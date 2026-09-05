import { it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));



const THREE_LOCAL = ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb'];


describeIfModels(THREE_LOCAL, 'Parallel — 3 different models', () => {
  it('Promise.all with safe+meshopt+join — all return ok with applied rules', async () => {
    const models = ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb'];

    const results = await Promise.all(
      models.map((name) =>
        optimizeFile(modelPath(name), {
          outDir: tmpOutDir(),
          advancedFeatures: ['safe', 'meshopt', 'join'],
          dryRun: true,
        }),
      ),
    );

    for (let i = 0; i < models.length; i++) {
      expect(results[i].status).toBe('ok');
      expect(results[i].file.written).toBe(false);
      expect(results[i].metrics.before).not.toBeNull();
      expect(results[i].metrics.after).not.toBeNull();
      expect(results[i].applied.length).toBeGreaterThan(0);
    }
  });

  it('each model has distinct fileBytes before optimization', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    const carBytes = results[0].metrics.before.fileBytes;
    const toyBytes = results[1].metrics.before.fileBytes;
    const poufBytes = results[2].metrics.before.fileBytes;

    expect(carBytes).not.toBe(toyBytes);
    expect(carBytes).not.toBe(poufBytes);
    expect(toyBytes).not.toBe(poufBytes);

    expect(carBytes).toBeGreaterThan(toyBytes);
    expect(toyBytes).toBeGreaterThan(poufBytes);
  });

  it('each model has distinct triangle counts — not mixed up', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    const carTris = results[0].metrics.after.triangles;
    const toyTris = results[1].metrics.after.triangles;
    const poufTris = results[2].metrics.after.triangles;

    expect(carTris).not.toBe(toyTris);
    expect(carTris).not.toBe(poufTris);
    expect(toyTris).not.toBe(poufTris);

    expect(carTris).toBeGreaterThan(100000);
    expect(toyTris).toBeGreaterThan(10000);
    expect(toyTris).toBeLessThan(carTris);
    expect(poufTris).toBeLessThan(toyTris);
    expect(poufTris).toBeGreaterThan(100);
  });

  it('each model has its own applied rules (counts differ)', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { outDir: tmpOutDir(), advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
    ]);

    const carRules = results[0].applied.length;
    const toyRules = results[1].applied.length;
    const poufRules = results[2].applied.length;

    expect(carRules).toBeGreaterThan(toyRules);
    expect(carRules).toBeGreaterThan(poufRules);

    expect(results[0].applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    expect(results[0].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);

    for (const r of results) {
      expect(r.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    }
  });

  it('metrics.before and metrics.after are distinct objects per call', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    for (const r of results) {
      expect(r.metrics.before).not.toBe(r.metrics.after);

      const requiredFields = [
        'fileBytes', 'drawCalls', 'triangles',
        'textureBytes', 'gpuBytes', 'meshes', 'materials',
        'textures', 'nodes', 'scenes', 'animations', 'skins',
        'bounds',
      ];
      for (const field of requiredFields) {
        expect(r.metrics.before).toHaveProperty(field);
        expect(r.metrics.after).toHaveProperty(field);
      }
    }
  });

  it('core invariant holds for all 3 models in parallel', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    for (const r of results) {
      const delta = Math.abs(r.metrics.after.triangles - r.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
    }
  });
});


describeIfModels(THREE_LOCAL, 'Parallel — same model x3', () => {
  it('3 parallel calls to CarConcept return identical metrics', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    for (const r of results) expect(r.status).toBe('ok');

    const sizes = results.map((r) => r.metrics.after.fileBytes);
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[1]).toBe(sizes[2]);

    const tris = results.map((r) => r.metrics.after.triangles);
    expect(tris[0]).toBe(tris[1]);
    expect(tris[1]).toBe(tris[2]);

    const appliedCounts = results.map((r) => r.applied.length);
    expect(appliedCounts[0]).toBe(appliedCounts[1]);
    expect(appliedCounts[1]).toBe(appliedCounts[2]);

    const valCounts = results.map((r) => r.validation.length);
    expect(valCounts[0]).toBe(valCounts[1]);
    expect(valCounts[1]).toBe(valCounts[2]);
  });

  it('3 parallel calls to ToyCar return identical applied ruleIds', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
    ]);

    const ruleIdSets = results.map((r) => r.applied.map((a) => a.ruleId).sort());
    expect(ruleIdSets[0]).toEqual(ruleIdSets[1]);
    expect(ruleIdSets[1]).toEqual(ruleIdSets[2]);
  });
});


describeIfModels(['CarConcept.glb'], 'Parallel — different features', () => {
  it('meshopt, draco, and strip-colors in parallel — all ok', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: ['meshopt'], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: ['draco'], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: ['strip-colors'], dryRun: true }),
    ]);

    for (const r of results) expect(r.status).toBe('ok');

    const sizes = results.map((r) => r.metrics.after.fileBytes);
    expect(sizes[1]).not.toBe(sizes[0]);

    expect(results[0].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    expect(results[1].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    expect(results[2].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(false);
  });

  it('default and ktx2 in parallel — ktx2 may fail gracefully, default always ok', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { outDir: tmpOutDir(), advancedFeatures: ['ktx2'], dryRun: true }),
    ]);

    expect(results[0].status).toBe('ok');

    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBeOneOf(['ok', 'fail']);

    for (const r of results) {
      const delta = Math.abs(r.metrics.after.triangles - r.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
    }
  });
});


describeIfModels(THREE_LOCAL, 'Parallel — dryRun:false (write to tmpdir)', () => {
  let OUT_DIR;

  beforeEach(() => {
    OUT_DIR = path.resolve(os.tmpdir(),
      `glb_optimize_parallel_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  });

  afterEach(() => {
    if (OUT_DIR && fs.existsSync(OUT_DIR)) {
      try { fs.rmSync(OUT_DIR, { force: true, recursive: true }); } catch {  }
    }
  });

  it('3 models write to tmpdir in parallel without file conflicts', async () => {
    const models = ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb'];

    const results = await Promise.all(
      models.map((name) =>
        optimizeFile(modelPath(name), {
          advancedFeatures: [],
          dryRun: false,
          force: true,
          outDir: OUT_DIR,
        }),
      ),
    );

    for (let i = 0; i < models.length; i++) {
      expect(results[i].status).toBe('ok');
      expect(results[i].file.written).toBe(true);
      expect(results[i].file.dst).toContain('glb_optimize_parallel');
    }

    for (const name of ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb']) {
      const dst = path.join(OUT_DIR, name);
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.statSync(dst).size).toBeGreaterThan(0);
    }

    for (const name of ['CarConcept.report.md', 'ToyCar.report.md', 'SpecularSilkPouf.report.md']) {
      const reportPath = path.join(OUT_DIR, name);
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(fs.statSync(reportPath).size).toBeGreaterThan(0);
    }
  });

  it('same model written twice in parallel — force:true avoids skip conflict', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: false, force: true, outDir: OUT_DIR }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: false, force: true, outDir: OUT_DIR }),
    ]);

    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('ok');
    expect(results[0].file.written).toBe(true);
    expect(results[1].file.written).toBe(true);
  });
});

afterAll(cleanupTmpOutDirs);
