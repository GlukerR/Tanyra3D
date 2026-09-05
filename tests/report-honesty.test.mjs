import { describe, it, expect } from 'vitest';
import { RULES } from '../addons/gltf/rules.mjs';
import { render, localizeResult } from '../core/i18n.mjs';
import { optimizeFile } from '../optimize2.mjs';
import os from 'node:os';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath } from './helpers/model-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ioPromise = gltfAddon.createIO();
const ruleById = (id) => RULES.find((r) => r.meta.id === id);

const ctxFor = (document, opts = {}) => ({
  document,
  opts: { locale: 'ru', texMode: 'mixed', ...opts },
  log: () => {},
  dstName: 'honesty-probe.glb',
});

async function docWithMimes(model, mimes) {
  const io = await ioPromise;
  const doc = await io.read(modelPath(model));
  const texs = doc.getRoot().listTextures();
  texs.forEach((t, i) => {
    const mime = typeof mimes === 'string' ? mimes : mimes[i];
    if (mime) t.setMimeType(mime);
  });
  return doc;
}

describe('Честность отчёта — один класс случаев даёт одну строку', () => {
  it('textures/ktx2: пять уже-KTX2 текстур → ОДНА строка .many со счётом, а не пять', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', 'image/ktx2');
    const n = doc.getRoot().listTextures().length;
    expect(n).toBeGreaterThan(1);

    const out = await ruleById('textures/ktx2').fix({}, ctxFor(doc));
    const already = (out.skipped || []).filter((s) => s.messageId.startsWith('ktx2.skipped.already'));

    expect(already).toHaveLength(1);
    expect(already[0].messageId).toBe('ktx2.skipped.already.many');
    expect(already[0].data.n).toBe(n);
  });

  it('textures/ktx2: одна уже-KTX2 текстура → строка в единственном числе, с именем', async () => {
    const io = await ioPromise;
    const doc = await io.read(modelPath('Dirty Cube 01.glb'));
    const texs = doc.getRoot().listTextures();
    texs[0].setMimeType('image/ktx2');
    texs.slice(1).forEach((t) => t.dispose());

    const out = await ruleById('textures/ktx2').fix({}, ctxFor(doc));
    const already = (out.skipped || []).filter((s) => s.messageId.startsWith('ktx2.skipped.already'));

    expect(already).toHaveLength(1);
    expect(already[0].messageId).toBe('ktx2.skipped.already');
    expect(already[0].data.name).toBeTruthy();
  });
});

describe('Честность отчёта — причина пропуска называет настоящую причину', () => {
  it('textures/webp: ни один формат не даёт молчаливого отказа', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', ['image/ktx2', 'image/avif']);
    const out = await ruleById('textures/webp').fix({}, ctxFor(doc));

    const ids = (out.skipped || []).map((s) => s.messageId).filter((id) => id.startsWith('webp.skipped'));
    expect(new Set(ids)).toEqual(new Set(ids.length ? ['webp.skipped.failed'] : []));

    for (const rec of (out.skipped || []).filter((s) => s.messageId === 'webp.skipped.failed')) {
      expect(rec.data.name).toBeTruthy();
      expect(rec.data.reason).toBeTruthy();
    }
  });

  it('textures/webp: строка про распаковку из GPU-формата НЕ обещает выигрыша, а называет цену', () => {
    for (const locale of ['ru', 'en']) {
      const text = render('webp.done.fromGpu', { n: 3 }, locale).toLowerCase();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/видеопамят|video memory/);
      expect(text).toMatch(/вырастет|will grow/);
      expect(text).not.toMatch(/меньше видеопамят|экономи|less video memory|saves/);
    }
  });

  it('scene/join: ложной строки «размножило общую геометрию» в движке больше нет (TESTBUG-009)', () => {
    for (const locale of ['ru', 'en']) {
      expect(() => render('join.expandedShared', { bytes: 1, pct: 1, dcSaved: 0 }, locale)).toThrow(/join\.expandedShared/);
    }
  });
});

describe('Честность отчёта — согласование числа в русском каталоге', () => {
  const COUNTED_KEYS = ['webp.found', 'webp.done.fromGpu', 'webp.alreadyTarget', 'ktx2.found'];

  for (const id of COUNTED_KEYS) {
    it(`${id}: при n = 1 нет ни «1 текстур», ни множественных местоимений`, () => {
      const one = render(id, { n: 1 }, 'ru');
      const many = render(id, { n: 5 }, 'ru');

      expect(one).not.toBe(id);
      expect(one).not.toBe(many);
      expect(one).not.toMatch(/\b1 текстур\b|\b1 карт\b/);
      expect(one).not.toMatch(/\bони\b|\bна них\b|\bих\b/);
      expect(many).toContain('5');
    });
  }
});

