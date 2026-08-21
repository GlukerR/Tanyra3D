// addons/gltf/importers.mts — чужие форматы на вход: STL и PLY.
//
// Зачем это здесь, а не отдельным аддоном. Аддон формата отвечает на вопрос «как получить
// документ glTF из файла» — и для `.stl` ответ на него такой же законный, как для `.glb`.
// Отдельный аддон означал бы отдельный набор правил и отдельный конвейер, а правила у нас
// одни и те же: после разбора это обычная модель, и оптимизируется она обычным образом.
//
// Почему НА СЕРВЕРЕ, а не в браузере через экспортёр three.js: приложение работает без
// интернета и должно уметь то же самое из командной строки. Проба 2026-08-19 показала,
// что экспортёр three.js в Node не работает вовсе, а сборка документа вручную для этих
// форматов — три десятка строк. Даром достаётся и командная строка: она принимает те же
// расширения, что интерфейс, без отдельной работы.
//
// Чего эти форматы НЕ несут: материалов, текстур, развёрток, иерархии, анимаций, единиц
// измерения. Придумывать их за автора мы не будем (Правило 11) — отчёт скажет, что их в
// файле нет, и это правда о файле, а не о нашей работе.

import fs from 'node:fs';
import path from 'node:path';

import { Document } from '@gltf-transform/core';
import { render } from '../../core/i18n.mjs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

/** Расширения, которые мы умеем ПРИНЯТЬ, но не отдаём: выход всегда glTF. */
export const IMPORT_FORMATS = ['stl', 'ply'] as const;

export function isImportFormat(srcPath: string): boolean {
  const ext = path.extname(String(srcPath)).toLowerCase().replace(/^\./, '');
  return (IMPORT_FORMATS as readonly string[]).includes(ext);
}

/**
 * Прочитать файл как ArrayBuffer — ровно свой кусок и ничего больше.
 *
 * `Buffer.buffer` в Node отдаёт ВЕСЬ пул памяти, в котором лежит буфер, а не его
 * содержимое: маленькие буферы Node селит в общий восьмикилобайтный пул. Парсер,
 * получивший такой «ArrayBuffer», читает мусор с начала пула — на пробе PLY это дало
 * ровно ноль вершин при трёх в файле, без единой ошибки. Копия через Uint8Array
 * стоит одного прохода по памяти и снимает вопрос.
 */
function readArrayBuffer(srcPath: string): ArrayBuffer {
  const bytes = new Uint8Array(fs.readFileSync(srcPath));
  return bytes.buffer as ArrayBuffer;
}

/** Атрибут геометрии three.js: сам массив и сколько чисел приходится на вершину. */
interface Attr {
  /** Может быть и типизированным массивом целых — см. флаг `normalized`. */
  array: ArrayLike<number> | Uint8Array | Uint16Array | Float32Array;
  itemSize: number;
  count: number;
  /** true — целые числа означают долю от своего максимума: 255 это единица. */
  normalized?: boolean;
}

interface Geometry {
  attributes: Record<string, Attr | undefined>;
  index?: { array: ArrayLike<number>; count: number } | null;
}

const TYPE_BY_SIZE: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/**
 * Собрать документ glTF из геометрии three.js.
 *
 * Материал НЕ создаётся намеренно. В glTF он необязателен, и примитив без материала
 * показывается умолчанием стандарта — то есть ровно тем, чем показывался бы придуманный
 * нами белый материал. Разница в честности: выдуманный материал попал бы в отчёт как
 * свойство модели, которого в файле не было.
 *
 * Раскраска вершин (она бывает у PLY) переносится КАК ЕСТЬ: это работа автора, а не
 * след экспортёра (Правило 11). По стандарту COLOR_0 умножается на базовый цвет и без
 * материала, поэтому цвета видны.
 */
