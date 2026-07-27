// Golden Corpus tests — прогон всех 16 референсных моделей из fixtures/models/
// через разные комбинации оптимизаций. Все тесты используют dryRun: true,
// чтобы не оставлять .glb файлы на диске.
//
// ВАЖНО: базовый пайплайн (dedup, prune, weld, join, meshopt) запускается
// автоматически БЕЗ advancedFeatures. Поле advancedFeatures только для
// опциональных расширений: 'ktx2', 'draco', 'strip-colors'.
//
// Золотой корпус (16 моделей):
//   ABeautifulGame, AnimationPointerUVs, AnisotropyBarnLamp, CarConcept,
//   ChronographWatch, CommercialRefrigerator, DiffuseTransmissionPlant,
//   DiffuseTransmissionTeacup, IridescenceLamp, IridescentDishWithOlives,
//   MosquitoInAmber, PotOfCoalsAnimationPointer, SheenWoodLeatherSofa,
//   SpecularSilkPouf, SunglassesKhronos, ToyCar

import { describe, it, expect } from 'vitest';
import { optimizeFile, listRules, VERSION } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

// Все 16 моделей золотого корпуса
const GOLDEN_MODELS = [
  'ABeautifulGame.glb',
  'AnimationPointerUVs.glb',
  'AnisotropyBarnLamp.glb',
  'CarConcept.glb',
  'ChronographWatch.glb',
  'CommercialRefrigerator.glb',
  'DiffuseTransmissionPlant.glb',
  'DiffuseTransmissionTeacup.glb',
  'IridescenceLamp.glb',
  'IridescentDishWithOlives.glb',
  'MosquitoInAmber.glb',
  'PotOfCoalsAnimationPointer.glb',
  'SheenWoodLeatherSofa.glb',
  'SpecularSilkPouf.glb',
  'SunglassesKhronos.glb',
  'ToyCar.glb',
];

// Модели с известными проблемами (KHR_animation_pointer)
const KNOWN_FAILING = new Set([
  'AnimationPointerUVs.glb',
  'PotOfCoalsAnimationPointer.glb',
]);

// Проверка: все sidecar-файлы лицензий существуют
describe('Golden Corpus — license sidecars', () => {
  it.each(GOLDEN_MODELS)('%s has a license.md sidecar', (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    expect(fs.existsSync(licensePath)).toBe(true);
  });

  it.each(GOLDEN_MODELS)('%s license.md has required fields', (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    const content = fs.readFileSync(licensePath, 'utf-8');
    // Поля могут быть на русском или английском
    expect(content).toMatch(/copyright|author|Copyright|Author|Автор/i);
    expect(content).toMatch(/license|License|Лицензия/i);
    expect(content).toMatch(/source|Source|Источник/i);
  });
});

// API — быстрая проверка один раз
describe('Golden Corpus — API smoke test', () => {
  it('listRules returns non-empty array', () => {
    const rules = listRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: PASSTHROUGH (базовый пайплайн) ----------
describe('Golden Corpus — passthrough (default pipeline)', () => {
  const TIMEOUT = 30000; // ABeautifulGame — большая модель

  it.each(GOLDEN_MODELS)('%s — passthrough returns status ok or known fail', async (modelName) => {
    const result = await optimizeFile(modelPath(modelName), {
      advancedFeatures: [],
      dryRun: true,
    });

    if (KNOWN_FAILING.has(modelName)) {
      // KHR_animation_pointer — известная проблема: расширение не поддерживается
      // Примечание: result.error может быть undefined — баг в обработке ошибок
      expect(result.status).toBe('fail');
      return;
    }

    expect(result.status).toBe('ok');
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
    expect(result.metrics.after.fileBytes).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: БАЗОВЫЙ ПАЙПЛАЙН С НАХОДКАМИ ----------
describe('Golden Corpus — basic pipeline produces findings', () => {
  const TIMEOUT = 15000;

  it.each(GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)))(
    '%s — has findings or applied rules after basic pipeline',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.file.written).toBe(false);
      // У healthy модели всегда есть applied правила (хотя бы prune)
      expect(result.applied.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: core invariant (triangles preserved) ----------
describe('Golden Corpus — core invariant: triangles ± small delta', () => {
  const TIMEOUT = 30000; // ABeautifulGame — большая модель

  it.each(GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)))(
    '%s — triangles delta ≤ 10 (degenerate removal is normal)',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Core invariant: weld + degenerate удаляют треугольники нулевой площади.
      // Это нормально — они не влияют на рендер. Допускаем дельту до 10.
      const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
      // drawCalls МОГУТ уменьшиться после join — это ожидаемо, не проверяем
    },
    TIMEOUT,
  );
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: join не увеличивает meshes/drawCalls ----------
describe('Golden Corpus — join invariant', () => {
  const TIMEOUT = 15000;

  it.each(GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)))(
    '%s — meshes ≤ before after join (flatten+join runs by default)',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // join (flatten+join) выполняется по умолчанию в базовом пайплайне
      expect(result.metrics.after.meshes).toBeLessThanOrEqual(result.metrics.before.meshes);
      expect(result.metrics.after.drawCalls).toBeLessThanOrEqual(result.metrics.before.drawCalls);
      expect(result.applied.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

// ---------- МЕТРИКИ ----------
describe('Golden Corpus — metrics structure', () => {
  const TIMEOUT = 15000;

  it.each(GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)))(
    '%s — metrics have all required fields',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');

      // 'vertices' НЕ входит в метрики — см. collectMetrics() в optimize2.mjs
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
    },
    TIMEOUT,
  );
});
