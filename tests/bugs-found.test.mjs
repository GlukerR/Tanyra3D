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
import fs from 'node:fs';
import { modelPath, describeIfModels, eachModel } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

describeIfModels(['CarConcept.glb'], 'TESTBUG-* — regression documentation (currently empty)', () => {
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

// TESTBUG-007 — ЗАКРЫТ 2026-07-29. Был: parkergirl + safe+meshopt → status='fail'
//   с «skins lost: was 1, now 14» и «bounding box changed».
//
//   Причина оказалась не в морфах и не в скинах как таковых, а в параметре
//   quantizationVolume, который у @gltf-transform/functions по умолчанию равен 'mesh':
//   своя область квантования на каждый меш → своё компенсирующее преобразование. Для
//   скинованного меша трансформация узла по спецификации glTF ИГНОРИРУЕТСЯ, поэтому
//   компенсация обязана лежать в inverseBindMatrices — а они принадлежат скину. Четырнадцать
//   мешей с разными областями потребовали четырнадцати наборов IBM, и общий скин расщепился.
//
//   Починено в addons/gltf/rules.mjs (geometry/compress): при наличии скинов передаём
//   quantizationVolume: 'scene' — одна область на сцену, один набор IBM, скин остаётся общим.
//
//   Второй маркер (bounding box) дефектом не был: getBounds() читает POSITION и трансформации
//   узлов и не читает IBM, поэтому на квантованной скинованной модели показывает
//   непозированную геометрию. Проверено на parkergirl: узел остаётся scale [1,1,1], а IBM
//   меняется 1 → 0.8099. Проверка bbox для этого случая переведена в info (см. index.mjs).
//
//   Теперь это регресс: если quantizationVolume снова уедет в 'mesh' либо gltf-transform
//   поменяет поведение — тест покраснеет.
describeIfModels(['parkergirl.glb'], 'TESTBUG-007 (закрыт) — parkergirl под safe+meshopt сохраняет скин', () => {
  const isParkergirlLocal = fs.existsSync(modelPath('parkergirl.glb'));
  const targetModel = 'parkergirl.glb';
  const expectedMode = ['safe', 'meshopt'];

  const fn = isParkergirlLocal ? it : it.skip;
  fn(`${targetModel} ${JSON.stringify(expectedMode)} — status='ok', скин один, морфы целы`, async () => {
    const result = await optimizeFile(modelPath(targetModel), {
      advancedFeatures: expectedMode,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const { before, after } = result.metrics;
    // Корень дефекта: скин обязан остаться общим, а не расщепиться по мешам.
    expect(after.skins).toBe(before.skins);
    // То, ради чего модель вообще брали в корпус, — 456 морф-таргетов должны пережить сжатие.
    expect(after.morphTargets).toBe(before.morphTargets);
    expect(after.triangles).toBe(before.triangles);

    // Ни одного fail: раньше их было два.
    const failed = (result.validation || []).filter((v) => v.level === 'fail');
    expect(failed).toEqual([]);
  });
});

// requireAnimationPointer LOCAL — обе модели на disk.
describeIfModels(['AnimationPointerUVs.glb', 'PotOfCoalsAnimationPointer.glb'], 'TESTBUG-006 (ЗАКРЫТ 2026-07-31) — KHR_animation_pointer models survive safe-cleanup', () => {
  // ИСТОРИЯ ДЕФЕКТА.
  // Задокументирован на main @ ed0936c (2026-07-27): обе модели с
  // KHR_animation_pointer возвращали 'fail' на ['safe'] — safe-cleanup
  // ломал baseline-checkpoint, потому что структурные правила (dedup,
  // prune-unused) переставляли/удаляли свойства, не видя ссылок по
  // индексу из неизвестного расширения.
  //
  // 2026-07-31 дефект закрыт: структурные правила (structure/dedup,
  // structure/prune-unused, structure/prune-final, scene/join, scene/instance)
  // теперь отказываются с { safe: false } и messageId
  // 'unsupportedExtension.refuse', когда в файле объявлено неизвестное
  // расширение. Модели больше не ломаются: status='ok', анимации целы,
  // неструктурные правила (weld) продолжают работать.
  //
  // Теперь это регресс: если структурные правила снова начнут трогать
  // модели с неизвестным расширением — тест покраснеет.
  const affectedModels = ['AnimationPointerUVs.glb', 'PotOfCoalsAnimationPointer.glb'];
  eachModel('safe-cleanup returns ok, animations preserved', affectedModels, async (name) => {
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    // Дефект закрыт: status обязан быть 'ok', анимации не теряются.
    expect(result.status).toBe('ok');
    expect(result.metrics.after.animations).toBe(result.metrics.before.animations);
    // Структурные правила ОБЯЗАНЫ отказаться с kind:'unsafe'.
    // Движок оборачивает canFix-сообщение в engine.skipped.line —
    // проверяем по тексту, а не по messageId правила.
    const refused = result.skipped.filter((s) =>
      s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // Среди отказавшихся должен быть structure/prune-final (самый опасный —
    // удаляет «осиротевшие» ресурсы, не видя ссылок из KHR_animation_pointer).
    expect(refused.some((s) => s.ruleId === 'structure/prune-final')).toBe(true);
  });
});

// TESTBUG-008 — ОТКРЫТ 2026-08-01 (задание 2026-08-01-квантование, раздел 3).
//
//   ОЖИДАНИЕ (по заданию, таблица «Отказы»): `['safe','meshopt','quantize']` →
//   правило воздерживается, в `skipped` строка «геометрия уже упакована (meshopt)»
//   (`quantize.skipped.compressed`, `data.codec === 'meshopt'`).
//
//   ФАКТ на 2026-08-01: движок отвечает `quantize.skipped.already` («Геометрия уже
//   квантована — второй проход только добавил бы потерь») БЕЗ codec в данных.
//
//   Шаг воспроизведения:
//     optimizeFile('fixtures/models/Dirty Cube 01.glb',
//       { advancedFeatures: ['safe','meshopt','quantize'], dryRun: true })
//     → status 'ok'; applied НЕ содержит geometry/quantize;
//       skipped содержит geometry/quantize с messageId 'quantize.skipped.already'.
//
//   Причина: geometry/compress (meshopt) идёт раньше geometry/quantize и сам
//   применяет KHR_mesh_quantization — документ уже несёт расширение, и ПЕРВАЯ
//   проверка правила («уже квантована») срабатывает раньше ветки «compressed».
//   Для draco ветка работает (`quantize.skipped.compressed` + codec 'draco',
//   проверено на Dirty Cube 01) — рассинхрон только с meshopt.
//
//   Воздержание есть (правило не применяется, потерь нет) — расходится только
//   текст причины. Движок по заданию НЕ чиним. Тест-сентинел оставлен красным:
//   когда поведение поправят (порядок проверок / охват meshopt-кейса), тест
//   позеленеет. Отчёт о расхождении — внизу файла задания.
describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-008 (открыт) — meshopt+quantize объясняет воздержание codec-специфично', () => {
  // Dirty Cube 01 — репо-модель, присутствует всегда; guard оставлен для симметрии с реестром.
  const isPresent = fs.existsSync(modelPath('Dirty Cube 01.glb'));
  const fn = isPresent ? it : it.skip;
  fn("['safe','meshopt','quantize'] — в skipped «геометрия уже упакована (meshopt)»", async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['safe', 'meshopt', 'quantize'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // Воздержание — часть контракта, держится даже при дефекте.
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();

    // ОЖИДАНИЕ по заданию. Факт 2026-08-01: 'quantize.skipped.already' без codec —
    // тест красный, дефект воспроизводится (см. историю выше).
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('meshopt');
  });
});

// TESTBUG-009 — ОТКРЫТ 2026-08-01 (аудит взаимоисключающих пар: ktx2+webp,
// quantize+draco, join+instance).
//
// ОЖИДАНИЕ (комментарий в rules.mjs, scene/join): «runAfter включает scene/instance
// НАМЕРЕННО... Инстансированные узлы несут EXT_mesh_gpu_instancing, и join их не
// трогает — то есть instance, отработав первым, физически защищает общую геометрию
// от разворачивания в копии». То есть на модели с общей геометрией пара
// join+instance должна дать: instance инстансирует общий меш, join его НЕ
// разворачивает — без строки join.expandedShared.
//
// ФАКТ на 2026-08-01: `['join','instance']` на Dirty Cube 01 (Cube.002 — общий меш,
// 3 родительские ноды) → status 'ok'; applied содержит scene/instance (3 инстанса)
// и scene/join (join.done: dcBefore=9 → dcAfter=9, т.е. 0 сэкономленных draw calls,
// nodes 9 → 6); в skipped — scene/join → join.expandedShared {bytes:960, pct:36,
// dcSaved:0} «Объединение размножило общую геометрию: +960 байт (+36%) ради 0
// отрисовок меньше». При этом в выходе инстансинг ЖИВ (1 узел с
// EXT_mesh_gpu_instancing, 3 инстанса), а суммарные байты геометрии МЕНЬШЕ, чем у
// одного instance (1916 против 2684 accessor-байт; файл 18104 против 61640).
// Текст причины противоречит фактическому результату.
//
// Шаг воспроизведения:
//   optimizeFile('fixtures/models/Dirty Cube 01.glb',
//     { advancedFeatures: ['join','instance'], dryRun: true })
//   → status 'ok'; applied: scene/instance, scene/join;
//     skipped: scene/join с messageId 'join.expandedShared'
//     (data: bytes=960, pct=36, dcSaved=0).
//
// Причина (гипотеза, движок не правим): join.expandedShared измеряется в окне
// самого transform-а (до/после flatten+join) и ловит временный рост геометрии,
// который потом убирает structure/prune-final — финальный файл легче, чем у
// одного instance, а сообщение остаётся. Воздержание есть только на моделях, где
// после instance общих мешей не остаётся вовсе (Linked/Unlinked Duplicates — join
// воздерживается корректно); на Dirty Cube остаток «не-инстансированной» общей
// геометрии даёт ложное срабатывание.
//
// Аудит остальных пар (2026-08-01) — расхождений НЕТ, заявки не нужны:
//   - quantize+draco: задание (стр. 76) ждёт «уже упакована (draco)» — движок
//     отвечает quantize.skipped.compressed + codec 'draco' на всех моделях корпуса;
//   - ktx2+webp: webp-задание (стр. 86–90, 193) ждёт «KTX2 применяется, WebP
//     уступает „уже GPU-формат“ (mime ktx2)» — факт совпадает
//     (webp.skipped.format / webp.skipped.noMime после ktx2-прохода).
//
// Тест-сентинел оставлен красным: когда join перестанет разворачивать защищённую
// инстансингом геометрию (или сообщение перестанет врать про финальный файл),
// тест позеленеет. Движок по правилам НЕ чиним.
describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-009 (открыт) — join+instance: join не разворачивает защищённую инстансингом общую геометрию', () => {
  // Dirty Cube 01 — репо-модель, присутствует всегда; guard для симметрии с реестром.
  const isPresent = fs.existsSync(modelPath('Dirty Cube 01.glb'));
  const fn = isPresent ? it : it.skip;
  fn("['join','instance'] — в skipped нет join.expandedShared, инстансинг применился", async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['join', 'instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    // Инстансинг реально применился — общую геометрию (Cube.002, 3 родителя) защищать есть чем.
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);

    // ОЖИДАНИЕ: join НЕ разворачивает то, что защитил инстансинг → в skipped НЕТ
    // join.expandedShared. Факт 2026-08-01: запись ЕСТЬ ({bytes:960, pct:36,
    // dcSaved:0}) при живом инстансинге в выходе и меньшей итоговой геометрии —
    // тест красный, дефект воспроизводится (см. историю выше).
    const expanded = result.skipped.find(
      (s) => s.ruleId === 'scene/join' && s.i18n?.text?.messageId === 'join.expandedShared',
    );
    expect(expanded).toBeUndefined();
  });
});
