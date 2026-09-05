import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { optimizeFile, listRules, VERSION } from '../../optimize2.mjs';
import * as assistant from '../../assistant.mjs';
import { modelPath } from '../helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = modelPath('Dirty Cube 01.glb');

let OUT_DIR;
beforeAll(() => {
  OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'public-api-'));
});
afterAll(() => {
  try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch {  }
});

async function runResult() {
  return optimizeFile(MODEL, {
    advancedFeatures: ['safe'],
    dryRun: true,
    force: true,
    outDir: OUT_DIR,
  });
}

const RESULT_KEYS = ['status', 'file', 'findings', 'skipped', 'applied', 'validation', 'metrics'];
const FILE_KEYS = ['src', 'dst', 'written', 'reportPath'];
const FINDING_KEYS = ['ruleId', 'category', 'severity', 'fixSafety', 'text'];
const SKIPPED_KEYS = ['ruleId', 'text', 'reason'];
const APPLIED_KEYS = ['ruleId', 'fixSafety', 'reversible', 'dataLoss', 'text'];
const VALIDATION_KEYS = ['level', 'text'];

const has = (obj, keys) => keys.filter((k) => !(k in obj));

describe('public-api — контрактный снимок RunResult (optimizeFile)', () => {
  it('результат реального прогона содержит обязательные поля контракта', async () => {
    const r = await runResult();
    expect(has(r, RESULT_KEYS)).toEqual([]);
    expect(has(r.file, FILE_KEYS)).toEqual([]);
    for (const k of ['findings', 'skipped', 'applied', 'validation']) {
      expect(Array.isArray(r[k]), `${k} должен быть массивом`).toBe(true);
    }
    expect(r.metrics).toHaveProperty('before');
    expect(r.metrics).toHaveProperty('after');
  });

  it('записи findings/skipped/applied/validation имеют обязательные поля', async () => {
    const r = await runResult();
    expect(r.applied.length + r.findings.length).toBeGreaterThan(0);
    for (const rec of r.applied) expect(has(rec, APPLIED_KEYS)).toEqual([]);
    for (const rec of r.findings) expect(has(rec, FINDING_KEYS)).toEqual([]);
    for (const rec of r.validation) expect(has(rec, VALIDATION_KEYS)).toEqual([]);
    for (const rec of r.skipped) expect(has(rec, SKIPPED_KEYS)).toEqual([]);
  });

  it('контракт статусов: ok | skip | fail (не строки-фантазии)', async () => {
    const r = await runResult();
    expect(['ok', 'skip', 'fail']).toContain(r.status);
  });

  it('метрики содержат обязательные поля до и после', async () => {
    const r = await runResult();
    const metricKeys = [
      'fileBytes', 'gpuBytes', 'textureBytes', 'drawCalls', 'triangles',
      'vertices', 'meshes', 'materials', 'textures', 'nodes',
      'scenes', 'animations', 'skins', 'bounds',
    ];
    expect(has(r.metrics.before, metricKeys)).toEqual([]);
    expect(has(r.metrics.after, metricKeys)).toEqual([]);
  });
});

describe('public-api — контрактный снимок listRules', () => {
  it('VERSION — строка (семвер проекта)', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('каждое правило несёт полный набор meta-полей контракта', () => {
    const rules = listRules();
    expect(rules.length).toBeGreaterThan(0);
    const ids = new Set();
    for (const rule of rules) {
      expect(typeof rule.id, `rule.id не строка: ${JSON.stringify(rule)}`).toBe('string');
      expect(typeof rule.category).toBe('string');
      expect(['info', 'warn', 'error']).toContain(rule.severity);
      expect(['provable', 'numeric', 'perceptual', 'lossy']).toContain(rule.fixSafety);
      expect(['basic', 'advanced']).toContain(rule.tier);
      expect(typeof rule.title).toBe('string');
      expect(typeof rule.reversible).toBe('boolean');
      expect(['none', 'minor', 'significant']).toContain(rule.dataLoss);
      expect(Array.isArray(rule.runAfter)).toBe(true);
      expect(Array.isArray(rule.touches)).toBe(true);
      ids.add(rule.id);
    }
    expect(ids.size).toBe(rules.length);
  });
});

describe('public-api — контрактный снимок assistant-экспортов (§4c)', () => {
  it('listPlatforms возвращает массив {id, title, description}', () => {
    const platforms = assistant.listPlatforms();
    expect(Array.isArray(platforms)).toBe(true);
    for (const p of platforms) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.description).toBe('string');
    }
  });

  it('planFor возвращает {profileId, title, engineOpts, explanation, availableExtensions}', () => {
    const platforms = assistant.listPlatforms();
    expect(platforms.length).toBeGreaterThan(0);
    const plan = assistant.planFor(platforms[0].id);
    expect(typeof plan.profileId).toBe('string');
    expect(typeof plan.title).toBe('string');
    expect(plan.engineOpts).toBeTruthy();
    expect(Array.isArray(plan.explanation)).toBe(true);
    expect(Array.isArray(plan.availableExtensions)).toBe(true);
  });

  it('listExtensions — алиас getAvailableExtensions (имя, которое ждёт server.mjs)', () => {
    expect(assistant.listExtensions).toBe(assistant.getAvailableExtensions);
    const platforms = assistant.listPlatforms();
    const exts = assistant.getAvailableExtensions(platforms[0].id);
    expect(Array.isArray(exts)).toBe(true);
  });

  it('explainResult возвращает {summary, highlights, budgetChecks, warnings}', () => {
    const platforms = assistant.listPlatforms();
    const fake = {
      status: 'ok',
      metrics: {
        before: { fileBytes: 100, gpuBytes: 100, drawCalls: 1, triangles: 1 },
        after: { fileBytes: 50, gpuBytes: 50, drawCalls: 1, triangles: 1 },
      },
      findings: [], skipped: [], applied: [], validation: [],
    };
    const out = assistant.explainResult(fake, platforms[0].id);
    expect(typeof out.summary).toBe('string');
    expect(Array.isArray(out.highlights)).toBe(true);
    expect(Array.isArray(out.budgetChecks)).toBe(true);
    expect(Array.isArray(out.warnings)).toBe(true);
  });
});
