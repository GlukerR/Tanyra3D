// tests/vertices-stored.test.mjs — «хранится» против «рисуется» (ROADMAP.md §5b).
//
// Пока величина была одна, она молча прятала ровно тот случай, ради которого на неё
// смотрят: `join` разворачивает общую геометрию в копии — рисуемых вершин остаётся
// столько же, а хранимых становится втрое больше. Файл и видеопамять растут, метрика
// неподвижна.
//
// Здесь сторожится смысл каждой из двух величин, а не их значения на конкретной модели.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document } from '@gltf-transform/core';

import { collectMetrics } from '../addons/gltf/metrics.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';

/** Один меш и N узлов, которые на него ссылаются: общая геометрия, как после dedup. */
function sharedMeshDoc(users) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const mesh = doc.createMesh('Shared').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos));
  const scene = doc.createScene('S');
  for (let i = 0; i < users; i++) {
    scene.addChild(doc.createNode(`N${i}`).setMesh(mesh).setTranslation([i * 2, 0, 0]));
  }
  return doc;
}

describe('две величины считают разное', () => {
  it('общая геометрия: рисуется втрое больше, хранится один раз', () => {
    const m = collectMetrics(sharedMeshDoc(3), 0);
    expect(m.vertices, 'рисуемые вершины не учли повторное использование меша').toBe(9);
    expect(m.verticesStored, 'хранимые вершины посчитали трижды один и тот же буфер').toBe(3);
  });

  it('на модели без повторов величины совпадают', () => {
    const m = collectMetrics(sharedMeshDoc(1), 0);
    expect(m.vertices).toBe(3);
    expect(m.verticesStored).toBe(3);
  });

  // Меш, которого нет в сцене, места в файле всё равно занимает — а рисоваться не
  // может. Это и есть разница между «лежит в файле» и «уходит в видеокарту».
  it('меш вне сцены хранится, но не рисуется', () => {
    const doc = sharedMeshDoc(1);
    const buffer = doc.getRoot().listBuffers()[0];
    const pos = doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]));
    doc.createMesh('Orphan').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos));

    const m = collectMetrics(doc, 0);
    expect(m.vertices, 'меш вне сцены попал в рисуемые').toBe(3);
    expect(m.verticesStored, 'меш вне сцены не попал в хранимые').toBe(7);
  });
});

// Настоящий случай, ради которого всё и заведено: на модели со связанными дубликатами
// объединение мешей разворачивает общую геометрию в копии.
describe('join разворачивает общую геометрию — и теперь это видно', () => {
  const MODEL = 'Linked Duplicates Grid 01.glb';
  const body = async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertices-stored-'));
    try {
      const r = await optimizeFile(modelPath(MODEL), {
        outDir, force: true, locale: 'ru', advancedFeatures: ['safe', 'join'],
      });
      expect(r.status).toBe('ok');
      const { before, after } = r.metrics;

      // Рисуется — не больше, чем было: объединение на картинку не влияет.
      expect(after.vertices, 'после join рисуется больше вершин, чем до него').toBeLessThanOrEqual(before.vertices);
      // А вот хранимые могут вырасти, и раньше об этом не говорила ни одна цифра.
      expect(after.verticesStored, 'хранимые вершины не посчитались вовсе').toBeGreaterThan(0);
      expect(typeof before.verticesStored).toBe('number');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };
  if (isPresent(MODEL)) it(`${MODEL} — обе величины в отчёте`, body, 120_000);
  else it.skip(`${MODEL} отсутствует локально`, () => {});
});

describe('baseline-снимок не сторожит хранимые вершины', () => {
  // В снимке лежит то, что меняться НЕ должно. Хранимым как раз положено меняться —
  // в этом смысл объединения мешей; попади они в снимок, join валил бы проверку
  // целостности на ровном месте.
  it('в BaselineSnapshot нет verticesStored', async () => {
    const { baselineSnapshot } = await import('../addons/gltf/metrics.mjs');
    const snap = baselineSnapshot(sharedMeshDoc(2));
    expect(Object.keys(snap)).not.toContain('verticesStored');
    expect(Object.keys(snap), 'из снимка пропали рисуемые вершины').toContain('vertices');
  });
});
