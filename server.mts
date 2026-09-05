import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3210;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 3210;
})();

const HOST = process.env.TANYRA_HOST || '127.0.0.1';

const UI_DIR = path.join(__dirname, 'ui');
const CORE_DIR = path.join(__dirname, 'core');

const DATA_DIR = process.env.TANYRA_DATA_DIR || path.join(__dirname, '_web');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const ANIM_POINTER_DIR = path.join(__dirname, 'node_modules', '@needle-tools', 'three-animation-pointer');
const GLTF_EXT_DIR = path.join(__dirname, 'node_modules', 'three-gltf-extensions');

async function ensureEmptyDir(dir: string, keep: Set<string> = new Set()) {
  await fsp.mkdir(dir, { recursive: true });
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
  }
}
await ensureEmptyDir(UPLOADS_DIR);
await ensureEmptyDir(RESULTS_DIR);

const core = await import('./optimize2.mjs');
const { optimizeFile, inspectFile, exportJson, VERSION, exclusiveGroups, textureSlots } = core;
const { localizeResult, render } = await import('./core/i18n.mjs');

function explainError(e: any, lang: string): string {
  if (e && e.i18n && e.i18n.messageId) {
    try { return render(e.i18n.messageId, e.i18n.data || {}, lang); } catch {  }
  }
  return e && e.message ? e.message : String(e);
}

type AssistantModule = typeof import('./assistant.mjs');

type PlanLike = Record<string, any>;

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

const FALLBACK_ENGINE_OPTS = {
  codec: 'meshopt',
  keepParts: false,
  noKtx: true,
  stripColors: false,
  dryRun: false,
};

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
  return { summary: '', highlights: [], budgetChecks: [], warnings: [] };
}

const progressClients = new Map();

const MAX_SSE_CLIENTS = 32;
const SSE_PING_MS = 30_000;
const SSE_MAX_LIFETIME_MS = 30 * 60_000;

const sourceUploads = new Map();

let uploadSeq = 0;

function isSourceId(id: string) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

function packDirOf(sourceParam: string): string | null {
  if (!sourceParam || !isSourceId(sourceParam)) return null;
  if (sourceUploads.has(sourceParam)) return null;
  const dir = path.join(UPLOADS_DIR, sourceParam);
  return fs.existsSync(dir) ? dir : null;
}

const MAX_KEPT_SOURCES = 12;

const MAX_KEPT_RUNS = 3;

const MAX_WORK_BYTES = (() => {
  const n = Number(process.env.TANYRA_WORK_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 8 * 1024 ** 3;
})();

const sourceRuns = new Map();

const activeRuns = new Set();

const runKey = (sourceId: string, runId: string) => `${sourceId}/${runId}`;

async function rememberRun(sourceId: string, runId: string) {
  const runs = sourceRuns.get(sourceId) || [];
  runs.push(runId);
  sourceRuns.set(sourceId, runs);

  while (runs.length > MAX_KEPT_RUNS) {
    const victim = runs.find((id: string) => !activeRuns.has(runKey(sourceId, id)));
    if (!victim) break;
    const ok = await fsp.rm(path.join(RESULTS_DIR, sourceId, victim), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    if (!ok) break;
    runs.splice(runs.indexOf(victim), 1);
  }

  await purgeBeyondLimit();
}

async function dropSource(id: string) {
  sourceUploads.delete(id);
  sourceRuns.delete(id);
  pendingPacks.delete(id);
  await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }).catch(() => {});
}

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

const workBytes = async () => (await dirBytes(UPLOADS_DIR)) + (await dirBytes(RESULTS_DIR));

const sourceBytes = async (id: string) =>
  (await dirBytes(path.join(UPLOADS_DIR, id))) + (await dirBytes(path.join(RESULTS_DIR, id)));

const sourceBusy = (id: string) => [...activeRuns].some((key) => (key as string).startsWith(`${id}/`));

const pendingPacks = new Map<string, { touched: number }>();

const packWrites = new Map<string, number>();

const uploadWrites = new Map<string, number>();

const beginWrite = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) || 0) + 1);
const endWrite = (map: Map<string, number>, id: string) => {
  const left = (map.get(id) || 1) - 1;
  if (left > 0) map.set(id, left); else map.delete(id);
};

