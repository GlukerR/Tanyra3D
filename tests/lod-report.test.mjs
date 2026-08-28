// tests/lod-report.test.mjs — уровни детализации названы человеку, а не молча пропущены.
//
// Слово Александра 2026-08-15: «создание лодов пока не будем делать, но показывать лоды
// если они есть мы как то должны».
//
// Картинка у нас и так верная: MSFT_lod вешает на узел список запасных, менее подробных
// версий, а three.js расширение игнорирует и рисует самый подробный — то есть ровно тот,
// который художник и хочет видеть. Не хватало только СЛОВА: человек не знал, что в файле
// есть ещё уровни и что показан из них один.
//
// Поэтому правило scene/lod-levels — наблюдение без починки: у него нет ни canFix, ни
// fix, и появиться они не должны. Первое такое правило в проекте, и на нём вскрылась
// мёртвая ветка ядра (см. второй раздел).

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';

const RULE_ID = 'scene/lod-levels';
const LOD_MODEL = 'Unknown Ext LOD 01.glb';
const PLAIN_MODEL = 'Dirty Cube 01.glb';

// Временные папки — из общего хелпера; своя была БЕЗ уборки и копилась в %TEMP%.
afterAll(cleanupTmpOutDirs);

const runOn = (model) => optimizeFile(modelPath(model), {
  advancedFeatures: ['safe'],
  outDir: tmpOutDir(),
});
const linesOf = (result, locale) =>
  (localizeResult(result, locale).findings || []).filter((e) => e.ruleId === RULE_ID);

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · Само правило
// ═══════════════════════════════════════════════════════════════════════════

