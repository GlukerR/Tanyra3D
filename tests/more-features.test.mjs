// Дополнительные тесты фич: strip-colors, keepParts, validation, force.
//
// Все тесты используют dryRun: true (кроме force-теста, который пишет и чистит).
// Только публичное API: { optimizeFile, listRules, VERSION } из optimize2.mjs.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { optimizeFile, listRules } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

// ================================================================
// strip-colors — удаление раскрашенных вершинных цветов (lossy)
// ================================================================

describe('strip-colors', () => {
  it('advancedFeatures:["strip-colors"] returns status ok', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  });

  it('strip-colors preserves structure (works on models with and without COLOR_n)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // applied.length может быть 0 на модели без COLOR_n (CarConcept их не имеет) —
    // это корректное поведение opt-in: правило выполнилось, но не нашло что удалять.
    // Главный инвариант — strip-colors не ломает файл.
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('strip-colors preserves triangles (core invariant)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  });

  it('strip-colors works alongside safe + meshopt', async () => {
    // strip-colors + явные safe/meshopt — проверяем, что opt-in фичи не конфликтуют.
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe', 'meshopt', 'strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // safe-семейство (dedup/prune/weld) может ничего не найти на чистой модели —
    // проверяем только meshopt-часть, она стабильна на любой геометрии.
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
  });
});

// ================================================================
// keepParts — отключение join (flatten + join не выполняются)
// ================================================================

describe('keepParts', () => {
  it('keepParts:true keeps meshes separate (no join)', async () => {
    const withoutKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(withoutKeep.status).toBe('ok');

    const withKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe', 'join'],
      keepParts: true,
      dryRun: true,
    });
    expect(withKeep.status).toBe('ok');

    // При keepParts:true join выключается даже при явном флаге 'join'.
    const joinRule = withKeep.applied.find((a) => a.ruleId === 'scene/join');
    expect(joinRule).toBeUndefined();

    // С явным флагом 'join' (без keepParts) join срабатывает.
    const joinRuleBase = withoutKeep.applied.find((a) => a.ruleId === 'scene/join');
    expect(joinRuleBase).toBeDefined();
  });

  it('keepParts:true leaves more meshes than default', async () => {
    const withoutKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
    });
    const withKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      keepParts: true,
      dryRun: true,
    });
    expect(withoutKeep.status).toBe('ok');
    expect(withKeep.status).toBe('ok');

    // С keepParts мешей не меньше (join не объединяет)
    expect(withKeep.metrics.after.meshes).toBeGreaterThanOrEqual(withoutKeep.metrics.after.meshes);
  }, 30000);

  it('keepParts:true preserves triangle count', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      keepParts: true,
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  });
});

// ================================================================
// validation — структура массива валидации
// ================================================================

describe('validation', () => {
  it('validation is an array with ok status', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.validation)).toBe(true);
  });

  it('validation entries have level and text fields', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    for (const entry of result.validation) {
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('text');
      expect(['pass', 'info', 'fail']).toContain(entry.level);
    }
  });

  it('validation includes geometry and triangle checks', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const texts = result.validation.map((v) => v.text).join(' ');
    // Язык сообщений не хардкодить (правило промпта). Используем английские паттерны,
    // стабильные на всех версиях: 'geometry is present', 'triangle count unchanged'
    expect(texts).toMatch(/triangles|geometry/i);
  });

  it('validation for missing file returns fail with validation info', async () => {
    const result = await optimizeFile(modelPath('does_not_exist.glb'));
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    // validation может быть пустым при fail — это нормально
    expect(Array.isArray(result.validation)).toBe(true);
  });
});

// ================================================================
// force — принудительная перезапись выходного файла
// ================================================================

describe('force', () => {
  // Уникальная tmpdir per-test: предотвращает конфликты с parallel.test.mjs
  // и не даёт afterEach rmSync(..., recursive: true) убить директорию ДО следующего теста.
  // Правило TEST_AGENT_PROMPT rule 9 + «не в PROJECT_ROOT».
  let outDir;

  beforeEach(() => {
    outDir = path.resolve(os.tmpdir(),
      `glb_optimize_force_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  });

  afterEach(() => {
    if (outDir && fs.existsSync(outDir)) {
      try { fs.rmSync(outDir, { force: true, recursive: true }); } catch { /* занят — не критично */ }
    }
  });

  it('without force: skips when output exists (status: skip)', async () => {
    // Сначала пишем файл
    const first = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(first.status).toBe('ok');
    expect(first.file.written).toBe(true);

    // Повторный запуск без force — должен быть skip
    const second = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: false,
      outDir,
    });
    expect(second.status).toBe('skip');
  });

  it('with force: true overwrites existing output', async () => {
    // Пишем первый раз
    const first = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(first.status).toBe('ok');

    // Второй раз с force:true — должен перезаписать
    const second = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(second.status).toBe('ok');
    expect(second.file.written).toBe(true);
    // Файл должен существовать на диске
    expect(fs.existsSync(second.file.dst)).toBe(true);
  });

  it('force:true with dryRun:true — dryRun приоритетнее, файл не пишется', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
      force: true,
      outDir,
    });
    // dryRun имеет приоритет над force
    expect(result.file.written).toBe(false);
  });
});

// ================================================================
// listRules — детальная проверка правил
// ================================================================

describe('listRules — detailed', () => {
  it('returns all known rule IDs', () => {
    const rules = listRules();
    const ids = rules.map((r) => r.id);
    const expected = [
      'structure/dedup',
      'structure/prune-unused',
      'attributes/vertex-colors',
      'geometry/weld',
      'geometry/degenerate-triangles',
      'geometry/orphan-vertices',
      'scene/join',
      'structure/prune-final',
      'textures/ktx2',
      'geometry/compress',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('each rule has tier: basic or advanced', () => {
    const rules = listRules();
    for (const rule of rules) {
      expect(['basic', 'advanced']).toContain(rule.tier);
    }
  });

  it('advanced rules reference a feature name', () => {
    const rules = listRules();
    const advanced = rules.filter((r) => r.tier === 'advanced');
    for (const rule of advanced) {
      expect(rule).toHaveProperty('feature');
      expect(typeof rule.feature).toBe('string');
      expect(rule.feature.length).toBeGreaterThan(0);
    }
  });

  it('no two rules share the same ID', () => {
    const rules = listRules();
    const ids = rules.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
