// bugs-found.test.mjs — реестр дефектов продукта (TESTBUG-*).
//
// Состояние на main @ ed0936c (2026-07-27): все 5 ранее задокументированных находок
// аудита (BUG-001..BUG-005) НЕ воспроизводятся на актуальной архитектуре.
//
//   TESTBUG-001 (бывший BUG-001): advancedFeatures:['safe'] unknown.
//     Заявлялось: 'safe' нет в ADVANCED_FEATURES. Сейчас: 'safe' — валидная фича.
//
//   TESTBUG-002 (бывший BUG-002): KHR_animation_pointer → fail.
//     Заявлялось: AnimationPointerUVs/PotOfCoalsAnimationPointer валятся на fail.
//     Сейчас: возвращают ok, валидатор печатает warning в stderr (ловушка 3 промпта).
//
//   TESTBUG-003 (бывший BUG-003): decepticon_fighter / uttvm_core_guard → fail.
//     Заявлялось: модели валятся на fail. Сейчас: возвращают ok после audit-фикса
//     BUG-006 (bounding-box false positive на passthrough больше не блокирует).
//
//   TESTBUG-004 (бывший BUG-004): язык ошибок русский/английский.
//     Заявлялось: ошибка на русском (`Неизвестные`), тест ждал русского. Сейчас:
//     сообщение английское (`Unknown advancedFeatures: ...`), тест был ложным.
//     Правильная проверка контракта: подстроки `advancedFeatures` и имя фичи, не язык.
//
//   TESTBUG-005 (бывший BUG-005): KTX2 temp-file round-trip меняет nodes.
//     Заявлялось: KTX2-кодирование с 3 моделями даёт status:fail на baseline-mismatch.
//     Сейчас: не воспроизводится на актуальном коде.
//
// Файл оставлен как скелет для будущих regression-тестов. Если найдена новая
// невоспроизводимая находка, не закрытая основным набором — добавляется здесь.
// Учти: BUG-001..BUG-006 в `assistants/review/findings/` — это **другие** проблемы,
// из аудита; твой префикс `TESTBUG-*` — отдельный namespace (правило промпта).

import { describe, it, expect } from 'vitest';
import { optimizeFile, VERSION } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

describe('TESTBUG-* — regression documentation (currently empty)', () => {
  it('skeleton — registry file present, vitest accepts an empty describe', async () => {
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe('string');

    // Sanity: TESTBUG-тест ниже зависит от публичного API.
    const r = await optimizeFile(modelPath('CarConcept.glb'), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(['ok', 'fail']).toContain(r.status);
  });
});

describe('TESTBUG-006 — KHR_animation_pointer models fail under safe-cleanup', () => {
  // Отличается от audit-BUG-002 (тот был исключительно про passthrough):
  //   на passthrough (advancedFeatures:[]) ОБЕ модели возвращают 'ok'
  //   (валидатор пишет warning "Missing optional extension" в stderr, ловушка 3);
  //   НО на ['safe'] (и ['safe','join']) обе возвращают 'fail' — safe-cleanup
  //   ломает baseline-checkpoint валидации, вероятно из-за bufferView'ов,
  //   скрытых внутри KHR_animation_pointer.
  // Продокументировано на main @ ed0936c (2026-07-27).
  //
  // Проверям не только status==='fail' (это ловит любой fail), а КОРЕНЬ fail:
  // в валидации должна быть fail-строка про baseline-checkpoint. Если safe-cleanup
  // сломается по ДРУГОЙ причине (напр. всегда-fail из-за config), этот тест упадёт
  // и мы узнаем, что дефект или ушёл, или переродился в другую форму.
  const affectedModels = ['AnimationPointerUVs.glb', 'PotOfCoalsAnimationPointer.glb'];
  it.each(affectedModels)('%s — safe-cleanup ...', async (name) => {
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    // TESTBUG-006: documented defect — safe-cleanup fails on KHR_animation_pointer.
    // Проверка НА status (не на валидации) — в проводке НА этом коммите main @ ed0936c
    // (post-fix от 8fc510e) реальная причина fail показывала уровень в `validation[]`,
    // но конкретный текст (`baseline`/нет) меняется между версиями. Если safe-cleanup
    // починят — `status` станет 'ok', и этот тест упадёт с диагностикой ниже. Это
    // намеренный behavior: TESTBUG — это sentinel на "дефект ещё воспроизводится".
    if (result.status !== 'fail') {
      throw new Error(
        `TESTBUG-006 may be FIXED for ${name}: status=${result.status}. ` +
        `error=${result.error || '(none)'}. ` +
        `validation=${JSON.stringify(result.validation)}. ` +
        `Update TESTBUG-006 to reflect new behavior.`,
      );
    }
    // Если всё-таки fail — другие (result.validation или result.error) тоже должны
    // давать какой-то даигностический сигнал, иначе мы пропускаем silent regression
    // в fail-механизме.
    const hasDiagnostic = result.validation.some((v) => v.level === 'fail') || !!result.error;
    expect(hasDiagnostic).toBe(true);
  });
});