describe('уровни детализации — наблюдение в отчёте', () => {
  it('правило существует и НЕ умеет чинить', () => {
    const rule = RULES.find((r) => r.meta.id === RULE_ID);
    expect(rule, `правило ${RULE_ID} исчезло из списка`).toBeTruthy();
    // Создание и переключение уровней в задачи проекта не входит. Появившийся здесь
    // fix — не улучшение, а смена решения, и приниматься она должна не молча.
    expect(rule.fix, 'у правила появилась починка — это отдельное решение, не рефакторинг').toBeUndefined();
    // Наблюдение не зависит ни от одной галочки: человек должен узнать про уровни
    // и тогда, когда не включил ни одной оптимизации.
    expect(rule.meta.enabled({}), 'наблюдение стало зависеть от галочки').toBe(true);
  });

  const withLod = isPresent(LOD_MODEL) ? it : it.skip;
  withLod(`${LOD_MODEL} — строка про уровни есть и на русском, и на английском`, async () => {
    const r = await runOn(LOD_MODEL);
    for (const locale of ['ru', 'en']) {
      const lines = linesOf(r, locale);
      // Одна запись на класс (Правило 9): узлов с уровнями бывают десятки, строка одна.
      expect(lines.length, `[${locale}] ожидалась ровно одна строка про уровни`).toBe(1);
      expect(lines[0].text.length, `[${locale}] строка пустая`).toBeGreaterThan(20);
    }
    // Отчёт переживает смену языка БЕЗ пересборки (Правило 8): рецепт строки лежит
    // в записи, и второй язык собирается из того же результата.
    expect(linesOf(r, 'ru')[0].text).not.toBe(linesOf(r, 'en')[0].text);
  }, 120_000);

  const withPlain = isPresent(PLAIN_MODEL) ? it : it.skip;
  withPlain(`${PLAIN_MODEL} — модель без уровней молчит`, async () => {
    const r = await runOn(PLAIN_MODEL);
    expect(linesOf(r, 'ru').length, 'наблюдение сработало там, где уровней нет').toBe(0);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · Ветка ядра, которая не работала ни разу
// ═══════════════════════════════════════════════════════════════════════════
//
// core/engine.mts, ветка `if (!rule.fix)`: находка правила-наблюдения идёт в «Анализ».
// Там стояло `addFound(rule.meta, finding.text)` — готовая строка, которой у находки
// нет и быть не может: Правило 8 запрещает пользовательский текст в логике, находка
// несёт `{ messageId, data }`. Правил без починки в проекте не было, ветка ни разу не
// исполнялась, и дефект дожил до первого такого правила.
//
// Сторож структурный, как у «правила истины» (tests/bugs-found.test.mjs): читает
// ИСХОДНИК и краснеет от возврата к `finding.text`, а не ждёт, пока пропадёт строка в
// отчёте конкретной модели.

describe('ядро — находка правила без починки доходит до отчёта', () => {
  const src = fs.readFileSync(new URL('../core/engine.mts', import.meta.url), 'utf8');

  it('в «Анализ» передаётся сама находка, а не её пустой text', () => {
    expect(src).toContain('if (!rule.fix) { addFound(rule.meta, finding); continue; }');
    expect(src, 'вернулась передача finding.text — наблюдения снова пропадут молча')
      .not.toContain('addFound(rule.meta, finding.text)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 3 · Уровни БЕЗ расширения — то, ради чего правило переписано
//
// ЗАКАЗ (Александр, 2026-08-28): «надо что бы в правой панели тоже показывало».
//
// До этого дня отчёт видел ровно `MSFT_lod` — способ правильный, но его экспортируют
// единицы. Куда чаще уровни лежат просто соседними узлами: у Sketchfab подписанными
// «LOD», у прочих не подписанными никак. Про них отчёт молчал — при том что
// переключатель уровней над моделью для них уже появлялся. Один вопрос — два разных
// ответа в двух местах.
//
// ПОЧЕМУ ЗАГОТОВКА, А НЕ МОДЕЛЬ ИЗ КОРПУСА. Модель с уровнями-соседями в корпусе одна
// (StoneWellLodsFlat), и её, как и все модели, в git нет (Правило 0) — на CI проверка
// не выполнилась бы ни разу. Лесенка строится здесь же за миллисекунды и работает на
// любом клоне. Настоящий колодец проверяется ниже, когда он на диске есть.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Собрать GLB с лестницей подробности: три соседних узла одного габарита, каждый
 * следующий кратно грубее.
 *
 * Треугольники считаются по числу вершин (индексов нет), габарит — по самим вершинам.
 * Первые две вершины ставят углы коробки, поэтому габарит у всех трёх одинаковый — как
 * у настоящих уровней одной и той же вещи.
 */
async function ladderGlb(dir, vertexCounts, names) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const rig = doc.createNode('rig');
  scene.addChild(rig);

  vertexCounts.forEach((verts, i) => {
    const data = new Float32Array(verts * 3);
    data.set([0, 0, 0, 1, 1, 1], 0);
    for (let v = 2; v < verts; v++) {
      data[v * 3] = (v % 7) / 7;
      data[v * 3 + 1] = (v % 5) / 5;
      data[v * 3 + 2] = (v % 3) / 3;
    }
    const pos = doc.createAccessor().setType('VEC3').setArray(data).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos);
    const mesh = doc.createMesh('m' + i).addPrimitive(prim);
    rig.addChild(doc.createNode(names[i]).setMesh(mesh));
  });

  const file = path.join(dir, 'ladder.glb');
  await new NodeIO().write(file, doc);
  return file;
}

describe('уровни-соседи доходят до правой панели', () => {
  it('лестница без подписи названа догадкой, а не фактом', async () => {
    const dir = tmpOutDir();
    const file = await ladderGlb(dir, [300, 30, 9], ['well', 'well_far', 'Plane.003']);
    const result = await optimizeFile(file, { advancedFeatures: ['safe'], outDir: tmpOutDir() });
    const lines = linesOf(result, 'ru');

    expect(lines.length, 'про уровни в отчёте по-прежнему ни строчки').toBe(1);
    // «Похоже» — не украшение: это ДОГАДКА по измерению, и выдавать её за факт нельзя.
    expect(lines[0].text).toMatch(/Похоже/);
    expect(lines[0].text, 'не сказано, сколько уровней найдено').toMatch(/до 3/);
    // И сказано главное следствие: связи между уровнями нет, значит рисуются все сразу.
    expect(lines[0].text).toMatch(/все сразу/);
  });

  it('подписанная лестница названа подписью, а не измерением', async () => {
    // Разный вес утверждения — разные строки. Автор, подписавший узлы, сказал прямо;
    // измерение только догадалось.
    const dir = tmpOutDir();
    const file = await ladderGlb(dir, [300, 30, 9], ['w_LOD0', 'w_LOD1', 'w_LOD2']);
    const result = await optimizeFile(file, { advancedFeatures: ['safe'], outDir: tmpOutDir() });
    const lines = linesOf(result, 'ru');

    expect(lines.length).toBe(1);
    expect(lines[0].text, 'подпись LOD не названа источником').toMatch(/подписаны LOD/);
  });

  it('строка переживает смену языка — она собирается из ключа', () => {
    // Правило 8: готовый отчёт обязан переводиться БЕЗ пересборки.
    const dir = tmpOutDir();
    return ladderGlb(dir, [300, 30, 9], ['a', 'b', 'c'])
      .then((file) => optimizeFile(file, { advancedFeatures: ['safe'], outDir: tmpOutDir() }))
      .then((result) => {
        expect(linesOf(result, 'ru')[0].text).toMatch(/Похоже/);
        expect(linesOf(result, 'en')[0].text).toMatch(/looks like/);
      });
  });

  it('обычные части моделью с уровнями не становятся', async () => {
    // Сторож догадки. Три узла одинаковой подробности — это части, а не версии.
    const dir = tmpOutDir();
    const file = await ladderGlb(dir, [300, 300, 300], ['left', 'middle', 'right']);
    const result = await optimizeFile(file, { advancedFeatures: ['safe'], outDir: tmpOutDir() });
    expect(linesOf(result, 'ru').length, 'части приняты за уровни').toBe(0);
  });

  // Настоящая выгрузка Sketchfab — когда она есть на диске. Шесть уровней соседями,
  // расширения в файле нет вовсе.
  const FLAT = 'StoneWellLodsFlat.glb';
  const flatIt = isPresent(FLAT) ? it : it.skip;
  flatIt('StoneWellLodsFlat — шесть уровней названы в отчёте', async () => {
    const result = await runOn(FLAT);
    const lines = linesOf(result, 'ru');
    expect(lines.length, 'про шесть уровней колодца отчёт молчит').toBe(1);
    expect(lines[0].text).toMatch(/до 6/);
    expect(lines[0].text).toMatch(/подписаны LOD/);
  }, 120000);
});
