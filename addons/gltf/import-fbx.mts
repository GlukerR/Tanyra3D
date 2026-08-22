/**
 * addons/gltf/import-fbx.mts — FBX на вход.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ, а не строкой в importers.mts рядом с STL и PLY. Те два несут
 * голую геометрию, и сборка документа для них — три десятка строк. FBX несёт иерархию
 * узлов, материалы, ссылки на текстуры, несколько развёрток, скины и анимации. Это другой
 * объём работы, и держать его в одном файле с «прочитали треугольники» значило бы сделать
 * нечитаемым и то, и другое.
 *
 * ПРАВО ЭТО ДЕЛАТЬ (вопрос Александра 2026-08-22: «мы не можем никак принимать фбикс в оф
 * приложении без какой-то лицензии?»). Можем, и ничего подключать не нужно:
 *   · `FBXLoader` — часть three.js, а three.js у нас уже есть (0.185.1, лицензия MIT).
 *     Оттуда же берутся STLLoader и PLYLoader. Новой зависимости не появляется.
 *   · В шапке самого загрузчика источник назван прямо: спецификация ДВОИЧНОГО формата от
 *     Blender (обратная разработка). SDK Autodesk упомянут справочником по смыслу полей,
 *     кода Autodesk там нет.
 *   · MIT внутрь Apache-2.0 ложится без конфликта.
 * Следствие не юридическое, а техническое, и его надо помнить: спецификация закрыта,
 * разбор восстановлен со стороны. Загрузчик требует FBX 7.0+ текстовый или 6400+ двоичный
 * и честно пишет, что более старые «загрузятся, но скорее всего с ошибками». Поэтому любой
 * срыв разбора превращается в человеческий отказ, а не в чужую строку про DataView.
 *
 * БЕЗ ИНТЕРНЕТА И БЕЗ БРАУЗЕРА. Загрузчик, встретив текстуру, зовёт `TextureLoader` —
 * а тот в Node полез бы в `document.createElementNS`. Обходим не заглушкой глобалей, а
 * штатным местом: `LoadingManager.addHandler` спрашивается РАНЬШЕ TextureLoader
 * (см. `loadTexture` в FBXLoader). Наш обработчик возвращает пустую текстуру с именем
 * файла — до декодирования картинки дело не доходит вовсе. Ни одного адреса наружу.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Document, type Material, type Texture } from '@gltf-transform/core';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

/** Что мы НЕ довезли и обязаны назвать вслух, а не проглотить. */
export interface ImportNote {
  /** Анимационных дорожек в файле (в glTF пока не переносим). */
  animations: number;
  /** Скинов (скелетная привязка) — там же. */
  skins: number;
  /** Имена текстур, которые FBX называет, а рядом их не оказалось. */
  missingTextures: string[];
}

/**
 * Заметки о ввозе, привязанные к документу.
 *
 * WeakMap, а не `extras` документа: `extras` уезжают в СОБРАННЫЙ файл, и наша служебная
 * записка стала бы частью модели человека. Здесь она живёт ровно столько, сколько живёт
 * сам документ, и наружу не попадает никогда.
 */
const NOTES = new WeakMap<Document, ImportNote>();

/** Заметка о ввозе для этого документа, если он приехал из FBX. */
export function importNote(doc: Document): ImportNote | null {
  return NOTES.get(doc) || null;
}

/** Расширения картинок, которые может понадобиться подставить вместо TextureLoader. */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'tga', 'psd', 'exr', 'dds'];

/** MIME по расширению. Чего glTF не разрешает — не называем, такие карты не переносятся. */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

// Три поля three.js, из которых достаётся имя файла: наш обработчик кладёт его в
// userData, но у пустой текстуры-заглушки (FBXLoader ставит её, когда имени нет вовсе)
// не будет и его.
const fileOf = (t: unknown): string => {
  const tex = t as { userData?: { fbxFile?: string }; name?: string } | null | undefined;
  return (tex && (tex.userData?.fbxFile || tex.name)) || '';
};
/**
 * Загрузчик, который НЕ грузит: возвращает имя файла и на этом заканчивает.
 *
 * СВОЕЙ ФОРМЫ, а не `new LoadingManager()` и `new Texture()` из three. Слой аддонов не
 * имеет права импортировать пакет three целиком — только конкретные разборщики чужих
 * форматов, по одному модулю (сторож: tests/architecture/layer-boundaries.test.mjs).
 * Граница узкая намеренно, и расширять её ради двух конструкторов нельзя: за `three`
 * стоит рендерер со сценой, а нам нужны имя файла и две пары чисел.
 *
 * Что именно трогает FBXLoader у того, что мы вернём (см. parseTexture в его исходнике):
 * присваивает `ID`, `name`, `wrapS`, `wrapT` и пишет в `repeat.x/y`, `offset.x/y` —
 * поэтому обе пары должны существовать заранее. Ничего больше он не зовёт: методы
 * менеджера `itemStart`/`itemError` живут в асинхронном `load()`, а мы зовём `parse()`.
 */
