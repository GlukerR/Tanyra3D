import fs from 'node:fs';
import path from 'node:path';

import { Document, type Material, type Texture } from '@gltf-transform/core';
import { emptyNote, setImportNote, type ImportNote } from './import-notes.mjs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MIME, TYPE_BY_SIZE } from './media.mjs';


const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'tga', 'psd', 'exr', 'dds'];


const fileOf = (t: unknown): string => {
  const tex = t as { userData?: { fbxFile?: string }; name?: string } | null | undefined;
  return (tex && (tex.userData?.fbxFile || tex.name)) || '';
};
function nameOnlyManager(): unknown {
  const stub = {
    path: '',
    setPath(p: string) { this.path = p || ''; return this; },
    setCrossOrigin() { return this; },
    load(fileName: string) {
      return {
        name: fileName,
        userData: { fbxFile: fileName },
        repeat: { x: 1, y: 1 },
        offset: { x: 0, y: 0 },
      };
    },
  };
  const known = new Set(IMAGE_EXT.map((e) => `.${e}`));
  return {
    getHandler: (ext: string) => (known.has(String(ext).toLowerCase()) ? stub : null),
  };
}

interface ThreeAttr { array: ArrayLike<number>; itemSize: number; count: number; normalized?: boolean }
interface ThreeGeom {
  attributes: Record<string, ThreeAttr | undefined>;
  index?: { array: ArrayLike<number>; count: number } | null;
}
interface ThreeObj {
  name?: string;
  isMesh?: boolean;
  geometry?: ThreeGeom;
  material?: unknown;
  children: ThreeObj[];
  position: { toArray(): number[] };
  quaternion: { toArray(): number[] };
  scale: { toArray(): number[] };
}
interface ThreeMat {
  uuid: string; name?: string;
  color?: { toArray(): number[] };
  emissive?: { toArray(): number[] };
  opacity?: number;
  transparent?: boolean;
  map?: unknown; normalMap?: unknown; emissiveMap?: unknown; aoMap?: unknown;
}


export function importFbx(
  srcPath: string,
  buf: ArrayBuffer,
  fail: (messageId: string, format: string) => Error & { cause?: unknown },
): Document {
  const format = 'FBX';
  let group: ThreeObj & { animations?: unknown[] };
  try {
    group = new FBXLoader(nameOnlyManager() as never).parse(buf, '') as never;
  } catch (e) {
    const err = fail('io.unreadable', format);
    err.cause = e;
    throw err;
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);

  const note: ImportNote = emptyNote();
  const anims = (group as { animations?: unknown[] }).animations;
  if (Array.isArray(anims)) note.animations = anims.length;

  const dir = path.dirname(srcPath);
  const byFile = new Map<string, Texture | null>();
  const resolveTexture = (ref: unknown): Texture | null => {
    const file = fileOf(ref);
    if (!file) return null;
    if (byFile.has(file)) return byFile.get(file)!;

    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    const mime = MIME[ext];
    const candidates = [
      path.resolve(dir, file),
      path.resolve(dir, path.basename(file)),
    ];
    const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

    if (!found || !mime) {
      if (!note.missingTextures.includes(file)) note.missingTextures.push(file);
      byFile.set(file, null);
      return null;
    }
    const tex = doc.createTexture(path.basename(file))
      .setMimeType(mime)
      .setImage(new Uint8Array(fs.readFileSync(found)));
    byFile.set(file, tex);
    return tex;
  };

  const byMaterial = new Map<string, Material>();
  const convertMaterial = (src: unknown): Material | null => {
    const m = src as ThreeMat | null | undefined;
    if (!m || !m.uuid) return null;
    const seen = byMaterial.get(m.uuid);
    if (seen) return seen;

    const out = doc.createMaterial(m.name || '')
      .setMetallicFactor(0)
      .setRoughnessFactor(1);

    const rgb = m.color ? m.color.toArray() : [1, 1, 1];
    const alpha = typeof m.opacity === 'number' ? m.opacity : 1;
    out.setBaseColorFactor([rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, alpha]);
    if (alpha < 1) out.setAlphaMode('BLEND');

    const emissive = m.emissive ? m.emissive.toArray() : [0, 0, 0];
    if (emissive.some((v) => v > 0)) out.setEmissiveFactor([emissive[0]!, emissive[1]!, emissive[2]!]);

    const base = resolveTexture(m.map);
    if (base) out.setBaseColorTexture(base);
    const normal = resolveTexture(m.normalMap);
    if (normal) out.setNormalTexture(normal);
    const emi = resolveTexture(m.emissiveMap);
    if (emi) { out.setEmissiveTexture(emi); if (!emissive.some((v) => v > 0)) out.setEmissiveFactor([1, 1, 1]); }
    const ao = resolveTexture(m.aoMap);
    if (ao) out.setOcclusionTexture(ao);

    byMaterial.set(m.uuid, out);
    return out;
  };

  const accessorOf = (arr: ArrayLike<number>, type: string, ints?: 'u16' | 'u32') => doc.createAccessor()
    .setType(type as never)
    .setArray(ints === 'u32' ? Uint32Array.from(arr) : ints === 'u16' ? Uint16Array.from(arr) : Float32Array.from(arr))
    .setBuffer(buffer);

  let meshCount = 0;
  const convert = (obj: ThreeObj, parent: ReturnType<Document['createNode']> | null): void => {
    const node = doc.createNode(obj.name || '');
    const [tx, ty, tz] = obj.position.toArray();
    const [rx, ry, rz, rw] = obj.quaternion.toArray();
    const [sx, sy, sz] = obj.scale.toArray();
    node.setTranslation([tx!, ty!, tz!]);
    node.setRotation([rx!, ry!, rz!, rw!]);
    node.setScale([sx!, sy!, sz!]);

    if (obj.isMesh && obj.geometry) {
      const g = obj.geometry;
      const position = g.attributes.position;
      if (position && position.count) {
        const prim = doc.createPrimitive().setMode(4);
        prim.setAttribute('POSITION', accessorOf(position.array, 'VEC3'));

        const normal = g.attributes.normal;
        if (normal && normal.count) prim.setAttribute('NORMAL', accessorOf(normal.array, 'VEC3'));

        const uv = g.attributes.uv;
        if (uv && uv.count) {
          const flipped = Float32Array.from(uv.array);
          for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i]!;
          prim.setAttribute('TEXCOORD_0', accessorOf(flipped, 'VEC2'));
        }

        const color = g.attributes.color;
        if (color && color.count) {
          const type = TYPE_BY_SIZE[color.itemSize];
          if (type) prim.setAttribute('COLOR_0', accessorOf(color.array, type));
        }

        const idx = g.index;
        if (idx && idx.count) {
          prim.setIndices(accessorOf(idx.array, 'SCALAR', position.count > 65535 ? 'u32' : 'u16'));
        } else {
          const seq = new Uint32Array(position.count);
          for (let i = 0; i < seq.length; i++) seq[i] = i;
          prim.setIndices(accessorOf(seq, 'SCALAR', position.count > 65535 ? 'u32' : 'u16'));
        }

        const mat = convertMaterial(Array.isArray(obj.material) ? obj.material[0] : obj.material);
        if (mat) prim.setMaterial(mat);

        node.setMesh(doc.createMesh(obj.name || '').addPrimitive(prim));
        meshCount++;
      }
    }

    if (parent) parent.addChild(node); else scene.addChild(node);
    for (const child of obj.children || []) convert(child, node);
  };

  for (const child of group.children || []) convert(child, null);

  if (!meshCount) throw fail('io.noGeometry', format);

  setImportNote(doc, note);
  return doc;
}
