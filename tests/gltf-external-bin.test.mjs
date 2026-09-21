import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectFile } from '../optimize2.mjs';

function writeTriangle(dir, base) {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  fs.writeFileSync(path.join(dir, `${base}.bin`), bin);
  const json = {
    asset: { version: '2.0', generator: 'Open CASCADE Technology 7.8' },
    buffers: [{ byteLength: 36, uri: `${base}.bin` }],
    bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const file = path.join(dir, `${base}.gltf`);
  fs.writeFileSync(file, JSON.stringify(json));
  return file;
}

describe('glTF с внешним .bin: проверка видит соседний файл', () => {
  it('исправная пара .gltf + .bin (кириллица и пробел в имени) — без IO_ERROR', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gltf-bin-'));
    try {
      const file = writeTriangle(dir, 'Безымянный-_X2_0415_X0_ _X2_041F_X0_');
      const res = await inspectFile(file);
      const io = (res.validation || []).filter((m) => m.code === 'IO_ERROR');
      expect(io, 'валидатор не получил доступ к .bin рядом с .gltf').toEqual([]);
      expect((res.validation || []).filter((m) => m.severity === 0)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