function nameOnlyManager(): unknown {
  const stub = {
    path: '',
    setPath(p: string) { this.path = p || ''; return this; },
    setCrossOrigin() { return this; },
    load(fileName: string) {
      return {
        name: fileName,
        userData: { fbxFile: fileName },
        repeat: { x: 1, y: 1 },
        offset: { x: 0, y: 0 },
      };
    },
  };
  const known = new Set(IMAGE_EXT.map((e) => `.${e}`));
  return {
    // FBXLoader спрашивает обработчик по расширению и сравнивает результат С NULL —
    // именно с null, поэтому для незнакомого расширения возвращаем его, а не undefined.
    getHandler: (ext: string) => (known.has(String(ext).toLowerCase()) ? stub : null),
  };
}

/** Минимум формы three.js, который нам нужен. Полные типы тянуть незачем: берём поля. */
interface ThreeAttr { array: ArrayLike<number>; itemSize: number; count: number; normalized?: boolean }
interface ThreeGeom {
  attributes: Record<string, ThreeAttr | undefined>;
  index?: { array: ArrayLike<number>; count: number } | null;
}
interface ThreeObj {
  name?: string;
  isMesh?: boolean;
  geometry?: ThreeGeom;
  material?: unknown;
  children: ThreeObj[];
  position: { toArray(): number[] };
  quaternion: { toArray(): number[] };
  scale: { toArray(): number[] };
}
interface ThreeMat {
  uuid: string; name?: string;
  color?: { toArray(): number[] };
  emissive?: { toArray(): number[] };
  opacity?: number;
  transparent?: boolean;
  map?: unknown; normalMap?: unknown; emissiveMap?: unknown; aoMap?: unknown;
}

const TYPE_BY_SIZE: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/**
 * Прочитать FBX и отдать обычный документ glTF.
 *
 * @param srcPath  путь к файлу — от него же отсчитываются относительные адреса текстур
 * @param buf      содержимое файла
 * @param fail     как превратить срыв в человеческий отказ (общий с STL/PLY)
 */
