/**
 * addons/gltf/import-obj.mts — OBJ на вход.
 *
 * ЗАКАЗ. Александр называл три формата разом: «фбикс стл обджи на загрузке». FBX и STL
 * сделаны раньше, OBJ — последний из тройки.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ, а не строкой рядом с STL и PLY. Те несут голую геометрию, и
 * сборка документа для них — три десятка строк. OBJ несёт развёртку, несколько частей,
 * имена материалов и ссылку на СОСЕДНИЙ файл `.mtl`, где лежат сами материалы. Это ближе
 * к FBX, чем к STL, и живёт по его образцу.
 *
 * ПРАВО ЭТО ДЕЛАТЬ. `OBJLoader` — часть three.js (0.185.1, MIT), которая у нас уже есть;
 * новой зависимости не появляется. В отличие от FBX формат ОТКРЫТ и прост: текстовые
 * строки `v`, `vt`, `vn`, `f`. Проба в Node прошла без единого браузерного вызова.
 *
 * `.mtl` РАЗБИРАЕМ САМИ, а `MTLLoader` не берём. Причина техническая и решающая:
 * `MTLLoader.preload()` создаёт материалы three.js и зовёт `TextureLoader`, а тот в Node
 * лезет в `document.createElementNS`. У FBX это обходится подменой менеджера загрузки, но
 * здесь обходить нечего: `.mtl` — плоский текстовый формат в дюжину ключей, и свой
 * читатель на двадцать строк честнее, чем заглушки вокруг чужого.
 *
 * ЧЕГО НЕ ВЫДУМЫВАЕМ (Правило 11). В `.mtl` нет ни шероховатости, ни металличности —
 * формат старше этих понятий. Пересчитывать в них блеск `Ns` мы не будем: получилось бы
 * число, которого автор не писал, а отчёт назвал бы его свойством модели. Не сказано —
 * значит не сказано; glTF подставит своё умолчание, и это честнее выдумки.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Document, type Material, type Texture } from '@gltf-transform/core';
import { emptyNote, setImportNote, type ImportNote } from './import-notes.mjs';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MIME, TYPE_BY_SIZE } from './media.mjs';

/** MIME по расширению. Чего glTF не разрешает — не называем, такие карты не переносятся. */

/** Что мы вычитываем из `.mtl`. Всё остальное автор пусть хранит — мы это не трогаем. */
interface MtlEntry {
  /** `Kd` — диффузный цвет. Работа автора, переносится в baseColorFactor. */
  diffuse?: [number, number, number];
  /** `d` или `1 - Tr` — непрозрачность. */
  alpha?: number;
  /** `map_Kd` — карта цвета. Имя файла как его написал автор. */
  mapDiffuse?: string;
  /** `map_Bump` / `bump` / `norm` — карта рельефа. */
  mapNormal?: string;
  /** `map_Ke` — карта свечения. */
  mapEmissive?: string;
  /** `Ke` — цвет свечения. */
  emissive?: [number, number, number];
}

/**
 * Прочитать `.mtl`. Формат построчный: `newmtl <имя>` открывает запись, дальше её поля.
 *
 * Регистр ключей в живых файлах гуляет (`map_Kd`, `map_kd`), поэтому сравниваем в нижнем.
 * Незнакомая строка молча пропускается: `.mtl` расширяли кто во что горазд, и падать на
 * чужом ключе значило бы не принять файл из-за поля, которое нам и не нужно.
 */
