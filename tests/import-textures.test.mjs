import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { Document } from '@gltf-transform/core';

import { attachNeighbourTextures } from '../addons/gltf/import-textures.mjs';
import { emptyNote, setImportNote } from '../addons/gltf/import-notes.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { render } from '../core/i18n.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tex-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

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

describe('множитель уступает своей карте', () => {
  it('чёрный цвет уходит, когда приложена карта цвета', async () => {
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

describe('множители без своей карты остаются как были', () => {
  it('одна карта рельефа не стирает ни цвет, ни шероховатость, ни металл', async () => {
    const src = await folder('only-normal', { 'mat_Normal.png': 128 });
    const { material } = await run(model({ color: [0.2, 0.4, 0.6, 1] }), src);
    expect(material.getNormalTexture(), 'рельеф не лёг').toBeTruthy();
    expect(material.getBaseColorFactor(), 'цвет автора стёрт без всякой карты цвета')
      .toEqual([0.2, 0.4, 0.6, 1]);
    expect(material.getRoughnessFactor(), 'шероховатость автора стёрта').toBe(0.3);
    expect(material.getMetallicFactor(), 'металличность автора стёрта').toBe(0.7);
  });
});

describe('за чужое не беремся', () => {
  it('у модели есть своя карта — не трогаем ничего', async () => {
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
    const src = await folder('unknown', { 'render_final_v3.png': 200 });
    const { note } = await run(model(), src);
    expect(note.attached, 'приписали к слоту файл, имя которого ни о чём не говорит').toEqual([]);
  });
});

describe('затенение, шероховатость и металл пакуются в одну карту', () => {
  it('каналы стоят по стандарту: R — затенение, G — шероховатость, B — металл', async () => {
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
    expect(data[0], 'в красном канале не затенение').toBeGreaterThan(45);
    expect(data[0]).toBeLessThan(80);
    expect(data[1], 'в зелёном канале не шероховатость').toBeGreaterThan(115);
    expect(data[1]).toBeLessThan(150);
    expect(data[2], 'в синем канале не металл').toBeGreaterThan(205);

    expect(material.getOcclusionTexture(), 'затенение не подключено').toBeTruthy();
  });

  it('недостающий канал заполняется нейтральным, а не чёрным', async () => {
    const src = await folder('orm-partial', { 'mat_Roughness.png': 130 });
    const { material } = await run(model(), src);
    const tex = material.getMetallicRoughnessTexture();
    const { data } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
    expect(data[0], 'затенения нет, а канал не белый — модель потемнеет').toBeGreaterThan(240);
    expect(data[2], 'металла нет, а канал не чёрный — модель заблестит').toBeLessThan(20);
    expect(material.getOcclusionTexture(), 'подключили затенение, которого не приносили').toBeNull();
  });
});

describe('таблица назначений карт объявлена один раз', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('интерфейс не держит своей таблицы', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'ui/app.ts'), 'utf8');
    const строкиТаблицы = ui.split(/\r?\n/).filter((l) => /\{\s*slot:\s*'[a-zA-Z]+'\s*,\s*re:/.test(l));
    expect(строкиТаблицы,
      'в ui/app.ts снова объявлена своя таблица назначений. Она приходит по шву '
      + '(/api/extensions, поле textureSlots) — вторая копия разойдётся молча')
      .toEqual([]);
  });

  it('таблица едет по шву и собирается в рабочие регулярки', async () => {
    const { textureSlots } = await import('../optimize2.mjs');
    const wire = textureSlots();
    expect(wire.length, 'по шву не приехало ни одного назначения').toBeGreaterThan(0);
    for (const s of wire) {
      expect(typeof s.slot, `слот без имени: ${JSON.stringify(s)}`).toBe('string');
      expect(() => new RegExp(s.pattern, s.flags), `${s.slot}: признак имени не собирается`).not.toThrow();
    }
  });

  it('собранная из шва таблица раскладывает имена так же, как движок', async () => {
    const { textureSlots } = await import('../optimize2.mjs');
    const { TEXTURE_SLOTS } = await import('../addons/gltf/media.mjs');
    const собранная = textureSlots().map((s) => ({ slot: s.slot, re: new RegExp(s.pattern, s.flags) }));
    const назначение = (таблица, имя) => (таблица.find(({ re }) => re.test(имя)) || {}).slot || null;

    const примеры = [
      'wood_basecolor.png', 'wood_albedo.jpg', 'wall_diffuse.webp', 'panel_col.png', 'x_d.png',
      'wood_normal.png', 'wood_nrm.png', 'x_n.png',
      'wood_roughness.png', 'wood_rgh.png',
      'metal_metallic.png', 'part_mtl.png',
      'wood_ao.png', 'occlusion.png', 'ambient.png',
      'lamp_emissive.png', 'lamp_emit.png',
      'readme.txt', 'chaotic.png', 'shadow.png',
    ];
    for (const имя of примеры) {
      expect(назначение(собранная, имя), `${имя}: шов и движок разошлись в назначении`)
        .toBe(назначение(TEXTURE_SLOTS, имя));
    }
  });
});

describe('правило import/textures-attached доходит до отчёта', () => {
  const RULE_ID = 'import/textures-attached';
  const analyze = (document) => RULES.find((r) => r.meta.id === RULE_ID).analyze({ document });

  const сЗапиской = (attached) => {
    const doc = model();
    setImportNote(doc, { ...emptyNote(), attached });
    return doc;
  };

  it('на каждую подобранную карту — своя строка с файлом и слотом', async () => {
    const out = analyze(сЗапиской([
      { slot: 'baseColor', file: 'chair_BaseColor.png' },
      { slot: 'normal', file: 'chair_Normal.png' },
      { slot: 'roughness', file: 'chair_Roughness.png' },
    ]));
    expect(out.length, 'строк не столько, сколько карт').toBe(3);
    expect(out.map((f) => f.data.file)).toEqual([
      'chair_BaseColor.png', 'chair_Normal.png', 'chair_Roughness.png',
    ]);
    for (const f of out) expect(f.messageId).toBe('import.textureAttached');
  });

  it('имя слота — сообщение каталога, а не строка из кода', async () => {
    const out = analyze(сЗапиской([{ slot: 'baseColor', file: 'a.png' }]));
    expect(out[0].data.slot).toEqual({ messageId: 'slot.baseColor', data: {} });
  });

  it('все шесть слотов подбора названы каталогом', async () => {
    const слоты = ['baseColor', 'normal', 'roughness', 'metallic', 'occlusion', 'emissive'];
    const out = analyze(сЗапиской(слоты.map((slot) => ({ slot, file: `${slot}.png` }))));
    expect(out.map((f) => f.data.slot.messageId))
      .toEqual(слоты.map((s) => `slot.${s}`));
  });

  it('строки переживают перевод и не остаются ключами', () => {
    const out = analyze(сЗапиской([{ slot: 'metallic', file: 'wheel_Metallic.png' }]));
    for (const язык of ['ru', 'en']) {
      const текст = render(out[0].messageId, out[0].data, язык);
      expect(текст, `на языке ${язык} в отчёт попал ключ`).not.toMatch(/^(import\.|slot\.)/);
      expect(текст, 'имя файла потерялось').toContain('wheel_Metallic.png');
      expect(текст.length, `на языке ${язык} пустая строка`).toBeGreaterThan(10);
    }
  });

  it('ничего не подобрали — правило молчит', () => {
    expect(analyze(сЗапиской([])), 'заговорили, не приложив ни одной карты').toEqual([]);
    expect(analyze(model()), 'заговорили о модели, которая приехала не из чужого формата')
      .toEqual([]);
  });
});
