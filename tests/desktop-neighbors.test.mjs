import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { readNeighbors } = createRequire(import.meta.url)('../desktop/neighbors.cjs');

let root;
let model;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'neigh-'));
  const dir = path.join(root, 'модель');
  fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
  model = path.join(dir, 'деталь.gltf');
  fs.writeFileSync(model, '{}');
  fs.writeFileSync(path.join(dir, 'деталь 1.bin'), 'BIN');
  fs.writeFileSync(path.join(dir, 'textures', 'a.png'), 'PNG');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const names = (list) => list.map((f) => f.name);

describe('настольная версия: соседние файлы .gltf', () => {
  it('берёт то, на что ссылается модель, включая %20 и подпапки', () => {
    const got = readNeighbors(model, ['деталь%201.bin', 'textures/a.png']);
    expect(names(got)).toEqual(['деталь%201.bin', 'textures/a.png']);
    expect(Buffer.from(got[0].data).toString()).toBe('BIN');
  });

  it('за пределы папки модели не выходит', () => {
    const escape = ['../secret.txt', '..%2Fsecret.txt', path.join(root, 'secret.txt'), 'textures/../../secret.txt'];
    expect(readNeighbors(model, escape)).toEqual([]);
  });

  it('data: и адреса со схемой пропускаются, отсутствующие — тоже', () => {
    expect(readNeighbors(model, ['data:application/octet-stream;base64,AAAA', 'http://x/y.bin', 'нет.bin'])).toEqual([]);
  });

  it('только от .gltf и только по абсолютному пути', () => {
    expect(readNeighbors(model.replace(/\.gltf$/, '.glb'), ['деталь 1.bin'])).toEqual([]);
    expect(readNeighbors('деталь.gltf', ['деталь 1.bin'])).toEqual([]);
    expect(readNeighbors(model, 'деталь 1.bin')).toEqual([]);
  });

  it('ссылка на папку снаружи не выводит за пределы модели', () => {
    const outside = path.join(root, 'снаружи');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'x.bin'), 'OUT');
    const link = path.join(path.dirname(model), 'ссылка');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return;
    }
    expect(readNeighbors(model, ['ссылка/x.bin'])).toEqual([]);
  });

  it('папка не отдаётся как файл', () => {
    expect(readNeighbors(model, ['textures'])).toEqual([]);
  });
});
