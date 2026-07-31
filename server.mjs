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
const PORT = Number(process.env.PORT) || 3210;

const UI_DIR = path.join(__dirname, 'ui');
const UPLOADS_DIR = path.join(__dirname, '_web', 'uploads');
const RESULTS_DIR = path.join(__dirname, '_web', 'results');
// three.js для встроенного просмотрщика отдаётся прямо из node_modules (пакет-зависимость,
// см. package.json). Никакого бандлера/CDN — браузер грузит нативные ESM через importmap
// (см. ui/index.html), а декодеры Draco/KTX2 — по путям /vendor/three/examples/jsm/libs/...
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

// Никаких накоплений: на старте чистим прежние загрузки/результаты (только текущая
// оптимизация хранится на диске — см. purgeBeyondLimit).
// Чистим СОДЕРЖИМОЕ, а не саму папку: на Windows удалённый каталог остаётся в состоянии
// pending-delete, и немедленный mkdir того же имени падает (UNKNOWN errno -4094).
async function ensureEmptyDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const entry of entries) {
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
  }
}
await ensureEmptyDir(UPLOADS_DIR);
await ensureEmptyDir(RESULTS_DIR);

// ---- Ядро (обязательный контракт §4b ARCHITECTURE.md) ----
const core = await import('./optimize2.mjs');
const { optimizeFile, inspectFile, exportJson, VERSION } = core;

// ---- Ассистент (появляется параллельно; graceful-фолбэк, если модуля ещё нет) ----
let assistant = null;
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
// codec/texMode срабатывают только если включён флажок компрессии/ktx2.
const FALLBACK_ENGINE_OPTS = {
  codec: 'meshopt',
  texMode: 'uastc',
  keepParts: false,
  noKtx: true,
  stripColors: false,
  dryRun: false,
};

// Язык отчёта приходит от клиента параметром ?lang=. Не по заголовку Accept-Language:
// в интерфейсе язык переключается кнопкой, и отчёт должен идти на выбранном языке,
// а не на языке, который браузер считает предпочтительным.
function langOf(url) {
  const v = url && url.searchParams ? url.searchParams.get('lang') : null;
  return v && /^[a-z]{2}$/.test(v) ? v : 'en';
}

function listPlatformsSafe(lang) {
  if (assistant && typeof assistant.listPlatforms === 'function') {
    try {
      const p = assistant.listPlatforms(lang);
      if (Array.isArray(p) && p.length) return p;
    } catch (e) {
      console.error('[assistant] listPlatforms() failed:', e.message);
    }
  }
  return FALLBACK_PLATFORMS;
}

// Расширенные опции (KTX2/Draco/strip-colors/...) — контракт с AI Assistant §4c:
//   listExtensions(platformId) → [{ id, title, description, impact }]
// Пока assistant.mjs не реализует listExtensions(), возвращаем пустой список —
// панель «Расширенные опции» в UI просто не покажется (нет придуманных web-interface данных).
function listExtensionsSafe(platformId, lang) {
  if (assistant && typeof assistant.listExtensions === 'function') {
    try {
      const list = assistant.listExtensions(platformId, lang);
      if (Array.isArray(list)) return list;
    } catch (e) {
      console.error('[assistant] listExtensions() failed:', e.message);
    }
  }
  return [];
}

