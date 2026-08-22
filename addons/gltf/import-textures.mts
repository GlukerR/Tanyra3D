/**
 * addons/gltf/import-textures.mts — карты, лежащие РЯДОМ с моделью.
 *
 * ПОВОД (Александр, 2026-08-22): «фбиксы загружаются, а вот текстуры нет… загрузка к
 * фбиксу текстур точно должна присутствовать». Его файл — `CCR1072-1G-8S+_nomat.fbx` —
 * назван так не случайно: материалов в нём нет вовсе, все 21 стоят `__DEFAULT`, ссылок на
 * картинки ноль. Карты лежат отдельной папкой `jpg2k`. Связывает их только человек.
 *
 * ГДЕ ЗДЕСЬ ГРАНИЦА ПРАВИЛА 11. Мы не решаем за автора и не становимся редактором:
 * пару «эта модель + эти карты» составил ЧЕЛОВЕК, когда бросил их вместе. Наше дело —
 * довезти поставку целиком, а не улучшить замысел. Поэтому:
 *
 *   · берёмся ТОЛЬКО когда своих текстур у модели нет ни одной. Есть материал с картой —
 *     значит автор всё сказал сам, и трогать его мы не будем ни при каких именах файлов;
 *   · берёмся ТОЛЬКО когда у модели есть развёртка. Без неё карту некуда положить, и
 *     назначенная текстура была бы враньём в отчёте;
 *   · КАЖДОЕ назначение попадает в отчёт строкой «слот ← файл». Человек обязан видеть,
 *     что мы сделали, — иначе это уже решение за него.
 *
 * ИМЕНА, А НЕ ДОГАДКИ. Суффиксы `_BaseColor`, `_Normal`, `_Roughness`, `_Metallic`,
 * `_AO`, `_Emissive` — не наша выдумка, а то, как называет файлы Substance Painter и
 * вслед за ним почти все. Это ЧТЕНИЕ соглашения, а не изобретение смысла. Файл, чьё имя
 * ни под что не подходит, остаётся лежать: молча приписать его к слоту было бы как раз
 * тем, чего Правило 11 не разрешает.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Document, Texture } from '@gltf-transform/core';
import sharp from 'sharp';

import type { ImportNote } from './import-notes.mjs';

/** MIME по расширению. Чего glTF не разрешает, здесь нет: такие файлы мы не берём. */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

/**
 * Слоты и признаки их имён. Порядок важен: `_AO` проверяется раньше прочего, потому что
 * две буквы легко найти внутри чужого слова, и якоря по краям здесь обязательны.
 */
const SLOTS: Array<{ slot: string; re: RegExp }> = [
  { slot: 'baseColor', re: /(basecolor|base_color|albedo|diffuse|_col(our)?[._-]|_d\.)/i },
  { slot: 'normal', re: /(normal|_nrm[._-]|_n\.)/i },
  { slot: 'roughness', re: /(rough|_rgh[._-])/i },
  { slot: 'metallic', re: /(metal|_mtl[._-])/i },
  { slot: 'occlusion', re: /((^|[._-])ao([._-]|$)|occlusion|ambient)/i },
  { slot: 'emissive', re: /(emissi|_emit[._-])/i },
];

/** У модели есть развёртка? Без неё карту класть некуда. */
function hasUv(doc: Document): boolean {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('TEXCOORD_0')) return true;
    }
  }
  return false;
}

/**
 * Собрать список картинок рядом с моделью: сама папка и её подпапки на ОДИН уровень.
 *
 * Глубже не ходим намеренно. Раскладка `модель.fbx` + `textures/` покрывает подавляющее
 * большинство поставок, а неограниченный обход на чужой папке — это и лишнее чтение
 * диска, и риск подобрать картинки от соседней модели.
 */
function imagesNear(dir: string): string[] {
  const out: string[] = [];
  const take = (d: string) => {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      if (MIME[ext]) out.push(path.join(d, name));
    }
  };
  take(dir);
  let subs: fs.Dirent[];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of subs) if (e.isDirectory()) take(path.join(dir, e.name));
  return out;
}

/** Первый файл, чьё имя подходит под слот. */
function pick(files: string[], re: RegExp): string | null {
  return files.find((f) => re.test(path.basename(f))) || null;
}

/**
 * Приложить к модели карты, лежащие рядом, — если своих у неё нет.
 *
 * Возвращает `true`, если хоть что-то назначено. Все назначения дописываются в записку
 * ввоза: по ней правило `import/textures-attached` скажет о них человеку.
 */
