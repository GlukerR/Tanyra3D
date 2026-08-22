// tests/import-textures.test.mjs — карты, лежащие рядом с моделью: что берём и что не трогаем.
//
// ПОВОД. Александр 2026-08-22, три замечания подряд, и все три об одном:
//
//   1. «выглядит будто металлик не накладывается. или рафнес. или оба»;
//   2. «на модели был чёрный бейсмат из блендера. но я добавил текстуры и он должен был
//      пропасть, но показывалась всё равно модель с бейсматериалом»;
//   3. «если в модели чёрный цвет и был рафнес 0.3. мы добавляем рафнес и материал уже
//      не 0.3. а текстура».
//
// Суть у всех одна и стоит того, чтобы записать её крупно: В glTF МНОЖИТЕЛЬ УМНОЖАЕТСЯ
// НА КАРТУ, А НЕ ЗАМЕНЯЕТСЯ ЕЮ. Чёрный baseColorFactor умножает цветную карту на ноль —
// модель остаётся чёрной, а карта в метаданных значится честно. Металличность 0 гасит
// карту металла целиком. Заметить это по числам нельзя никак: карты на месте, счётчики
// верные, картинка неверная.
//
// И правило работает В ОБЕ СТОРОНЫ — вторая половина далась мне не сразу. Первая правка
// ставила «цвет белый, шероховатость 1, металл 0» БЕЗУСЛОВНО, и человек, приложивший одну
// карту рельефа, терял и свой чёрный цвет, и свои 0.3 шероховатости. Мы стирали значения
// автора, которых менять не поручали.
//
// Отсюда правило, которое эти тесты и стерегут: КАЖДЫЙ МНОЖИТЕЛЬ УСТУПАЕТ ТОЛЬКО СВОЕЙ
// КАРТЕ. Есть карта — множитель отходит; нет карты — множитель не трогаем.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { Document } from '@gltf-transform/core';

import { attachNeighbourTextures } from '../addons/gltf/import-textures.mjs';
import { emptyNote } from '../addons/gltf/import-notes.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tex-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** Модель из одного квадрата с развёрткой и материалом, который задал «автор». */
function model({ color = [0, 0, 0, 1], roughness = 0.3, metallic = 0.7, uv = true, withTexture = false } = {}) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (a, t) => doc.createAccessor().setType(t).setBuffer(buf).setArray(a);
  const mat = doc.createMaterial('basemat')
    .setBaseColorFactor(color)
    .setRoughnessFactor(roughness)
    .setMetallicFactor(metallic);
  if (withTexture) {
    mat.setBaseColorTexture(doc.createTexture('own').setMimeType('image/png').setImage(new Uint8Array([1, 2, 3])));
  }
  const prim = doc.createPrimitive().setMode(4)
    .setAttribute('POSITION', acc(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 'VEC3'))
    .setIndices(acc(new Uint16Array([0, 1, 2, 1, 3, 2]), 'SCALAR'))
    .setMaterial(mat);
  if (uv) prim.setAttribute('TEXCOORD_0', acc(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 'VEC2'));
  doc.createScene('S').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));
  return doc;
}

/** Папка «рядом с моделью» с картами заданных имён и цветов. */
async function folder(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, grey] of Object.entries(files)) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: grey, g: grey, b: grey } } })
      .png().toFile(path.join(dir, file));
  }
  const src = path.join(dir, 'model.fbx');
  fs.writeFileSync(src, '');
  return src;
}

const run = async (doc, src) => {
  const note = emptyNote();
  await attachNeighbourTextures(doc, src, note);
  return { note, material: doc.getRoot().listMaterials()[0] };
};

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · Множитель уступает своей карте
// ═══════════════════════════════════════════════════════════════════════════

