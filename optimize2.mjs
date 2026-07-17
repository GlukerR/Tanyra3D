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
//   node optimize2.mjs --uastc                ВСЕ текстуры в UASTC (макс. качество, тяжёлый файл;
//                                             по умолчанию режим mixed: цвет→ETC1S, нормали/ORM→UASTC)
//   node optimize2.mjs --dry-run              полный анализ и отчёт, но без записи .glb
//   node optimize2.mjs --strip-vertex-colors  удалить вершинные цвета, даже раскрашенные
//
// Вход: input/*.glb и input/*.gltf  →  Выход: output/*.glb + output/*.report.md
//
// Программный API (контракт: docs/ARCHITECTURE.md §4b, раздел Б):
//   import { optimizeFile, listRules, VERSION } from './optimize2.mjs';
// При импорте main() НЕ запускается, консоль не перехватывается, логи не пишутся.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ---------- логи (только CLI): всё из консоли дублируется в файл logs/run_*.log ----------
// Вызывается ТОЛЬКО из CLI-пути: при импорте как модуля консоль не перехватывается.
function initCliLogging(opts) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  const logFile = path.join(LOG_DIR, `run_${stamp}.log`);
  const logLines = [`=== glb_web_optimize v3 · запуск ${new Date().toISOString()} ===`, `argv: ${process.argv.slice(2).join(' ') || '(без аргументов)'}`];
  for (const m of ['log', 'error', 'warn']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => {
      logLines.push(a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || String(x))).join(' '));
      orig(...a);
    };
  }
  const flushLog = () => {
    try { fs.writeFileSync(logFile, logLines.join('\n') + '\n', 'utf8'); } catch { /* диск/права — лог не критичен */ }
  };
  process.on('exit', flushLog); // пишется и при падении, и при успехе

  // ротация: удалить логи старше LOG_KEEP_DAYS дней
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > LOG_KEEP_DAYS * 24 * 3600 * 1000) fs.rmSync(p);
    }
  } catch { /* не критично */ }

  logLines.push(`node: ${process.version} | CLI: ${GLTF_CLI_JS || GLTF_CLI || 'не найден'} | toktx: ${(opts.noKtx ? null : TOKTX) || 'не найден'}`);
}

// ---------- аргументы CLI → opts (та же форма, что принимает optimizeFile) ----------
function parseArgv(rawArgv) {
  const argv = rawArgv.map((a) => a.toLowerCase());
  return {
    codec: argv.includes('draco') ? 'draco' : 'meshopt',
    keepParts: argv.includes('--keep-parts'),
    noKtx: argv.includes('--no-ktx'),
    stripColors: argv.includes('--strip-vertex-colors'),
    // mixed (по умолчанию, решение Александра 2026-07-17): цветовые текстуры → ETC1S
    // (лёгкие и в файле, и в VRAM), data-текстуры (нормали/occlusion/roughness) → UASTC
    // (ETC1S мылит нормали). --uastc возвращает прежний режим «всё в UASTC».
    texMode: argv.includes('--uastc') ? 'uastc' : 'mixed',
    dryRun: argv.includes('--dry-run'),
  };
}

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

// Инструмент ищем всегда (нужен и API-вызовам); --no-ktx отключает само правило
// textures/ktx2 через meta.enabled, поэтому найденный TOKTX при noKtx не используется.
const TOKTX = findToktx();
const childEnv = { ...process.env };
if (TOKTX) {
  const dir = path.dirname(TOKTX);
  // на Windows ключ называется `Path` — ищем реальный ключ без учёта регистра,
  // иначе создаётся дубликат PATH, который ЗАМЕНЯЕТ системный путь у дочернего процесса
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!(childEnv[pathKey] || '').includes(dir)) childEnv[pathKey] = dir + path.delimiter + (childEnv[pathKey] || '');
}

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
    skins: effectiveSkins(doc),
    bounds: sceneBounds(doc),
  };
}

