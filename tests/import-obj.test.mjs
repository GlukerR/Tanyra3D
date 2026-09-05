import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import '../addons/gltf/index.mjs';
import { importForeign, IMPORT_FORMATS } from '../addons/gltf/importers.mjs';
import { importNote } from '../addons/gltf/import-notes.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-obj-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

async function build(name, obj, mtl = null, images = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.obj'), obj);
  if (mtl != null) fs.writeFileSync(path.join(dir, 'model.mtl'), mtl);
  for (const [file, grey] of Object.entries(images)) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: grey, g: grey, b: grey } } })
      .png().toFile(path.join(dir, file));
  }
  const doc = await importForeign(path.join(dir, 'model.obj'));
  return { doc, root: doc.getRoot(), note: importNote(doc) };
}

const TWO_MATERIALS = `mtllib model.mtl
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
vt 0 0
vt 1 0
vt 0 0.25
vt 1 0.25
vn 0 0 1
usemtl red
f 1/1/1 2/2/1 3/3/1
usemtl blue
f 2/2/1 4/4/1 3/3/1
`;

const MTL = `newmtl red
Kd 0.8 0.1 0.1
newmtl blue
Kd 0.1 0.1 0.9
`;

describe('OBJ доезжает целым', () => {
  it('числится среди принимаемых форматов', () => {
    expect([...IMPORT_FORMATS]).toContain('obj');
  });

  it('геометрия и развёртка на месте, V перевёрнута', async () => {
    const { root } = await build('uv', TWO_MATERIALS, MTL);
    const vs = [];
    for (const mesh of root.listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const uv = prim.getAttribute('TEXCOORD_0');
        expect(uv, 'развёртка не перенесена').toBeTruthy();
        for (let i = 0; i < uv.getCount(); i++) vs.push(Number(uv.getElement(i, [])[1].toFixed(2)));
      }
    }
    expect(Math.min(...vs), 'развёртка не перевёрнута — карта ляжет вверх ногами').toBeCloseTo(0.75, 2);
    expect(Math.max(...vs)).toBeCloseTo(1, 2);
  });

  it('деление по usemtl сохраняется: две части — два материала', async () => {
    const { root } = await build('two-mats', TWO_MATERIALS, MTL);
    const names = root.listMaterials().map((m) => m.getName()).sort();
    expect(names, 'материалы из .mtl потеряны или слиты').toEqual(['blue', 'red']);
    const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
    expect(prims.length, 'части с разными материалами свели в одну').toBe(2);
  });

  it('цвета читаются у соседнего .mtl', async () => {
    const { root } = await build('colors', TWO_MATERIALS, MTL);
    const byName = Object.fromEntries(root.listMaterials().map((m) => [m.getName(), m.getBaseColorFactor()]));
    expect(byName.red[0], 'красный не тот').toBeCloseTo(0.8, 2);
    expect(byName.blue[2], 'синий не тот').toBeCloseTo(0.9, 2);
  });

  it('карта из .mtl подключается, и множитель ей уступает', async () => {
    const { root } = await build('with-map',
      TWO_MATERIALS, `newmtl red\nKd 0.8 0.1 0.1\nmap_Kd wood.png\n`, { 'wood.png': 200 });
    const red = root.listMaterials().find((m) => m.getName() === 'red');
    expect(red.getBaseColorTexture(), 'карта из .mtl не подключена').toBeTruthy();
    expect(red.getBaseColorFactor().slice(0, 3), 'множитель погасит карту').toEqual([1, 1, 1]);
  });

  it('имя карты берётся ПОСЛЕДНИМ словом строки, а не вторым', async () => {
    const { root } = await build('map-opts',
      TWO_MATERIALS, `newmtl red\nmap_Kd -s 1 1 1 wood.png\n`, { 'wood.png': 180 });
    const red = root.listMaterials().find((m) => m.getName() === 'red');
    expect(red.getBaseColorTexture(), 'ключи перед именем сбили чтение').toBeTruthy();
    expect(red.getBaseColorTexture().getName()).toBe('wood.png');
  });

  it('без .mtl модель всё равно открывается, а деление сохраняется', async () => {
    const { root } = await build('no-mtl', TWO_MATERIALS, null);
    expect(root.listMeshes().length, 'модель не собралась без .mtl').toBeGreaterThan(0);
    const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
    expect(prims.length, 'без .mtl потерялось деление по usemtl').toBe(2);
  });

  it('названная, но отсутствующая карта попадает в записку, а не теряется молча', async () => {
    const { note } = await build('missing-map',
      TWO_MATERIALS, `newmtl red\nmap_Kd нет-такого.png\n`);
    expect(note, 'записки о ввозе нет').toBeTruthy();
    expect(note.missingTextures, 'о пропавшей карте промолчали').toContain('нет-такого.png');
  });

  it('шероховатость и металличность НЕ выдумываются', async () => {
    const { root } = await build('no-pbr', TWO_MATERIALS, `newmtl red\nKd 0.8 0.1 0.1\nNs 250\nKs 1 1 1\n`);
    const red = root.listMaterials().find((m) => m.getName() === 'red');
    expect(red.getRoughnessFactor(), 'шероховатость выдумана из Ns').toBe(1);
    expect(red.getMetallicFactor(), 'металличность выдумана из Ks').toBe(1);
  });

  it('файл без геометрии отвергается объяснением, а не внутренней ошибкой', async () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.obj'), '# только комментарий\n');
    await expect(importForeign(path.join(dir, 'model.obj'))).rejects.toThrow(/OBJ/);
  });
});
