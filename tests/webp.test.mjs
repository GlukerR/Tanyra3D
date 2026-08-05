// tests/webp.test.mjs — покрытие правила textures/webp (фича 'webp').
//
// Правило — второй ответ на текстуры, противоположный KTX2 по смыслу:
//   KTX2 остаётся сжатым на видеокарте (VRAM падает, файл нередко растёт),
//   WebP распаковывается в ту же несжатую RGBA (VRAM НЕ меняется, файл меньше).
//
// Политика правила (задание 2026-08-01-webp-корпус):
//   PNG/JPEG цветная        → WebP quality 90
//   PNG карта данных        → WebP lossless
//   JPEG карта данных       → не трогаем вовсе
//   уже image/webp          → не трогаем
//   image/ktx2 и прочее     → не трогаем (уже формат для видеокарты)
//   mime пустой             → не трогаем (формат не сообщён)
//   результат НЕ легче      → откат к исходной картинке
//
// ГЛАВНЫЙ ИНВАРИАНТ: «webp не может увеличить суммарный вес картинок».
// Каждая текстура либо стала легче, либо вернулась к исходнику. Вес меряем
// по самим картинкам (listTextures → getImage().byteLength), а не по файлу:
// файл может подрасти на служебных данных контейнера, когда картинок мало и
// они крошечные (Orphan Texture Cube 01, Dirty Cube 01).
//
// Разделы:
//   1. Модели с PNG-текстурами, на которых правило работает.
//   2. Модели, на которых правило обязано воздержаться.
//   3. Взаимодействие с KTX2: оба порядка дают одинаковый предсказуемый результат.
//   4. (отдельный файл) tests/report-density.test.mjs — сторож плотности отчёта.
//   5. Отчёт переживает смену языка (Правило 8): localizeResult без пересборки.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { TOKTX, GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, eachModel, describeIfModels } from './helpers/model-files.mjs';

// ---- инструменты: чтение выходного .glb для контроля картинок ----
// optimizeFile отдаёт метрики (gpuBytes/textureBytes и т.д.), но инвариант
// задания просят мерить ПО КАРТИНКАМ (getImage().byteLength), а не по метрике
// textureBytes. Читаем записанный файл тем же io, которым пишет аддон.
const ioPromise = gltfAddon.createIO();

async function inspectOutput(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  let imageBytes = 0;
  const mimes = [];
  for (const t of doc.getRoot().listTextures()) {
    imageBytes += t.getImage()?.byteLength || 0;
    mimes.push(t.getMimeType() || '');
  }
  const extensions = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  return { imageBytes, mimes, extensions };
}

function tmpOutDir(prefix = 'webp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// РАЗДЕЛ 1. Модели с PNG-текстурами — правило работает.
// ============================================================================
// BoomBox, IridescentDishWithOlives, ToyCar, chibi_zenitsu — локальные модели.
// eachModel сам пропустит отсутствующую на диске модель (см. helpers).

const WEBP_PNG_MODELS = [
  'BoomBox.glb',
  'IridescentDishWithOlives.glb',
  'ToyCar.glb',
  'chibi_zenitsu.glb',
];

describe('WebP — PNG-модели: конверсия работает', () => {
  eachModel('webp: картинки легче, mime=webp, EXT_texture_webp, VRAM и треугольники не изменились', WEBP_PNG_MODELS, async (name) => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath(name)); // читаем ИСХОДНИК тем же io
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);

    const after = await inspectOutput(result.file.dst);

    // инвариант: суммарный вес картинок СТРОГО меньше (хотя бы одна полегчала)
    expect(after.imageBytes).toBeLessThan(before.imageBytes);

    // у всех сконвертированных текстур mime — image/webp (все картинки PNG, все конвертируются)
    for (const m of after.mimes) expect(m).toBe('image/webp');

    // в выходном файле объявлено EXT_texture_webp
    expect(after.extensions).toContain('EXT_texture_webp');

    // треугольники не изменились
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);

    // ВИДЕОПАМЯТЬ WebP не трогает вообще — ключевое отличие от KTX2
    expect(result.metrics.after.gpuBytes).toBe(result.metrics.before.gpuBytes);
  });
});

// ============================================================================
// РАЗДЕЛ 2. Модели, на которых правило обязано воздержаться.
// ============================================================================