export function importFbx(
  srcPath: string,
  buf: ArrayBuffer,
  fail: (messageId: string, format: string) => Error & { cause?: unknown },
): Document {
  const format = 'FBX';
  let group: ThreeObj & { animations?: unknown[] };
  try {
    group = new FBXLoader(nameOnlyManager() as never).parse(buf, '') as never;
  } catch (e) {
    const err = fail('io.unreadable', format);
    err.cause = e;
    throw err;
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);

  const note: ImportNote = { animations: 0, skins: 0, missingTextures: [] };
  const anims = (group as { animations?: unknown[] }).animations;
  if (Array.isArray(anims)) note.animations = anims.length;

  // ---- текстуры: ссылку из FBX превращаем в байты с диска -------------------
  //
  // Соседей мы не ищем и не угадываем: адрес называет сам файл, а рядом их кладёт
  // человек — тем же броском, каким уже работает `.gltf` с его пачкой. Имени файла
  // недостаточно, поэтому пробуем и относительный адрес, и просто имя: экспортёры
  // пишут `RelativeFilename` по-разному, а раскладка папок — дело автора.
  const dir = path.dirname(srcPath);
  const byFile = new Map<string, Texture | null>();
  const resolveTexture = (ref: unknown): Texture | null => {
    const file = fileOf(ref);
    if (!file) return null;
    if (byFile.has(file)) return byFile.get(file)!;

    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    const mime = MIME[ext];
    const candidates = [
      path.resolve(dir, file),
      path.resolve(dir, path.basename(file)),
    ];
    const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

    if (!found || !mime) {
      // Не нашлась рядом — или нашлась, но её формат glTF не разрешает (TGA, PSD, EXR).
      // И то и другое человек обязан узнать: молча собранная модель без карты выглядит
      // как наша работа, а на деле это правда о поставке.
      if (!note.missingTextures.includes(file)) note.missingTextures.push(file);
      byFile.set(file, null);
      return null;
    }
    const tex = doc.createTexture(path.basename(file))
      .setMimeType(mime)
      .setImage(new Uint8Array(fs.readFileSync(found)));
    byFile.set(file, tex);
    return tex;
  };

  // ---- материалы -----------------------------------------------------------
  //
  // FBX хранит материал по Фонгу или Ламберту: там есть блик и его резкость, но НЕТ
  // ни шероховатости, ни металличности — величин, на которых стоит glTF. Пересчитать
  // одно в другое нельзя, можно только придумать. Мы не придумываем: металличность 0,
  // шероховатость 1 — это «просто поверхность», то же самое, чем показался бы материал
  // без наших домыслов. Цвет, прозрачность и карты переносятся как есть, потому что они
  // в файле ЕСТЬ.
  const byMaterial = new Map<string, Material>();
  const convertMaterial = (src: unknown): Material | null => {
    const m = src as ThreeMat | null | undefined;
    if (!m || !m.uuid) return null;
    const seen = byMaterial.get(m.uuid);
    if (seen) return seen;

    const out = doc.createMaterial(m.name || '')
      .setMetallicFactor(0)
      .setRoughnessFactor(1);

    const rgb = m.color ? m.color.toArray() : [1, 1, 1];
    const alpha = typeof m.opacity === 'number' ? m.opacity : 1;
    out.setBaseColorFactor([rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, alpha]);
    if (alpha < 1) out.setAlphaMode('BLEND');

    const emissive = m.emissive ? m.emissive.toArray() : [0, 0, 0];
    if (emissive.some((v) => v > 0)) out.setEmissiveFactor([emissive[0]!, emissive[1]!, emissive[2]!]);

    const base = resolveTexture(m.map);
    if (base) out.setBaseColorTexture(base);
    const normal = resolveTexture(m.normalMap);
    if (normal) out.setNormalTexture(normal);
    const emi = resolveTexture(m.emissiveMap);
    if (emi) { out.setEmissiveTexture(emi); if (!emissive.some((v) => v > 0)) out.setEmissiveFactor([1, 1, 1]); }
    const ao = resolveTexture(m.aoMap);
    if (ao) out.setOcclusionTexture(ao);

    byMaterial.set(m.uuid, out);
    return out;
  };

  // ---- геометрия -----------------------------------------------------------
  const accessorOf = (arr: ArrayLike<number>, type: string, ints?: 'u16' | 'u32') => doc.createAccessor()
    .setType(type as never)
    .setArray(ints === 'u32' ? Uint32Array.from(arr) : ints === 'u16' ? Uint16Array.from(arr) : Float32Array.from(arr))
    .setBuffer(buffer);

  let meshCount = 0;
  const convert = (obj: ThreeObj, parent: ReturnType<Document['createNode']> | null): void => {
    const node = doc.createNode(obj.name || '');
    const [tx, ty, tz] = obj.position.toArray();
    const [rx, ry, rz, rw] = obj.quaternion.toArray();
    const [sx, sy, sz] = obj.scale.toArray();
    node.setTranslation([tx!, ty!, tz!]);
    node.setRotation([rx!, ry!, rz!, rw!]);
    node.setScale([sx!, sy!, sz!]);

    if (obj.isMesh && obj.geometry) {
      const g = obj.geometry;
      const position = g.attributes.position;
      if (position && position.count) {
        const prim = doc.createPrimitive().setMode(4);
        prim.setAttribute('POSITION', accessorOf(position.array, 'VEC3'));

        const normal = g.attributes.normal;
        if (normal && normal.count) prim.setAttribute('NORMAL', accessorOf(normal.array, 'VEC3'));

        const uv = g.attributes.uv;
        if (uv && uv.count) {
          // ОСЬ V. В glTF она отсчитывается СВЕРХУ, в FBX — снизу. three компенсирует
          // это флагом flipY на самой текстуре; мы собираем glTF напрямую, значит
          // компенсация теряется. Замер 2026-08-22 на настоящей модели (CCR1072):
          // без переворота текстуры ложились не по развёртке — Александр это и увидел.
          const flipped = Float32Array.from(uv.array);
          for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i]!;
          prim.setAttribute('TEXCOORD_0', accessorOf(flipped, 'VEC2'));
        }

        const color = g.attributes.color;
        if (color && color.count) {
          const type = TYPE_BY_SIZE[color.itemSize];
          if (type) prim.setAttribute('COLOR_0', accessorOf(color.array, type));
        }

        const idx = g.index;
        if (idx && idx.count) {
          prim.setIndices(accessorOf(idx.array, 'SCALAR', position.count > 65535 ? 'u32' : 'u16'));
        } else {
          // Без индексов примитив законен, но дальше по конвейеру индексы нужны почти
          // всем (сварка, вырожденные, Draco). Заводим прямой порядок — геометрия та же.
          const seq = new Uint32Array(position.count);
          for (let i = 0; i < seq.length; i++) seq[i] = i;
          prim.setIndices(accessorOf(seq, 'SCALAR', position.count > 65535 ? 'u32' : 'u16'));
        }

        // Материал может быть один или списком (по группам примитива). Первый берём
        // потому, что группы FBXLoader раскладывает по отдельным мешам сам.
        const mat = convertMaterial(Array.isArray(obj.material) ? obj.material[0] : obj.material);
        if (mat) prim.setMaterial(mat);

        node.setMesh(doc.createMesh(obj.name || '').addPrimitive(prim));
        meshCount++;
      }
    }

    if (parent) parent.addChild(node); else scene.addChild(node);
    for (const child of obj.children || []) convert(child, node);
  };

  for (const child of group.children || []) convert(child, null);

  if (!meshCount) throw fail('io.noGeometry', format);

  NOTES.set(doc, note);
  return doc;
}