function planForSafe(platformId, lang) {
  if (assistant && typeof assistant.planFor === 'function') {
    try {
      const plan = assistant.planFor(platformId, lang);
      if (plan && typeof plan === 'object') return plan;
    } catch (e) {
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

function explainResultSafe(runResult, platformId, lang) {
  if (assistant && typeof assistant.explainResult === 'function') {
    try {
      const explain = assistant.explainResult(runResult, platformId, lang);
      if (explain && typeof explain === 'object') return explain;
    } catch (e) {
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

async function dropSource(id) {
  sourceUploads.delete(id);
  await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }).catch(() => {});
}

// Оставить N самых свежих исходников, остальные стереть. Сравнение по seq, а не по
// времени файла: две одновременные загрузки видели друг друга «старыми» и стирали
// чужие каталоги, так что обе вкладки теряли исходник.
async function purgeBeyondLimit() {
  const entries = [...sourceUploads.entries()].sort((a, b) => b[1].seq - a[1].seq);
  for (const [id] of entries.slice(MAX_KEPT_SOURCES)) await dropSource(id);
}

function sendSSE(jobId, payload) {
  const res = progressClients.get(jobId);
  if (!res) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
    // клиент уже отключился — не страшно
  }
}

// ---- Утилиты ----

const MIME = {
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

function safeJoin(baseDir, relPath) {
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
  let localeFiles = [];
  try {
    localeFiles = (await fsp.readdir(LOCALES_DIR)).filter((f) => f.endsWith('.js'));
  } catch (e) {
    return ''; // папки нет — интерфейс останется на языке разметки
  }
  localeFiles.sort((a, b) => (a === 'en.js' ? -1 : b === 'en.js' ? 1 : a.localeCompare(b)));

  // Переводы из translations/ (ru.js, validator-ru.js, …)
  let transFiles = [];
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

async function serveStatic(req, res, urlPath, baseDir = UI_DIR, stripPrefix = '') {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 1024 * 1024 * 1024; // 1 ГБ — щедрый предел для локального инструмента
    req.on('data', (chunk) => {
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

function sendJSON(res, status, obj) {
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

function sanitizeFileName(name) {
  const base = path.basename(name || 'model.glb');
  // убираем управляющие/запрещённые для файловой системы Windows символы, оставляем юникод (кириллицу)
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
function chosenExportName(reqName, fallback, ext) {
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
function asciiHeaderName(name) {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

// ---- HTTP сервер ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // краткий лог каждого запроса — чтобы проблемы вроде «файл недоступен» были видны в консоли
  if (pathname.startsWith('/api/')) {
    res.on('finish', () => console.log(`[${req.method}] ${decodeURIComponent(req.url)} → ${res.statusCode}`));
  }

  try {
    // --- three.js для просмотрщика (из node_modules/three) ---
    if (req.method === 'GET' && pathname.startsWith('/vendor/three/')) {
      await serveStatic(req, res, pathname, THREE_DIR, '/vendor/three');
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
      const platformId = url.searchParams.get('platform');
      if (!platformId) {
        sendJSON(res, 400, { error: 'platform is required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        sendJSON(res, 400, { error: 'Malformed JSON body' });
        return;
      }
      sendJSON(res, 200, { explain: explainResultSafe(payload && payload.result, platformId, langOf(url)) });
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

    if (req.method === 'GET' && pathname === '/api/platforms') {
      sendJSON(res, 200, { platforms: listPlatformsSafe(langOf(url)), engineVersion: VERSION });
      return;
    }

    // --- расширенные опции для платформы ---
    if (req.method === 'GET' && pathname === '/api/extensions') {
      const platformId = url.searchParams.get('platform') || '';
      sendJSON(res, 200, { extensions: listExtensionsSafe(platformId, langOf(url)) });
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
      const rawName = req.headers['x-filename'] || 'model.glb';
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
      } catch (e) {
        console.error('[inspect] failed:', e);
        sendJSON(res, 500, { error: 'Inspection failed: ' + e.message });
        return;
      }
      sendJSON(res, 200, { sourceId, ...data });
      return;
    }

    // --- обработка модели ---
    if (req.method === 'POST' && pathname === '/api/optimize') {
      const platformId = url.searchParams.get('platform') || (listPlatformsSafe(langOf(url))[0] || {}).id;
      const jobId = url.searchParams.get('job') || '';
      const featuresParam = url.searchParams.get('features') || '';
      const advancedFeatures = featuresParam.split(',').map((s) => s.trim()).filter(Boolean);
      // режим KTX2 из UI: uastc (по умолчанию) | mixed (ETC1S). Влияет только при флажке ktx2.
      const texModeParam = url.searchParams.get('texMode') === 'mixed' ? 'mixed' : 'uastc';

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
        const rawName = req.headers['x-filename'] || 'model.glb';
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

      const plan = planForSafe(platformId, langOf(url));
      const engineOpts = { ...FALLBACK_ENGINE_OPTS, ...(plan.engineOpts || {}), texMode: texModeParam };

      const onProgress = (e) => {
        if (jobId) sendSSE(jobId, e);
      };

      // Результат каждого исходника — в своей подпапке, чтобы разные модели не
      // перетирали друг друга; повторные прогоны одной модели перезаписывают её вариант.
      const outDir = path.join(RESULTS_DIR, sourceId);
      await fsp.mkdir(outDir, { recursive: true });

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
      } catch (e) {
        console.error('[optimize] exception during processing:', e);
        sendJSON(res, 500, { error: 'Could not process the model: ' + e.message });
        return;
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
      } catch (e) {
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
      } catch (e) {
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
  } catch (e) {
    console.error('[server] unhandled error:', e);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: 'Internal server error: ' + e.message });
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the server seems to be running already.`);
    console.error(`Open http://localhost:${PORT} in a browser or close the other run (the npm start window).`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`glb-web-optimize UI: ${address} (core v${VERSION})`);

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
