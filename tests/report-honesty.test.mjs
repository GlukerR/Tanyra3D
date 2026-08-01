// tests/report-honesty.test.mjs — сторожа честности отчёта.
//
// Плотность отчёта («не толпой одинаковых строк») сторожит соседний файл
// tests/report-density.test.mjs. Здесь — три других свойства той же честности,
// каждое закрывает найденный дефект:
//
//   1. Один класс случаев — одна строка (Правило 9). GAP-006: `textures/ktx2`
//      писал «уже KTX2» на каждую текстуру.
//   2. Причина пропуска — настоящая. GAP-007: `textures/webp` объяснял пропуск
//      любого незнакомого формата словами «это уже формат для видеокарты»,
//      что верно для KTX2 и ложно для AVIF.
//   3. Число — часть языка (Правило 8). BUG-008: русские строки при n = 1 давали
//      «1 текстур» и рассинхрон местоимений («они», «на них» про одну штуку).
//
// Проверки идут ЧЕРЕЗ ПРАВИЛО, а не через каталог: каталог можно поправить, а
// правило продолжит пушить не тот ключ. mime текстур переписывается в памяти —
// так корпусу не нужны модели в экзотических форматах ради одного утверждения.
//
// Формат-независимость: тесты не знают ни про three.js, ни про профиль площадки.
// Они проверяют контракт отчёта (какие записи выдаёт правило и как они звучат),
// а он общий для всех будущих движков и платформ.

import { describe, it, expect } from 'vitest';
import { RULES } from '../addons/gltf/rules.mjs';
import { render } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath } from './helpers/model-files.mjs';

const ioPromise = gltfAddon.createIO();
const ruleById = (id) => RULES.find((r) => r.meta.id === id);

// Минимальный ctx: правилам нужны document, opts и log. Ни outDir, ни внешние
// инструменты в проверяемых ветках не задействованы — все они выходят раньше.
const ctxFor = (document, opts = {}) => ({
  document,
  opts: { locale: 'ru', texMode: 'mixed', ...opts },
  log: () => {},
  dstName: 'honesty-probe.glb',
});

/** Модель корпуса с текстурами, у которых mime переписан на заданный. */
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

const ids = (recs) => (recs || []).map((r) => r.messageId);

// ============================================================================
// 1. Один класс случаев — одна строка (Правило 9, GAP-006).
// ============================================================================
describe('Честность отчёта — один класс случаев даёт одну строку', () => {
  it('textures/ktx2: пять уже-KTX2 текстур → ОДНА строка .many со счётом, а не пять', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', 'image/ktx2');
    const n = doc.getRoot().listTextures().length;
    expect(n).toBeGreaterThan(1); // иначе тест ничего не проверяет

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
    // Только первая — KTX2; остальные убираем из документа, чтобы правило не
    // ушло в кодирование (toktx на CI может отсутствовать).
    texs[0].setMimeType('image/ktx2');
    texs.slice(1).forEach((t) => t.dispose());

    const out = await ruleById('textures/ktx2').fix({}, ctxFor(doc));
    const already = (out.skipped || []).filter((s) => s.messageId.startsWith('ktx2.skipped.already'));

    expect(already).toHaveLength(1);
    expect(already[0].messageId).toBe('ktx2.skipped.already');
    expect(already[0].data.name).toBeTruthy();
  });
});

// ============================================================================
// 2. Причина пропуска — настоящая (GAP-007).
// ============================================================================
// «Это уже формат для видеокарты» верно ровно для форматов, которые остаются
// сжатыми в видеопамяти. AVIF распаковывается в ту же RGBA, что PNG: экономии
// видеопамяти там нет, и обещать её человеку — врать о результате.
describe('Честность отчёта — причина пропуска называет настоящую причину', () => {
  it('textures/webp: KTX2 и AVIF получают РАЗНЫЕ причины пропуска', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', ['image/ktx2', 'image/avif']);
    const out = await ruleById('textures/webp').fix({}, ctxFor(doc));

    const gpu = (out.skipped || []).filter((s) => s.messageId.startsWith('webp.skipped.format'));
    const other = (out.skipped || []).filter((s) => s.messageId.startsWith('webp.skipped.unsupported'));

    expect(gpu).toHaveLength(1);
    expect(gpu[0].data.mime).toBe('ktx2');
    expect(other).toHaveLength(1);
    expect(other[0].data.mime).toBe('avif');
  });

  it('textures/webp: строка про AVIF не обещает выигрыша в видеопамяти', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', 'image/avif');
    const out = await ruleById('textures/webp').fix({}, ctxFor(doc));
    const rec = (out.skipped || []).find((s) => s.messageId.startsWith('webp.skipped.unsupported'));
    expect(rec).toBeDefined();

    for (const locale of ['ru', 'en']) {
      const text = render(rec.messageId, rec.data, locale);
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).not.toMatch(/видеокарт|видеопамят|gpu format|video memory/);
    }
  });

  it('scene/join: ложной строки «размножило общую геометрию» в движке больше нет (TESTBUG-009)', () => {
    // Ключ убран из обоих каталогов вместе с записью: render() на отсутствующем
    // ключе падает — по этому и опознаём, что строки в движке больше нет.
    for (const locale of ['ru', 'en']) {
      expect(() => render('join.expandedShared', { bytes: 1, pct: 1, dcSaved: 0 }, locale)).toThrow(/join\.expandedShared/);
    }
  });
});

// ============================================================================
// 3. Число — часть языка (Правило 8, BUG-008).
// ============================================================================
// Русский не обходится подстановкой: «1 текстур» и «именно они» про одну штуку —
// ошибка согласования на самом видном месте отчёта. У единицы своя ветка.
describe('Честность отчёта — согласование числа в русском каталоге', () => {
  const COUNTED_KEYS = ['webp.found', 'webp.keptOriginal', 'ktx2.found'];

  for (const id of COUNTED_KEYS) {
    it(`${id}: при n = 1 нет ни «1 текстур», ни множественных местоимений`, () => {
      const one = render(id, { n: 1 }, 'ru');
      const many = render(id, { n: 5 }, 'ru');

      expect(one).not.toBe(id); // ключ существует
      expect(one).not.toBe(many); // форма единственного числа отличается
      expect(one).not.toMatch(/\b1 текстур\b|\b1 карт\b/);
      expect(one).not.toMatch(/\bони\b|\bна них\b|\bих\b/);
      expect(many).toContain('5');
    });
  }
});
