// server.mjs — локальный веб-сервер для v0.1.0 (glb-web-optimize)
// Только node:http и встроенные модули — без новых npm-зависимостей.
// Отдаёт статику ui/, вызывает ядро (optimize2.mjs) и ассистента (assistant.mjs, если есть),
// принимает GLB по drag&drop, отдаёт результат + отчёт для человека без терминала.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 3210 по умолчанию; переопределяется PORT — чтобы можно было поднять второй экземпляр
// (например, проверить правки, пока на 3210 работает уже запущенный).
//
// PORT=0 значит «любой свободный, выбери сама» — так просит настольное приложение.
// Через `Number(...) || 3210` этот ноль было не передать: ноль ложен, и запрос на
// свободный порт молча превращался в тот самый занятый 3210.
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3210;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 3210;
})();

// Слушаем ТОЛЬКО петлевой интерфейс. `listen(PORT)` без хоста в Node значит
// «unspecified address» — обычно `::` или `0.0.0.0`, то есть все сетевые карты машины.
// У API нет ни токена, ни пароля: любой в той же сети (кафе, коворкинг, гостиница,
// гостевой Wi-Fi) мог обратиться к нему напрямую — загрузить модель, прочитать чужую,
// занять диск. Программа настольная, снаружи к ней обращаться некому.
// Ревью 2026-08-10 (P0.1).
//
// TANYRA_HOST оставлен на случай, когда это нужно осознанно (проверка с телефона в
// своей сети, докер). По умолчанию его нет, и по умолчанию сервер недоступен извне.
const HOST = process.env.TANYRA_HOST || '127.0.0.1';

const UI_DIR = path.join(__dirname, 'ui');

// Рабочая папка: загруженные модели и собранные результаты.
//
// Рядом с сервером её держать нельзя — установленная программа лежит там, куда писать
// не дают. `C:\Program Files` на Windows доступен только администратору, и первый же
// mkdir падает с EPERM ещё до открытия порта: окно не появляется вовсе (Александр,
// 2026-08-09, установка 0.0.12 в Program Files). На macOS то же самое внутри .app,
// на Linux — внутри /opt и /usr.
//
// Поэтому адрес называет тот, кто знает раскладку: оболочка Electron передаёт папку
// данных пользователя (desktop/main.cjs). Тот же приём, что и с TANYRA_TOOLS_DIR —
// сервер не должен догадываться, как устроен собранный пакет.
//
// Нет переменной — прежнее поведение, `_web/` в корне проекта: при запуске из
// исходников это удобно, там всё под рукой и папка в .gitignore.
const DATA_DIR = process.env.TANYRA_DATA_DIR || path.join(__dirname, '_web');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
// three.js для встроенного просмотрщика отдаётся прямо из node_modules (пакет-зависимость,
// см. package.json). Никакого бандлера/CDN — браузер грузит нативные ESM через importmap
// (см. ui/index.html), а декодеры Draco/KTX2 — по путям /vendor/three/examples/jsm/libs/...
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
// Плагин KHR_animation_pointer к загрузчику three.js (@needle-tools, MIT, ~60 КБ).
// Отдаётся тем же способом, что и сам three: сырые ESM из node_modules, importmap в
// ui/index.html. Отдельная константа, а не подпапка three, — пакет чужой и обновляется
// своим циклом; см. docs/ЗАВИСИМОСТИ.md.
const ANIM_POINTER_DIR = path.join(__dirname, 'node_modules', '@needle-tools', 'three-animation-pointer');
// Плагины к загрузчику three.js, которых нет в самом three (takahirox, MIT, ~62 КБ на
// все). Нам нужен один — KHR_materials_variants: запасные цвета и отделки модели.
// Ссылка на этот репозиторий стоит в документации самого GLTFLoader.
const GLTF_EXT_DIR = path.join(__dirname, 'node_modules', 'three-gltf-extensions');

// Никаких накоплений: на старте чистим прежние загрузки/результаты (только текущая
// оптимизация хранится на диске — см. purgeBeyondLimit).
// Чистим СОДЕРЖИМОЕ, а не саму папку: на Windows удалённый каталог остаётся в состоянии
// pending-delete, и немедленный mkdir того же имени падает (UNKNOWN errno -4094).
async function ensureEmptyDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const entry of entries) {
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
  }
}
await ensureEmptyDir(UPLOADS_DIR);
await ensureEmptyDir(RESULTS_DIR);

// ---- Ядро (обязательный контракт §4b ARCHITECTURE.md) ----
const core = await import('./optimize2.mjs');
const { optimizeFile, inspectFile, exportJson, VERSION, exclusiveGroups } = core;
// Каталоги сообщений правил регистрирует аддон при импорте ядра выше — поэтому
// localizeResult здесь умеет пересобрать строки отчёта на любом подключённом языке.
const { localizeResult } = await import('./core/i18n.mjs');

/**
 * Ассистент подключается по-настоящему динамически: его может не быть (graceful-фолбэк
 * ниже), поэтому тип берётся у самого модуля, а не описывается здесь заново.
 */
type AssistantModule = typeof import('./assistant.mjs');

/**
 * Ответ planFor: состав задают профиль площадки и движок, то есть ДАННЫЕ. У фолбэка
 * (ассистента нет) полей меньше, и читающий код это учитывает — `plan.engine || …`.
 * Описывать здесь объединение двух форм значило бы дублировать данные типом.
 */
type PlanLike = Record<string, any>;

// ---- Ассистент (появляется параллельно; graceful-фолбэк, если модуля ещё нет) ----
let assistant: AssistantModule | null = null;
try {
  assistant = await import('./assistant.mjs');
  console.log('[assistant] assistant.mjs connected');
} catch (e) {
  console.log('[assistant] assistant.mjs not found — running without explanations (fallback)');
}

const FALLBACK_PLATFORMS = [
  { id: 'web', title: 'Web', description: 'Standard web preparation' },
];

// v0.1.1: веб по умолчанию — passthrough (opt-in). Фолбэк не форсит оптимизаций:
// codec срабатывает только если включён флажок компрессии.
//
// texMode здесь намеренно НЕТ: режим KTX2 — не дело сервера. Умолчание живёт у
// аддона, профиль площадки вправе его переопределить, человек — выбрать сам.
// Пока сервер держал свою копию, она молча побеждала профиль (см. /api/optimize).
const FALLBACK_ENGINE_OPTS = {
  codec: 'meshopt',
  keepParts: false,
  noKtx: true,
  stripColors: false,
  dryRun: false,
};

// Язык отчёта приходит от клиента параметром ?lang=. Не по заголовку Accept-Language:
// в интерфейсе язык переключается кнопкой, и отчёт должен идти на выбранном языке,
// а не на языке, который браузер считает предпочтительным.
function langOf(url: URL): string {
  const v = url && url.searchParams ? url.searchParams.get('lang') : null;
  return v && /^[a-z]{2}$/.test(v) ? v : 'en';
}

