import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, eachModel, describeIfModels, itIfModel } from './helpers/model-files.mjs';

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



const WEBP_PNG_MODELS = [
  'BoomBox.glb',
  'IridescentDishWithOlives.glb',
  'ToyCar.glb',
  'chibi_zenitsu.glb',
];

describe('WebP — PNG-модели: конверсия работает', () => {
  eachModel('webp: картинки легче, mime=webp, EXT_texture_webp, VRAM и треугольники не изменились', WEBP_PNG_MODELS, async (name) => {
    const outDir = tmpOutDir();
    const before = await inspectOutput(modelPath(name));
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);

    const after = await inspectOutput(result.file.dst);

    expect(after.imageBytes).toBeLessThan(before.imageBytes);

    for (const m of after.mimes) expect(m).toBe('image/webp');

    expect(after.extensions).toContain('EXT_texture_webp');

    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);

    expect(result.metrics.after.gpuBytes).toBe(result.metrics.before.gpuBytes);
  });
});


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
    expect(result.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);

    const done = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.alreadyTarget');
    expect(done).toHaveLength(1);
    expect(done[0].i18n.text.data.n).toBe(11);

    expect(result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped'),
    )).toHaveLength(0);

    const after = await inspectOutput(result.file.dst);
    expect(after.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(after.imageBytes).toBe(before.imageBytes);
  });
});

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

describe('WebP — Dirty Cube 01 (текстура без объявленного формата)', () => {
  it('незаявленный формат не повод отказать: картинка закодирована, отказов нет', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['webp'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    const skips = result.skipped
      .filter((s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped'))
      .map((s) => s.i18n.text.messageId);
    expect(new Set(skips)).toEqual(new Set(skips.length ? ['webp.skipped.failed'] : []));

    const out = await inspectOutput(result.file.dst);
    expect(out.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(out.extensions).toContain('EXT_texture_webp');
  });
});

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

    const doneColor = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.done.color');
    expect(doneColor).toHaveLength(1);
    expect(doneColor[0].i18n.text.data.n).toBe(13);

    const doneData = result.applied.filter((a) => a.i18n?.text?.messageId === 'webp.done.dataLossy');
    expect(doneData).toHaveLength(1);
    expect(doneData[0].i18n.text.data.n).toBe(20);
    expect(result.skipped.filter(
      (s) => (s.i18n?.text?.messageId || '').startsWith('webp.skipped.jpegData'),
    )).toHaveLength(0);

    const after = await inspectOutput(result.file.dst);
    expect(after.mimes.every((m) => m === 'image/webp')).toBe(true);

    expect(after.imageBytes).toBeLessThan(before.imageBytes);

    expect(result.metrics.after.gpuBytes).toBe(result.metrics.before.gpuBytes);
  });
});

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

    expect(webpLast.out.mimes.every((m) => m === 'image/webp')).toBe(true);
    expect(ktx2Last.out.mimes.every((m) => m === 'image/ktx2')).toBe(true);

    expect(webpLast.r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(true);
    expect(webpLast.r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(false);
    expect(ktx2Last.r.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    expect(ktx2Last.r.applied.some((a) => a.ruleId === 'textures/webp')).toBe(false);

    for (const { r } of [webpLast, ktx2Last]) {
      expect(r.skipped.some((s) => s.kind === 'exclusive')).toBe(true);
    }
  });
});


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

    expect(ru.applied.some((a, i) => a.text !== en.applied[i].text)).toBe(true);
    expect(ru.skipped.some((s, i) => s.text !== en.skipped[i].text)).toBe(true);
  });
});

