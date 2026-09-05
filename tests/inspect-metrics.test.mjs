import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectFile, optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';

const TIMEOUT = 120_000;

const MODELS = [
  'Dirty Cube 01.glb',
  'Orphan Texture Cube 01.glb',
  'Instance Grid 01.glb',
  'Texture Only 01.glb',
];

const HUD_FIELDS = ['fileBytes', 'triangles', 'vertices', 'drawCalls', 'materials', 'textures', 'gpuBytes'];

describe('Цифры исходной модели: inspect() = metrics.before', () => {
  eachModel('inspect отдаёт метрики, и они совпадают с before после сборки', MODELS, async (name) => {
    const src = modelPath(name);

    const inspected = await inspectFile(src);
    expect(inspected.metrics, `${name}: inspect() не отдал metrics — левая шапка останется пустой`).toBeTruthy();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-metrics-'));
    let result;
    try {
      result = await optimizeFile(src, { advancedFeatures: ['safe'], outDir });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    expect(result.status).toBe('ok');

    for (const field of HUD_FIELDS) {
      expect(
        inspected.metrics[field],
        `${name}: ${field} до сборки ${inspected.metrics[field]} ≠ ${result.metrics.before[field]} после. `
          + 'Левая шапка дёрнется в момент сборки — значит источников снова два.',
      ).toBe(result.metrics.before[field]);
    }
  }, TIMEOUT);

  it('размер файла в метриках — настоящий размер на диске', async () => {
    const name = 'Dirty Cube 01.glb';
    const inspected = await inspectFile(modelPath(name));
    expect(inspected.metrics.fileBytes).toBe(fs.statSync(modelPath(name)).size);
  }, TIMEOUT);

  it('поле metrics объявлено в контракте даже у формата без инспекции', async () => {
    const stub = { format: null, asset: {}, extensions: [], metadata: null, metrics: null, validation: [] };
    const src = fs.readFileSync(new URL('../optimize2.mjs', import.meta.url), 'utf8');
    for (const key of Object.keys(stub)) {
      expect(src, `в заглушке inspectFile() пропало поле ${key}`).toMatch(new RegExp(`${key}\\s*:`));
    }
  });
});
