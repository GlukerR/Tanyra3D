// Input folder matrix tests — полный прогон ВСЕХ моделей input/ через все значимые
// комбинации advancedFeatures.
//
// ЗАПУСК: только при переменной окружения FULL_MATRIX=1, иначе describe.skip.
//   FULL_MATRIX=1 npx vitest run tests/input-folder-matrix.test.mjs
//
// Папки input/ на чистом клоне нет (она в .gitignore) — при её отсутствии тесты
// graceful-пропускаются, а не падают.
//
// Таймауты: 300 с на тест (тяжёлые модели + внешний toktx для ktx2).
//
// Инварианты (из задания):
//   - исключений наружу — ни одного
//   - status: 'ok' или 'fail', НЕ undefined
//   - если ok: metrics.before/after заполнены, без null и NaN
//   - если ok: треугольников не БОЛЬШЕ, чем было
//   - если ok: файл не вырос >25% (кроме ktx2 — там gpuBytes.after < gpuBytes.before)
//   - если fail: есть error или запись level:'fail' в validation

import { describe, it, expect, beforeAll } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

// ---- Комбинации флагов ----
const COMBOS = [
  { name: 'passthrough',        flags: [] },
  { name: 'safe',               flags: ['safe'] },
  { name: 'safe+join',          flags: ['safe', 'join'] },
  { name: 'safe+join+instance', flags: ['safe', 'join', 'instance'] },
  { name: 'safe+meshopt',       flags: ['safe', 'meshopt'] },
  { name: 'safe+draco',         flags: ['safe', 'draco'] },
  { name: 'safe+ktx2',          flags: ['safe', 'ktx2'] },
  { name: 'safe+resample',      flags: ['safe', 'resample'] },
];

const GROWTH_LIMIT_PCT = 25; // порог роста файла (кроме ktx2)
const TEST_TIMEOUT_MS = 300_000; // 5 минут на тест — toktx на тяжёлых текстурах

// ---- Список моделей ----
const inputExists = fs.existsSync(INPUT_DIR);
let inputModels = [];
if (inputExists) {
  inputModels = fs.readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    .sort();
}

const MATRIX_TOTAL = inputModels.length * COMBOS.length;

// ---- Guards ----
const shouldRun = process.env.FULL_MATRIX === '1';
const skipReason = shouldRun
  ? null
  : 'FULL_MATRIX не установлен. Запусти: FULL_MATRIX=1 npx vitest run tests/input-folder-matrix.test.mjs';

// ---- Вспомогательные функции ----

/** Все ли ключи метрик присутствуют и не null/NaN */
function metricsAreSound(m) {
  if (!m || typeof m !== 'object') return false;
  const required = [
    'fileBytes', 'drawCalls', 'triangles', 'vertices',
    'textureBytes', 'gpuBytes', 'meshes', 'materials',
    'nodes', 'animations',
  ];
  for (const k of required) {
    if (!(k in m)) return false;
    const v = m[k];
    if (v === null || v === undefined) return false;
    if (typeof v === 'number' && Number.isNaN(v)) return false;
  }
  return true;
}

/** Есть ли внятная причина отказа */
function hasFailReason(result) {
  if (result.error && typeof result.error === 'string' && result.error.length > 0) return true;
  if (Array.isArray(result.validation) && result.validation.some((v) => v.level === 'fail')) return true;
  return false;
}

// ---- Тесты ----

const matrixDescribe = shouldRun ? describe : describe.skip;

matrixDescribe(`Input folder — matrix: ${inputModels.length} models × ${COMBOS.length} combos = ${MATRIX_TOTAL} runs`, () => {

  beforeAll(() => {
    if (!inputExists || inputModels.length === 0) {
      console.warn('  ⚠️  input/ directory empty or missing — matrix tests will have nothing to run.');
    }
  });

  for (const combo of COMBOS) {
    describe(`${combo.name} [${combo.flags.join(',') || 'none'}]`, () => {

      it.each(inputModels)(
        `${combo.name}: %s`,
        async (modelName) => {
          const modelFullPath = path.join(INPUT_DIR, modelName);
          expect(fs.existsSync(modelFullPath)).toBe(true);

          let result;
          try {
            result = await optimizeFile(modelFullPath, {
              advancedFeatures: combo.flags,
              dryRun: true,
            });
          } catch (e) {
            // Инвариант 1: исключений наружу быть не должно
            throw new Error(
              `optimizeFile бросил исключение на ${modelName} / ${combo.name}: ${e.message}`,
            );
          }

          // Инвариант 2: status определён и одно из допустимых
          expect(result.status, `status undefined on ${modelName} / ${combo.name}`).toBeDefined();
          expect(['ok', 'fail', 'skip']).toContain(result.status);

          if (result.status === 'ok') {
            // Инвариант 3: метрики заполнены
            expect(metricsAreSound(result.metrics.before),
              `metrics.before broken on ${modelName} / ${combo.name}`).toBe(true);
            expect(metricsAreSound(result.metrics.after),
              `metrics.after broken on ${modelName} / ${combo.name}`).toBe(true);

            // Инвариант 4: треугольники не выросли
            const triBefore = result.metrics.before.triangles;
            const triAfter = result.metrics.after.triangles;
            expect(triAfter,
              `triangles grew ${triBefore} → ${triAfter} on ${modelName} / ${combo.name}`
            ).toBeLessThanOrEqual(triBefore);

            // Инвариант 5: файл не вырос >25% (кроме ktx2)
            if (!combo.flags.includes('ktx2')) {
              const fileBefore = result.metrics.before.fileBytes;
              const fileAfter = result.metrics.after.fileBytes;
              const limit = Math.ceil(fileBefore * (1 + GROWTH_LIMIT_PCT / 100));
              expect(fileAfter,
                `file grew >${GROWTH_LIMIT_PCT}%: ${fileBefore} → ${fileAfter} on ${modelName} / ${combo.name}`
              ).toBeLessThanOrEqual(limit);
            } else {
              // ktx2: gpuBytes должен уменьшиться
              const gpuBefore = result.metrics.before.gpuBytes;
              const gpuAfter = result.metrics.after.gpuBytes;
              // Если текстур не было — gpuBytes может быть 0=0, это не ошибка
              if (gpuBefore > 0) {
                expect(gpuAfter,
                  `gpuBytes grew under ktx2: ${gpuBefore} → ${gpuAfter} on ${modelName}`
                ).toBeLessThan(gpuBefore);
              }
            }
          }

          if (result.status === 'fail') {
            // Инвариант 6: есть причина отказа
            expect(hasFailReason(result),
              `fail без причины на ${modelName} / ${combo.name}`
            ).toBe(true);
          }
        },
        TEST_TIMEOUT_MS,
      );

    });
  }
});