function listPlatformsSafe(lang: string) {
  if (assistant && typeof assistant.listPlatforms === 'function') {
    try {
      const p = assistant.listPlatforms(lang);
      if (Array.isArray(p) && p.length) return p;
    } catch (e: any) {
      console.error('[assistant] listPlatforms() failed:', e.message);
    }
  }
  return FALLBACK_PLATFORMS;
}

// Расширенные опции (KTX2/Draco/strip-colors/...) — контракт с AI Assistant §4c:
//   listExtensions(platformId) → [{ id, title, description, impact }]
// Пока assistant.mjs не реализует listExtensions(), возвращаем пустой список —
// панель «Расширенные опции» в UI просто не покажется (нет придуманных web-interface данных).
function listExtensionsSafe(platformId: string, lang: string, engineId?: string) {
  if (assistant && typeof assistant.listExtensions === 'function') {
    try {
      const list = assistant.listExtensions(platformId, lang, engineId);
      if (Array.isArray(list)) return list;
    } catch (e: any) {
      console.error('[assistant] listExtensions() failed:', e.message);
    }
  }
  return [];
}

// Движки (ARCHITECTURE.md §4g). Как и у площадок — «safe»-обёртка: слой ассистента
// может быть старее сервера и не знать про движки вовсе. Тогда список пуст, и поле
// движка в интерфейсе не появляется. Выдуманного движка здесь не будет: имя читателя
// файла — не то, что web-interface вправе сочинить.
function listEnginesSafe(platformId: string, lang: string) {
  if (!assistant) return [];
  const fn = platformId && typeof assistant.enginesForPlatform === 'function'
    ? () => assistant.enginesForPlatform(platformId, lang)
    : (typeof assistant.listEngines === 'function' ? () => assistant.listEngines(lang) : null);
  if (!fn) return [];
  try {
    const list = fn();
    if (Array.isArray(list)) return list;
  } catch (e: any) {
    console.error('[assistant] listEngines() failed:', e.message);
  }
  return [];
}

// engineId нужен только когда площадка не выбрана (прочерк, §4g): движок больше неоткуда
// взять. У выбранной площадки движок свой, и переданное значение слой ассистента
// игнорирует — пары, которой нет, посчитать нельзя.
function planForSafe(platformId: string, lang: string, engineId?: string): PlanLike {
  if (assistant && typeof assistant.planFor === 'function') {
    try {
      const plan = assistant.planFor(platformId, lang, engineId);
      if (plan && typeof plan === 'object') return plan;
    } catch (e: any) {
      console.error('[assistant] planFor() failed:', e.message);
    }
  }
  const known = FALLBACK_PLATFORMS.find((p) => p.id === platformId);
  return {
    profileId: 'default',
    title: known ? known.title : platformId,
    engineOpts: { ...FALLBACK_ENGINE_OPTS },
    explanation: [],
  };
}

function explainResultSafe(runResult: unknown, platformId: string, lang: string) {
  if (assistant && typeof assistant.explainResult === 'function') {
    try {
      const explain = assistant.explainResult(runResult as Record<string, unknown>, platformId, lang);
      if (explain && typeof explain === 'object') return explain;
    } catch (e: any) {
      console.error('[assistant] explainResult() failed:', e.message);
    }
  }
  // Фолбэк: без сочинённых от себя объяснений — пустые массивы,
  // фронтенд покажет только сырые данные ядра (findings/applied/skipped/validation).
  return { summary: '', highlights: [], budgetChecks: [], warnings: [] };
}

// ---- SSE: карта активных подключений прогресса, ключ — jobId ----
/** @type {Map<string, import('node:http').ServerResponse>} */
const progressClients = new Map();

// Пределы для SSE. Инструмент локальный, одновременных сборок у одного человека
// единицы — потолок нужен не от злоумышленника, а чтобы забытые вкладки не копили
// дескрипторы бесконечно (SECURITY-001, пункт 3).
const MAX_SSE_CLIENTS = 32;
const SSE_PING_MS = 30_000;
const SSE_MAX_LIFETIME_MS = 30 * 60_000;

// ---- Загруженные исходники (для повторной оптимизации без перезаливки) ----
// Ядро — чистая функция (исходник не мутируется, см. §4d), поэтому одну и ту же модель
// можно гонять с разными опциями сколько угодно раз. Сервер держит исходник, чтобы
// десятки/сотни вариантов не перекачивали файл: клиент шлёт sourceId вместо тела.
/** @type {Map<string, { uploadPath: string, name: string, seq: number }>} */
const sourceUploads = new Map();

// Порядковый номер загрузки. Нужен, чтобы «стереть всё, кроме текущего» не превращалось
// в гонку: при двух одновременных загрузках каждая видела в Map чужую запись и удаляла её,
// так что обе вкладки теряли исходник. Теперь чистится только то, что СТАРШЕ текущей.
let uploadSeq = 0;

// Сколько исходников держим на диске одновременно.
//
// Раньше держали ровно один: при загрузке новой модели прежние стирались. Это мешало
// списку моделей — вернуться к прошлой без перезаливки было нельзя. Теперь список ведёт
// клиент, он же говорит DELETE /api/source/<id>, когда модель из списка убрали.
//
// Но полагаться ТОЛЬКО на клиента нельзя: вкладку закрывают, браузер падает, страницу
// перезагружают — и никто уже не придёт удалить свой каталог. Поэтому остаётся потолок:
// всё, что старше N последних, стирается само. Иначе у человека на диске молча копятся
// десятки мегабайт на каждую открытую модель, и он никогда не узнает почему.
const MAX_KEPT_SOURCES = 12;

// Сколько прогонов одной модели держим. Больше одного — чтобы ссылка из прошлого
// ответа не начала вдруг отдавать чужой файл и чтобы можно было сравнить два варианта
// (Draco против Meshopt) не перезаливая модель. Не «сколько влезет»: у каждого прогона
// на диске лежит целая модель, и десяток вариантов тяжёлой сцены — это гигабайты,
// про которые человек не узнает.
const MAX_KEPT_RUNS = 3;