const busyNow = (): Set<string> => new Set([
  ...[...activeRuns].map((key) => String(key).split('/')[0]!),
  ...uploadWrites.keys(),
  ...packWrites.keys(),
]);

const PACK_IDLE_MS = (() => {
  const n = Number(process.env.TANYRA_PACK_IDLE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
})();

const touchPack = (id: string) => pendingPacks.set(id, { touched: Date.now() });

const packBecameSource = (id: string) => { pendingPacks.delete(id); };

async function sweepAbandoned() {
  const now = Date.now();
  for (const [id, info] of [...pendingPacks]) {
    if (packWrites.get(id)) continue;
    if (now - info.touched < PACK_IDLE_MS) continue;
    await dropSource(id);
  }
  let onDisk: string[];
  try { onDisk = await fsp.readdir(UPLOADS_DIR); } catch { return; }
  for (const id of onDisk) {
    if (sourceUploads.has(id) || pendingPacks.has(id) || packWrites.get(id)) continue;
    await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(RESULTS_DIR, id), { recursive: true, force: true }).catch(() => {});
  }
}

async function purgeBeyondLimit() {
  await sweepAbandoned();
  const entries = [...sourceUploads.entries()].sort((a, b) => b[1].seq - a[1].seq);
  const kept: string[] = [];
  for (const [id] of entries) {
    if (kept.length < MAX_KEPT_SOURCES || sourceBusy(id)) kept.push(id);
    else await dropSource(id);
  }

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
  }
}


const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

const LOCALES_DIR = path.join(UI_DIR, 'locales');
const TRANSLATIONS_DIR = path.join(__dirname, 'translations');
const LOCALE_MARKER = '<!--locales-->';

async function localeScriptTags() {
  let localeFiles;
  try {
    localeFiles = (await fsp.readdir(LOCALES_DIR)).filter((f) => f.endsWith('.js'));
  } catch (e) {
    return '';
  }
  localeFiles.sort((a, b) => (a === 'en.js' ? -1 : b === 'en.js' ? 1 : a.localeCompare(b)));

  let transFiles: string[] = [];
  try {
    transFiles = (await fsp.readdir(TRANSLATIONS_DIR)).filter((f) => f.endsWith('.js'));
  } catch (e) {
  }
  transFiles.sort((a, b) => a.localeCompare(b));

  const enSet = new Set(localeFiles);
  const tags = [];
  for (const f of localeFiles) {
    tags.push(`<script src="/locales/${encodeURIComponent(f)}"></script>`);
  }
  for (const f of transFiles) {
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

const MAX_BODY = (() => {
  const n = Number(process.env.TANYRA_MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 1024 * 1024 * 1024;
})();

const MAX_JSON_BODY = 4 * 1024 * 1024;

function streamBodyToFile(req: http.IncomingMessage, dest: string, max = MAX_BODY): Promise<number> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.destroy();
      reject(new Error('File too large'));
      return;
    }

    const out = fs.createWriteStream(dest);
    let size = 0;
    let failed: Error | null = null;

    const fail = (err: Error) => {
      if (failed) return;
      failed = err;
      req.destroy();
      out.destroy();
      fs.rm(dest, { force: true }, () => reject(err));
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) { fail(new Error('File too large')); return; }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('error', fail);
    out.on('error', fail);
    req.on('end', () => { if (!failed) out.end(); });
    out.on('close', () => { if (!failed) resolve(size); });
  });
}

function readBody(req: http.IncomingMessage, max = MAX_JSON_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = max;
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

const MODEL_EXT = /\.(glb|gltf|stl|ply|fbx|obj)$/i;

const MODEL_EXT_WORDS = (MODEL_EXT.source.match(/\(([^)]+)\)/)?.[1] || '')
  .split('|').map((e) => `.${e}`).join(', ');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function sanitizeFileName(name: string): string {
  const base = path.basename(name || 'model.glb');
  // eslint-disable-next-line no-control-regex -- управляющие символы тут и есть цель: имя файла с \x00 внутри Windows не создаст
  let clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  clean = clean.replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(clean)) clean = '_' + clean;
  return clean || 'model.glb';
}

