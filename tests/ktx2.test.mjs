// KTX2 compression tests — проверка advancedFeatures:['ktx2'].
//
// KTX2 — сжатие текстур в формат Basis Universal (KTX2). Требует установленного
// KTX-Software (toktx/ktx) и gltf-transform CLI для фактического кодирования.
//
// Если toktx не установлен:
//   - Модели БЕЗ текстур проходят ok (ktx2 нечего делать)
//   - Модели С текстурами ktx2 правило конвертирует JPEG→PNG и пытается
//     вызвать CLI для кодирования. Без toktx CLI падает → пайплайн graceful:
//     status:'fail' с валидационной ошибкой, но не крэш.
//   - Если toktx установлен — текстуры кодируются в KTX2, всё проходит ok.
//
// Проверяет:
// 1. advancedFeatures:['ktx2'] валидна — не кидает "Неизвестные advancedFeatures"
// 2. На CarConcept (известно-good): status ok, ktx2 в applied, треугольники ок
// 3. На всём золотом корпусе — ни одна модель не крэшится (может быть fail,
//    но не unhandled exception)
// 4. Baseline pipeline не ломается от присутствия ktx2

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { modelPath, describeIfModels, eachModel } from './helpers/model-files.mjs';
import { INPUT_DIR, inputModels as readInputModels, describeInput } from './helpers/input-folder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- TIMEOUTS ----
// KTX2 с текстурами дольше из-за lazy-import sharp и конвертации JPEG→PNG.
//
// Подняты втрое после 2026-07-29. Причина: правило `textures/ktx2` запускает
// ВНЕШНИЙ процесс `toktx` через execFileSync, и время его работы зависит не от
// теста, а от загрузки машины. В одиночку `['ktx2','draco']` на CarConcept идёт
// 15 секунд, а в полном прогоне vitest поднимает воркеры на все ядра, toktx
// конкурирует сам с собой — и те же тесты выбивали 60-секундный потолок.
// Наблюдалось 4 падения из 549 на одном прогоне и 0 на следующем при том же коде.
//
// Таймаут здесь — страховка от зависания, а не утверждение о скорости. Ловить им
// деградацию производительности бессмысленно: цифра всё равно зависит от того,
// что ещё крутится на машине. От настоящего зависания toktx защищает
// CLI_TIMEOUT_MS в addons/gltf/tools.mjs (BUG-007), и он куда точнее.
const TIMEOUT_BASIC = 180000;
const TIMEOUT_GOLDEN = 180000;
const TIMEOUT_INPUT = 300000;

// ---- KTX2: базовая проверка на CarConcept.glb ----

describeIfModels(['CarConcept.glb'], 'KTX2 — basic', () => {
  it('advancedFeatures:["ktx2"] is a valid feature (no unknown error)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('ktx2 alone triggers textures/ktx2 (geometry/compress stays opt-in)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // На модели с текстурами ktx2-препроцессинг отрабатывает (JPEG→PNG),
    // а сам факт — applied.length > 0 и presence of textures/ktx2.
    // geometry/compress НЕ включается автоматически: требует явного 'meshopt'/'draco'.
    // Это явный opt-in инвариант (правило 11 промпта).
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(false);
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation includes baseline entry and geometry present on ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // Инвариант:
    //   1. baseline-checkpoint ЕСТЬ в валидации (compareBaseline отработал).
    //   2. Есть pass-уровневая запись про геометрию ('geometry is present', английский).
    // Язык сообщений не хардкодить (правило промпта): на ktx2-only baseline-checkpoint
    // остаётся pass; на ktx2+draco и all-three может уйти в info/fail — отдельные тесты ниже.
    const baselineEntry = result.validation.find((v) => v.text.includes('baseline'));
    expect(baselineEntry).toBeDefined();

    const geoPass = result.validation.find(
      (v) => v.level === 'pass' && /geometry/i.test(v.text),
    );
    expect(geoPass).toBeDefined();
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with ktx2', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
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

// ---- KTX2: сравнение с default (без ktx2) на CarConcept ----

describeIfModels(['CarConcept.glb'], 'KTX2 — vs default pipeline', () => {
  it('both modes pass baseline validation', async () => {
    const [ktx2Result, defaultResult] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['ktx2'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: [],
        dryRun: true,
      }),
    ]);

    const ktx2Basel = ktx2Result.validation.find((v) => v.text.includes('baseline'));
    const defBasel = defaultResult.validation.find((v) => v.text.includes('baseline'));

    expect(ktx2Basel).toBeDefined();
    expect(defBasel).toBeDefined();
    expect(ktx2Basel.level).toBe('pass');
    expect(defBasel.level).toBe('pass');
  }, TIMEOUT_BASIC);
});

