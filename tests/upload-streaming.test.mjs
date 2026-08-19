// tests/upload-streaming.test.mjs — модель приезжает на диск потоком, а не через память.
//
// Повод. До 2026-08-19 тело запроса собиралось в массив кусков и склеивалось
// `Buffer.concat`: в момент склейки живы и куски, и результат, поэтому на гигабайтном
// файле пик памяти выходил заметно выше гигабайта. Замер на 300 МБ (одинаковые условия,
// два сервера по очереди): прирост 1197 МБ и 54,5 с против 600 МБ и 3,1 с после правки.
//
// Проверки поднимают НАСТОЯЩИЙ сервер — тот же приём, что в `server-local-only`. Память
// тестом не меряется: цифра зависит от машины и сборщика мусора и краснела бы на занятом
// прогоне (этот урок в наборе уже оплачен — см. `flat-textures`, сторож считает вызовы,
// а не секунды). Проверяется ПОВЕДЕНИЕ на границе: отказ по размеру приходит кодом, а
// обрывок не остаётся лежать в рабочей папке.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Предел приёма на время проверок — маленький. Гигабайт через сокет не прогнать, а
// поведение на границе проверить надо.
const LIMIT = 64 * 1024;

let child;
let port;
let dataDir;

/** POST с телом, отданным по кускам. */
function upload(body, { name = 'probe.glb', path: url = '/api/inspect', headers = {} } = {}) {
  // Отказа нет намеренно: обрыв соединения — законный исход отказа по размеру, и он
  // разрешается через resolve со статусом 0. Отдельная ветка отказа промиса заставила бы
  // каждую проверку ловить исключение вместо чтения статуса.
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
      // Сервер вправе оборвать соединение, отказав по размеру: ответ мог не долететь.
      // Это законный исход, а не провал проверки.
      resolve({ status: 0, body: '', aborted: e.code || String(e) });
    });
    if (body && body.length) {
      // Кусками, а не одним write: приём обязан считать размер по ходу, а не по
      // заголовку — заголовку верить нельзя, его пишет клиент.
      for (let i = 0; i < body.length; i += 8192) req.write(body.subarray(i, i + 8192));
    }
    req.end();
  });
}

/** Сколько папок исходников лежит в рабочем каталоге сервера. */
function uploadDirs() {
  const dir = path.join(dataDir, 'uploads');
  try { return fs.readdirSync(dir); } catch { return []; }
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
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* временная папка */ }
});

describe('приём модели идёт потоком на диск', () => {
  it('тело сверх предела отвергается, и обрывок не остаётся на диске', async () => {
    const before = uploadDirs().length;
    const res = await upload(Buffer.alloc(LIMIT * 3, 7));
    // 413 либо обрыв соединения — оба означают отказ. Чего быть НЕ должно: 200 и
    // молча принятый файл.
    expect([0, 413].includes(res.status), `ожидался отказ, пришло ${res.status}: ${res.body}`).toBe(true);

    // Папка исходника заводится ДО приёма (файл течёт в неё), поэтому при отказе её
    // надо убрать. Иначе на каждой неудачной попытке в рабочем каталоге оставался бы
    // обрывок, который считается в занятое место и не убирается никогда.
    await new Promise((r) => setTimeout(r, 300)); // серверу дать дописать уборку
    expect(uploadDirs().length, 'после отказа осталась папка с обрывком').toBe(before);
  }, 60_000);

  it('заявленный размер сверх предела отвергается ДО приёма тела', async () => {
    // Иначе гигабайт сначала приедет по сети и ляжет на диск, и только потом
    // выяснится, что он не нужен.
    const res = await upload(Buffer.alloc(16, 1), {
      headers: { 'Content-Length': String(LIMIT * 10) },
    });
    expect([0, 413].includes(res.status), `ожидался отказ, пришло ${res.status}`).toBe(true);
  }, 60_000);

  it('пустое тело — понятный отказ, а не пустая папка исходника', async () => {
    const before = uploadDirs().length;
    const res = await upload(Buffer.alloc(0));
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(uploadDirs().length, 'пустой запрос оставил папку').toBe(before);
  }, 60_000);

  it('нормальный файл принимается и доезжает до разбора', async () => {
    // Минимальный валидный GLB: заголовок + JSON-кусок. Разбор его прочтёт, значит
    // путь «поток → диск → инспекция» пройден целиком.
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
    // `readBody` собирает тело целиком. Для JSON это законно (килобайты), для модели —
    // ровно тот дефект, ради которого всё переписано.
    const uploads = [...SERVER.matchAll(/streamBodyToFile\(req,/g)].length;
    expect(uploads, 'путей потоковой загрузки меньше двух: /api/inspect и /api/optimize').toBeGreaterThanOrEqual(2);

    // И ни один из них не должен вернуться к буферу: ищем readBody рядом со словом
    // uploadPath — так выглядело бы возвращение старого приёма.
    const bad = /readBody\([^)]*\)[\s\S]{0,400}?uploadPath\s*=/.test(SERVER);
    expect(bad, 'загрузка модели снова читает тело в память').toBe(false);
  });

  it('у чтения в память свой маленький предел, а не общий гигабайт', () => {
    expect(/function readBody\([^)]*max = MAX_JSON_BODY/.test(SERVER),
      'readBody снова принимает гигабайт: любой запрос с чужим Content-Type займёт память').toBe(true);
  });

  it('поток уважает противодавление', () => {
    // Без pause/resume куски копятся внутри потока записи на медленном диске — то же
    // самое переполнение памяти, только этажом ниже.
    const body = SERVER.slice(SERVER.indexOf('function streamBodyToFile'), SERVER.indexOf('function streamBodyToFile') + 2500);
    expect(/req\.pause\(\)/.test(body) && /req\.resume\(\)/.test(body),
      'приём не тормозит источник, когда диск не успевает').toBe(true);
  });
});
