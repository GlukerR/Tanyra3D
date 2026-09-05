import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LIMIT = 64 * 1024;

let child;
let port;
let dataDir;

function upload(body, { name = 'probe.glb', path: url = '/api/inspect', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(name),
        'Content-Type': 'application/octet-stream',
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', (e) => {
      resolve({ status: 0, body: '', aborted: e.code || String(e) });
    });
    if (body && body.length) {
      for (let i = 0; i < body.length; i += 8192) req.write(body.subarray(i, i + 8192));
    }
    req.end();
  });
}

function uploadDirs() {
  const dir = path.join(dataDir, 'uploads');
  try { return fs.readdirSync(dir); } catch { return []; }
}

async function leftoverAfter(run, waitMs = 15_000) {
  const before = new Set(uploadDirs());
  const res = await run();
  const deadline = Date.now() + waitMs;
  let extra = uploadDirs().filter((d) => !before.has(d));
  while (extra.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    extra = uploadDirs().filter((d) => !before.has(d));
  }
  return { res, extra };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-stream-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      TANYRA_NO_BROWSER: '1',
      TANYRA_DATA_DIR: dataDir,
      TANYRA_MAX_BODY_BYTES: String(LIMIT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const STARTUP_MS = 120_000;
  port = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => reject(new Error(`сервер не отозвался за ${STARTUP_MS / 1000} с.\nstdout:\n${out}\nstderr:\n${err}`)),
      STARTUP_MS,
    );
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = out.match(/http:\/\/[^:\s]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`сервер вышел с кодом ${code}`)); });
  });
}, 130_000);

afterAll(() => {
  if (child && !child.killed) child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {  }
});

describe('приём модели идёт потоком на диск', () => {
  it('тело сверх предела отвергается, и обрывок не остаётся на диске', async () => {
    const { res, extra } = await leftoverAfter(() => upload(Buffer.alloc(LIMIT * 3, 7)));
    expect([0, 413].includes(res.status), `ожидался отказ, пришло ${res.status}: ${res.body}`).toBe(true);
    expect(extra, `после отказа осталась папка: ${extra.join(', ')}`).toEqual([]);
  }, 60_000);

  it('заявленный размер сверх предела отвергается ДО приёма тела', async () => {
    const res = await upload(Buffer.alloc(16, 1), {
      headers: { 'Content-Length': String(LIMIT * 10) },
    });
    expect([0, 413].includes(res.status), `ожидался отказ, пришло ${res.status}`).toBe(true);
  }, 60_000);

  it('пустое тело — понятный отказ, а не пустая папка исходника', async () => {
    const { res, extra } = await leftoverAfter(() => upload(Buffer.alloc(0)));
    expect(res.status).toBe(400);
    expect(extra, `пустой запрос оставил папку: ${extra.join(', ')}`).toEqual([]);
  }, 60_000);

  it('нормальный файл принимается и доезжает до разбора', async () => {
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] }), 'utf8');
    const pad = (4 - (json.length % 4)) % 4;
    const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
    const glb = Buffer.alloc(12 + 8 + chunk.length);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(chunk.length, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    chunk.copy(glb, 20);

    const res = await upload(glb, { name: 'tiny.glb' });
    expect(res.status, res.body).toBe(200);
    expect(JSON.parse(res.body).sourceId, 'сервер не вернул идентификатор исходника').toBeTruthy();
  }, 60_000);
});

describe('память не берёт на себя то, что должно течь на диск', () => {
  const SERVER = readSource('server');

  it('модель не читается в память ни на одном из двух путей загрузки', () => {
    const uploads = [...SERVER.matchAll(/streamBodyToFile\(req,/g)].length;
    expect(uploads, 'путей потоковой загрузки меньше двух: /api/inspect и /api/optimize').toBeGreaterThanOrEqual(2);

    const bad = /readBody\([^)]*\)[\s\S]{0,400}?uploadPath\s*=/.test(SERVER);
    expect(bad, 'загрузка модели снова читает тело в память').toBe(false);
  });

  it('у чтения в память свой маленький предел, а не общий гигабайт', () => {
    expect(/function readBody\([^)]*max = MAX_JSON_BODY/.test(SERVER),
      'readBody снова принимает гигабайт: любой запрос с чужим Content-Type займёт память').toBe(true);
  });

  it('поток уважает противодавление', () => {
    const body = SERVER.slice(SERVER.indexOf('function streamBodyToFile'), SERVER.indexOf('function streamBodyToFile') + 2500);
    expect(/req\.pause\(\)/.test(body) && /req\.resume\(\)/.test(body),
      'приём не тормозит источник, когда диск не успевает').toBe(true);
  });
});
