// tests/import-formats.test.mjs — что приложение принимает на вход, и почему без сети.
//
// Слово Александра 2026-08-19: «нужно чтобы всё работало в приложении без интернета».
// Это ограничение на весь ввоз форматов, а не пожелание: программа ставится и работает
// на машине, у которой сети может не быть вовсе.
//
// Первый шаг ввоза — `.gltf` наравне с `.glb`, и это ПОЧИНКА КРУГА, а не новая
// возможность. Окно выгрузки само отдаёт «самодостаточный .gltf со встроенными данными»,
// движок читает его с первого дня (командная строка принимала всегда) — не принимал
// только сервер. Свой же выход нельзя было подать себе на вход.
//
// Проверки поднимают настоящий сервер: спор идёт про его поведение, а не про текст кода.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let port;
let dataDir;

/** Самодостаточный .gltf: JSON со встроенным буфером. Ровно то, что отдаёт наша выгрузка. */
function selfContainedGltf() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(pos.buffer);
  return Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'tanyra3d test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
  }), 'utf8');
}

function upload(body, name) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/inspect',
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(name),
        'Content-Type': 'application/octet-stream',
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end(body);
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-formats-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TANYRA_NO_BROWSER: '1', TANYRA_DATA_DIR: dataDir },
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

describe('что сервер принимает на вход', () => {
  it('самодостаточный .gltf принимается и разбирается', async () => {
    const res = await upload(selfContainedGltf(), 'круг.gltf');
    expect(res.status, res.body).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.sourceId, 'сервер не завёл исходник').toBeTruthy();
    // Разбор состоялся, а не «принял и промолчал».
    expect(data.metadata || data.metrics, 'файл принят, но не разобран').toBeTruthy();
  }, 60_000);

  it('.glb по-прежнему принимается', async () => {
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] }), 'utf8');
    const pad = (4 - (json.length % 4)) % 4;
    const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
    const glb = Buffer.alloc(20 + chunk.length);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(chunk.length, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    chunk.copy(glb, 20);
    const res = await upload(glb, 'обычная.glb');
    expect(res.status, res.body).toBe(200);
  }, 60_000);

  it('чужой формат отвергается ПОНЯТНО, а не молча', async () => {
    // OBJ придёт позже (см. .claude/ПЛАН_импорт-форматов_2026-08-19.md). Пока его нет —
    // отказ обязан называть, что принимается, иначе человек не поймёт, что делать.
    const res = await upload(Buffer.from('v 0 0 0\n', 'utf8'), 'куб.obj');
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/gltf/i);
    expect(res.body).toMatch(/glb/i);
  }, 60_000);
});

describe('пачка: .gltf со своими файлами рядом', () => {
  /** Соседний файл пачки. Без `source` — заводит пачку и возвращает её идентификатор. */
  function asset(name, body, source = '') {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/asset' + (source ? `?source=${encodeURIComponent(source)}` : ''),
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e) }));
      req.end(body);
    });
  }

  function inspectInPack(source, name, body) {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `/api/inspect?source=${encodeURIComponent(source)}`,
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e) }));
      req.end(body);
    });
  }

  it('модель находит свой .bin и текстуру из подпапки', async () => {
    // Это и есть смысл пачки: `.gltf` ссылается на соседей относительными адресами,
    // и без них он либо не читается вовсе, либо читается без текстур — молча.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bin = Buffer.from(pos.buffer);
    // 1×1 PNG — достаточно, чтобы движок увидел картинку и посчитал её.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000d4944415478da63f8cfc000000301010018dd8db0', 'hex',
    );

    const first = await asset('model.bin', bin);
    expect(first.status, first.body).toBe(200);
    const source = JSON.parse(first.body).sourceId;
    expect(source, 'пачка не заведена').toBeTruthy();

    expect((await asset('textures/wood.png', png, source)).status).toBe(200);

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: 'textures/wood.png' }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
      buffers: [{ byteLength: bin.length, uri: 'model.bin' }],
    };
    const res = await inspectInPack(source, 'модель.gltf', Buffer.from(JSON.stringify(gltf)));
    expect(res.status, res.body).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.sourceId, 'пачка потеряна при разборе').toBe(source);
    // Текстура сосчитана — значит соседний файл действительно нашёлся на диске.
    const textures = (data.metrics && data.metrics.textures) ?? (data.metadata && data.metadata.textures);
    expect(textures, `текстура из подпапки не найдена: ${res.body.slice(0, 200)}`).toBe(1);
  }, 90_000);

  it('выход за папку пачки — ОТКАЗ, а не тихое переименование', async () => {
    // Имена соседей приходят от клиента, поэтому `..` в них — вопрос времени, даже без
    // злого умысла: достаточно бросить папку, лежащую выше модели.
    //
    // Первая редакция просто выбрасывала `..`: наружу ничего не попадало, но файл тихо
    // ложился внутрь пачки под другим именем и мог перезаписать чужой — а ответ был
    // «принято». Молча сделать не то, о чём просили, нельзя.
    //
    // Обратный слэш строим кодом символа: через shell он теряется, и проба начинает
    // проверять не то, что написано (проверено на себе 2026-08-19).
    const BS = String.fromCharCode(92);
    const start = await asset('model.bin', Buffer.from('x'));
    const source = JSON.parse(start.body).sourceId;

    const bad = [
      '../../побег.txt',
      '/абсолютный.txt',
      '..',
      `..${BS}..${BS}побег.txt`,
      `C:${BS}винда.txt`,
      `${BS}${BS}сервер${BS}шара.txt`,
      `ok${BS}..${BS}..${BS}снаружи.txt`,
    ];
    for (const name of bad) {
      const res = await asset(name, Buffer.from('вон'), source);
      expect(res.status, `путь ${JSON.stringify(name)} принят вместо отказа`).toBe(400);
    }

    // И законный путь с подпапкой при этом обязан работать — иначе мы «починили»
    // безопасность, сломав саму возможность.
    expect((await asset('textures/дерево.png', Buffer.from('png'), source)).status).toBe(200);
  }, 90_000);
});