// 2a. Production Many Materials 01: 11 текстур, ВСЕ уже WebP — ни одной конверсии, одна строка skipped.
describeIfModels(['Production Many Materials 01.glb'], 'WebP — Production Many Materials 01 (11 текстур уже WebP)', () => {
  it('ни одной конверсии, вес картинок не изменился, в skipped ОДНА строка про «уже WebP»', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('Production Many Materials 01.glb'));
    const result = await optimizeFile(modelPath('Production Many Materials 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    // вес картинок не изменился
    expect((await inspectOutput(result.file.dst)).imageBytes).toBe(before.imageBytes);
    // ни одной конверсии
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);

    // ровно одна строка про «уже WebP» — НЕ одиннадцать (Правило 9)
    const already = result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped.already'),
    );
    expect(already).toHaveLength(1);
    expect(already[0].i18n.text.messageId).toBe('webp.skipped.already.many');
    expect(already[0].i18n.text.data.n).toBe(11);
  });
});

// 2b. Draco Compressed Input 01 (репо-модель, 1 текстура WebP) — то же, в единственном числе.
describe('WebP — Draco Compressed Input 01 (1 текстура уже WebP)', () => {
  it('ни одной конверсии, вес картинок не изменился, строка в единственном числе', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('Draco Compressed Input 01.glb'));
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect((await inspectOutput(result.file.dst)).imageBytes).toBe(before.imageBytes);
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);

    const already = result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped.already'),
    );
    expect(already).toHaveLength(1);
    expect(already[0].i18n.text.messageId).toBe('webp.skipped.already');
  });
});

// 2c. Модели БЕЗ текстур: статус ok, правило молчит, ничего не падает.
describe('WebP — модели без текстур: правило молчит', () => {
  const NO_TEXTURE_MODELS = ['Linked Duplicates Grid 01.glb', 'Morph Cube 01.glb'];
  for (const m of NO_TEXTURE_MODELS) {
    it(`${m}: status ok, ни одного webp-применения/пропуска`, async () => {
      const outDir = tmpOutDir();
      const result = await optimizeFile(modelPath(m), {
        advancedFeatures: ['webp'],
        dryRun: false,
        outDir,
      });
      expect(result.status).toBe('ok');
      expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);
      expect(result.skipped.filter((s) => (s.i18n?.text?.messageId || '').startsWith('webp.'))).toHaveLength(0);
      expect(result.findings.filter((f) => (f.i18n?.text?.messageId || '').startsWith('webp.'))).toHaveLength(0);
    });
  }
});

// 2d. Dirty Cube 01: текстура «Image» с ПУСТЫМ mime — пропущена со своей причиной
//     («формат не сообщён»), а не с «это уже формат для видеокарты».
describe('WebP — Dirty Cube 01 (текстура без mime)', () => {
  it('пустой mime пропущен своей причиной, а не «уже формат для видеокарты»', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    // своя причина для пустого mime
    const noMime = result.skipped.filter((s) => s.i18n?.text?.messageId === 'webp.skipped.noMime');
    expect(noMime).toHaveLength(1);
    expect(noMime[0].i18n.text.data.name).toBe('Image');

    // и НЕ «уже формат для видеокарты» (эта причина — только для image/ktx2 и т.п.)
    expect(result.skipped.filter((s) => s.i18n?.text?.messageId === 'webp.skipped.format')).toHaveLength(0);
  });
});

// 2e. ABeautifulGame: 33 JPEG — 20 карт данных пропущены ОДНОЙ строкой,
//     13 цветных сконвертированы.
describeIfModels(['ABeautifulGame.glb'], 'WebP — ABeautifulGame (33 JPEG)', () => {
  it('20 карт данных пропущены одной строкой, 13 цветных сконвертированы, картинки легче', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('ABeautifulGame.glb'));
    const result = await optimizeFile(modelPath('ABeautifulGame.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    // 20 карт данных — ОДНА строка, а не двадцать (Правило 9)
    const jpegData = result.skipped.filter((s) => s.i18n?.text?.messageId === 'webp.skipped.jpegData.many');
    expect(jpegData).toHaveLength(1);
    expect(jpegData[0].i18n.text.data.n).toBe(20);

    // 13 цветных сконвертированы
    const doneColor = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.done.color');
    expect(doneColor).toHaveLength(1);
    expect(doneColor[0].i18n.text.data.n).toBe(13);

    // картинки в сумме легче
    expect((await inspectOutput(result.file.dst)).imageBytes).toBeLessThan(before.imageBytes);

    // видеопамять не меняется
    expect(result.metrics.after.gpuBytes).toBe(result.metrics.before.gpuBytes);
  });
});

