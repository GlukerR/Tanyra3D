// tests/architecture/import-graph.mjs — статический граф импортов production-кода.
//
// Общий хелпер для архитектурных гейтов tests/architecture/:
//   - layer-boundaries.test.mjs — allow-list по слоям (§2.4 АРХИТЕКТУРНЫЕ_ТЕСТЫ.md);
//   - no-cycles.test.mjs        — DFS по графу импортов.
//
// Парсинг — es-module-lexer@2.3.1 (прямая devDependency с 2026-08-03): тот же
// лексер, которым Vite разбирает импорты; штатно обрабатывает import(...),
// export * from, многострочные импорты, кавычки, комментарии. Полный AST-парсер
// ради извлечения строк import — новая зависимость, противоречащая ЗАВИСИМОСТИ.md.
//
// Оговорка (зафиксирована в АРХИТЕКТУРНЫЕ_ТЕСТЫ.md §4.1): import(variable)
// с динамическим спецификатором статически неразрешим — лексер вернёт
// specifier === null. В коде таких импортов нет; гейт layer-boundaries
// явно проверяет их отсутствие.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Слои, которые сканируем: всё, что является «кодом продукта», а не тестами и не
// данными переводов. messages/ — каталоги ассистента (не импортируют ничего, но
// входят в проверку границ: assistant имеет право импортировать только их).
const SOURCE_ROOTS = ['core', 'addons', 'ui', 'messages'];
const SOURCE_FILES = ['optimize2.mjs', 'server.mjs', 'assistant.mjs'];

// init в ESM-сборке es-module-lexer — это ПРОМИС, а не функция:
//   export const init = WebAssembly.compile(...).then(WebAssembly.instantiate).then(...)
// Его нужно именно await-ить (как в README пакета), а не вызывать.
let lexerPromise = null;
function ensureLexer() {
  if (!lexerPromise) lexerPromise = init;
  return lexerPromise;
}

/** Все production-файлы (.js/.mjs) в слоях, по возрастанию пути. */
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

/**
 * Импорты файла: [{ specifier }]. specifier === null означает неразрешимый
 * динамический импорт (import(variable)).
 *
 * import.meta в imports НЕ попадает: лексер помечает его d === -2 (не импорт),
 * а настоящий import(variable) — d >= 0 с n === undefined. Мы отсекаем первый
 * и оставляем второй, чтобы гейт ловил именно неразрешимые импорты.
 */
export async function parseImports(filePath) {
  await ensureLexer();
  const code = fs.readFileSync(filePath, 'utf8');
  const [imports] = parse(code, filePath);
  return imports
    .filter((i) => i.d !== -2) // import.meta — не импорт
    .map((i) => ({
      specifier: typeof i.n === 'string' && i.n.length ? i.n : null,
    }));
}

/**
 * Класс спецификатора:
 *   'builtin'    — node:*;
 *   'relative'   — ./ и ../ (резолвится в файл проекта);
 *   'package'    — голое имя пакета (three, @gltf-transform/*, ...);
 *   'nonliteral' — import(variable): статически неразрешим.
 */
export function classifySpecifier(spec) {
  if (spec == null) return 'nonliteral';
  if (spec.startsWith('node:')) return 'builtin';
  if (spec.startsWith('.')) return 'relative';
  return 'package';
}

/** Абсолютный путь для относительного спецификатора (или null за пределами проекта). */
export function resolveRelative(fromFile, spec) {
  const abs = path.resolve(path.dirname(fromFile), spec);
  if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + path.sep)) return null;
  return abs;
}

/**
 * Слой файла по пути:
 *   'core' | 'addons' | 'ui' | 'messages' | 'root:<basename>' | 'other'
 */
export function layerOfFile(absPath) {
  const rel = path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
  const first = rel.split('/')[0];
  if (['core', 'addons', 'ui', 'messages'].includes(first)) return first;
  if (/\.(mjs|js)$/.test(rel)) return `root:${path.basename(rel)}`;
  return 'other';
}

/** Граф: nodes — Set путей, edges — Map<путь, путь[]> (рёбра только между production-файлами). */
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

/**
 * 3-цветный DFS: ищет цикл в графе. Возвращает массив путей цикла (первый
 * найденный) или null. Работает и на синтетических графах (nodes/edges Map).
 */
export function findCycle({ nodes, edges }) {
  const color = new Map(); // 0 белый, 1 серый, 2 чёрный
  const stack = [];
  const order = [...nodes].sort();

  const dfs = (v) => {
    color.set(v, 1);
    stack.push(v);
    for (const w of edges.get(v) || []) {
      const c = color.get(w) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(w);
        return [...stack.slice(start), w]; // путь цикла, замкнутый на w
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
