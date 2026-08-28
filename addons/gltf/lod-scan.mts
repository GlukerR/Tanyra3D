// addons/gltf/lod-scan.mts — поиск уровней детализации в документе, для отчёта.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ВЬЮПОРТА И ЗАЧЕМ ВООБЩЕ.
//
// Уровни приезжают тремя способами (полный разбор — `ui/viewer/lod.ts`), и только один
// из них файл объявляет открыто: `MSFT_lod`. Остальные два — просто соседние узлы: у
// Sketchfab подписанные «LOD», у прочих не подписанные никак. Отчёт до 2026-08-28 видел
// ровно расширение и молчал про остальные — то есть про самый частый случай.
//
// Молчал он при этом РАЗДЕЛЬНО с вьюпортом: переключатель уровней над моделью появлялся,
// а в правой панели не было ни строчки. Один вопрос — два разных ответа в двух местах,
// ровно то, что запрещают Правила интерфейса §1.
//
// Поэтому РЕШЕНИЕ здесь не принимается: его принимает `core/lod-grouping.mts`, общий с
// вьюпортом. Здесь только МЕРКА — перевести документ gltf-transform в те же числа, какие
// вьюпорт снимает со сцены three.js.
//
// ПОЧЕМУ ЧИСЛА МОГУТ РАСХОДИТЬСЯ НА ЕДИНИЦЫ. Вьюпорт меряет ЗАГРУЖЕННУЮ сцену: загрузчик
// уже развернул инстансы и разрезал меши по материалам. Документ — то, что лежит в файле.
// Правило одно, данные разные; на порядок величин это не влияет, а на равенство
// треугольников до штуки — может. Сверять их между собой нечем и незачем.

import * as gltfCore from '@gltf-transform/core';

import { groupLevels, type LodCandidate } from '../../core/lod-grouping.mjs';

import type { Document, Material, Node, Texture } from '@gltf-transform/core';

export interface LodScan {
  /** `names` — соседи подписаны «LOD»; `measured` — подписи нет, решило измерение. */
  source: 'names' | 'measured';
  /** У скольких узлов найдена лестница уровней. «В файле 47 уровней» ничего не значит. */
  nodes: number;
  /** Самая длинная найденная лестница. */
  levels: number;
}

/** Обойти узел вместе с потомками. */
function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of node.listChildren()) walk(child, visit);
}

/**
 * Какие картинки у какого материала.
 *
 * Идём ОТ ТЕКСТУРЫ к материалу (`listParents`), а не перечисляем слоты материала по
 * именам. Именной список пришлось бы дополнять при каждом новом расширении — и его
 * забыли бы дополнить, как уже было с таблицей назначений карт (аудит Ф2, 2026-08-25).
 */
function materialTextures(doc: Document): Map<Material, Set<Texture>> {
  const map = new Map<Material, Set<Texture>>();
  for (const tex of doc.getRoot().listTextures()) {
    for (const parent of tex.listParents()) {
      if (parent.propertyType !== 'Material') continue;
      const mat = parent as Material;
      let set = map.get(mat);
      if (!set) { set = new Set(); map.set(mat, set); }
      set.add(tex);
    }
  }
  return map;
}

/** Треугольников в узле вместе с потомками. Считается по счётчикам, данные не читаются. */
function triangles(node: Node): number {
  let tri = 0;
  walk(node, (n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
      tri += count / 3;
    }
  });
  return Math.round(tri);
}

/** Пикселей во всех РАЗНЫХ картинках узла: одна картинка в пяти слотах — одна картинка. */
function texturePixels(node: Node, byMaterial: Map<Material, Set<Texture>>): number {
  const seen = new Set<Texture>();
  let px = 0;
  walk(node, (n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      for (const tex of byMaterial.get(mat) ?? []) {
        if (seen.has(tex)) continue;
        seen.add(tex);
        const size = tex.getSize();
        if (size) px += size[0] * size[1];
      }
    }
  });
  return px;
}

/** Габарит и середина узла в общих координатах. `null` — измерить не вышло. */
function box(node: Node): { size: [number, number, number]; center: [number, number, number] } | null {
  if (typeof gltfCore.getBounds !== 'function') return null;
  let bounds;
  try { bounds = gltfCore.getBounds(node); } catch { return null; }
  const { min, max } = bounds;
  if (!min || !max) return null;
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!size.every((v) => Number.isFinite(v))) return null;
  return {
    size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/**
 * Найти уровни детализации среди соседних узлов. `null` — их нет.
 *
 * Считаем УЗЛЫ с уровнями и самую длинную лестницу, а не сумму по всем: «в файле
 * 47 уровней» ничего не значит, а «у 12 частей до 3 уровней» — значит.
 */
export function scanLods(doc: Document): LodScan | null {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;

  const byMaterial = materialTextures(doc);
  const triCache = new Map<Node, number>();
  const triOf = (n: Node) => {
    let v = triCache.get(n);
    if (v === undefined) { v = triangles(n); triCache.set(n, v); }
    return v;
  };

  let nodes = 0;
  let levels = 0;
  let named = false;

  const consider = (children: Node[]) => {
    // Габариты читают ВЕРШИНЫ, а это единственная дорогая часть проверки. Поэтому
    // сначала дешёвый отсев по счётчику треугольников: у одиночки соседей нет, и мерить
    // нечего.
    const withGeometry = children.filter((c) => triOf(c) > 0);
    if (withGeometry.length < 2) return;

    const cands: LodCandidate[] = [];
    for (const child of withGeometry) {
      const b = box(child);
      if (!b) return; // не измерили один — не судим весь набор
      cands.push({
        name: child.getName() || '',
        triangles: triOf(child),
        texturePixels: texturePixels(child, byMaterial),
        size: b.size,
        center: b.center,
      });
    }

    const group = groupLevels(cands);
    if (!group) return;
    nodes++;
    levels = Math.max(levels, group.order.length);
    if (group.source === 'names') named = true;
  };

  consider(scene.listChildren());
  for (const child of scene.listChildren()) walk(child, (n) => consider(n.listChildren()));

  if (!nodes) return null;
  // Подписанный набор сильнее: он подтверждён словом автора, а не одним измерением.
  return { source: named ? 'names' : 'measured', nodes, levels };
}