// Потолок по ОБЪЁМУ, а не только по счёту (Александр, 2026-08-13: «я не хочу что бы
// через месяц работы пользователь удивлялся, когда у него 200+ГБ разных версий
// оптимизированных моделей лежали где-то в одной груде»).
//
// Счёт про объём не знает: двенадцать исходников — это двенадцать НЕИЗВЕСТНО каких
// моделей. Дюжина сцен по 600 МБ, у каждой по три прогона, — под тридцать гигабайт
// за один сеанс, и человек об этом нигде не прочитает.
//
// Восемь гигабайт — это либо одна очень тяжёлая сцена со всеми прогонами, либо
// десяток обычных. Число показывается человеку в настройках, поэтому оно не тайна.
//
// Переменной оно задаётся по той же причине, что и PORT: код, который стирает файлы
// с чужого диска, обязан проверяться, а восемь гигабайт в тесте не наберёшь. Заодно
// это ответ тому, у кого диск маленький.
const MAX_WORK_BYTES = (() => {
  const n = Number(process.env.TANYRA_WORK_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 8 * 1024 ** 3;
})();

// sourceId → список runId в порядке появления. Порядок ведём сами, а не по времени
// файлов: у двух прогонов, начатых в одну миллисекунду, время совпадёт.
const sourceRuns = new Map();

// Прогоны, которые прямо сейчас пишут в свои папки. Их убирать нельзя ни при каких
// обстоятельствах — ревью 2026-08-10 (D2): сначала уборка вызывалась ДО optimizeFile,
// и четвёртый одновременный прогон одной модели сносил каталог первого, пока тот в него
// писал. Замер ревьюера: пять параллельных прогонов BoomBox — двое падали с ENOENT.
const activeRuns = new Set();

const runKey = (sourceId: string, runId: string) => `${sourceId}/${runId}`;

/**
 * Записать прогон в учёт и убрать лишние.
 *
 * Зовётся ПОСЛЕ того, как прогон закончил писать. Пока идут пять параллельных, никто
 * никого не трогает; когда закончатся — останутся три последних, как и задумано.
 */
async function rememberRun(sourceId: string, runId: string) {
  const runs = sourceRuns.get(sourceId) || [];
  runs.push(runId);
  sourceRuns.set(sourceId, runs);

  // Идём с начала, пропуская тех, кто ещё работает: удалить их нельзя, а прерывать
  // уборку из-за одного занятого — значит копить остальные.
  while (runs.length > MAX_KEPT_RUNS) {
    const victim = runs.find((id: string) => !activeRuns.has(runKey(sourceId, id)));
    if (!victim) break; // все лишние ещё пишут — уберём их следующий раз
    const ok = await fsp.rm(path.join(RESULTS_DIR, sourceId, victim), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    // Из учёта выбрасываем ТОЛЬКО удалённое. Не удалилось (на Windows файл занят) —
    // оставляем в списке: иначе каталог выпадает из учёта и не будет убран никогда.
    // Ревью 2026-08-10 (D8).
    if (!ok) break;
    runs.splice(runs.indexOf(victim), 1);
  }

  // Объём вырос именно сейчас: прогон дописал на диск ещё одну целую модель. Проверка
  // только при загрузке нового исходника пропустила бы это — человек может гонять
  // варианты одной тяжёлой сцены, ничего больше не загружая.
  await purgeBeyondLimit();
}

async function dropSource(id: string) {
  sourceUploads.delete(id);
  sourceRuns.delete(id);
  await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }).catch(() => {});
}

/** Сколько занимает каталог со всем содержимым. Нет каталога — ноль, а не отказ. */
async function dirBytes(dir: string): Promise<number> {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else total += await fsp.stat(full).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/** Сколько рабочая папка занимает прямо сейчас — загрузки плюс результаты. */
const workBytes = async () => (await dirBytes(UPLOADS_DIR)) + (await dirBytes(RESULTS_DIR));

const sourceBytes = async (id: string) =>
  (await dirBytes(path.join(UPLOADS_DIR, id))) + (await dirBytes(path.join(RESULTS_DIR, id)));

/** Идёт ли по этому исходнику прогон прямо сейчас. Такой трогать нельзя — см. activeRuns. */
const sourceBusy = (id: string) => [...activeRuns].some((key) => (key as string).startsWith(`${id}/`));

// Оставить N самых свежих исходников, остальные стереть. Сравнение по seq, а не по
// времени файла: две одновременные загрузки видели друг друга «старыми» и стирали
// чужие каталоги, так что обе вкладки теряли исходник.
async function purgeBeyondLimit() {
  const entries = [...sourceUploads.entries()].sort((a, b) => b[1].seq - a[1].seq);
  const kept: string[] = [];
  for (const [id] of entries) {
    if (kept.length < MAX_KEPT_SOURCES || sourceBusy(id)) kept.push(id);
    else await dropSource(id);
  }

  // Объём. Убираем самые старые, пока не уложимся в потолок.
  //
  // Самый свежий не трогаем НИКОГДА, даже если он один перевешивает потолок: это
  // модель, с которой человек работает прямо сейчас, и стереть её значило бы оборвать
  // работу вместо уборки. Занятые прогоном пропускаем по той же причине, что и выше.
  let total = await workBytes();
  for (let i = kept.length - 1; i > 0 && total > MAX_WORK_BYTES; i--) {
    const victim = kept[i];
    if (!victim || sourceBusy(victim)) continue;
    total -= await sourceBytes(victim);
    await dropSource(victim);
  }
}

function sendSSE(jobId: string, payload: unknown) {
  const res = progressClients.get(jobId);
  if (!res) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
    // клиент уже отключился — не страшно
  }
}

// ---- Утилиты ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

function safeJoin(baseDir: string, relPath: string): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relPath);
  // Граница по разделителю пути, а не просто startsWith — иначе "base"+"-evil" (сосед,
  // чьё имя начинается с того же префикса) ошибочно считался бы "внутри" baseDir.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Языки интерфейса подключаются по факту наличия файла в ui/locales или translations/ —
// добавить язык значит положить каталог в одну из этих папок, и всё. Список собирается
// на каждый запрос страницы: приложение локальное, лишний readdir дешевле, чем перезапуск
// сервера ради нового языка.
//
// ui/locales/ содержит только английские каталоги (en.js, validator-en.js) — это язык,
// на который i18n.js откатывается, когда в другом каталоге не хватает ключа. Каталог
// должен быть определён к этому моменту.
//
// translations/ содержит остальные языки (ru.js, validator-ru.js и т.д.). Файлы оттуда
// обслуживаются по /translations/* и загружаются после английских.
const LOCALES_DIR = path.join(UI_DIR, 'locales');
const TRANSLATIONS_DIR = path.join(__dirname, 'translations');
const LOCALE_MARKER = '<!--locales-->';

async function localeScriptTags() {
  // Английские каталоги из ui/locales/ (en.js, validator-en.js)
  let localeFiles;
  try {
    localeFiles = (await fsp.readdir(LOCALES_DIR)).filter((f) => f.endsWith('.js'));
  } catch (e) {
    return ''; // папки нет — интерфейс останется на языке разметки
  }
  localeFiles.sort((a, b) => (a === 'en.js' ? -1 : b === 'en.js' ? 1 : a.localeCompare(b)));

  // Переводы из translations/ (ru.js, validator-ru.js, …)
  let transFiles: string[] = [];
  try {
    transFiles = (await fsp.readdir(TRANSLATIONS_DIR)).filter((f) => f.endsWith('.js'));
  } catch (e) {
    // translations/ не существует — не страшно, есть только английский
  }
  transFiles.sort((a, b) => a.localeCompare(b));

  const enSet = new Set(localeFiles);
  const tags = [];
  for (const f of localeFiles) {
    tags.push(`<script src="/locales/${encodeURIComponent(f)}"></script>`);
  }
  for (const f of transFiles) {
    // Если файл с тем же именем есть и в ui/locales/, приоритет у ui/locales —
    // не дублируем скрипт
    if (enSet.has(f)) continue;
    tags.push(`<script src="/translations/${encodeURIComponent(f)}"></script>`);
  }
  return tags.join('\n');
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, baseDir: string = UI_DIR, stripPrefix: string = '') {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]!);
  if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
  const filePath = safeJoin(baseDir, '.' + rel);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    if (baseDir === UI_DIR && rel === '/index.html') {
      const html = (await fsp.readFile(filePath, 'utf8')).replace(LOCALE_MARKER, await localeScriptTags());
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + rel);
  }
}

