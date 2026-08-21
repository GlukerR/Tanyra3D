// tests/report-honesty.test.mjs — сторожа честности отчёта.
//
// Плотность отчёта («не толпой одинаковых строк») сторожит соседний файл
// tests/report-density.test.mjs. Здесь — три других свойства той же честности,
// каждое закрывает найденный дефект:
//
//   1. Один класс случаев — одна строка. GAP-006: `textures/ktx2`
//      писал «уже KTX2» на каждую текстуру.
//   2. Причина пропуска — настоящая. GAP-007: `textures/webp` объяснял пропуск
//      любого незнакомого формата словами «это уже формат для видеокарты»,
//      что верно для KTX2 и ложно для AVIF.
//   3. Число — часть языка. BUG-008: русские строки при n = 1 давали
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ============================================================================
// 1. Один класс случаев — одна строка (GAP-006).
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
// Смысл раздела сменился 2026-08-17 (Правило 12). Раньше здесь проверялось, что у
// РАЗНЫХ отказов разные причины: «уже формат для видеокарты» для ktx2 и «мы такое не
// перекодируем» для avif. Обоих отказов больше нет — правило кодирует всё. Проверять
// теперь надо противоположное: молчаливого отказа не осталось ни для какого формата,
// а единственный законный (сбой кодировщика) назван по имени текстуры и с причиной.
describe('Честность отчёта — причина пропуска называет настоящую причину', () => {
  it('textures/webp: ни один формат не даёт молчаливого отказа', async () => {
    const doc = await docWithMimes('Dirty Cube 01.glb', ['image/ktx2', 'image/avif']);
    const out = await ruleById('textures/webp').fix({}, ctxFor(doc));

    // Единственный разрешённый вид пропуска — назвавший себя сбой кодировщика.
    // Любой другой webp.skipped.* означает, что молчаливый отказ вернулся.
    const ids = (out.skipped || []).map((s) => s.messageId).filter((id) => id.startsWith('webp.skipped'));
    expect(new Set(ids)).toEqual(new Set(ids.length ? ['webp.skipped.failed'] : []));

    // И у каждого такого пропуска обязаны быть имя текстуры и причина — иначе это
    // тот же молчаливый отказ, только под другим ключом.
    for (const rec of (out.skipped || []).filter((s) => s.messageId === 'webp.skipped.failed')) {
      expect(rec.data.name).toBeTruthy();
      expect(rec.data.reason).toBeTruthy();
    }
  });

  it('textures/webp: строка про распаковку из GPU-формата НЕ обещает выигрыша, а называет цену', () => {
    // Раньше правило отказывалось трогать KTX2 и объясняло это выигрышем видеопамяти.
    // Теперь оно его распаковывает — и обязано сказать, что видеопамять ВЫРАСТЕТ,
    // а качество потеряно дважды. Обещать здесь экономию было бы враньём наоборот.
    for (const locale of ['ru', 'en']) {
      const text = render('webp.done.fromGpu', { n: 3 }, locale).toLowerCase();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/видеопамят|video memory/);
      expect(text).toMatch(/вырастет|will grow/);
      // ни слова про экономию/уменьшение видеопамяти
      expect(text).not.toMatch(/меньше видеопамят|экономи|less video memory|saves/);
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
// 3. Число — часть языка (BUG-008).
// ============================================================================
// Русский не обходится подстановкой: «1 текстур» и «именно они» про одну штуку —
// ошибка согласования на самом видном месте отчёта. У единицы своя ветка.
describe('Честность отчёта — согласование числа в русском каталоге', () => {
  // webp.keptOriginal убран вместе с откатом (Правило 12). На его месте — два новых
  // счётных ключа того же правила: оба появились 2026-08-17 и оба обязаны согласовывать
  // число, иначе «1 текстур распаковано» вернётся на самое видное место отчёта.
  const COUNTED_KEYS = ['webp.found', 'webp.done.fromGpu', 'webp.alreadyTarget', 'ktx2.found'];

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

// ---------------------------------------------------------------------------
// Включённая галочка не пропадает из отчёта — даже когда делать ей нечего
// ---------------------------------------------------------------------------
//
// Правило 12 запрещает молчаливый пропуск. У движка для этого есть сторож: правило,
// которое отработало и не сказало ни слова, получает строку «включено, но в этой модели
// менять было нечего».
//
// Сторож смотрел на `meta.feature` — имя ОДНОЙ галочки. А у `textures/resize` галочек
// четыре (4096, 2048, 1024, 512), и назвать в этом поле одну нельзя: выбравшему 2048
// сообщили бы про 4096. Поэтому правило объявляет ГРУППУ (`featureGroup`), и мимо
// сторожа проходило целиком: человек выбирал «уменьшить до 2048» на модели без текстур
// и не получал НИ ОДНОЙ строки о своём выборе.
//
// Найдено 2026-08-20 на модели из STL — в этом формате текстур нет по устройству, и
// случай перестал быть редким.
describe('Честность отчёта — правило с группой галочек тоже отчитывается', () => {
  it('у каждого правила есть чем назваться: feature либо featureGroup', () => {
    // «Своя галочка» отличается от «члена набора safe» одним признаком: набор `safe`
    // САМ ПО СЕБЕ его не включает. Правило, которое зажигается от `safe`, человек
    // поимённо не выбирал — ему молчать законно (structure/dedup, attributes/vertex-colors).
    // А правило со своим выключателем обязано его объявить: иначе движку нечем о нём
    // отчитаться, и молчание вернётся.
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
    // Сторож на самом движке, а не на правиле: правило может объявить группу правильно,
    // а движок — по-прежнему смотреть только на `feature`. Ровно так и было.
    const src = fs.readFileSync(path.join(ROOT, 'core', 'engine.mjs'), 'utf8');
    const guard = src.match(/if \(!saidSomething && \(?([^)]*)\)?\) \{/);
    expect(guard, 'не нашёл сторож «ничего не сделано» — якорь сменился').toBeTruthy();
    expect(guard[1], 'движок снова смотрит только на feature').toContain('featureGroup');
  });
});
