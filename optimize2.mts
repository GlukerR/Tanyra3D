// Tanyra3D — умный оптимизатор GLB/glTF: тонкий вход над движком и аддонами.
//
// Архитектура (Фаза C, docs/ARCHITECTURE.md §4b): формат-агностичный движок из пяти фаз —
// core/engine.mjs; реестр аддонов по расширению файла — core/registry.mjs; вся
// glTF-специфика (10 правил, метрики, IO, валидация, отчёт, внешний тулинг) — аддон
// addons/gltf/. GLB-аддон всегда включён и невыключаем: снаружи (CLI, server.mjs,
// assistant.mjs, ui/, profiles/) ничего не меняется — контракты §4b/§4c те же.
//
// v0.1.1: ядро — opt-in (docs/ARCHITECTURE §4b). По умолчанию (программный API,
// advancedFeatures:[]) — passthrough, ничего не меняется. Каждое правило гейтится
// своим флажком через meta.enabled(opts): safe (dedup/prune/weld/degenerate/orphan),
// meshopt/draco (geometry/compress), join (scene/join), ktx2, strip-colors.
// Двухуровневая обработка (meta.tier basic/advanced) в движке — это порядок ДВУХ
// проходов вокруг baseline-checkpoint (структурные правки — до, кодирование — после),
// а не признак «применяется всегда»; basic-правила тоже все opt-in.
//
// CLI НИЖЕ сохраняет старое поведение ПРЕСЕТОМ (см. parseArgv): без флагов — это не
// «только базовые», это готовый набор safe+meshopt+join (как было до v0.1.1).
//
// Запуск:
//   node optimize2.mjs                        пресет: safe + meshopt + join (без KTX2)
//   node optimize2.mjs --none / --passthrough отключить пресет — явный passthrough
//   node optimize2.mjs --ktx2                 + расширение: текстуры → KTX2
//   node optimize2.mjs --draco  (или draco)   + расширение: Draco вместо Meshopt
//   node optimize2.mjs --strip-vertex-colors  + расширение: удалить и раскрашенные вершинные цвета
//   node optimize2.mjs --keep-parts           не объединять меши (снимает join из пресета)
//   node optimize2.mjs --uastc                при --ktx2: ВСЕ текстуры в UASTC (точнее)
//   node optimize2.mjs --etc1s                при --ktx2: цвет в ETC1S (легче), карты в UASTC
//   node optimize2.mjs --no-ktx               устарел: KTX2 и так выключен по умолчанию
//   node optimize2.mjs --dry-run              полный анализ и отчёт, но без записи .glb
//
// Вход: input/*.glb, *.gltf, *.stl, *.ply  →  Выход: output/*.glb + output/*.report.md
// Список расширений один на всё приложение и живёт в аддоне (addons/gltf, поле formats).
//
// Программный API (контракт: docs/ARCHITECTURE.md §4b, раздел Б):
//   import { optimizeFile, listRules, VERSION } from './optimize2.mjs';
// При импорте main() НЕ запускается, консоль не перехватывается, логи не пишутся.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runOptimize } from './core/engine.mjs';
import { Registry } from './core/registry.mjs';
import gltfAddon from './addons/gltf/index.mjs';
import { GLTF_CLI, GLTF_CLI_JS, TOKTX } from './addons/gltf/tools.mjs';
import { MB } from './addons/gltf/metrics.mjs';

import type { Addon, RunResult, RuleMeta } from './core/types.mjs';

/** Консоль как таблица методов: перехват идёт по ИМЕНИ, а не по известному полю. */
type ConsoleTable = Record<string, (...a: any[]) => void>;

/** Два числа, которые печатает сводка CLI. Есть у любого формата, шире ей не нужно. */
type CliMetrics = { fileBytes: number; gpuBytes: number };

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(BASE_DIR, 'input');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_KEEP_DAYS = 30; // логи старше — удаляются при следующем запуске

// Реестр аддонов. GLB-аддон всегда включён и невыключаем (единственный формат ядра).
// Приведение здесь — единственное место, где glTF-аддон встречается с формой, которую
// ждёт движок, и оно осознанное. Правила аддона принимают СВОЙ контекст и свои опции,
// а правило движка обязано принимать любые: формально это сужение входа, то есть
// подстановка, которую компилятор запретить обязан (подробнее — GltfRule в
// addons/gltf/types.mts). Во время работы подстановка верна: движок зовёт правила
// аддона только с тем контекстом, который сам же собрал из загруженного этим аддоном
// документа. Один cast в композиционном корне честнее, чем ослабление типов у всех
// десяти правил.
const registry = new Registry().register(gltfAddon as unknown as Addon);