// ---- KTX2: на всём золотом корпусе ----
// Главная проверка: ни одна модель не вызывает unhandled exception.
// Модели с текстурами могут вернуть fail из-за документированного бага
// BUG-005: temp-файловый round-trip KTX2-кодирования меняет количество nodes.
//
// KTX2_FAILING очищен после audit-проверки на main @ ed0936c (2026-07-27):
// ни одна из ранее задокументированных «failing» моделей на актуальном коде
// не воспроизводится как fail (bug-репорт BUG-005 был снят).
// Если в будущем KTX2 снова начнёт ломать baseline на конкретных моделях —
// добавить сюда с комментарием что именно KTX2-проход ломает.

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
    // AnimationPointerUVs и PotOfCoalsAnimationPointer — known-failing
    // (KHR_animation_pointer), не тестируем с ktx2
  ];

  // Модели без KTX2-бага — status строго ok
  const HEALTHY_MODELS = GOLDEN_HEALTHY.filter((m) => !KTX2_FAILING.has(m));

  // it.each → eachModel: пропуск LOCALS, которых нет на диске.
  eachModel('ktx2 returns ok, triangles preserved', HEALTHY_MODELS, async (name) => {
    const result = await optimizeFile(modelPath(name), {
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

// ---- KTX2 + Draco: комбинированные расширения на CarConcept ----

describeIfModels(['CarConcept.glb'], 'KTX2 + Draco — combined features', () => {
  it('advancedFeatures:["ktx2","draco"] is valid (no unknown error)', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('both ktx2 and draco rules are present in applied', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // KTX2 правило сработало (хотя бы конвертация JPEG→PNG)
    const ktx2Applied = result.applied.filter((a) => a.ruleId === 'textures/ktx2');
    expect(ktx2Applied.length).toBeGreaterThan(0);

    // Geometry compress использует Draco (не meshopt)
    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation confirms file integrity with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['ktx2', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // Heavy combo (ktx2+draco) — compareBaseline может отсутствовать в валидации
    // или выдавать info/fail уровни. Главный инвариант — файл цел и валидация не пуста.
    expect(result.validation.length).toBeGreaterThan(0);
    const geoPass = result.validation.find(
      (v) => v.level === 'pass' && /geometry/i.test(v.text),
    );
    expect(geoPass).toBeDefined();
  }, TIMEOUT_BASIC);

  it('file size differs from both pure-ktx2 and pure-draco separately', async () => {
    // Запускаем все три режима параллельно
    const [combined, pureKtx2, pureDraco] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['ktx2', 'draco'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['ktx2'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['draco'],
        dryRun: true,
      }),
    ]);

    // Heavy combo (ktx2+draco) может вернуть fail из-за структурного отклонения
    // от baseline — graceful degradation, не краш. Аналогично all-three секции.
    expect(combined.status).toBeOneOf(['ok', 'fail']);
    expect(pureKtx2.status).toBe('ok');
    expect(pureDraco.status).toBe('ok');

    // Сравниваем размеры только если все три ok
    if (combined.status === 'ok' && pureKtx2.status === 'ok' && pureDraco.status === 'ok') {
      const combSize = combined.metrics.after.fileBytes;
      const ktx2Size = pureKtx2.metrics.after.fileBytes;
      const dracoSize = pureDraco.metrics.after.fileBytes;

      // Комбинированный режим даёт уникальный размер
      expect(combSize).not.toBe(ktx2Size);
      expect(combSize).not.toBe(dracoSize);
      expect(ktx2Size).not.toBe(dracoSize);
    } else {
      console.warn(`  ⚠ ktx2+draco heavy combo graceful degradation: combined=${combined.status}`);
    }
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with ktx2+draco', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
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

// ---- KTX2 + Draco + strip-colors: все три расширения сразу на CarConcept ----

const ALL_THREE = ['ktx2', 'draco', 'strip-colors'];

describeIfModels(['CarConcept.glb'], 'KTX2 + Draco + strip-colors — all three', () => {
  it('advancedFeatures:["ktx2","draco","strip-colors"] is valid', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
  }, TIMEOUT_BASIC);

  it('all three rules are present in applied', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // KTX2
    expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);

    // Draco (geometry/compress упоминает draco)
    const compressRule = result.applied.find((a) => a.ruleId === 'geometry/compress');
    expect(compressRule).toBeDefined();
    expect(compressRule.text).toMatch(/draco/i);

    // strip-colors (attributes/vertex-colors), если в модели есть COLOR_n
    // Если нет — правило может не дать applied-строки, это нормально
    const vcRule = result.applied.find((a) => a.ruleId === 'attributes/vertex-colors');
    if (vcRule) {
      expect(vcRule.text).toBeDefined();
    }
  }, TIMEOUT_BASIC);

  it('core invariant — triangles preserved with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ALL_THREE,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);
  }, TIMEOUT_BASIC);

  it('validation confirms file integrity with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
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
    // 4 режима параллельно. Примечание: CarConcept не имеет COLOR_n,
    // поэтому strip-colors не меняет размер файла. Кодек и KTX2 — основные
    // измерения, по которым размеры различаются.
    const [all3, ktx2Draco, ktx2Strip, dracoStrip] = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ALL_THREE,
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['ktx2', 'draco'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['ktx2', 'strip-colors'],
        dryRun: true,
      }),
      optimizeFile(modelPath('CarConcept.glb'), {
        advancedFeatures: ['draco', 'strip-colors'],
        dryRun: true,
      }),
    ]);

    // Heavy combo может вернуть fail из-за структурного отклонения от baseline
    // (например all3 на CarConcept). Главное — graceful degradation, не краш.
    expect(all3.status).toBeOneOf(['ok', 'fail']);
    expect(ktx2Draco.status).toBeOneOf(['ok', 'fail']);
    expect(ktx2Strip.status).toBeOneOf(['ok', 'fail']);
    expect(dracoStrip.status).toBeOneOf(['ok', 'fail']);

    // Если все 4 режима ok — сравниваем размеры (draco vs meshopt, ktx2+draco vs отдельные).
    // Если хоть один fail — heavy-combo graceful degradation, логируем без size-сравнения.
    if (
      all3.status === 'ok' && ktx2Draco.status === 'ok' &&
      ktx2Strip.status === 'ok' && dracoStrip.status === 'ok'
    ) {
      const a3 = all3.metrics.after.fileBytes;
      const kd = ktx2Draco.metrics.after.fileBytes;
      const ks = ktx2Strip.metrics.after.fileBytes;
      const ds = dracoStrip.metrics.after.fileBytes;

      expect(a3).not.toBe(ks);  // ktx2+draco != ktx2+meshopt
      expect(ds).not.toBe(ks);  // draco != meshopt
      expect(a3).not.toBe(ds);  // ktx2+draco != draco (ktx2 конвертирует JPEG→PNG)
      expect(kd).not.toBe(ds);
      expect(ks).not.toBe(ds);
    } else {
      console.warn(`  ⚠ Heavy combo graceful degradation: all3=${all3.status}, kd=${ktx2Draco.status}, ks=${ktx2Strip.status}, ds=${dracoStrip.status}`);
    }
  }, TIMEOUT_BASIC);

  it('metrics have all required fields with all three', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
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

// ---- KTX2: выборочно на input-папке ----
// Проверяем, что ktx2 не вызывает краша ни для одной из 10 первых моделей.
// Модели без текстур проходят ok без ktx2 в applied — это нормально.

describeInput('KTX2 — input folder (first 10 models)', () => {
  const inputModels = readInputModels({ limit: 10, ext: ['.glb'] });

  const knownFailing = new Set(['decepticon_fighter.glb', 'uttvm_core_guard.glb']);
  const models = inputModels.filter((m) => !knownFailing.has(m));

  it.each(models)('%s — no crash with ktx2', async (name) => {
    const result = await optimizeFile(path.join(INPUT_DIR, name), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    // Главное: не unhandled exception
    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);

    // Модели без текстур проходят ok, но ktx2 может не быть в applied —
    // это нормально: правило выполнилось, но текстуры не нашлись.
    // Модели с текстурами могут вернуть fail (без toktx).
    // В любом случае — не краш.
  }, TIMEOUT_INPUT);

  it(`${models.length} models tested from input/ with ktx2 — no crashes`, () => {
    expect(models.length).toBeGreaterThan(0);
  });
});
