// tests/quantize.test.mjs — покрытие правила geometry/quantize (фича 'quantize',
// «Квантование»).
//
// Правило — третий способ уменьшить геометрию и единственный, которому НЕ нужен
// декодер на сайте: координаты вершин переписываются 16-/8-битными числами вместо
// 32-битных (KHR_mesh_quantization), three.js читает такую геометрию сам. Поэтому
// значка «нужен декодер» у опции нет — в отличие от Draco, Meshopt, KTX2.
//
// В интерфейсе это третий взаимоисключающий пункт группы «Геометрия». Взаимоисключение
// не косметика: Draco квантует своим способом, Meshopt тянет то же расширение внутри
// себя, и поверх них квантовать нечего.
//
// Разделы (задание 2026-08-01-квантование):
//   1. Инварианты на корпусе с геометрией: треугольников ровно столько же, вес данных
//      геометрии строго меньше, KHR_mesh_quantization объявлен в required (а не только
//      used), status ok, валидатор Khronos не добавил ошибок.
//   2. Сторож скинов — САМОЕ ВАЖНОЕ (TESTBUG-007): parkergirl 1 скин → 1 скин,
//      quantize.done.scene в отчёте; RiggedSimple — то же.
//   3. Отказы: ['safe','draco','quantize'] и ['safe','meshopt','quantize'], повторный
//      проход по уже квантованной модели, модель с KHR_mesh_quantization на входе,
//      модель без геометрии (Orphan Texture Cube 01).
//   4. Морфы и анимация: Morph Cube 01 и parkergirl — счётчики не изменились,
//      baseline-checkpoint зелёный.
//   5. Отчёт переживает смену языка: localizeResult без пересборки.
//   (сторож плотности — tests/report-density.test.mjs, добавлен набор ['safe','quantize'])
//
// Ловушки задания:
//   - точные байты в утверждения не пишем — только направление и структуру;
//     единственное точное число — количество треугольников;
//   - BoomBox даёт −1 % по файлу при −41 % по геометрии, поэтому инвариант
//     формулируется ПО ГЕОМЕТРИИ (сумма byteLength аксессоров), а не по файлу;
//   - Production Draco Webp 01 под Draco падает в status:'fail' по своей, давно известной причине
//     (расхождение треугольников на драко-кодировщике) — в находки по квантованию
//     это не пишется и тест под это не подгоняется; отказы проверяем на Dirty Cube.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult, render } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath, eachModel, describeLocal, describeIfModels } from './helpers/model-files.mjs';

// ---- инструменты: чтение выходного .glb тем же io, которым пишет аддон ----
const ioPromise = gltfAddon.createIO();

