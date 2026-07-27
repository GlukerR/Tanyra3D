// Bug documentation tests — тесты, документирующие найденные дефекты и несоответствия.
// По правилам TEST_AGENT_PROMPT.md: баги не исправляются, а фиксируются тестами.
//
// Найденные проблемы:
// 1. advancedFeatures:['safe'] не существует — 'safe' нет в ADVANCED_FEATURES
// 2. KHR_animation_pointer вызывает status:'fail' у моделей, которые его используют
// 3. decepticon_fighter.glb и uttvm_core_guard.glb падают с неизвестной ошибкой (BUG-006)
// 4. Ошибки о неизвестных advancedFeatures на русском, тест ожидает английский

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

// ---- БАГ №1: advancedFeatures:['safe'] не существует ----
describe('BUG-001: advancedFeatures:safe is not a valid feature', () => {
  it('passing advancedFeatures:["safe"] returns status fail', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    // Сообщение об ошибке — на русском, упоминает 'safe' как неизвестную фичу
    expect(result.error).toContain('safe');
    expect(result.error).toContain('Неизвестные');
  });

  it('passing advancedFeatures:["safe","meshopt"] also fails', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toContain('safe');
    // 'meshopt' тоже не в ADVANCED_FEATURES
    expect(result.error).toContain('meshopt');
  });
});

// ---- БАГ №2: KHR_animation_pointer вызывает fail ----
describe('BUG-002: KHR_animation_pointer models fail on passthrough', () => {
  const affectedModels = [
    { name: 'AnimationPointerUVs.glb', ext: 'KHR_animation_pointer' },
    { name: 'PotOfCoalsAnimationPointer.glb', ext: 'KHR_animation_pointer' },
  ];

  it.each(affectedModels)('$name fails with known extension error', async ({ name }) => {
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    // БАГ: result.error не задан — код выставляет status:'fail' без сообщения
    // Ожидалось бы сообщение вроде "Missing extension: KHR_animation_pointer"
    if (result.error) {
      console.log(`  🔍 ${name} error: ${result.error.slice(0, 200)}`);
    } else {
      console.log(`  🔍 ${name}: status=fail, error=undefined (BUG: no error message)`);
    }
  });
});

// ---- БАГ №3: decepticon_fighter и uttvm_core_guard (BUG-006) ----
describe('BUG-003: decepticon_fighter / uttvm_core_guard fail on passthrough', () => {
  const inputDir = path.resolve(PROJECT_ROOT, 'input');
  const failingModels = [
    { name: 'decepticon_fighter.glb', bugRef: 'BUG-006' },
    { name: 'uttvm_core_guard.glb', bugRef: 'BUG-006' },
  ];

  it.each(failingModels)('$name (ref: $bugRef) returns fail on passthrough', async ({ name }) => {
    const p = path.join(inputDir, name);
    if (!fs.existsSync(p)) {
      console.warn(`  ⚠️  Модель ${name} не найдена в input/ — пропуск`);
      return;
    }
    const result = await optimizeFile(p, {
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    // БАГ: result.error не задан — код выставляет status:'fail' без сообщения
    // См. BUG-006 в assistants/review/findings/
    if (result.error) {
      console.log(`  🔍 ${name} error: ${result.error.slice(0, 200)}`);
    } else {
      console.log(`  🔍 ${name}: status=fail, error=undefined (BUG: no error message)`);
    }
  });
});

// ---- БАГ №5: KTX2 temp-файловый round-trip меняет nodes ----
describe('BUG-005: KTX2 temp-file round-trip changes node count', () => {
  const KTX2_FAILING = [
    { name: 'ChronographWatch.glb', bug: 'nodes 11→12' },
    { name: 'CommercialRefrigerator.glb', bug: 'nodes 6→8' },
    { name: 'DiffuseTransmissionPlant.glb', bug: 'nodes 14→20' },
  ];

  const TIMEOUT = 60000; // KTX2 с текстурами дольше

  it.each(KTX2_FAILING)('$name fails with ktx2 ($bug)', async ({ name }) => {
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');

    // Баг: после KTX2-кодирования (io.write→io.read через temp-файл)
    // количество nodes расходится с baseline-checkpoint.
    // Ошибка в validation, не в result.error (который undefined).
    const nodeValidation = result.validation.find(
      (v) => v.level === 'fail' && v.text.includes('nodes'),
    );
    expect(nodeValidation).toBeDefined();
    console.log(`  🔍 ${name}: ${nodeValidation.text.slice(0, 120)}`);

    // Коренная причина: textures/ktx2.fix() пишет temp-файл в outDir,
    // вызывает gltf-transform CLI (если toktx найден), читает результат
    // обратно. Даже ПРИ ОТСУТСТВИИ toktx (fail) конвертация JPEG→PNG и
    // повторная запись/чтение меняет node-иерархию (структура IO).
    // Временный файл удаляется в finally, но структура документа уже изменена.
  }, TIMEOUT);

  it('all 3 known KTX2-failing models have textures', () => {
    for (const { name } of KTX2_FAILING) {
      const p = modelPath(name);
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});

// ---- БАГ №4: Несоответствие языка ошибок ----
describe('BUG-004: Error message language mismatch', () => {
  it('unknown advancedFeature error is in Russian, not English', async () => {
    const result = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['nonexistent_feature'],
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    // Сообщение на русском — тест проверяет, что это не английский
    expect(result.error).toContain('Неизвестные');
    expect(result.error).toContain('nonexistent_feature');
    // Доступные фичи в сообщении
    expect(result.error).toContain('ktx2');
    expect(result.error).toContain('draco');
    expect(result.error).toContain('strip-colors');
  });
});