// «Действующие» скины: привязаны к узлу, чей меш реально имеет JOINTS_0 (без него
// скин ничего не деформирует). Экспортёры оставляют скины-пустышки при node-анимации —
// их удаление рендер не меняет, и инвариант не должен считать это потерей.
function effectiveSkins(doc) {
  const used = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (mesh.listPrimitives().some((p) => p.getAttribute('JOINTS_0'))) used.add(skin);
  }
  return used.size;
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
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out = { found: [], details: [] };
      for (const s of semBefore) {
        if (!semAfter.has(s)) {
          out.found.push(`атрибут ${s} не используется ни одним материалом`);
          out.details.push(`Атрибут ${s}: не используется ни одним материалом — удалён (prune)`);
        }
      }
      if (b.tex > a.tex) { out.found.push(`неиспользуемые текстуры: ${b.tex - a.tex}`); out.details.push(`Текстуры: удалено ${b.tex - a.tex} неиспользуемых`); }
      if (b.mat > a.mat) { out.found.push(`неиспользуемые материалы: ${b.mat - a.mat}`); out.details.push(`Материалы: удалено ${b.mat - a.mat} неиспользуемых`); }
      if (b.skins > a.skins && b.effSkins === a.effSkins) {
        // удалены только пустышки: действующих скинов не убыло (иначе инвариант остановит запись)
        out.found.push(`скины-пустышки (у мешей нет JOINTS/WEIGHTS): ${b.skins - a.skins}`);
        out.details.push(`Удалено ${b.skins - a.skins} скинов-пустышек — деформаций не было, анимация работает через иерархию узлов`);
      }
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
      // data-текстуры (нормали/occlusion/roughness) — UASTC: ETC1S мылит нормали и даёт
      // ступеньки на roughness. Цветовые (baseColor/emissive/прочее) — ETC1S: в разы
      // легче в файле при той же экономии VRAM. Regex и glob должны совпадать по смыслу.
      const DATA_SLOT_RE = /normal|occlusion|roughness/i;
      const DATA_SLOT_GLOB = '*{normal,Normal,occlusion,Occlusion,metallicRoughness,Roughness}*';
      const dataTex = [];
      const colorTex = [];
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
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      const needKtx = dataTex.length + colorTex.length;
      if (needKtx === 0) {
        ctx.log('        все текстуры уже KTX2 или их нет — кодирование пропущено');
        return out;
      }
      out.found.push(`текстуры не в KTX2: ${needKtx}`);
      const mixed = ctx.opts.texMode === 'mixed';
      ctx.log(`        кодирование KTX2 (${needKtx} шт., режим ${mixed ? 'mixed: ETC1S+UASTC' : 'uastc'})`);
      const tmpA = path.join(ctx.outDir, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(ctx.outDir, `_tmp2_${ctx.dstName}`);
      const tmpC = path.join(ctx.outDir, `_tmp3_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        let cur = tmpA;
        if (mixed) {
          if (dataTex.length) { runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
          cur = tmpB;
        }
        ctx.document = await ctx.io.read(cur); // дальше пайплайн работает с KTX2-версией
      } finally {
        // временные файлы не должны оставаться в output даже при ошибке
        for (const t of [tmpA, tmpB, tmpC]) {
          try { if (fs.existsSync(t)) fs.rmSync(t); } catch { /* занят — уберётся при следующем запуске */ }
        }
      }
      if (mixed) {
        if (colorTex.length) out.details.push(`Цветовые текстуры → KTX2/ETC1S, quality 255 (${colorTex.length} шт.: ${colorTex.join(', ')}) — компактны в файле и в VRAM`);
        if (dataTex.length) out.details.push(`Data-текстуры → KTX2/UASTC --level 2 --zstd 18 (${dataTex.length} шт.: ${dataTex.join(', ')}) — нормали/ORM без артефактов ETC1S`);
      } else {
        out.details.push(`Текстуры → KTX2/UASTC: ${needKtx} шт. (--level 2 --zstd 18, без RDO; режим --uastc)`);
      }
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

// ============================================================================
// ПУБЛИЧНЫЙ API (контракт: docs/ARCHITECTURE.md §4b, раздел Б).
// CLI ниже — тонкая обёртка над optimizeFile.
// ============================================================================

export const VERSION = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8')).version;

// read-only копии meta: мутации у потребителя не влияют на движок
export function listRules() {
  return RULES.map((r) => ({ ...r.meta, runAfter: [...(r.meta.runAfter || [])], touches: [...(r.meta.touches || [])] }));
}

// io с декодерами создаётся один раз и переиспользуется всеми вызовами
let _ioPromise = null;
function getIO() {
  if (!_ioPromise) {
    _ioPromise = (async () => {
      await MeshoptEncoder.ready;
      await MeshoptDecoder.ready;
      return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'draco3d.decoder': await draco3d.createDecoderModule(),
          'draco3d.encoder': await draco3d.createEncoderModule(),
          'meshopt.decoder': MeshoptDecoder,
          'meshopt.encoder': MeshoptEncoder,
        });
    })();
  }
  return _ioPromise;
}

// значения по умолчанию — ровно как у CLI без флагов (контракт §4b)
function normalizeOpts(opts = {}) {
  return {
    codec: opts.codec === 'draco' ? 'draco' : 'meshopt',
    texMode: opts.texMode === 'uastc' ? 'uastc' : 'mixed',
    keepParts: !!opts.keepParts,
    noKtx: !!opts.noKtx,
    stripColors: !!opts.stripColors,
    dryRun: !!opts.dryRun,
    outDir: path.resolve(String(opts.outDir || 'output')),
    force: !!opts.force,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    // аддитивная опция (не в контракте, разрешено правилами стабильности): приёмник
    // строк хода работы. По умолчанию тишина; CLI передаёт console.log.
    log: typeof opts.log === 'function' ? opts.log : () => {},
  };
}

// Находки/применения уровня движка (вне RULES) — стабильные ruleId «engine/*»
const ENGINE_META = {
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none' },
};

export async function optimizeFile(srcPath, opts = {}) {
  const o = normalizeOpts(opts);
  const src = path.resolve(String(srcPath));
  const dstName = path.basename(src).replace(/\.gltf$/i, '.glb');
  const result = {
    status: 'ok',
    file: { src, dst: path.join(o.outDir, dstName), written: false, reportPath: null },
    findings: [],   // { ruleId, category, severity, fixSafety, text }
    skipped: [],    // { ruleId, text, reason }
    applied: [],    // { ruleId, fixSafety, text }
    validation: [], // { level: 'pass'|'info'|'fail', text }
    metrics: { before: null, after: null },
  };
  try {
    return await runFile(src, dstName, o, result);
  } catch (e) {
    // исключение (модель не читается и т.п.) — наружу не летит, а становится status:'fail'
    result.status = 'fail';
    result.error = e && e.message ? e.message : String(e);
    return result;
  }
}

async function runFile(src, dstName, o, result) {
  const dst = result.file.dst;
  if (!o.dryRun && !o.force && fs.existsSync(dst)) {
    result.status = 'skip';
    return result;
  }
  const progress = o.onProgress || (() => {});
  const log = o.log;
  const addFound = (meta, v) => { for (const text of asLines(v)) result.findings.push({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text }); };
  const addSkipped = (meta, v, reason) => { for (const text of asLines(v)) result.skipped.push({ ruleId: meta.id, text, reason: reason ?? text }); };
  const addApplied = (meta, v) => { for (const text of asLines(v)) result.applied.push({ ruleId: meta.id, fixSafety: meta.fixSafety, text }); };

  fs.mkdirSync(o.outDir, { recursive: true });
  const io = await getIO();

  // -------- загрузка: исходный файл НЕ трогаем никогда, работаем с копией в памяти --------
  const ctx = {
    document: await io.read(src),
    io,
    opts: o,
    outDir: o.outDir,
    dstName,
    cache: new Map(),
    log,
  };
  const before = collectMetrics(ctx.document, fs.statSync(src).size);

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
    addFound(ENGINE_META.inputCompression, `входная геометрия уже сжата (${strippedCodecs.join(', ')}) — распакована при загрузке`);
    addApplied(ENGINE_META.inputCompression, `Снято входное сжатие ${strippedCodecs.join(', ')} — перекодировано заново (${o.codec}), без двойного сжатия и скрытых пережатий`);
  }

  // -------- ФАЗА 1 · АНАЛИЗ (только чтение) --------
  progress({ type: 'phase', phase: 1, name: 'анализ' });
  const activeRules = orderRules(RULES.filter((r) => r.meta.enabled(o)));
  log(`    фаза 1/5 · анализ (${activeRules.length} правил активно)`);
  const findings = [];
  for (const rule of activeRules) {
    for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
  }

  // -------- ФАЗА 2 · ПЛАН (canFix + политика безопасности, порядок уже топологический) --------
  progress({ type: 'phase', phase: 2, name: 'план' });
  log('    фаза 2/5 · план');
  const planned = [];
  for (const { rule, finding } of findings) {
    if (!rule.fix) { addFound(rule.meta, finding.text); continue; }
    const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true, reason: '' };
    if (!decision.safe) {
      addSkipped(rule.meta, `${rule.meta.title} — ${decision.reason}`, decision.reason);
      continue;
    }
    const tier = finding.fixSafety || rule.meta.fixSafety;
    if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
      const reason = `уровень безопасности «${tier}» не применяется автоматически`;
      addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason);
      continue;
    }
    planned.push({ rule, finding });
  }

  // -------- ФАЗА 3 · ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию) --------
  progress({ type: 'phase', phase: 3, name: 'применение' });
  log(`    фаза 3/5 · применение (${planned.length} фиксов)`);
  for (const { rule, finding } of planned) {
    progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: rule.meta.title });
    log(`      • ${rule.meta.title}`);
    const res = (await rule.fix(finding, ctx)) || {};
    addFound(rule.meta, res.found);
    addSkipped(rule.meta, res.skipped);
    addApplied(rule.meta, res.details ?? res.detail);
  }

  // -------- ФАЗА 4 · ВАЛИДАЦИЯ (весь ассет; при провале .glb НЕ записывается) --------
  progress({ type: 'phase', phase: 4, name: 'валидация' });
  log('    фаза 4/5 · валидация');
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

  const v = result.validation;
  const vp = (level, text) => v.push({ level, text }); // md-отчёт рендерит ✅/ℹ/❌ из level
  // 1. геометрия на месте
  if (before.triangles === 0) vp('info', 'треугольной геометрии не было и нет');
  else if (after.triangles > 0) vp('pass', 'геометрия на месте');
  else vp('fail', 'ГЕОМЕТРИЯ ПУСТАЯ — файл битый!');
  // 2. треугольники не изменились (кроме вырожденных); окно отсчёта — как в v2 (до weld)
  const trianglesBase = ctx.cache.get('trianglesBeforeWeld') ?? before.triangles;
  const degenerateRemoved = ctx.cache.get('degenerateRemoved') ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) vp('pass', 'число треугольников не изменилось');
  else if (triangleDelta === degenerateRemoved) vp('info', `треугольников стало меньше на ${triangleDelta} — только вырожденные (нулевая площадь), рендер идентичен`);
  else vp('fail', `треугольники расходятся: ожидали ${trianglesBase - degenerateRemoved}, получили ${after.triangles}`);
  // 3-5. анимации, скины, сцены
  if (before.animations === after.animations) vp('pass', `анимации: ${after.animations}`);
  else vp('fail', `анимации потеряны: было ${before.animations}, стало ${after.animations}`);
  if (before.skins === after.skins) vp('pass', `действующие скины: ${after.skins}`);
  else vp('fail', `скины потеряны: было ${before.skins}, стало ${after.skins}`);
  if (before.scenes === after.scenes) vp('pass', `иерархия сцен цела: ${after.scenes}`);
  else vp('fail', `сцены потеряны: было ${before.scenes}, стало ${after.scenes}`);
  // 6. bounding box в пределах эпсилон (квантование кодека даёт микросдвиг — допуск 1% диагонали)
  if (before.bounds && after.bounds) {
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds.max[i] - before.bounds.min[i]));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds.min[i] - after.bounds.min[i]) <= eps && Math.abs(before.bounds.max[i] - after.bounds.max[i]) <= eps);
    if (ok) vp('pass', 'bounding box в пределах эпсилон');
    else vp('fail', 'bounding box изменился — модель съехала или схлопнулась');
  } else {
    vp('info', 'bounding box не посчитан (getBounds недоступен или нет сцены)');
  }
  // 7. материалы
  if (materialsOk) vp('pass', 'каждый материал резолвится');
  else vp('fail', 'примитив ссылается на удалённый материал');
  // 8. gltf-validator (Khronos)
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glb));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      vp('pass', 'gltf-validator (Khronos): 0 ошибок');
    } else {
      // вход мог быть битым изначально — проверяем исходник и блокируем только НОВЫЕ ошибки
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      if (inErrs > 0) addFound(ENGINE_META.inputValidation, `входной файл уже содержит ${inErrs} ошибок gltf-validator (дефект экспорта, не оптимизации)`);
      if (errs <= inErrs) {
        vp('info', `gltf-validator: осталось ${errs} ошибок, унаследованных от входа (в исходнике ${inErrs}) — оптимизация новых не добавила`);
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          vp('info', `пример: ${m.code} @ ${m.pointer || '—'}`);
        }
      } else {
        vp('fail', `gltf-validator: ${errs} ошибок (на входе было ${inErrs}) — оптимизация добавила новые`);
      }
    }
  } catch {
    vp('info', 'gltf-validator не установлен — структурная валидация пропущена');
  }

  const validationOk = !v.some((x) => x.level === 'fail');

  // -------- ФАЗА 5 · ОТЧЁТ + запись (.glb пишем ТОЛЬКО если есть applied и валидация прошла) --------
  progress({ type: 'phase', phase: 5, name: 'отчёт' });
  log('    фаза 5/5 · отчёт');
  const writeAsset = !o.dryRun && validationOk && result.applied.length > 0;
  if (writeAsset) fs.writeFileSync(dst, glb);
  const reportName = writeReport(dstName, result, before, after, writeAsset, o);

  result.file.written = writeAsset;
  result.file.reportPath = path.join(o.outDir, reportName);
  result.metrics = { before, after };
  result.status = validationOk ? 'ok' : 'fail'; // fail = валидация не прошла, .glb не записан
  return result;
}

// ---------- отчёт: рендерится централизованно из данных, а не собирается правилами ----------
function diffLine(label, before, after, fmt = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

// уровень → префикс строки валидации в md (разбор обратно: level хранится в RunResult)
const LEVEL_PREFIX = { pass: '✅', info: 'ℹ', fail: '❌' };

function writeReport(name, report, before, after, assetWritten, opts) {
  const flags = (opts.keepParts ? ' · без join' : '')
    + (opts.noKtx ? ' · без KTX2' : ` · текстуры: ${opts.texMode}`)
    + (opts.stripColors ? ' · strip-vertex-colors' : '')
    + (opts.dryRun ? ' · **DRY-RUN**' : '');
  const lines = [
    `# Отчёт оптимизации — ${name}`,
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)} · кодек: ${opts.codec} · автофикс: до «${AUTOFIX_MAX_TIER}»${flags}`,
    '',
    '## Найдено (проблемы)',
    '',
    ...(report.findings.length ? report.findings.map((f) => `- ✓ ${f.text}`) : ['- индивидуальных находок нет (структурная чистка без замечаний)']),
    '',
    '## Пропущено (и почему)',
    '',
    ...(report.skipped.length ? report.skipped.map((s) => `- ${s.text}`) : ['- нет']),
    '',
    '## Применено',
    '',
    ...(report.applied.length ? report.applied.map((a) => `- ${a.text}`) : ['- нет']),
    '',
    '## Валидация',
    '',
    ...report.validation.map((s) => `- ${LEVEL_PREFIX[s.level]} ${s.text}`),
    ...(assetWritten ? [] : [
      '',
      opts.dryRun
        ? '**Режим dry-run** — файл .glb не записан; отчёт показывает, что БЫЛО БЫ сделано (все фазы прогнаны в памяти, цифры точные).'
        : '**Файл .glb НЕ записан** — не было применённых фиксов или валидация не прошла.',
    ]),
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
  // dry-run пишет отчёт под отдельным именем, чтобы не затирать отчёт реального прогона
  const reportName = name.replace(/\.(glb|gltf)$/i, opts.dryRun ? '.dryrun.report.md' : '.report.md');
  fs.writeFileSync(path.join(opts.outDir, reportName), lines.join('\n'), 'utf8');
  return reportName;
}

// ---------- CLI: тонкая обёртка над optimizeFile (поведение — как в v0.0.6) ----------
async function main() {
  const OPTS = parseArgv(process.argv.slice(2));
  initCliLogging(OPTS);
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = fs.readdirSync(INPUT_DIR).filter((f) => /\.(glb|gltf)$/i.test(f)).sort();
  if (!files.length) {
    console.log(`В папке input/ нет .glb/.gltf файлов. Положи модели сюда:\n  ${INPUT_DIR}`);
    return;
  }

  await getIO(); // декодеры и io инициализируются до первого файла, как раньше

  console.log(`Кодек: ${OPTS.codec}`
    + (OPTS.noKtx ? ' | без KTX2' : ` | текстуры: ${OPTS.texMode}`)
    + (OPTS.keepParts ? ' | без join' : '')
    + (OPTS.stripColors ? ' | strip-vertex-colors' : '')
    + (OPTS.dryRun ? ' | DRY-RUN (без записи .glb)' : '')
    + ((OPTS.noKtx ? null : TOKTX) ? '' : ' | toktx НЕ найден'));
  console.log(`Файлов: ${files.length}\n`);

  const pct = (b, a) => (b ? (a <= b ? `−${((1 - a / b) * 100).toFixed(0)}%` : `+${((a / b - 1) * 100).toFixed(0)}%`) : '—');
  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const dstName = f.replace(/\.gltf$/i, '.glb');
      if (!OPTS.dryRun && fs.existsSync(path.join(OUTPUT_DIR, dstName))) {
        console.log(`[ПРОПУСК] ${f} — уже есть в output/`);
        skip++;
      } else {
        console.log(`[РАБОТА] ${f}`);
        const r = await optimizeFile(path.join(INPUT_DIR, f), { ...OPTS, outDir: OUTPUT_DIR, log: (m) => console.log(m) });
        const reportName = r.file.reportPath ? path.basename(r.file.reportPath) : '';
        if (r.status === 'ok') {
          const b = r.metrics.before, a = r.metrics.after;
          const tag = OPTS.dryRun ? '[DRY-RUN]' : '[ГОТОВО]';
          console.log(`${tag} ${dstName}: файл ${MB(b.fileBytes)} → ${MB(a.fileBytes)} МБ (${pct(b.fileBytes, a.fileBytes)}), VRAM ${MB(b.gpuBytes)} → ${MB(a.gpuBytes)} МБ (${pct(b.gpuBytes, a.gpuBytes)})${OPTS.dryRun ? ' — файл НЕ записан' : ''}`);
          console.log(`         отчёт: output/${reportName}`);
          ok++;
        } else if (r.status === 'skip') {
          console.log(`[ПРОПУСК] ${f} — уже есть в output/`);
          skip++;
        } else if (r.error) {
          // исключение внутри optimizeFile (модель не читается и т.п.)
          fail++;
          console.error(`[ОШИБКА] ${f}: ${r.error}`);
        } else {
          // валидация не прошла — отчёт есть, .glb не записан
          fail++;
          console.error(`[ОШИБКА] ${f}: валидация не прошла — .glb НЕ записан, подробности в отчёте`);
          console.log(`         отчёт: output/${reportName}`);
        }
      }
    } catch (e) {
      fail++;
      console.error(`[ОШИБКА] ${f}: ${e.message || e}`);
    }
    console.log();
  }
  console.log(`Итог: готово ${ok}, пропущено ${skip}, ошибок ${fail}`);
}

// ---------- запуск: main() ТОЛЬКО при прямом вызове (node optimize2.mjs), не при import ----------
function isDirectCliRun() {
  if (!process.argv[1]) return false; // REPL / eval — точно не наш CLI
  try {
    const argUrl = pathToFileURL(path.resolve(process.argv[1])).href;
    // Windows: регистр буквы диска/пути не значим; кириллица в обоих URL
    // percent-кодируется одинаково (оба URL строит один и тот же Node)
    return process.platform === 'win32'
      ? argUrl.toLowerCase() === import.meta.url.toLowerCase()
      : argUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectCliRun()) {
  main().catch((e) => { console.error('[ФАТАЛЬНАЯ ОШИБКА]', e && e.stack ? e.stack : e); process.exit(1); });
}
