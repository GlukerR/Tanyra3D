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

const MODEL = 'Skinned Morphs 01.glb';

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

const targets = (doc) => doc.getRoot().listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + p.listTargets().length, 0);

describeIfModels([MODEL], 'скин и морфы переживают сжатие', () => {
  it('заготовка и правда «три меша на ОДНОМ скине, с морфами»', async () => {
    const doc = await (await reader()).read(modelPath(MODEL));
    const root = doc.getRoot();
    expect(root.listSkins().length, 'скин должен быть ровно один').toBe(1);
    expect(root.listSkins()[0].listJoints().length, 'суставов меньше двух — расщеплять нечего').toBe(2);
    expect(root.listMeshes().length, 'мешей меньше трёх — своя область квантования не у кого').toBe(3);
    expect(targets(doc), 'морф-целей не шесть').toBe(6);
    expect(root.listAnimations().length).toBe(1);
    const skinned = root.listNodes().filter((n) => n.getSkin());
    expect(skinned.length, 'скиннутых узлов не три').toBe(3);
    expect(new Set(skinned.map((n) => n.getSkin())).size, 'узлы висят на разных скинах').toBe(1);
  });

  for (const features of [['safe'], ['safe', 'meshopt'], ['safe', 'quantize'], ['safe', 'draco'], ['safe', 'join']]) {
    it(`${features.join(' + ')}: скин остаётся ОДНИМ, морфы и анимация целы`, async () => {
      const { result, doc } = await build(features);
      expect(result.status, 'сборка отказала').toBe('ok');
      expect(doc, 'файл не записан').toBeTruthy();

      expect(result.metrics.after.skins,
        `скин расщепился: 1 → ${result.metrics.after.skins}. Похоже, снят сторож quantizeOptions`).toBe(1);
      expect(doc.getRoot().listSkins().length, 'в записанном файле скинов не один').toBe(1);

      expect(targets(doc), 'морф-цели потеряны').toBe(6);
      expect(doc.getRoot().listAnimations().length, 'анимация потеряна').toBe(1);
      expect(result.metrics.after.triangles, 'треугольники изменились').toBe(result.metrics.before.triangles);
    }, 120_000);
  }

  it('обратные матрицы связывания доезжают до файла', async () => {
    const { doc } = await build(['safe', 'meshopt']);
    const skin = doc.getRoot().listSkins()[0];
    expect(skin.getInverseBindMatrices(), 'обратные матрицы пропали при сжатии').toBeTruthy();
    expect(skin.getInverseBindMatrices().getCount(), 'матриц не столько, сколько суставов')
      .toBe(skin.listJoints().length);
  });
});
