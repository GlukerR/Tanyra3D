// ui/viewer/lod.ts — распознавание уровней детализации в загруженной сцене.
//
// ЧТО ЭТО И ЧЕГО ЗДЕСЬ НЕТ (Правило 11). Модуль только НАХОДИТ уровни и даёт показать
// один из них. Он ничего не удаляет, не перестраивает и не решает за автора, какой
// уровень «правильный». Переключение — состояние показа: скрытый уровень остаётся в
// сцене и в файле, его просто не рисуют.
//
// ДВА СПОСОБА, КАКИМИ УРОВНИ ПРИЕЗЖАЮТ НА САМОМ ДЕЛЕ
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
//    Стоят они НЕ друг в друге, а в ряд вдоль оси X — автор выложил их витриной, и
//    сдвиг запечён в вершины, а не в трансформы узлов. Поправка к первому впечатлению:
//    по JSON у всех шести узлов трансформа нет, и я сперва принял это за общую точку.
//
// Второй случай распознаётся по имени, и это единственная зацепка, какая есть. Чтобы
// догадка не превратилась в решение за автора, она обставлена условиями (см. `siblings`)
// и НИЧЕГО не меняет в файле — только предлагает посмотреть по одному.

import * as THREE from "three";

/** Один уровень: что показывать и чем он отличается от соседей. */
export interface LodLevel {
  /** Подпись из файла: имя узла. Переводу не подлежит — это данные (Правило 8). */
  name: string;
  /** Треугольников в этом уровне — по ним человек и отличает уровни друг от друга. */
  triangles: number;
  /** Объекты сцены, которые показывает этот уровень. */
  objects: THREE.Object3D[];
}

export interface LodSet {
  /** Откуда узнали: расширение или имена соседних узлов. Нужно интерфейсу для честности. */
  source: 'extension' | 'names';
  /** Уровни от самого подробного к самому грубому. */
  levels: LodLevel[];
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

// Имя уровня: LOD3, lod_3, Stone_Well_LOD3_1. Номер вытаскиваем, но ПОРЯДКОМ он не
// служит: у автора Stone Well `LOD0` — самый грубый, а бывает и наоборот. Порядок
// решается числом треугольников — измеримым фактом, а не соглашением об именах.
const LOD_NAME = /(?:^|[^a-z])lod[_\s-]?(\d+)/i;

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
    levels.push({ name: obj.name || '', triangles: triangleCount(obj), objects: [obj] });
  }
  if (levels.length < 2) return null;
  return { source: 'extension', levels };
}

/**
 * Уровни как отдельные узлы-соседи с LOD в имени.
 *
 * Три условия, и все обязательны. Без них догадка стала бы решением за автора — а по
 * Правилу 11 мы не решаем: набор частей с «LOD» в названии вполне может быть просто
 * набором частей.
 *
 *   1. Минимум два соседа с номером в имени — один «LOD» ни о чём не говорит.
 *   2. Числа треугольников РАЗНЫЕ. Уровень детализации на то и уровень, что отличается
 *      подробностью; одинаковые куски — это части модели, а не её версии.
 *   3. Габарит совпадает по самой длинной стороне. Уровни — одна и та же вещь разной
 *      подробности; МЕСТО при этом может быть разным (см. замер в теле функции).
 */
function fromSiblings(scene: THREE.Object3D): LodSet | null {
  let best: LodSet | null = null;

  scene.traverse((parent) => {
    if (best) return;
    const candidates = parent.children.filter((c) => LOD_NAME.test(c.name || ''));
    if (candidates.length < 2) return;

    const levels = candidates
      .map((obj) => ({ name: obj.name || '', triangles: triangleCount(obj), objects: [obj] }))
      .filter((l) => l.triangles > 0);
    if (levels.length < 2) return;

    // (2) подробность обязана различаться
    if (new Set(levels.map((l) => l.triangles)).size !== levels.length) return;

    levels.sort((a, b) => b.triangles - a.triangles);

    // (3) уровни — одна и та же вещь, значит совпадают ПО РАЗМЕРУ.
    //
    // Именно по размеру, а не по месту. Замер на Stone Well 2026-08-15: автор разложил
    // шесть уровней В РЯД вдоль оси X (−0.65…0.65, 0.85…2.15, 2.35…3.65 и так далее),
    // причём сдвиг запечён в вершины, а не в трансформы узлов — у всех шести узлов
    // трансформа нет вовсе. Требовать общего места значило бы не узнать этот случай,
    // а он у фотограмметрии обычный: уровни выкладывают витриной, чтобы сравнить.
    //
    // Сравниваем САМУЮ ДЛИННУЮ сторону — и только её. Остальные проверять нельзя, и это
    // тот же замер: самый грубый уровень оказался плоским биллбордом
    // 1.282 × 0.719 × 0.000 против 1.302 × 0.705 × 1.302 у подробного. Схлопнулась не
    // «третья» сторона, а одна из двух горизонтальных: силуэт колодца сохранён, объём
    // выброшен целиком. Так и работает огрубление до плоскости, и требовать от него
    // сохранности второго габарита значит не узнавать самый грубый уровень никогда.
    //
    // Вторую сторону всё же держим — но односторонне: ей позволено СХЛОПНУТЬСЯ и
    // запрещено вырасти. Уровень, который стал ШИРЕ подробного, — уже не огрубление.
    const sizeOf = (o: THREE.Object3D) => {
      const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      return [s.x, s.y, s.z].sort((a, b) => b - a); // по убыванию
    };
    const ref = sizeOf(levels[0]!.objects[0]!);
    if (!ref[0]) return;

    const sameThing = levels.every((l) => {
      const s = sizeOf(l.objects[0]!);
      const longestMatches = Math.abs(s[0]! - ref[0]!) <= Math.max(s[0]!, ref[0]!) * 0.2;
      const notWider = s[1]! <= ref[1]! * 1.2;
      return longestMatches && notWider;
    });
    if (!sameThing) return;

    best = { source: 'names', levels };
  });

  return best;
}

/**
 * Найти уровни детализации в загруженной модели. `null` — их нет.
 *
 * Расширение важнее имён: если автор связал уровни как положено, догадываться не о чем.
 */
export async function detectLods(gltf: { scene?: THREE.Object3D } & Record<string, unknown>): Promise<LodSet | null> {
  const byExtension = await fromExtension(gltf as Parameters<typeof fromExtension>[0]);
  if (byExtension) return byExtension;
  return gltf.scene ? fromSiblings(gltf.scene) : null;
}

/**
 * Показать один уровень, спрятав остальные.
 *
 * `index === null` — вернуть как в файле: у соседей это ВСЕ уровни сразу (именно так
 * модель и приезжает, и человек вправе увидеть, что там на самом деле), у расширения —
 * только самый подробный, потому что запасные в сцене и не лежали.
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
export function showLod(set: LodSet, root: THREE.Object3D, index: number | null): void {
  set.levels.forEach((level, i) => {
    const visible = index === null
      ? (set.source === 'names' ? true : i === 0)
      : i === index;
    for (const obj of level.objects) {
      if (visible && set.source === 'extension' && !obj.parent) root.add(obj);
      obj.visible = visible;
    }
  });
}
