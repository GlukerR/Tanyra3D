// tests/heavy-stress-input.test.mjs — стресс ТЯЖЁЛЫХ моделей из input/.
//
// Класс `heavy` в tests/helpers/model-situations.mjs объявлен дырой корпуса:
// «нет модели >50 МБ … тяжёлые модели живут в input/ и у клиентов, в fixtures
// не добавляем». Этот файл — то место, где обещание класса реально гоняется:
// ВСЕ модели input/ тяжелее HEAVY_BYTES прогоняются через стрессовые наборы
// флагов. Сейчас представитель один — самый большой файл корпуса:
//   input/uploads_files_5625009_Post_Apocalyptic_UAZ — копия.glb (~146 МБ,
//   118 411 треугольников, 12 текстур на ~140 МБ).
//
// input/ в .gitignore (модели не версионируются) — на чистом клоне папки нет,
// и файл graceful-пропускается, как input-folder.test.mjs.
//
// Покрытие по комбо:
//   passthrough   — стресс загрузки: 146 МБ читаются без OOM и без краха;
//   safe          — чистка на большом файле;
//   safe+quantize — геометрический проход на больших данных;
//   safe+webp     — текстурный стресс (главный для UAZ: 140 МБ текстур).
//
// Инварианты (как у input-folder-matrix): исключений наружу — ни одного;
// status — ok/fail/skip, не undefined; если ok — metrics заполнены, треугольников
// не больше, валидация без level:'fail'; если fail — причина есть.
//
// Таймаут 300 с на тест — запас поверх измеренных 0.5–19 с. Смысл таймаута —
// ловить зависание, а не скорость (см. vitest.config.mjs).

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

// Тот же порог «тяжёлой» модели, что и в реестре ситуаций (HEAVY_BYTES).
const HEAVY_BYTES = 50 * 1024 * 1024;

// Стрессовые наборы флагов. Тяжёлое здесь — не геометрия (118 тыс. треугольников
// это немного), а ТЕКСТУРЫ: 12 штук на ~140 МБ. Поэтому safe+webp — главный
// стресс-прогон для этого представителя.
const COMBOS = [
  { name: 'passthrough',   flags: [] },
  { name: 'safe',          flags: ['safe'] },
  { name: 'safe+quantize', flags: ['safe', 'quantize'] },
  { name: 'safe+webp',     flags: ['safe', 'webp'] },
];

const TEST_TIMEOUT_MS = 300_000;

const inputExists = fs.existsSync(INPUT_DIR);
let heavyModels = [];
if (inputExists) {
  heavyModels = fs.readdirSync(INPUT_DIR)
    .filter((f) => /\.(glb|gltf)$/i.test(f))
    .filter((f) => fs.statSync(path.join(INPUT_DIR, f)).size > HEAVY_BYTES)
    .sort();
}

describe('Тяжёлые модели input/ — стресс (класс heavy)', () => {
  // Папки input/ нет на чистом клоне (в .gitignore) — весь блок graceful-пропускается,
  // чтобы набор оставался зелёным после свежего clone, как в input-folder.test.mjs.
  if (!inputExists) {
    it.skip('папка input/ отсутствует (чистый клон) — стресс тяжёлых моделей недоступен', () => {});
    return;
  }

  it('в input/ есть хотя бы одна модель тяжелее 50 МБ (представитель класса heavy)', () => {
    expect(heavyModels.length).toBeGreaterThan(0);
  });

  for (const name of heavyModels) {
    for (const combo of COMBOS) {
      it(`${name} — ${combo.name}: завершается в таймаут, без исключений наружу`, async () => {
        const result = await optimizeFile(
          path.join(INPUT_DIR, name),
          { advancedFeatures: combo.flags, dryRun: true },
          TEST_TIMEOUT_MS,
        );

        expect(result.status).toMatch(/ok|fail|skip/);

        if (result.status === 'ok') {
          expect(result.metrics.before).toBeTruthy();
          expect(result.metrics.after).toBeTruthy();
          expect(result.metrics.before.triangles).toBeGreaterThan(0);
          // Инвариант: треугольников не БОЛЬШЕ, чем было.
          expect(result.metrics.after.triangles).toBeLessThanOrEqual(result.metrics.before.triangles);
          expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
        } else if (result.status === 'fail') {
          // fail обязан быть честным: есть error или запись level:'fail' в validation.
          const reason = result.error || result.validation.find((v) => v.level === 'fail')?.message;
          expect(reason).toBeTruthy();
        }
      }, TEST_TIMEOUT_MS);
    }
  }
});
