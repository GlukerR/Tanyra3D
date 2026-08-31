// ui/viewer/interactivity.ts — показать, какие части модели откликаются на нажатие.
//
// ЗАКАЗ (Александр, 2026-08-28): «я не вижу вообще никаких интерактивов. должен видеть.
// мы можем добавить в движок виденье интерактивных элементов?»
//
// ЧТО ЭТО И ЧЕГО ЗДЕСЬ НЕТ. Модуль ПОКАЗЫВАЕТ, где интерактив, и держит показ в согласии
// с файлом: обводит нажимаемое, прячет спрятанное автором, ведёт рамки за деталями.
// Исполняет граф поведения СОСЕД — `interactivity-graph.ts` с `interactivity-runtime.ts`;
// сюда его логика не заходит, здесь только глаза.
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

import { isClickable, isHiddenInFile } from "../../core/interactivity-rules.mjs";

/** Виден ли предок: `visible` у самого объекта ничего не знает о родителях. */
function hiddenByParent(obj: THREE.Object3D): boolean {
  for (let p = obj.parent; p; p = p.parent) if (!p.visible) return true;
  return false;
}

/** Часть модели, которая откликается на нажатие. */
export interface InteractivePart {
  /** Имя узла из файла. Переводу не подлежит — данные автора (Правило 8). */
  name: string;
  /** Номер узла в файле: им граф поведения и называет, на что нажали. */
  nodeIndex: number;
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
    parts.push({
      name: obj.name || (json.nodes?.[at]?.['name'] as string) || '',
      nodeIndex: at,
      object: obj,
    });
  });
  return parts;
}

/**
 * Спрятать узлы, спрятанные автором в файле (`KHR_node_visibility`).
 *
 * Загрузчик three.js этого расширения не читает и показывает всё подряд. Возвращаем
 * число спрятанных: ноль — расширения в файле нет либо всё в нём видимое.
 *
 * ЭТО НЕ ПРАВКА МОДЕЛИ. Мы приводим ПОКАЗ к тому, что записано в файле, — ровно как с
 * уровнями детализации: спрятанный узел остаётся в сцене и в собранном файле, его просто
 * не рисуют, пока граф поведения не скажет обратного.
 */
export function applyNodeVisibility(gltf: {
  parser?: { json?: Record<string, unknown>; associations?: Map<unknown, Association> };
  scene?: THREE.Object3D;
}): number {
  const json = gltf.parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  const assoc = gltf.parser?.associations;
  if (!json?.nodes || !assoc || !gltf.scene) return 0;

  const спрятанные = new Set<number>();
  json.nodes.forEach((node, i) => {
    if (isHiddenInFile(node['extensions'])) спрятанные.add(i);
  });
  if (!спрятанные.size) return 0;

  let n = 0;
  gltf.scene.traverse((obj) => {
    const at = assoc.get(obj)?.nodes;
    if (at === undefined || !спрятанные.has(at)) return;
    obj.visible = false;
    n += 1;
  });
  return n;
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

  readonly color: number;

  constructor(parts: readonly InteractivePart[], color = 0x4ade80) {
    super();
    this.name = 'InteractivityHighlight';
    this.color = color;
    for (const part of parts) {
      const box = new THREE.BoxHelper(part.object, color) as THREE.BoxHelper & { _part?: InteractivePart };
      // Помним, чья это рамка: вспышка адресуется части, а не порядковому номеру —
      // список нажимаемых меняется на ходу, когда граф гасит части.
      box._part = part;
      // Рамка не должна прятаться внутри модели: её задача — быть видной.
      const material = box.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      material.opacity = 0.9;
      box.renderOrder = 999;
      this.add(box);
    }
  }

  /**
   * Вспыхнуть на одной части — ответ на нажатие.
   *
   * Зачем. Отклики у моделей бывают тихие: цвет лампы, сдвиг развёртки на пиксель,
   * анимация, начинающаяся через секунду. Человек нажимает и не понимает, попал он или
   * промахнулся — а это два совершенно разных положения дел. Вспышка отвечает на этот
   * вопрос сразу и ни с чем не спорит: она живёт в той же рамке, что и обводка.
   *
   * Александр, 2026-08-28: «неработает странно. может я просто не понимаю».
   */
  flash(part: InteractivePart, ms = 450): void {
    const at = this.children.findIndex((c) => (c as THREE.BoxHelper & { _part?: unknown })._part === part);
    const box = (at >= 0 ? this.children[at] : null) as THREE.BoxHelper | null;
    if (!box) return;
    const material = box.material as THREE.LineBasicMaterial;
    material.color.setHex(0xffffff);
    setTimeout(() => {
      if (box.parent) material.color.setHex(this.color);
    }, ms);
  }

  /**
   * Подтянуть рамки к деталям: где они сейчас и видно ли их.
   *
   * ЗОВЁТСЯ КАЖДЫЙ КАДР, и иначе нельзя. `BoxHelper` считает габарит один раз при
   * создании — а граф поведения двигает детали и гасит их. У `WhackAMole` кроты
   * появляются и прячутся по очереди в разных лунках: рамки стояли там, где кроты были в
   * миг загрузки, и висели над пустыми лунками (Александр, 2026-08-28: «у крота они
   * пропадают и появляются в разных местах. а ты этого не ловишь совершенно»).
   *
   * Спрятанная деталь не обводится: обводка обещает нажатие, а нажать на то, чего не
   * видно, человек не может.
   *
   * Цена — обход по числу нажимаемых частей за кадр. Он мал по построению: обводятся
   * только помеченные автором узлы, у самой богатой модели набора их пятнадцать.
   */
  sync(): void {
    for (const child of this.children) {
      const box = child as THREE.BoxHelper & { _part?: InteractivePart };
      const obj = box._part?.object;
      if (!obj) continue;
      const видно = obj.visible && !hiddenByParent(obj);
      box.visible = видно;
      if (видно) box.update();
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
