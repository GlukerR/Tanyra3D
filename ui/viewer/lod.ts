// ui/viewer/lod.ts — распознавание уровней детализации в загруженной сцене.
//
// ЧТО ЭТО И ЧЕГО ЗДЕСЬ НЕТ (Правило 11). Модуль только НАХОДИТ уровни и даёт показать
// один из них. Он ничего не удаляет, не перестраивает и не решает за автора, какой
// уровень «правильный». Переключение — состояние показа: скрытый уровень остаётся в
// сцене и в файле, его просто не рисуют.
//
// ТРИ СПОСОБА, КАКИМИ УРОВНИ ПРИЕЗЖАЮТ НА САМОМ ДЕЛЕ
//
// 1. Расширение `MSFT_lod`. Узел несёт список запасных, менее подробных версий себя;
//    сам узел — самый подробный. Способ правильный и однозначный. Беда одна: его почти
//    никто не экспортирует.
//
// 2. Отдельные узлы-соседи с `LOD0…LODn` в имени. Так уровни отдаёт Sketchfab — то есть
//    самый массовый источник моделей для веба. Расширения в файле нет вовсе, и любой
//    движок рисует все уровни СРАЗУ.
//
//    Замер 2026-08-15 на «Stone Well - Photogrammetry & LODs»: шесть узлов,
//    67 247 + 9 915 + 2 230 + 480 + 126 + 2 треугольника рисуются одновременно.
//    Стоят они НЕ друг в друге, а в ряд вдоль оси X — автор выложил их витриной. Сдвиг
//    лежит в `matrix` узла (чистый перенос), а не в вершинах и не в `translation`:
//    искал не там дважды, прежде чем посмотреть в матрицу.
//
// 3. Просто соседние узлы. Ни расширения, ни слова «LOD» в именах — а уровни есть.
//    Имена бывают какими угодно: `well`, `well_far`, `well_2`, `Plane.003`.
//
// ПОЧЕМУ ИМЯ БОЛЬШЕ НЕ ПРОПУСК (Александр, 2026-08-26)
//
// Его слова: «мы должны распределять не по названию их. а по размерам модели (размерам
// текстур или размерам самого меша) Только это точно определяет какой лод». И там же
// про самый грубый уровень: «у нас есть модель где колодец в конце становится просто
// плейном вдалеке. мы должны его тоже ловить и понимать как лод, хоть и габарит вообще
// стал другим».
//
// Он прав по существу: имя — это подпись, а подпись можно не поставить. Уровень
// детализации — вещь ИЗМЕРИМАЯ: та же вещь того же размера, сделанная кратно грубее.
// Поэтому решает теперь ИЗМЕРЕНИЕ, а имя осталось уликой — не пропуском.
//
//   • Имя с «LOD» у двух и более соседей — автор сам сказал, что это уровни. Меряем
//     мягко: разная подробность и совпадающий габарит.
//   • Имён нет — меряем строго (см. `оценить`). Три уровня минимум, кратная лестница
//     подробности, текстуры не растут вслед за убывающей сеткой, габарит совпадает
//     плотнее, и уровни ЗАМЕЩАЮТ друг друга — стоят в одной точке или ровным рядом.
//
// Строгость нужна не из осторожности вообще, а против одной конкретной ошибки: набор
// ЧАСТЕЙ модели — это тоже соседние узлы с геометрией. Части СКЛАДЫВАЮТСЯ в предмет и
// стоят каждая на своём месте; уровни ЗАМЕЩАЮТ друг друга и занимают одно место. Отсюда
// и проверки: они отделяют замещение от сложения, а не «уровни» от «не уровней» вообще.
//
// Догадка (и мягкая, и строгая) НИЧЕГО не меняет в файле — только предлагает посмотреть
// по одному, и интерфейс называет её догадкой (`source`).
//
// ГДЕ ЛЕЖИТ САМО ПРАВИЛО. Не здесь: в `core/lod-grouping.mts`. Тот же вопрос задаёт
// отчёт (`addons/gltf/rules.mts`), и данные у него другие — документ gltf-transform
// вместо сцены three.js. Разойдись эти два ответа, человек увидел бы переключатель
// уровней во вьюпорте и ни строчки про них в правой панели. Здесь остаётся МЕРКА:
// перевести объекты three.js в числа и вернуть решение обратно на объекты.

import * as THREE from "three";

import { groupLevels, type LodCandidate } from "../../core/lod-grouping.mjs";

/** Один уровень: что показывать и чем он отличается от соседей. */
export interface LodLevel {
  /** Подпись из файла: имя узла. Переводу не подлежит — это данные (Правило 8). */
  name: string;
  /** Треугольников в этом уровне — по ним человек и отличает уровни друг от друга. */
  triangles: number;
  /**
   * Пикселей во всех РАЗНЫХ картинках уровня.
   *
   * Вторая мера подробности, названная Александром наравне с сеткой: бывают уровни, где
   * сетка та же, а карта вчетверо меньше. Считаем по картинке, а не по слоту: одна
   * картинка в пяти слотах — это одна картинка.
   */
  texturePixels: number;
  /** Объекты сцены, которые показывает этот уровень. */
  objects: THREE.Object3D[];
}

