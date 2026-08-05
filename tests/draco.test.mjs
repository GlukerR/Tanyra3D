// Draco compression tests — проверка advancedFeatures:['draco'].
//
// Draco — альтернатива Meshopt для сжатия геометрии. Включается через
// advancedFeatures:['draco'] или флаг --draco.
//
// Проверяет:
// 1. draco возвращает status:'ok'
// 2. Core invariant: треугольники не меняются
// 3. applied содержит упоминание draco
// 4. draco на всём золотом корпусе (кроме known-failing)
// 5. draco на input-папке (выборочно, первые 10 моделей)

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { modelPath, describeIfModels, eachModel } from './helpers/model-files.mjs';
import { INPUT_DIR, inputModels as readInputModels, describeInput } from './helpers/input-folder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---- Draco: базовая проверка на CarConcept.glb ----

describeIfModels(['CarConcept.glb'], 'Draco — basic', () => {
  it('advancedFeatures:["draco"] returns status ok on CarConcept.glb', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  });

  it('applied rules contain draco reference', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // Ищем правило geometry/compress с упоминанием draco
    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);
  });

  it('triangles preserved with draco (core invariant)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  });

  it('metrics have all required fields with draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['draco'],
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
  });
});

// ---- Draco: сравнение с meshopt (дефолтный кодек) ----

describeIfModels(['CarConcept.glb'], 'Draco — vs meshopt', () => {
  it('draco produces different file size than meshopt', async () => {
    // Запускаем с meshopt (дефолт)
    const meshoptResult = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(meshoptResult.status).toBe('ok');

    // Запускаем с draco
    const dracoResult = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(dracoResult.status).toBe('ok');

    // Размер файла после сжатия должен отличаться (Draco vs Meshopt — разные кодеки)
    // Не утверждаем какой больше/меньше, только что они разные
    expect(dracoResult.metrics.after.fileBytes).not.toBe(meshoptResult.metrics.after.fileBytes);
  });

  it('both draco and meshopt preserve triangles', async () => {
    const [draco, meshopt] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['draco'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: [],
        dryRun: true,
      }),
    ]);

    expect(draco.status).toBe('ok');
    expect(meshopt.status).toBe('ok');

    // Triangle delta одинаково мало для обоих кодеров
    const dracoDelta = Math.abs(draco.metrics.after.triangles - draco.metrics.before.triangles);
    const meshoptDelta = Math.abs(meshopt.metrics.after.triangles - meshopt.metrics.before.triangles);
    expect(dracoDelta).toBeLessThanOrEqual(10);
    expect(meshoptDelta).toBeLessThanOrEqual(10);
  });
});

// ---- Draco: на всём золотом корпусе ----

describe('Draco — golden corpus', () => {
  const GOLDEN = [
    'ABeautifulGame.glb', 'AnisotropyBarnLamp.glb', 'CarConcept.glb',
    'ChronographWatch.glb', 'CommercialRefrigerator.glb',
    'DiffuseTransmissionPlant.glb', 'DiffuseTransmissionTeacup.glb',
    'IridescenceLamp.glb', 'IridescentDishWithOlives.glb',
    'MosquitoInAmber.glb', 'SheenWoodLeatherSofa.glb',
    'SpecularSilkPouf.glb', 'SunglassesKhronos.glb', 'ToyCar.glb',
    // AnimationPointerUVs и PotOfCoalsAnimationPointer — known failing (KHR_animation_pointer)
  ];

  // eachModel: пропуск LOCALS, которых нет на диске.
  eachModel('draco returns ok, triangles preserved', GOLDEN, async (name) => {
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);
  });
});

// ---- Draco: выборочно на input-папке ----

describeInput('Draco — input folder (first 10 models)', () => {
  const inputModels = readInputModels({ limit: 10, ext: ['.glb'] });

  // Known-failing для Draco: некоторые модели не поддерживают Draco-кодирование
  // (обычно из-за особенностей геометрии: non-triangle примитивы, нестандартные
  // accessor types, mesh с без-индексной геометрией)
  const DRACO_FAILING = new Set([
    '1 (2).glb',
    '1_Flowers_GLB.glb',
    '2 (2).glb',
    '2 (3).glb',
  ]);
  const KNOWN_FAILING = new Set(['decepticon_fighter.glb', 'uttvm_core_guard.glb']);
  const models = inputModels.filter((m) => !KNOWN_FAILING.has(m));

  it.each(models)('%s — draco returns ok or known fail', async (name) => {
    const result = await optimizeFile(path.join(INPUT_DIR, name), {
      advancedFeatures: ['draco'],
      dryRun: true,
    });

    if (DRACO_FAILING.has(name)) {
      // Draco-несовместимая модель — логируем и проверяем, что хотя бы не крэш
      expect(result.status).toBe('fail');
      console.log(`  ℹ️ ${name}: Draco не поддерживается для этой модели (статус: ${result.status})`);
      return;
    }

    expect(result.status).toBe('ok');

    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);
  });

  it(`${models.length} models tested from input/ (${DRACO_FAILING.size} Draco-incompatible)`, () => {
    expect(models.length).toBeGreaterThan(0);
  });
});
