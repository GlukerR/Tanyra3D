import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { optimizeFile } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const COLORED_PLY = [
  'ply', 'format ascii 1.0', 'element vertex 4',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'element face 2', 'property list uchar int vertex_indices', 'end_header',
  '0 0 0 255 0 0', '1 0 0 0 255 0', '1 1 0 0 0 255', '0 1 0 255 255 0',
  '3 0 1 2', '3 0 2 3', '',
].join('\n');

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
      expect(path.basename(res.file.dst)).toBe('куб.glb');
      expect(res.metrics.before.triangles).toBe(2);
      expect(res.metrics.after.triangles).toBe(2);
      expect(res.metrics.after.materials, 'материал выдуман на пустом месте').toBe(0);
      expect(res.metrics.after.textures).toBe(0);
    });
  }, 120_000);

  it('раскраска вершин из PLY доезжает НЕПЕРЕСВЕЧЕННОЙ', async () => {
    await withTemp(async (dir) => {
      const src = path.join(dir, 'квадрат.ply');
      fs.writeFileSync(src, COLORED_PLY, 'utf8');

      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, res.error).toBe('ok');

      const doc = await new NodeIO().read(res.file.dst);
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      const color = prim.getAttribute('COLOR_0');
      expect(color, 'раскраска вершин потеряна — это работа автора (Правило 11)').toBeTruthy();

      for (let i = 0; i < color.getCount(); i++) {
        for (const v of color.getElement(i, [])) {
          expect(v, `составляющая цвета вне [0,1]: ${v}`).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
      const first = color.getElement(0, []);
      expect(first[0]).toBeCloseTo(1, 2);
      expect(first[1]).toBeCloseTo(0, 2);
    });
  }, 120_000);

  it('гранёность STL переживает сшивку вершин', async () => {
    await withTemp(async (dir) => {
      const src = path.join(dir, 'угол.stl');
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
      expect(said[0].i18n, 'строка без рецепта i18n — при смене языка останется чужой').toBeTruthy();
    });
  }, 120_000);

  it('текстовый STL читается наравне с двоичным', async () => {
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
    await withTemp(async (dir) => {
      const src = path.join(dir, 'облако.ply');
      fs.writeFileSync(src, [
        'ply', 'format ascii 1.0', 'element vertex 4',
        'property float x', 'property float y', 'property float z', 'end_header',
        '0 0 0', '1 0 0', '1 1 0', '0 1 0', '',
      ].join('\n'), 'utf8');
      const res = await optimizeFile(src, { outDir: path.join(dir, 'out'), force: true });
      expect(res.status, 'облако точек принято как модель').toBe('fail');
      expect(res.error).toMatch(/point|точ/i);
      expect(res.error, 'наружу вылез внутренний код вместо объяснения').not.toMatch(/point_cloud|no_geometry/);
    });
  }, 120_000);

  it('обрезанный и пустой файл объясняются словами, а не кодом библиотеки', async () => {
    await withTemp(async (dir) => {
      const cut = Buffer.alloc(84 + 50);
      cut.writeUInt32LE(4, 80);
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
      expect(idx.getComponentType(), 'индексы остались двухбайтными на 70 000 вершинах').toBe(5125);
      let max = 0;
      for (let i = 0; i < idx.getCount(); i++) max = Math.max(max, idx.getScalar(i));
      expect(max, 'индекс указывает за пределы массива вершин').toBeLessThan(pos.getCount());
      expect(max, 'индексы завернулись по кругу — геометрия испорчена').toBeGreaterThan(65535);
    });
  }, 180_000);

  it('три кодировки PLY дают один и тот же результат', async () => {
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
    const viewer = fs.readFileSync(path.join(ROOT, 'ui', 'viewer', 'viewer.ts'), 'utf8');
    const ЯКОРЬ = /const FOREIGN_FORMATS = \[([^\]]+)\]/;
    const m = viewer.match(ЯКОРЬ);
    expect(m,
      `в ui/viewer/viewer.ts не найден список чужих форматов по образцу ${ЯКОРЬ}. `
      + 'Если переменную переименовали — поправь образец здесь; если список убрали — '
      + 'вьюпорт больше не знает, что умеет показывать, и это уже дефект')
      .toBeTruthy();
    const shown = m[1].split(',').map((x) => x.trim().replace(/["']/g, '')).filter(Boolean).sort();

    const native = new Set(['glb', 'gltf']);
    const accepted = [...gltfAddon.formats].filter((f) => !native.has(f)).sort();

    expect(shown, `форматы принимаются, но не показываются: ${accepted.filter((f) => !shown.includes(f)).join(', ')}`)
      .toEqual(accepted);
  });

  it('командная строка берёт список у аддона, а не держит свою копию', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'optimize2.mjs'), 'utf8');
    expect(/gltfAddon\.formats\.join\('\|'\)/.test(cli), 'в командной строке снова своя копия списка').toBe(true);
  });
});
