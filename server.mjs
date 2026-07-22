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
const PORT = 3210;

const UI_DIR = path.join(__dirname, 'ui');
const UPLOADS_DIR = path.join(__dirname, '_web', 'uploads');
const RESULTS_DIR = path.join(__dirname, '_web', 'results');
// three.js для встроенного просмотрщика отдаётся прямо из node_modules (пакет-зависимость,
// см. package.json). Никакого бандлера/CDN — браузер грузит нативные ESM через importmap
// (см. ui/index.html), а декодеры Draco/KTX2 — по путям /vendor/three/examples/jsm/libs/...
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

// Никаких накоплений: на старте чистим прежние загрузки/результаты (только текущая
// оптимизация хранится на диске — см. purgeSourcesExcept).
await fsp.rm(UPLOADS_DIR, { recursive: true, force: true }).catch(() => {});
await fsp.rm(RESULTS_DIR, { recursive: true, force: true }).catch(() => {});
await fsp.mkdir(UPLOADS_DIR, { recursive: true });
await fsp.mkdir(RESULTS_DIR, { recursive: true });

// ---- Ядро (обязательный контракт §4b ARCHITECTURE.md) ----
const core = await import('./optimize2.mjs');
const { optimizeFile, inspectFile, listRules, VERSION } = core;

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

function listPlatformsSafe() {
  if (assistant && typeof assistant.listPlatforms === 'function') {
    try {
      const p = assistant.listPlatforms();
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
function listExtensionsSafe(platformId) {
  if (assistant && typeof assistant.listExtensions === 'function') {
    try {
      const list = assistant.listExtensions(platformId);
      if (Array.isArray(list)) return list;
    } catch (e) {
      console.error('[assistant] listExtensions() failed:', e.message);
    }
  }
  return [];
}

function planForSafe(platformId) {
  if (assistant && typeof assistant.planFor === 'function') {
    try {
      const plan = assistant.planFor(platformId);
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

function explainResultSafe(runResult, platformId) {
  if (assistant && typeof assistant.explainResult === 'function') {
    try {
      const explain = assistant.explainResult(runResult, platformId);
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

// ---- Загруженные исходники (для повторной оптимизации без перезаливки) ----
// Ядро — чистая функция (исходник не мутируется, см. §4d), поэтому одну и ту же модель
// можно гонять с разными опциями сколько угодно раз. Сервер держит исходник, чтобы
// десятки/сотни вариантов не перекачивали файл: клиент шлёт sourceId вместо тела.
/** @type {Map<string, { uploadPath: string, name: string }>} */
const sourceUploads = new Map();

// Держим на диске только текущий исходник: при загрузке новой модели стираем все прежние
// (папки uploads/<id> и results/<id>) — записи не копятся, живёт лишь последняя оптимизация.
async function purgeSourcesExcept(keepId) {
  for (const id of [...sourceUploads.keys()]) {
    if (id === keepId) continue;
    sourceUploads.delete(id);
    await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }).catch(() => {});
  }
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

function sanitizeFileName(name) {
  const base = path.basename(name || 'model.glb');
  // убираем управляющие/запрещённые для файловой системы Windows символы, оставляем юникод (кириллицу)
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'model.glb';
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

    // --- статика UI ---
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }

    // --- список платформ ---
    if (req.method === 'GET' && pathname === '/api/platforms') {
      sendJSON(res, 200, { platforms: listPlatformsSafe(), engineVersion: VERSION });
      return;
    }

    // --- расширенные опции для платформы ---
    if (req.method === 'GET' && pathname === '/api/extensions') {
      const platformId = url.searchParams.get('platform') || '';
      sendJSON(res, 200, { extensions: listExtensionsSafe(platformId) });
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      progressClients.set(jobId, res);
      req.on('close', () => {
        progressClients.delete(jobId);
      });
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
      sourceUploads.set(sourceId, { uploadPath, name: fileName });
      await purgeSourcesExcept(sourceId);

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
      const platformId = url.searchParams.get('platform') || (listPlatformsSafe()[0] || {}).id;
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
        sourceUploads.set(sourceId, { uploadPath, name: fileName });
        // новая модель → стереть данные предыдущих (не копим лишнее)
        await purgeSourcesExcept(sourceId);
      }

      const plan = planForSafe(platformId);
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
        });
      } catch (e) {
        console.error('[optimize] exception during processing:', e);
        sendJSON(res, 500, { error: 'Could not process the model: ' + e.message });
        return;
      }

      const explain = explainResultSafe(result, platformId);

      let downloadUrl = null;
      if (result.status === 'ok' && result.file && result.file.written && result.file.dst) {
        const rel = path.relative(RESULTS_DIR, result.file.dst).split(path.sep).join('/');
        downloadUrl = '/api/download?f=' + encodeURIComponent(rel);
      }

      if (jobId) sendSSE(jobId, { type: 'done', status: result.status });

      sendJSON(res, 200, { result, explain, plan, advancedFeatures, downloadUrl, sourceId });
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
      const name = path.basename(filePath);
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_');
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
