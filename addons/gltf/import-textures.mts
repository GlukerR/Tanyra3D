import fs from 'node:fs';
import path from 'node:path';

import type { Document, Texture } from '@gltf-transform/core';
import sharp from 'sharp';

import type { ImportNote } from './import-notes.mjs';
import { MIME, TEXTURE_SLOTS as SLOTS } from './media.mjs';



function hasUv(doc: Document): boolean {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('TEXCOORD_0')) return true;
    }
  }
  return false;
}

function imagesNear(dir: string): string[] {
  const out: string[] = [];
  const take = (d: string) => {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      if (MIME[ext]) out.push(path.join(d, name));
    }
  };
  take(dir);
  let subs: fs.Dirent[];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of subs) if (e.isDirectory()) take(path.join(dir, e.name));
  return out;
}

function pick(files: string[], re: RegExp): string | null {
  return files.find((f) => re.test(path.basename(f))) || null;
}

export async function attachNeighbourTextures(doc: Document, srcPath: string, note: ImportNote): Promise<boolean> {
  const root = doc.getRoot();
  if (root.listTextures().length) return false;
  if (!hasUv(doc)) return false;

  const files = imagesNear(path.dirname(srcPath));
  if (!files.length) return false;

  const found = new Map<string, string>();
  for (const { slot, re } of SLOTS) {
    const hit = pick(files, re);
    if (hit) found.set(slot, hit);
  }
  if (!found.size) return false;

  const texOf = async (file: string): Promise<Texture> => {
    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    return doc.createTexture(path.basename(file))
      .setMimeType(MIME[ext]!)
      .setImage(new Uint8Array(fs.readFileSync(file)));
  };

  const material = root.listMaterials()[0] || doc.createMaterial('imported');
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setMaterial(material);
  }

  const say = (slot: string, file: string) => note.attached.push({ slot, file: path.basename(file) });

  const base = found.get('baseColor');
  if (base) {
    material.setBaseColorTexture(await texOf(base));
    material.setBaseColorFactor([1, 1, 1, 1]);
    say('baseColor', base);
  }

  const normal = found.get('normal');
  if (normal) { material.setNormalTexture(await texOf(normal)); say('normal', normal); }

  const emissive = found.get('emissive');
  if (emissive) {
    material.setEmissiveTexture(await texOf(emissive));
    material.setEmissiveFactor([1, 1, 1]);
    say('emissive', emissive);
  }

  const orm: Array<string | null> = ['occlusion', 'roughness', 'metallic'].map((k) => found.get(k) ?? null);
  if (orm.some(Boolean)) {
    const packed = await packOrm(orm[0] ?? null, orm[1] ?? null, orm[2] ?? null);
    if (packed) {
      const ormTex = doc.createTexture('orm').setMimeType('image/jpeg').setImage(packed);
      material.setMetallicRoughnessTexture(ormTex);
      if (orm[0]) material.setOcclusionTexture(ormTex);
      if (orm[2]) material.setMetallicFactor(1);
      if (orm[1]) material.setRoughnessFactor(1);
      for (const [i, k] of ['occlusion', 'roughness', 'metallic'].entries()) {
        if (orm[i]) say(k, orm[i]!);
      }
    }
  }

  return note.attached.length > 0;
}

async function packOrm(ao: string | null, rough: string | null, metal: string | null): Promise<Uint8Array | null> {
  const any = ao || rough || metal;
  if (!any) return null;
  const meta = await sharp(any).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return null;

  const channel = async (file: string | null, fallback: number) => (file
    ? sharp(file).resize(w, h).greyscale().raw().toBuffer()
    : Buffer.alloc(w * h, fallback));
  const [r, g, b] = await Promise.all([channel(ao, 255), channel(rough, 255), channel(metal, 0)]);

  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = r[i]!;
    rgb[i * 3 + 1] = g[i]!;
    rgb[i * 3 + 2] = b[i]!;
  }
  const out = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return new Uint8Array(out);
}
