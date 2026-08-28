// ui/viewer/interactivity.ts — показать, какие части модели откликаются на нажатие.
//
// ЗАКАЗ (Александр, 2026-08-28): «я не вижу вообще никаких интерактивов. должен видеть.
// мы можем добавить в движок виденье интерактивных элементов?»
//
// ЧТО ЭТО И ЧЕГО ЗДЕСЬ НЕТ. Модуль ПОКАЗЫВАЕТ, где интерактив, и не исполняет его.
// Проигрывание графа поведения — интерпретатор с событиями, переменными и потоком
// управления, работа другого размера (ROADMAP §6д). Нажатие на подсвеченную часть здесь
// ничего не запускает, и обещать этого нельзя.
//
// ПОЧЕМУ РАМКАМИ, А НЕ ПОДМЕНОЙ МАТЕРИАЛА. Материал в этом вьюпорте уже занят: им
// переключаются три способа показа (сетка, глина, материалы файла). Подсветка через
// материал спорила бы с ними — человек, включивший глину, увидел бы не то, что выбрал.
// Рамка живёт отдельным объектом рядом с моделью, ничего не подменяет и снимается
// начисто.
//
// ОТКУДА БЕРЁТСЯ СПИСОК. `KHR_node_selectability` помечает узлы, на которые можно нажать.
// Загрузчик three.js этого расширения не читает — как и `KHR_interactivity`, — поэтому
// имена берём из ИСХОДНОГО JSON, а объекты сцены находим по разметке загрузчика
// (`parser.associations`: она помечает объект тем, чем он был в файле). Тот же приём, что
// у уровней детализации: факт у движка, а не догадка по именам.

import * as THREE from "three";

import { isClickable } from "../../core/interactivity-rules.mjs";

/** Часть модели, которая откликается на нажатие. */
export interface InteractivePart {
  /** Имя узла из файла. Переводу не подлежит — данные автора (Правило 8). */
  name: string;
  object: THREE.Object3D;
}

type Association = { nodes?: number };

/**
 * Найти части, помеченные нажимаемыми. Пустой список — интерактива в файле нет.
 *
 * Расширение стоит на УЗЛЕ, поэтому и ищем по узлам: `{ "selectable": true }`. Явное
 * `false` — тоже решение автора, и такой узел в список не идёт.
 */
export function findInteractive(gltf: {
  parser?: {
    json?: Record<string, unknown>;
    associations?: Map<unknown, Association>;
  };
  scene?: THREE.Object3D;
}): InteractivePart[] {
  const json = gltf.parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  const assoc = gltf.parser?.associations;
  if (!json?.nodes || !assoc || !gltf.scene) return [];

  // Правило «что считается нажимаемым» общее с движком (`core/interactivity-rules.mts`):
  // разойдись они — отчёт и окно назовут разные числа, как это уже случилось с MagicBall.
  const нажимаемые = new Set<number>();
  json.nodes.forEach((node, i) => {
    if (isClickable(node['extensions'])) нажимаемые.add(i);
  });
  if (!нажимаемые.size) return [];

  const parts: InteractivePart[] = [];
  gltf.scene.traverse((obj) => {
    const at = assoc.get(obj)?.nodes;
    if (at === undefined || !нажимаемые.has(at)) return;
    parts.push({ name: obj.name || (json.nodes?.[at]?.['name'] as string) || '', object: obj });
  });
  return parts;
}

/**
 * Рамки вокруг нажимаемых частей — то, что человек видит.
 *
 * Объект-хранитель один на всю модель: снять подсветку значит снять его, и в сцене не
 * остаётся ни следа. Считается вспомогательным (`isHelper`), чтобы обходы, считающие
 * геометрию модели, его не приняли за часть модели.
 */
export class InteractivityHighlight extends THREE.Group {
  readonly isHelper = true;

  constructor(parts: readonly InteractivePart[], color = 0x4ade80) {
    super();
    this.name = 'InteractivityHighlight';
    for (const part of parts) {
      const box = new THREE.BoxHelper(part.object, color);
      // Рамка не должна прятаться внутри модели: её задача — быть видной.
      const material = box.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      material.opacity = 0.9;
      box.renderOrder = 999;
      this.add(box);
    }
  }

  /** Освободить рамки. Сцена живёт всё время работы, мусор в ней копится молча. */
  dispose(): void {
    for (const child of this.children) {
      const box = child as THREE.BoxHelper;
      box.geometry?.dispose();
      (box.material as THREE.Material | undefined)?.dispose();
    }
    this.clear();
  }
}
