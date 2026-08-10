// tests/server-local-only.test.mjs — сервер отвечает только своему окну.
//
// Ревью 2026-08-10 (P0.1): `server.listen(PORT)` без хоста в Node значит «unspecified
// address» — все сетевые карты машины. У API нет ни токена, ни пароля, поэтому любой
// в той же сети мог обратиться к нему напрямую. Плюс к привязке нужна проверка Host:
// от DNS rebinding адрес сокета не спасает — запрос приходит на 127.0.0.1 изнутри
// браузера человека, и отличить его можно только по заголовку.
//
// Проверки поднимают НАСТОЯЩИЙ сервер (server.mjs как дочерний процесс на свободном
// порту) и стучатся в него настоящими запросами. Разбор заголовков проверяется отдельно
// на экспортированной функции — там перебор случаев дешевле.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let port;
let dataDir;

// Запрос с произвольным Host — http.request позволяет подменить заголовок, не трогая
// адрес соединения. Ровно то, что делает DNS rebinding.
function ask(options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: options.path || '/api/platforms', method: 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-local-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TANYRA_NO_BROWSER: '1', TANYRA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Запас большой намеренно: в одиночку сервер поднимается за пару секунд, но в полном
  // прогоне рядом работают семь других потоков, и тот же старт занимает десятки секунд.
  // Тридцати не хватило — набор падал не от дефекта, а от занятой машины.
  const STARTUP_MS = 120_000;
  port = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    // Что сказал сервер — в текст отказа: иначе на голом «не отозвался» причину
    // пришлось бы искать заново.
    const timer = setTimeout(
      () => reject(new Error(`сервер не отозвался за ${STARTUP_MS / 1000} с.\nstdout:\n${out}\nstderr:\n${err}`)),
      STARTUP_MS,
    );
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.stdout.on('data', (c) => {
      out += c.toString();
      // адрес объявляется тем же именем, на котором сервер слушает
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

describe('сервер слушает только петлю', () => {
  it('на 127.0.0.1 отвечает', async () => {
    const r = await ask({ headers: { host: `127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
  });

  it('сокет не открыт на внешнем адресе машины', async () => {
    // Ищем настоящий адрес машины в локальной сети. Нет такого (нет сети) — проверять
    // нечего, и честнее пропустить, чем сделать вид, что проверили.
    const external = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return;

    const reached = await new Promise((resolve) => {
      const req = http.request({ host: external.address, port, path: '/api/platforms', timeout: 3000 },
        (res) => { res.resume(); resolve(`ответил ${res.statusCode}`); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
    expect(reached, `сервер доступен по адресу ${external.address}`).toBeNull();
  });

  it('чужой Host отвергается — это DNS rebinding', async () => {
    const r = await ask({ headers: { host: 'evil.example.com' } });
    expect(r.status).toBe(403);
  });

  it('чужой Origin отвергается', async () => {
    const r = await ask({ headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example.com' } });
    expect(r.status).toBe(403);
  });

  it('свой Origin проходит', async () => {
    const r = await ask({ headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } });
    expect(r.status).toBe(200);
  });

  it('отказ распространяется и на статику, а не только на /api/', async () => {
    const r = await ask({ path: '/', headers: { host: 'evil.example.com' } });
    expect(r.status).toBe(403);
  });
});

describe('разбор заголовков — на живом сервере', () => {
  // server.mjs здесь НЕ импортируется: модуль при импорте сам открывает порт и
  // (без TANYRA_NO_BROWSER) открывает браузер. Поэтому все случаи гоняем по HTTP.

  it('пропускает петлю во всех записях имени', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
      const r = await ask({ headers: { host: `${host}:${port}` } });
      expect(r.status, host).toBe(200);
    }
  });

  it('не обманывается похожим именем — то, что пропустил бы startsWith', async () => {
    for (const host of ['localhost.evil.com', 'evil.com', '127.0.0.1.evil.com', 'notlocalhost']) {
      const r = await ask({ headers: { host } });
      expect(r.status, host).toBe(403);
    }
  });

  it('Origin с userinfo не выдаёт себя за свой', async () => {
    const r = await ask({
      headers: { host: `localhost:${port}`, origin: 'http://localhost@evil.com' },
    });
    expect(r.status).toBe(403);
  });

  it('короткие и числовые записи петли — это петля, и они проходят', async () => {
    // 127.1, 0x7f000001 и 2130706433 — законные записи адреса 127.0.0.1, и разбор
    // через new URL() приводит их к нему сам. Сравнение строк такого не умеет: оно
    // отвергло бы человека, набравшего http://127.1:порт. Закреплено проверкой,
    // потому что «починка» через startsWith('127.0.0.1') выглядит правдоподобно.
    for (const host of ['127.1', '0x7f000001', '2130706433']) {
      const r = await ask({ headers: { host: `${host}:${port}` } });
      expect(r.status, host).toBe(200);
    }
  });

  it('0.0.0.0 петлёй не считается', async () => {
    const r = await ask({ headers: { host: `0.0.0.0:${port}` } });
    expect(r.status).toBe(403);
  });

  it('X-Forwarded-Host не подменяет настоящий Host', async () => {
    const r = await ask({ headers: { host: 'evil.example.com', 'x-forwarded-host': 'localhost' } });
    expect(r.status, 'заголовок от посредника принят за настоящий').toBe(403);
  });

  it('Origin: null отвергается — это не «origin отсутствует»', async () => {
    // Ревью 2026-08-10 (D4). Строку «null» браузер шлёт из непрозрачного источника:
    // страница в `<iframe sandbox>`, `data:`, локальный файл. Чужой сайт может открыть
    // такой iframe и стучаться к нам из него. Ответ он не прочитает, но записи
    // проходили — сжечь процессор и диск на чужой машине этого хватает.
    const r = await ask({ headers: { host: `127.0.0.1:${port}`, origin: 'null' } });
    expect(r.status).toBe(403);
  });

  it('запрос вовсе без Host отвергается', async () => {
    // HTTP/1.0 позволяет обойтись без Host; http.request его подставляет всегда,
    // поэтому пишем запрос в сокет руками.
    const net = await import('node:net');
    const answer = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET /api/platforms HTTP/1.0\r\n\r\n');
      });
      let buf = '';
      s.on('data', (c) => { buf += c.toString(); });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
      s.setTimeout(5000, () => { s.destroy(); reject(new Error('нет ответа')); });
    });
    expect(answer.split('\r\n')[0]).toMatch(/ 403 /);
  });
});