function parseMtl(text: string): Map<string, MtlEntry> {
  const out = new Map<string, MtlEntry>();
  let cur: MtlEntry | null = null;
  const nums = (parts: string[]): [number, number, number] | undefined => {
    const v = parts.map(Number).filter((n) => Number.isFinite(n));
    return v.length >= 3 ? [v[0]!, v[1]!, v[2]!] : undefined;
  };
  // Имя карты — ПОСЛЕДНЕЕ слово строки, а не второе: перед ним стоят необязательные
  // ключи (`map_Kd -s 1 1 1 wood.png`). Иначе картой оказался бы «-s».
  const file = (parts: string[]): string | undefined => {
    const last = parts[parts.length - 1];
    return last && !last.startsWith('-') ? last : undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = (parts.shift() || '').toLowerCase();
    if (key === 'newmtl') {
      cur = {};
      out.set(parts.join(' '), cur);
      continue;
    }
    if (!cur) continue;
    if (key === 'kd') { const c = nums(parts); if (c) cur.diffuse = c; }
    else if (key === 'ke') { const c = nums(parts); if (c) cur.emissive = c; }
    else if (key === 'd') { const n = Number(parts[0]); if (Number.isFinite(n)) cur.alpha = n; }
    else if (key === 'tr') { const n = Number(parts[0]); if (Number.isFinite(n)) cur.alpha = 1 - n; }
    else if (key === 'map_kd') { const f = file(parts); if (f) cur.mapDiffuse = f; }
    else if (key === 'map_bump' || key === 'bump' || key === 'norm') { const f = file(parts); if (f) cur.mapNormal = f; }
    else if (key === 'map_ke') { const f = file(parts); if (f) cur.mapEmissive = f; }
  }
  return out;
}

/** Имена файлов `.mtl`, названные в самом OBJ. Их может быть несколько. */
function mtlLibs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*mtllib\s+(.+)$/gim)) {
    for (const name of m[1]!.trim().split(/\s+/)) if (name) out.push(name);
  }
  return out;
}

/** Атрибут геометрии three.js. */
interface Attr { array: ArrayLike<number>; itemSize: number; count: number }
interface ObjGeometry {
  attributes: Record<string, Attr | undefined>;
  groups: Array<{ start: number; count: number; materialIndex?: number }>;
}
interface ObjMesh {
  isMesh?: boolean;
  name?: string;
  geometry: ObjGeometry;
  material: { name?: string } | Array<{ name?: string }>;
}


/**
 * Разобрать OBJ и отдать документ glTF.
 *
 * @param srcPath     путь к файлу — нужен, чтобы найти `.mtl` и карты РЯДОМ с моделью
 * @param buf         байты файла
 * @param importError фабрика человеческих отказов (живёт в importers.mts)
 */