describe('Честность отчёта — правило с группой галочек тоже отчитывается', () => {
  it('у каждого правила есть чем назваться: feature либо featureGroup', () => {
    for (const rule of RULES) {
      const m = rule.meta;
      if (typeof m.enabled !== 'function') continue;
      const ownSwitch = !m.enabled({}) && !m.enabled({ safe: true });
      if (!ownSwitch) continue;
      expect(
        m.feature || m.featureGroup,
        `${m.id} включается галочкой, но не объявил ни feature, ни featureGroup — движок о нём промолчит`,
      ).toBeTruthy();
    }
  });

  it('движок спрашивает про обе формы выключателя, а не только про feature', () => {
    const src = fs.readFileSync(path.join(ROOT, 'core', 'engine.mjs'), 'utf8');
    const guard = src.match(/if \(!saidSomething && \(?([^)]*)\)?\) \{/);
    expect(guard, 'не нашёл сторож «ничего не сделано» — якорь сменился').toBeTruthy();
    expect(guard[1], 'движок снова смотрит только на feature').toContain('featureGroup');
  });
});

describe('Честность отчёта — причина отказа настоящая и переводимая', () => {
  function pointCloudPly(dir) {
    const file = path.join(dir, 'cloud.ply');
    fs.writeFileSync(file, [
      'ply', 'format ascii 1.0', 'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'end_header', '0 0 0', '1 0 0', '0 1 0', '',
    ].join('\n'));
    return file;
  }

  it('прогон, который не состоялся, несёт рецепт своей причины', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-reason-'));
    try {
      const src = pointCloudPly(dir);
      const result = await optimizeFile(src, { outDir: dir, force: true, locale: 'en' });

      expect(result.status, 'облако точек прошло как годная модель').toBe('fail');
      expect(result.file.written, 'файла быть не должно').toBe(false);
      expect(result.error, 'движок не сказал, почему отказался').toBeTruthy();
      expect(result.validation, 'проверки не проводилось, а записи о ней есть').toEqual([]);

      const ref = result.i18n && result.i18n.error;
      expect(ref && ref.messageId, 'у причины отказа нет рецепта — перевести её будет нечем').toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

it('исчезнувшая папка результата объясняется словами, а не путём из UUID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outdir-gone-'));
    try {
      const src = path.join(dir, 'tiny.ply');
      fs.writeFileSync(src, [
        'ply', 'format ascii 1.0', 'element vertex 3',
        'property float x', 'property float y', 'property float z',
        'element face 1', 'property list uchar int vertex_index',
        'end_header', '0 0 0', '1 0 0', '0 1 0', '3 0 1 2', '',
      ].join('\n'));

      const outDir = path.join(dir, 'out');
      const result = await optimizeFile(src, {
        outDir,
        force: true,
        locale: 'ru',
        onProgress: (e) => {
          if (e && e.phase === 5) fs.rmSync(outDir, { recursive: true, force: true });
        },
      });

      expect(result.status, 'запись в исчезнувшую папку прошла — тест ничего не проверил').toBe('fail');
      expect(result.file.written, 'файла нет, а движок говорит, что записал').toBe(false);
      expect(result.error, 'причина не названа').toBeTruthy();
      expect(result.error, 'наружу ушло сообщение библиотеки вместо человеческой причины')
        .not.toMatch(/ENOENT|no such file/i);
      const ref = result.i18n && result.i18n.error;
      expect(ref && ref.messageId, 'у причины нет рецепта — перевести её будет нечем').toBe('engine.outDirGone');
      expect(/[А-Яа-я]/.test(result.error), `причина не на языке прогона: ${result.error}`).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('по рецепту причина собирается на другом языке без пересборки модели', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-reason-ru-'));
    try {
      const src = pointCloudPly(dir);
      const result = await optimizeFile(src, { outDir: dir, force: true, locale: 'en' });
      const ru = localizeResult(result, 'ru');

      expect(ru.error, 'причина не переведена — осталась строка языка сборки').not.toBe(result.error);
      expect(/[А-Яа-я]/.test(ru.error), `перевод не похож на русский: ${ru.error}`).toBe(true);
      expect(result.error, 'исходный результат изменён — функция не чистая').toBe(
        render(result.i18n.error.messageId, result.i18n.error.data, 'en'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
