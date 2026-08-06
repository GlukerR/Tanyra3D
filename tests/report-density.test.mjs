// tests/report-density.test.mjs — сторож плотности отчёта (docs/EXTENDING.md §5b,
// прямое требование Александра от 2026-08-01).
//
// Суть: дефект «толпа одинаковых строк» не должен возвращаться с каждой новой
// фичей. Правило, которое обходит список (текстуры, меши, атрибуты, узлы),
// обязано вернуть ОДНУ запись на класс случаев, а не запись на элемент:
// двадцать строк «карта данных в JPEG», одиннадцать «уже WebP» — это дефект.
//
// Сторож: проходим корпус (GOLDEN_MODELS + модели с текстурами из задания
// webp-корпус) под несколькими наборами флагов и считаем, сколько записей в
// applied / skipped / findings / validation несут один и тот же messageId:
//
//   const id = (rec) => rec.i18n?.text?.messageId;   // рецепт i18n лежит в записи
//
// validation считается наравне со списками правил: записи проверки кладутся
// через vp() с тем же рецептом i18n (addons/gltf/index.mjs). «Толпа» тут так же
// возможна, как в applied/skipped, и так же является дефектом. Единственный
// близкий к порогу случай — check.validatorExample: движок сам ограничивает
// примеры сообщений Khronos-валидатора тремя (slice(0, 3)); три — ровно порог,
// не нарушение. Если когда-нибудь cap вырастет выше лимита — сторож честно
// пойдёт в красный, и это правильное поведение.
//
// Больше трёх записей с одинаковым messageId в одном отчёте — тест красный.
// В сообщении об ошибке — модель, набор флагов, messageId и количество.
//
// Три — не священное число, а запас: две-три однотипные строки читаются
// нормально, десяток уже нет. Если существующее правило порог не проходит —
// НЕ поднимать порог, а записать находку в отчёт: чинить будет основной агент.
//
// ЕДИНСТВЕННОЕ исключение (белый список) — engine.skipped.line, строка
// «правило X пропущено, фича не включена»: их столько, сколько невключённых
// фич (до восьми), но каждая называет СВОЮ фичу — это перечень выбора, а не
// повтор одного и того же. Белый список явный и не пополняется, чтобы тест
// позеленел: новая запись — решение основного агента, а не способ обойти.
//
// Прогон 2026-08-01 по Production Draco Webp 01, MosquitoInAmber2, ToyCar, SheenWoodLeatherSofa,
// Production Multi UV 01, parkergirl под ['safe','join','instance'] не нашёл ни одного повтора
// кроме исключения — сторож обязан быть зелёным на момент выдачи задания.

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';
import { densityViolations, DENSITY_LIMIT } from './helpers/report-density.mjs';

// Белый список, порог и функция densityViolations вынесены в tests/helpers/
// report-density.mjs по заданию «сочетания фич»: сторож гоняет десятки наборов
// флагов (tests/feature-combos.test.mjs), и дублировать функцию нельзя. Почему
// белый список именно такой — см. в шапке хелпера.

// ============================================================================
// Корпус: GOLDEN_MODELS (24 из tests/golden-corpus.test.mjs) + модели
// с текстурами из задания webp-корпус (BoomBox, chibi_zenitsu, Production Many Materials 01,
// Linked Duplicates Grid 01 — последняя без текстур, но в списке воздержания).
// ============================================================================
const DENSITY_CORPUS = [
  // GOLDEN_MODELS — 24 референсных модели корпуса
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
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Cthulhu Stone 01.glb',
  'Lilith Character 01.glb',
  // модели с текстурами из задания webp (локальные)
  'BoomBox.glb',
  'chibi_zenitsu.glb',
  'Production Many Materials 01.glb',
  'Linked Duplicates Grid 01.glb',
];

// Наборы флагов — как минимум те, что в задании. dryRun: true: сторожу нужен
// отчёт, файл на диск писать незачем (и быстрее, и чище).
const DENSITY_FLAG_SETS = [
  ['safe'],
  ['webp'],
  ['safe', 'webp'],
  ['safe', 'join', 'instance'],
  ['safe', 'quantize'], // задание 2026-08-01-квантование, раздел 6: правило выдаёт максимум две строки на модель
];



// ============================================================================
// Сторож: корпус × наборы флагов, никакая запись не повторяется чаще 3 раз.
// ============================================================================
describe('Report density — сторож повторов одинаковых messageId (Правило 9)', () => {
  for (const flags of DENSITY_FLAG_SETS) {
    eachModel(`плотность отчёта ≤${DENSITY_LIMIT} (флаги: [${flags.join(', ')}])`, DENSITY_CORPUS, async (name) => {
      const result = await optimizeFile(modelPath(name), {
        advancedFeatures: flags,
        dryRun: true,
      });

      // Статус fail — легитимен для части корпуса (KHR_animation_pointer и т.п.),
      // сторож считает плотность ОТЧЁТА, а не успешность сборки.
      const violations = densityViolations(result);
      const detail = violations
        .map(([id, n]) => `${id} ×${n}`)
        .join(', ');
      expect(violations, `модель: ${name} · флаги: [${flags.join(', ')}] · повторы: ${detail}`).toEqual([]);
    });
  }

  it(`${DENSITY_CORPUS.length} моделей × ${DENSITY_FLAG_SETS.length} набора флагов — сторож работает`, () => {
    expect(DENSITY_CORPUS.length).toBeGreaterThan(0);
    expect(DENSITY_FLAG_SETS.length).toBeGreaterThan(0);
  });

  // Сторож обязан видеть validation-секцию, а не только списки правил: записи
  // проверки кладутся vp() с тем же рецептом i18n, и «толпа» там — такой же
  // дефект, как в applied/skipped. Четыре одинаковых — красный.
  it('сторож видит повторы и в validation-секции', () => {
    const fake = {
      applied: [{ ruleId: 'x', i18n: { text: { messageId: 'rule.one' } } }],
      skipped: [],
      findings: [],
      validation: [
        { level: 'pass', text: '1', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '2', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '3', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '4', i18n: { text: { messageId: 'check.same' } } },
      ],
    };
    expect(densityViolations(fake)).toContainEqual(['check.same', 4]);
  });

  // А три — не нарушение: движок сам ограничивает примеры сообщений валидатора
  // тремя (check.validatorExample, slice(0, 3)), это ровно порог, не толпа.
  it('три однотипные строки validation — не нарушение (cap движка = порог)', () => {
    const fake = {
      applied: [],
      skipped: [],
      findings: [],
      validation: [1, 2, 3].map((n) => ({ level: 'info', text: `${n}`, i18n: { text: { messageId: 'check.validatorExample' } } })),
    };
    expect(densityViolations(fake)).toEqual([]);
  });
});
