// Integration tests for optimize2.mjs public API.
// Follows the test plan from tests/TEST_AGENT_PROMPT.md and reviews/tests/README.md.
//
// Ни один тест этого файла не пишет в рабочую `output/` пользователя: каждый вызов
// получает свою временную папку (tmpOutDir), и они сносятся в конце файла.

import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile, listRules, VERSION } from '../optimize2.mjs';
import fs from 'node:fs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

// ---- helpers ----

// modelPath импортирован из helpers/model-files.mjs. Не определять локальный
// shadow этого имени — кроме рисков затенения, он ещё и ломает гомогенность
// (один тест-файл должен иметь один источник истины для путей к fixtures).

const MODEL = modelPath('CarConcept.glb');
const MISSING = modelPath('does_not_exist.glb');

// Уборщиков здесь больше нет, и это принципиально. Раньше файл держал три штуки, и
// один из них — cleanDryRunReports() — на ЗАГРУЗКЕ МОДУЛЯ обходил настоящую `output/`
// пользователя и удалял оттуда каждый `*.dryrun.report.md`. Прогон набора стирал чужие
// файлы: проверено зондом 2026-08-15 — положенный в `output/` файл после
// `vitest run tests/optimize.test.mjs` исчезал.
//
// Своё убирать надо, чужое трогать нельзя. Теперь каждый вызов пишет в свою временную
// папку (tmpOutDir), а cleanupTmpOutDirs() в конце сносит их целиком — вместе с .glb и
// отчётами, поимённой уборки не требуется.

// ---- API ----

describe('API', () => {
  it('exports: optimizeFile, listRules, VERSION exist and have correct types', () => {
    expect(typeof optimizeFile).toBe('function');
    expect(typeof listRules).toBe('function');
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('listRules returns a non-empty array of rule objects with required fields', () => {
    const rules = listRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      expect(rule).toHaveProperty('id');
      expect(typeof rule.id).toBe('string');
      expect(rule).toHaveProperty('category');
      expect(typeof rule.category).toBe('string');
      expect(rule).toHaveProperty('severity');
      expect(rule).toHaveProperty('fixSafety');
      expect(rule).toHaveProperty('title');
    }
  });
});

// ---- optimizeFile ----

describeIfModels(['CarConcept.glb'], 'optimizeFile', () => {
  it('passthrough (no advancedFeatures) returns status ok with metrics', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
    expect(result.metrics.before.triangles).toBeGreaterThan(0);
  });

  it('safe optimizations return status ok and produce findings', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.applied)).toBe(true);
  });
});

// ---- meshopt ----

describeIfModels(['CarConcept.glb'], 'meshopt', () => {
  it('safe + meshopt preserves triangle count (core invariant)', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const b = result.metrics.before;
    const a = result.metrics.after;
    expect(a.triangles).toBe(b.triangles);
  });
});

// ---- join ----

describeIfModels(['CarConcept.glb'], 'join', () => {
  it('safe + join returns ok and does not increase meshes or draw calls', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const b = result.metrics.before;
    const a = result.metrics.after;
    // join should not increase meshes/draw-calls (model may already be minimal)
    expect(a.meshes).toBeLessThanOrEqual(b.meshes);
    expect(a.drawCalls).toBeLessThanOrEqual(b.drawCalls);
    // at least something was applied (safe cleanup)
    expect(result.applied.length).toBeGreaterThan(0);
  });
});

// ---- dryRun ----

describeIfModels(['CarConcept.glb'], 'dryRun', () => {
  it('dryRun=true does not write glb but produces a report file', async () => {
    const outDir = tmpOutDir();

    const result = await optimizeFile(MODEL, {
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
      outDir,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
    expect(result.file.reportPath).toBeTruthy();

    const reportExists = fs.existsSync(result.file.reportPath);
    expect(reportExists).toBe(true);
  });

  it('non-dryRun writes .glb file with written=true', async () => {
    const outDir = tmpOutDir();

    const result = await optimizeFile(MODEL, {
      advancedFeatures: ['safe'],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(true);
    expect(result.file.dst).toBeTruthy();

    const glbExists = fs.existsSync(result.file.dst);
    expect(glbExists).toBe(true);
    // Убирать поимённо нечего: папка временная, её сносит cleanupTmpOutDirs().
  });
});

// ---- errors ----

describeIfModels(['CarConcept.glb'], 'errors', () => {
  it('unknown advancedFeature returns status fail with descriptive message', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['nonexistent_feature'],
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Unknown advancedFeatures');
    expect(result.error).toContain('nonexistent_feature');
  });

  it('missing input file returns status fail gracefully (not a crash)', async () => {
    const result = await optimizeFile(MISSING, { outDir: tmpOutDir() });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    // Error message should explain the problem, not a generic crash
    expect(result.error.length).toBeGreaterThan(5);
  });
});

// ---- additional scenarios ----

describeIfModels(['CarConcept.glb'], 'additional scenarios', () => {
  it('full pipeline: safe + meshopt + join returns ok preserving triangles', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBeGreaterThan(0);
    // triangles never change (core invariant)
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    // join does not inflate meshes
    expect(result.metrics.after.meshes).toBeLessThanOrEqual(result.metrics.before.meshes);
    expect(result.metrics.after.drawCalls).toBeLessThanOrEqual(result.metrics.before.drawCalls);
  });

  it('strip-colors combined with safe returns ok', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.applied)).toBe(true);
  });

  it('metrics structure contains expected fields both before and after', async () => {
    const result = await optimizeFile(MODEL, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const { before, after } = result.metrics;
    const requiredFields = [
      'fileBytes', 'drawCalls', 'triangles', 'vertices',
      'textureBytes', 'gpuBytes', 'meshes', 'materials',
      'textures', 'nodes', 'scenes', 'animations', 'skins',
      'bounds',
    ];

    for (const field of requiredFields) {
      expect(before).toHaveProperty(field);
      expect(after).toHaveProperty(field);
    }

    // File size should be non-zero
    expect(before.fileBytes).toBeGreaterThan(0);
    expect(after.fileBytes).toBeGreaterThan(0);
  });
});

afterAll(cleanupTmpOutDirs);
