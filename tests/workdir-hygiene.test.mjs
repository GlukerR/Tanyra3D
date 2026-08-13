// tests/workdir-hygiene.test.mjs — рабочая папка не растёт бесконечно.
//
// Александр, 2026-08-13: «я не хочу что бы через месяц работы пользователь удивлялся
// когда у него 200+гб разных версий оптимизированных моделей лежали где-то в одной
// груде. Это совершенно неприемлемо».
//
// Уборка по СЧЁТУ была и раньше (12 исходников, 3 прогона на каждый), но про объём она
// ничего не знает: двенадцать исходников — это двенадцать неизвестно каких моделей.
// Здесь проверяется потолок по объёму и то, что человеку есть чем убрать папку руками.
//
// Потолок задаётся переменной TANYRA_WORK_LIMIT_BYTES — восемь гигабайт в тесте не
// наберёшь, а код, который стирает файлы с чужого диска, обязан проверяться.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelPath } from './helpers/model-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Та же модель, что в run-isolation: она коммитится в git и есть на чистом клоне.
const MODEL_NAME = 'Dirty Cube 01.glb';
const MODEL = modelPath(MODEL_NAME);

// Потолок ниже одной модели с прогоном — иначе для превышения пришлось бы грузить
// десятки файлов. Самый свежий исходник не стирается никогда, поэтому такой потолок
// не ломает работу: он лишь означает, что предыдущие уходят сразу.
const LIMIT = 1024;

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

const json = async (opts) => JSON.parse((await request(opts)).buf.toString());

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-hygiene-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      TANYRA_NO_BROWSER: '1',
      TANYRA_DATA_DIR: dataDir,
      TANYRA_WORK_LIMIT_BYTES: String(LIMIT),
    },
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

describe('рабочая папка: сколько занято', () => {
  it('сервер называет папку, занятое место и потолок', async () => {
    const info = await json({ method: 'GET', path: '/api/workdir' });
    expect(info.path).toBe(dataDir);
    expect(info.limit).toBe(LIMIT);
    expect(typeof info.bytes).toBe('number');
  });

  it('занятое место — не выдумка: после сборки оно больше нуля', async () => {
    await optimize(fs.readFileSync(MODEL), MODEL_NAME, 'platform=&lang=ru');
    const info = await json({ method: 'GET', path: '/api/workdir' });
    expect(info.bytes, 'модель на диске есть, а занятое место нулевое').toBeGreaterThan(0);
  });
});

describe('рабочая папка: потолок по объёму', () => {
  it('старые исходники уходят, свежий остаётся', async () => {
    const bytes = fs.readFileSync(MODEL);
    // Три РАЗНЫХ исходника (каждый раз без source= — значит новая загрузка).
    const first = await optimize(bytes, MODEL_NAME, 'platform=&lang=ru');
    await optimize(bytes, MODEL_NAME, 'platform=&lang=ru');
    const last = await optimize(bytes, MODEL_NAME, 'platform=&lang=ru');

    // Свежий обязан работать: потолок — это уборка, а не обрыв работы. Одна модель
    // сама по себе тяжелее потолка, и стереть её значило бы оставить человека ни с чем.
    const alive = await request({ method: 'GET', path: last.downloadUrl });
    expect(alive.status, 'потолок стёр модель, с которой человек работает').toBe(200);

    // А самый старый — уйти. Иначе потолка нет.
    const gone = await request({ method: 'GET', path: first.downloadUrl });
    expect(gone.status, 'при превышении потолка старые сборки остались на диске').not.toBe(200);
  }, 180_000);
});

describe('рабочая папка: уборка руками', () => {
  it('«Очистить» опустошает папку', async () => {
    await optimize(fs.readFileSync(MODEL), MODEL_NAME, 'platform=&lang=ru');
    const after = await json({ method: 'DELETE', path: '/api/workdir' });
    expect(after.bytes, 'после очистки в папке что-то осталось').toBe(0);

    const again = await json({ method: 'GET', path: '/api/workdir' });
    expect(again.bytes).toBe(0);
  }, 180_000);
});

describe('показать папку в проводнике', () => {
  // Успешный вызов открыл бы окно проводника прямо во время прогона тестов, поэтому
  // проверяется отказ. Он же и есть суть входа: адрес приходит НЕ от клиента, клиент
  // выбирает из известных серверу папок по имени.
  it('чужое имя папки не открывается', async () => {
    const r = await request({ method: 'POST', path: '/api/open?what=C:%5CWindows' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.buf.toString()).error).toBe('unknown_dir');
  });

  it('без имени тоже отказ', async () => {
    const r = await request({ method: 'POST', path: '/api/open' });
    expect(r.status).toBe(400);
  });
});