// ============================================================================
// ПУБЛИЧНЫЙ API (контракт: docs/ARCHITECTURE.md §4b, раздел Б).
// CLI ниже — тонкая обёртка над optimizeFile.
// ============================================================================

export const VERSION = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8')).version;

// read-only копии meta всех правил всех аддонов: мутации у потребителя не влияют на движок
export function listRules(): RuleMeta[] {
  const out: RuleMeta[] = [];
  for (const addon of registry.addons()) {
    for (const r of addon.rules) {
      out.push({ ...r.meta, runAfter: [...(r.meta.runAfter || [])], touches: [...(r.meta.touches || [])] });
    }
  }
  return out;
}

// Группы взаимоисключающих опций — объявляет аддон, а интерфейс читает отсюда.
// Раньше свой список держал ui/app.js: два независимых объявления, которые никто не
// сверял и которые уже разошлись. Аддон, не умеющий их объявить, просто не даёт
// групп — это не ошибка, а отсутствие взаимоисключений в его формате.
export function exclusiveGroups(): Array<{ id: string; members: string[] }> {
  const out: Array<{ id: string; members: string[] }> = [];
  for (const addon of registry.addons()) {
    if (typeof addon.exclusiveGroups !== 'function') continue;
    for (const g of addon.exclusiveGroups()) out.push({ ...g, members: [...g.members] });
  }
  return out;
}

export async function optimizeFile(srcPath: string, opts: Record<string, unknown> = {}): Promise<RunResult> {
  let addon: Addon;
  try {
    addon = registry.resolve(srcPath); // формат по расширению; неподдержанный → status:'fail'
  // `any`, а не `unknown`: выражение ниже сохранено дословно (см. тот же приём в CLI).
  } catch (e: any) {
    return {
      status: 'fail' as const,
      file: { src: path.resolve(String(srcPath)), dst: null, written: false, reportPath: null },
      findings: [], skipped: [], applied: [], validation: [], metrics: { before: null, after: null },
      error: e && e.message ? e.message : String(e),
    };
  }
  return runOptimize(addon, srcPath, opts);
}

// Инспекция ассета без оптимизации: метаданные + валидация (для окон Metadata/Validation).
// Формат-агностично: ядро резолвит аддон по расширению и зовёт его хук inspect().
export async function inspectFile(srcPath: string) {
  const addon = registry.resolve(srcPath);
  if (typeof addon.inspect !== 'function') {
    return { format: null, asset: {}, extensions: [], metadata: null, metrics: null, validation: [] };
  }
  return addon.inspect(srcPath);
}

// Экспорт ассета как самодостаточного JSON (для «Export as JSON»). Формат-агностично.
export async function exportJson(srcPath: string) {
  const addon = registry.resolve(srcPath);
  if (typeof addon.toJSON !== 'function') throw new Error('This format does not support JSON export.');
  return addon.toJSON(srcPath);
}

// ============================================================================
// CLI: тонкая обёртка над optimizeFile (поведение — как в v0.0.6).
// ============================================================================