export interface LodSet {
  /**
   * Откуда узнали. Нужно интерфейсу для честности — догадку нельзя выдавать за факт:
   *
   *   • `extension` — автор связал уровни расширением. Это ФАКТ.
   *   • `names`     — соседние узлы подписаны «LOD». Догадка, подтверждённая подписью.
   *   • `measured`  — подписи нет, узнали одним измерением. Догадка.
   */
  source: 'extension' | 'names' | 'measured';
  /** Уровни от самого подробного к самому грубому. */
  levels: LodLevel[];
}

/** Кандидат в уровни: измерения для `core/lod-grouping.mts` плюс сам объект сцены. */
interface Candidate extends LodCandidate {
  obj: THREE.Object3D;
}

const triangleCount = (root: THREE.Object3D): number => {
  let tri = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const geom = mesh.geometry;
    if (!geom || !geom.attributes || !geom.attributes.position) return;
    tri += geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
  });
  return Math.round(tri);
};

/**
 * Сколько пикселей несут картинки узла.
 *
 * Слоты не перечисляем: их состав меняется от версии three.js к версии и от расширения
 * к расширению (`diffuseTransmissionMap` появился у нас в 0.2.19). Перебираем свойства
 * материала и берём всё, что объявляет себя текстурой, — так новый слот учитывается сам.
 */
const texturePixels = (root: THREE.Object3D): number => {
  const seen = new Set<unknown>();
  let px = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as (THREE.Texture & { isTexture?: boolean }) | null;
        if (!tex || !tex.isTexture) continue;
        const img = tex.image as { width?: number; height?: number } | undefined;
        const w = img?.width || 0;
        const h = img?.height || 0;
        if (!w || !h || seen.has(img)) continue;
        seen.add(img);
        px += w * h;
      }
    }
  });
  return px;
};

/** Измерить узел целиком. `null` — геометрии в нём нет, в уровни не годится. */
function measure(obj: THREE.Object3D): Candidate | null {
  const triangles = triangleCount(obj);
  if (triangles <= 0) return null;
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    obj,
    name: obj.name || '',
    triangles,
    texturePixels: texturePixels(obj),
    // Габарит отдаём КАК ИЗМЕРЕН: сортирует его сам `core/lod-grouping.mts`, и делать
    // это дважды значило бы держать порядок сторон в двух местах.
    size: [size.x, size.y, size.z],
    center: [center.x, center.y, center.z],
  };
}

/**
 * Уровни через `MSFT_lod`.
 *
 * Загрузчик three.js расширение не читает: запасные узлы в сцену не попадают вовсе, и
 * до объектов через сцену не добраться. Поэтому уровни поднимаем из JSON и просим
 * загрузчик собрать нужные узлы отдельно — тем же `parser.getDependency`, каким это
 * делает любой плагин.
 */
async function fromExtension(gltf: {
  parser?: { json?: Record<string, unknown>; getDependency?: (t: string, i: number) => Promise<unknown> };
  scene?: THREE.Object3D;
}): Promise<LodSet | null> {
  const parser = gltf.parser;
  const json = parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  if (!parser?.getDependency || !json?.nodes) return null;

  // Узел с уровнями в этой сцене. Модель с несколькими такими узлами — законна, но
  // переключать их по отдельности значит собирать сцену, а не смотреть модель; берём
  // первый и честно об этом молчим, потому что второго в корпусе нет.
  let holder = -1;
  let ids: number[] = [];
  json.nodes.forEach((n, i) => {
    if (holder !== -1) return;
    const ext = (n.extensions as Record<string, { ids?: number[] }> | undefined)?.['MSFT_lod'];
    if (ext && Array.isArray(ext.ids) && ext.ids.length) { holder = i; ids = ext.ids; }
  });
  if (holder === -1) return null;

  const levels: LodLevel[] = [];
  for (const nodeIndex of [holder, ...ids]) {
    const obj = (await parser.getDependency('node', nodeIndex)) as THREE.Object3D | null;
    if (!obj) continue;
    levels.push({
      name: obj.name || '',
      triangles: triangleCount(obj),
      texturePixels: texturePixels(obj),
      objects: [obj],
    });
  }
  if (levels.length < 2) return null;
  return { source: 'extension', levels };
}

