// tests/webp.test.mjs — покрытие правила textures/webp (фича 'webp').
//
// Правило — второй ответ на текстуры, противоположный KTX2 по смыслу:
//   KTX2 остаётся сжатым на видеокарте (VRAM падает, файл нередко растёт),
//   WebP распаковывается в ту же несжатую RGBA (VRAM НЕ меняется, файл меньше).
//
// Политика правила ПЕРЕПИСАНА 2026-08-17 (Правило 12, слова Александра: «галочка есть?
// есть! значит мы всегда меняем. никаких алреди гпу»). Было — список случаев, в которых
// правило воздерживалось. Стало:
//   любая текстура с картинкой → WebP на качестве ЕЁ ИСХОДНИКА (см. ниже про ползунок)
//   image/ktx2                 → сперва распаковка транскодером Basis, потом WebP
//   уже image/webp             → цель достигнута, не трогаем (пока ползунок на 100)
//   mime пустой                → формат определяется по байтам, кодируется
//   результат тяжелее          → ОСТАЁТСЯ; отката больше нет
// Единственный законный отказ — сбой кодировщика (webp.skipped.failed), названный
// по имени текстуры.
//
// ГЛАВНЫЙ ИНВАРИАНТ ТЕПЕРЬ ДРУГОЙ. Прежний («webp не может увеличить суммарный вес
// картинок») держался на молчаливом откате и снят вместе с ним: он превращал замер
// человека во враньё. Новый — «ни одна текстура не осталась в прежнем формате без
// названной причины», а подорожание обязано быть видно знаком цены у самой галочки
// (kind:'cost', feature:'webp').
//
// Вес меряем по самим картинкам (listTextures → getImage().byteLength), а не по файлу:
// файл может подрасти на служебных данных контейнера, когда картинок мало и
// они крошечные (Orphan Texture Cube 01, Dirty Cube 01).
//
// Разделы:
//   1. Модели с PNG-текстурами, на которых правило работает.
//   2. Модели, на которых правило РАНЬШЕ воздерживалось, — теперь работает и на них.
//   3. Взаимодействие с KTX2: оба порядка дают одинаковый предсказуемый результат.
//   3б. Ползунок качества (см. ниже).
//   4. (отдельный файл) tests/report-density.test.mjs — сторож плотности отчёта.
//   5. Отчёт переживает смену языка: localizeResult без пересборки.

import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
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
  it('цель уже достигнута: картинки не тронуты, ОДНА строка в «Что сделано», не в отказах', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('Production Many Materials 01.glb'));
    const result = await optimizeFile(modelPath('Production Many Materials 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    // Правило отработало и сказало о себе — молчания нет.
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);

    // Строка про достигнутую цель — в «Что сделано» (applied), ОДНА на все 11.
    const done = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.alreadyTarget');
    expect(done).toHaveLength(1);
    expect(done[0].i18n.text.data.n).toBe(11);

    // Ни одного отказа: «уже WebP» больше не причина пропуска, а состояние модели.
    expect(result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped'),
    )).toHaveLength(0);

    // Главное: картинки НЕ ТРОНУТЫ. Пережатие своим качеством растило файл на 32 %
    // и портило изображение — замер 2026-08-17: автор сжал на ~q75–q80, наш q90 выше.
    const after = await inspectOutput(result.file.dst);
    expect(after.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(after.imageBytes).toBe(before.imageBytes);
  });
});

