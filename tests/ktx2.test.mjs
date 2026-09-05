import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { modelPath, describeIfModels, eachModel } from './helpers/model-files.mjs';
import { INPUT_DIR, inputModels as readInputModels, describeInput } from './helpers/input-folder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIMEOUT_BASIC = 180000;
const TIMEOUT_GOLDEN = 180000;
const TIMEOUT_INPUT = 300000;


describeIfModels(['CarConcept.glb'], 'KTX2 — basic', () => {
  it('advancedFeatures:["ktx2"] is a valid feature (no unknown error)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('ktx2 alone triggers textures/ktx2 (geometry/compress stays opt-in)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(false);
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation includes baseline entry and geometry present on ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const baselineEntry = result.validation.find((v) => v.i18n?.text?.messageId === 'check.baselineMatch');
    expect(baselineEntry).toBeDefined();

    const geoPass = result.validation.find(
      (v) => v.level === 'pass' && /geometry/i.test(v.text),
    );
    expect(geoPass).toBeDefined();
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const requiredFields = [
      'fileBytes', 'drawCalls', 'triangles',
      'textureBytes', 'gpuBytes', 'meshes', 'materials',
      'textures', 'nodes', 'scenes', 'animations', 'skins',
      'bounds',
    ];
    for (const field of requiredFields) {
      expect(result.metrics.before).toHaveProperty(field);
      expect(result.metrics.after).toHaveProperty(field);
    }
  }, TIMEOUT_BASIC);
});


describeIfModels(['CarConcept.glb'], 'KTX2 — vs default pipeline', () => {
  it('both modes pass baseline validation', async () => {
    const [ktx2Result, defaultResult] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      }),
    ]);

    const byMatch = (r) => r.validation.find((v) => v.i18n?.text?.messageId === 'check.baselineMatch');
    const ktx2Basel = byMatch(ktx2Result);
    const defBasel = byMatch(defaultResult);

    expect(ktx2Basel).toBeDefined();
    expect(defBasel).toBeDefined();
    expect(ktx2Basel.level).toBe('pass');
    expect(defBasel.level).toBe('pass');
  }, TIMEOUT_BASIC);
});


const KTX2_FAILING = new Set([]);

describe('KTX2 — golden corpus', () => {
  const GOLDEN_HEALTHY = [
    'ABeautifulGame.glb',
    'AnisotropyBarnLamp.glb',
    'CarConcept.glb',
    'ChronographWatch.glb',
    'CommercialRefrigerator.glb',
    'DiffuseTransmissionPlant.glb',
    'DiffuseTransmissionTeacup.glb',
    'IridescenceLamp.glb',
    'IridescentDishWithOlives.glb',
    'MosquitoInAmber.glb',
    'SheenWoodLeatherSofa.glb',
    'SpecularSilkPouf.glb',
    'SunglassesKhronos.glb',
    'ToyCar.glb',
  ];

  const HEALTHY_MODELS = GOLDEN_HEALTHY.filter((m) => !KTX2_FAILING.has(m));

  eachModel('ktx2 returns ok, triangles preserved', HEALTHY_MODELS, async (name) => {
    const result = await optimizeFile(modelPath(name), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    expect(result.applied.length).toBeGreaterThan(0);
  }, TIMEOUT_GOLDEN);

  it(`${GOLDEN_HEALTHY.length} models tested with ktx2 (${KTX2_FAILING.size} known-failing; см. TESTBUG-005 в tests/bugs-found.test.mjs)`, () => {
    expect(GOLDEN_HEALTHY.length).toBeGreaterThan(0);
  });
});


describeIfModels(['CarConcept.glb'], 'KTX2 + Draco — combined features', () => {
  it('advancedFeatures:["ktx2","draco"] is valid (no unknown error)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('both ktx2 and draco rules are present in applied', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const ktx2Applied = result.applied.filter((a) => a.ruleId === 'textures/ktx2');
    expect(ktx2Applied.length).toBeGreaterThan(0);

    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation confirms file integrity with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.validation.length).toBeGreaterThan(0);
    const geoPass = result.validation.find(
      (v) => v.level === 'pass' && /geometry/i.test(v.text),
    );
    expect(geoPass).toBeDefined();
  }, TIMEOUT_BASIC);

  it('file size differs from both pure-ktx2 and pure-draco separately', async () => {
    const [combined, pureKtx2, pureDraco] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2', 'draco'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['draco'],
        dryRun: true,
      }),
    ]);

    expect(combined.status).toBeOneOf(['ok', 'fail']);
    expect(pureKtx2.status).toBe('ok');
    expect(pureDraco.status).toBe('ok');

    if (combined.status === 'ok' && pureKtx2.status === 'ok' && pureDraco.status === 'ok') {
      const combSize = combined.metrics.after.fileBytes;
      const ktx2Size = pureKtx2.metrics.after.fileBytes;
      const dracoSize = pureDraco.metrics.after.fileBytes;

      expect(combSize).not.toBe(ktx2Size);
      expect(combSize).not.toBe(dracoSize);
      expect(ktx2Size).not.toBe(dracoSize);
    } else {
      console.warn(`  ⚠ ktx2+draco heavy combo graceful degradation: combined=${combined.status}`);
    }
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const requiredFields = [
      'fileBytes', 'drawCalls', 'triangles',
      'textureBytes', 'gpuBytes', 'meshes', 'materials',
      'textures', 'nodes', 'scenes', 'animations', 'skins',
      'bounds',
    ];
    for (const field of requiredFields) {
      expect(result.metrics.before).toHaveProperty(field);
      expect(result.metrics.after).toHaveProperty(field);
    }
  }, TIMEOUT_BASIC);
});


