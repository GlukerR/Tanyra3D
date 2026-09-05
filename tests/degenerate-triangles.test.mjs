import { describe, it, expect, afterAll } from 'vitest';
import { Document } from '@gltf-transform/core';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const RULE_ID = 'geometry/degenerate-triangles';

afterAll(cleanupTmpOutDirs);

function applyRule(doc) {
  const rule = RULES.find((r) => r.meta.id === RULE_ID);
  const cache = new Map();
  const out = rule.fix({ messageId: 'pipeline', data: {} }, { document: doc, cache, opts: {} });
  return { out, removed: cache.get('degenerateRemoved') };
}

function docWithCoincidentCorner({ morph = false, joints = null } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 1, 3]));
  const prim = doc.createPrimitive().setMode(4)
    .setAttribute('POSITION', position).setIndices(indices);

  if (morph) {
    const target = doc.createPrimitiveTarget().setAttribute('POSITION',
      doc.createAccessor().setType('VEC3').setBuffer(buffer)
        .setArray(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5])));
    prim.addTarget(target);
  }
  if (joints) {
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setBuffer(buffer)
      .setArray(new Uint16Array(joints)));
    prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setBuffer(buffer)
      .setArray(new Float32Array(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat())));
  }

  const mesh = doc.createMesh('M').addPrimitive(prim);
  doc.createScene('Scene').addChild(doc.createNode('N').setMesh(mesh));
  return { doc, prim };
}

const triCount = (prim) => prim.getIndices().getCount() / 3;


describe('два угла в одной точке — треугольник вырожденный', () => {
  it('убирается, хотя индексы у углов разные', () => {
    const { doc, prim } = docWithCoincidentCorner();
    expect(triCount(prim), 'заготовка неверна: должно быть два треугольника').toBe(2);
    const { removed } = applyRule(doc);
    expect(removed, 'вырожденный треугольник не убран — его найдёт и выбросит Draco').toBe(1);
    expect(triCount(prim)).toBe(1);
  });

  it('повторяющийся индекс убирается по-прежнему', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(new Uint16Array([0, 1, 2, 0, 1, 1]));
    const prim = doc.createPrimitive().setMode(4)
      .setAttribute('POSITION', position).setIndices(indices);
    doc.createScene('S').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));
    const { removed } = applyRule(doc);
    expect(removed).toBe(1);
    expect(triCount(prim)).toBe(1);
  });

  it('здоровую геометрию не трогает', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]));
    const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(new Uint16Array([0, 1, 2, 1, 3, 2]));
    const prim = doc.createPrimitive().setMode(4)
      .setAttribute('POSITION', position).setIndices(indices);
    doc.createScene('S').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));
    const { out, removed } = applyRule(doc);
    expect(removed).toBe(0);
    expect(out.found, 'на здоровой модели правило не должно писать в отчёт').toBeUndefined();
    expect(triCount(prim)).toBe(2);
  });
});


describe('осторожность там, где вершины могут разойтись', () => {
  it('у примитива с запасной формой по позициям не режем', () => {
    const { doc, prim } = docWithCoincidentCorner({ morph: true });
    const { removed } = applyRule(doc);
    expect(removed, 'треугольник убран, хотя морф разводит его углы').toBe(0);
    expect(triCount(prim)).toBe(2);
  });

  it('вершины на РАЗНЫХ костях — не режем', () => {
    const { doc, prim } = docWithCoincidentCorner({
      joints: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    });
    const { removed } = applyRule(doc);
    expect(removed, 'треугольник убран, хотя кости разведут его углы').toBe(0);
    expect(triCount(prim)).toBe(2);
  });

  it('вершины на ОДНОЙ кости — режем: разойтись им нечем', () => {
    const { doc, prim } = docWithCoincidentCorner({
      joints: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    const { removed } = applyRule(doc);
    expect(removed).toBe(1);
    expect(triCount(prim)).toBe(1);
  });

  it('общий индексный аксессор не режется по чужим позициям', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(new Uint16Array([0, 1, 2, 0, 1, 3]));
    const mk = (arr) => doc.createPrimitive().setMode(4)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(arr)))
      .setIndices(indices);
    const bad = mk([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    const good = mk([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 2]);
    doc.createScene('S').addChild(doc.createNode('N')
      .setMesh(doc.createMesh('M').addPrimitive(bad).addPrimitive(good)));

    applyRule(doc);
    expect(triCount(bad), 'вырожденный не убран у своего примитива').toBe(1);
    expect(triCount(good), 'рез по чужим позициям выкосил здоровый треугольник').toBe(2);
  });
});


describeIfModels(['Production Multi UV 01.glb'], 'на настоящей модели', () => {
  it('сборка с Draco проходит, а не помечается отказом', async () => {
    const res = await optimizeFile(modelPath('Production Multi UV 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
      locale: 'ru',
    });
    expect(res.status, 'здоровая сборка снова помечена отказом').toBe('ok');

    const hard = res.validation.filter((v) => v.i18n?.text?.messageId === 'check.baselineHardMismatch');
    expect(hard.map((v) => v.text), 'вернулась надпись про нарушение гарантии').toEqual([]);

    const cut = res.applied.find((a) => a.ruleId === RULE_ID);
    expect(cut, 'вырожденные треугольники не убраны — значит их снова выбросит Draco').toBeTruthy();

    const delta = res.metrics.before.triangles - res.metrics.after.triangles;
    expect(delta).toBeGreaterThan(0);
    const dropped = res.validation.find((v) => v.i18n?.text?.messageId === 'check.trianglesDropped');
    expect(dropped, 'потеря не объяснена вырожденными').toBeTruthy();
  });
});
