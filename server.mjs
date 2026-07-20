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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3210;

const UI_DIR = path.join(__dirname, 'ui');
const UPLOADS_DIR = path.join(__dirname, '_web', 'uploads');
const RESULTS_DIR = path.join(__dirname, '_web', 'results');

await fsp.mkdir(UPLOADS_DIR, { recursive: true });
await fsp.mkdir(RESULTS_DIR, { recursive: true });

// ---- Ядро (обязательный контракт §4b ARCHITECTURE.md) ----
const core = await import('./optimize2.mjs');
const { optimizeFile, listRules, VERSION } = core;

// ---- Ассистент (появляется параллельно; graceful-фолбэк, если модуля ещё нет) ----
let assistant = null;
try {
  assistant = await import('./assistant.mjs');
  console.log('[assistant] assistant.mjs подключён');
} catch (e) {
  console.log('[assistant] assistant.mjs не найден — работаем без объяснений (фолбэк)');
}

const FALLBACK_PLATFORMS = [
  { id: 'web', title: 'Веб', description: 'Стандартная подготовка для сайта' },
];

const FALLBACK_ENGINE_OPTS = {
  codec: 'meshopt',
  texMode: 'mixed',
  keepParts: false,
  noKtx: false,
  stripColors: false,
  dryRun: false,
};

function listPlatformsSafe() {
  if (assistant && typeof assistant.listPlatforms === 'function') {
    try {
      const p = assistant.listPlatforms();
      if (Array.isArray(p) && p.length) return p;
    } catch (e) {
      console.error('[assistant] listPlatforms() упал:', e.message);
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
      console.error('[assistant] listExtensions() упал:', e.message);
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
      console.error('[assistant] planFor() упал:', e.message);
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
      console.error('[assistant] explainResult() упал:', e.message);
    }
  }
  // Фолбэк: без сочинённых от себя объяснений — пустые массивы,
  // фронтенд покажет только сырые данные ядра (findings/applied/skipped/validation).
  return { summary: '', highlights: [], budgetChecks: [], warnings: [] };
}

// ---- SSE: карта активных подключений прогресса, ключ — jobId ----
/** @type {Map<string, import('node:http').ServerResponse>} */
const progressClients = new Map();

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
};

function safeJoin(baseDir, relPath) {
  const resolved = path.resolve(baseDir, relPath);
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  return resolved;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = safeJoin(UI_DIR, '.' + rel);
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
    res.end('Не найдено: ' + rel);
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
        reject(new Error('Файл слишком большой'));
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
        res.end('нужен параметр job');
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

    // --- обработка модели ---
    if (req.method === 'POST' && pathname === '/api/optimize') {
      const platformId = url.searchParams.get('platform') || (listPlatformsSafe()[0] || {}).id;
      const jobId = url.searchParams.get('job') || '';
      const featuresParam = url.searchParams.get('features') || '';
      const advancedFeatures = featuresParam.split(',').map((s) => s.trim()).filter(Boolean);

      const rawName = req.headers['x-filename'] || 'model.glb';
      let decodedName;
      try {
        decodedName = decodeURIComponent(rawName);
      } catch (e) {
        decodedName = rawName;
      }
      const fileName = sanitizeFileName(decodedName);
      if (!/\.glb$/i.test(fileName)) {
        sendJSON(res, 400, { error: 'Ожидается файл .glb' });
        return;
      }

      const bytes = await readBody(req);
      if (!bytes.length) {
        sendJSON(res, 400, { error: 'Пустое тело запроса — файл не получен' });
        return;
      }

      const uploadPath = path.join(UPLOADS_DIR, fileName);
      await fsp.writeFile(uploadPath, bytes);

      const plan = planForSafe(platformId);
      const engineOpts = { ...FALLBACK_ENGINE_OPTS, ...(plan.engineOpts || {}) };

      const onProgress = (e) => {
        if (jobId) sendSSE(jobId, e);
      };

      let result;
      try {
        result = await optimizeFile(uploadPath, {
          ...engineOpts,
          advancedFeatures,
          outDir: RESULTS_DIR,
          force: true,
          onProgress,
        });
      } catch (e) {
        console.error('[optimize] исключение при обработке:', e);
        sendJSON(res, 500, { error: 'Не удалось обработать модель: ' + e.message });
        return;
      }

      const explain = explainResultSafe(result, platformId);

      let downloadUrl = null;
      if (result.status === 'ok' && result.file && result.file.written && result.file.dst) {
        downloadUrl = '/api/download?f=' + encodeURIComponent(path.basename(result.file.dst));
      }

      if (jobId) sendSSE(jobId, { type: 'done', status: result.status });

      sendJSON(res, 200, { result, explain, plan, advancedFeatures, downloadUrl });
      return;
    }

    // --- скачивание результата ---
    if (req.method === 'GET' && pathname === '/api/download') {
      const f = url.searchParams.get('f');
      if (!f) {
        res.writeHead(400);
        res.end('нужен параметр f');
        return;
      }
      const filePath = safeJoin(RESULTS_DIR, path.basename(f));
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Файл результата не найден');
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
    res.end('Не найдено');
  } catch (e) {
    console.error('[server] необработанная ошибка:', e);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: 'Внутренняя ошибка сервера: ' + e.message });
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят — похоже, сервер уже запущен.`);
    console.error(`Откройте http://localhost:${PORT} в браузере или закройте другой запуск (окно npm start).`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`glb-web-optimize UI: ${address} (ядро v${VERSION})`);

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
    console.log('Не удалось открыть браузер автоматически — откройте вручную:', address);
  }
});