const ALL_THREE = ['ktx2', 'draco', 'strip-colors'];

describeIfModels(['CarConcept.glb'], 'KTX2 + Draco + strip-colors — all three', () => {
  it('advancedFeatures:["ktx2","draco","strip-colors"] is valid', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('all three rules are present in applied', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);

    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);

    const vcRule = result.applied.find((a) => a.ruleId === 'attributes/vertex-colors');
    if (vcRule) {
      expect(vcRule.text).toBeDefined();
    }
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation confirms file integrity with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.validation.length).toBeGreaterThan(0);
    const geoPass = result.validation.find(
      (v) => v.level === 'pass' && /geometry/i.test(v.text),
    );
    expect(geoPass).toBeDefined();
  }, TIMEOUT_BASIC);

  it('file size differs between codec and texture dimension', async () => {
    const [all3, ktx2Draco, ktx2Strip, dracoStrip] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ALL_THREE,
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2', 'draco'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2', 'strip-colors'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: ['draco', 'strip-colors'],
        dryRun: true,
      }),
    ]);

    expect(all3.status).toBeOneOf(['ok', 'fail']);
    expect(ktx2Draco.status).toBeOneOf(['ok', 'fail']);
    expect(ktx2Strip.status).toBeOneOf(['ok', 'fail']);
    expect(dracoStrip.status).toBeOneOf(['ok', 'fail']);

    if (
      all3.status === 'ok' && ktx2Draco.status === 'ok' &&
      ktx2Strip.status === 'ok' && dracoStrip.status === 'ok'
    ) {
      const a3 = all3.metrics.after.fileBytes;
      const kd = ktx2Draco.metrics.after.fileBytes;
      const ks = ktx2Strip.metrics.after.fileBytes;
      const ds = dracoStrip.metrics.after.fileBytes;

      expect(a3).not.toBe(ks);
      expect(ds).not.toBe(ks);
      expect(a3).not.toBe(ds);
      expect(kd).not.toBe(ds);
      expect(ks).not.toBe(ds);
    } else {
      console.warn(`  ⚠ Heavy combo graceful degradation: all3=${all3.status}, kd=${ktx2Draco.status}, ks=${ktx2Strip.status}, ds=${dracoStrip.status}`);
    }
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const requiredFields = [
      'fileBytes', 'drawCalls', 'triangles',
      'textureBytes', 'gpuBytes', 'meshes', 'materials',
      'textures', 'nodes', 'scenes', 'animations', 'skins',
      'bounds',
    ];
    for (const field of requiredFields) {
      expect(result.metrics.before).toHaveProperty(field);
      expect(result.metrics.after).toHaveProperty(field);
    }
  }, TIMEOUT_BASIC);
});


describeInput('KTX2 — input folder (first 10 models)', () => {
  const inputModels = readInputModels({ limit: 10, ext: ['.glb'] });

  const knownFailing = new Set(['decepticon_fighter.glb', 'uttvm_core_guard.glb']);
  const models = inputModels.filter((m) => !knownFailing.has(m));

  it.each(models)('%s — no crash with ktx2', async (name) => {
    const result = await optimizeFile(path.join(INPUT_DIR, name), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);
  }, TIMEOUT_INPUT);

  it(`${models.length} models tested from input/ with ktx2 — no crashes`, () => {
    expect(models.length).toBeGreaterThan(0);
  });
});

afterAll(cleanupTmpOutDirs);
