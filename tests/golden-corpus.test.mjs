// Golden Corpus tests — прогон всех 16 референсных моделей из fixtures/models/
// через разные комбинации оптимизаций. Все тесты используют dryRun: true,
// чтобы не оставлять .glb файлы на диске.
//
// ВАЖНО: модель opt-in. Пустой advancedFeatures — это passthrough: файл
// перезаписывается без изменений, applied пуст. Любая оптимизация включается
// своим флагом; актуальный список — ADVANCED_FEATURES в addons/gltf/index.mjs.
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

// Модели с известными проблемами. Пусто: KHR_animation_pointer больше не валит
// пайплайн (проверено 2026-07-27 на слитом main) — валидатор пишет предупреждение
// «Missing optional extension» в stderr, статус остаётся ok.
const KNOWN_FAILING = new Set([]);

// Модели, которые ломаются на safe-cleanup (но проходят passthrough):
// KHR_animation_pointer — задокументировано в TESTBUG-006 (bugs-found.test.mjs).
const KNOWN_FAILING_UNDER_SAFE = new Set([
  'AnimationPointerUVs.glb',
  'PotOfCoalsAnimationPointer.glb',
]);

// Helper-фильтр для describe с safe / safe+join: исключает KHR_animation_pointer и known-failing.
// Используется во всех 3 safe-using describe вместо повторного .filter(...).
const isSafeEligible = (m) => !KNOWN_FAILING.has(m) && !KNOWN_FAILING_UNDER_SAFE.has(m);

// Whitelist ruleIds из семейства safe — НЕЛЬЗЯ хардкодить (TEST_AGENT_PROMPT rule 11:
// «Сверять с кодом, а не с этим файлом»). Source of truth — listRules(), который читает
// актуальный registry из addons/gltf/index.mjs. Если кто-то переименует ruleId или
// добавит новый в safe-семейство, этот whitelist обновится автоматически.
const SAFE_RULE_IDS = new Set(
  listRules()
    .filter((r) => r.tier === 'basic' || r.feature === 'safe')
    .map((r) => r.id),
);

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

    expect(result.status).toBe('ok');
    // passthrough ничего не применяет — это и есть контракт opt-in
    expect(result.applied.length).toBe(0);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
    expect(result.metrics.after.fileBytes).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: safe-cleanup не ломает структуру ----------
describe('Golden Corpus — safe cleanup preserves structure', () => {
  const TIMEOUT = 60000; // ABeautifulGame — большая модель (~145 MB)

  it.each(GOLDEN_MODELS.filter(isSafeEligible))(
    '%s — safe cleanup preserves structure (no validation fails)',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.file.written).toBe(false);
      // safe = dedup + prune + weld: на уже-чистых моделях applied может быть 0 —
      // это корректное поведение opt-in. Главный инвариант — safe не ломает валидацию.
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },
    TIMEOUT,
  );
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: core invariant (triangles preserved) ----------
describe('Golden Corpus — core invariant: triangles ± small delta', () => {
  const TIMEOUT = 60000; // ABeautifulGame — большая модель

  it.each(GOLDEN_MODELS.filter(isSafeEligible))(
    '%s — triangles delta ≤ 10 (degenerate removal is normal)',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: ['safe'],
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
  const TIMEOUT = 60000; // ABeautifulGame — большая модель, safe+join дольше

  it.each(GOLDEN_MODELS.filter(isSafeEligible))(
    '%s — meshes ≤ before after join (flatten+join)',
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        advancedFeatures: ['safe', 'join'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // join (flatten+join) — opt-in, включается своим флагом
      expect(result.metrics.after.meshes).toBeLessThanOrEqual(result.metrics.before.meshes);
      expect(result.metrics.after.drawCalls).toBeLessThanOrEqual(result.metrics.before.drawCalls);
      // applied.length может быть 0 на моделях, где нечего джойнить (например,
      // AnisotropyBarnLamp, CommercialRefrigerator, IridescenceLamp — они уже
      // имеют оптимальную структуру). Это корректное поведение opt-in.
      // Главный инвариант: join+safe не ломает валидацию.
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },
    TIMEOUT,
  );
});

// ---------- DEFENSE-IN-DEPTH: safe ЯВНО что-то делает на грязных моделях ----------
// Ловушка 2 TEST_AGENT_PROMPT: инвариант «validation без fail» на чистках,
// которые могут быть silent no-op, проходит тривиально. Поэтому отдельный describe
// на «грязной» модели проверяет, что safe pipeline ЯВНО что-то сделал — `applied.length > 0`,
// `validation` без fail И хотя бы одно правило с правильным ruleId.
describe('Golden Corpus — safe is NOT silent no-op', () => {
  const TIMEOUT = 60000; // CarConcept — самая тяжёлая в корпусе

  const DIRTY_SAFE_MODELS = ['CarConcept.glb'];

  it.each(DIRTY_SAFE_MODELS)('%s — safe cleanup applies AT LEAST one rule', async (modelName) => {
    const result = await optimizeFile(modelPath(modelName), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Если safe тихо ничего не делает — applied.length === 0, этот expect падает.
    // Проверяем и что base-rule из safe-семейства сработал (dedup/prune),
    // и что валидация не зафиксировала fail (не маскирует broken pipeline).
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => SAFE_RULE_IDS.has(a.ruleId))).toBe(true);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  }, TIMEOUT);
});

// ---------- МЕТРИКИ ----------
describe('Golden Corpus — metrics structure', () => {
  const TIMEOUT = 60000; // ABeautifulGame — большая модель (~145 MB), нужен буфер

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
