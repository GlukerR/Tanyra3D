// addons/gltf/interactivity.mts — что за интерактив лежит в файле.
//
// ЗАКАЗ (Александр, 2026-08-28): «я не вижу вообще никаких интерактивов. должен видеть».
//
// И он прав дважды. До этого дня про интерактив в отчёте не было ни одного слова В ПОЛЬЗУ
// модели — только пять строк в «Пропущено», где расширение называлось «тем, которого этот
// конвейер не понимает». То есть человек с интерактивной моделью узнавал ровно одно: у
// него что-то, чего мы не умеем. Что в файле есть работающий интерактив и сколько его —
// не узнавал ниоткуда.
//
// ГРАНИЦА, И ОНА ЗДЕСЬ ВАЖНЕЕ ОБЫЧНОГО (Правило 11). Движок граф ЧИТАЕТ, чтобы посчитать
// и назвать, и не исполняет его: сборке всё равно, что делает нажатие, ей важно довезти
// его целым. Проигрывает граф ОКНО — `ui/viewer/interactivity-graph.ts` с
// `interactivity-runtime.ts`. Разделение не случайное: сборка идёт без экрана и без сцены,
// а исполнять граф не над чем. «Считает, измеряет, предупреждает, объясняет — наша
// работа» ровно про этот модуль.
//
// ЧТО СЧИТАЕМ И ПОЧЕМУ ИМЕННО ЭТО. Не «узлов графа 595» — это число ничего не говорит
// художнику. Человеческие величины три, и все они отвечают на вопросы, которые он
// задаёт вслух:
//
//   • на что можно нажать — узлы, помеченные выбираемыми (`KHR_node_selectability`);
//   • сколько откликов на нажатие — узлы графа типа `event/onSelect`;
//   • что при этом происходит — запуск и остановка анимаций, смена свойств;
//   • сколько нажимаемых частей осталось БЕЗ отклика — см. `silent` ниже.
//
// Замер по набору Khronos 2026-08-28: WhackAMole — 7 нажимаемых, 7 откликов, 21 запуск
// анимации, 42 остановки; TrafficLight — 2 нажимаемых, 2 отклика, 12 смен свойств;
// Calculator — 15 нажимаемых и 15 откликов; MagicBall — 1 и 1. Пустых нет нигде.

import { isClickable } from '../../core/interactivity-rules.mjs';

/** Что удалось прочитать про интерактив. Все числа — из файла, ни одно не выведено. */
export interface Interactivity {
  /** Узлов, на которые можно нажать. */
  clickable: number;
  /** Откликов на нажатие в графе. */
  handlers: number;
  /** Запусков анимации. */
  animations: number;
  /** Смен свойств модели (цвет, поворот, видимость). */
  changes: number;
  /** Узлов графа всего — для логов, человеку не показывается. */
  graphNodes: number;
  /**
   * Нажимаемых частей, на которые в графе нет ни одного отклика.
   *
   * ВОПРОС АЛЕКСАНДРА, 2026-08-28: «там есть неработающие пустые интерактивные элементы?
   * ты видишь это?» Вопрос законный: обведённая часть обещает нажатие (Правило 12), и
   * если автор обещание не подкрепил, человек должен узнать это от нас, а не выяснять
   * тыканьем. Замер по набору Khronos в тот же день: пустых нет ни в одной из пяти
   * моделей — у калькулятора все пятнадцать кнопок со своим откликом.
   */
  silent: number;
}

/**
 * Номера узлов, которые ПОМЕЧЕНЫ нажимаемыми, а отклика на них в графе нет.
 *
 * ОДНО МЕСТО НА ПРОГРАММУ, и это существенно. Ответ нужен троим, и разойтись им нельзя:
 * отчёт называет число, окно решает, показывать ли галочку, а сборка по этому же списку
 * снимает метки. Скажи они разное — человек нажал бы на то, что уже убрано, или получил
 * бы удаление не того, что ему обещали.
 *
 * Графа нет вовсе — мертвы ВСЕ метки: нажимать не на что по построению.
 *
 * `onHover` считаем откликом наравне с `onSelect`: часть, которая отзывается на
 * наведение, работает — просто иначе.
 */