// ---------- логи (только CLI): всё из консоли дублируется в файл logs/run_*.log ----------
// Вызывается ТОЛЬКО из CLI-пути: при импорте как модуля консоль не перехватывается.
function initCliLogging(opts: { dryRun?: boolean } & Record<string, unknown>) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  const logFile = path.join(LOG_DIR, `run_${stamp}.log`);
  const logLines = [`=== Tanyra3D · run ${new Date().toISOString()} ===`, `argv: ${process.argv.slice(2).join(' ') || '(no arguments)'}`];
  // Перехват идёт по ИМЕНИ метода, поэтому консоль здесь — таблица функций, а не класс
  // с известными полями: приведение стоит прямо на обращении и в собранный код не попадает.
  // `any` у списка аргументов — сознательно: сюда приходит что угодно, включая ошибки, и
  // выражение ниже (`x && x.stack`) должно остаться дословно тем же, что было до перевода.
  // Замена его на `x?.stack` дала бы тот же результат, но это уже правка, а не перенос.
  for (const m of ['log', 'error', 'warn']) {
    const orig = (console as unknown as ConsoleTable)[m]!.bind(console);
    (console as unknown as ConsoleTable)[m] = (...a: any[]) => {
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

  logLines.push(`node: ${process.version} | CLI: ${GLTF_CLI_JS || GLTF_CLI || 'not found'} | toktx: ${(opts.noKtx ? null : TOKTX) || 'not found'}`);
}

// ---------- аргументы CLI → opts (та же форма, что принимает optimizeFile) ----------
// Расширения (tier advanced) — только явный opt-in флагами; кодек/цвета/KTX2
// выводятся из advancedFeatures в addon.normalizeOpts, здесь не дублируются.
function parseArgv(rawArgv: string[]) {
  const argv = rawArgv.map((a) => a.toLowerCase());
  const has = (f: string) => argv.includes(f);
  const advancedFeatures: string[] = [];

  // v0.1.1: ядро — opt-in (по умолчанию passthrough). CLI СОХРАНЯЕТ прежнее поведение
  // пресетом (решение Александра): без флагов = безопасная чистка + склейка + meshopt.
  // --none / --passthrough отключает пресет (только явно выбранные оптимизации).
  const preset = !(has('--none') || has('--passthrough'));
  const draco = has('draco') || has('--draco');
  if (preset) {
    advancedFeatures.push('safe', draco ? 'draco' : 'meshopt');
    if (!has('--keep-parts')) advancedFeatures.push('join');
  } else if (draco) {
    advancedFeatures.push('draco');
  }
  if (has('--ktx2')) advancedFeatures.push('ktx2');
  if (has('--strip-vertex-colors')) advancedFeatures.push('strip-colors');

  return {
    advancedFeatures: [...new Set(advancedFeatures)],
    keepParts: argv.includes('--keep-parts'),
    // --no-ktx оставлен для совместимости скриптов: с v0.0.8 KTX2 и так выключен
    // по умолчанию. При явном конфликте (--no-ktx --ktx2) побеждает расширение.
    ...(argv.includes('--no-ktx') ? { noKtx: true } : {}),
    // Режим KTX2 CLI НЕ назначает. Умолчание — одно на всю программу, и живёт оно
    // у аддона (addons/gltf/index.mjs, normalizeOpts), а поверх него его вправе
    // задать профиль площадки.
    //
    // Почему убрано (2026-08-07). Здесь стояло `mixed`, в аддоне и в интерфейсе —
    // `uastc`. Одна и та же модель с одной и той же галочкой KTX2 выходила из
    // терминала в ETC1S, а из браузера в UASTC: разный вес, разное качество,
    // разная видеопамять. Нигде об этом не было сказано, потому что никто этого
    // не решал — просто два места отвечали на один вопрос по-разному.
    //
    // Флаги ниже — ЯВНЫЙ выбор человека, он побеждает и аддон, и профиль. Без них
    // ключа в опциях нет вовсе: «не сказал» и «сказал uastc» — разные вещи, и
    // только первое оставляет решение тому, кто за него отвечает.
    // При «--uastc --etc1s» побеждает --uastc: из двух он тот, что ничего не ухудшает.
    // Тот же принцип, что у пары --no-ktx/--ktx2 выше — выигрывает более осторожный.
    ...(has('--uastc') ? { texMode: 'uastc' } : has('--etc1s') ? { texMode: 'mixed' } : {}),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  // normalizeOpts сразу: codec/noKtx/stripColors выводятся из advancedFeatures,
  // консоль и лог показывают ИТОГОВЫЕ значения (двойная нормализация идемпотентна)
  const OPTS = gltfAddon.normalizeOpts(parseArgv(process.argv.slice(2)));
  initCliLogging(OPTS);
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Список расширений берём У АДДОНА, а не пишем здесь заново. Своя копия разошлась бы с
  // интерфейсом при первом же новом формате, и разошлась бы МОЛЧА: командная строка не
  // заметила бы файл, лежащий в input/, и сказала бы «моделей нет».
  const accept = new RegExp(`\\.(${gltfAddon.formats.join('|')})$`, 'i');
  const files = fs.readdirSync(INPUT_DIR).filter((f) => accept.test(f)).sort();
  if (!files.length) {
    const list = gltfAddon.formats.map((e) => `.${e}`).join(', ');
    console.log(`No model files in input/ (${list}). Put models here:\n  ${INPUT_DIR}`);
    return;
  }

  await gltfAddon.createIO(); // декодеры и io инициализируются до первого файла, как раньше

  console.log(`Codec: ${OPTS.codec}`
    + (OPTS.noKtx ? ' | no KTX2' : ` | textures: ${OPTS.texMode}`)
    + (OPTS.keepParts ? ' | no join' : '')
    + (OPTS.stripColors ? ' | strip-vertex-colors' : '')
    + (OPTS.dryRun ? ' | DRY-RUN (no .glb written)' : '')
    + (OPTS.advancedFeatures.length ? ` | extensions: ${OPTS.advancedFeatures.join(', ')}` : ' | basic only')
    // предупреждение про toktx уместно только когда KTX2 реально включён
    + (OPTS.noKtx || TOKTX ? '' : ' | toktx NOT found'));
  console.log(`Files: ${files.length}\n`);

  const pct = (b: number, a: number) => (b ? (a <= b ? `−${((1 - a / b) * 100).toFixed(0)}%` : `+${((a / b - 1) * 100).toFixed(0)}%`) : '—');
  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const dstName = f.replace(/\.gltf$/i, '.glb');
      if (!OPTS.dryRun && fs.existsSync(path.join(OUTPUT_DIR, dstName))) {
        console.log(`[SKIP] ${f} — already in output/`);
        skip++;
      } else {
        console.log(`[WORKING] ${f}`);
        const r = await optimizeFile(path.join(INPUT_DIR, f), { ...OPTS, outDir: OUTPUT_DIR, log: (m: string) => console.log(m) });
        const reportName = r.file.reportPath ? path.basename(r.file.reportPath) : '';
        if (r.status === 'ok') {
          // Статус 'ok' означает, что прогон дошёл до конца, — метрики при нём есть обе.
          // Приведение к CliMetrics: состав метрик задаёт аддон, и для ядра это словарь
          // с неизвестными значениями. Сводке CLI нужны ровно два числа, они есть у
          // любого формата, — сужаем до них, а не тащим сюда типы glTF.
          const b = r.metrics.before as CliMetrics, a = r.metrics.after as CliMetrics;
          const tag = OPTS.dryRun ? '[DRY-RUN]' : '[DONE]';
          console.log(`${tag} ${dstName}: file ${MB(b.fileBytes)} → ${MB(a.fileBytes)} MB (${pct(b.fileBytes, a.fileBytes)}), VRAM ${MB(b.gpuBytes)} → ${MB(a.gpuBytes)} MB (${pct(b.gpuBytes, a.gpuBytes)})${OPTS.dryRun ? ' — file NOT written' : ''}`);
          console.log(`         report: output/${reportName}`);
          ok++;
        } else if (r.status === 'skip') {
          console.log(`[SKIP] ${f} — already in output/`);
          skip++;
        } else if (r.error) {
          // исключение внутри optimizeFile (модель не читается и т.п.)
          fail++;
          console.error(`[ERROR] ${f}: ${r.error}`);
        } else {
          // Валидация не прошла. Файл при этом ЗАПИСАН (решение Александра 2026-07-30):
          // отказ должен быть громким, а не запирающим. До 2026-08-10 здесь стояло
          // «.glb NOT written» — прямая неправда в самом заметном месте вывода, из-за
          // которой человек не искал файл, который лежал на диске. Ревью (P1.4).
          fail++;
          const where = r.file && r.file.written ? `.glb written to ${r.file.dst}` : '.glb NOT written';
          console.error(`[ERROR] ${f}: validation failed — ${where}; see the report before using it`);
          console.log(`         report: output/${reportName}`);
        }
      }
    // `any`, а не `unknown`: прежняя строка звучала `e.message || e` и на пустом `e`
    // падала бы прямо в catch. Поведение сохранено дословно — сузить его до `e?.message`
    // значит починить край, которого перенос касаться не должен.
    } catch (e: any) {
      fail++;
      console.error(`[ERROR] ${f}: ${e.message || e}`);
    }
    console.log();
  }
  console.log(`Summary: done ${ok}, skipped ${skip}, errors ${fail}`);
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
  main().catch((e) => { console.error('[FATAL ERROR]', e && e.stack ? e.stack : e); process.exit(1); });
}
