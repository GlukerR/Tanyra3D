import { isClickable } from '../../core/interactivity-rules.mjs';

export interface Interactivity {
  clickable: number;
  handlers: number;
  animations: number;
  changes: number;
  graphNodes: number;
  silent: number;
}

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

function opOf(graph: Record<string, unknown>, node: Record<string, unknown>): string {
  const decls = graph['declarations'];
  if (!Array.isArray(decls)) return '';
  const i = node['declaration'];
  if (typeof i !== 'number') return '';
  const d = decls[i] as { op?: unknown } | undefined;
  return typeof d?.op === 'string' ? d.op : '';
}

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
      if (op === 'event/onSelect' || op === 'event/onHover') handlers++;
      else if (op === 'animation/start' || op === 'animation/stop') animations++;
      else if (op === 'pointer/set') changes++;
    }
  }

  let clickable = 0;
  const nodes = root['nodes'];
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      if (isClickable((n as { extensions?: unknown } | null)?.extensions)) clickable++;
    }
  }
  const silent = deadSelectabilityNodes(json).length;

  return { clickable, handlers, animations, changes, graphNodes, silent };
}
