// glb_web_optimize v3 — умный оптимизатор GLB/glTF: движок + правила
//
// Рефактор v2 → v3 по docs/РЕФАКТОР_v3_движок-правил.md: та же логика, тот же
// результат, но каждая операция — объект-правило в массиве RULES, а обработка
// файла — маленький движок из пяти фаз (АНАЛИЗ → ПЛАН → ПРИМЕНЕНИЕ → ВАЛИДАЦИЯ
// → ОТЧЁТ). Фазы 1–3 идут ДВУМЯ проходами (двухуровневая обработка): сначала
// базовые правила (tier basic, им можно менять структуру), затем checkpoint
// BASELINE_METRICS, затем расширения (tier advanced — только сжатие/кодирование);
// фаза 4 строго сверяет структуру с checkpoint, расхождение блокирует запись.
// Большая архитектура: docs/ARCHITECTURE.md. Копия v2 рядом:
// optimize2_v2_backup.mjs (до подтверждения эквивалентности).
//
// Правила делятся на два уровня (meta.tier, v0.0.8):
//   basic    — безопасны для всех и работают везде: Meshopt, чистка (dedup/prune/weld/
//              degenerate/orphan), текстуры остаются PNG/WebP. Применяются всегда.
//   advanced — опциональные расширения, явный opt-in пользователя (advancedFeatures в API
//              или флаг CLI): KTX2 (нужен KTX2Loader в браузере), Draco (медленный декод),
//              strip-colors (lossy — удаление раскрашенных вершинных цветов), decimation
//              (lossy — упрощение геометрии), decompress-* (распаковка: Draco/Meshopt →
//              стандартная геометрия, KTX2 → PNG).
//
// Принцип обратимости (ARCHITECTURE.md §4d): ядро — не только оптимизатор, но и
// универсальный трансформер моделей. Каждое сжатие по возможности парное с распаковкой;
// meta каждого правила декларирует reversible / reversalRuleId / reversalNote / dataLoss.
//
// Запуск:
//   node optimize2.mjs                        только базовые (Meshopt, чистка, без KTX2)
//   node optimize2.mjs --ktx2                 + расширение: текстуры → KTX2
//   node optimize2.mjs --draco  (или draco)   + расширение: Draco вместо Meshopt
//   node optimize2.mjs --strip-vertex-colors  + расширение: удалить и раскрашенные вершинные цвета
//   node optimize2.mjs --decimation           + расширение: упростить геометрию (lossy, необратимо)
//   node optimize2.mjs --decompress-draco     распаковка: снять Draco, геометрию не пережимать
//   node optimize2.mjs --decompress-meshopt   распаковка: снять Meshopt, геометрию не пережимать
//   node optimize2.mjs --decompress-ktx2      распаковка: текстуры KTX2 → PNG (микропотеря BasisU)
//   node optimize2.mjs --keep-parts           не объединять меши
//   node optimize2.mjs --uastc                при --ktx2: ВСЕ текстуры в UASTC (макс. качество,
//                                             тяжёлый файл; по умолчанию mixed: цвет→ETC1S, data→UASTC)
//   node optimize2.mjs --no-ktx               устарел: KTX2 и так выключен по умолчанию (v0.0.8)
//   node optimize2.mjs --dry-run              полный анализ и отчёт, но без записи .glb
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
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

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
// Расширения (tier advanced) — только явный opt-in флагами; кодек/цвета/KTX2
// выводятся из advancedFeatures в normalizeOpts, здесь не дублируются.
function parseArgv(rawArgv) {
  const argv = rawArgv.map((a) => a.toLowerCase());
  const advancedFeatures = [];
  if (argv.includes('--ktx2')) advancedFeatures.push('ktx2');
  if (argv.includes('draco') || argv.includes('--draco')) advancedFeatures.push('draco');
  if (argv.includes('--strip-vertex-colors')) advancedFeatures.push('strip-colors');
  return {
    advancedFeatures,
    keepParts: argv.includes('--keep-parts'),
    // --no-ktx оставлен для совместимости скриптов: с v0.0.8 KTX2 и так выключен
    // по умолчанию. При явном конфликте (--no-ktx --ktx2) побеждает расширение.
    ...(argv.includes('--no-ktx') ? { noKtx: true } : {}),
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

// ---------- baseline-checkpoint (двухуровневая обработка) ----------
// Метрики-инварианты СТРУКТУРЫ модели. Снимок делается после базовых оптимизаций
// (tier basic) и сверяется после расширений (tier advanced): расширения — только
// сжатие/кодирование, эти значения меняться НЕ должны. Любое будущее расширение
// (Draco, KTX2, decimation, ...) валидируется этой сверкой автоматически, без
// специальных проверок под каждое. VRAM/textureBytes/fileBytes сюда НЕ входят —
// им меняться можно (в этом смысл сжатия).
//
// ОФИЦИАЛЬНЫЕ ГАРАНТИИ КОМПОНЕНТОВ (docs/ARCHITECTURE.md §0a):
//   - Draco (google/draco 1.5.7): НЕ меняет количество треугольников и топологию
//     mesh; квантизация трогает только точность позиций/нормалей.
//   - Meshopt (zeux/meshoptimizer через EXT_meshopt_compression): НЕ меняет
//     топологию, кодирование полностью обратимо.
//   - KTX2 (@gltf-transform/extensions + toktx): кодирует ТОЛЬКО текстуры,
//     геометрия/сцена/анимации неизменны.
//   - strip-colors и прочие атрибутные операции: не трогают baseline-метрики.
// Следствие: расхождение baseline после второго прохода — ВСЕГДА ошибка
// (неправильное применение компонента, баг в библиотеке или недочищенный вход),
// а не «допустимая погрешность». Поэтому сверка STRICT, без допусков.
const BASELINE_METRICS = ['triangles', 'drawCalls', 'skins', 'nodes', 'animations'];

function baselineSnapshot(doc) {
  const { drawCalls, triangles } = sceneGeometry(doc);
  return {
    triangles,
    drawCalls,
    skins: effectiveSkins(doc),
    nodes: doc.getRoot().listNodes().length,
    animations: doc.getRoot().listAnimations().length,
  };
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
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: ['texture', 'material', 'accessor'],
      reversible: false, dataLoss: 'none', // склеиваются только байт-в-байт идентичные копии — терять нечего
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
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      reversible: false, dataLoss: 'none', // удаляется только то, на что нет ни одной ссылки
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
      // tier basic: базовое действие — удаление БЕЛЫХ каналов (provable, вид не меняется).
      // Lossy-ветка (удалить раскрашенные) — расширение 'strip-colors': включается только
      // через advancedFeatures:['strip-colors'] или флаг --strip-vertex-colors (→ opts.stripColors).
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Вершинные цвета (COLOR_n)',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      // базовая ветка (белые каналы) — потери нет; strip-ветка помечает свои строки
      // через res.irreversible → dataLoss 'significant' на уровне applied-записи
      reversible: false, dataLoss: 'none',
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
              (out.irreversible ??= []).push(`${where}: РАСКРАШЕН, удалён по флагу --strip-vertex-colors — вид может измениться`);
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
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // свариваются только идентичные вершины
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
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/weld'], touches: ['geometry'],
      reversible: false, dataLoss: 'none', // нулевая площадь — не рисовались
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
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // не адресованы индексами — не рисовались
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
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['geometry/orphan-vertices'], touches: ['geometry', 'node'],
      reversible: false, dataLoss: 'significant', // §4d: структура узлов и имена частей теряются безвозвратно
      reversalNote: 'Иерархия узлов и отдельные части объединены — из результата их не восстановить. Чтобы сохранить части, используйте --keep-parts.',
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
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      reversible: false, dataLoss: 'none', // только осиротевшие после предыдущих фиксов ресурсы
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
      // ADVANCED: KTX2 требует KTX2Loader (Three.js) / поддержку basisu в движке —
      // работает не «везде», поэтому только явный opt-in (advancedFeatures:['ktx2'] / --ktx2).
      // normalizeOpts переводит выбор фичи в noKtx:false — enabled смотрит на итоговую опцию.
      id: 'textures/ktx2', category: 'textures', title: 'Текстуры → KTX2/UASTC',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: true, dataLoss: 'minor', // §4d: KTX2 ↔ PNG/WebP, потеря от BASIS-U распаковки
      reversalNote: 'KTX2 можно распаковать обратно в PNG/WebP с небольшой потерей качества (BASIS-декодирование).',
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
      // tier basic: сжатие как таковое базовое (Meshopt работает везде и всегда полезно).
      // Advanced-часть — ВЫБОР кодека Draco: advancedFeatures:['draco'] / --draco
      // переключает opts.codec в normalizeOpts; само правило остаётся в базовом плане.
      id: 'geometry/compress', category: 'geometry', title: 'Сжатие геометрии',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'none', // §4d: Draco/Meshopt ↔ стандартный формат в пределах точности float32
      reversalNote: 'Сжатая геометрия распаковывается обратно в стандартный формат без потери данных.',
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

// Расширенные возможности (tier advanced): id → человекочитаемое имя для ошибок.
// Каждая фича транслируется в конкретную опцию ядра ниже в normalizeOpts.
const ADVANCED_FEATURES = {
  ktx2: 'текстуры → KTX2 (нужна поддержка в браузере/движке)',
  draco: 'сжатие геометрии Draco вместо Meshopt',
  'strip-colors': 'удаление раскрашенных вершинных цветов (lossy)',
};

// Значения по умолчанию — ровно как у CLI без флагов (контракт §4b): ТОЛЬКО базовые
// оптимизации, расширения — через advancedFeatures. Неизвестная фича → Error
// (optimizeFile превратит его в status:'fail', а не молча проигнорирует).
function normalizeOpts(opts = {}) {
  const adv = [...new Set((opts.advancedFeatures || []).map(String))];
  const unknown = adv.filter((f) => !(f in ADVANCED_FEATURES));
  if (unknown.length) {
    throw new Error(`Неизвестные advancedFeatures: ${unknown.join(', ')}. Доступные: ${Object.keys(ADVANCED_FEATURES).join(', ')}.`);
  }
  return {
    advancedFeatures: adv,
    // фича 'draco' переключает кодек; явный codec:'draco' (legacy) тоже работает
    codec: opts.codec === 'draco' || adv.includes('draco') ? 'draco' : 'meshopt',
    texMode: opts.texMode === 'uastc' ? 'uastc' : 'mixed',
    keepParts: !!opts.keepParts,
    // KTX2 с v0.0.8 по умолчанию ВЫКЛЮЧЕН (advanced). Приоритет: фича 'ktx2' >
    // явный boolean noKtx (legacy-вызовы с noKtx:false сохраняют смысл) > default true.
    // Фича обязана побеждать: baseline-профили передают noKtx:true, а web-interface
    // добавляет advancedFeatures поверх них — иначе KTX2 не включить вовсе.
    noKtx: adv.includes('ktx2') ? false : (typeof opts.noKtx === 'boolean' ? opts.noKtx : true),
    stripColors: !!opts.stripColors || adv.includes('strip-colors'),
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
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable', reversible: true, dataLoss: 'none' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none', reversible: true, dataLoss: 'none' },
};

export async function optimizeFile(srcPath, opts = {}) {
  const src = path.resolve(String(srcPath));
  const dstName = path.basename(src).replace(/\.gltf$/i, '.glb');
  const result = {
    status: 'ok',
    file: { src, dst: null, written: false, reportPath: null },
    findings: [],   // { ruleId, category, severity, fixSafety, text }
    skipped: [],    // { ruleId, text, reason }
    applied: [],    // { ruleId, fixSafety, reversible, dataLoss, text } — обратимость по §4d
    validation: [], // { level: 'pass'|'info'|'fail', text }
    metrics: { before: null, after: null },
  };
  try {
    // normalizeOpts внутри try: неизвестная advancedFeature → status:'fail', не исключение наружу
    const o = normalizeOpts(opts);
    result.file.dst = path.join(o.outDir, dstName);
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
  // over — переопределение полей обратимости для отдельных строк (lossy-ветки правил,
  // см. res.irreversible): базовое поведение правила может быть без потерь, а форсированное — нет
  const addApplied = (meta, v, over = {}) => {
    for (const text of asLines(v)) {
      result.applied.push({
        ruleId: meta.id,
        fixSafety: meta.fixSafety,
        reversible: over.reversible ?? meta.reversible ?? false,
        dataLoss: over.dataLoss ?? meta.dataLoss ?? 'none',
        text,
      });
    }
  };

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

  // ==========================================================================
  // ДВУХУРОВНЕВАЯ ОБРАБОТКА: фазы 1–3 идут ДВУМЯ проходами.
  //   Проход 1 — базовые (tier basic): чистка, ей МОЖНО менять структуру
  //              (вырожденные треугольники, join, пустышки-скины).
  //   *** CHECKPOINT: снимок BASELINE_METRICS (структура зафиксирована) ***
  //   Проход 2 — расширения (tier advanced): ТОЛЬКО сжатие/кодирование,
  //              структура меняться не должна — сверка с baseline в фазе 4.
  // Порядок пайплайна v2 сохраняется: базовое правило, зависящее (runAfter) от
  // ВКЛЮЧЁННОГО расширения (geometry/compress после textures/ktx2), уходит во
  // второй проход вместе с ним — иначе сжатие геометрии выполнилось бы до KTX2.
  // ==========================================================================
  const orderedRules = orderRules(RULES);
  const activeCount = orderedRules.filter((r) => r.meta.enabled(o)).length;
  const basicPass = [];
  const advancedPass = [];
  const deferredIds = new Set(); // id правил, реально выполняющихся во втором проходе
  for (const rule of orderedRules) {
    const dependsOnDeferred = (rule.meta.runAfter || []).some((d) => deferredIds.has(d));
    if (rule.meta.tier === 'advanced' || dependsOnDeferred) {
      advancedPass.push(rule);
      if (rule.meta.enabled(o)) deferredIds.add(rule.meta.id);
    } else {
      basicPass.push(rule);
    }
  }

  // Фазы 1–2 одного прохода: АНАЛИЗ (только чтение; анализируются и невыбранные
  // расширения — их находки видны в отчёте, advanced ≠ невидимый) + ПЛАН.
  const analyzeAndPlan = (rules) => {
    const findings = [];
    for (const rule of rules) {
      for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
    }
    const planned = [];
    for (const { rule, finding } of findings) {
      if (!rule.meta.enabled(o)) {
        if (rule.meta.tier === 'advanced') {
          // расширение не выбрано пользователем — явная строка «Пропущено» с подсказкой
          const reason = `расширение «${rule.meta.feature}» не включено (advancedFeatures: ['${rule.meta.feature}'] или флаг --${rule.meta.feature})`;
          addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason);
        }
        // базовое правило, выключенное опцией (например --keep-parts), — молча, как раньше
        continue;
      }
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
    return planned;
  };

  // Фаза 3 одного прохода: ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию)
  const applyPlanned = async (planned) => {
    for (const { rule, finding } of planned) {
      progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: rule.meta.title });
      log(`      • ${rule.meta.title}`);
      const res = (await rule.fix(finding, ctx)) || {};
      addFound(rule.meta, res.found);
      addSkipped(rule.meta, res.skipped);
      addApplied(rule.meta, res.details ?? res.detail);
      // строки с безвозвратной потерей данных (§4d) — UI предупредит перед скачиванием
      addApplied(rule.meta, res.irreversible, { reversible: false, dataLoss: 'significant' });
    }
  };

  // -------- ПРОХОД 1 · БАЗОВЫЕ (фазы 1–3) --------
  // события onProgress фаз 1–3 шлём один раз (на базовом проходе): номера фаз
  // для потребителей остаются монотонными 1→5, контракт §4b не меняется
  progress({ type: 'phase', phase: 1, name: 'анализ' });
  log(`    фаза 1/5 · анализ (правил: ${orderedRules.length}, активно: ${activeCount})`);
  progress({ type: 'phase', phase: 2, name: 'план' });
  log('    фаза 2/5 · план');
  const basicPlanned = analyzeAndPlan(basicPass);
  progress({ type: 'phase', phase: 3, name: 'применение' });
  log(`    фаза 3/5 · применение · базовые (${basicPlanned.length} фиксов)`);
  await applyPlanned(basicPlanned);

  // *** CHECKPOINT: BASELINE METRICS после базовых оптимизаций ***
  // Дальше структура модели зафиксирована; расширениям разрешено менять только
  // кодирование (байты/VRAM). Сверка — в фазе 4, расхождение блокирует запись.
  // Снимок берётся именно ЗДЕСЬ (после прохода 1, перед проходом 2), потому что
  // базовым правилам (degenerate-triangles, orphan-vertices, join, prune) менять
  // структуру МОЖНО — это их работа. А расширения второго прохода по официальным
  // гарантиям (ARCHITECTURE.md §0a: Draco/Meshopt/KTX2) структуру не меняют никогда.
  ctx.baselineMetrics = baselineSnapshot(ctx.document);
  log(`      baseline-checkpoint: ${BASELINE_METRICS.map((k) => `${k}=${ctx.baselineMetrics[k]}`).join(', ')}`);

  // -------- ПРОХОД 2 · РАСШИРЕНИЯ (фазы 1–3 повторно, только advanced и отложенные) --------
  const advancedPlanned = analyzeAndPlan(advancedPass);
  if (advancedPlanned.length) log(`      расширения (${advancedPlanned.length} фиксов)`);
  await applyPlanned(advancedPlanned);

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
  // 2b. BASELINE-CHECKPOINT (двухуровневая обработка): после базовых оптимизаций структура
  // зафиксирована — расширения (tier advanced) обязаны её не трогать. Сверяем снимок
  // с метриками РЕАЛЬНЫХ байтов будущего файла (after) — STRICT, без допусков.
  // Любое будущее расширение валидируется этой сверкой автоматически.
  //
  // По официальной документации компонентов (docs/ARCHITECTURE.md §0a):
  // Draco НЕ меняет количество треугольников и топологию mesh; Meshopt НЕ меняет
  // топологию (обратимое кодирование); KTX2 кодирует только текстуры. Поэтому
  // ЛЮБОЕ расхождение baseline-метрик после расширений = нарушение гарантии:
  // неправильное применение компонента, баг в библиотеке (gltf-transform / кодек)
  // или недочищенный вход (вырожденные треугольники не сняты базовыми правилами).
  {
    const baseline = ctx.baselineMetrics;
    // лог для отладки: полная сверка по каждой метрике, независимо от исхода
    for (const k of BASELINE_METRICS) {
      log(`      [baseline-validate] ${k}: ${baseline[k]} → ${after[k]}${after[k] === baseline[k] ? '' : '  ← РАСХОЖДЕНИЕ'}`);
    }
    const broken = BASELINE_METRICS.filter((k) => after[k] !== baseline[k]);
    if (broken.length === 0) {
      vp('pass', `baseline-checkpoint: структура (${BASELINE_METRICS.join(', ')}) совпадает с контрольной точкой после базовых оптимизаций`);
    } else {
      const cause = advancedPlanned.length
        ? `расширения второго прохода (${advancedPlanned.map((p) => p.rule.meta.id).join(', ')}) или запись файла`
        : 'запись файла (второй проход фиксов не применялся)';
      for (const k of broken) {
        vp('fail',
          `Нарушена гарантия компонента: ${k} изменился после расширений (было ${baseline[k]} на checkpoint, стало ${after[k]}). `
          + `По официальной документации (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 не меняют структуру mesh. `
          + `Вероятная причина: ${cause} — баг в библиотеке или неправильное применение компонента. Файл НЕ записан.`);
      }
    }
  }
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
  // normalizeOpts сразу: codec/noKtx/stripColors выводятся из advancedFeatures,
  // консоль и лог показывают ИТОГОВЫЕ значения (двойная нормализация идемпотентна)
  const OPTS = normalizeOpts(parseArgv(process.argv.slice(2)));
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
    + (OPTS.advancedFeatures.length ? ` | расширения: ${OPTS.advancedFeatures.join(', ')}` : ' | только базовые')
    // предупреждение про toktx уместно только когда KTX2 реально включён
    + (OPTS.noKtx || TOKTX ? '' : ' | toktx НЕ найден'));
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