export function deadSelectabilityNodes(json: unknown): number[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const nodes = root['nodes'];
  if (!Array.isArray(nodes)) return [];

  const слушают = new Set<number>();
  const ext = (root['extensions'] as Record<string, unknown> | undefined)?.['KHR_interactivity'];
  const graphs = (ext as { graphs?: unknown } | undefined)?.graphs;
  if (Array.isArray(graphs)) {
    for (const g of graphs) {
      if (!g || typeof g !== 'object') continue;
      const graph = g as Record<string, unknown>;
      const list = graph['nodes'];
      if (!Array.isArray(list)) continue;
      for (const n of list) {
        if (!n || typeof n !== 'object') continue;
        const op = opOf(graph, n as Record<string, unknown>);
        if (op !== 'event/onSelect' && op !== 'event/onHover') continue;
        const at = ((n as { configuration?: Record<string, { value?: unknown[] }> }).configuration)
          ?.['nodeIndex']?.value?.[0];
        if (typeof at === 'number') слушают.add(at);
      }
    }
  }

  const out: number[] = [];
  nodes.forEach((n, i) => {
    if (!isClickable((n as { extensions?: unknown } | null)?.extensions)) return;
    if (!слушают.has(i)) out.push(i);
  });
  return out;
}

/** Тип узла графа: `declarations[i].op`, например `event/onSelect`. */
function opOf(graph: Record<string, unknown>, node: Record<string, unknown>): string {
  const decls = graph['declarations'];
  if (!Array.isArray(decls)) return '';
  const i = node['declaration'];
  if (typeof i !== 'number') return '';
  const d = decls[i] as { op?: unknown } | undefined;
  return typeof d?.op === 'string' ? d.op : '';
}

/**
 * Прочитать интерактив из разобранного JSON ассета. `null` — его в файле нет.
 *
 * Читаем ИСХОДНЫЙ JSON, а не документ: `gltf-transform` про `KHR_interactivity` не знает,
 * и в документе расширения нет вовсе — то же основание, что у правила уровней детализации
 * (docs/EXTENDING.md §5c, истина в первоисточнике).
 *
 * `null` означает «интерактива нет вовсе» — ни графа, ни единой пометки нажимаемости.
 * ОДНИ ПОМЕТКИ БЕЗ ГРАФА — это не «нет интерактива», а самый крайний случай лишнего: все
 * они обещают нажатие, которого никто не написал. Первая редакция уходила здесь в `null`
 * и о таком файле не говорила ни слова.
 */
export function readInteractivity(json: unknown): Interactivity | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;

  const ext = (root['extensions'] as Record<string, unknown> | undefined)?.['KHR_interactivity'];
  const raw = (ext as { graphs?: unknown } | undefined)?.graphs;
  const graphs = Array.isArray(raw) ? raw : [];
  const помечено = Array.isArray(root['nodes'])
    && (root['nodes'] as unknown[]).some((n) => isClickable((n as { extensions?: unknown } | null)?.extensions));
  if (!graphs.length && !помечено) return null;

  let handlers = 0;
  let animations = 0;
  let changes = 0;
  let graphNodes = 0;

  for (const g of graphs) {
    if (!g || typeof g !== 'object') continue;
    const graph = g as Record<string, unknown>;
    const nodes = graph['nodes'];
    if (!Array.isArray(nodes)) continue;
    graphNodes += nodes.length;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const op = opOf(graph, n as Record<string, unknown>);
      // Отклик на действие человека. `onHover` считаем наравне с `onSelect`: для того,
      // кто смотрит модель, это тот же вопрос — «оно откликается на меня».
      if (op === 'event/onSelect' || op === 'event/onHover') handlers++;
      else if (op === 'animation/start' || op === 'animation/stop') animations++;
      else if (op === 'pointer/set') changes++;
    }
  }

  // Нажимаемые узлы — отдельное расширение на самих узлах, не часть графа. Решает общее
  // правило: `"selectable": false` — это тоже решение автора, и считать такой узел
  // нажимаемым значит соврать. Первая редакция считала ЛЮБОЙ помеченный узел, и на
  // `MagicBall` отчёт обещал 21 нажимаемую часть там, где их одна.
  let clickable = 0;
  const nodes = root['nodes'];
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      if (isClickable((n as { extensions?: unknown } | null)?.extensions)) clickable++;
    }
  }
  // Пустые считает ОТДЕЛЬНАЯ функция, а не этот цикл: по тому же списку сборка снимает
  // метки, и второй счёт разошёлся бы с первым молча.
  const silent = deadSelectabilityNodes(json).length;

  return { clickable, handlers, animations, changes, graphNodes, silent };
}
