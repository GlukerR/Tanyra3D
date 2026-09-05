import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document } from '@gltf-transform/core';

import { collectMetrics } from '../addons/gltf/metrics.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';

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

      expect(after.vertices, 'после join рисуется больше вершин, чем до него').toBeLessThanOrEqual(before.vertices);
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
  it('в BaselineSnapshot нет verticesStored', async () => {
    const { baselineSnapshot } = await import('../addons/gltf/metrics.mjs');
    const snap = baselineSnapshot(sharedMeshDoc(2));
    expect(Object.keys(snap)).not.toContain('verticesStored');
    expect(Object.keys(snap), 'из снимка пропали рисуемые вершины').toContain('vertices');
  });
});
