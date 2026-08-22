// tests/degenerate-triangles.test.mjs — треугольник нулевой площади убираем МЫ, а не Draco.
//
// ПОВОД (Александр, 2026-08-22). В отчёте при сжатии Draco появлялось: «Нарушение гарантии
// компонента: triangles изменился после расширений (было 108644, стало 108108)… доверять
// ему как точной копии исходной геометрии нельзя». Его вопрос: «Это вообще не выглядит как
// ошибка, потому что модель не становилась ни разу хуже».
//
// ЗАМЕР по 61 настоящей модели показал, что он прав, и назвал причину точно:
//
//   потеря треугольников = (тройки с повторяющимся ИНДЕКСОМ) + (тройки, у которых два
//   угла стоят в одной ТОЧКЕ при разных индексах)
//
// Сходилось до единицы на всех проверенных: Whatsminer 2 + 17558 = 17560, Е300
// 213 + 192 = 405, подземка6 160 + 0 = 160, лифт 50 + 14 = 64. От числа бит квантования
// (11/14/16/20) потеря не зависела вовсе — значит дело не в сетке кодека.
//
// Первый вид мы убирали и раньше, второй — нет: weld такие вершины НЕ склеивает, потому
// что у них различаются нормаль или развёртка. Как вершины они разные, как углы
// треугольника — одна точка. Их находил уже кодировщик Draco и выбрасывал сам, на записи,
// после снимка baseline-checkpoint. Отсюда и «нарушение гарантии»: пугающая надпись на
// совершенно здоровой сборке.
//
// Убираем их сами, в базовом проходе, — и терять Draco становится нечего. Правило 11 это
// разрешает прямо: вырожденный треугольник никто не делал намеренно, это след экспорта.
//
// ГРАНИЦА ОСТОРОЖНОСТИ. «Одна точка» — правда только для текущей позы. Под морфом или под
// костью вершины расходятся, и треугольник оживает. Поэтому по позициям режем лишь там,
// где расхождение невозможно: морф-целей нет, привязка к костям одинаковая.

import { describe, it, expect, afterAll } from 'vitest';
import { Document } from '@gltf-transform/core';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const RULE_ID = 'geometry/degenerate-triangles';

afterAll(cleanupTmpOutDirs);

/** Прогнать fix() правила по документу — без движка и без файла. */
function applyRule(doc) {
  const rule = RULES.find((r) => r.meta.id === RULE_ID);
  const cache = new Map();
  const out = rule.fix({ messageId: 'pipeline', data: {} }, { document: doc, cache, opts: {} });
  return { out, removed: cache.get('degenerateRemoved') };
}

/**
 * Меш из четырёх вершин, где v3 стоит ровно там же, где v0.
 *
 * Треугольники: [0,1,2] — настоящий; [0,1,3] — два угла в одной точке, нулевая площадь.
 * Индексы у этих углов РАЗНЫЕ: ровно тот случай, который weld не склеивает.
 */
function docWithCoincidentCorner({ morph = false, joints = null } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 0, // та же точка, что v0
    ]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 1, 3]));
  const prim = doc.createPrimitive().setMode(4)
    .setAttribute('POSITION', position).setIndices(indices);

  if (morph) {
    // Запасная форма разводит v0 и v3 — под ней треугольник перестаёт быть вырожденным.
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

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · Совпадающая точка при разных индексах
// ═══════════════════════════════════════════════════════════════════════════

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
      .setArray(new Uint16Array([0, 1, 2, 0, 1, 1])); // второй — с повтором
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

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · Где «одна точка» — правда только для текущей позы
// ═══════════════════════════════════════════════════════════════════════════

describe('осторожность там, где вершины могут разойтись', () => {
  it('у примитива с запасной формой по позициям не режем', () => {
    const { doc, prim } = docWithCoincidentCorner({ morph: true });
    const { removed } = applyRule(doc);
    expect(removed, 'треугольник убран, хотя морф разводит его углы').toBe(0);
    expect(triCount(prim)).toBe(2);
  });

  it('вершины на РАЗНЫХ костях — не режем', () => {
    // v0 привязана к кости 0, v3 — к кости 1: в анимации они разъедутся.
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
    // Два примитива делят ОДИН аксессор индексов, но вершины у них разные: у первого
    // v0 и v3 в одной точке, у второго — нет. Рез по первому не имеет права выкосить
    // треугольник у второго.
    const doc = new Document();
    const buffer = doc.createBuffer();
    const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(new Uint16Array([0, 1, 2, 0, 1, 3]));
    const mk = (arr) => doc.createPrimitive().setMode(4)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(arr)))
      .setIndices(indices);
    const bad = mk([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);   // v3 = v0
    const good = mk([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 2]);  // все четыре разные
    doc.createScene('S').addChild(doc.createNode('N')
      .setMesh(doc.createMesh('M').addPrimitive(bad).addPrimitive(good)));

    applyRule(doc);
    expect(triCount(bad), 'вырожденный не убран у своего примитива').toBe(1);
    expect(triCount(good), 'рез по чужим позициям выкосил здоровый треугольник').toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 3 · Настоящая модель: Draco больше не теряет ничего
// ═══════════════════════════════════════════════════════════════════════════

describeIfModels(['Production Multi UV 01.glb'], 'на настоящей модели', () => {
  // Эта модель корпуса и воспроизводит дефект: 213 троек с повторяющимся индексом плюс
  // 192 с совпадающей точкой = 405. До правки Draco выбрасывал их сам, сборка получала
  // status:'fail' и надпись про нарушение гарантии.
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

    // Потеря треугольников объяснена вырожденными, а не осталась загадкой.
    const delta = res.metrics.before.triangles - res.metrics.after.triangles;
    expect(delta).toBeGreaterThan(0);
    const dropped = res.validation.find((v) => v.i18n?.text?.messageId === 'check.trianglesDropped');
    expect(dropped, 'потеря не объяснена вырожденными').toBeTruthy();
  });
});
