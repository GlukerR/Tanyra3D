import { it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';

import { INPUT_DIR, inputExists, inputModels as readInputModels, describeInput } from './helpers/input-folder.mjs';

const inputModels = readInputModels();
const inputModelCount = inputModels.length;

const KNOWN_FAILING = new Set([]);

describeInput('Input folder — basic checks', () => {
  it('input/ directory exists', () => {
    expect(inputExists).toBe(true);
  });

  it('input/ has at least one .glb/.gltf model', () => {
    expect(inputModelCount).toBeGreaterThan(0);
  });
});

describeInput('Input folder — batch passthrough (default pipeline)', () => {
  it.each(inputModels)(`passthrough: %s`, async (modelName) => {
    const modelFullPath = path.join(INPUT_DIR, modelName);
    expect(fs.existsSync(modelFullPath)).toBe(true);

    const result = await optimizeFile(modelFullPath, {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });

    if (KNOWN_FAILING.has(modelName)) {
      expect(result.status).toBe('fail');
      return;
    }

    expect(['ok', 'skip']).toContain(result.status);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
  });
});

describeInput('Input folder — safe cleanup (core invariant)', () => {
  it.each(inputModels.filter((m) => !KNOWN_FAILING.has(m)))(
    `safe cleanup: %s`,
    async (modelName) => {
      const modelFullPath = path.join(INPUT_DIR, modelName);
      const result = await optimizeFile(modelFullPath, {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });

      if (result.status === 'ok') {
        expect(result.metrics.after.triangles, 'треугольников стало больше — этого быть не может')
          .toBeLessThanOrEqual(result.metrics.before.triangles);
        const explained = result.validation.some((v) => v.i18n?.text?.messageId === 'check.trianglesDropped'
          || v.i18n?.text?.messageId === 'check.trianglesUnchanged');
        expect(explained, 'убыль треугольников ничем не объяснена').toBe(true);
        expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
      } else if (result.status === 'skip') {
        expect(result.file.written).toBe(false);
      } else {
        console.warn(`  ⚠️  UNEXPECTED FAIL: ${modelName} — ${result.error?.slice(0, 100)}`);
        expect(result.status).toMatch(/ok|skip/);
      }
    },
  );
});

describeInput('Input folder — edge case filenames', () => {
  const edgeNames = inputModels.filter((n) =>
    /[\s()[\]{}&+=%#@!,;]/.test(n) ||
    /[а-яА-ЯёЁ]/.test(n),
  );
  const edgeKnownFailing = edgeNames.filter((n) => KNOWN_FAILING.has(n));

  it.each(edgeNames)(`edge filename: %s`, async (modelName) => {
    const modelFullPath = path.join(INPUT_DIR, modelName);
    const result = await optimizeFile(modelFullPath, {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });

    if (KNOWN_FAILING.has(modelName)) {
      expect(result.status).toBe('fail');
      return;
    }

    expect(['ok', 'skip']).toContain(result.status);
  });

  it(`edge filename count: ${edgeNames.length} models with special chars, ${edgeKnownFailing.length} known failing`, () => {
    expect(edgeNames.length).toBeGreaterThan(0);
  });
});

describeInput('Input folder — file size statistics', () => {
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

afterAll(cleanupTmpOutDirs);
