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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  it('номер пачки тоже подставляется в путь — и тоже проверяется', async () => {
    // Вторая дверь той же комнаты, и я её сперва не заметил. Имя соседа проверялось
    // (см. выше), а НОМЕР ПАЧКИ брался на веру: `?source=../..` уводил папку за пределы
    // рабочей, и дальше уже неважно, насколько аккуратно считается имя внутри неё.
    //
    // У `DELETE /api/source/<id>` такой сторож стоял с самого начала — расхождение и
    // было дефектом. Найдено 2026-08-20 перечитыванием собственного коммита 7b33b56.
    const BS = String.fromCharCode(92);
    const bad = ['../../..', '..', `..${BS}..`, '/', 'C:', 'не-uuid'];
    for (const source of bad) {
      // Отказа тут нет и быть не должно: незнакомый номер означает НОВУЮ пачку.
      // Требование одно — не ходить по присланному пути.
      const res = await asset('сосед.bin', Buffer.from('x'), source);
      expect(res.status, `номер ${JSON.stringify(source)}: ${res.body}`).toBe(200);
      const got = JSON.parse(res.body).sourceId;
      expect(got, `сервер принял чужой номер ${JSON.stringify(source)} как свой`).not.toBe(source);
      expect(/^[0-9a-f-]{36}$/i.test(got), `выдан номер не своего вида: ${got}`).toBe(true);
    }
  }, 90_000);

  it('сборка находит соседей, даже если модель не инспектировали', async () => {
    // Пакетная сборка инспекцию ПРОПУСКАЕТ (пятьдесят разборов положили бы вкладку).
    // Значит на /api/optimize пачка приезжает так: соседи уже на сервере, модель — в теле
    // запроса, номер папки в адресе. Без этой ветки `.gltf` ложился в новую пустую папку
    // отдельно от своего `.bin` и не читался — причём именно в пакете, где смотреть
    // некому.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bin = Buffer.from(pos.buffer);
    const start = await asset('geo.bin', bin);
    const source = JSON.parse(start.body).sourceId;

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
      buffers: [{ byteLength: bin.length, uri: 'geo.bin' }],
    };

    const res = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `/api/optimize?platform=&engine=&job=pack-build&source=${encodeURIComponent(source)}`,
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent('пачка.gltf'), 'Content-Type': 'application/octet-stream' },
      }, (r) => {
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: text }));
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e) }));
      req.end(Buffer.from(JSON.stringify(gltf)));
    });

    expect(res.status, res.body).toBe(200);
    const data = JSON.parse(res.body);
    // Треугольник на месте — значит `.bin` нашёлся. Не нашёлся бы — разбор упал бы
    // на чтении буфера, а не отдал модель с нулём треугольников.
    const after = data.result && data.result.metrics && data.result.metrics.after;
    expect(after && after.triangles, `сборка не увидела .bin: ${res.body.slice(0, 300)}`).toBe(1);
  }, 120_000);
});