function buildDocument(geom: Geometry, name: string, format: string): Document {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const prim = doc.createPrimitive();

  const position = geom.attributes.position;
  if (!position || !position.count) throw importError('io.noGeometry', format);

  const add = (semantic: string, attr: Attr | undefined) => {
    if (!attr || !attr.count) return;
    const type = TYPE_BY_SIZE[attr.itemSize];
    if (!type) return;   // экзотический размер — молча не выдумываем, чего не поняли

    // Целые числа с флагом «нормализованные» переносим КАК ЕСТЬ, а не приводим к float.
    //
    // Дефект, найденный проверкой 2026-08-20 и стоящий отдельного слова: PLYLoader отдаёт
    // раскраску вершин массивом Uint8Array с `normalized: true` — то есть 255 означает
    // единицу. Слепое `Float32Array.from` давало в файле 255.0 вместо 1.0, и модель
    // приезжала пересвеченной в двести пятьдесят пять раз. Ошибка при этом ТИХАЯ: цвета
    // на месте, счёт вершин верный, валидатор доволен.
    //
    // Заодно это и меньше весит: цвет байтом вчетверо легче цвета числом с плавающей
    // точкой, и стандарт такой аксессор разрешает.
    const src = attr.array;
    const keepInts = !!attr.normalized && (src instanceof Uint8Array || src instanceof Uint16Array);
    const acc = doc.createAccessor(semantic)
      .setType(type as never)
      .setArray(keepInts ? (src as Uint8Array | Uint16Array).slice() : Float32Array.from(src as ArrayLike<number>))
      .setBuffer(doc.getRoot().listBuffers()[0]!);
    if (keepInts) acc.setNormalized(true);
    prim.setAttribute(semantic, acc);
  };

  add('POSITION', position);
  add('NORMAL', geom.attributes.normal);
  add('COLOR_0', geom.attributes.color);
  // Развёртки у этих форматов не бывает у STL и почти не бывает у PLY, но если она
  // приехала — она авторская, и выбрасывать её нельзя.
  add('TEXCOORD_0', geom.attributes.uv);

  if (geom.index && geom.index.count) {
    // Индексы — целые. Ширину выбираем по числу вершин: 16 бит хватает до 65 535, дальше
    // обязательны 32. Ошибиться здесь значит молча испортить геометрию на крупной модели.
    const big = position.count > 65535;
    const acc = doc.createAccessor('indices')
      .setType('SCALAR')
      .setArray(big
        ? Uint32Array.from(geom.index.array as ArrayLike<number>)
        : Uint16Array.from(geom.index.array as ArrayLike<number>))
      .setBuffer(doc.getRoot().listBuffers()[0]!);
    prim.setIndices(acc);
  }

  const mesh = doc.createMesh(name).addPrimitive(prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
  doc.getRoot().setDefaultScene(scene);
  return doc;
}

/**
 * Отказ, который человек прочтёт на своём языке.
 *
 * Строка берётся из каталога (Правило 8), а на ошибку вешается рецепт: `message` остаётся
 * английским для командной строки и журнала, а сервер пересобирает текст на языке запроса.
 */
function importError(messageId: string, format: string) {
  const err: Error & { i18n?: { messageId: string; data: Record<string, unknown> } } =
    new Error(render(messageId, { format }));
  err.i18n = { messageId, data: { format } };
  return err;
}

/**
 * Разобрать файл, а внутреннюю ошибку разборщика заменить человеческой.
 *
 * Обрезанный STL давал «Offset is outside the bounds of the DataView» — правду о том, что
 * произошло внутри библиотеки, и ничего о том, что делать. Исходную ошибку не теряем:
 * она уходит в `cause` и остаётся в журнале сервера.
 */
function parseOrExplain(run: () => unknown, format: string): Geometry {
  try {
    return run() as Geometry;
  } catch (e) {
    const err = importError('io.unreadable', format);
    err.cause = e;
    throw err;
  }
}

/**
 * Сколько граней объявляет заголовок PLY. Ноль означает облако точек.
 *
 * Заголовок у PLY всегда текстовый, даже когда сами данные двоичные, — значит прочесть
 * его можно, не разбирая файл целиком. Берём первые несколько килобайт: по стандарту
 * заголовок обязан кончиться строкой `end_header`, и до неё умещаются десятки строк.
 *
 * Нет `element face` вовсе — тоже ноль: объявления нет, значит и граней нет.
 */
function plyFaceCount(buf: ArrayBuffer): number {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192)));
  const stop = head.indexOf('end_header');
  const m = (stop >= 0 ? head.slice(0, stop) : head).match(/^\s*element\s+face\s+(\d+)/mi);
  return m ? Number(m[1]) : 0;
}

/**
 * Прочитать чужой формат и отдать обычный документ glTF. Дальше конвейер не отличает его
 * от модели, приехавшей в `.glb`.
 */
export function importForeign(srcPath: string): Document {
  const ext = path.extname(srcPath).toLowerCase().replace(/^\./, '');
  const format = ext.toUpperCase();
  const buf = readArrayBuffer(srcPath);
  const name = path.basename(srcPath, path.extname(srcPath));

  if (ext === 'stl') {
    // STL хранит треугольники поштучно, со своей нормалью у каждого и без общих вершин.
    // Так он устроен — это не мусор экспортёра, и сшивать вершины здесь мы не будем:
    // сшивка склеила бы грани с разными нормалями и сгладила бы то, что автор оставил
    // гранёным. Захочет — включит сшивку галочкой, увидев цену.
    return buildDocument(parseOrExplain(() => new STLLoader().parse(buf), format), name, format);
  }
  if (ext === 'ply') {
    // Граней нет — значит это облако точек, и треугольников в нём НЕТ.
    //
    // Проверять надо ДО разбора и по заголовку, а не по результату: разборщик отдаёт
    // такое облако как обычную геометрию без индексов, а примитив glTF по умолчанию
    // рисуется треугольниками. Четыре точки молча превращались в один треугольник —
    // выдуманную геометрию, которой в файле не было (найдено 2026-08-20).
    if (plyFaceCount(buf) === 0) throw importError('io.pointCloud', format);
    return buildDocument(parseOrExplain(() => new PLYLoader().parse(buf), format), name, format);
  }
  throw new Error(`unsupported_import_format:${ext}`);
}
