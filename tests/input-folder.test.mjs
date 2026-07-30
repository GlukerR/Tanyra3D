// Input folder batch tests — прогон ВСЕХ моделей из input/ через optimizeFile.
//
// Папка input/ содержит 65+ моделей разного размера, сложности и происхождения
// (многие с кириллическими именами, пробелами, спецсимволами).
//
// ВАЖНО: базовый пайплайн запускается автоматически — advancedFeatures НЕ нужен.
// Поле advancedFeatures только для опциональных расширений: 'ktx2', 'draco', 'strip-colors'.
//
// Все тесты используют dryRun: true, чтобы не писать .glb файлы.
// Цель: проверить, что ни одна модель не вызывает исключение (crash).

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

/** Проверить, что папка input/ существует и не пуста */
const inputExists = fs.existsSync(INPUT_DIR);
let inputModels = [];
if (inputExists) {
  inputModels = fs.readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    .sort();
}

const inputModelCount = inputModels.length;

// Известные проблемные модели — set пуст после audit-фикса BUG-006:
// decepticon_fighter.glb и uttvm_core_guard.glb теперь возвращают 'ok'
// (bounding-box false positive на passthrough больше не блокирует запись).
// Если кто-то снова начнёт валиться — добавить сюда с комментарием.
const KNOWN_FAILING = new Set([]);

// ---- Smoke: check that input folder has models ----
describe('Input folder — basic checks', () => {
  it('input/ directory exists', () => {
    expect(inputExists).toBe(true);
  });

  it('input/ has at least one .glb/.gltf model', () => {
    expect(inputModelCount).toBeGreaterThan(0);
  });
});

// ---- Batch passthrough for ALL input models ----
describe('Input folder — batch passthrough (default pipeline)', () => {

  it.each(inputModels)(`passthrough: %s`, async (modelName) => {
    const modelFullPath = path.join(INPUT_DIR, modelName);
    expect(fs.existsSync(modelFullPath)).toBe(true);

    const result = await optimizeFile(modelFullPath, {
      advancedFeatures: [],
      dryRun: true,
    });

    if (KNOWN_FAILING.has(modelName)) {
      // Известная проблема — баг уже зафиксирован в аудите (BUG-006)
      // Примечание: result.error может быть undefined — баг в обработке ошибок
      expect(result.status).toBe('fail');
      return;
    }

    expect(['ok', 'skip']).toContain(result.status);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
  });
});

// ---- Safe cleanup + core invariant ----
describe('Input folder — safe cleanup (core invariant)', () => {

  it.each(inputModels.filter((m) => !KNOWN_FAILING.has(m)))(
    `safe cleanup: %s`,
    async (modelName) => {
      const modelFullPath = path.join(INPUT_DIR, modelName);
      const result = await optimizeFile(modelFullPath, {
        advancedFeatures: ['safe'],
        dryRun: true,
      });

      if (result.status === 'ok') {
        // Core invariant: triangles stay ≈ same (degenerate removal is normal)
        const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
        // Допуск 5000: input-модели могут иметь много вырожденных треугольников
        // (напр. Ноутбук.glb удаляет 2264, 2 (3).glb — 1546)
        expect(delta).toBeLessThanOrEqual(5000);
        // applied.length может быть 0 на уже-чистых моделях (safe нашёл нечего чистить) —
        // это корректное поведение opt-in. Главный инвариант — safe НЕ ломает валидацию.
        expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
      } else if (result.status === 'skip') {
        expect(result.file.written).toBe(false);
      } else {
        // Неизвестный fail — логируем модель для отладки
        console.warn(`  ⚠️  UNEXPECTED FAIL: ${modelName} — ${result.error?.slice(0, 100)}`);
        expect(result.status).toMatch(/ok|skip/);
      }
    },
  );
});

// ---- Edge case: имена с пробелами и кириллицей ----
describe('Input folder — edge case filenames', () => {
  const edgeNames = inputModels.filter((n) =>
    /[\s\(\)\[\]\{\}\&\+\=\%\#\@\!\,\;]/.test(n) ||
    /[а-яА-ЯёЁ]/.test(n),
  );
  const edgeKnownFailing = edgeNames.filter((n) => KNOWN_FAILING.has(n));

  it.each(edgeNames)(`edge filename: %s`, async (modelName) => {
    const modelFullPath = path.join(INPUT_DIR, modelName);
    const result = await optimizeFile(modelFullPath, {
      advancedFeatures: [],
      dryRun: true,
    });

    if (KNOWN_FAILING.has(modelName)) {
      expect(result.status).toBe('fail');
      return;
    }

    // Имена с пробелами/кириллицей не должны ломать пайплайн
    expect(['ok', 'skip']).toContain(result.status);
  });

  it(`edge filename count: ${edgeNames.length} models with special chars, ${edgeKnownFailing.length} known failing`, () => {
    expect(edgeNames.length).toBeGreaterThan(0);
  });
});

// ---- Статистика по размеру файлов ----
describe('Input folder — file size statistics', () => {
  it('generates size statistics for all input models', () => {
    const stats = inputModels.map((name) => {
      const p = path.join(INPUT_DIR, name);
      try {
        const s = fs.statSync(p);
        return { name, sizeBytes: s.size, sizeMB: (s.size / (1024 * 1024)).toFixed(2) };
      } catch {
        return { name, sizeBytes: 0, sizeMB: '0.00' };
      }
    });

    const totalMB = stats.reduce((sum, s) => sum + parseFloat(s.sizeMB), 0);
    const maxModel = stats.reduce((max, s) => s.sizeBytes > max.sizeBytes ? s : max, stats[0] || { name: 'none', sizeBytes: 0 });

    expect(stats.length).toBe(inputModelCount);
    expect(totalMB).toBeGreaterThan(0);
    expect(maxModel.sizeBytes).toBeGreaterThan(0);

    console.log(`\n  📊 Input folder stats: ${inputModelCount} models, ${totalMB.toFixed(2)} MB total`);
    console.log(`  📦 Largest: ${maxModel.name} (${(maxModel.sizeBytes / (1024 * 1024)).toFixed(2)} MB)`);
  });
});
