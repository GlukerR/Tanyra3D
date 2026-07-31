// tests/analyse-baseline.test.mjs — автоматический baseline-гейт для golden-corpus
//
// Запускает `node tests/analyse-test-coverage.mjs --json` и проверяет, что:
//   1. Число тестов не упало ниже baseline (228);
//   2. Все закоммиченные модели (REPO_MODELS) присутствуют на диске;
//   3. Каждая модель покрыта хотя бы одной комбинацией флагов.
//
// Файл подхватывается vitest автоматически (include: tests/**/*.test.mjs)
// и выполняется вместе с остальными тестами корпуса. Никаких изменений
// в vitest.config.mjs не требуется.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const analyseScript = path.resolve(__dirname, 'analyse-test-coverage.mjs');

const { BASELINE_ITS, BASELINE_FLAG_COMBOS } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'baselines.json'), 'utf-8'),
);

describe('Golden Corpus — baseline (analyse-test-coverage)', () => {
  let data;

  beforeAll(() => {
    let raw;
    try {
      raw = execFileSync('node', [analyseScript, '--json'], {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(
        `analyse-test-coverage.mjs failed: ${err.message}\n` +
        `Ensure the script runs standalone: node ${analyseScript} --json`,
        { cause: err },
      );
    }
    data = JSON.parse(raw);
  });

  it(`число тестов не упало ниже baseline (≥ ${BASELINE_ITS})`, () => {
    expect(data.totalIts).toBeGreaterThanOrEqual(BASELINE_ITS);
  });

  // Только закоммиченные модели (REPO_MODELS). Локальные на чистом клоне
  // отсутствуют законно — describeLocal их пропускает, см. helpers/model-files.mjs.
  it('все закоммиченные модели (REPO_MODELS) присутствуют на диске', () => {
    expect(data.modelsMissing || []).toEqual([]);
  });

  it('каждая модель покрыта хотя бы одной комбинацией флагов', () => {
    const uncovered = Object.entries(data.modelCoverage || {})
      .filter(([, info]) => !(info.flags || []).length && !info.tests);
    expect(uncovered).toEqual([]);
  });

  it('пропущенных тестов не более 5 (допустимы только it.skip с причиной)', () => {
    // Допустимые пропуски: gltf-validator (1), потенциальные будущие
    // интеграционные проверки. Жёсткий лимит — 5.
    expect(data.skippedIts).toBeLessThanOrEqual(5);
  });

  it(`уникальных комбинаций флагов не менее ${BASELINE_FLAG_COMBOS} (правила не переименовывали и не удаляли)`, () => {
    const uniq = new Set(
      (data.flagCombinations || []).map((fc) => JSON.stringify(fc.flags)),
    );
    expect(uniq.size).toBeGreaterThanOrEqual(BASELINE_FLAG_COMBOS);
  });
});