// 2b. Draco Compressed Input 01 (репо-модель, 1 текстура WebP) — то же, в единственном числе.
describe('WebP — Draco Compressed Input 01 (1 текстура уже WebP)', () => {
  it('единственная текстура уже в цели, строка в единственном числе', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('Draco Compressed Input 01.glb'));
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);

    const after = await inspectOutput(result.file.dst);
    expect(after.mimes).toEqual(['image/webp']);
    expect(after.imageBytes).toBe(before.imageBytes);

    const done = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.alreadyTarget');
    expect(done).toHaveLength(1);
    expect(done[0].i18n.text.data.n).toBe(1);
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

// 2d. Dirty Cube 01: текстура «Image» с ПУСТЫМ mime. Раньше её пропускали «вслепую не
//     кодируем». Правило 12 такого исхода не допускает: формат определяется по самим
//     байтам (sharp это умеет), и картинка кодируется наравне с остальными.
describe('WebP — Dirty Cube 01 (текстура без объявленного формата)', () => {
  it('незаявленный формат не повод отказать: картинка закодирована, отказов нет', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    // Ни одного молчаливого пропуска: причин «формат не сообщён» и «уже GPU-формат»
    // больше нет в природе, а единственный законный отказ — сбой кодировщика.
    const skips = result.skipped
      .filter((s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped'))
      .map((s) => s.i18n.text.messageId);
    expect(new Set(skips)).toEqual(new Set(skips.length ? ['webp.skipped.failed'] : []));

    // все картинки на выходе — WebP
    const out = await inspectOutput(result.file.dst);
    expect(out.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(out.extensions).toContain('EXT_texture_webp');
  });
});

// 2e. ABeautifulGame: 33 JPEG — 20 карт данных пропущены ОДНОЙ строкой,
//     13 цветных сконвертированы.
describeIfModels(['ABeautifulGame.glb'], 'WebP — ABeautifulGame (33 JPEG)', () => {
  it('все 33 закодированы: 13 цветных + 20 карт данных, каждая группа одной строкой', async () => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath('ABeautifulGame.glb'));
    const result = await optimizeFile(modelPath('ABeautifulGame.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    // 13 цветных — одна строка (Правило 9)
    const doneColor = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.done.color');
    expect(doneColor).toHaveLength(1);
    expect(doneColor[0].i18n.text.data.n).toBe(13);

    // 20 карт данных — ТОЖЕ закодированы, а не пропущены. Раньше здесь стоял отказ
    // «JPEG-карта данных станет тяжелее» — то есть решение за человека (Правило 12).
    // Идут они строкой dataLossy, а не data: источник JPEG, то есть уже сжат с потерями,
    // и кодировать его без потерь значило бы раздуть модель, ничего не вернув.
    const doneData = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.done.dataLossy');
    expect(doneData).toHaveLength(1);
    expect(doneData[0].i18n.text.data.n).toBe(20);
    expect(result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped.jpegData'),
    )).toHaveLength(0);

    // Все картинки — WebP, ни одной не оставлено в прежнем формате.
    const after = await inspectOutput(result.file.dst);
    expect(after.mimes.every((m) => m === 'image/webp')).toBe(true);

    // И главное: модель должна ПОЛЕГЧАТЬ. Замер 2026-08-17 — 40.99 → 34.36 МБ (−16 %).
    // Этот тест — сторож против возврата lossless-кодирования лоссовых исходников:
    // с ним та же модель весила 82 МБ, вдвое больше собственного оригинала.
    expect(after.imageBytes).toBeLessThan(before.imageBytes);

    // видеопамять не меняется: WebP и JPEG доезжают до видеокарты одинаково распакованными
    expect(result.metrics.after.gpuBytes).toBe(result.metrics.before.gpuBytes);
  });
});

// ============================================================================
// РАЗДЕЛ 3. Взаимодействие с KTX2 — оба порядка дают одинаковый результат.
// ============================================================================
// В интерфейсе опции взаимоисключающие, но через API можно передать обе.
// Поведение обязано быть предсказуемым и не зависеть от ПОРЯДКА В МАССИВЕ: очередь
// правил задаётся их runAfter, а не тем, что человек перечислил первым.
//
// Смысл проверки менялся дважды за 2026-08-17 и остановился здесь.
// Было: WebP «уступает» готовому KTX2 — то есть молчаливый отказ (Правило 12 запретил).
// Стало на время: работают оба — но тогда второе правило разбирает работу первого.
// Итог (слово Александра): пара ВЗАИМОИСКЛЮЧАЮЩАЯ и в движке тоже, как в интерфейсе,
// и побеждает ПОСЛЕДНИЙ выбранный — ровно как клик по галочке гасит соседнюю.
// Проигравший не исчезает молча: движок называет его строкой exclusive.
//
// Если toktx/gltf-transform CLI не установлены — ktx2-правило откажется
// (ktx2.noTools), и тест теряет смысл: пропускаем с понятным маркером.
const KTXToolsAvailable = Boolean(TOKTX && HAS_GLTF_CLI);

describeIfModels(['SunglassesKhronos.glb'], 'WebP × KTX2 — взаимоисключение, побеждает последний', () => {
  if (!KTXToolsAvailable) {
    it('оба порядка [skipped: toktx / gltf-transform CLI не установлены]', () => {});
    return;
  }

  it('порядок решает: работает ровно одно правило, второе названо в отчёте', async () => {
    const run = async (feats) => {
      const outDir = tmpOutDir();
      const r = await optimizeFile(modelPath('SunglassesKhronos.glb'), {
        advancedFeatures: feats,
        dryRun: false,
        outDir,
      });
      expect(r.status).toBe('ok');
      return { r, out: await inspectOutput(r.file.dst) };
    };

    const webpLast = await run(['ktx2', 'webp']);
    const ktx2Last = await run(['webp', 'ktx2']);

    // Побеждает последний присланный — и это ВИДНО по формату картинок.
    expect(webpLast.out.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(ktx2Last.out.mimes.every((m) => m === 'image/ktx2')).toBe(true);

    // Ровно одно правило отработало в каждом прогоне, а не оба подряд.
    expect(webpLast.r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);
    expect(webpLast.r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(false);
    expect(ktx2Last.r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    expect(ktx2Last.r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);

    // Отменённый выбор назван вслух — молча он исчезнуть не имеет права.
    for (const { r } of [webpLast, ktx2Last]) {
      expect(r.skipped.some((s) => s.kind === 'exclusive')).toBe(true);
    }
  });
});

// ============================================================================
// РАЗДЕЛ 5. Отчёт переживает смену языка.
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

// ============================================================================
// 3б. Ползунок качества: шкала считается от качества ИСХОДНИКА.
// ============================================================================
// Введено 2026-08-17 по мысли Александра: «если они уже сжаты, мы ведь не можем вернуть
// качество — значит это для нас уже и есть всегда 100 процентное качество». Отсюда
// шкала: 100 — «как в исходнике», ниже — доля от него, выше не бывает.
//
// Три типа исходника ведут себя по-разному, и каждый проверяется отдельно, потому что
// раньше правило обращалось со всеми одинаково (жёсткий q90) и обе беды шли именно
// оттуда: у слабого исходника мы «улучшали» его и платили весом, у сильного — молча
// огрубляли.
describe('WebP — ползунок качества считается от исходника', () => {
  const imageBytes = (doc) => doc.getRoot().listTextures()
    .reduce((s, t) => s + (t.getImage()?.byteLength || 0), 0);

  // Прогон дорогой (ABeautifulGame — 33 текстуры, оценка потолка WebP — по пять
  // кодирований на штуку), а одна и та же пара «модель + положение» нужна нескольким
  // утверждениям. Держим результат, а не гоняем конвейер заново: без этого раздел
  // добавлял к полному набору минуты, ничего нового не проверяя.
  const runs = new Map();
  function runAt(model, share) {
    const key = `${model}|${share}`;
    if (!runs.has(key)) runs.set(key, execute(model, share));
    return runs.get(key);
  }

  async function execute(model, share) {
    const outDir = tmpOutDir('webp-q');
    const result = await optimizeFile(modelPath(model), {
      advancedFeatures: ['webp'], dryRun: false, outDir, locale: 'ru', webpQuality: share,
    });
    expect(result.status).toBe('ok');
    const io = await ioPromise;
    const doc = await io.read(result.file.dst);
    const ids = [...result.applied, ...result.skipped]
      .filter((r) => r.ruleId === 'textures/webp')
      .map((r) => r.i18n?.text?.messageId);
    return { bytes: imageBytes(doc), ids, result };
  }

  /** Вес картинок исходной модели — для сравнения «до/после». */
  async function sourceBytes(model) {
    const io = await ioPromise;
    return imageBytes(await io.read(modelPath(model)));
  }

  it('шкала монотонна: чем ниже ползунок, тем легче картинки', async () => {
    const at100 = await runAt('BoomBox.glb', 100);
    const at70 = await runAt('BoomBox.glb', 70);
    const at40 = await runAt('BoomBox.glb', 40);
    expect(at70.bytes).toBeLessThan(at100.bytes);
    expect(at40.bytes).toBeLessThan(at70.bytes);
  }, 300000);

  it('исходник без потерь (PNG): на 100 кодируем без потерь и всё равно легче исходника', async () => {
    const src = await sourceBytes('BoomBox.glb');
    const { bytes, ids } = await runAt('BoomBox.glb', 100);
    // Ровно тот случай, из-за которого «без потерь» когда-то раздуло модели: там
    // источник был ЛОССОВЫМ. На честном PNG обратное — WebP без потерь просто лучше.
    expect(ids).toContain('webp.done.data');
    expect(bytes).toBeLessThan(src);
  }, 300000);

  it('исходник без потерь, ползунок сдвинут: причина названа выбором человека, а не чужим экспортом', async () => {
    const { ids } = await runAt('BoomBox.glb', 70);
    // Дефект, пойманный замером 2026-08-17: карта данных из честного PNG получала
    // объяснение «пришла уже сжатой с потерями» — неправда про модель человека.
    expect(ids).toContain('webp.done.dataByChoice');
    expect(ids).not.toContain('webp.done.dataLossy');
  }, 300000);

  it('исходник JPEG: качество прочитано из файла точно и прицел в потолок легче жёсткого q90', async () => {
    const src = await sourceBytes('ABeautifulGame.glb');
    const { bytes, result } = await runAt('ABeautifulGame.glb', 100);

    const rec = result.applied.find((a) => a.i18n?.text?.messageId?.startsWith('webp.sourceQuality'));
    expect(rec).toBeTruthy();
    // exact:true — качество взято из маркера DQT, а не угадано пробным кодированием,
    // и слова «примерно» в строке быть не должно: это измерение, а не оценка.
    expect(rec.i18n.text.data.exact).toBe(true);
    expect(rec.text).not.toMatch(/примерно/);
    // У этой модели текстуры сжаты по-разному (77…97) — значит именно размах, а не
    // одно число: одно число здесь было бы полуправдой.
    expect(rec.i18n.text.messageId).toBe('webp.sourceQuality.range');
    expect(rec.i18n.text.data.min).toBeLessThan(rec.i18n.text.data.max);

    // Замер, ради которого всё и делалось: жёсткий q90 давал −41 %, потолок −56 %.
    // Порог с запасом от q90, но не впритык к замеру — иначе тест начнёт падать от
    // смены версии кодировщика, ничего не сообщая по существу.
    expect(bytes).toBeLessThan(src * 0.5);
  }, 600000);

  it('исходник уже WebP: на сотне не трогаем, ниже — жмём по просьбе', async () => {
    const model = 'Production Many Materials 01.glb';
    const src = await sourceBytes(model);

    // На сотне цель — «быть WebP», и модель ей уже отвечает: работы нет. Пережимать
    // было бы чистым проигрышем (+6 % даже прицелом ровно в потолок исходника).
    const at100 = await runAt(model, 100);
    expect(at100.ids).toContain('webp.alreadyTarget');
    expect(at100.bytes).toBe(src);

    // Сдвинули — человек попросил ЛЕГЧЕ, и та же текстура цели больше не отвечает.
    // Запрет на это существовал недолго и был снят по прямым словам Александра:
    // «WebP-модель не меняется вовсе — не должно быть такого».
    const at40 = await runAt(model, 40);
    expect(at40.ids).not.toContain('webp.alreadyTarget');
    expect(at40.bytes).toBeLessThan(src);
  }, 900000);

  it('умолчание — сотня: без просьбы человека качество не понижается', async () => {
    // Кратко умолчанием было 90 ради прежней лёгкости; Александр посмотрел результат
    // глазами и вернул сотню. Цифры говорили одно, глаз другое — здесь прав глаз.
    const io = await ioPromise;
    const outDir = tmpOutDir('webp-q-default');
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      advancedFeatures: ['webp'], dryRun: false, outDir, locale: 'ru', // webpQuality НЕ передаём
    });
    expect(result.status).toBe('ok');
    const bytes = imageBytes(await io.read(result.file.dst));
    const at100 = await runAt('BoomBox.glb', 100);
    expect(bytes).toBe(at100.bytes);
  }, 600000);

  it('мусор в значении не роняет сборку и откатывается к умолчанию', async () => {
    // Значение приходит и от чужого вызова по API, а не только с ползунка.
    // Отдельно про null: `Number(null)` это 0, а не NaN, — без явной отсечки
    // «не задавали» молча означало бы «сжать до предела». Дефект пойман этим тестом.
    const io = await ioPromise;
    const at100 = await runAt('BoomBox.glb', 100);
    for (const bad of ['abc', null, 900]) {
      const outDir = tmpOutDir('webp-q-bad');
      const result = await optimizeFile(modelPath('BoomBox.glb'), {
        advancedFeatures: ['webp'], dryRun: false, outDir, locale: 'ru', webpQuality: bad,
      });
      expect(result.status).toBe('ok');
      const bytes = imageBytes(await io.read(result.file.dst));
      expect(bytes, `значение ${JSON.stringify(bad)}`).toBe(at100.bytes);
    }
  }, 900000);
});

afterAll(cleanupTmpOutDirs);
