import { it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const MODEL = 'Two UV Islands 01.glb';

let io;
async function reader() {
  if (io) return io;
  await MeshoptDecoder.ready;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
  return io;
}

afterAll(cleanupTmpOutDirs);

async function build(features) {
  const outDir = tmpOutDir();
  const result = await optimizeFile(modelPath(MODEL), { outDir, advancedFeatures: features, locale: 'ru' });
  const name = fs.readdirSync(outDir).find((n) => n.toLowerCase().endsWith('.glb'));
  const doc = name ? await (await reader()).read(path.join(outDir, name)) : null;
  return { result, doc };
}

function layout(doc) {
  const out = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!mat || !uv) continue;
      const vs = [];
      for (let i = 0; i < uv.getCount(); i++) vs.push(uv.getElement(i, [])[1]);
      out.push({
        material: mat.getName(),
        texture: mat.getBaseColorTexture() ? mat.getBaseColorTexture().getName() : null,
        vMin: Math.min(...vs),
        vMax: Math.max(...vs),
      });
    }
  }
  return out.sort((a, b) => a.material.localeCompare(b.material));
}

describeIfModels([MODEL], 'две развёртки и две карты не путаются', () => {
  it('заготовка и правда содержит два РАЗНЫХ острова', async () => {
    const doc = await (await reader()).read(modelPath(MODEL));
    const parts = layout(doc);
    expect(parts.length, 'частей с развёрткой должно быть две').toBe(2);
    expect(parts[0].texture).not.toBe(parts[1].texture);
    expect(parts[0].vMax, 'острова наложились — заготовка потеряла смысл').toBeLessThan(parts[1].vMin);
  });

  for (const features of [['safe'], ['safe', 'join'], ['safe', 'join', 'meshopt']]) {
    it(`${features.join(' + ')}: каждая часть остаётся со своей картой и своей развёрткой`, async () => {
      const { result, doc } = await build(features);
      expect(result.status).toBe('ok');
      expect(doc, 'файл не записан').toBeTruthy();

      const parts = layout(doc);
      expect(parts.length, 'часть потерялась').toBe(2);

      const [left, right] = parts;
      expect(left.texture, 'у части пропала карта').toBeTruthy();
      expect(right.texture, 'у части пропала карта').toBeTruthy();
      expect(left.texture, 'обе части смотрят в одну карту — склейка их перепутала').not.toBe(right.texture);

      expect(left.vMax, 'развёртки съехали друг на друга').toBeLessThan(right.vMin);
      expect(left.vMin).toBeCloseTo(0, 2);
      expect(right.vMax).toBeCloseTo(1, 2);

      expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    }, 120_000);
  }

  it('склейка НЕ сводит части с разными материалами', async () => {
    const { result, doc } = await build(['safe', 'join']);
    expect(result.status).toBe('ok');
    expect(doc.getRoot().listMaterials().length, 'материалы слиты — одна из карт пропала').toBe(2);
    expect(doc.getRoot().listTextures().length, 'текстуры слиты').toBe(2);
    expect(result.metrics.after.drawCalls, 'части с разными материалами свели в один вызов').toBe(2);
  }, 120_000);
});