export function importObj(
  srcPath: string,
  buf: ArrayBuffer,
  importError: (messageId: string, format: string) => Error,
): Document {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));

  let root: { traverse(fn: (o: unknown) => void): void };
  try {
    root = new OBJLoader().parse(text) as never;
  } catch (e) {
    const err = importError('io.unreadable', 'OBJ');
    err.cause = e;
    throw err;
  }

  const meshes: ObjMesh[] = [];
  root.traverse((o) => { if ((o as ObjMesh).isMesh) meshes.push(o as ObjMesh); });
  if (!meshes.length) throw importError('io.noGeometry', 'OBJ');

  const dir = path.dirname(srcPath);
  const note: ImportNote = emptyNote();

  // Материалы из соседнего `.mtl`. Нет файла — не беда: у OBJ он необязателен, а имена
  // `usemtl` остаются, и части модели сохранят своё деление.
  const mtl = new Map<string, MtlEntry>();
  for (const lib of mtlLibs(text)) {
    const file = path.join(dir, lib);
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { note.missingTextures.push(lib); continue; }
    for (const [name, entry] of parseMtl(content)) mtl.set(name, entry);
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);

  const textures = new Map<string, Texture | null>();
  /** Карта по имени файла из `.mtl`. null — файла нет рядом или формат не для glTF. */
  const textureOf = (name: string): Texture | null => {
    if (textures.has(name)) return textures.get(name)!;
    let tex: Texture | null = null;
    const file = path.join(dir, name.split('\\').join('/'));
    const ext = path.extname(file).toLowerCase().replace(/^\./, '');
    if (MIME[ext] && fs.existsSync(file)) {
      tex = doc.createTexture(path.basename(file))
        .setMimeType(MIME[ext]!)
        .setImage(new Uint8Array(fs.readFileSync(file)));
    } else if (!note.missingTextures.includes(name)) {
      // Формат, которого glTF не принимает (`.tga`, `.psd`), и отсутствующий файл — для
      // человека одно и то же: карта названа, а на модели её не будет. Скажем об этом
      // один раз строкой отчёта, а не промолчим.
      note.missingTextures.push(name);
    }
    textures.set(name, tex);
    return tex;
  };

  const materials = new Map<string, Material>();
  const materialOf = (name: string): Material | null => {
    if (!name) return null;
    const have = materials.get(name);
    if (have) return have;
    const entry = mtl.get(name);
    const mat = doc.createMaterial(name);
    if (entry) {
      const [r, g, b] = entry.diffuse || [1, 1, 1];
      const a = entry.alpha != null ? entry.alpha : 1;
      if (entry.diffuse || entry.alpha != null) mat.setBaseColorFactor([r, g, b, a]);
      if (a < 1) mat.setAlphaMode('BLEND');
      if (entry.emissive) mat.setEmissiveFactor(entry.emissive);
      // Карта цвета отменяет множитель: в glTF они ПЕРЕМНОЖАЮТСЯ, и `Kd` тёмного оттенка
      // погасил бы приложенную картинку (тот же дефект, что был с чёрным материалом из
      // Blender, — см. import-textures.mts).
      if (entry.mapDiffuse) {
        const tex = textureOf(entry.mapDiffuse);
        if (tex) { mat.setBaseColorTexture(tex); mat.setBaseColorFactor([1, 1, 1, a]); }
      }
      if (entry.mapNormal) { const t = textureOf(entry.mapNormal); if (t) mat.setNormalTexture(t); }
      if (entry.mapEmissive) {
        const t = textureOf(entry.mapEmissive);
        if (t) { mat.setEmissiveTexture(t); mat.setEmissiveFactor(entry.emissive || [1, 1, 1]); }
      }
    }
    materials.set(name, mat);
    return mat;
  };

  /**
   * Один примитив из куска геометрии.
   *
   * OBJLoader отдаёт геометрию БЕЗ индексов — по три вершины на треугольник подряд.
   * Поэтому `start` и `count` группы считаются прямо в вершинах, и кусок берётся срезом.
   */
  const primitiveFrom = (geom: ObjGeometry, start: number, count: number, matName: string) => {
    const prim = doc.createPrimitive().setMode(4);
    const add = (semantic: string, attr: Attr | undefined, flipV = false) => {
      if (!attr || !attr.count) return;
      const type = TYPE_BY_SIZE[attr.itemSize];
      if (!type) return;
      const size = attr.itemSize;
      const slice = new Float32Array(count * size);
      for (let i = 0; i < count * size; i++) slice[i] = Number(attr.array[start * size + i]);
      // Развёртку ПЕРЕВОРАЧИВАЕМ. В OBJ начало отсчёта V внизу картинки, в glTF —
      // наверху. Без переворота карта ложится вверх ногами, и по числам это не видно
      // никак: треугольники, материалы и текстуры на месте, неверна только картинка.
      if (flipV) for (let i = 1; i < slice.length; i += 2) slice[i] = 1 - slice[i]!;
      prim.setAttribute(semantic, doc.createAccessor(semantic)
        .setType(type as never).setArray(slice).setBuffer(buffer));
    };
    add('POSITION', geom.attributes.position);
    add('NORMAL', geom.attributes.normal);
    add('TEXCOORD_0', geom.attributes.uv, true);
    add('COLOR_0', geom.attributes.color);
    const mat = materialOf(matName);
    if (mat) prim.setMaterial(mat);
    return prim;
  };

  let index = 0;
  for (const m of meshes) {
    const geom = m.geometry;
    const position = geom.attributes.position;
    if (!position || !position.count) continue;
    const names = Array.isArray(m.material) ? m.material.map((x) => x?.name || '') : [m.material?.name || ''];
    const mesh = doc.createMesh(m.name || `mesh_${++index}`);

    // Части с РАЗНЫМИ материалами — разные примитивы. Свести их в один значило бы
    // потерять деление, которое автор задал строками `usemtl`.
    const groups = geom.groups && geom.groups.length
      ? geom.groups
      : [{ start: 0, count: position.count, materialIndex: 0 }];
    for (const g of groups) {
      if (!g.count) continue;
      mesh.addPrimitive(primitiveFrom(geom, g.start, g.count, names[g.materialIndex || 0] || ''));
    }
    if (!mesh.listPrimitives().length) continue;
    scene.addChild(doc.createNode(m.name || mesh.getName()).setMesh(mesh));
  }

  if (!doc.getRoot().listMeshes().length) throw importError('io.noGeometry', 'OBJ');

  setImportNote(doc, note);
  return doc;
}