// 1 ГБ — щедрый предел для локального инструмента. Самая тяжёлая модель в наборе
// проверок — около 600 МБ, так что предел не мешает работе.
//
// Отдельно от предела остаётся то, что тело копится в памяти целиком: chunk-буферы ещё
// живы в момент Buffer.concat, и на гигабайтном файле пик заметно выше гигабайта.
// Лечится не числом, а потоковой записью на диск — это переделка приёма файла, и она не
// сделана. Прежняя ссылка вела в `docs/ПЛАН_исправлений.md`; документ удалён 2026-08-18,
// когда его собственная шапка объявила все пятнадцать пунктов закрытыми, — а вот ЭТОТ
// пункт закрыт не был. Записано здесь, рядом с кодом, чтобы больше не потеряться.
const MAX_BODY = 1024 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = MAX_BODY;
    // Заявленный размер отвергаем ДО приёма: иначе гигабайт сначала приедет по сети
    // и осядет в памяти, и только потом выяснится, что он не нужен.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX) {
      reject(new Error('File too large'));
      req.destroy();
      return;
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('File too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Зарезервированные Windows имена устройств. Резервируются в ЛЮБОЙ папке и вместе с
// расширением: запись в `uploads/<id>/con.glb` уходит в консоль, а не в файл, и модель
// пропадает без внятной ошибки. Точку с расширением Windows при сопоставлении отбрасывает.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function sanitizeFileName(name: string): string {
  const base = path.basename(name || 'model.glb');
  // убираем управляющие/запрещённые для файловой системы Windows символы, оставляем юникод (кириллицу)
  // eslint-disable-next-line no-control-regex -- управляющие символы тут и есть цель: имя файла с \x00 внутри Windows не создаст
  let clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Хвостовые точки и пробелы Windows молча срезает: "model.glb." станет "model.glb",
  // а "..." — пустой строкой, то есть попыткой записи в саму папку.
  clean = clean.replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(clean)) clean = '_' + clean;
  return clean || 'model.glb';
}

// Имя файла для скачивания: если клиент прислал ?name= (окно экспорта), берём его —
// чистим, снимаем расширение и ставим нужное для выбранного формата; иначе fallback.
// Расширение задаёт формат, не пользователь: экспортёр решает, что он пишет.
function chosenExportName(reqName: string | null | undefined, fallback: string, ext: string): string {
  if (!reqName) return fallback;
  const clean = sanitizeFileName(reqName).replace(/\.[^.]+$/, '');
  return (clean || 'model') + ext;
}

// ASCII-имя для параметра filename="..." в Content-Disposition. Юникод уезжает
// в filename*=UTF-8'' рядом, здесь остаётся только запасной вариант для старых клиентов.
// Кавычка и обратный слэш закрыли бы параметр раньше времени, и хвост имени стал бы
// отдельным параметром заголовка — поэтому вычищаются отдельно от не-ASCII.
// Сейчас сюда и так приходит результат sanitizeFileName(), но фолбэк-ветка
// chosenExportName() берёт имя с диска: страховка на случай, если правила разойдутся.
function asciiHeaderName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

// ---- HTTP сервер ----