/**
 * Узел ли это модели — или кусок одного меша, разрезанного по материалам.
 *
 * ЗАЧЕМ. Соседний объект с геометрией — ещё не узел файла. Меш из нескольких примитивов
 * загрузчик three.js кладёт в группу и раскладывает по отдельным `THREE.Mesh` — а это
 * ОДНА вещь, разрезанная по материалам, а не набор вещей.
 *
 * Поймано на `Dirty Cube 01.glb` 2026-08-26, и поймано измерением: куб приехал тремя
 * кусками (8 + 2 + 2 треугольника, у одного нет карт вовсе), все три в одной точке и с
 * одним габаритом — то есть прошёл ВСЕ проверки строгого измерения и объявился тремя
 * уровнями. Ни одна геометрическая мера тут не помогает: куски одного меша и правда
 * стоят в одном месте и правда разной подробности. Помогает только факт из файла.
 *
 * Факт берём у загрузчика, а не переписываем: `parser.associations` помечает объект тем,
 * чем он был в glTF. Кусок меша несёт `primitives` и НЕ несёт `nodes`.
 *
 * Разметки нет (заготовка в тесте, чужой загрузчик) — не отсеиваем никого: выдумывать
 * замену факту нечем.
 */
type Association = { nodes?: number; meshes?: number; primitives?: number };

function nodeFilter(assoc?: Map<unknown, Association>): (o: THREE.Object3D) => boolean {
  if (!assoc || typeof assoc.get !== 'function') return () => true;
  return (o) => assoc.get(o)?.nodes !== undefined;
}

/**
 * Уровни как отдельные узлы-соседи. Меряем здесь, решает `core/lod-grouping.mts`.
 *
 * Подписанный набор сильнее неподписанного, поэтому обход не останавливается на первой
 * же строгой находке: подпись где-то глубже перевесит её. Наоборот — нет, подписанный
 * набор прекращает поиск сразу.
 */
function fromSiblings(scene: THREE.Object3D, isNode: (o: THREE.Object3D) => boolean): LodSet | null {
  let named: LodSet | null = null;
  let measured: LodSet | null = null;

  scene.traverse((parent) => {
    if (named) return;

    // Кандидаты — ВСЕ дети-узлы с геометрией, а не отобранные по имени. Отбор по имени
    // и был тем самым «распределением по названию».
    const cands: Candidate[] = [];
    for (const child of parent.children) {
      if (!isNode(child)) continue;
      const m = measure(child);
      if (m) cands.push(m);
    }

    const group = groupLevels(cands);
    if (!group) return;

    const set: LodSet = {
      source: group.source,
      levels: group.order.map((i) => {
        const c = cands[i]!;
        return {
          name: c.name,
          triangles: c.triangles,
          texturePixels: c.texturePixels,
          objects: [c.obj],
        };
      }),
    };
    if (group.source === 'names') named = set;
    else if (!measured) measured = set;
  });

  return named ?? measured;
}

/**
 * Найти уровни детализации в загруженной модели. `null` — их нет.
 *
 * Расширение важнее измерения: если автор связал уровни как положено, догадываться не о чем.
 */
export async function detectLods(gltf: { scene?: THREE.Object3D } & Record<string, unknown>): Promise<LodSet | null> {
  const byExtension = await fromExtension(gltf as Parameters<typeof fromExtension>[0]);
  if (byExtension) return byExtension;
  if (!gltf.scene) return null;
  const assoc = (gltf.parser as { associations?: Map<unknown, Association> } | undefined)?.associations;
  return fromSiblings(gltf.scene, nodeFilter(assoc));
}

/**
 * Показать один уровень, спрятав остальные.
 *
 * `index`:
 *   • число — показать один уровень;
 *   • `'all'` — показать все сразу (просьба Александра 2026-08-15: сравнить их наложенными
 *     друг на друга, а не по очереди);
 *   • `null` — как в файле: у соседей это все уровни, потому что именно так модель и
 *     приезжает, у расширения — только самый подробный, запасные в сцене и не лежали.
 *
 * Уровни, поднятые из расширения, подвешиваются при первом показе — загрузчик их в
 * граф не клал. Подвешиваются к КОРНЮ МОДЕЛИ, а не к сцене, и это важно: модель целиком
 * снимается при загрузке следующей, а сцена живёт всё время работы программы. Первая
 * версия добавляла в сцену — и запасные уровни переживали смену модели, продолжая
 * рисоваться поверх новой. Поймано тестом «скрытый уровень остаётся в сцене»:
 * 67 249 треугольников вместо 67 247, лишние два — уровень от прошлой модели.
 *
 * @param root корень МОДЕЛИ (`viewer.model`), а не сцена
 */
export function showLod(set: LodSet, root: THREE.Object3D, index: number | 'all' | null): void {
  set.levels.forEach((level, i) => {
    const visible = index === 'all'
      ? true
      : index === null
        ? (set.source === 'extension' ? i === 0 : true)
        : i === index;
    for (const obj of level.objects) {
      if (visible && set.source === 'extension' && !obj.parent) root.add(obj);
      obj.visible = visible;
    }
  });
}
