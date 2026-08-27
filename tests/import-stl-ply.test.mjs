// tests/import-stl-ply.test.mjs — чужие форматы на вход: STL и PLY.
//
// Шаг 2 плана ввоза (`.claude/ПЛАН_импорт-форматов_2026-08-19.md`). Самые простые форматы:
// только геометрия, ни материалов, ни текстур, ни иерархии. Конвейер после разбора не
// отличает их от обычной модели — и вот это утверждение здесь и проверяется.
//
// Почему проверки идут через НАСТОЯЩИЙ прогон, а не через чтение исходников: перекладывать
// вершины из одного представления в другое легко сломать так, что видно только в готовом
// файле. Один такой дефект уже был найден живой проверкой — см. «раскраска вершин».

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { optimizeFile } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Двоичный STL: 80 байт заголовка, число треугольников, дальше по 50 байт на каждый. */
function binarySTL(faces) {
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.write('Tanyra3D test', 0);
  buf.writeUInt32LE(faces.length, 80);
  let o = 84;
  for (const { n, v } of faces) {
    for (let i = 0; i < 3; i++) buf.writeFloatLE(n[i], o + i * 4);
    o += 12;
    for (const p of v) { for (let i = 0; i < 3; i++) buf.writeFloatLE(p[i], o + i * 4); o += 12; }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  return buf;
}

/** PLY с раскраской вершин: цвета лежат целыми байтами, 255 означает единицу. */
const COLORED_PLY = [
  'ply', 'format ascii 1.0', 'element vertex 4',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'element face 2', 'property list uchar int vertex_indices', 'end_header',
  '0 0 0 255 0 0', '1 0 0 0 255 0', '1 1 0 0 0 255', '0 1 0 255 255 0',
  '3 0 1 2', '3 0 2 3', '',
].join('\n');

/**
 * Временная папка на одну проверку.
 *
 * `async` и `await` здесь обязательны, и это не украшение: первая редакция была
 * синхронной, `finally` срабатывал на ВОЗВРАТЕ ПРОМИСА — то есть папка стиралась раньше,
 * чем прогон успевал прочитать из неё файл. Все три проверки падали на ENOENT, обвиняя
 * код, который был исправен.
 */
async function withTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-stl-'));
  try { return await run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('STL и PLY принимаются и проходят обычный конвейер', () => {
  it('STL становится .glb, треугольники целы, материалов не выдумано', async () => {
    await withTemp(async (dir) => {
      const src = path.join(dir, 'куб.stl');
      fs.writeFileSync(src, binarySTL([
        { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0]] },
        { n: [0, 0, -1], v: [[0, 0, 0], [1, 1, 0], [1, 0, 0]] },
      ]));

      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');
      // Имя выхода — .glb. Оставить .stl значило бы отдать файл, чьё имя врёт о том,
      // что внутри: там двоичный glTF.
      expect(path.basename(res.file.dst)).toBe('куб.glb');
      expect(res.metrics.before.triangles).toBe(2);
      expect(res.metrics.after.triangles).toBe(2);
      // Материалов и текстур в STL нет по устройству формата. Придумать белый материал
      // было бы правкой замысла: в отчёте он выглядел бы свойством модели (Правило 11).
      expect(res.metrics.after.materials, 'материал выдуман на пустом месте').toBe(0);
      expect(res.metrics.after.textures).toBe(0);
    });
  }, 120_000);

  it('раскраска вершин из PLY доезжает НЕПЕРЕСВЕЧЕННОЙ', async () => {
    // Настоящий дефект, найденный 2026-08-20 живой проверкой. PLYLoader отдаёт цвета
    // массивом Uint8Array с флагом `normalized`: 255 там означает единицу. Слепое
    // приведение к float писало в файл 255.0 — модель приезжала пересвеченной в двести
    // пятьдесят пять раз, и НИ ОДНА проверка этого бы не заметила: цвета на месте, счёт
    // вершин верный, валидатор доволен. Ловится только чтением значения.
    await withTemp(async (dir) => {
      const src = path.join(dir, 'квадрат.ply');
      fs.writeFileSync(src, COLORED_PLY, 'utf8');

      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');

      const doc = await new NodeIO().read(res.file.dst);
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      const color = prim.getAttribute('COLOR_0');
      expect(color, 'раскраска вершин потеряна — это работа автора (Правило 11)').toBeTruthy();

      // Каждая составляющая обязана лежать в пределах от нуля до единицы. Само по себе
      // «цвета есть» ничего не доказывает — врал именно масштаб.
      for (let i = 0; i < color.getCount(); i++) {
        for (const v of color.getElement(i, [])) {
          expect(v, `составляющая цвета вне [0,1]: ${v}`).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
      // И первая вершина обязана остаться КРАСНОЙ, а не стать белой от переполнения.
      const first = color.getElement(0, []);
      expect(first[0]).toBeCloseTo(1, 2);
      expect(first[1]).toBeCloseTo(0, 2);
    });
  }, 120_000);

  it('гранёность STL переживает сшивку вершин', async () => {
    // Сшивка объединяет только вершины, совпадающие ЦЕЛИКОМ — вместе с нормалью. Начни
    // она сливать по одной позиции, куб из STL сгладился бы в шар: рёбра пропали бы,
    // а это уже правка замысла, а не уборка следов экспортёра.
    await withTemp(async (dir) => {
      const src = path.join(dir, 'угол.stl');
      // Две грани с ОБЩИМ ребром и РАЗНЫМИ нормалями.
      fs.writeFileSync(src, binarySTL([
        { n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
        { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 1], [1, 0, 0]] },
      ]));

      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true, safe: true });
      expect(res.status, res.error).toBe('ok');

      const doc = await new NodeIO().read(res.file.dst);
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      const normals = prim.getAttribute('NORMAL');
      expect(normals, 'нормали потеряны — модель станет плоской').toBeTruthy();
      const seen = new Set();
      for (let i = 0; i < normals.getCount(); i++) seen.add(normals.getElement(i, []).map((v) => v.toFixed(2)).join(','));
      expect(seen.size, 'все нормали стали одной — грани слились').toBeGreaterThan(1);
    });
  }, 120_000);

  it('включённая галочка не пропадает из отчёта на модели без текстур', async () => {
    // Правило 12: показанная галочка обязана работать, а если делать ей нечего — сказать
    // об этом. У модели из STL текстур нет по устройству формата, и «уменьшить текстуры
    // до 2048» не находило ни одной. До 2026-08-20 отчёт при этом молчал ПОЛНОСТЬЮ: ни
    // «сделано», ни «пропущено» — человек не мог понять, сработал его выбор или нет.
    //
    // Причина была в движке: сторож «ничего не сделано» смотрел на имя ОДНОЙ галочки
    // (`meta.feature`), а у размеров текстур их четыре, и правило объявляет группу.
    //
    // Проверка идёт по ОТЧЁТУ, а не по тексту кода: сторож на исходнике стоит отдельно
    // (tests/report-honesty), но он не докажет, что строка дошла до человека.
    await withTemp(async (dir) => {
      const src = path.join(dir, 'без-текстур.stl');
      fs.writeFileSync(src, binarySTL([
        { n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
      ]));

      const res = await optimizeFile(src, {
        outDir: path.join(dir, 'out'),
        force: true,
        advancedFeatures: ['resize-2048'],
      });
      expect(res.status, res.error).toBe('ok');

      const said = [...(res.applied || []), ...(res.skipped || [])]
        .filter((e) => e.ruleId === 'textures/resize');
      expect(said.length, 'выбранный размер текстур не оставил в отчёте ни одной строки').toBe(1);
      expect(said[0].text, 'строка есть, но пустая').toBeTruthy();
      // Рецепт нужен, чтобы строка пережила смену языка без пересборки (Правило 8).
      expect(said[0].i18n, 'строка без рецепта i18n — при смене языка останется чужой').toBeTruthy();
    });
  }, 120_000);

  it('текстовый STL читается наравне с двоичным', async () => {
    // Двоичный проверялся с первого дня, текстовый — ни разу. Разборщик выбирает ветку
    // сам (isBinary в STLLoader), и до 2026-08-20 мы не знали, работает ли вторая.
    await withTemp(async (dir) => {
      const src = path.join(dir, 'текст.stl');
      fs.writeFileSync(src, [
        'solid проба', 'facet normal 0 0 1', 'outer loop',
        'vertex 0 0 0', 'vertex 1 0 0', 'vertex 0 1 0',
        'endloop', 'endfacet', 'endsolid проба', '',
      ].join('\n'), 'utf8');
      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');
      expect(res.metrics.after.triangles).toBe(1);
    });
  }, 120_000);

  it('ЗАГЛАВНОЕ расширение тоже становится .glb', async () => {
    await withTemp(async (dir) => {
      const src = path.join(dir, 'МОДЕЛЬ.STL');
      fs.writeFileSync(src, binarySTL([{ n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }]));
      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');
      expect(path.basename(res.file.dst)).toBe('МОДЕЛЬ.glb');
    });
  }, 120_000);

  it('облако точек ОТВЕРГАЕТСЯ, а не превращается в выдуманные треугольники', async () => {
    // Самая дорогая находка 2026-08-20. PLY без граней — это точки, треугольников в нём
    // нет. Разборщик отдаёт такое облако обычной геометрией без индексов, а примитив
    // glTF по умолчанию рисуется ТРЕУГОЛЬНИКАМИ: четыре точки молча превращались в один
    // треугольник, и отчёт объявлял его содержимым модели. Мы выдумывали геометрию,
    // которой в файле не было (Правило 11), и говорили о ней уверенным числом.
    await withTemp(async (dir) => {
      const src = path.join(dir, 'облако.ply');
      fs.writeFileSync(src, [
        'ply', 'format ascii 1.0', 'element vertex 4',
        'property float x', 'property float y', 'property float z', 'end_header',
        '0 0 0', '1 0 0', '1 1 0', '0 1 0', '',
      ].join('\n'), 'utf8');
      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, 'облако точек принято как модель').toBe('fail');
      // Отказ обязан объяснять, а не сыпать внутренним кодом.
      expect(res.error).toMatch(/point|точ/i);
      expect(res.error, 'наружу вылез внутренний код вместо объяснения').not.toMatch(/point_cloud|no_geometry/);
    });
  }, 120_000);

  it('обрезанный и пустой файл объясняются словами, а не кодом библиотеки', async () => {
    // Обрезанный STL давал «Offset is outside the bounds of the DataView» — правду о том,
    // что случилось внутри библиотеки, и ничего о том, что делать человеку.
    await withTemp(async (dir) => {
      const cut = Buffer.alloc(84 + 50);
      cut.writeUInt32LE(4, 80);            // заявлено четыре треугольника, лежит один
      const a = path.join(dir, 'обрезан.stl');
      fs.writeFileSync(a, cut);
      const r1 = await optimizeFile(a, { outDir: path.join(dir, 'o1'), force: true });
      expect(r1.status).toBe('fail');
      expect(r1.error, 'наружу вылезло сообщение из недр библиотеки').not.toMatch(/DataView|Offset/i);
      expect(r1.error).toMatch(/truncated|обрез|повреж/i);

      const empty = Buffer.alloc(84);
      empty.writeUInt32LE(0, 80);
      const b = path.join(dir, 'пустой.stl');
      fs.writeFileSync(b, empty);
      const r2 = await optimizeFile(b, { outDir: path.join(dir, 'o2'), force: true });
      expect(r2.status).toBe('fail');
      expect(r2.error, 'внутренний код вместо объяснения').not.toMatch(/no_geometry/);
    });
  }, 120_000);

  it('за границей 65 535 вершин индексы становятся четырёхбайтными', async () => {
    // Развилка в buildDocument, не проверенная ни разу. Ошибись она — геометрия крупной
    // модели молча испортилась бы: индексы завернулись бы по кругу, и треугольники
    // соединили бы не те вершины. Ни счёт, ни валидатор этого бы не показали.
    await withTemp(async (dir) => {
      const N = 70000;
      const F = Math.floor(N / 3);
      const lines = ['ply', 'format ascii 1.0', `element vertex ${N}`,
        'property float x', 'property float y', 'property float z',
        `element face ${F}`, 'property list uchar int vertex_indices', 'end_header'];
      for (let i = 0; i < N; i++) lines.push(`${i % 100} ${Math.floor(i / 100)} 0`);
      for (let i = 0; i < F; i++) lines.push(`3 ${i * 3} ${i * 3 + 1} ${i * 3 + 2}`);
      const src = path.join(dir, 'много.ply');
      fs.writeFileSync(src, lines.join('\n') + '\n', 'utf8');

      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');
      const doc = await new NodeIO().read(res.file.dst);
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      expect(pos.getCount()).toBe(N);
      // 5125 — четыре байта на индекс. 5123 (два байта) здесь означал бы порчу.
      expect(idx.getComponentType(), 'индексы остались двухбайтными на 70 000 вершинах').toBe(5125);
      let max = 0;
      for (let i = 0; i < idx.getCount(); i++) max = Math.max(max, idx.getScalar(i));
      expect(max, 'индекс указывает за пределы массива вершин').toBeLessThan(pos.getCount());
      expect(max, 'индексы завернулись по кругу — геометрия испорчена').toBeGreaterThan(65535);
    });
  }, 180_000);

  it('три кодировки PLY дают один и тот же результат', async () => {
    // ascii, binary_little_endian, binary_big_endian. Порядок байтов — ровно то место,
    // где ошибка тихая: числа читаются, модель собирается, а координаты чужие.
    const V = [[0, 0, 0, 255, 0, 0], [1, 0, 0, 0, 255, 0], [1, 1, 0, 0, 0, 255]];
    const header = (fmt) => ['ply', `format ${fmt} 1.0`, 'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      'element face 1', 'property list uchar int vertex_indices', 'end_header', ''].join('\n');
    const binary = (le) => {
      const head = Buffer.from(header(le ? 'binary_little_endian' : 'binary_big_endian'), 'utf8');
      const body = Buffer.alloc(3 * 15 + 13);
      let o = 0;
      for (const v of V) {
        for (let i = 0; i < 3; i++) { if (le) body.writeFloatLE(v[i], o); else body.writeFloatBE(v[i], o); o += 4; }
        for (let i = 3; i < 6; i++) { body.writeUInt8(v[i], o); o += 1; }
      }
      body.writeUInt8(3, o); o += 1;
      for (const i of [0, 1, 2]) { if (le) body.writeInt32LE(i, o); else body.writeInt32BE(i, o); o += 4; }
      return Buffer.concat([head, body]);
    };

    await withTemp(async (dir) => {
      const snapshots = [];
      const files = {
        ascii: Buffer.from(header('ascii') + V.map((v) => v.join(' ')).join('\n') + '\n3 0 1 2\n', 'utf8'),
        le: binary(true),
        be: binary(false),
      };
      for (const [name, bytes] of Object.entries(files)) {
        const src = path.join(dir, name + '.ply');
        fs.writeFileSync(src, bytes);
        const res = await optimizeFile(src, { outDir: path.join(dir, 'out-' + name), force: true });
        expect(res.status, `${name}: ${res.error}`).toBe('ok');
        const doc = await new NodeIO().read(res.file.dst);
        const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
        const pos = prim.getAttribute('POSITION');
        const col = prim.getAttribute('COLOR_0');
        const dump = { pos: [], col: [] };
        for (let i = 0; i < pos.getCount(); i++) dump.pos.push(pos.getElement(i, []).map((v) => v.toFixed(3)).join(','));
        for (let i = 0; i < col.getCount(); i++) dump.col.push(col.getElement(i, []).map((v) => v.toFixed(3)).join(','));
        snapshots.push([name, JSON.stringify(dump)]);
      }
      const [firstName, first] = snapshots[0];
      for (const [name, dump] of snapshots.slice(1)) {
        expect(dump, `${name} разошёлся с ${firstName} — порядок байтов прочитан неверно`).toBe(first);
      }
    });
  }, 180_000);

  it('список расширений один: аддон, сервер, интерфейс и диалог выбора', () => {
    // Четыре места, и разойтись они могут молча: интерфейс покажет файл в списке, сервер
    // его отвергнет, а командная строка не заметит вовсе.
    const formats = [...gltfAddon.formats].sort();
    expect(formats).toContain('stl');
    expect(formats).toContain('ply');

    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const fromRe = (src, re) => {
      const m = src.match(re);
      expect(m, `не нашёл список расширений: ${re}`).toBeTruthy();
      return m[1].split('|').sort();
    };
    expect(fromRe(read('server.mjs'), /const MODEL_EXT = \/\\\.\(([^)]+)\)/)).toEqual(formats);
    expect(fromRe(read('ui/app.js'), /const MODEL_RE = \/\\\.\(([^)]+)\)/)).toEqual(formats);

    const accept = read(path.join('ui', 'index.html')).match(/id="file-input"[^>]*accept="([^"]+)"/);
    expect(accept, 'у поля выбора файла нет accept').toBeTruthy();
    expect(accept[1].split(',').map((e) => e.trim().replace(/^\./, '')).sort()).toEqual(formats);
  });

  it('КАЖДЫЙ принимаемый формат умеет показываться', () => {
    // Александр 2026-08-22: «подключай просмотр всех поддерживаемых моделей». Повод —
    // FBX: движок его принял, отчёт собрался, а во вьюпорте не появлялось ничего. Дефект
    // тихий и обидный: файл принят, кнопки живые, экран пуст.
    //
    // Списка два, и они разного происхождения. Аддон говорит, что умеет ПРОЧЕСТЬ;
    // вьюпорт — что умеет ПОКАЗАТЬ. Совпадать они обязаны, а расходятся молча: приём
    // добавляют в одном файле, показ — в другом, и второй забывают.
    //
    // glTF в списке вьюпорта не назван: его открывает GLTFLoader, то есть путь по
    // умолчанию. Поэтому вычитаем его, а сверяем остаток — «чужие» форматы.
    const viewer = fs.readFileSync(path.join(ROOT, 'ui', 'viewer', 'viewer.ts'), 'utf8');
    const ЯКОРЬ = /const FOREIGN_FORMATS = \[([^\]]+)\]/;
    const m = viewer.match(ЯКОРЬ);
    // Сообщение называет ЯКОРЬ, а не «список не найден». Разница не косметическая:
    // сторож читает ТЕКСТ исходника, поэтому краснеет и от чистого переименования, когда
    // ничего не сломано. Прежний текст в этом случае утверждал, что списка нет, — и
    // контрибутор шёл искать пропавшую фичу вместо того, чтобы поправить якорь
    // (замерено аудитом, фаза Ф6: 5 красных на переименование четырёх переменных).
    expect(m,
      `в ui/viewer/viewer.ts не найден список чужих форматов по образцу ${ЯКОРЬ}. `
      + 'Если переменную переименовали — поправь образец здесь; если список убрали — '
      + 'вьюпорт больше не знает, что умеет показывать, и это уже дефект')
      .toBeTruthy();
    const shown = m[1].split(',').map((x) => x.trim().replace(/["']/g, '')).filter(Boolean).sort();

    const native = new Set(['glb', 'gltf']); // их открывает GLTFLoader, отдельного пути нет
    const accepted = [...gltfAddon.formats].filter((f) => !native.has(f)).sort();

    expect(shown, `форматы принимаются, но не показываются: ${accepted.filter((f) => !shown.includes(f)).join(', ')}`)
      .toEqual(accepted);
  });

  it('командная строка берёт список у аддона, а не держит свою копию', () => {
    // Пункт 5 из «что не сделано»: разница между интерфейсом и командной строкой должна
    // исчезнуть сама, а не поддерживаться руками.
    const cli = fs.readFileSync(path.join(ROOT, 'optimize2.mjs'), 'utf8');
    expect(/gltfAddon\.formats\.join\('\|'\)/.test(cli), 'в командной строке снова своя копия списка').toBe(true);
  });
});
