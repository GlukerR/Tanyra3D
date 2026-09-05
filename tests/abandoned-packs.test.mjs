import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tinyGlb() {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] }),
    'utf8',
  );
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + chunk.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(chunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(glb, 20);
  return glb;
}

async function startServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TANYRA_NO_BROWSER: '1', TANYRA_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => reject(new Error(`сервер не отозвался.\nstdout:\n${out}\nstderr:\n${err}`)),
      120_000,
    );
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = out.match(/http:\/\/[^:\s]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`сервер вышел с кодом ${code}`)); });
  });
  return {
    port,
    dataDir,
    stop() {
      if (!child.killed) child.kill();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {  }
    },
  };
}

function request(port, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sendAsset(port, name, bytes, source) {
  const q = source ? `?source=${encodeURIComponent(source)}` : '';
  const r = await request(port, {
    method: 'POST',
    path: `/api/asset${q}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      'Content-Length': bytes.length,
    },
  }, bytes);
  expect(r.status, r.buf.toString().slice(0, 200)).toBe(200);
  return JSON.parse(r.buf.toString()).sourceId;
}

async function sendModel(port, name, bytes, source) {
  const q = source ? `?source=${encodeURIComponent(source)}` : '';
  const r = await request(port, {
    method: 'POST',
    path: `/api/inspect${q}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      'Content-Length': bytes.length,
    },
  }, bytes);
  return { status: r.status, data: r.status === 200 ? JSON.parse(r.buf.toString()) : null };
}

const uploadDirs = (dataDir) => {
  try { return fs.readdirSync(path.join(dataDir, 'uploads')); } catch { return []; }
};

const LIMIT = 256 * 1024;
const ASSET = Buffer.alloc(80 * 1024, 7);

let idle;
let patient;

beforeAll(async () => {
  [idle, patient] = await Promise.all([
    startServer({ TANYRA_PACK_IDLE_MS: '0', TANYRA_WORK_LIMIT_BYTES: String(LIMIT) }),
    startServer({ TANYRA_WORK_LIMIT_BYTES: String(LIMIT) }),
  ]);
}, 260_000);

afterAll(() => {
  if (idle) idle.stop();
  if (patient) patient.stop();
});

describe('пачка без модели не остаётся на диске навсегда', () => {
  it('брошенные пачки уходят, а модели человека остаются', async () => {
    const orphans = [];
    for (let i = 0; i < 5; i += 1) {
      orphans.push(await sendAsset(idle.port, `textures/big${i}.png`, ASSET));
    }
    expect(uploadDirs(idle.dataDir).length, 'пачки вообще не завелись').toBeGreaterThanOrEqual(5);

    const real = [];
    for (let i = 0; i < 3; i += 1) {
      const { status, data } = await sendModel(idle.port, `real${i}.glb`, tinyGlb());
      expect(status, 'модель не принялась').toBe(200);
      real.push(data.sourceId);
    }

    const left = uploadDirs(idle.dataDir);
    const orphansLeft = orphans.filter((id) => left.includes(id));
    const realLeft = real.filter((id) => left.includes(id));

    expect(orphansLeft, `брошенные пачки остались: ${orphansLeft.join(', ')}`).toEqual([]);
    expect(realLeft.length, 'уборка стёрла модели человека вместо мусора').toBe(3);

    const info = JSON.parse((await request(idle.port, { method: 'GET', path: '/api/workdir' })).buf.toString());
    expect(info.bytes, 'потолок объёма остался пробит').toBeLessThanOrEqual(LIMIT);
  }, 120_000);

  it('папка, которой нет ни в одном учёте, тоже убирается', async () => {
    const stray = path.join(idle.dataDir, 'uploads', '00000000-0000-4000-8000-00000000dead');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'junk.bin'), Buffer.alloc(1024, 3));

    await sendModel(idle.port, 'trigger.glb', tinyGlb());

    expect(fs.existsSync(stray), 'папка вне учёта осталась на диске').toBe(false);
  }, 120_000);
});

describe('пачка, которая ещё ждёт свою модель, неприкосновенна', () => {
  it('соседи доживают до модели и достаются ей', async () => {
    const packId = await sendAsset(patient.port, 'scene.bin', Buffer.alloc(64, 1));
    await sendAsset(patient.port, 'textures/wood.png', ASSET, packId);

    await sendModel(patient.port, 'other.glb', tinyGlb());

    const dir = path.join(patient.dataDir, 'uploads', packId);
    expect(fs.existsSync(dir), 'пачку убрали, пока она ждала свою модель').toBe(true);
    expect(fs.existsSync(path.join(dir, 'textures', 'wood.png')), 'сосед пропал из пачки').toBe(true);

    const { status, data } = await sendModel(patient.port, 'pack.glb', tinyGlb(), packId);
    expect(status, 'модель не приняли в её же пачку').toBe(200);
    expect(data.sourceId, 'модель завела новую папку вместо пачки').toBe(packId);
    expect(fs.existsSync(path.join(dir, 'pack.glb')), 'модель легла не в папку пачки').toBe(true);
  }, 120_000);
});