function safeAssetPath(srcDir: string, rel: string): string | null {
  const raw = String(rel || '');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw) || /^([a-zA-Z]:)?[\\/]/.test(raw)) return null;
  const parts = raw
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.')
    .map((p) => sanitizeFileName(p));
  if (!parts.length) return null;
  const full = path.join(srcDir, ...parts);
  const root = path.resolve(srcDir) + path.sep;
  if (!path.resolve(full).startsWith(root)) return null;
  return full;
}

const MAX_PACK_FILES = 100;

function chosenExportName(reqName: string | null | undefined, fallback: string, ext: string): string {
  if (!reqName) return fallback;
  const clean = sanitizeFileName(reqName).replace(/\.[^.]+$/, '');
  return (clean || 'model') + ext;
}

function asciiHeaderName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}


const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackHostname = (value: string | undefined | null) => {
  if (!value) return false;
  try { return LOOPBACK.has(new URL(`http://${value}`).hostname); } catch { return false; }
};
function originAllowed(req: http.IncomingMessage): boolean {
  if (HOST !== '127.0.0.1') return true;
  if (!loopbackHostname(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
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

  if (pathname.startsWith('/api/')) {
    res.on('finish', () => console.log(`[${req.method}] ${decodeURIComponent(req.url!)} → ${res.statusCode}`));
  }

  try {
    if (req.method === 'GET' && pathname.startsWith('/vendor/three/')) {
      await serveStatic(req, res, pathname, THREE_DIR, '/vendor/three');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/vendor/animation-pointer/')) {
      await serveStatic(req, res, pathname, ANIM_POINTER_DIR, '/vendor/animation-pointer');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/vendor/gltf-extensions/')) {
      await serveStatic(req, res, pathname, GLTF_EXT_DIR, '/vendor/gltf-extensions');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/core/')) {
      await serveStatic(req, res, pathname, CORE_DIR, '/core');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/translations/')) {
      await serveStatic(req, res, pathname, TRANSLATIONS_DIR, '/translations');
      return;
    }

    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/explain') {
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
      const lang = langOf(url);
      const localized = localizeResult(payload && payload.result, lang);
      sendJSON(res, 200, { explain: explainResultSafe(localized, platformId, lang), result: localized });
      return;
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/source/')) {
      const id = decodeURIComponent(pathname.slice('/api/source/'.length));
      if (!isSourceId(id)) {
        sendJSON(res, 400, { error: 'bad source id' });
        return;
      }
      await dropSource(id);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/workdir') {
      if (req.method === 'GET') {
        sendJSON(res, 200, { path: DATA_DIR, bytes: await workBytes(), limit: MAX_WORK_BYTES });
        return;
      }
      if (req.method === 'DELETE') {
        const busy = busyNow();
        for (const id of [...sourceUploads.keys()]) if (!busy.has(id)) sourceUploads.delete(id);
        for (const id of [...sourceRuns.keys()]) if (!busy.has(id)) sourceRuns.delete(id);
        for (const id of [...pendingPacks.keys()]) if (!busy.has(id)) pendingPacks.delete(id);
        await ensureEmptyDir(UPLOADS_DIR, busy);
        await ensureEmptyDir(RESULTS_DIR, busy);
        sendJSON(res, 200, { bytes: await workBytes(), kept: busy.size });
        return;
      }
      sendJSON(res, 405, { error: 'method_not_allowed' });
      return;
    }

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
      const opener = process.platform === 'win32' ? 'explorer.exe'
        : process.platform === 'darwin' ? 'open'
        : 'xdg-open';
      try { spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch {  }
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/profiles' || pathname.startsWith('/api/profiles/')) {
      if (!assistant || typeof assistant.saveCustomProfile !== 'function') {
        sendJSON(res, 501, { error: 'no_assistant' });
        return;
      }
      const lang = langOf(url);
      let id = '';
      if (pathname.startsWith('/api/profiles/')) {
        const raw = pathname.slice('/api/profiles/'.length);
        try { id = decodeURIComponent(raw); } catch { id = raw; }
      }
      const fail = (e: any) => {
        if (e && e.name === 'ProfileError') {
          sendJSON(res, 400, { error: e.code, field: e.field || null });
        } else {
          console.error('[profiles]', e && e.message);
          sendJSON(res, 500, { error: 'write_failed', detail: e && e.message });
        }
      };
      try {
        if (req.method === 'GET' && !id) {
          sendJSON(res, 200, assistant.profileTemplate(lang));
          return;
        }
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
      let noPlatform = null;
      if (assistant && typeof assistant.noPlatformInfo === 'function') {
        try { noPlatform = assistant.noPlatformInfo(langOf(url)); } catch (e: any) {
          console.error('[assistant] noPlatformInfo() failed:', e.message);
        }
      }
      sendJSON(res, 200, { platforms: listPlatformsSafe(langOf(url)), noPlatform, engineVersion: VERSION });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/engines') {
      const forPlatform = url.searchParams.get('platform') || '';
      sendJSON(res, 200, { engines: listEnginesSafe(forPlatform, langOf(url)) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/extensions') {
      const platformId = url.searchParams.get('platform') || '';
      const askedEngine = url.searchParams.get('engine') || '';
      const plan = planForSafe(platformId, langOf(url), askedEngine);
      const planEngine = plan.engine || 'threejs';
      const engine = askedEngine === planEngine ? askedEngine : planEngine;
      const engineInfo = plan.engineInfo || null;
      const planDefaults = plan.engineOpts || {};
      const advisedTexMode = (planDefaults.texMode === 'mixed' || planDefaults.texMode === 'uastc')
        ? planDefaults.texMode
        : null;
      const advises = (plan.advises || {}) as { codec?: string };
      const groups = typeof exclusiveGroups === 'function' ? exclusiveGroups() : [];
      const codecs: string[] = (groups.find((g) => g.id === 'geometry') || {}).members || [];
      const advisedCodec = codecs.includes(advises.codec as string) ? advises.codec : null;
      sendJSON(res, 200, {
        engine,
        engineInfo,
        extensions: listExtensionsSafe(platformId, langOf(url), engine),
        exclusiveGroups: groups,
        textureSlots: typeof textureSlots === 'function' ? textureSlots() : [],
        defaults: { texMode: advisedTexMode, codec: advisedCodec },
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/progress') {
      const jobId = url.searchParams.get('job');
      if (!jobId) {
        res.writeHead(400);
        res.end('job parameter required');
        return;
      }
      const previous = progressClients.get(jobId);
      if (previous && previous !== res) {
        try { previous.end(); } catch {  }
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

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { closeStream(); }
      }, SSE_PING_MS);
      const deadline = setTimeout(closeStream, SSE_MAX_LIFETIME_MS);
      ping.unref?.();
      deadline.unref?.();
      function closeStream() {
        clearInterval(ping);
        clearTimeout(deadline);
        if (progressClients.get(jobId) === res) progressClients.delete(jobId);
        try { res.end(); } catch {  }
      }
      req.on('close', closeStream);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/asset') {
      const sourceParam = url.searchParams.get('source') || '';
      const rawName = (req.headers['x-filename'] as string) || '';
      let decodedName;
      try { decodedName = decodeURIComponent(rawName); } catch (e) { decodedName = rawName; }

      let sourceId = sourceParam;
      let srcDir: string | null = null;
      if (isSourceId(sourceId)) {
        const known = sourceUploads.get(sourceId);
        srcDir = known ? path.dirname(known.uploadPath) : packDirOf(sourceId);
      }
      if (!srcDir) {
        sourceId = randomUUID();
        srcDir = path.join(UPLOADS_DIR, sourceId);
        await fsp.mkdir(srcDir, { recursive: true });
      }

      const dest = safeAssetPath(srcDir, decodedName);
      if (!dest) {
        sendJSON(res, 400, { error: 'Bad asset name' });
        return;
      }
      let existing = 0;
      try {
        for (const e of await fsp.readdir(srcDir, { withFileTypes: true, recursive: true })) {
          if (e.isFile()) existing += 1;
        }
      } catch {  }
      if (existing >= MAX_PACK_FILES) {
        sendJSON(res, 413, { error: `Too many files in one pack (limit ${MAX_PACK_FILES})` });
        return;
      }

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const newPack = !sourceUploads.has(sourceId);
      if (newPack) {
        touchPack(sourceId);
        beginWrite(packWrites, sourceId);
      }
      try {
        await streamBodyToFile(req, dest);
      } catch (e: any) {
        sendJSON(res, e.message === 'File too large' ? 413 : 400, { error: e.message });
        return;
      } finally {
        if (newPack) {
          endWrite(packWrites, sourceId);
          if (pendingPacks.has(sourceId)) touchPack(sourceId);
        }
      }
      sendJSON(res, 200, { sourceId });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/inspect') {
      const rawName = (req.headers['x-filename'] as string) || 'model.glb';
      let decodedName;
      try { decodedName = decodeURIComponent(rawName); } catch (e) { decodedName = rawName; }
      const fileName = sanitizeFileName(decodedName);
      if (!MODEL_EXT.test(fileName)) {
        sendJSON(res, 400, { error: `Expected one of: ${MODEL_EXT_WORDS}` });
        return;
      }
      const packParam = url.searchParams.get('source') || '';
      const packDir = packDirOf(packParam);
      if (packDir) {
        const uploadPath = path.join(packDir, fileName);
        let received;
        beginWrite(uploadWrites, packParam);
        try {
          received = await streamBodyToFile(req, uploadPath);
        } catch (e: any) {
          sendJSON(res, e.message === 'File too large' ? 413 : 400, { error: e.message });
          return;
        } finally {
          endWrite(uploadWrites, packParam);
        }
        if (!received) {
          sendJSON(res, 400, { error: 'Empty request body — no file received' });
          return;
        }
        sourceUploads.set(packParam, { uploadPath, name: fileName, seq: ++uploadSeq });
        packBecameSource(packParam);
        await purgeBeyondLimit();
        let packData;
        try {
          packData = await inspectFile(uploadPath);
        } catch (e: any) {
          console.error('[inspect] failed:', e);
          sendJSON(res, 500, { error: explainError(e, langOf(url)) });
          return;
        }
        sendJSON(res, 200, { sourceId: packParam, ...packData });
        return;
      }
      const sourceId = randomUUID();
      const srcDir = path.join(UPLOADS_DIR, sourceId);
      await fsp.mkdir(srcDir, { recursive: true });
      const uploadPath = path.join(srcDir, fileName);
      let received;
      beginWrite(uploadWrites, sourceId);
      try {
        received = await streamBodyToFile(req, uploadPath);
      } catch (e: any) {
        await fsp.rm(srcDir, { recursive: true, force: true });
        sendJSON(res, e.message === 'File too large' ? 413 : 400, { error: e.message });
        return;
      } finally {
        endWrite(uploadWrites, sourceId);
      }
      if (!received) {
        await fsp.rm(srcDir, { recursive: true, force: true });
        sendJSON(res, 400, { error: 'Empty request body — no file received' });
        return;
      }
      sourceUploads.set(sourceId, { uploadPath, name: fileName, seq: ++uploadSeq });
      await purgeBeyondLimit();

      let data;
      try {
        data = await inspectFile(uploadPath);
      } catch (e: any) {
        console.error('[inspect] failed:', e);
        sendJSON(res, 500, { error: explainError(e, langOf(url)) });
        return;
      }
      sendJSON(res, 200, { sourceId, ...data });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/optimize') {
      const platformId = url.searchParams.has('platform')
        ? (url.searchParams.get('platform') || '')
        : ((listPlatformsSafe(langOf(url))[0] || {}).id ?? '');
      const engineId = url.searchParams.get('engine') || '';
      const jobId = url.searchParams.get('job') || '';
      const featuresParam = url.searchParams.get('features') || '';
      const advancedFeatures = featuresParam.split(',').map((s) => s.trim()).filter(Boolean);
      const texModeRaw = url.searchParams.get('texMode');
      const texModeChoice = (texModeRaw === 'mixed' || texModeRaw === 'uastc') ? { texMode: texModeRaw } : {};

      const webpQualityRaw = url.searchParams.get('webpQuality');
      const webpQualityNum = (webpQualityRaw === null || webpQualityRaw.trim() === '')
        ? NaN
        : Number(webpQualityRaw);
      const webpQualityChoice = Number.isFinite(webpQualityNum)
        ? { webpQuality: Math.min(100, Math.max(0, Math.round(webpQualityNum))) }
        : {};

      const sourceParam = url.searchParams.get('source') || '';
      let sourceId;
      let uploadPath;
      let fileName;

      const cached = sourceParam && sourceUploads.get(sourceParam);
      if (cached && fs.existsSync(cached.uploadPath)) {
        sourceId = sourceParam;
        uploadPath = cached.uploadPath;
        fileName = cached.name;
        await new Promise<void>((done) => {
          req.on('data', () => {  });
          req.on('end', () => done());
          req.on('error', () => done());
        });
      } else {
        const rawName = (req.headers['x-filename'] as string) || 'model.glb';
        let decodedName;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch (e) {
          decodedName = rawName;
        }
        fileName = sanitizeFileName(decodedName);
        if (!MODEL_EXT.test(fileName)) {
          sendJSON(res, 400, { error: `Expected one of: ${MODEL_EXT_WORDS}` });
          return;
        }

        const packDir = packDirOf(sourceParam);
        let srcDir;
        if (packDir) {
          sourceId = sourceParam;
          srcDir = packDir;
        } else {
          sourceId = randomUUID();
          srcDir = path.join(UPLOADS_DIR, sourceId);
          await fsp.mkdir(srcDir, { recursive: true });
        }
        uploadPath = path.join(srcDir, fileName);
        let received;
        beginWrite(uploadWrites, sourceId);
        try {
          received = await streamBodyToFile(req, uploadPath);
        } catch (e: any) {
          if (!packDir) await fsp.rm(srcDir, { recursive: true, force: true });
          sendJSON(res, e.message === 'File too large' ? 413 : 400, { error: e.message });
          return;
        } finally {
          endWrite(uploadWrites, sourceId);
        }
        if (!received) {
          if (!packDir) await fsp.rm(srcDir, { recursive: true, force: true });
          if (sourceParam) {
            sendJSON(res, 410, { error: 'source_expired' });
            return;
          }
          sendJSON(res, 400, { error: 'Empty request body — no file received' });
          return;
        }

        sourceUploads.set(sourceId, { uploadPath, name: fileName, seq: ++uploadSeq });
        packBecameSource(sourceId);
        await purgeBeyondLimit();
      }

      const plan = planForSafe(platformId, langOf(url), engineId);
      const engineOpts = { ...FALLBACK_ENGINE_OPTS, ...(plan.engineOpts || {}), ...texModeChoice, ...webpQualityChoice };

      const onProgress = (e: Record<string, unknown>) => {
        if (jobId) sendSSE(jobId, e);
      };

      const runId = randomUUID();
      const outDir = path.join(RESULTS_DIR, sourceId, runId);
      await fsp.mkdir(outDir, { recursive: true });

      activeRuns.add(runKey(sourceId, runId));

      let result;
      try {
        result = await optimizeFile(uploadPath, {
          ...engineOpts,
          advancedFeatures,
          outDir,
          force: true,
          onProgress,
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

      let downloadUrl = null;
      if (result.file && result.file.written && result.file.dst) {
        const rel = path.relative(RESULTS_DIR, result.file.dst).split(path.sep).join('/');
        downloadUrl = '/api/download?f=' + encodeURIComponent(rel);
      }

      if (jobId) sendSSE(jobId, { type: 'done', status: result.status });

      sendJSON(res, 200, { result, explain, plan, advancedFeatures, downloadUrl, sourceId });
      return;
    }

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

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/download') {
      const f = url.searchParams.get('f');
      if (!f) {
        res.writeHead(400);
        res.end('f parameter required');
        return;
      }
      const filePath = safeJoin(RESULTS_DIR, f);
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Result file not found');
        return;
      }
      const size = await fsp.stat(filePath).then((s) => s.size).catch(() => null);
      if (size === null) {
        res.writeHead(404);
        res.end('Result file not found');
        return;
      }
      const name = chosenExportName(url.searchParams.get('name'), path.basename(filePath), '.glb');
      const asciiFallback = asciiHeaderName(name);
      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      res.on('close', () => stream.destroy());
      stream.on('error', () => { res.destroy(); });
      stream.pipe(res);
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
  const port = (server.address() as import('node:net').AddressInfo).port;
  const address = `http://${HOST}:${port}`;
  console.log(`Tanyra3D UI: ${address} (core v${VERSION})`);

  if (typeof process.send === 'function') process.send({ type: 'listening', port, address });

  if (process.env.TANYRA_NO_BROWSER === '1') return;

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