describe('вес пачки считается честно', () => {
  // Числа «до → после» — самое заметное место отчёта, и до 2026-08-20 оно врало на любой
  // пачке: весом считался только `.gltf`, то есть ОГЛАВЛЕНИЕ. Настоящая проверка в
  // браузере показала «8.9 КБ → 10.7 КБ, +20 %» там, где на самом деле было
  // «62.9 КБ → 10.7 КБ, −83 %»: рост вместо шестикратного уменьшения.
  const addon = path.join(ROOT, 'addons', 'gltf', 'index.mjs');

  it('вес .gltf включает соседей, а .glb остаётся собой', async () => {
    const { default: gltf } = await import(pathToFileURL(addon).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanyra-вес-'));
    try {
      const bin = Buffer.alloc(5000, 7);
      fs.mkdirSync(path.join(dir, 'textures'));
      fs.writeFileSync(path.join(dir, 'geo.bin'), bin);
      fs.writeFileSync(path.join(dir, 'textures', 'wood.png'), Buffer.alloc(3000, 3));
      const gltfJson = {
        asset: { version: '2.0' },
        buffers: [{ byteLength: bin.length, uri: 'geo.bin' }],
        // Один и тот же файл по двум ссылкам весит ОДИН раз, иначе общая карта у пяти
        // материалов раздула бы «до» впятеро.
        images: [{ uri: 'textures/wood.png' }, { uri: 'textures/wood.png' }],
      };
      const model = path.join(dir, 'model.gltf');
      fs.writeFileSync(model, JSON.stringify(gltfJson));
      const own = fs.statSync(model).size;

      expect(gltf.sourceBytes(model), 'соседи не сосчитаны либо сосчитаны дважды')
        .toBe(own + 5000 + 3000);

      // Встроенное (`data:`) уже лежит внутри файла — второй раз его считать нельзя.
      const inlineModel = path.join(dir, 'inline.gltf');
      fs.writeFileSync(inlineModel, JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAA' }],
      }));
      expect(gltf.sourceBytes(inlineModel)).toBe(fs.statSync(inlineModel).size);

      // `.glb` самодостаточен: у него вес — это размер файла, и лезть в папку незачем.
      const glb = path.join(dir, 'сам.glb');
      fs.writeFileSync(glb, Buffer.alloc(1234, 1));
      expect(gltf.sourceBytes(glb)).toBe(1234);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('отсутствующий файл назван по имени, а не спрятан за ENOENT', async () => {
    // Особо коварен файл-СИРОТА: картинка, которую не использует ни один материал.
    // Показу она не мешает (загрузчик за ней и не пойдёт), а разбору мешает — читаются
    // все. Человек получал «Inspection failed (500)» и не знал, что делать.
    const { default: gltf } = await import(pathToFileURL(addon).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanyra-обрыв-'));
    try {
      const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
      fs.writeFileSync(path.join(dir, 'geo.bin'), bin);
      const model = path.join(dir, 'обрыв.gltf');
      fs.writeFileSync(model, JSON.stringify({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
        buffers: [{ byteLength: bin.length, uri: 'geo.bin' }],
        // Ни один материал на неё не смотрит — и всё равно без неё файл не прочитать.
        images: [{ uri: 'textures/сирота.png' }],
      }));

      await expect(gltf.inspect(model)).rejects.toThrow(/сирота\.png/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
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
    const ui = APP.match(/const MODEL_RE = (\/[^/]+\/i)/);
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

describe('граница веса названа, а не подразумевается', () => {
  const APP = readSource('ui/app');

  it('сто мегабайт стоят в коде одним числом', () => {
    // Слово Александра 2026-08-20 после проверки на файле в 330 МБ: «надо расчитывать
    // сразу на модели до 100мб тогда в приложении будет смысл хоть какой-то».
    const m = APP.match(/const COMFORT_BYTES = ([^;]+);/);
    expect(m, 'граница веса в коде не найдена').toBeTruthy();
    // Считаем ЧИСЛО, а не сверяем текст: `100 * 1024 * 1024` и `104857600` — одна и та
    // же граница, и проверка не должна краснеть на переписанном по-другому выражении.
    expect(Function(`return ${m[1]}`)(), 'граница разошлась со словом Александра')
      .toBe(100 * 1024 * 1024);
  });

  it('про границу СКАЗАНО, а не запрещено', () => {
    // Разница принципиальная: отказать значило бы решить за человека (Правило 11).
    // Модель тяжелее ста мегабайт обязана открываться — с предупреждением.
    expect(/log\.tooHeavy/.test(APP), 'нет строки, которая называет цену').toBe(true);
    const blocks = /COMFORT_BYTES[\s\S]{0,400}?(dropzone\.rejected|return;\s*\/\/ отказ|throw )/.test(APP);
    expect(blocks, 'тяжёлая модель отвергается вместо предупреждения').toBe(false);
  });

  it('то же число стоит в документах', () => {
    for (const file of ['README.md', path.join('docs', 'ЧТО_УМЕЕТ.md'), path.join('docs', 'ВОПРОСЫ_И_ОТВЕТЫ.md')]) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(/100\s*(МБ|MB)/.test(text), `${file} не называет границу в 100 МБ`).toBe(true);
    }
  });
});

describe('глина: показ безтекстурных моделей', () => {
  const VIEWER = readSource('ui/viewer/viewer');
  const INDEX = readSource('ui/viewer/index');

  it('глина рисуется кодом, а не возится файлом', () => {
    // Приложение работает без интернета и лишних файлов с собой не таскает: картинка
    // шара строится тремя градиентами на полотне.
    expect(/function makeClayMatcap/.test(VIEWER), 'глины нет вовсе').toBe(true);
    expect(/createRadialGradient/.test(VIEWER), 'картинка шара не рисуется').toBe(true);
    const asset = /matcap[^\r\n]*(\.png|\.jpg|\.webp|fetch\()/i.test(VIEWER);
    expect(asset, 'глина тянет файл вместо того, чтобы рисоваться').toBe(false);
  });

  it('родные материалы возвращаются, а не теряются', () => {
    // Это РЕЖИМ ПОКАЗА (Правило 11). Два места обязаны вернуть материалы на место:
    // переключение обратно и выгрузка модели. Забыть второе — молчаливая утечка: обход
    // освобождения ходит по мешам и до снятых материалов не добирается.
    const restores = [...VIEWER.matchAll(/for \(const \[mesh, mat\] of this\._origMaterials\) mesh\.material = mat;/g)];
    expect(restores.length, 'возврат родных материалов стоит не в двух местах').toBe(2);
    const disposeTail = VIEWER.slice(VIEWER.indexOf('_disposeModel()'));
    const before = disposeTail.indexOf('mesh.material = mat');
    const after = disposeTail.indexOf('disposeSubtree(this.model)');
    expect(before >= 0 && before < after, 'материалы возвращаются ПОСЛЕ выгрузки — они утекут').toBe(true);
  });

  it('выбор один на оба окна', () => {
    // Разъехавшийся показ превратил бы сравнение «до и после» в сравнение способов
    // рисовать. Та же причина, по которой один вариант материала и один уровень.
    expect(/this\.left\?\.viewer\?\.setDisplayMaterial\?\./.test(INDEX)).toBe(true);
    expect(/this\.right\?\.viewer\?\.setDisplayMaterial\?\./.test(INDEX)).toBe(true);
  });

  it('сама включается только там, где текстур нет ВОВСЕ', () => {
    // Ровно одно условие и никаких догадок: есть хоть одна текстура — не трогаем.
    const m = INDEX.match(/_autoDisplayMaterial\(\)\s*\{[\s\S]*?\r?\n {2}\}/);
    expect(m, 'авто-выбора нет').toBeTruthy();
    expect(/hasTextures\(\) \? 'file' : 'clay'/.test(m[0]), 'условие авто-выбора не то').toBe(true);
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
