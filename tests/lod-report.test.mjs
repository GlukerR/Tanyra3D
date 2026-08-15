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