function tmpOutDir(prefix = 'quantize-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// «Вес данных геометрии» — сумма byteLength по аксессорам (ровно как считает правило).
async function accessorBytes(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  let n = 0;
  for (const a of doc.getRoot().listAccessors()) n += a.getArray()?.byteLength || 0;
  return n;
}

// Расширения, помеченные в выходном файле как required (движок, не знающий
// расширения, обязан отказаться открыть файл, а не показать сломанную модель).
async function requiredExtensions(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  return doc.getRoot().listExtensionsRequired().map((e) => e.extensionName);
}

// Валидатор Khronos не добавил ошибок: либо 0 (pass), либо не больше, чем на входе
// (часть корпуса имеет ошибки ИЗНАЧАЛЬНО — Dirty Cube: UNSATISFIED_DEPENDENCY).
function validatorDidNotWorsen(result) {
  const zero = result.validation.find((v) => v.i18n?.text?.messageId === 'check.validatorZeroErrors');
  if (zero) return zero.level === 'pass';
  const remain = result.validation.find((v) => v.i18n?.text?.messageId === 'check.validatorErrorsRemain');
  return !!remain && remain.i18n.text.data.errs <= remain.i18n.text.data.inErrs;
}

// ============================================================================
// РАЗДЕЛ 1. Инварианты на корпусе с геометрией.
// ============================================================================
// Репо-модели (всегда на месте) + локальные (eachModel сам пропустит отсутствующие).
// Meshopt Compressed Input 01 сюда НЕ входит: на входе уже KHR_mesh_quantization,
// правило воздерживается, «строго меньше» не выполняется — это раздел 3.
const QUANTIZE_CORPUS = [
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Linked Duplicates Grid 01.glb',
  'Preinstanced Grid 01.glb',
  'Unlinked Duplicates 01.glb',
  'Draco Compressed Input 01.glb',
  // локальные
  'parkergirl.glb',
  'RiggedSimple.glb',
  'MosquitoInAmber2.glb',
  'BoomBox.glb',
];

describe('Квантование — инварианты на корпусе с геометрией', () => {
  eachModel('quantize: треугольники те же, геометрия легче, расширение в required, status ok', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const beforeBytes = await accessorBytes(modelPath(name));
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    // ГЛАВНЫЙ инвариант: треугольников ровно столько же, сколько было.
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);

    // Вес данных геометрии СТРОГО меньше (инвариант по геометрии, а не по файлу:
    // на BoomBox файл почти не меняется — вес в текстурах).
    expect(await accessorBytes(result.file.dst)).toBeLessThan(beforeBytes);

    // KHR_mesh_quantization объявлен в required, а не только в used.
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');

    // Валидатор Khronos: 0 ошибок или не больше, чем на входе.
    expect(validatorDidNotWorsen(result)).toBe(true);

    // Правило реально применилось и честно отчиталось.
    const q = result.applied.find((a) => a.ruleId === 'geometry/quantize');
    expect(q).toBeDefined();
    expect(q.i18n.text.messageId).toBe('quantize.done');
  });

  it(`${QUANTIZE_CORPUS.length} моделей в инвариантном корпусе`, () => {
    expect(QUANTIZE_CORPUS.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// РАЗДЕЛ 2. Сторож скинов — САМОЕ ВАЖНОЕ (TESTBUG-007).
// ============================================================================
// Без сторожа fns.quantize() расщепляет скин 1 → 14: область квантования «на каждый
// меш» требует своего компенсирующего преобразования, а у скина оно живёт в
// inverseBindMatrices, которые принадлежат скину, а не мешу. Правило обходит это
// через quantizationVolume: 'scene'. Если сторож когда-нибудь снимут — тест обязан
// покраснеть.

describeLocal('parkergirl.glb', 'Квантование — сторож скинов (parkergirl, TESTBUG-007)', () => {
  it('скинов 1 → 1, в applied quantize.done.scene', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);

    // правило честно сказало, что взяло область на всю сцену
    const scene = result.applied.find((a) => a.i18n?.text?.messageId === 'quantize.done.scene');
    expect(scene).toBeDefined();
  });
});

describeIfModels(['RiggedSimple.glb'], 'Квантование — RiggedSimple (1 скин)', () => {
  it('скинов 1 → 1, в applied quantize.done.scene', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);

    const scene = result.applied.find((a) => a.i18n?.text?.messageId === 'quantize.done.scene');
    expect(scene).toBeDefined();
  });
});

// ============================================================================
// РАЗДЕЛ 3. Отказы.
// ============================================================================
// Отказы проверяем на Dirty Cube — репо-модель, где draco не падает (в отличие от
// Production Draco Webp 01, известный fail по треугольникам на драко-кодировщике — не про квантование).

describe('Квантование — отказы', () => {
  it("['safe','draco','quantize'] — воздержалось, в skipped «геометрия уже упакована (draco)»", async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['safe', 'draco', 'quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);

    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('draco');
  });

  // То же, с meshopt. Здесь был TESTBUG-008: meshopt сам кладёт в документ
  // KHR_mesh_quantization, и проверка «уже квантована» срабатывала раньше ветки
  // «уже упакована (codec)» — человеку называли следствие его выбора вместо самого
  // выбора. Закрыт 2026-08-01 перестановкой проверок (см. tests/bugs-found.test.mjs).
  it("['safe','meshopt','quantize'] — воздержалось, в skipped «геометрия уже упакована (meshopt)»", async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['safe', 'meshopt', 'quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);

    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('meshopt');
  });

  it('повторный проход по уже квантованной модели — воздержание, потерь не добавляет', async () => {
    const outDir1 = tmpOutDir();
    const r1 = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir: outDir1,
    });
    expect(r1.status).toBe('ok');
    const pass1Bytes = await accessorBytes(r1.file.dst);

    const outDir2 = tmpOutDir();
    const r2 = await optimizeFile(r1.file.dst, {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir: outDir2,
    });
    expect(r2.status).toBe('ok');

    // воздержание со своей причиной
    expect(r2.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = r2.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.already');

    // второй проход потерь не добавляет: геометрия не изменилась
    expect(await accessorBytes(r2.file.dst)).toBe(pass1Bytes);
  });

  it('Meshopt Compressed Input 01 — KHR_mesh_quantization на входе, воздержание', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.already');
  });

  // Модель без геометрии — status ok, ничего не падает.
  // Примечание: на 2026-08-01 у модели 12 треугольников (в задании она названа
  // «без геометрии» — расхождение описано в отчёте), правило применяется.
  it('Orphan Texture Cube 01 — status ok, ничего не падает', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
  });
});

