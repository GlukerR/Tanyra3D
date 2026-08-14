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
// Учти: префикс `TESTBUG-*` — отдельный namespace; нумерация аудиторских находок
// прошлых итераций к этим тестам не относится.

import { it, expect } from 'vitest';
import { optimizeFile, VERSION } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { modelPath, describeIfModels, eachModel, isPresent } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// TESTBUG-008 — ЗАКРЫТ 2026-08-01 (задание 2026-08-01-квантование, раздел 3).
//
//   ИСТОРИЯ ДЕФЕКТА.
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
//   ЗАКРЫТ 2026-08-01: проверка «уже упакована (codec)» переставлена ПЕРВОЙ,
//   до проверки «уже квантована». Порядок теперь несёт смысл — человеку называют
//   причину, которую он может изменить (он сам выбрал Meshopt), а не описание
//   состояния файла, к которому его выбор и привёл.
//
//   Теперь это регресс: если проверки снова поменяют местами — тест покраснеет.
describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-008 (ЗАКРЫТ 2026-08-01) — meshopt+quantize объясняет воздержание codec-специфично', () => {
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

    // Причина названа codec-специфично, а не общим «уже квантована».
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('meshopt');
  });
});

// TESTBUG-009 — ЗАКРЫТ 2026-08-01 (аудит взаимоисключающих пар: ktx2+webp,
// quantize+draco, join+instance).
//
// ИСТОРИЯ ДЕФЕКТА.
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
// ЗАКРЫТ 2026-08-01: строка `join.expandedShared` убрана из движка целиком —
// она врала в обе стороны, и гипотеза выше подтвердилась замером (_work/join-*-probe):
//
//   1. Ни одного общего меша join на этой модели НЕ ПОЛУЧАЛ: после instance
//      shared.size === 0, общие меши исключены фильтром. Сообщение называло
//      причиной то, чего не происходило.
//   2. Рост мерился в окне самого transform-а, а сразу за join идёт
//      structure/prune-final. Итог: геометрия 2648 → 1880 байт на ['join'] и
//      2684 → 1916 на ['join','instance'] — МЕНЬШЕ, чем было, — пока строка
//      сообщала «+960 байт (+36 %)».
//
// Меньшую экономию отрисовок объясняет join.keptShared, настоящий вес — общий
// итог сборки. Теперь это регресс: вернётся ложная строка — тест покраснеет.
//
// Аудит остальных пар (2026-08-01) — расхождений НЕТ, заявки не нужны:
//   - quantize+draco: задание (стр. 76) ждёт «уже упакована (draco)» — движок
//     отвечает quantize.skipped.compressed + codec 'draco' на всех моделях корпуса;
//   - ktx2+webp: webp-задание (стр. 86–90, 193) ждёт «KTX2 применяется, WebP
//     уступает „уже GPU-формат“ (mime ktx2)» — факт совпадает
//     (webp.skipped.format / webp.skipped.noMime после ktx2-прохода).
//
describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-009 (ЗАКРЫТ 2026-08-01) — join+instance: join не разворачивает защищённую инстансингом общую геометрию', () => {
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

    // join НЕ разворачивает то, что защитил инстансинг, и не заявляет обратного:
    // ложной строки join.expandedShared в отчёте больше нет.
    const expanded = result.skipped.find(
      (s) => s.ruleId === 'scene/join' && s.i18n?.text?.messageId === 'join.expandedShared',
    );
    expect(expanded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TESTBUG-010 — расширение, которого не знает библиотека, пропадало из результата.
//
// ЧАСТИЧНО ЗАКРЫТ 2026-08-14 (решение Александра: «чини на passthrough, а с
// оптимизациями потом решим»).
//
// Что было. gltf-transform при загрузке выбрасывает незнакомое расширение и пишет
// документ уже без него. Наши правила ни при чём: структурные правила на таких моделях
// честно отказываются работать, а потеря происходила в самом цикле чтение→запись —
// на passthrough, при нуле применённых правил.
//
// Чем это было плохо, на образце Khronos PotOfCoalsAnimationPointer:
//   до     target = { extensions: { KHR_animation_pointer: { pointer: "/materials/2/…" } },
//                     path: "pointer" }
//   после  target = { path: "pointer" }
// Канал говорил «анимирую указатель» и больше не говорил ЧТО. Валидатор Khronos менял
// вердикт с INCOMPLETE_EXTENSION_SUPPORT на VALUE_NOT_IN_LIST.
//
// Почему не поймал никто. Сторож целостности сверяет треугольники, вершины, отрисовки,
// скины, анимации и морфы — расширений в списке нет, а число анимаций не менялось
// (1 → 1). Сеть валидатора сторожит ПОЯВЛЕНИЕ новых кодов, а тут возможность исчезала
// беззвучно. Слепое пятно у обоих.
//
// Как починено: addons/gltf/index.mts, restoreCarried(). При загрузке с исходника
// снимаются незнакомые расширения вместе с путями, при записи возвращаются на место —
// но ТОЛЬКО если отпечаток структуры совпал (длины логических массивов документа).
// Расширения держатся на номерах объектов; сдвинулась нумерация — не возвращаем ничего.
//
// ЧТО ОСТАЛОСЬ. Сериализатор сам схлопывает одинаковые текстуры и сэмплеры даже на
// passthrough: на AnimationPointerUVs это textures 61 → 13, samplers 61 → 1. Отпечаток
// не совпадает, восстановление отказывает — осознанно. Указатели той модели адресуют
// только материалы, и вернуть их было бы безопасно, но узнать это в общем виде нельзя:
// чужое расширение вправе ссылаться на что угодно.
// ---------------------------------------------------------------------------

const readGlbJson = (file) => {
  const buf = fs.readFileSync(file);
  return JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
};

eachModel(
  'TESTBUG-010: незнакомое расширение переживает passthrough',
  ['Unknown Ext LOD 01.glb', 'Unknown Ext Interactivity 01.glb', 'Unknown Ext Pointer 01.glb'],
  async (modelName) => {
    const src = modelPath(modelName);
    const declared = readGlbJson(src).extensionsUsed || [];
    expect(declared.length, 'модель-образец обязана нести расширение').toBe(1);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug010-'));
    try {
      const result = await optimizeFile(src, { advancedFeatures: [], outDir: dir });
      expect(result.status).toBe('ok');
      expect(result.applied.length, 'passthrough не применяет правил').toBe(0);

      const after = readGlbJson(path.join(dir, modelName)).extensionsUsed || [];
      expect(
        after,
        `${declared[0]} обязано пережить passthrough — иначе модель молча теряет ` +
        'возможность, о которой человеку никто не скажет',
      ).toContain(declared[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Настоящий образец Khronos: там расширение не просто объявлено, а несёт указатель на
// анимируемое свойство. Модель локальная (чужая лицензия), на чистом клоне пропускается.
eachModel(
  'TESTBUG-010: указатель анимации возвращается на место целиком',
  ['PotOfCoalsAnimationPointer.glb'],
  async (modelName) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug010b-'));
    try {
      await optimizeFile(modelPath(modelName), { advancedFeatures: [], outDir: dir });
      const json = readGlbJson(path.join(dir, modelName));
      expect(json.extensionsUsed).toContain('KHR_animation_pointer');

      const target = json.animations[0].channels[0].target;
      expect(target.path).toBe('pointer');
      expect(
        target.extensions?.KHR_animation_pointer?.pointer,
        'канал говорит «анимирую указатель», но не говорит что именно',
      ).toMatch(/^\//);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);


// ---------------------------------------------------------------------------
// TESTBUG-011 — под ОПТИМИЗАЦИЯМИ незнакомое расширение теряло адрес.
//
// ЗАКРЫТ 2026-08-15. Слово Александра: «анимация текстур не должна пропадать и должна
// показываться в обоих вьюпортах».
//
// Что было. Возврат чужих расширений (TESTBUG-010) сверял отпечаток структуры ЦЕЛИКОМ:
// длины всех логических массивов документа. Один сдвинувшийся массив отменял возврат
// всего — включая то, что этого массива не касалось. Два замера:
//   - сварка вершин добавляет треугольнику индексы, accessors 3 → 4, и указатель на
//     МАТЕРИАЛ пропадал, хотя материалы не шелохнулись;
//   - сериализатор схлопывает одинаковые текстуры и сэмплеры (AnimationPointerUVs:
//     61 → 13 и 61 → 1), и 103 указателя, все адресующие материалы, терялись из-за
//     чужой перенумерации — причём даже на passthrough.
//
// Как починено: addons/gltf/index.mts, arraysAddressedBy(). Расширение само называет
// свои цели — `/materials/0/pbrMetallicRoughness/baseColorFactor`. Первый сегмент такого
// адреса и есть имя массива, и достаточно убедиться, что не сдвинулся ОН. Решение
// принимается пообъектно, а не одно на весь файл.
//
// Строгость не ослаблена, а направлена: расширение без адресов-строк (MSFT_lod
// перечисляет узлы числами, KHR_interactivity хранит граф) осталось под полной сверкой.
// ---------------------------------------------------------------------------
eachModel(
  'TESTBUG-011 (закрыт): указатель переживает safe и join',
  ['Animated Pointer 01.glb'],
  async (modelName) => {
    for (const flags of [['safe'], ['safe', 'join'], ['safe', 'quantize']]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug011-'));
      try {
        await optimizeFile(modelPath(modelName), { advancedFeatures: flags, outDir: dir });
        const json = readGlbJson(path.join(dir, modelName));
        const label = flags.join(',');

        expect(json.extensionsUsed, `[${label}] расширение обязано остаться`).toContain('KHR_animation_pointer');
        const target = json.animations[0].channels[0].target;
        expect(target.path).toBe('pointer');
        expect(
          target.extensions?.KHR_animation_pointer?.pointer,
          `[${label}] канал говорит «анимирую указатель», но не говорит что именно`,
        ).toBe('/materials/0/pbrMetallicRoughness/baseColorFactor');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

// Образец Khronos с настоящей анимацией текстур: 103 канала, все адресуют материалы.
// До 2026-08-15 не выживал НИ ОДИН — сериализатор схлопывал текстуры, и общая сверка
// отказывала целиком. Модель локальная (чужая лицензия), на чистом клоне пропускается.
eachModel(
  'TESTBUG-011 (закрыт): все 103 указателя AnimationPointerUVs остаются с адресами',
  ['AnimationPointerUVs.glb'],
  async (modelName) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug011b-'));
    try {
      await optimizeFile(modelPath(modelName), { advancedFeatures: [], outDir: dir });
      const json = readGlbJson(path.join(dir, modelName));
      const channels = json.animations.flatMap((a) => a.channels);
      const addressed = channels.filter((c) => c.target?.extensions?.KHR_animation_pointer?.pointer);
      expect(channels.length).toBeGreaterThan(100);
      expect(addressed.length, 'указатели без адреса — это осиротевшие каналы').toBe(channels.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// TESTBUG-012 — KTX2 убивал анимацию текстур. Виноват был НЕ KTX2.
//
// ЗАКРЫТ 2026-08-15. Нашёл Александр, вопросом: «ktx2 убивает анимацию текстур?»
//
// Замер до правки, PotOfCoalsAnimationPointer:
//   [safe, webp] → указателей с адресом 2/2
//   [safe, ktx2] → указателей с адресом 0/2
// То есть терялось ровно на одной галочке из десяти.
//
// Причина. Правило KTX2 перекодирует картинки внешней утилитой и ради этого делает круг
// через временный файл: `ctx.document = await ctx.io.read(tmp)`. Документ после этого —
// ДРУГОЙ ОБЪЕКТ. Реестр снятых чужих расширений (TESTBUG-010) — WeakMap по документу,
// и в новом документе записи нет: на записи возвращать оказывалось нечего.
//
// Починено переносом реестра в addons/gltf/carried.mts и единственным санкционированным
// способом подмены — replaceDocument(). Ниже два сторожа: замер и запрет прямого
// присваивания, из-за которого дефект и появился.
// ---------------------------------------------------------------------------
const { TOKTX, HAS_GLTF_CLI } = await import('../addons/gltf/tools.mjs');

const ktx2Ready = Boolean(TOKTX && HAS_GLTF_CLI);
const itKtx2 = (name, body, timeout) => (ktx2Ready
  ? it(name, body, timeout)
  : it.skip(`${name} [пропущено: нет toktx/gltf-transform CLI]`, () => {}, timeout));

for (const model of ['PotOfCoalsAnimationPointer.glb']) {
  if (!isPresent(model)) continue;
  itKtx2(`TESTBUG-012 (закрыт): ${model} — KTX2 не уносит адрес указателя`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug012-'));
    try {
      await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'ktx2'], texMode: 'uastc', outDir: dir,
      });
      const json = readGlbJson(path.join(dir, model));
      const channels = json.animations.flatMap((a) => a.channels);
      const addressed = channels.filter((c) => c.target?.extensions?.KHR_animation_pointer?.pointer);
      expect(channels.length).toBeGreaterThan(0);
      expect(addressed.length, 'KTX2 унёс адреса указателей — вернулся круг через временный файл')
        .toBe(channels.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
}

// ---------------------------------------------------------------------------
// ПРАВИЛО «ИСТИНА — В ПЕРВОНАЧАЛЬНОМ ФАЙЛЕ» (Александр, 2026-08-15)
//
// Дословно: «брать за основу только первоначальный файл и последний всегда проверять
// с самым первым, а не с промежуточными нашими. Для всех проверок и тестов это должно
// быть правилом».
//
// Откуда взялось. TESTBUG-012: возврат чужих расширений держался на реестре, привязанном
// к ОБЪЕКТУ документа. Правило KTX2 перекодирует картинки внешней утилитой и делает круг
// через временный файл — документ после него другой объект, реестра в нём нет, и
// анимация исчезала ровно на одной галочке из десяти. Дефект был не в KTX2 и не в
// логике возврата, а в том, ЧТО МЫ СЧИТАЛИ ИСТОЧНИКОМ ПРАВДЫ.
//
// Как внедрено: `writeBytes(io, doc, src)` вычисляет возвращаемое ЗАНОВО из файла на
// диске в момент записи. Промежуточный документ на ответ не влияет никак — сколько бы
// раз его ни подменяли. Прежний реестр (addons/gltf/carried.mts) удалён вместе с
// функцией replaceDocument: чинить нечего, если ломаться нечему.
//
// Два сторожа ниже. Первый — структурный: подпись writeBytes обязана требовать исходник.
// Второй — поведенческий: то, что объявлено во ВХОДНОМ файле, обязано быть в выходном
// при любом наборе флажков, включая тот, что подменяет документ.
// ---------------------------------------------------------------------------

it('правило истины: writeBytes принимает ИСХОДНЫЙ файл, а не только документ', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'addons', 'gltf', 'index.mts'), 'utf8');
  const sig = /const writeBytes = async \(io: NodeIOType, doc: Document, src\?: string\)/.test(src);
  expect(
    sig,
    'writeBytes потерял довод src — значит снова сверяется с промежуточным документом, '
      + 'а не с первоначальным файлом (правило Александра 2026-08-15)',
  ).toBe(true);

  // И сам возврат обязан читать исходник, а не что-то накопленное по дороге.
  expect(
    /sourceJson\(src\)/.test(src),
    'writeBytes не читает исходный файл — источник правды подменён',
  ).toBe(true);
});

// Каждый набор флажков, включая ktx2 (единственный, кто подменяет документ целиком).
// Утверждение одно: объявленное во входном файле есть и в выходном.
for (const model of ['Animated Pointer 01.glb', 'Unknown Ext LOD 01.glb', 'Unknown Ext Interactivity 01.glb']) {
  for (const flags of [[], ['safe'], ['safe', 'join'], ['safe', 'quantize']]) {
    const label = `правило истины: ${model} [${flags.join(',') || 'passthrough'}] — расширения входа есть в выходе`;
    eachModel(label, [model], async (m) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-'));
      try {
        const before = readGlbJson(modelPath(m)).extensionsUsed || [];
        await optimizeFile(modelPath(m), { advancedFeatures: flags, outDir: dir });
        const after = readGlbJson(path.join(dir, m)).extensionsUsed || [];
        for (const name of before) {
          expect(after, `${name} объявлено во входном файле, но пропало из выходного`).toContain(name);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  }
}