// Запрос пришёл к нам, а не к нам через чужую страницу?
//
// Привязки к 127.0.0.1 мало от двух вещей. Первая — DNS rebinding: чужой сайт заводит
// имя, которое через минуту начинает разрешаться в 127.0.0.1, и его скрипт стучится
// «на localhost» уже из браузера человека. Заголовок Host при этом остаётся чужим —
// по нему это и видно. Вторая — обычный запрос со страницы в интернете: там приходит
// Origin, и он не наш.
//
// Проверка включается только когда мы действительно слушаем петлю. Поставил человек
// TANYRA_HOST осознанно — значит знает, что делает, и мешать ему нечем.
// Имя хоста, а не строка целиком: `evil.com` и `localhost.evil.com` — разные вещи,
// а `startsWith('localhost')` их не различает. `[::1]` в hostname приезжает в скобках.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackHostname = (value: string | undefined | null) => {
  if (!value) return false;
  try { return LOOPBACK.has(new URL(`http://${value}`).hostname); } catch { return false; }
};
function originAllowed(req: http.IncomingMessage): boolean {
  if (HOST !== '127.0.0.1') return true;
  if (!loopbackHostname(req.headers.host)) return false;
  const origin = req.headers.origin;
  // Origin нет — значит это не кросс-страница из браузера (обычный GET, curl, само
  // окно приложения). Проверять нечего, а Host выше уже сказал главное.
  if (!origin) return true;
  // А вот строка «null» — это НЕ «нет источника». Так браузер называет источник
  // непрозрачный: страница из `<iframe sandbox>`, `data:`, локальный файл. Чужой сайт
  // может открыть такой iframe и стучаться к нам из него. Ответ он не прочитает
  // (заголовков CORS мы не шлём), но записи проходили: сжечь процессор и диск на
  // чужой машине этого хватает, а порт 3210 угадывается.
  // Ревью 2026-08-10 (D4). Окно приложения сюда не попадает — оно грузится с
  // http://127.0.0.1:порт и шлёт обычный origin.
  if (origin === 'null') return false;
  try { return LOOPBACK.has(new URL(origin).hostname); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (!originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: this server answers only to the local application.');
    return;
  }

  // краткий лог каждого запроса — чтобы проблемы вроде «файл недоступен» были видны в консоли
  if (pathname.startsWith('/api/')) {
    res.on('finish', () => console.log(`[${req.method}] ${decodeURIComponent(req.url!)} → ${res.statusCode}`));
  }

  try {
    // --- three.js для просмотрщика (из node_modules/three) ---
    if (req.method === 'GET' && pathname.startsWith('/vendor/three/')) {
      await serveStatic(req, res, pathname, THREE_DIR, '/vendor/three');
      return;
    }

    // --- плагин KHR_animation_pointer (из node_modules/@needle-tools/…) ---
    if (req.method === 'GET' && pathname.startsWith('/vendor/animation-pointer/')) {
      await serveStatic(req, res, pathname, ANIM_POINTER_DIR, '/vendor/animation-pointer');
      return;
    }

    // --- плагины к загрузчику, которых нет в three (из node_modules/three-gltf-extensions/) ---
    if (req.method === 'GET' && pathname.startsWith('/vendor/gltf-extensions/')) {
      await serveStatic(req, res, pathname, GLTF_EXT_DIR, '/vendor/gltf-extensions');
      return;
    }

    // --- переводы (из translations/ — неанглийские локали) ---
    if (req.method === 'GET' && pathname.startsWith('/translations/')) {
      await serveStatic(req, res, pathname, TRANSLATIONS_DIR, '/translations');
      return;
    }

    // --- статика UI ---
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }

    // --- пересказ уже готового результата на другом языке ---
    //
    // Смена языка не должна пересобирать модель: explainResult() — чистая функция от
    // результата прогона, файлы ей не нужны. Клиент присылает тот самый result, который
    // получил при сборке, и получает тот же отчёт на другом языке.
    if (req.method === 'POST' && pathname === '/api/explain') {
      // Пустая строка — законный выбор «без площадки» (ARCHITECTURE.md §4g), а не
      // забытый параметр. Различаем по наличию ключа: старый клиент его не пришлёт
      // вовсе, и такому по-прежнему отвечаем отказом.
      if (!url.searchParams.has('platform')) {
        sendJSON(res, 400, { error: 'platform is required' });
        return;
      }
      const platformId = url.searchParams.get('platform') || '';
      let payload;
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        sendJSON(res, 400, { error: 'Malformed JSON body' });
        return;
      }
      // Смена языка в интерфейсе приходит сюда: перерисовать отчёт, ничего не пересобирая.
      // Строки правил в готовом результате пересобираются из messageId (localizeResult),
      // и уже ЛОКАЛИЗОВАННЫЙ результат идёт в explainResult — иначе предупреждения,
      // которые ассистент собирает из этих же строк, остались бы на прежнем языке.
      const lang = langOf(url);
      const localized = localizeResult(payload && payload.result, lang);
      sendJSON(res, 200, { explain: explainResultSafe(localized, platformId, lang), result: localized });
      return;
    }

    // --- список платформ ---
    // Модель убрали из списка — стереть её исходник и результат с диска.
    // Клиент зовёт это сам; на случай, если не позовёт (закрыли вкладку, упал браузер),
    // работает потолок MAX_KEPT_SOURCES.
    if (req.method === 'DELETE' && pathname.startsWith('/api/source/')) {
      const id = decodeURIComponent(pathname.slice('/api/source/'.length));
      // id приходит снаружи и подставляется в путь. Пропускаем только формат UUID,
      // который сами и выдали: без этого «../..» в id увёл бы rm куда угодно.
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        sendJSON(res, 400, { error: 'bad source id' });
        return;
      }
      await dropSource(id);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- рабочая папка: сколько занято и как убрать ---
    //
    // Человек должен видеть число, а не догадываться о нём. Уборка сама по себе есть
    // (чистка на старте, потолки по счёту и объёму), но пока её нигде не видно, она
    // ничем не отличается от её отсутствия.
    if (pathname === '/api/workdir') {
      if (req.method === 'GET') {
        sendJSON(res, 200, { path: DATA_DIR, bytes: await workBytes(), limit: MAX_WORK_BYTES });
        return;
      }
      if (req.method === 'DELETE') {
        // Стираем ВСЁ, включая текущую модель: «очистить» значит очистить. Ссылка на
        // исходник после этого отвечает 410 source_expired, и клиент перезаливает файл
        // сам — этот путь давно работает, отдельного согласования тут не нужно.
        sourceUploads.clear();
        sourceRuns.clear();
        await ensureEmptyDir(UPLOADS_DIR);
        await ensureEmptyDir(RESULTS_DIR);
        sendJSON(res, 200, { bytes: await workBytes() });
        return;
      }
      sendJSON(res, 405, { error: 'method_not_allowed' });
      return;
    }

    // --- показать папку в проводнике ---
    //
    // Путь строкой человек не откроет: скопировать и вставить в проводник — три
    // лишних действия там, где нужно одно. Адрес НЕ приходит от клиента: он выбирает
    // из двух известных серверу папок по имени. Иначе это был бы вход, открывающий
    // на машине человека что угодно по просьбе любой страницы в браузере.
    if (req.method === 'POST' && pathname === '/api/open') {
      const dirs: Record<string, string> = { work: DATA_DIR };
      if (assistant && typeof assistant.profileTemplate === 'function') {
        dirs.profiles = assistant.profileTemplate('en').dir;
      }
      const dir = dirs[url.searchParams.get('what') || ''];
      if (!dir) {
        sendJSON(res, 400, { error: 'unknown_dir' });
        return;
      }
      await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      // Своя команда на каждую систему; shell не зовём — путь уходит отдельным
      // аргументом, а не куском командной строки.
      const opener = process.platform === 'win32' ? 'explorer.exe'
        : process.platform === 'darwin' ? 'open'
        : 'xdg-open';
      // explorer.exe возвращает 1 и при успехе — код выхода тут не показатель, ждать
      // его нечего. Ошибку самого запуска гасим: не открылось окно проводника — это
      // не причина отвечать отказом на работу, которая уже сделана.
      try { spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { /* нет проводника */ }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // --- своя площадка: форма вместо JSON руками (ROADMAP.md §5i, шаг 2) ---
    //
    // Пишет и стирает ТОЛЬКО пользовательскую папку профилей — встроенные площадки
    // отсюда недосягаемы, это проверяет сам ассистент (ProfileError 'builtin_id').
    // Сервер здесь ничего не решает: он передаёт поля формы и возвращает код отказа,
    // а фразу к коду подбирает интерфейс на своём языке (Правило 8).
    if (pathname === '/api/profiles' || pathname.startsWith('/api/profiles/')) {
      if (!assistant || typeof assistant.saveCustomProfile !== 'function') {
        sendJSON(res, 501, { error: 'no_assistant' });
        return;
      }
      const lang = langOf(url);
      // Битую %-последовательность decodeURIComponent роняет исключением, и оно ушло бы
      // мимо разбора ниже — запрос повис бы без ответа. Неразобранное имя не годится
      // ни под один вход, поэтому берём его как есть: дальше его всё равно чистит safeId.
      let id = '';
      if (pathname.startsWith('/api/profiles/')) {
        const raw = pathname.slice('/api/profiles/'.length);
        try { id = decodeURIComponent(raw); } catch { id = raw; }
      }
      // Отказ формы — не поломка сервера: 400 с кодом. Всё остальное (нет прав на
      // папку, диск полон) — настоящая ошибка, её отдаём как есть и пишем в журнал.
      const fail = (e: any) => {
        if (e && e.name === 'ProfileError') {
          sendJSON(res, 400, { error: e.code, field: e.field || null });
        } else {
          console.error('[profiles]', e && e.message);
          sendJSON(res, 500, { error: 'write_failed', detail: e && e.message });
        }
      };
      try {
        // Описание формы отдаёт САМ /api/profiles, без вложенного имени. Имя вроде
        // `/api/profiles/template` перекрыла бы площадка, названную «Template»: её id
        // вышел бы ровно таким, и правка открывала бы описание формы вместо профиля.
        if (req.method === 'GET' && !id) {
          sendJSON(res, 200, assistant.profileTemplate(lang));
          return;
        }
        // Обмен площадками — файлом (ROADMAP.md §5i, шаг 3). Признаком служит параметр
        // запроса, а не вложенное имя: имя пути занял бы возможный id площадки, как
        // едва не случилось с `template`.
        //
        // Отдаётся СЫРОЙ файл, а не поля формы: профиль, написанный руками, несёт то,
        // чего форма не спрашивает (жёсткий предел, ссылку на документ, список
        // вычитаемых опций). Пропусти его через форму — получатель увидит не ту
        // площадку, которую ему отправили.
        if (req.method === 'GET' && id && url.searchParams.get('download') === '1') {
          const out = assistant.exportCustomProfile(id);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${out.id}.json"`,
          });
          res.end(out.json);
          return;
        }
        if (req.method === 'POST' && !id && url.searchParams.get('import') === '1') {
          // Тело — сам файл, как его прочитал браузер. Разбирает и проверяет ассистент:
          // решение «годится ли это как площадка» принадлежит ему, а не транспорту.
          sendJSON(res, 200, assistant.importCustomProfile((await readBody(req)).toString('utf8')));
          return;
        }
        if (req.method === 'GET' && id) {
          sendJSON(res, 200, assistant.readCustomProfile(id, lang));
          return;
        }
        if (req.method === 'POST' && !id) {
          let payload;
          try {
            payload = JSON.parse((await readBody(req)).toString('utf8'));
          } catch {
            sendJSON(res, 400, { error: 'Malformed JSON body' });
            return;
          }
          sendJSON(res, 200, assistant.saveCustomProfile(payload));
          return;
        }
        if (req.method === 'DELETE' && id) {
          sendJSON(res, 200, assistant.deleteCustomProfile(id));
          return;
        }
      } catch (e) {
        fail(e);
        return;
      }
      sendJSON(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/platforms') {
      // noPlatform — описание прочерка («без площадки»). Не элемент списка: это не
      // площадка, а объяснение выбора БЕЗ неё. Отдельным полем, чтобы список площадок
      // остался списком площадок и его длина ничего не подменяла.
      let noPlatform = null;
      if (assistant && typeof assistant.noPlatformInfo === 'function') {
        try { noPlatform = assistant.noPlatformInfo(langOf(url)); } catch (e: any) {
          console.error('[assistant] noPlatformInfo() failed:', e.message);
        }
      }
      sendJSON(res, 200, { platforms: listPlatformsSafe(langOf(url)), noPlatform, engineVersion: VERSION });
      return;
    }

    // --- движки: вторая ось, равноправная площадкам (ARCHITECTURE.md §4g) ---
    // Отдельный вход, а не поле внутри /api/platforms: движок существует независимо от
    // того, есть ли под него площадка, и наоборот. Необязательный `platform=` сужает
    // ответ до движков, годных этой площадке — та самая симметрия двух полей, где
    // выбор в любом из них переупорядочивает второе. Пустой список — законный ответ:
    // папки engines/ может не быть, и тогда интерфейс поле движка просто не покажет.
    if (req.method === 'GET' && pathname === '/api/engines') {
      const forPlatform = url.searchParams.get('platform') || '';
      sendJSON(res, 200, { engines: listEnginesSafe(forPlatform, langOf(url)) });
      return;
    }

    // --- расширенные опции для платформы ---
    if (req.method === 'GET' && pathname === '/api/extensions') {
      const platformId = url.searchParams.get('platform') || '';
      // exclusiveGroups отдаём вместе со списком: интерфейс больше не держит свой
      // список взаимоисключений, а читает объявление аддона. Два списка уже
      // расходились — см. addons/gltf/index.mjs, EXCLUSIVE_FEATURES.
      // defaults — аддитивное поле (§4c): что площадка СОВЕТУЕТ, пока человек не выбрал
      // сам. Пока его не было, интерфейс держал собственную копию умолчания ('uastc') и
      // площадка не могла на неё повлиять. Значение может быть null — тогда интерфейс
      // просто не показывает предвыбранным ничего своего.
      // Значение из профиля проверяется так же, как пришедшее от человека. Профиль
      // редактируют руками, и опечатка правдоподобна — флаг в командной строке
      // называется `--etc1s`, а опция здесь `mixed`. Непроверенное значение доехало бы
      // до радиокнопок, не совпало ни с одной, и человек увидел бы «Режим: UASTC» и ни
      // одной отмеченной кнопки: результат верный, экран врёт.
      // Движок — второй, равноправный с площадкой признак (ARCHITECTURE.md §4g).
      // Сегодня он один, и параметр служит только формой: запрос уже умеет его принять,
      // поэтому появление второго движка станет добавлением данных, а не сменой
      // протокола и не правкой интерфейса. Чужое значение не подставляем молча —
      // отвечаем движком площадки и сообщаем, какой применён на самом деле.
      const askedEngine = url.searchParams.get('engine') || '';
      const plan = planForSafe(platformId, langOf(url), askedEngine);
      const planEngine = plan.engine || 'threejs';
      const engine = askedEngine === planEngine ? askedEngine : planEngine;
      // engineInfo — как движок называется и какой вьюпорт монтировать (engines/<id>.json).
      // null, если файла движка нет: интерфейс покажет площадку без движка, но не выдумает имя.
      const engineInfo = plan.engineInfo || null;
      const planDefaults = plan.engineOpts || {};
      const advisedTexMode = (planDefaults.texMode === 'mixed' || planDefaults.texMode === 'uastc')
        ? planDefaults.texMode
        : null;
      sendJSON(res, 200, {
        engine,
        engineInfo,
        extensions: listExtensionsSafe(platformId, langOf(url), engine),
        exclusiveGroups: typeof exclusiveGroups === 'function' ? exclusiveGroups() : [],
        defaults: { texMode: advisedTexMode },
      });
      return;
    }

    // --- SSE прогресс ---
    if (req.method === 'GET' && pathname === '/api/progress') {
      const jobId = url.searchParams.get('job');
      if (!jobId) {
        res.writeHead(400);
        res.end('job parameter required');
        return;
      }
      // Повторное подключение с тем же job (перезагрузили вкладку) — прежний ответ
      // просто вытеснялся из Map и оставался висеть открытым. Закрываем явно.
      const previous = progressClients.get(jobId);
      if (previous && previous !== res) {
        try { previous.end(); } catch { /* уже закрыт */ }
        progressClients.delete(jobId);
      }
      if (progressClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Too many progress subscriptions');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      progressClients.set(jobId, res);

      // Соединение живёт, пока идёт сборка. Клиент, который «ушёл», не всегда рвёт
      // TCP — вкладка может висеть в фоне часами. Пинг раз в полминуты даёт ошибку
      // записи на мёртвом сокете, а жёсткий предел закрывает то, что пережило и пинг.
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { closeStream(); }
      }, SSE_PING_MS);
      const deadline = setTimeout(closeStream, SSE_MAX_LIFETIME_MS);
      // Таймеры не должны сами по себе держать процесс живым — сервер и так держит.
      ping.unref?.();
      deadline.unref?.();
      function closeStream() {
        clearInterval(ping);
        clearTimeout(deadline);
        if (progressClients.get(jobId) === res) progressClients.delete(jobId);
        try { res.end(); } catch { /* уже закрыт */ }
      }
      req.on('close', closeStream);
      return;
    }

    // --- инспекция модели (Metadata + Validation) + регистрация исходника ---
    // Модель загружается один раз здесь (при импорте); последующая сборка переиспользует
    // тот же sourceId без перезаливки.
    if (req.method === 'POST' && pathname === '/api/inspect') {
      const rawName = (req.headers['x-filename'] as string) || 'model.glb';
      let decodedName;
      try { decodedName = decodeURIComponent(rawName); } catch (e) { decodedName = rawName; }
      const fileName = sanitizeFileName(decodedName);
      if (!/\.glb$/i.test(fileName)) {
        sendJSON(res, 400, { error: 'Expected a .glb file' });
        return;
      }
      const bytes = await readBody(req);
      if (!bytes.length) {
        sendJSON(res, 400, { error: 'Empty request body — no file received' });
        return;
      }
      const sourceId = randomUUID();
      const srcDir = path.join(UPLOADS_DIR, sourceId);
      await fsp.mkdir(srcDir, { recursive: true });
      const uploadPath = path.join(srcDir, fileName);
      await fsp.writeFile(uploadPath, bytes);
      sourceUploads.set(sourceId, { uploadPath, name: fileName, seq: ++uploadSeq });
      await purgeBeyondLimit();

      let data;
      try {
        data = await inspectFile(uploadPath);
      } catch (e: any) {
        console.error('[inspect] failed:', e);
        sendJSON(res, 500, { error: 'Inspection failed: ' + e.message });
        return;
      }
      sendJSON(res, 200, { sourceId, ...data });
      return;
    }

    // --- обработка модели ---
    if (req.method === 'POST' && pathname === '/api/optimize') {
      // Прочерк («без площадки») присылается как пустая строка и означает выбор, а не
      // пропуск: подставлять первую попавшуюся площадку было бы подменой решения
      // человека. Фолбэк остаётся только для запроса, где ключа нет совсем.
      const platformId = url.searchParams.has('platform')
        ? (url.searchParams.get('platform') || '')
        : (listPlatformsSafe(langOf(url))[0] || {}).id;
      const engineId = url.searchParams.get('engine') || '';
      const jobId = url.searchParams.get('job') || '';
      const featuresParam = url.searchParams.get('features') || '';
      const advancedFeatures = featuresParam.split(',').map((s) => s.trim()).filter(Boolean);
      // Режим KTX2 приходит от интерфейса ТОЛЬКО когда человек выбрал его радиокнопкой.
      // Нет параметра (или мусор в нём) — ключа в опциях не будет вовсе, и умолчание
      // останется за профилем площадки, а под ним за аддоном.
      //
      // Раньше здесь стояло `=== 'mixed' ? 'mixed' : 'uastc'`, то есть отсутствие
      // параметра означало «uastc», и это значение подставлялось ПОСЛЕ профиля —
      // профиль не мог задать режим никогда: профиль объявлял `texMode` и объяснял
      // человеку почему, а его выбор выбрасывался. Дефект принадлежит этому месту, а не
      // какому-то одному профилю, и воспроизводится с любым, который задаёт `texMode`.
      const texModeRaw = url.searchParams.get('texMode');
      const texModeChoice = (texModeRaw === 'mixed' || texModeRaw === 'uastc') ? { texMode: texModeRaw } : {};

      // Качество WebP — доля от качества исходника, 0…100. По той же логике, что и
      // texMode: нет параметра или мусор в нём — ключа в опциях не будет вовсе, и
      // умолчание («как в исходнике») останется за аддоном. Дробное округляем, за края
      // не выпускаем: 100 — потолок исходника, выше него не бывает по определению.
      // Пустое значение (`?webpQuality=`) — это ОТСУТСТВИЕ параметра, а не ноль:
      // `Number('')` даёт 0, то есть самое разрушительное положение ползунка молча
      // получалось бы из пустой строки в адресе.
      const webpQualityRaw = url.searchParams.get('webpQuality');
      const webpQualityNum = (webpQualityRaw === null || webpQualityRaw.trim() === '')
        ? NaN
        : Number(webpQualityRaw);
      const webpQualityChoice = Number.isFinite(webpQualityNum)
        ? { webpQuality: Math.min(100, Math.max(0, Math.round(webpQualityNum))) }
        : {};

      // Повторная оптимизация уже загруженного исходника (без перезаливки тела).
      const sourceParam = url.searchParams.get('source') || '';
      let sourceId;
      let uploadPath;
      let fileName;

      const cached = sourceParam && sourceUploads.get(sourceParam);
      if (cached && fs.existsSync(cached.uploadPath)) {
        sourceId = sourceParam;
        uploadPath = cached.uploadPath;
        fileName = cached.name;
        // тело не ожидается — на всякий случай выкачиваем и игнорируем
        await readBody(req).catch(() => {});
      } else {
        const rawName = (req.headers['x-filename'] as string) || 'model.glb';
        let decodedName;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch (e) {
          decodedName = rawName;
        }
        fileName = sanitizeFileName(decodedName);
        if (!/\.glb$/i.test(fileName)) {
          sendJSON(res, 400, { error: 'Expected a .glb file' });
          return;
        }

        const bytes = await readBody(req);
        if (!bytes.length) {
          // Клиент просил повторить по sourceId, но исходник не найден (например, сервер
          // перезапускался) — просим перезалить файл. Клиент повторит запрос с телом.
          if (sourceParam) {
            sendJSON(res, 410, { error: 'source_expired' });
            return;
          }
          sendJSON(res, 400, { error: 'Empty request body — no file received' });
          return;
        }

        sourceId = randomUUID();
        const srcDir = path.join(UPLOADS_DIR, sourceId);
        await fsp.mkdir(srcDir, { recursive: true });
        uploadPath = path.join(srcDir, fileName);
        await fsp.writeFile(uploadPath, bytes);
        sourceUploads.set(sourceId, { uploadPath, name: fileName, seq: ++uploadSeq });
        // новая модель → стереть данные предыдущих (не копим лишнее)
        await purgeBeyondLimit();
      }

      const plan = planForSafe(platformId, langOf(url), engineId);
      // Порядок значим: фолбэк → профиль площадки → явный выбор человека.
      const engineOpts = { ...FALLBACK_ENGINE_OPTS, ...(plan.engineOpts || {}), ...texModeChoice, ...webpQualityChoice };

      const onProgress = (e: Record<string, unknown>) => {
        if (jobId) sendSSE(jobId, e);
      };

      // Результат каждого ПРОГОНА — в своей подпапке, а не одна папка на исходник.
      //
      // Раньше повторный прогон писал туда же. Отсюда три беды сразу: два запроса по
      // одной модели писали в один файл одновременно; ссылка из первого ответа потом
      // отдавала результат второго — молча и с виду правдоподобно; сравнить Draco с
      // Meshopt на одной модели было нельзя, второй прогон стирал первый.
      // Ревью 2026-08-10 (P1.3).
      //
      // Имя папки — случайное, а не «прогон №2»: номер потребовал бы общего счётчика,
      // который два параллельных запроса делят так же неудачно, как делили папку.
      const runId = randomUUID();
      const outDir = path.join(RESULTS_DIR, sourceId, runId);
      await fsp.mkdir(outDir, { recursive: true });

      // Пока прогон идёт, его папку не трогает никто. Учёт и уборка лишнего — ПОСЛЕ,
      // в finally: до 2026-08-10 уборка звалась здесь, и четвёртый одновременный
      // прогон одной модели сносил каталог первого прямо во время записи.
      activeRuns.add(runKey(sourceId, runId));

      let result;
      try {
        result = await optimizeFile(uploadPath, {
          ...engineOpts,
          advancedFeatures,
          outDir,
          force: true,
          onProgress,
          // строки правил («что сделано», находки анализа) рендерит ядро — язык нужен ему
          locale: langOf(url),
        });
      } catch (e: any) {
        console.error('[optimize] exception during processing:', e);
        sendJSON(res, 500, { error: 'Could not process the model: ' + e.message });
        return;
      } finally {
        activeRuns.delete(runKey(sourceId, runId));
        await rememberRun(sourceId, runId);
      }

      const explain = explainResultSafe(result, platformId, langOf(url));

      // Ссылка даётся по факту наличия файла, а не по статусу. Провалившая проверку
      // целостности модель тоже записывается (решение Александра 2026-07-30): показать
      // расхождение и запретить выгрузку — значит решить за пользователя, что ему этот
      // результат не нужен. Предупреждение остаётся красным, выбор остаётся за ним.
      let downloadUrl = null;
      if (result.file && result.file.written && result.file.dst) {
        const rel = path.relative(RESULTS_DIR, result.file.dst).split(path.sep).join('/');
        downloadUrl = '/api/download?f=' + encodeURIComponent(rel);
      }

      if (jobId) sendSSE(jobId, { type: 'done', status: result.status });

      sendJSON(res, 200, { result, explain, plan, advancedFeatures, downloadUrl, sourceId });
      return;
    }

    // --- инспекция СОБРАННОГО файла (Metadata + Validation для правой колонки окон) ---
    // Тот же inspectFile(), что и для исходника, но по готовому результату в RESULTS_DIR;
    // путь приходит тем же параметром f, что у download/export-json (safeJoin — защита от traversal).
    if (req.method === 'GET' && pathname === '/api/inspect-result') {
      const f = url.searchParams.get('f');
      const filePath = f && safeJoin(RESULTS_DIR, f);
      if (!filePath || !fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: 'Result file not found' });
        return;
      }
      let data;
      try {
        data = await inspectFile(filePath);
      } catch (e: any) {
        console.error('[inspect-result] failed:', e);
        sendJSON(res, 500, { error: 'Inspection failed: ' + e.message });
        return;
      }
      sendJSON(res, 200, data);
      return;
    }

    // --- экспорт результата как самодостаточного glTF JSON ---
    if (req.method === 'GET' && pathname === '/api/export-json') {
      const f = url.searchParams.get('f');
      const filePath = f && safeJoin(RESULTS_DIR, f);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Result file not found');
        return;
      }
      let json;
      try {
        json = await exportJson(filePath);
      } catch (e: any) {
        sendJSON(res, 500, { error: 'JSON export failed: ' + e.message });
        return;
      }
      const name = chosenExportName(url.searchParams.get('name'), path.basename(filePath).replace(/\.glb$/i, '.gltf'), '.gltf');
      const body = JSON.stringify(json, null, 2);
      const asciiFallback = asciiHeaderName(name);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      res.end(body);
      return;
    }

    // --- скачивание результата ---
    if (req.method === 'GET' && pathname === '/api/download') {
      const f = url.searchParams.get('f');
      if (!f) {
        res.writeHead(400);
        res.end('f parameter required');
        return;
      }
      // f может содержать подпапку исходника (sourceId/name.glb); safeJoin держит
      // путь внутри RESULTS_DIR (защита от traversal — см. safeJoin).
      const filePath = safeJoin(RESULTS_DIR, f);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Result file not found');
        return;
      }
      const data = await fsp.readFile(filePath);
      const name = chosenExportName(url.searchParams.get('name'), path.basename(filePath), '.glb');
      const asciiFallback = asciiHeaderName(name);
      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      res.end(data);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e: any) {
    console.error('[server] unhandled error:', e);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: 'Internal server error: ' + e.message });
    }
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the server seems to be running already.`);
    console.error(`Open http://localhost:${PORT} in a browser or close the other run (the npm start window).`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  // PORT=0 просит систему выдать любой свободный — тогда настоящий номер известен
  // только отсюда. Настольное приложение так и делает: фиксированный порт занят, если
  // человек уже запустил программу из терминала, и окно молча не открылось бы.
  // Слушаем TCP, поэтому адрес — объект с портом, а не путь к сокету.
  const port = (server.address() as import('node:net').AddressInfo).port;
  // Адрес называем тем же именем, на котором слушаем. Раньше стояло `localhost` при
  // прослушивании всех интерфейсов — и разница была незаметна. Теперь сокет открыт
  // только на 127.0.0.1, а `localhost` на части машин сначала разрешается в `::1`:
  // окно приложения постучалось бы туда, где никто не отвечает.
  const address = `http://${HOST}:${port}`;
  console.log(`Tanyra3D UI: ${address} (core v${VERSION})`);

  // Родителю (настольной оболочке) адрес нужен раньше, чем человеку: окно ждёт его,
  // чтобы открыться. Обычный запуск из терминала родителя не имеет — ветка молчит.
  if (typeof process.send === 'function') process.send({ type: 'listening', port, address });

  // Внутри окна приложения браузер открывать не надо: страница уже показана в нём.
  if (process.env.TANYRA_NO_BROWSER === '1') return;

  // Открываем браузер автоматически; неудача — не критична, просто печатаем ссылку.
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', address], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [address], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [address], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (e) {
    console.log('Could not open the browser automatically — open it manually:', address);
  }
});
