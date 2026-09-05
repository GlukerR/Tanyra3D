import fs from 'node:fs';
import path from 'node:path';

import { Document, type Material, type Texture } from '@gltf-transform/core';
import { emptyNote, setImportNote, type ImportNote } from './import-notes.mjs';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MIME, TYPE_BY_SIZE } from './media.mjs';


interface MtlEntry {
  diffuse?: [number, number, number];
  alpha?: number;
  mapDiffuse?: string;
  mapNormal?: string;
  mapEmissive?: string;
  emissive?: [number, number, number];
}

function parseMtl(text: string): Map<string, MtlEntry> {
  const out = new Map<string, MtlEntry>();
  let cur: MtlEntry | null = null;
  const nums = (parts: string[]): [number, number, number] | undefined => {
    const v = parts.map(Number).filter((n) => Number.isFinite(n));
    return v.length >= 3 ? [v[0]!, v[1]!, v[2]!] : undefined;
  };
  const file = (parts: string[]): string | undefined => {
    const last = parts[parts.length - 1];
    return last && !last.startsWith('-') ? last : undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = (parts.shift() || '').toLowerCase();
    if (key === 'newmtl') {
      cur = {};
      out.set(parts.join(' '), cur);
      continue;
    }
    if (!cur) continue;
    if (key === 'kd') { const c = nums(parts); if (c) cur.diffuse = c; }
    else if (key === 'ke') { const c = nums(parts); if (c) cur.emissive = c; }
    else if (key === 'd') { const n = Number(parts[0]); if (Number.isFinite(n)) cur.alpha = n; }
    else if (key === 'tr') { const n = Number(parts[0]); if (Number.isFinite(n)) cur.alpha = 1 - n; }
    else if (key === 'map_kd') { const f = file(parts); if (f) cur.mapDiffuse = f; }
    else if (key === 'map_bump' || key === 'bump' || key === 'norm') { const f = file(parts); if (f) cur.mapNormal = f; }
    else if (key === 'map_ke') { const f = file(parts); if (f) cur.mapEmissive = f; }
  }
  return out;
}

function mtlLibs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*mtllib\s+(.+)$/gim)) {
    for (const name of m[1]!.trim().split(/\s+/)) if (name) out.push(name);
  }
  return out;
}

interface Attr { array: ArrayLike<number>; itemSize: number; count: number }
interface ObjGeometry {
  attributes: Record<string, Attr | undefined>;
  groups: Array<{ start: number; count: number; materialIndex?: number }>;
}
interface ObjMesh {
  isMesh?: boolean;
  name?: string;
  geometry: ObjGeometry;
  material: { name?: string } | Array<{ name?: string }>;
}


export function importObj(
  srcPath: string,
  buf: ArrayBuffer,
  importError: (messageId: string, format: string) => Error,
): Document {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));

  let root: { traverse(fn: (o: unknown) => void): void };
  try {
    root = new OBJLoader().parse(text) as never;
  } catch (e) {
    const err = importError('io.unreadable', 'OBJ');
    err.cause = e;
    throw err;
  }

  const meshes: ObjMesh[] = [];
  root.traverse((o) => { if ((o as ObjMesh).isMesh) meshes.push(o as ObjMesh); });
  if (!meshes.length) throw importError('io.noGeometry', 'OBJ');

  const dir = path.dirname(srcPath);
  const note: ImportNote = emptyNote();

  const mtl = new Map<string, MtlEntry>();
  for (const lib of mtlLibs(text)) {
    const file = path.join(dir, lib);
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { note.missingTextures.push(lib); continue; }
    for (const [name, entry] of parseMtl(content)) mtl.set(name, entry);
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);

  const textures = new Map<string, Texture | null>();
  const textureOf = (name: string): Texture | null => {
    if (textures.has(name)) return textures.get(name)!;
    let tex: Texture | null = null;
    const file = path.join(dir, name.split('\\').join('/'));
    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    if (MIME[ext] && fs.existsSync(file)) {
      tex = doc.createTexture(path.basename(file))
        .setMimeType(MIME[ext]!)
        .setImage(new Uint8Array(fs.readFileSync(file)));
    } else if (!note.missingTextures.includes(name)) {
      note.missingTextures.push(name);
    }
    textures.set(name, tex);
    return tex;
  };

  const materials = new Map<string, Material>();
  const materialOf = (name: string): Material | null => {
    if (!name) return null;
    const have = materials.get(name);
    if (have) return have;
    const entry = mtl.get(name);
    const mat = doc.createMaterial(name);
    if (entry) {
      const [r, g, b] = entry.diffuse || [1, 1, 1];
      const a = entry.alpha != null ? entry.alpha : 1;
      if (entry.diffuse || entry.alpha != null) mat.setBaseColorFactor([r, g, b, a]);
      if (a < 1) mat.setAlphaMode('BLEND');
      if (entry.emissive) mat.setEmissiveFactor(entry.emissive);
      if (entry.mapDiffuse) {
        const tex = textureOf(entry.mapDiffuse);
        if (tex) { mat.setBaseColorTexture(tex); mat.setBaseColorFactor([1, 1, 1, a]); }
      }
      if (entry.mapNormal) { const t = textureOf(entry.mapNormal); if (t) mat.setNormalTexture(t); }
      if (entry.mapEmissive) {
        const t = textureOf(entry.mapEmissive);
        if (t) { mat.setEmissiveTexture(t); mat.setEmissiveFactor(entry.emissive || [1, 1, 1]); }
      }
    }
    materials.set(name, mat);
    return mat;
  };

  const primitiveFrom = (geom: ObjGeometry, start: number, count: number, matName: string) => {
    const prim = doc.createPrimitive().setMode(4);
    const add = (semantic: string, attr: Attr | undefined, flipV = false) => {
      if (!attr || !attr.count) return;
      const type = TYPE_BY_SIZE[attr.itemSize];
      if (!type) return;
      const size = attr.itemSize;
      const slice = new Float32Array(count * size);
      for (let i = 0; i < count * size; i++) slice[i] = Number(attr.array[start * size + i]);
      if (flipV) for (let i = 1; i < slice.length; i += 2) slice[i] = 1 - slice[i]!;
      prim.setAttribute(semantic, doc.createAccessor(semantic)
        .setType(type as never).setArray(slice).setBuffer(buffer));
    };
    add('POSITION', geom.attributes.position);
    add('NORMAL', geom.attributes.normal);
    add('TEXCOORD_0', geom.attributes.uv, true);
    add('COLOR_0', geom.attributes.color);
    const mat = materialOf(matName);
    if (mat) prim.setMaterial(mat);
    return prim;
  };

  let index = 0;
  for (const m of meshes) {
    const geom = m.geometry;
    const position = geom.attributes.position;
    if (!position || !position.count) continue;
    const names = Array.isArray(m.material) ? m.material.map((x) => x?.name || '') : [m.material?.name || ''];
    const mesh = doc.createMesh(m.name || `mesh_${++index}`);

    const groups = geom.groups && geom.groups.length
      ? geom.groups
      : [{ start: 0, count: position.count, materialIndex: 0 }];
    for (const g of groups) {
      if (!g.count) continue;
      mesh.addPrimitive(primitiveFrom(geom, g.start, g.count, names[g.materialIndex || 0] || ''));
    }
    if (!mesh.listPrimitives().length) continue;
    scene.addChild(doc.createNode(m.name || mesh.getName()).setMesh(mesh));
  }

  if (!doc.getRoot().listMeshes().length) throw importError('io.noGeometry', 'OBJ');

  setImportNote(doc, note);
  return doc;
}
