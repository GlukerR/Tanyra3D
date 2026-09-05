import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile, listRules } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


describeIfModels(['CarConcept.glb'], 'strip-colors', () => {
  it('advancedFeatures:["strip-colors"] returns status ok', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  });

  it('strip-colors preserves structure (works on models with and without COLOR_n)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('strip-colors preserves triangles (core invariant)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  });

  it('strip-colors works alongside safe + meshopt', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt', 'strip-colors'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
  });
});


describeIfModels(['CarConcept.glb'], 'keepParts', () => {
  it('keepParts:true keeps meshes separate (no join)', async () => {
    const withoutKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(withoutKeep.status).toBe('ok');

    const withKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      keepParts: true,
      dryRun: true,
    });
    expect(withKeep.status).toBe('ok');

    const joinRule = withKeep.applied.find((a) => a.ruleId === 'scene/join');
    expect(joinRule).toBeUndefined();

    const joinRuleBase = withoutKeep.applied.find((a) => a.ruleId === 'scene/join');
    expect(joinRuleBase).toBeDefined();
  });

  it('keepParts:true leaves more meshes than default', async () => {
    const withoutKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    const withKeep = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      keepParts: true,
      dryRun: true,
    });
    expect(withoutKeep.status).toBe('ok');
    expect(withKeep.status).toBe('ok');

    expect(withKeep.metrics.after.meshes).toBeGreaterThanOrEqual(withoutKeep.metrics.after.meshes);
  });

  it('keepParts:true preserves triangle count', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      keepParts: true,
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  });
});


describeIfModels(['CarConcept.glb'], 'validation', () => {
  it('validation is an array with ok status', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.validation)).toBe(true);
  });

  it('validation entries have level and text fields', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
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
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const texts = result.validation.map((v) => v.text).join(' ');
    expect(texts).toMatch(/triangles|geometry/i);
  });

  it('validation for missing file returns fail with validation info', async () => {
    const result = await optimizeFile(modelPath('does_not_exist.glb'), { outDir: tmpOutDir() });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(Array.isArray(result.validation)).toBe(true);
  });
});


describeIfModels(['CarConcept.glb'], 'force', () => {
  let outDir;

  beforeEach(() => {
    outDir = path.resolve(os.tmpdir(),
      `glb_optimize_force_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  });

  afterEach(() => {
    if (outDir && fs.existsSync(outDir)) {
      try { fs.rmSync(outDir, { force: true, recursive: true }); } catch {  }
    }
  });

  it('without force: skips when output exists (status: skip)', async () => {
    const first = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(first.status).toBe('ok');
    expect(first.file.written).toBe(true);

    const second = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: false,
      outDir,
    });
    expect(second.status).toBe('skip');
  });

  it('with force: true overwrites existing output', async () => {
    const first = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(first.status).toBe('ok');

    const second = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: false,
      force: true,
      outDir,
    });
    expect(second.status).toBe('ok');
    expect(second.file.written).toBe(true);
    expect(fs.existsSync(second.file.dst)).toBe(true);
  });

  it('force:true with dryRun:true — dryRun приоритетнее, файл не пишется', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
      force: true,
      outDir,
    });
    expect(result.file.written).toBe(false);
  });
});


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

  it('advanced rules reference a feature name or a feature group', () => {
    const rules = listRules();
    const advanced = rules.filter((r) => r.tier === 'advanced');
    for (const rule of advanced) {
      const gate = rule.feature || rule.featureGroup;
      expect(typeof gate, `${rule.id}: ни feature, ни featureGroup`).toBe('string');
      expect(gate.length, `${rule.id}: пустой выключатель`).toBeGreaterThan(0);
    }
  });

  it('featureGroup правила существует среди exclusiveGroups аддона', async () => {
    const { exclusiveGroups } = await import('../optimize2.mjs');
    const groups = new Set(exclusiveGroups().map((g) => g.id));
    for (const rule of listRules()) {
      if (!rule.featureGroup) continue;
      expect(groups, `${rule.id}: группы ${rule.featureGroup} у аддона нет`).toContain(rule.featureGroup);
    }
  });

  it('no two rules share the same ID', () => {
    const rules = listRules();
    const ids = rules.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});


describeIfModels(['Dirty Cube 01.glb'], 'skipped feature field', () => {
  it('cost entries in skipped have a non-empty feature field from a valid set', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const validFeatures = new Set(
      listRules()
        .filter((r) => typeof r.feature === 'string' && r.feature.length > 0)
        .map((r) => r.feature),
    );
    expect(validFeatures.size).toBeGreaterThan(0);

    const costEntries = result.skipped.filter((s) => s.kind === 'cost');
    expect(costEntries.length).toBeGreaterThan(0);

    for (const entry of costEntries) {
      expect(entry).toHaveProperty('feature');
      expect(typeof entry.feature).toBe('string');
      expect(entry.feature.length).toBeGreaterThan(0);
      expect(validFeatures.has(entry.feature)).toBe(true);
    }
  });
});

afterAll(cleanupTmpOutDirs);
