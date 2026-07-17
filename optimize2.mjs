// glb_web_optimize v3 — умный оптимизатор GLB/glTF: движок + правила
//
// Рефактор v2 → v3 по docs/РЕФАКТОР_v3_движок-правил.md: та же логика, тот же
// результат, но каждая операция — объект-правило в массиве RULES, а обработка
// файла — маленький движок из пяти фаз (АНАЛИЗ → ПЛАН → ПРИМЕНЕНИЕ → ВАЛИДАЦИЯ
// → ОТЧЁТ). Большая архитектура: docs/ARCHITECTURE.md. Копия v2 рядом:
// optimize2_v2_backup.mjs (до подтверждения эквивалентности).
//
// Запуск:
//   node optimize2.mjs                        Meshopt (по умолчанию)
//   node optimize2.mjs draco                  Draco
//   node optimize2.mjs --keep-parts           не объединять меши
//   node optimize2.mjs --no-ktx               не трогать текстуры
//   node optimize2.mjs --strip-vertex-colors  удалить вершинные цвета, даже раскрашенные
//
// Вход: input/*.glb и input/*.gltf  →  Выход: output/*.glb + output/*.report.md

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as gltfCore from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as fns from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const { NodeIO } = gltfCore;

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(BASE_DIR, 'input');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_KEEP_DAYS = 30; // логи старше — удаляются при следующем запуске

// ---------- логи: всё из консоли дублируется в файл logs/run_*.log ----------
fs.mkdirSync(LOG_DIR, { recursive: true });
const _stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `run_${_stamp}.log`);
const _logLines = [`=== glb_web_optimize v3 · запуск ${new Date().toISOString()} ===`, `argv: ${process.argv.slice(2).join(' ') || '(без аргументов)'}`];
for (const m of ['log', 'error', 'warn']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    _logLines.push(a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || String(x))).join(' '));
    orig(...a);
  };
}
function flushLog() {
  try { fs.writeFileSync(LOG_FILE, _logLines.join('\n') + '\n', 'utf8'); } catch { /* диск/права — лог не критичен */ }
}
process.on('exit', flushLog); // пишется и при падении, и при успехе

// ротация: удалить логи старше LOG_KEEP_DAYS дней
try {
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!f.endsWith('.log')) continue;
    const p = path.join(LOG_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > LOG_KEEP_DAYS * 24 * 3600 * 1000) fs.rmSync(p);
  }
} catch { /* не критично */ }

// ---------- аргументы → opts (флаги видят движок и правила через ctx.opts) ----------
const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const OPTS = {
  codec: argv.includes('draco') ? 'draco' : 'meshopt',
  keepParts: argv.includes('--keep-parts'),
  noKtx: argv.includes('--no-ktx'),
  stripColors: argv.includes('--strip-vertex-colors'),
};

// Политика автофикса (ARCHITECTURE.md §2.4): применяем provable + numeric + perceptual
// (perceptual = KTX2/UASTC — пользователь выбрал сам и доволен). lossy — никогда
// автоматом; только явный force из canFix (например флаг --strip-vertex-colors).
const TIER_RANK = { provable: 0, numeric: 1, perceptual: 2, lossy: 3 };
const AUTOFIX_MAX_TIER = 'perceptual';

// ---------- поиск внешних инструментов ----------
function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const GLTF_CLI = findInPath(['gltf-transform.cmd', 'gltf-transform']);

// JS-вход CLI: вызываем его напрямую текущим node, минуя .cmd-обёртку
// (.cmd внутри вызывает "node" через shell — ломается двойным слоем кавычек на Windows)
function findCliJs() {
  if (!GLTF_CLI) return null;
  const pkgDir = path.join(path.dirname(GLTF_CLI), 'node_modules', '@gltf-transform', 'cli');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    let bin = pkg.bin;
    if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
    if (typeof bin === 'string') {
      const p = path.join(pkgDir, bin);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* нет package.json — используем .cmd как запасной путь */ }
  return null;
}
const GLTF_CLI_JS = findCliJs();