// ============================================================================
// РАЗДЕЛ 4. Морфы и анимация.
// ============================================================================
// Морфы — самое хрупкое место квантования; потеря морф-таргета или анимации не
// меняет ни треугольники, ни узлы — её ловят morphTargets/animations (GAP-005).

describe('Квантование — морфы и анимация', () => {
  eachModel('quantize: морфы и анимации не изменились, baseline-checkpoint зелёный', ['Morph Cube 01.glb', 'parkergirl.glb'], async (name) => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.morphTargets).toBe(result.metrics.before.morphTargets);
    expect(result.metrics.after.animations).toBe(result.metrics.before.animations);

    // baseline-checkpoint прошёл (строгая сверка структуры после базового прохода)
    const baseline = result.validation.find((v) => v.i18n?.text?.messageId === 'check.baselineMatch');
    expect(baseline).toBeDefined();
    expect(baseline.level).toBe('pass');
  });
});

// ============================================================================
// РАЗДЕЛ 7. Сочетание ['safe','quantize','join'] — join не отменяет квантование.
// ============================================================================
// Вопрос 2026-08-01: не разворачивает ли join квантованную общую геометрию
// обратно в копии и не съедает ли выигрыш квантования.
//
// Механика: join (scene/join, tier basic) идёт в ПЕРВОМ проходе, quantize
// (geometry/quantize, tier advanced) — во ВТОРОМ, после baseline-checkpoint.
// Поэтому join физически не может развернуть «уже квантованную» геометрию:
// он расширяет общие меши в копии ДО квантования, а квантование затем
// применяется к расширенной геометрии. На моделях без общей геометрии join
// ничего не разворачивает и не влияет на итог — замерено 2026-08-01:
// 11 из 12 моделей корпуса дают safe+quantize+join = safe+quantize байт в байт.
//
// Единственное исключение — Instance Grid 01: join разворачивает общую
// геометрию сетки в копии, и относительный выигрыш квантования падает
// (геометрия −100 % → −41 %, файл −79 % → −58 %), но итог всё равно строго
// лучше исходника и лучше одного join. Это не дефект, а цена совмещения двух
// структурных операций; тест ниже сторожит, что сочетание не ломает
// инварианты и не теряет расширение.

describe('Квантование × join — инвариант сочетания на корпусе', () => {
  eachModel('safe+quantize+join: треугольники и скины целы, расширение в required, status ok', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe', 'quantize', 'join'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.skins).toBe(result.metrics.before.skins);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(validatorDidNotWorsen(result)).toBe(true);
  });

  it('Instance Grid 01 — join применён, квантование поверх него живо, итог строго легче исходника', async () => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath('Instance Grid 01.glb'));
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['safe', 'quantize', 'join'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    // join реально развернул общую геометрию — это и есть его работа
    expect(result.applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    // ...но квантование во втором проходе отработало поверх расширенной геометрии
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(true);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    // Итог строго легче исходника: выигрыш съеден частично, но не весь.
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });
});

