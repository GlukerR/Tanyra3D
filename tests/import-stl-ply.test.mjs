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

  it('командная строка берёт список у аддона, а не держит свою копию', () => {
    // Пункт 5 из «что не сделано»: разница между интерфейсом и командной строкой должна
    // исчезнуть сама, а не поддерживаться руками.
    const cli = fs.readFileSync(path.join(ROOT, 'optimize2.mjs'), 'utf8');
    expect(/gltfAddon\.formats\.join\('\|'\)/.test(cli), 'в командной строке снова своя копия списка').toBe(true);
  });
});