function findToktx() {
  // gltf-transform CLI v4 требует бинарник `ktx` (KTX-Software 4.3+); toktx — запасной признак установки
  const inPath = findInPath(['ktx.exe', 'ktx', 'toktx.exe', 'toktx']);
  if (inPath) return inPath;
  const candidates = [
    'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files (x86)\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files\\KTX-Software\\bin\\toktx.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const TOKTX = OPTS.noKtx ? null : findToktx();
const childEnv = { ...process.env };
if (TOKTX) {
  const dir = path.dirname(TOKTX);
  // на Windows ключ называется `Path` — ищем реальный ключ без учёта регистра,
  // иначе создаётся дубликат PATH, который ЗАМЕНЯЕТ системный путь у дочернего процесса
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!(childEnv[pathKey] || '').includes(dir)) childEnv[pathKey] = dir + path.delimiter + (childEnv[pathKey] || '');
}

_logLines.push(`node: ${process.version} | CLI: ${GLTF_CLI_JS || GLTF_CLI || 'не найден'} | toktx: ${TOKTX || 'не найден'}`);

function runCli(args) {
  // gltf-transform CLI для фазы KTX2 (кодирование через toktx)
  try {
    if (GLTF_CLI_JS) {
      execFileSync(process.execPath, [GLTF_CLI_JS, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execFileSync(GLTF_CLI, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: GLTF_CLI.endsWith('.cmd') });
    }
  } catch (e) {
    const raw = ((e.stderr || '') + '\n' + (e.stdout || '')).toString().trim();
    const tail = raw ? raw.split('\n').slice(-10).join('\n    ') : e.message;
    throw new Error(`gltf-transform ${args[0]} завершился с ошибкой:\n    ${tail}`);
  }
}

// ---------- метрики и снимки ----------
// Треугольники и draw calls считаем ПО УЗЛАМ СЦЕНЫ, а не по объектам-мешам:
// dedup схлопывает одинаковые меши в «один меш на многих узлах», flatten разворачивает
// обратно — счёт по мешам прыгает, хотя рендер не меняется. Счёт по сцене инвариантен.
function sceneGeometry(doc) {
  let drawCalls = 0;
  let triangles = 0;
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      for (const prim of mesh.listPrimitives()) {
        drawCalls += 1;
        if (prim.getMode() === 4) {
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
        }
      }
    });
  }
  return { drawCalls, triangles };
}

function collectMetrics(doc, fileBytes) {
  const root = doc.getRoot();
  const { drawCalls, triangles } = sceneGeometry(doc);
  let textureBytes = 0;
  let gpuBytes = 0;
  try {
    const report = fns.inspect(doc);
    for (const t of report.textures.properties) {
      textureBytes += t.size || 0;
      gpuBytes += t.gpuSize || 0;
    }
  } catch {
    /* inspect может не поддержать экзотику — не критично */
  }
  return {
    fileBytes,
    drawCalls,
    triangles,
    textureBytes,
    gpuBytes,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    nodes: root.listNodes().length,
    scenes: root.listScenes().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    bounds: sceneBounds(doc),
  };
}

function sceneBounds(doc) {
  // bounding box сцены — для инварианта «модель не съехала и не схлопнулась»
  if (typeof gltfCore.getBounds !== 'function') return null;
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;
  try { return gltfCore.getBounds(scene); } catch { return null; }
}

function countTriangles(doc) {
  return sceneGeometry(doc).triangles;
}

function listSemantics(doc) {
  const out = new Set();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  return out;
}

const MB = (b) => (b / (1024 * 1024)).toFixed(2);