// ============================================================================
// РАЗДЕЛ 8. Сочетание ['safe','quantize','instance'] и трио с join.
// ============================================================================
// Вопрос 2026-08-01: защищает ли инстансинг общую геометрию от join-разворачивания
// в трио safe+quantize+join+instance?
//
// Механика: scene/instance идёт в первом проходе, scene/join — после него
// (runAfter включает 'scene/instance'), то есть join гарантированно видит уже
// инстансированные узлы. Узел с EXT_mesh_gpu_instancing join не трогает — поэтому
// там, где инстансинг РЕАЛЬНО применился, join воздерживается и выигрыш
// квантования сохраняется байт-в-байт (замерено на Linked Duplicates Grid 01 и
// Unlinked Duplicates 01: трио = safe+quantize+instance).
//
// Instance Grid 01 — исключение иного рода: у модели НЕТ общей геометрии
// (625 отдельных узлов × своя копия меша, ни один меш не имеет ≥2 родителей),
// поэтому scene/instance нечего инстансировать — правило воздерживается. join
// при этом flatten+join схлопывает 625 копий в одну (draw calls 625 → 1), и
// квантование применяется уже к склеенной геометрии: относительный выигрыш падает
// (геометрия −100 % → −41 %, файл −79 % → −58 %), но итог всё равно строго легче
// исходника.
//
// Вывод: инстансинг защищает от join-разворачивания ровно там, где есть что
// защищать (общая геометрия); на модели без общей геометрии он бессилен, и трио
// ведёт себя как пара quantize+join. Это не дефект — это цена flatten+join на
// модели из независимых копий.

describe('Квантование × instance — инвариант сочетания на корпусе', () => {
  eachModel('safe+quantize+join+instance: треугольники и скины целы, расширение в required, итог легче исходника', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath(name));
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe', 'quantize', 'join', 'instance'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.skins).toBe(result.metrics.before.skins);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(validatorDidNotWorsen(result)).toBe(true);
    // трио никогда не раздувает геометрию сверх исходника
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });

  it('Instance Grid 01 — нет общей геометрии: instance воздержался, join применился, итог легче исходника', async () => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath('Instance Grid 01.glb'));
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['safe', 'quantize', 'join', 'instance'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    // инстансировать нечего — ни один меш не имеет ≥2 родителей (625 отдельных копий)
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(false);
    // join схлопнул 625 копий в одну
    expect(result.applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    // квантование отработало поверх склеенной геометрии
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(true);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    // итог строго легче исходника: выигрыш съеден частично, но не весь
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });
});

// ============================================================================
// РАЗДЕЛ 5. Отчёт переживает смену языка.
// ============================================================================
// Смена языка — перерисовка, а не работа: записи applied/skipped пересобираются из
// рецепта (поле i18n) через localizeResult, структура и числа остаются теми же.
// Новые ключи (quantize.done, quantize.done.scene, quantize.skipped.*) обязаны
// рендериться на обоих языках.

describeIfModels(['Instance Grid 01.glb'], 'Квантование — отчёт переживает смену языка (Правило 8)', () => {
  it('localizeResult: тексты меняются, структура и числа те же; новые ключи рендерятся', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBeGreaterThan(0);

    const ru = localizeResult(result, 'ru');
    const en = localizeResult(result, 'en');

    // структура: длины, ruleId, messageId, данные (числа) — не изменились
    expect(ru.applied.length).toBe(result.applied.length);
    expect(ru.applied.map((a) => a.ruleId)).toEqual(result.applied.map((a) => a.ruleId));
    expect(ru.applied.map((a) => a.i18n?.text?.messageId)).toEqual(result.applied.map((a) => a.i18n?.text?.messageId));
    expect(JSON.stringify(ru.applied.map((a) => a.i18n?.text?.data))).toBe(
      JSON.stringify(result.applied.map((a) => a.i18n?.text?.data)),
    );

    // тексты МЕНЯЮТСЯ: ru ≠ en хотя бы на одной записи applied
    expect(ru.applied.some((a, i) => a.text !== en.applied[i].text)).toBe(true);

    // новые ключи квантования рендерятся на обоих языках (строка по ключу)
    for (const id of ['quantize.done', 'quantize.done.scene', 'quantize.skipped.already', 'quantize.skipped.compressed']) {
      const data = id === 'quantize.done' ? { pct: 41 } : id === 'quantize.skipped.compressed' ? { codec: 'draco' } : {};
      expect(render(id, data, 'ru').length).toBeGreaterThan(0);
      expect(render(id, data, 'en').length).toBeGreaterThan(0);
    }
  });
});
