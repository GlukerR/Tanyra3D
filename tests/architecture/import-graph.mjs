import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_ROOTS = ['core', 'addons', 'ui', 'messages'];
const SOURCE_FILES = ['optimize2.mjs', 'server.mjs', 'assistant.mjs'];

let lexerPromise = null;
function ensureLexer() {
  if (!lexerPromise) lexerPromise = init;
  return lexerPromise;
}

export function productionFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
    }
  };
  for (const root of SOURCE_ROOTS) walk(path.join(PROJECT_ROOT, root));
  for (const f of SOURCE_FILES) {
    const p = path.join(PROJECT_ROOT, f);
    if (fs.existsSync(p)) out.push(p);
  }
  return out.sort();
}

export async function parseImports(filePath) {
  await ensureLexer();
  const code = fs.readFileSync(filePath, 'utf8');
  const [imports] = parse(code, filePath);
  return imports
    .filter((i) => i.d !== -2)
    .map((i) => ({
      specifier: typeof i.n === 'string' && i.n.length ? i.n : null,
    }));
}

export function classifySpecifier(spec) {
  if (spec == null) return 'nonliteral';
  if (spec.startsWith('node:')) return 'builtin';
  if (spec.startsWith('.')) return 'relative';
  return 'package';
}

export function resolveRelative(fromFile, spec) {
  const abs = path.resolve(path.dirname(fromFile), spec);
  if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + path.sep)) return null;
  return abs;
}

export function layerOfFile(absPath) {
  const rel = path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
  const first = rel.split('/')[0];
  if (['core', 'addons', 'ui', 'messages'].includes(first)) return first;
  if (/\.(mjs|js)$/.test(rel)) return `root:${path.basename(rel)}`;
  return 'other';
}

export async function buildGraph() {
  const files = productionFiles();
  const nodes = new Set(files);
  const edges = new Map();
  for (const f of files) {
    const targets = [];
    for (const im of await parseImports(f)) {
      if (classifySpecifier(im.specifier) !== 'relative') continue;
      const target = resolveRelative(f, im.specifier);
      if (target && nodes.has(target)) targets.push(target);
    }
    edges.set(f, targets);
  }
  return { nodes, edges };
}

export function findCycle({ nodes, edges }) {
  const color = new Map();
  const stack = [];
  const order = [...nodes].sort();

  const dfs = (v) => {
    color.set(v, 1);
    stack.push(v);
    for (const w of edges.get(v) || []) {
      const c = color.get(w) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(w);
        return [...stack.slice(start), w];
      }
      if (c === 0) {
        const cyc = dfs(w);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    color.set(v, 2);
    return null;
  };

  for (const v of order) {
    if ((color.get(v) ?? 0) === 0) {
      const cyc = dfs(v);
      if (cyc) return cyc;
    }
  }
  return null;
}
