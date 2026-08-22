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


describe('уборка не трогает то, что делается прямо сейчас', () => {
  // ЗАМЕР 2026-08-22, два исхода, и оба плохие. «Очистить», нажатая ПОСРЕДИ сборки,
  // убивала её сообщением «ENOENT ... \\results\\7a24…\\b8d2…\\probe.glb» — путь из двух
  // UUID вместо причины. Нажатая СРАЗУ ПОСЛЕ — оставляла ответ «готово, файл записан»
  // при стёртом файле, и ссылка отвечала 404.
  //
  // Работы две, и обе надо щадить: ПРИЁМ файла (на границе в сто мегабайт это заметные
  // секунды) и ПРОГОН. Первую проверяем здесь — у неё темп задаёт сам тест, поэтому
  // гонки нет по построению. Вторую держит тот же список занятого (activeRuns), и её
  // проверяет живой замер, а не этот файл: воспроизвести её без гонки нечем.
  //
  // Второй исход (ссылка на убранный файл) чинится в интерфейсе — он обязан сверить
  // ссылку, а не предлагать её вслепую. Сторож там же: tests/architecture/per-model-state.

  /** Отправить модель, растянув отправку, и вклиниться в середину чужим запросом. */
  function uploadSlowly(bytes, name, onMiddle) {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, path: '/api/inspect', method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-filename': encodeURIComponent(name),
          'Content-Length': bytes.length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      // Половину тела отдаём сразу, потом даём чужому запросу отработать, потом остаток.
      const half = Math.floor(bytes.length / 2);
      r.write(bytes.subarray(0, half));
      setTimeout(async () => {
        await onMiddle();
        r.write(bytes.subarray(half));
        r.end();
      }, 150);
    });
  }

  it('очистка посреди приёма не отбирает файл у того, кто его шлёт', async () => {
    const bytes = fs.readFileSync(MODEL);
    let cleared = null;
    const answer = await uploadSlowly(bytes, MODEL_NAME, async () => {
      cleared = await json({ method: 'DELETE', path: '/api/workdir' });
    });

    expect(cleared, 'очистка не выполнилась').toBeTruthy();
    expect(cleared.kept, 'сервер не сказал, что оставил занятое приёмом').toBeGreaterThan(0);
    expect(answer.status, `приём оборвался очисткой: ${answer.body.slice(0, 200)}`).toBe(200);

    // И модель после этого читается — то есть на диск лёг целый файл, а не половина.
    const data = JSON.parse(answer.body);
    expect(data.sourceId, 'исходник не зарегистрирован').toBeTruthy();
    expect(data.metrics || data.metadata, 'файл принят, но не разобрался — значит доехал обрывок').toBeTruthy();
  }, 180_000);

  it('всё, что НЕ занято, при этом убрано', async () => {
    // Исключение узкое: щадится только то, что делается прямо сейчас. Иначе «очистить»
    // перестало бы значить «очистить».
    const before = await optimize(fs.readFileSync(MODEL), MODEL_NAME, 'platform=&lang=ru');
    const cleared = await json({ method: 'DELETE', path: '/api/workdir' });
    expect(cleared.kept, 'ничего не делалось, а что-то оставлено').toBe(0);
    const gone = await request({ method: 'GET', path: before.downloadUrl });
    expect(gone.status, 'после очистки старый результат остался на диске').not.toBe(200);
  }, 180_000);
});

describe('интерфейсу есть чем спросить, на месте ли файл', () => {
  // Без этого проверить наличие файла можно только выкачав его целиком — то есть сто
  // мегабайт ради ответа «да». Скачивание идёт через <a download>, который об отказе не
  // сообщает никак, поэтому спрашивать приходится заранее.
  it('HEAD отвечает теми же заголовками и без тела', async () => {
    const run = await optimize(fs.readFileSync(MODEL), MODEL_NAME, 'platform=&lang=ru');
    const head = await request({ method: 'HEAD', path: run.downloadUrl });
    expect(head.status, 'HEAD по живой ссылке не отвечает 200').toBe(200);
    expect(head.buf.length, 'на HEAD пришло тело — значит файл всё-таки выкачан').toBe(0);
  }, 180_000);

  it('на убранный файл HEAD отвечает отказом, а не молчанием', async () => {
    const run = await optimize(fs.readFileSync(MODEL), MODEL_NAME, 'platform=&lang=ru');
    await json({ method: 'DELETE', path: '/api/workdir' });
    const head = await request({ method: 'HEAD', path: run.downloadUrl });
    expect(head.status, 'HEAD по стёртому файлу отвечает «всё в порядке»').not.toBe(200);
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
