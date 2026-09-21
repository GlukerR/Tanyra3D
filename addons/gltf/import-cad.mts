import { createRequire } from 'node:module';

import { Document, type Material, type Node } from '@gltf-transform/core';
import { emptyNote, setImportNote } from './import-notes.mjs';
import { CAD_PARAMS, CAD_READERS, groupFacesByColor, type OcctNode, type OcctResult } from './cad-shared.mjs';

type Occt = Record<string, (bytes: Uint8Array, params: unknown) => OcctResult>;

const require = createRequire(import.meta.url);
let occtReady: Promise<Occt> | null = null;
const quiet = { print: () => {}, printErr: () => {} };
const occt = (): Promise<Occt> => (occtReady ??= (require('occt-import-js') as (o: object) => Promise<Occt>)(quiet));

export async function importCad(
  ext: string,
  buf: ArrayBuffer,
  name: string,
  importError: (messageId: string, format: string) => Error,
): Promise<Document> {
  const format = ext.toUpperCase();
  const reader = CAD_READERS[ext];
  if (!reader) throw importError('io.unreadable', format);

  let res: OcctResult;
  try {
    res = (await occt())[reader]!(new Uint8Array(buf), CAD_PARAMS);
  } catch (e) {
    const err = importError('io.unreadable', format);
    err.cause = e;
    throw err;
  }
  if (!res || !res.success) throw importError('io.unreadable', format);
  if (!res.meshes || !res.meshes.length) throw importError('io.noGeometry', format);

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(name);
  doc.getRoot().setDefaultScene(scene);

  const materials = new Map<string, Material>();
  const materialOf = (rgb: [number, number, number] | null): Material | null => {
    if (!rgb) return null;
    const key = rgb.map((v) => v.toFixed(6)).join(',');
    let mat = materials.get(key);
    if (!mat) {
      mat = doc.createMaterial(`mat_${materials.size}`)
        .setBaseColorFactor([rgb[0], rgb[1], rgb[2], 1])
        .setDoubleSided(true);
      materials.set(key, mat);
    }
    return mat;
  };

  const meshes = res.meshes.map((m, i) => {
    const pos = Float32Array.from(m.attributes.position.array);
    const nrm = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null;
    const idx = m.index.array;
    const big = pos.length / 3 > 65535;
    const position = doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer);
    const normal = nrm ? doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer) : null;
    const mesh = doc.createMesh(m.name || `${name}_${i + 1}`);
    for (const group of groupFacesByColor(m)) {
      const tri = new (big ? Uint32Array : Uint16Array)(group.triangles.length * 3);
      let k = 0;
      for (const t of group.triangles) {
        tri[k++] = idx[t * 3]!;
        tri[k++] = idx[t * 3 + 1]!;
        tri[k++] = idx[t * 3 + 2]!;
      }
      const prim = doc.createPrimitive().setMode(4)
        .setAttribute('POSITION', position)
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(tri).setBuffer(buffer));
      if (normal) prim.setAttribute('NORMAL', normal);
      const mat = materialOf(group.color);
      if (mat) prim.setMaterial(mat);
      mesh.addPrimitive(prim);
    }
    return mesh;
  });

  const build = (src: OcctNode, parent: { addChild(n: Node): unknown }) => {
    const node = doc.createNode(src.name || '');
    parent.addChild(node);
    const own = src.meshes || [];
    if (own.length === 1) node.setMesh(meshes[own[0]!]!);
    else for (const mi of own) node.addChild(doc.createNode(meshes[mi]!.getName()).setMesh(meshes[mi]!));
    for (const child of src.children || []) build(child, node);
  };
  build(res.root, scene);

  if (!doc.getRoot().listMeshes().some((m) => m.listPrimitives().length)) throw importError('io.noGeometry', format);
  setImportNote(doc, emptyNote());
  return doc;
}