// ============================================================================
// РАЗДЕЛ 3. Взаимодействие с KTX2 — оба порядка дают одинаковый результат.
// ============================================================================
// В интерфейсе опции взаимоисключающие, но через API можно передать обе.
// Поведение обязано быть предсказуемым и не зависеть от порядка: KTX2
// применяется, WebP видит image/ktx2 и корректно уступает («уже формат для
// видеокарты»). Проверено вручную 2026-08-01 на SunglassesKhronos; закрепляем.
//
// Если toktx/gltf-transform CLI не установлены — ktx2-правило откажется
// (ktx2.noTools), и тест теряет смысл: пропускаем с понятным маркером.
const KTXToolsAvailable = Boolean(TOKTX && GLTF_CLI);

describeIfModels(['SunglassesKhronos.glb'], 'WebP × KTX2 — предсказуемость при обеих опциях', () => {
  if (!KTXToolsAvailable) {
    it('обои порядка [skipped: toktx / gltf-transform CLI не установлены]', () => {});
    return;
  }

  it('оба порядка: одинаковый размер файла, KTX2 применён, WebP уступил «уже GPU-формат»', async () => {
    const run = async (feats) => {
      const outDir = tmpOutDir();
      const r = await optimizeFile(modelPath('SunglassesKhronos.glb'), {
        advancedFeatures: feats,
        dryRun: false,
        outDir,
      });
      expect(r.status).toBe('ok');
      return r;
    };

    const ktx2First = await run(['ktx2', 'webp']);
    const webpFirst = await run(['webp', 'ktx2']);

    // одинаковый размер файла — поведение не зависит от порядка
    expect(ktx2First.metrics.after.fileBytes).toBe(webpFirst.metrics.after.fileBytes);

    // в applied — строка KTX2 (в обоих порядках)
    expect(ktx2First.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    expect(webpFirst.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);

    // в skipped — строка WebP про уже-GPU-формат (в обоих порядках)
    for (const r of [ktx2First, webpFirst]) {
      const gpu = r.skipped.filter((s) => s.i18n?.text?.messageId === 'webp.skipped.format');
      expect(gpu).toHaveLength(1);
      expect(gpu[0].i18n.text.data.mime).toBe('ktx2');
    }
  });
});

// ============================================================================
// РАЗДЕЛ 5. Отчёт переживает смену языка (Правило 8).
// ============================================================================
// Смена языка — перерисовка, а не работа: записи applied/skipped пересобираются
// из рецепта (поле i18n) через localizeResult, структура и числа остаются теми же.
// Образец — tests/russian-locale.test.mjs; здесь фокус на модели С КОНВЕРСИЕЙ.

describeIfModels(['ToyCar.glb'], 'WebP — отчёт переживает смену языка (Правило 8)', () => {
  it('localizeResult меняет тексты applied/skipped, структура и числа те же', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('ToyCar.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBeGreaterThan(0);

    const ru = localizeResult(result, 'ru');
    const en = localizeResult(result, 'en');

    // структура: длины, ruleId, messageId, данные (числа) — не изменились
    expect(ru.applied.length).toBe(result.applied.length);
    expect(ru.skipped.length).toBe(result.skipped.length);
    expect(ru.applied.map((a) => a.ruleId)).toEqual(result.applied.map((a) => a.ruleId));
    expect(ru.skipped.map((s) => s.ruleId)).toEqual(result.skipped.map((s) => s.ruleId));
    expect(ru.applied.map((a) => a.i18n?.text?.messageId)).toEqual(result.applied.map((a) => a.i18n?.text?.messageId));
    expect(JSON.stringify(ru.applied.map((a) => a.i18n?.text?.data))).toBe(
      JSON.stringify(result.applied.map((a) => a.i18n?.text?.data)),
    );
    expect(JSON.stringify(ru.skipped.map((s) => s.i18n?.text?.data))).toBe(
      JSON.stringify(result.skipped.map((s) => s.i18n?.text?.data)),
    );

    // тексты МЕНЯЮТСЯ: ru ≠ en хотя бы на одной записи каждого списка
    expect(ru.applied.some((a, i) => a.text !== en.applied[i].text)).toBe(true);
    expect(ru.skipped.some((s, i) => s.text !== en.skipped[i].text)).toBe(true);
  });
});