describe('множитель уступает своей карте', () => {
  it('чёрный цвет уходит, когда приложена карта цвета', async () => {
    // Случай Александра дословно: чёрный basemat из Blender.
    const src = await folder('black-base', { 'mat_BaseColor.png': 200 });
    const { material, note } = await run(model(), src);
    expect(material.getBaseColorTexture(), 'карта цвета не легла').toBeTruthy();
    expect(material.getBaseColorFactor(), 'чёрный множитель остался и погасит карту').toEqual([1, 1, 1, 1]);
    expect(note.attached.map((a) => a.slot)).toEqual(['baseColor']);
  });

  it('карта шероховатости отменяет 0.3, карта металла отменяет 0.7', async () => {
    const src = await folder('rm', { 'mat_Roughness.png': 128, 'mat_Metallic.png': 200 });
    const { material } = await run(model(), src);
    expect(material.getMetallicRoughnessTexture(), 'общая карта не собрана').toBeTruthy();
    expect(material.getRoughnessFactor(), 'шероховатость осталась 0.3 и придавит карту').toBe(1);
    expect(material.getMetallicFactor(), 'металличность осталась 0.7 и исказит карту').toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · И НЕ трогает чужие
// ═══════════════════════════════════════════════════════════════════════════

describe('множители без своей карты остаются как были', () => {
  it('одна карта рельефа не стирает ни цвет, ни шероховатость, ни металл', async () => {
    // Обратная половина правила, и попалась она мне не сразу: первая правка ставила
    // «белый, 1, 0» безусловно — то есть съедала настройки автора целиком.
    const src = await folder('only-normal', { 'mat_Normal.png': 128 });
    const { material } = await run(model({ color: [0.2, 0.4, 0.6, 1] }), src);
    expect(material.getNormalTexture(), 'рельеф не лёг').toBeTruthy();
    expect(material.getBaseColorFactor(), 'цвет автора стёрт без всякой карты цвета')
      .toEqual([0.2, 0.4, 0.6, 1]);
    expect(material.getRoughnessFactor(), 'шероховатость автора стёрта').toBe(0.3);
    expect(material.getMetallicFactor(), 'металличность автора стёрта').toBe(0.7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 3 · Границы: когда НЕ берёмся вовсе
// ═══════════════════════════════════════════════════════════════════════════

describe('за чужое не беремся', () => {
  it('у модели есть своя карта — не трогаем ничего', async () => {
    // Правило 11: автор всё сказал сам. Подменять его материал по именам файлов рядом
    // было бы решением за него.
    const src = await folder('has-own', { 'mat_BaseColor.png': 200 });
    const doc = model({ withTexture: true });
    const { note } = await run(doc, src);
    expect(note.attached, 'вмешались в модель, у которой уже есть карты').toEqual([]);
    expect(doc.getRoot().listTextures().length, 'добавили лишнюю текстуру').toBe(1);
  });

  it('нет развёртки — карту класть некуда, и мы не кладём', async () => {
    const src = await folder('no-uv', { 'mat_BaseColor.png': 200 });
    const { note } = await run(model({ uv: false }), src);
    expect(note.attached, 'назначили карту модели без развёртки — отчёт соврал бы').toEqual([]);
  });

  it('имя ни под что не подходит — файл остаётся лежать', async () => {
    // Молча приписать «render_final_v3.png» к слоту — это выдумка, а не чтение.
    const src = await folder('unknown', { 'render_final_v3.png': 200 });
    const { note } = await run(model(), src);
    expect(note.attached, 'приписали к слоту файл, имя которого ни о чём не говорит').toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 4 · Как три карты становятся одной
// ═══════════════════════════════════════════════════════════════════════════

describe('затенение, шероховатость и металл пакуются в одну карту', () => {
  it('каналы стоят по стандарту: R — затенение, G — шероховатость, B — металл', async () => {
    // Вопрос Александра: «как происходит объединение текстур в орм текстуру?». Ответ
    // проверяемый: три серые картинки разной яркости, и каждая обязана оказаться в своём
    // канале. Перепутать их местами — обычная ошибка, и по виду модели её не поймать.
    const src = await folder('orm', {
      'mat_AO.png': 60,
      'mat_Roughness.png': 130,
      'mat_Metallic.png': 220,
    });
    const doc = model();
    const { material } = await run(doc, src);

    const tex = material.getMetallicRoughnessTexture();
    expect(tex, 'общая карта не собрана').toBeTruthy();
    const { data } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
    // JPEG сжимает с потерей — сверяем с допуском, а не побайтно.
    expect(data[0], 'в красном канале не затенение').toBeGreaterThan(45);
    expect(data[0]).toBeLessThan(80);
    expect(data[1], 'в зелёном канале не шероховатость').toBeGreaterThan(115);
    expect(data[1]).toBeLessThan(150);
    expect(data[2], 'в синем канале не металл').toBeGreaterThan(205);

    // Затенение glTF читает из КРАСНОГО канала той же карты — значит она же ставится и
    // в слот затенения, иначе карта AO просто не подключена.
    expect(material.getOcclusionTexture(), 'затенение не подключено').toBeTruthy();
  });

  it('недостающий канал заполняется нейтральным, а не чёрным', async () => {
    // Чёрное затенение погасило бы модель целиком — это и есть цена неверного умолчания.
    const src = await folder('orm-partial', { 'mat_Roughness.png': 130 });
    const { material } = await run(model(), src);
    const tex = material.getMetallicRoughnessTexture();
    const { data } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
    expect(data[0], 'затенения нет, а канал не белый — модель потемнеет').toBeGreaterThan(240);
    expect(data[2], 'металла нет, а канал не чёрный — модель заблестит').toBeLessThan(20);
    // И слот затенения НЕ занимаем: карты AO не было, занимать его нечем.
    expect(material.getOcclusionTexture(), 'подключили затенение, которого не приносили').toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 5 · Одна таблица назначений на движок и на интерфейс
// ═══════════════════════════════════════════════════════════════════════════

describe('интерфейс и движок одинаково понимают имена файлов', () => {
  it('таблицы назначений совпадают побуквенно', () => {
    // ПОЧЕМУ ТАБЛИЦА ЛЕЖИТ В ДВУХ МЕСТАХ. Слой интерфейса не имеет права импортировать
    // `addons/` (§2.4, layer-boundaries), а знать назначение карты обязан: без этого он
    // не поймёт, какую прежнюю карту вытесняет новая. Значит копия неизбежна — и
    // единственное, что делает её безопасной, это сторож на расхождение.
    //
    // Разойдись они молча — интерфейс выбросит из пачки не ту карту. Человек увидит это
    // не раньше сборки, а причину не увидит вовсе.
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
    const strip = (text, start) => {
      const from = text.indexOf(start);
      expect(from, `таблица ${start} не найдена`).toBeGreaterThan(-1);
      const to = text.indexOf('];', from);
      return text.slice(from, to)
        .split('\n')
        // Только СТРОКИ ТАБЛИЦЫ. Заголовок объявления отбрасываем: имена переменных
        // разные намеренно (`SLOTS` у движка, `TEXTURE_SLOTS` у интерфейса), а сверяем
        // мы содержимое.
        .filter((l) => l.includes("{ slot: '"))
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .join('\n');
    };
    const engine = strip(fs.readFileSync(path.join(root, 'addons/gltf/import-textures.mts'), 'utf8'), 'const SLOTS');
    const ui = strip(fs.readFileSync(path.join(root, 'ui/app.ts'), 'utf8'), 'const TEXTURE_SLOTS');
    expect(engine.length, 'таблица движка пуста').toBeGreaterThan(0);
    expect(ui, 'таблицы назначений разошлись — интерфейс выбросит не ту карту').toBe(engine);
  });
});