describe('список принимаемых форматов живёт в ОДНОМ месте', () => {
  const SERVER = readSource('server');
  const APP = readSource('ui/app');

  it('сервер не держит вторую копию списка расширений', () => {
    // До 2026-08-19 проверка `/\.glb$/i` стояла двумя копиями — в приёме на разбор и в
    // приёме на сборку. Две копии одного списка расходятся при первом же добавлении
    // формата, и расходятся молча: один путь принимает файл, другой отвергает.
    expect(/const MODEL_EXT = /.test(SERVER), 'общего списка расширений нет').toBe(true);
    // Стережём именно ПРОВЕРКУ ИМЕНИ ВХОДЯЩЕГО файла, а не любое упоминание расширения:
    // переименование выхода `.glb → .gltf` в выгрузке — законное и к приёму отношения
    // не имеет. Первая редакция сторожа этого не различала и краснела на объявлении
    // самого MODEL_EXT.
    const inline = [...SERVER.matchAll(/\/[^/\n]*glb[^/\n]*\/i?\.test\(\s*(fileName|decodedName|rawName)/g)];
    expect(
      inline.map((m) => m[0]),
      'проверка входящего имени снова зашита по месту, а не взята из MODEL_EXT',
    ).toEqual([]);
  });

  it('интерфейс и сервер принимают одно и то же', () => {
    // Разойдутся — человек увидит файл в списке, а сборка его отвергнет.
    const ui = APP.match(/files\.filter\(\(f\) => (\/[^/]+\/i)\.test\(f\.name\)\)/);
    expect(ui, 'фильтр форматов в интерфейсе не найден').toBeTruthy();
    const server = SERVER.match(/const MODEL_EXT = (\/[^/]+\/i)/);
    expect(server, 'фильтр форматов на сервере не найден').toBeTruthy();
    expect(ui[1], `интерфейс: ${ui[1]}, сервер: ${server[1]}`).toBe(server[1]);
  });

  it('поле выбора файла предлагает то же, что принимает код', () => {
    const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const accept = html.match(/id="file-input"[^>]*accept="([^"]+)"/);
    expect(accept, 'у поля выбора файла нет accept').toBeTruthy();
    for (const ext of ['glb', 'gltf']) {
      expect(accept[1].includes(ext), `диалог не предлагает .${ext}, хотя код его принимает`).toBe(true);
    }
  });
});

describe('без интернета (слово Александра 2026-08-19)', () => {
  const APP = readSource('ui/app');
  const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const VIEWER = readSource('ui/viewer/viewer');

  it('ни один внешний адрес не зашит в интерфейс', () => {
    // Проверено живьём 2026-08-19: полный проход «бросить .gltf → собрать» дал 36
    // запросов, все на свой порт, наружу ни одного. Здесь сторож этого факта.
    //
    // Ищем только СХЕМУ с хостом: относительные пути и адреса документации в
    // комментариях не в счёт — комментарии вырезаются.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
    for (const [name, src] of [['ui/app', strip(APP)], ['ui/viewer/viewer', strip(VIEWER)]]) {
      const external = [...src.matchAll(/["'`](https?:\/\/[^"'`]+)/g)].map((m) => m[1]);
      expect(external, `${name} ходит наружу: ${external.join(', ')}`).toEqual([]);
    }
  });

  it('разметка не тянет ни шрифтов, ни скриптов из сети', () => {
    const external = [...HTML.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(external, `разметка ходит наружу: ${external.join(', ')}`).toEqual([]);
  });

  it('карта модулей ведёт только на свой сервер', () => {
    // three.js и его загрузчики раздаются из node_modules по /vendor/three/… Появится
    // здесь адрес CDN — приложение перестанет открываться без сети, и заметит это
    // человек без интернета, а не мы.
    const map = HTML.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(map, 'карты модулей нет').toBeTruthy();
    const imports = JSON.parse(map[1]).imports;
    for (const [name, url] of Object.entries(imports)) {
      expect(/^\//.test(url), `«${name}» ведёт не на свой сервер: ${url}`).toBe(true);
    }
  });
});