// ============================================================================
// ПРАВИЛА. Каждое действие пайплайна — объект формы из РЕФАКТОР_v3 §2:
//   meta { id, category, title, severity, fixSafety, runAfter, touches, enabled }
//   analyze(ctx)          — фаза 1, только чтение
//   canFix(finding, ctx)  — доказательство безопасности, причина идёт в отчёт
//   fix(finding, ctx)     — фаза 3, меняет ctx.document (рабочую копию)
//
// fix возвращает { found, skipped, details } — строки для секций отчёта
// «Найдено» / «Пропущено» / «Применено» (любое поле опционально).
//
// ВАЖНО (эквивалентность v2): бОльшая часть находок в glTF считается только
// по факту применения (diff до/после prune, вырожденные треугольники появляются
// ПОСЛЕ weld и т.д. — см. ARCHITECTURE.md §2.1). Поэтому analyze здесь возвращает
// «задание» ({ messageId: 'pipeline' }), а конкретика с цифрами приходит из fix
// — ровно те же измерения, что делал v2. Read-only-детекторы появятся в
// следующих шагах вместе с --dry-run (РЕФАКТОР_v3 §7).
// ============================================================================

// Порядок пайплайна ЖЁСТКИЙ и выверен в v2 (кодируется через runAfter):
// dedup → prune → vertex-colors → weld → degenerate → orphan → (flatten+join)
// → prune → ktx2 → geometry-compress. Не менять.
const RULES = [
  {
    meta: {
      id: 'structure/dedup', category: 'materials', title: 'Дубли ресурсов (dedup)',
      severity: 'info', fixSafety: 'provable', runAfter: [], touches: ['texture', 'material', 'accessor'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'склейка идентичных ресурсов структурно безопасна' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      await ctx.document.transform(fns.dedup());
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      const out = { found: [], details: [] };
      if (b.tex > a.tex) { out.found.push(`дубли текстур: ${b.tex - a.tex}`); out.details.push(`Склеены дубли текстур (${b.tex - a.tex})`); }
      if (b.mat > a.mat) { out.found.push(`дубли материалов: ${b.mat - a.mat}`); out.details.push(`Склеены дубли материалов (${b.mat - a.mat})`); }
      if (b.acc > a.acc) { out.found.push(`дубли аксессоров: ${b.acc - a.acc}`); out.details.push(`Склеены дубли аксессоров (${b.acc - a.acc})`); }
      return out;
    },
  },

  {
    meta: {
      id: 'structure/prune-unused', category: 'scene', title: 'Неиспользуемые ресурсы (prune)',
      severity: 'info', fixSafety: 'provable', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'удаляется только то, на что нет ни одной ссылки' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length };
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length };
      const out = { found: [], details: [] };
      for (const s of semBefore) {
        if (!semAfter.has(s)) {
          out.found.push(`атрибут ${s} не используется ни одним материалом`);
          out.details.push(`Атрибут ${s}: не используется ни одним материалом — удалён (prune)`);
        }
      }
      if (b.tex > a.tex) { out.found.push(`неиспользуемые текстуры: ${b.tex - a.tex}`); out.details.push(`Текстуры: удалено ${b.tex - a.tex} неиспользуемых`); }
      if (b.mat > a.mat) { out.found.push(`неиспользуемые материалы: ${b.mat - a.mat}`); out.details.push(`Материалы: удалено ${b.mat - a.mat} неиспользуемых`); }
      return out;
    },
  },

  {
    meta: {
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Вершинные цвета (COLOR_n)',
      severity: 'warn', fixSafety: 'provable', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      enabled: () => true,
    },
    // Детекция при применении, а не в analyze: COLOR-каналы, которые снесёт prune
    // (например неиспользуемый COLOR_1), не должны попадать в находки — v2 сканировал
    // ПОСЛЕ prune, сохраняем то же окно измерения.
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) {
      // белый (все значения 1.0) → provable: множитель baseColor равен единице.
      // раскрашенный → lossy: убирается только явным флагом (решение внутри fix).
      return { safe: true, reason: 'белые каналы удаляются доказуемо безопасно; раскрашенные — только по флагу' };
    },
    fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      const el = [];
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc.getCount();
            for (let i = 0; i < n; i++) {
              acc.getElement(i, el); // нормализованные float-значения
              if (el.some((v) => v < 0.999)) { allWhite = false; break; }
            }
            const where = `${sem} (меш «${mesh.getName() || '—'}»)`;
            if (allWhite) {
              prim.setAttribute(sem, null);
              out.found.push(`${where}: все значения белые — на вид не влияет`);
              out.details.push(`${where}: все значения белые — удалён, вид не меняется`);
            } else if (ctx.opts.stripColors) {
              prim.setAttribute(sem, null); // lossy, но пользователь явно форсировал флагом
              out.found.push(`${where}: реальная покраска вершин`);
              out.details.push(`${where}: РАСКРАШЕН, удалён по флагу --strip-vertex-colors — вид может измениться`);
            } else {
              out.found.push(`${where}: реальная покраска вершин`);
              out.skipped.push(`${where}: реальная покраска — НЕ удалён, влияет на вид. Форсировать: --strip-vertex-colors`);
            }
          }
        }
      }
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/weld', category: 'geometry', title: 'Сварка вершин (weld)',
      severity: 'info', fixSafety: 'numeric', runAfter: ['attributes/vertex-colors'], touches: ['geometry', 'accessor'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'свариваются только идентичные вершины' }; },
    async fix(finding, ctx) {
      // точка отсчёта для инварианта «треугольники не изменились» — как в v2:
      // после prune/цветов, до сварки (weld порождает вырожденные треугольники)
      ctx.cache.set('trianglesBeforeWeld', countTriangles(ctx.document));
      let vb = 0, va = 0;
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) vb += pos.getCount(); }
      await ctx.document.transform(fns.weld());
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) va += pos.getCount(); }
      if (vb > va) {
        return { found: [`идентичные вершины: ${vb - va}`], details: [`Сварка вершин (weld): ${vb} → ${va}`] };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/degenerate-triangles', category: 'geometry', title: 'Вырожденные треугольники',
      severity: 'info', fixSafety: 'provable', runAfter: ['geometry/weld'], touches: ['geometry'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'треугольник с повторным индексом имеет нулевую площадь и не рисуется' }; },
    fix(finding, ctx) {
      // два/три одинаковых индекса = нулевая площадь; считаем ПОСЛЕ weld (он их порождает).
      // Итог меряем дельтой по сцене: правка общего аксессора действует на все его инстансы.
      const trisBefore = countTriangles(ctx.document);
      const patched = new Set();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue; // только TRIANGLES
          const indices = prim.getIndices();
          if (!indices || patched.has(indices)) continue;
          const arr = indices.getArray();
          const out = [];
          for (let i = 0; i + 2 < arr.length; i += 3) {
            const a = arr[i], b = arr[i + 1], c = arr[i + 2];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
          }
          if (out.length < arr.length) indices.setArray(new arr.constructor(out));
          patched.add(indices); // общий аксессор не обрабатываем дважды
        }
      }
      const sceneRemoved = trisBefore - countTriangles(ctx.document);
      ctx.cache.set('degenerateRemoved', sceneRemoved); // для инварианта по треугольникам
      if (sceneRemoved > 0) {
        return {
          found: [`вырожденные треугольники (нулевая площадь): ${sceneRemoved}`],
          details: [`Вырожденные треугольники: удалено ${sceneRemoved} (нулевая площадь, на рендер не влияли)`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/orphan-vertices', category: 'geometry', title: 'Висящие вершины',
      severity: 'info', fixSafety: 'provable', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (typeof fns.compactPrimitive !== 'function') {
        return { safe: false, reason: 'compactPrimitive недоступен в этой версии @gltf-transform/functions — проход пропущен' };
      }
      return { safe: true, reason: 'вершины не адресованы ни одним индексом и не рисуются' };
    },
    fix(finding, ctx) {
      let before = 0;
      let after = 0;
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos || !prim.getIndices()) continue;
          before += pos.getCount();
          fns.compactPrimitive(prim);
          after += prim.getAttribute('POSITION').getCount();
        }
      }
      if (before > after) {
        return {
          found: [`висящие вершины: ${before - after}`],
          details: [`Висящие вершины: удалено ${before - after} (не адресованы индексами, не рисовались)`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'scene/join', category: 'scene', title: 'Объединение мешей (flatten + join)',
      severity: 'info', fixSafety: 'numeric', runAfter: ['geometry/orphan-vertices'], touches: ['geometry', 'node'],
      enabled: (opts) => !opts.keepParts,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'модель статичная, отдельные части не нужны (иначе --keep-parts)' }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      const b = m();
      await ctx.document.transform(fns.flatten(), fns.join());
      const a = m();
      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        return {
          found: [`лишние draw calls / узлы: draw calls ${b.drawCalls}, узлов ${b.nodes}`],
          details: [`Меши объединены (flatten+join): draw calls ${b.drawCalls} → ${a.drawCalls}, узлы ${b.nodes} → ${a.nodes}`],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'structure/prune-final', category: 'scene', title: 'Подчистка осиротевших ресурсов',
      severity: 'info', fixSafety: 'provable', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'удаляются только осиротевшие после предыдущих фиксов ресурсы' }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = root.listAccessors().length;
      await ctx.document.transform(fns.prune()); // как в v2: подчистка после всех проходов
      const a = root.listAccessors().length;
      if (b > a) return { details: [`Подчистка (prune): удалено ${b - a} осиротевших аксессоров`] };
      return {};
    },
  },

  {
    meta: {
      id: 'textures/ktx2', category: 'textures', title: 'Текстуры → KTX2/UASTC',
      severity: 'warn', fixSafety: 'perceptual', runAfter: ['structure/prune-final'], touches: ['texture'],
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !GLTF_CLI) {
        return { safe: false, reason: 'toktx или gltf-transform CLI не найдены — текстуры оставлены в исходном формате' };
      }
      return { safe: true, reason: 'UASTC --level 2 --zstd 18 без RDO — near-lossless, выбор пользователя' };
    },
    async fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      let needKtx = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '—';
        if (mime === 'image/ktx2') {
          out.skipped.push(`Текстура «${name}»: уже KTX2 — повторно не кодируем (без лишней потери)`);
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
          const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
          tex.setImage(png);
          tex.setMimeType('image/png');
          out.details.push(`Текстура «${name}»: ${mime} → PNG (без потерь, для toktx)`);
        }
        needKtx += 1;
      }
      if (needKtx === 0) {
        ctx.log('        все текстуры уже KTX2 или их нет — кодирование пропущено');
        return out;
      }
      out.found.push(`текстуры не в KTX2: ${needKtx}`);
      ctx.log(`        кодирование KTX2/UASTC (${needKtx} шт.)`);
      const tmpA = path.join(OUTPUT_DIR, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(OUTPUT_DIR, `_tmp2_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        runCli(['uastc', tmpA, tmpB, '--level', '2', '--zstd', '18']);
        ctx.document = await ctx.io.read(tmpB); // дальше пайплайн работает с KTX2-версией
      } finally {
        // временные файлы не должны оставаться в output даже при ошибке
        for (const t of [tmpA, tmpB]) {
          try { if (fs.existsSync(t)) fs.rmSync(t); } catch { /* занят — уберётся при следующем запуске */ }
        }
      }
      out.details.push(`Текстуры → KTX2/UASTC: ${needKtx} шт. (--level 2 --zstd 18, без RDO)`);
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/compress', category: 'geometry', title: 'Сжатие геометрии',
      severity: 'info', fixSafety: 'numeric', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      enabled: () => true,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, reason: 'сжатие пакует данные вершин, число полигонов не меняется' }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        await ctx.document.transform(fns.meshopt({ encoder: MeshoptEncoder }));
      }
      return { details: [`Геометрия сжата (${ctx.opts.codec}) — число полигонов не изменилось`] };
    },
  },
];

// ============================================================================
// ДВИЖОК: пять фаз над массивом RULES (РЕФАКТОР_v3 §3).
// Движок ничего не знает о конкретных правилах.
// ============================================================================

// Топологическая сортировка по meta.runAfter (устойчивая: при равенстве — порядок массива).
// Зависимости на выключенные правила считаются выполненными.
function orderRules(rules) {
  const ids = new Set(rules.map((r) => r.meta.id));
  const done = new Set();
  const pending = [...rules];
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((r) => (r.meta.runAfter || []).every((d) => !ids.has(d) || done.has(d)));
    if (i === -1) throw new Error(`цикл в runAfter: ${pending.map((r) => r.meta.id).join(', ')}`);
    const [r] = pending.splice(i, 1);
    done.add(r.meta.id);
    out.push(r);
  }
  return out;
}

const asLines = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function processFile(io, filename) {
  const src = path.join(INPUT_DIR, filename);
  const dstName = filename.replace(/\.gltf$/i, '.glb');
  const dst = path.join(OUTPUT_DIR, dstName);
  if (fs.existsSync(dst)) {
    console.log(`[ПРОПУСК] ${filename} — уже есть в output/`);
    return 'skip';
  }

  console.log(`[РАБОТА] ${filename}`);

  // -------- загрузка: исходный файл НЕ трогаем никогда, работаем с копией в памяти --------
  const ctx = {
    document: await io.read(src),
    io,
    opts: OPTS,
    dstName,
    cache: new Map(),
    log: (msg) => console.log(msg),
  };
  const before = collectMetrics(ctx.document, fs.statSync(src).size);

  const report = { found: [], skipped: [], applied: [], validation: [] };

  // Входное сжатие геометрии снимаем сразу после загрузки (данные уже распакованы в память).
  // Иначе расширение остаётся на документе и КАЖДАЯ запись (включая tmp для KTX2) молча
  // пережимает геометрию заново — Draco лосси по связности, потери накапливаются.
  // Граничный случай из ARCHITECTURE.md §6: «Draco vs Meshopt already present — не стекировать».
  const strippedCodecs = [];
  for (const ext of ctx.document.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression' || ext.extensionName === 'EXT_meshopt_compression') {
      strippedCodecs.push(ext.extensionName);
      ext.dispose();
    }
  }
  if (strippedCodecs.length) {
    report.found.push(`входная геометрия уже сжата (${strippedCodecs.join(', ')}) — распакована при загрузке`);
    report.applied.push(`Снято входное сжатие ${strippedCodecs.join(', ')} — перекодировано заново (${OPTS.codec}), без двойного сжатия и скрытых пережатий`);
  }

  // -------- ФАЗА 1 · АНАЛИЗ (только чтение) --------
  const activeRules = orderRules(RULES.filter((r) => r.meta.enabled(OPTS)));
  console.log(`    фаза 1/5 · анализ (${activeRules.length} правил активно)`);
  const findings = [];
  for (const rule of activeRules) {
    for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
  }

  // -------- ФАЗА 2 · ПЛАН (canFix + политика безопасности, порядок уже топологический) --------
  console.log('    фаза 2/5 · план');
  const planned = [];
  for (const { rule, finding } of findings) {
    if (!rule.fix) { report.found.push(...asLines(finding.text)); continue; }
    const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true, reason: '' };
    if (!decision.safe) {
      report.skipped.push(`${rule.meta.title} — ${decision.reason}`);
      continue;
    }
    const tier = finding.fixSafety || rule.meta.fixSafety;
    if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
      report.skipped.push(`${rule.meta.title} — уровень безопасности «${tier}» не применяется автоматически`);
      continue;
    }
    planned.push({ rule, finding });
  }

  // -------- ФАЗА 3 · ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию) --------
  console.log(`    фаза 3/5 · применение (${planned.length} фиксов)`);
  for (const { rule, finding } of planned) {
    console.log(`      • ${rule.meta.title}`);
    const res = (await rule.fix(finding, ctx)) || {};
    report.found.push(...asLines(res.found));
    report.skipped.push(...asLines(res.skipped));
    report.applied.push(...asLines(res.details ?? res.detail));
  }

  // -------- ФАЗА 4 · ВАЛИДАЦИЯ (весь ассет; при провале .glb НЕ записывается) --------
  console.log('    фаза 4/5 · валидация');
  // материалы резолвятся: ни один примитив не ссылается на удалённый материал
  let materialsOk = true;
  for (const mesh of ctx.document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat && typeof mat.isDisposed === 'function' && mat.isDisposed()) materialsOk = false;
    }
  }

  const glb = await io.writeBinary(ctx.document); // байты будущего файла — в памяти, на диск пока ничего
  const after = collectMetrics(await io.readBinary(glb), glb.byteLength);

  const v = report.validation;
  // 1. геометрия на месте
  if (before.triangles === 0) v.push('ℹ треугольной геометрии не было и нет');
  else v.push(after.triangles > 0 ? '✅ геометрия на месте' : '❌ ГЕОМЕТРИЯ ПУСТАЯ — файл битый!');
  // 2. треугольники не изменились (кроме вырожденных); окно отсчёта — как в v2 (до weld)
  const trianglesBase = ctx.cache.get('trianglesBeforeWeld') ?? before.triangles;
  const degenerateRemoved = ctx.cache.get('degenerateRemoved') ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) v.push('✅ число треугольников не изменилось');
  else if (triangleDelta === degenerateRemoved) v.push(`ℹ треугольников стало меньше на ${triangleDelta} — только вырожденные (нулевая площадь), рендер идентичен`);
  else v.push(`❌ треугольники расходятся: ожидали ${trianglesBase - degenerateRemoved}, получили ${after.triangles}`);
  // 3-5. анимации, скины, сцены
  v.push(before.animations === after.animations ? `✅ анимации: ${after.animations}` : `❌ анимации потеряны: было ${before.animations}, стало ${after.animations}`);
  v.push(before.skins === after.skins ? `✅ скины: ${after.skins}` : `❌ скины потеряны: было ${before.skins}, стало ${after.skins}`);
  v.push(before.scenes === after.scenes ? `✅ иерархия сцен цела: ${after.scenes}` : `❌ сцены потеряны: было ${before.scenes}, стало ${after.scenes}`);
  // 6. bounding box в пределах эпсилон (квантование кодека даёт микросдвиг — допуск 1% диагонали)
  if (before.bounds && after.bounds) {
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds.max[i] - before.bounds.min[i]));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds.min[i] - after.bounds.min[i]) <= eps && Math.abs(before.bounds.max[i] - after.bounds.max[i]) <= eps);
    v.push(ok ? '✅ bounding box в пределах эпсилон' : '❌ bounding box изменился — модель съехала или схлопнулась');
  } else {
    v.push('ℹ bounding box не посчитан (getBounds недоступен или нет сцены)');
  }
  // 7. материалы
  v.push(materialsOk ? '✅ каждый материал резолвится' : '❌ примитив ссылается на удалённый материал');
  // 8. gltf-validator (Khronos)
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glb));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      v.push('✅ gltf-validator (Khronos): 0 ошибок');
    } else {
      // вход мог быть битым изначально — проверяем исходник и блокируем только НОВЫЕ ошибки
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      if (inErrs > 0) report.found.push(`входной файл уже содержит ${inErrs} ошибок gltf-validator (дефект экспорта, не оптимизации)`);
      if (errs <= inErrs) {
        v.push(`ℹ gltf-validator: осталось ${errs} ошибок, унаследованных от входа (в исходнике ${inErrs}) — оптимизация новых не добавила`);
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          v.push(`ℹ пример: ${m.code} @ ${m.pointer || '—'}`);
        }
      } else {
        v.push(`❌ gltf-validator: ${errs} ошибок (на входе было ${inErrs}) — оптимизация добавила новые`);
      }
    }
  } catch {
    v.push('ℹ gltf-validator не установлен — структурная валидация пропущена');
  }

  const validationOk = !v.some((line) => line.startsWith('❌'));

  // -------- ФАЗА 5 · ОТЧЁТ + запись (.glb пишем ТОЛЬКО если есть applied и валидация прошла) --------
  console.log('    фаза 5/5 · отчёт');
  const writeAsset = validationOk && report.applied.length > 0;
  if (writeAsset) fs.writeFileSync(dst, glb);
  writeReport(dstName, report, before, after, writeAsset);

  if (!validationOk) {
    console.error(`[ОШИБКА] ${filename}: валидация не прошла — .glb НЕ записан, подробности в отчёте`);
    console.log(`         отчёт: output/${dstName.replace(/\.glb$/i, '.report.md')}`);
    return 'fail';
  }
  const pct = (b, a) => (b ? (a <= b ? `−${((1 - a / b) * 100).toFixed(0)}%` : `+${((a / b - 1) * 100).toFixed(0)}%`) : '—');
  console.log(`[ГОТОВО] ${dstName}: файл ${MB(before.fileBytes)} → ${MB(after.fileBytes)} МБ (${pct(before.fileBytes, after.fileBytes)}), VRAM ${MB(before.gpuBytes)} → ${MB(after.gpuBytes)} МБ (${pct(before.gpuBytes, after.gpuBytes)})`);
  console.log(`         отчёт: output/${dstName.replace(/\.glb$/i, '.report.md')}`);
  return 'ok';
}

// ---------- отчёт: рендерится централизованно из данных, а не собирается правилами ----------
function diffLine(label, before, after, fmt = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

function writeReport(name, report, before, after, assetWritten) {
  const flags = (OPTS.keepParts ? ' · без join' : '') + (OPTS.noKtx ? ' · без KTX2' : '') + (OPTS.stripColors ? ' · strip-vertex-colors' : '');
  const lines = [
    `# Отчёт оптимизации — ${name}`,
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)} · кодек: ${OPTS.codec} · автофикс: до «${AUTOFIX_MAX_TIER}»${flags}`,
    '',
    '## Найдено (проблемы)',
    '',
    ...(report.found.length ? report.found.map((f) => `- ✓ ${f}`) : ['- индивидуальных находок нет (структурная чистка без замечаний)']),
    '',
    '## Пропущено (и почему)',
    '',
    ...(report.skipped.length ? report.skipped.map((s) => `- ${s}`) : ['- нет']),
    '',
    '## Применено',
    '',
    ...(report.applied.length ? report.applied.map((a) => `- ${a}`) : ['- нет']),
    '',
    '## Валидация',
    '',
    ...report.validation.map((s) => `- ${s}`),
    ...(assetWritten ? [] : ['', '**Файл .glb НЕ записан** — не было применённых фиксов или валидация не прошла.']),
    '',
    '## Оценка улучшений',
    '',
    '| Показатель | До | После |',
    '|---|---|---|',
    diffLine('Файл', before.fileBytes, after.fileBytes, (v) => `${MB(v)} МБ`),
    diffLine('VRAM текстур (GPU)', before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} МБ`),
    diffLine('Вес текстур в файле', before.textureBytes, after.textureBytes, (v) => `${MB(v)} МБ`),
    diffLine('Draw calls (примитивы)', before.drawCalls, after.drawCalls),
    diffLine('Треугольники', before.triangles, after.triangles),
    diffLine('Меши', before.meshes, after.meshes),
    diffLine('Материалы', before.materials, after.materials),
    diffLine('Текстуры', before.textures, after.textures),
    diffLine('Узлы сцены', before.nodes, after.nodes),
    '',
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, name.replace(/\.(glb|gltf)$/i, '.report.md')), lines.join('\n'), 'utf8');
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = fs.readdirSync(INPUT_DIR).filter((f) => /\.(glb|gltf)$/i.test(f)).sort();
  if (!files.length) {
    console.log(`В папке input/ нет .glb/.gltf файлов. Положи модели сюда:\n  ${INPUT_DIR}`);
    return;
  }

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  console.log(`Кодек: ${OPTS.codec}` + (OPTS.keepParts ? ' | без join' : '') + (OPTS.noKtx ? ' | без KTX2' : '') + (OPTS.stripColors ? ' | strip-vertex-colors' : '') + (TOKTX ? '' : ' | toktx НЕ найден'));
  console.log(`Файлов: ${files.length}\n`);

  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const r = await processFile(io, f);
      if (r === 'ok') ok++;
      else if (r === 'skip') skip++;
      else fail++;
    } catch (e) {
      fail++;
      console.error(`[ОШИБКА] ${f}: ${e.message || e}`);
    }
    console.log();
  }
  console.log(`Итог: готово ${ok}, пропущено ${skip}, ошибок ${fail}`);
}

main().catch((e) => { console.error('[ФАТАЛЬНАЯ ОШИБКА]', e && e.stack ? e.stack : e); process.exit(1); });
