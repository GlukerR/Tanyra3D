import fs from 'node:fs';
import path from 'node:path';

import { Document } from '@gltf-transform/core';
import { render } from '../../core/i18n.mjs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { importFbx } from './import-fbx.mjs';
import { importObj } from './import-obj.mjs';
import { emptyNote, importNote, setImportNote } from './import-notes.mjs';
import { attachNeighbourTextures } from './import-textures.mjs';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { TYPE_BY_SIZE } from './media.mjs';

export const IMPORT_FORMATS = ['stl', 'ply', 'fbx', 'obj'] as const;

export function isImportFormat(srcPath: string): boolean {
  const ext = path.extname(String(srcPath)).toLowerCase().replace(/^\./, '');
  return (IMPORT_FORMATS as readonly string[]).includes(ext);
}

function readArrayBuffer(srcPath: string): ArrayBuffer {
  const bytes = new Uint8Array(fs.readFileSync(srcPath));
  return bytes.buffer as ArrayBuffer;
}

interface Attr {
  array: ArrayLike<number> | Uint8Array | Uint16Array | Float32Array;
  itemSize: number;
  count: number;
  normalized?: boolean;
}

interface Geometry {
  attributes: Record<string, Attr | undefined>;
  index?: { array: ArrayLike<number>; count: number } | null;
}


function buildDocument(geom: Geometry, name: string, format: string): Document {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const prim = doc.createPrimitive();

  const position = geom.attributes.position;
  if (!position || !position.count) throw importError('io.noGeometry', format);

  const add = (semantic: string, attr: Attr | undefined) => {
    if (!attr || !attr.count) return;
    const type = TYPE_BY_SIZE[attr.itemSize];
    if (!type) return;

    const src = attr.array;
    const keepInts = !!attr.normalized && (src instanceof Uint8Array || src instanceof Uint16Array);
    const acc = doc.createAccessor(semantic)
      .setType(type as never)
      .setArray(keepInts ? (src as Uint8Array | Uint16Array).slice() : Float32Array.from(src as ArrayLike<number>))
      .setBuffer(doc.getRoot().listBuffers()[0]!);
    if (keepInts) acc.setNormalized(true);
    prim.setAttribute(semantic, acc);
  };

  add('POSITION', position);
  add('NORMAL', geom.attributes.normal);
  add('COLOR_0', geom.attributes.color);
  add('TEXCOORD_0', geom.attributes.uv);

  if (geom.index && geom.index.count) {
    const big = position.count > 65535;
    const acc = doc.createAccessor('indices')
      .setType('SCALAR')
      .setArray(big
        ? Uint32Array.from(geom.index.array as ArrayLike<number>)
        : Uint16Array.from(geom.index.array as ArrayLike<number>))
      .setBuffer(doc.getRoot().listBuffers()[0]!);
    prim.setIndices(acc);
  }

  const mesh = doc.createMesh(name).addPrimitive(prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
  doc.getRoot().setDefaultScene(scene);
  return doc;
}

function importError(messageId: string, format: string) {
  const err: Error & { i18n?: { messageId: string; data: Record<string, unknown> } } =
    new Error(render(messageId, { format }));
  err.i18n = { messageId, data: { format } };
  return err;
}

function parseOrExplain(run: () => unknown, format: string): Geometry {
  try {
    return run() as Geometry;
  } catch (e) {
    const err = importError('io.unreadable', format);
    err.cause = e;
    throw err;
  }
}

function plyFaceCount(buf: ArrayBuffer): number {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192)));
  const stop = head.indexOf('end_header');
  const m = (stop >= 0 ? head.slice(0, stop) : head).match(/^\s*element\s+face\s+(\d+)/mi);
  return m ? Number(m[1]) : 0;
}

export async function importForeign(srcPath: string): Promise<Document> {
  const ext = path.extname(srcPath).toLowerCase().replace(/^\./, '');
  const format = ext.toUpperCase();
  const buf = readArrayBuffer(srcPath);
  const name = path.basename(srcPath, path.extname(srcPath));

  const withNeighbours = async (doc: Document): Promise<Document> => {
    const note = importNote(doc) || emptyNote();
    await attachNeighbourTextures(doc, srcPath, note);
    setImportNote(doc, note);
    return doc;
  };

  if (ext === 'stl') {
    return withNeighbours(buildDocument(parseOrExplain(() => new STLLoader().parse(buf), format), name, format));
  }
  if (ext === 'ply') {
    if (plyFaceCount(buf) === 0) throw importError('io.pointCloud', format);
    return withNeighbours(buildDocument(parseOrExplain(() => new PLYLoader().parse(buf), format), name, format));
  }
  if (ext === 'obj') {
    return withNeighbours(importObj(srcPath, buf, importError));
  }
  if (ext === 'fbx') {
    return withNeighbours(importFbx(srcPath, buf, importError));
  }
  throw new Error(`unsupported_import_format:${ext}`);
}
