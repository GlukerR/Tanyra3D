// tests/texture-resize.test.mjs — уменьшение текстур (правило textures/resize).
//
// Решение Александра 2026-08-12: «нужно сделать изменение размера 4к, 2к, 1к, 512 на
// 512». Четыре размера — четыре члена одной взаимоисключающей группы; ничего не
// выбрано — правило не работает вовсе.
//
// Здесь проверяется ровно то, что человек увидит и не сможет отменить:
//   · уменьшается только то, что КРУПНЕЕ цели, и никогда не увеличивается;
//   · пропорции сохраняются (цель — большая сторона, а не обе);
//   · уже сжатое для видеокарты не трогается, и отказ назван вслух;
//   · запись в отчёте помечена как необратимая (пиксели не вернуть).
//
// Модели синтетические: нужен точный контроль над размером картинки, а в корпусе
// текстуры такие, какие есть.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';

import { runOptimize } from '../core/engine.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { textureSize } from '../addons/gltf/metrics.mjs';

const RULE = 'textures/resize';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'texture-resize-'));
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * GLB с одной текстурой заданного размера.
 *
 * Картинка — шум: он не сжимается, поэтому уменьшение видно и по весу файла, а не
 * только по числам в отчёте.
 */
async function modelWithTexture(name, width, height, mime = 'image/png') {
  const raw = crypto.randomBytes(width * height * 4);
  const pipeline = sharp(raw, { raw: { width, height, channels: 4 } });
  const image = mime === 'image/jpeg' ? await pipeline.jpeg().toBuffer() : await pipeline.png().toBuffer();

  const doc = new Document();
  doc.createBuffer();
  const tex = doc.createTexture('tex').setMimeType(mime).setImage(image);
  const mat = doc.createMaterial('mat').setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setMaterial(mat);
  doc.createScene('S').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));

  const file = path.join(tmp, `${name}.glb`);
  await new NodeIO().write(file, doc);
  return file;
}

/** Прогон через движок и размеры текстур в результате. */
async function run(src, features) {
  const outDir = path.join(tmp, `out-${crypto.randomUUID()}`);
  const result = await runOptimize(gltfAddon, src, { outDir, force: true, advancedFeatures: features, locale: 'ru' });
  let sizes = [];
  if (result.file.written) {
    const doc = await new NodeIO().read(result.file.dst);
    sizes = doc.getRoot().listTextures().map((t) => textureSize(t.getImage(), t.getMimeType()));
  }
  const lines = [...result.applied, ...result.skipped].filter((e) => e.ruleId === RULE);
  return { result, sizes, lines };
}

describe('textures/resize — уменьшает только то, что крупнее цели', () => {
  it('2048 при цели 1024 становится 1024, и запись помечена необратимой', async () => {
    const src = await modelWithTexture('big', 2048, 2048);
    const { result, sizes, lines } = await run(src, ['resize-1024']);

    expect(result.status).toBe('ok');
    expect(sizes[0]).toEqual([1024, 1024]);
    const done = result.applied.filter((a) => a.ruleId === RULE);
    expect(done.length, 'правило не отчиталось о работе').toBe(1);
    expect(done[0].dataLoss, 'выброшенные пиксели отчитались как безобидные').toBe('significant');
    expect(lines.length, `строк больше, чем классов случаев: ${lines.length}`).toBeLessThanOrEqual(2);
  }, 120_000);

  // Цель — БОЛЬШАЯ сторона. Квадрат из неквадратной картинки означал бы растянутую
  // модель: пропорции текстуры менять нельзя ни при каком размере.
  it('неквадратная сохраняет пропорции: 2048×1024 при цели 1024 → 1024×512', async () => {
    const src = await modelWithTexture('wide', 2048, 1024);
    const { sizes } = await run(src, ['resize-1024']);
    expect(sizes[0]).toEqual([1024, 512]);
  }, 120_000);

  it('никогда не увеличивает: 256 при цели 1024 остаётся 256', async () => {
    const src = await modelWithTexture('small', 256, 256);
    const { sizes, lines } = await run(src, ['resize-1024']);
    expect(sizes[0]).toEqual([256, 256]);
    expect(lines.length, 'правило отчиталось о работе, которой не было').toBe(0);
  }, 120_000);

  it('без выбора размера правило не работает вовсе', async () => {
    const src = await modelWithTexture('untouched', 2048, 2048);
    const { sizes, lines } = await run(src, ['safe']);
    expect(sizes[0]).toEqual([2048, 2048]);
    expect(lines.length).toBe(0);
  }, 120_000);

  it('JPEG остаётся JPEG — формат меняют соседние правила, не это', async () => {
    const src = await modelWithTexture('jpeg', 2048, 2048, 'image/jpeg');
    const outDir = path.join(tmp, 'out-jpeg');
    const result = await runOptimize(gltfAddon, src, { outDir, force: true, advancedFeatures: ['resize-512'], locale: 'ru' });
    const doc = await new NodeIO().read(result.file.dst);
    const tex = doc.getRoot().listTextures()[0];
    expect(tex.getMimeType()).toBe('image/jpeg');
    expect(textureSize(tex.getImage(), tex.getMimeType())).toEqual([512, 512]);
  }, 120_000);
});

describe('textures/resize — отказы называются вслух', () => {
  it('картинку, уже сжатую для видеокарты, не трогает и объясняет почему', async () => {
    // Текстура с mime image/ktx2: распаковать и сжать заново значило бы потерять
    // качество дважды за одну просьбу.
    const doc = new Document();
    doc.createBuffer();
    const tex = doc.createTexture('gpu').setMimeType('image/ktx2').setImage(new Uint8Array([1, 2, 3, 4]));
    const mat = doc.createMaterial('m').setBaseColorTexture(tex);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
      .setMaterial(mat);
    doc.createScene('S').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));
    const src = path.join(tmp, 'ktx2.glb');
    await new NodeIO().write(src, doc);

    const { result } = await run(src, ['resize-512']);
    const skipped = result.skipped.filter((s) => s.ruleId === RULE);
    expect(skipped.length, 'отказ не назван — человек решит, что уменьшение прошло').toBeGreaterThan(0);
    expect(skipped[0].text).toBeTruthy();
  }, 120_000);
});

describe('выбор размера — взаимоисключающая группа', () => {
  it('из двух просьб выполняется та, что выбрасывает меньше пикселей', async () => {
    const src = await modelWithTexture('both', 2048, 2048);
    const { sizes } = await run(src, ['resize-512', 'resize-2048']);
    // 2048 крупнее — значит и картинка остаётся 2048, а не 512.
    expect(sizes[0]).toEqual([2048, 2048]);
  }, 120_000);

  it('отменённый размер попадает в отчёт, а не исчезает молча', async () => {
    const src = await modelWithTexture('conflict', 2048, 2048);
    const { result } = await run(src, ['resize-512', 'resize-2048']);
    const exclusive = result.skipped.filter((s) => s.kind === 'exclusive');
    expect(exclusive.length, 'движок молча отменил выбор человека').toBeGreaterThan(0);
  }, 120_000);
});
