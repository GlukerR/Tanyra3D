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

import * as THREE from "three";

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

/** Кандидат в уровни: узел вместе со всем, что о нём измерено. */
interface Candidate {
  obj: THREE.Object3D;
  name: string;
  triangles: number;
  texturePixels: number;
  /** Габарит по убыванию: [самая длинная сторона, средняя, самая короткая]. */
  size: [number, number, number];
  center: THREE.Vector3;
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Насколько грубее обязан быть следующий уровень при СТРОГОМ измерении.
 *
 * Двойка — не «красивое число», а граница между двумя разными вещами. Уровень
 * детализации делают кратно грубее, иначе он не экономит ничего: у Stone Well шаги
 * 6.8×, 4.4×, 4.6×, 3.8×, 63×. А соседние ЧАСТИ одного предмета отличаются подробностью
 * случайно и понемногу — переднее колесо от заднего на проценты. Требование кратности
 * отсекает «части», не трогая настоящие уровни.
 */
const STEP = 2;

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
  return {
    obj,
    name: obj.name || '',
    triangles,
    texturePixels: texturePixels(obj),
    size: [size.x, size.y, size.z].sort((a, b) => b - a) as [number, number, number],
    center: box.getCenter(new THREE.Vector3()),
  };
}

// Имя уровня: LOD3, lod_3, Stone_Well_LOD3_1. Номер вытаскиваем, но ПОРЯДКОМ он не
// служит: у автора Stone Well `LOD0` — самый грубый, а бывает и наоборот. Порядок
// решается подробностью — измеримым фактом, а не соглашением об именах.
const LOD_NAME = /(?:^|[^a-z])lod[_\s-]?(\d+)/i;

/**
 * Уровни ЗАМЕЩАЮТ друг друга, а части СКЛАДЫВАЮТСЯ. Это и проверяем.
 *
 * Два законных расположения, и оба встречаются в живых файлах:
 *
 *   • в одной точке — уровни надеты друг на друга, как их и рисует движок;
 *   • ровным рядом — автор выложил их витриной, чтобы сравнить (замер на Stone Well
 *     2026-08-15: перенос 1.5, 3, 4.5, 6, 7.5 вдоль X).
 *
 * Ряд проверяем по РОВНОСТИ шага и только по одной оси. Части предмета тоже стоят
 * каждая на своём месте, но их места — не арифметическая прогрессия вдоль оси.
 *
 * @param span самая длинная сторона самого подробного уровня — мерка допуска
 */
function placedAsLevels(centers: THREE.Vector3[], span: number): boolean {
  const slack = span * 0.2;
  const spread = AXES.map((a) => {
    const v = centers.map((c) => c[a]);
    return Math.max(...v) - Math.min(...v);
  });

  if (spread.every((s) => s <= slack)) return true; // все в одной точке

  const wide = spread.filter((s) => s > slack);
  if (wide.length !== 1) return false; // разъехались по двум осям — это раскладка частей
  const axis = AXES[spread.indexOf(wide[0]!)]!;

  // Ряд сортируем ПО КООРДИНАТЕ, а не по подробности: у Sketchfab порядок выкладки свой
  // (`Stone_Well_LOD5_5`, `Stone_Well_LOD0_3`) и с порядком уровней не совпадает.
  const line = centers.map((c) => c[axis]).sort((a, b) => a - b);
  const steps: number[] = [];
  for (let i = 1; i < line.length; i++) steps.push(line[i]! - line[i - 1]!);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  if (!(mean > 0)) return false;
  return steps.every((s) => Math.abs(s - mean) <= mean * 0.25);
}

/**
 * Решить, уровни ли это, и выстроить их от подробного к грубому.
 *
 * @param strict подписи «LOD» в именах нет — меры те же, требования выше
 */
function оценить(cands: Candidate[], strict: boolean): LodLevel[] | null {
  // Двух уровней хватает, когда автор их подписал. Без подписи двух мало: «крупная
  // часть плюс мелкая» встречается в любой модели, а лестница из трёх ступеней случайно
  // не складывается.
  if (cands.length < (strict ? 3 : 2)) return null;

  // Порядок — по подробности: сначала сетка, при равной сетке — картинки. Имя в порядке
  // не участвует вовсе.
  const order = [...cands].sort(
    (a, b) => b.triangles - a.triangles || b.texturePixels - a.texturePixels,
  );

  // (1) Уровни обязаны РАЗЛИЧАТЬСЯ подробностью. Одинаковые куски — это части модели
  //     (четыре колеса), а не её версии.
  const seen = new Set(order.map((c) => c.triangles + '/' + c.texturePixels));
  if (seen.size !== order.length) return null;

  const ref = order[0]!;
  if (!ref.size[0]) return null;

  if (strict) {
    for (let i = 1; i < order.length; i++) {
      const выше = order[i - 1]!;
      const ниже = order[i]!;

      // (2) Кратная лестница. Считаем по той мере, которая изменилась: сетка та же —
      //     значит уровень отличается картинками, и кратность спрашиваем с них.
      const step = выше.triangles === ниже.triangles
        ? (ниже.texturePixels ? выше.texturePixels / ниже.texturePixels : Infinity)
        : (ниже.triangles ? выше.triangles / ниже.triangles : Infinity);
      if (step < STEP) return null;

      // (3) Обе меры смотрят в одну сторону. Узел с более грубой сеткой, но БОЛЬШЕЙ
      //     картинкой — не огрубление той же вещи, а другая вещь.
      if (ниже.texturePixels > выше.texturePixels) return null;
    }
  }

  // (4) Одна и та же вещь — значит совпадает ПО РАЗМЕРУ. Именно по размеру, а не по
  //     месту: место проверяет `placedAsLevels`.
  //
  // Сравниваем САМУЮ ДЛИННУЮ сторону — и только её. Остальные проверять нельзя, и это
  // тот же замер на Stone Well: самый грубый уровень оказался плоским биллбордом
  // 1.282 × 0.719 × 0.000 против 1.302 × 0.705 × 1.302 у подробного. Схлопнулась не
  // «третья» сторона, а одна из двух горизонтальных: силуэт колодца сохранён, объём
  // выброшен целиком. Так и работает огрубление до плоскости («колодец в конце
  // становится просто плейном вдалеке»), и требовать от него сохранности второго
  // габарита значит не узнавать самый грубый уровень никогда.
  //
  // Вторую сторону всё же держим — но односторонне: ей позволено СХЛОПНУТЬСЯ и
  // запрещено вырасти. Уровень, который стал ШИРЕ подробного, — уже не огрубление.
  const tol = strict ? 0.1 : 0.2;
  for (const c of order) {
    const longestMatches = Math.abs(c.size[0] - ref.size[0]) <= Math.max(c.size[0], ref.size[0]) * tol;
    if (!longestMatches) return null;
    if (c.size[1] > ref.size[1] * (1 + tol)) return null;
  }

  // (5) Замещение, а не сложение.
  if (strict && !placedAsLevels(order.map((c) => c.center), ref.size[0])) return null;

  return order.map((c) => ({
    name: c.name,
    triangles: c.triangles,
    texturePixels: c.texturePixels,
    objects: [c.obj],
  }));
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
 * Уровни как отдельные узлы-соседи: измерением, а имя — только улика.
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
    if (cands.length < 2) return;

    const подписанные = cands.filter((c) => LOD_NAME.test(c.name));
    if (подписанные.length >= 2) {
      const levels = оценить(подписанные, false);
      if (levels) { named = { source: 'names', levels }; return; }
    }

    if (!measured) {
      const levels = оценить(cands, true);
      if (levels) measured = { source: 'measured', levels };
    }
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
