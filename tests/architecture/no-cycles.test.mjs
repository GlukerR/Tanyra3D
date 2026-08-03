// tests/architecture/no-cycles.test.mjs — DFS по графу импортов (АРХИТЕКТУРНЫЕ_ТЕСТЫ.md §5.5).
//
// Циклическая зависимость — это всегда скрытая глобальность: два модуля, которые
// ссылаются друг на друга, невозможно разобрать по отдельности, и любой из них
// можно импортировать только вместе с другим. ESM ловит лишь часть циклов (с
// hoisting-функциями цикл переживает загрузку) — статическая проверка графа
// дешева и не оставляет таких лазеек.
//
// Граф строится тем же лексером (es-module-lexer), что и layer-boundaries —
// см. ./import-graph.mjs. Рёбра — только между production-файлами;
// node:* и пакеты в граф не входят (цикл между нами и three невозможен по
// определению: пакет не импортирует наш код).

import { describe, it, expect } from 'vitest';
import { PROJECT_ROOT, productionFiles, buildGraph, findCycle } from './import-graph.mjs';
import path from 'node:path';

describe('no-cycles — граф импортов production-кода ацикличен', () => {
  it('граф строится и нетривиален (рёбра между файлами существуют)', async () => {
    const { nodes, edges } = await buildGraph();
    expect(nodes.size).toBeGreaterThan(10);
    const edgeCount = [...edges.values()].reduce((n, e) => n + e.length, 0);
    expect(edgeCount).toBeGreaterThan(10); // иначе гейт ни на что не смотрит
  });

  it('в графе нет циклов', async () => {
    const graph = await buildGraph();
    const cycle = findCycle(graph);
    expect(cycle, cycle
      ? `Цикл импортов: ${cycle.map((f) => path.relative(PROJECT_ROOT, f)).join(' → ')}`
      : '').toBeNull();
  });

  it('детектор сам работоспособен: синтетический цикл находится (гейт не пустой)', () => {
    const graph = {
      nodes: new Set(['a', 'b', 'c']),
      edges: new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']], // цикл a → b → c → a
      ]),
    };
    const cycle = findCycle(graph);
    expect(cycle).not.toBeNull();
    expect(cycle[0]).toBe(cycle[cycle.length - 1]); // замкнутый путь
  });

  it('ацикличный синтетический граф не даёт ложного срабатывания', () => {
    const graph = {
      nodes: new Set(['x', 'y', 'z']),
      edges: new Map([
        ['x', ['y', 'z']],
        ['y', ['z']],
        ['z', []],
      ]),
    };
    expect(findCycle(graph)).toBeNull();
  });
});