describe('WebP — ползунок качества считается от исходника', () => {
  const imageBytes = (doc) => doc.getRoot().listTextures()
    .reduce((s, t) => s + (t.getImage()?.byteLength || 0), 0);

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

  async function sourceBytes(model) {
    const io = await ioPromise;
    return imageBytes(await io.read(modelPath(model)));
  }

  itIfModel('BoomBox.glb', 'шкала монотонна: чем ниже ползунок, тем легче картинки', async () => {
    const at100 = await runAt('BoomBox.glb', 100);
    const at70 = await runAt('BoomBox.glb', 70);
    const at40 = await runAt('BoomBox.glb', 40);
    expect(at70.bytes).toBeLessThan(at100.bytes);
    expect(at40.bytes).toBeLessThan(at70.bytes);
  }, 300000);

  itIfModel('BoomBox.glb', 'исходник без потерь (PNG): на 100 кодируем без потерь и всё равно легче исходника', async () => {
    const src = await sourceBytes('BoomBox.glb');
    const { bytes, ids } = await runAt('BoomBox.glb', 100);
    expect(ids).toContain('webp.done.data');
    expect(bytes).toBeLessThan(src);
  }, 300000);

  itIfModel('BoomBox.glb', 'исходник без потерь, ползунок сдвинут: причина названа выбором человека, а не чужим экспортом', async () => {
    const { ids } = await runAt('BoomBox.glb', 70);
    expect(ids).toContain('webp.done.dataByChoice');
    expect(ids).not.toContain('webp.done.dataLossy');
  }, 300000);

  itIfModel('ABeautifulGame.glb', 'исходник JPEG: качество читается из файла и названо ПРИМЕРНЫМ, прицел в потолок легче q90', async () => {
    const src = await sourceBytes('ABeautifulGame.glb');
    const { bytes, result } = await runAt('ABeautifulGame.glb', 100);

    const rec = result.applied.find((a) => a.i18n?.text?.messageId?.startsWith('webp.sourceQuality'));
    expect(rec).toBeTruthy();
    expect(rec.text).toMatch(/примерно/);
    expect(rec.i18n.text.data.exact, 'флаг exact снят вместе с обещанием точности').toBeUndefined();
    expect(rec.i18n.text.messageId).toBe('webp.sourceQuality.range');
    expect(rec.i18n.text.data.min).toBeLessThan(rec.i18n.text.data.max);

    expect(bytes).toBeLessThan(src * 0.5);
  }, 600000);

  itIfModel('Production Many Materials 01.glb', 'исходник уже WebP: на сотне не трогаем, ниже — жмём по просьбе', async () => {
    const model = 'Production Many Materials 01.glb';
    const src = await sourceBytes(model);

    const at100 = await runAt(model, 100);
    expect(at100.ids).toContain('webp.alreadyTarget');
    expect(at100.bytes).toBe(src);

    const at40 = await runAt(model, 40);
    expect(at40.ids).not.toContain('webp.alreadyTarget');
    expect(at40.bytes).toBeLessThan(src);
  }, 900000);

  itIfModel('BoomBox.glb', 'умолчание — сотня: без просьбы человека качество не понижается', async () => {
    const io = await ioPromise;
    const outDir = tmpOutDir('webp-q-default');
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      advancedFeatures: ['webp'], dryRun: false, outDir, locale: 'ru',
    });
    expect(result.status).toBe('ok');
    const bytes = imageBytes(await io.read(result.file.dst));
    const at100 = await runAt('BoomBox.glb', 100);
    expect(bytes).toBe(at100.bytes);
  }, 600000);

  itIfModel('BoomBox.glb', 'мусор в значении не роняет сборку и откатывается к умолчанию', async () => {
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

describe('textures/webp — знак цены не загорается на ровном месте', () => {
  const rule = RULES.find((r) => r.meta.id === 'textures/webp');

  itIfModel('BoomBox.glb', 'модель ужалась — цены нет', async () => {
    const io = await ioPromise;
    const doc = await io.read(modelPath('BoomBox.glb'));
    let before = 0;
    for (const t of doc.getRoot().listTextures()) before += t.getImage()?.byteLength || 0;

    const out = await rule.fix({}, {
      document: doc, opts: { locale: 'ru' }, log: () => {}, dstName: 'webp-nocost.glb',
    });

    let after = 0;
    for (const t of doc.getRoot().listTextures()) after += t.getImage()?.byteLength || 0;
    expect(after, 'предпосылка теста: модель должна ужаться').toBeLessThan(before);
    expect(out.cost, 'ужалась — знака цены быть не должно').toBeFalsy();
  }, 600000);

  it('знак цены не встаёт на росте, которого не видно в напечатанных числах', async () => {
    const io = await ioPromise;
    const doc = await io.read(modelPath('Dirty Cube 01.glb'));
    const out = await rule.fix({}, {
      document: doc, opts: { locale: 'ru' }, log: () => {}, dstName: 'webp-cost-honest.glb',
    });
    for (const c of out.cost || []) {
      const d = c.data || {};
      const before = d.beforeKb ?? d.beforeMb;
      const after = d.afterKb ?? d.afterMb;
      expect(d.pct, `${c.messageId}: заявлен рост, а процент ${d.pct}`).toBeGreaterThan(0);
      expect(after, `${c.messageId}: заявлен рост, а числа ${before} → ${after}`)
        .toBeGreaterThan(before);
    }
  }, 600000);
});

afterAll(cleanupTmpOutDirs);
