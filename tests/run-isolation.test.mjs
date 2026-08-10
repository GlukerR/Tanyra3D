// tests/run-isolation.test.mjs — второй прогон не затирает первый.
//
// Ревью 2026-08-10 (P1.3): результат каждого исходника лежал в одной папке
// `results/<sourceId>/`, и повторный прогон писал туда же. Отсюда три беды:
// два параллельных запроса по одной модели писали в один файл; ссылка из первого
// ответа позже отдавала результат ВТОРОГО — молча и с виду правдоподобно; сравнить
// два варианта сжатия одной модели было нельзя.
//
// Проверяется поведение на живом сервере: одна и та же модель прогоняется дважды с
// разными настройками, и обе ссылки обязаны остаться рабочими и вести к своим файлам.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(ROOT, 'fixtures', 'models', 'BoomBox.glb');

let child;
let port;
let dataDir;

function request(opts, body) {
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

async function optimize(bytes, name, query) {
  const r = await request({
    method: 'POST',
    path: `/api/optimize?${query}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      'Content-Length': bytes.length,
    },
  }, bytes);
  expect(r.status, r.buf.toString().slice(0, 300)).toBe(200);
  return JSON.parse(r.buf.toString());
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-isolation-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TANYRA_NO_BROWSER: '1', TANYRA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
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
}, 130_000);

afterAll(() => {
  if (child && !child.killed) child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* временная папка */ }
});

describe('прогоны одной модели изолированы', () => {
  it('второй прогон не отбирает ссылку у первого', async () => {
    const bytes = fs.readFileSync(MODEL);

    // Первый прогон — без сжатия геометрии.
    const first = await optimize(bytes, 'BoomBox.glb', 'platform=&lang=ru');
    expect(first.downloadUrl, 'первый прогон не дал ссылки').toBeTruthy();
    const sourceId = first.sourceId;

    const before = await request({ method: 'GET', path: first.downloadUrl });
    expect(before.status).toBe(200);
    const firstBytes = before.buf;
    expect(firstBytes.length).toBeGreaterThan(0);

    // Второй прогон ТОЙ ЖЕ модели, с другими настройками. sourceId передаётся —
    // именно этот путь раньше и писал поверх.
    const second = await optimize(bytes, 'BoomBox.glb',
      `platform=&lang=ru&source=${encodeURIComponent(sourceId)}&features=quantize`);
    expect(second.sourceId).toBe(sourceId);
    expect(second.downloadUrl).toBeTruthy();

    // Главное: ссылки разные. Одинаковые означали бы, что файл один на двоих.
    expect(second.downloadUrl, 'обе ссылки ведут в одно место — прогоны не изолированы')
      .not.toBe(first.downloadUrl);

    // И первая по-прежнему отдаёт СВОЙ файл, а не результат второго прогона.
    const after = await request({ method: 'GET', path: first.downloadUrl });
    expect(after.status, 'первая ссылка перестала работать').toBe(200);
    expect(after.buf.equals(firstBytes), 'по первой ссылке приехал результат второго прогона').toBe(true);

    const secondFile = await request({ method: 'GET', path: second.downloadUrl });
    expect(secondFile.status).toBe(200);
    expect(secondFile.buf.length).toBeGreaterThan(0);
  }, 180_000);

  it('прогоны копятся не бесконечно — старые стираются', async () => {
    const bytes = fs.readFileSync(MODEL);
    const first = await optimize(bytes, 'BoomBox.glb', 'platform=&lang=ru');
    const sourceId = first.sourceId;

    const urls = [first.downloadUrl];
    for (let i = 0; i < 4; i++) {
      const r = await optimize(bytes, 'BoomBox.glb',
        `platform=&lang=ru&source=${encodeURIComponent(sourceId)}`);
      urls.push(r.downloadUrl);
    }

    // Свежая ссылка обязана работать…
    expect((await request({ method: 'GET', path: urls[urls.length - 1] })).status).toBe(200);
    // …а самая старая — уже нет: пять моделей на диске держать незачем.
    // Честный отказ лучше молчаливой подмены, ради которой всё и затевалось.
    expect((await request({ method: 'GET', path: urls[0] })).status).toBe(404);
  }, 300_000);
});