export async function attachNeighbourTextures(doc: Document, srcPath: string, note: ImportNote): Promise<boolean> {
  const root = doc.getRoot();
  if (root.listTextures().length) return false; // свои карты есть — не наше дело
  if (!hasUv(doc)) return false;                // класть некуда

  const files = imagesNear(path.dirname(srcPath));
  if (!files.length) return false;

  const found = new Map<string, string>();
  for (const { slot, re } of SLOTS) {
    const hit = pick(files, re);
    if (hit) found.set(slot, hit);
  }
  if (!found.size) return false;

  const texOf = async (file: string): Promise<Texture> => {
    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    return doc.createTexture(path.basename(file))
      .setMimeType(MIME[ext]!)
      .setImage(new Uint8Array(fs.readFileSync(file)));
  };

  // ОДИН набор карт — на ВСЕ материалы модели, у которых своих карт нет.
  //
  // Первая редакция вешала карты на первый материал и отдавала его только примитивам без
  // материала. Замер на модели Александра показал, чего это стоит: у его FBX 21 материал
  // (все __DEFAULT, все со своим объектом), карты легли на один — то есть покрашенной
  // оказалась одна часть из двадцати одной. Снаружи это выглядит как «текстуры не
  // работают», и понять почему нельзя ничем.
  //
  // Разложить семь карт по двадцати одной части по-разному мы не можем: какая часть чем
  // покрыта, знает только автор, а он про это молчит — материалов-то в файле нет.
  // Значит честный ответ один: набор общий, и он на всём.
  const material = root.listMaterials()[0] || doc.createMaterial('imported');
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setMaterial(material);
  }

  const say = (slot: string, file: string) => note.attached.push({ slot, file: path.basename(file) });

  // КАЖДЫЙ МНОЖИТЕЛЬ УСТУПАЕТ ТОЛЬКО СВОЕЙ КАРТЕ.
  //
  // Александр 2026-08-22: «на модели был чёрный бейсмат из блендера. но я добавил
  // текстуры и он должен был пропасть… если в модели чёрный цвет и был рафнес 0.3, мы
  // добавляем рафнес — и материал уже не 0.3, а текстура».
  //
  // В glTF множитель УМНОЖАЕТСЯ на карту, а не заменяется ею. Чёрный baseColorFactor
  // из Blender умножал бы цветную карту на ноль: модель осталась бы чёрной, а карта в
  // метаданных значилась бы честно. Ровно тот же дефект, что был с металличностью.
  //
  // Но правило работает и в обратную сторону, и это важнее. Раньше здесь стояло
  // безусловное «цвет белый, шероховатость 1, металл 0» — то есть, приложив ОДНУ карту
  // рельефа, человек терял и свой чёрный цвет, и свои 0.3 шероховатости. Мы стирали
  // значения автора, которых он нам менять не поручал.
  //
  // Поэтому: карта есть — множитель уступает; карты нет — множитель НЕ ТРОГАЕМ.
  const base = found.get('baseColor');
  if (base) {
    material.setBaseColorTexture(await texOf(base));
    material.setBaseColorFactor([1, 1, 1, 1]);
    say('baseColor', base);
  }

  const normal = found.get('normal');
  if (normal) { material.setNormalTexture(await texOf(normal)); say('normal', normal); }

  const emissive = found.get('emissive');
  if (emissive) {
    material.setEmissiveTexture(await texOf(emissive));
    material.setEmissiveFactor([1, 1, 1]);
    say('emissive', emissive);
  }

  // Шероховатость, металличность и затенение glTF хранит ОДНОЙ картой по каналам:
  // R — затенение, G — шероховатость, B — металличность. Три отдельных файла надо
  // упаковать, иначе стандарт их не примет. Пакуем сами, а не просим человека.
  const orm: Array<string | null> = ['occlusion', 'roughness', 'metallic'].map((k) => found.get(k) ?? null);
  if (orm.some(Boolean)) {
    const packed = await packOrm(orm[0] ?? null, orm[1] ?? null, orm[2] ?? null);
    if (packed) {
      const ormTex = doc.createTexture('orm').setMimeType('image/jpeg').setImage(packed);
      material.setMetallicRoughnessTexture(ormTex);
      if (orm[0]) material.setOcclusionTexture(ormTex);
      // МНОЖИТЕЛИ ОБЯЗАНЫ СТАТЬ ЕДИНИЦАМИ. В glTF metallicFactor и roughnessFactor
      // УМНОЖАЮТСЯ на соответствующие каналы карты. Мы ставили металличность 0 — и она
      // обнуляла всю карту металла целиком: модель выходила без единого блика, а в
      // метаданных карта при этом честно значилась. Александр это и увидел: «выглядит
      // будто металлик не накладывается. или рафнес. или оба».
      //
      // Ноль был осмысленным ДО того, как появились карты: у материала без них «просто
      // поверхность» — это металличность 0. С картой смысл ровно обратный: множитель
      // должен пропускать её как есть.
      if (orm[2]) material.setMetallicFactor(1);
      if (orm[1]) material.setRoughnessFactor(1);
      // Затенению множителя в glTF не полагается — только сила (occlusionStrength),
      // и её умолчание уже единица. Трогать нечего.
      for (const [i, k] of ['occlusion', 'roughness', 'metallic'].entries()) {
        if (orm[i]) say(k, orm[i]!);
      }
    }
  }

  return note.attached.length > 0;
}

/**
 * Упаковать три карты в одну: R — затенение, G — шероховатость, B — металличность.
 *
 * Размер берём у первой попавшейся; недостающие каналы заполняем нейтральным значением
 * (затенение и шероховатость — 255, металличность — 0), а не оставляем чёрными: чёрное
 * затенение погасило бы модель целиком.
 */
async function packOrm(ao: string | null, rough: string | null, metal: string | null): Promise<Uint8Array | null> {
  const any = ao || rough || metal;
  if (!any) return null;
  const meta = await sharp(any).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return null;

  const channel = async (file: string | null, fallback: number) => (file
    ? sharp(file).resize(w, h).greyscale().raw().toBuffer()
    : Buffer.alloc(w * h, fallback));
  const [r, g, b] = await Promise.all([channel(ao, 255), channel(rough, 255), channel(metal, 0)]);

  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = r[i]!;
    rgb[i * 3 + 1] = g[i]!;
    rgb[i * 3 + 2] = b[i]!;
  }
  const out = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return new Uint8Array(out);
}
