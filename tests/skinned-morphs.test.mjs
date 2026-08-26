// tests/skinned-morphs.test.mjs — скин и морфы вместе: сжатие их не ломает.
//
// ЗАКАЗ (Александр, 2026-08-23): «надо следующей версией разобраться со скином и морфами».
//
// ЧТО СТЕРЕЖЁМ. Дефект, найденный в июле на `parkergirl` (персонаж, 456 морф-целей):
// `['safe','meshopt']` РАЗМНОЖАЛ скин 1 → 14 и сдвигал габарит. Причина — квантование
// внутри пути meshopt: без `quantizationVolume: 'scene'` каждый меш получает свою область
// и своё преобразование, а у скиннутой модели преобразование должно быть ОДНО на сцену,
// иначе обратные матрицы расходятся с узлами.
//
// Починка — `quantizeOptions()` в `addons/gltf/rules.mts`, одна на два правила
// (`geometry/compress` и `geometry/quantize`), чтобы они не разошлись.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ ТОЛЬКО СЕЙЧАС. Замер 2026-08-23: в коммитимой части корпуса
// 24 модели и НИ ОДНОЙ со скином. Проверялось всё двумя локальными моделями (`parkergirl`,
// `chibi_zenitsu`) — то есть на чистом клоне и на CI обещание держалось на слове. Ровно
// та же дыра, что была с двумя UV-островами.
//
// ЗАГОТОВКА ЛОВИТ ДЕФЕКТ, а не просто существует: со снятым сторожем она даёт скин 1 → 3
// и статус `fail`. Это проверено пробой, и без такой пробы файл не стоил бы ничего —
// первая редакция заготовки (ОДИН скиннутый меш) дефект не воспроизводила вовсе.

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

/** Сколько морф-целей во всём документе. */
const targets = (doc) => doc.getRoot().listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + p.listTargets().length, 0);

describeIfModels([MODEL], 'скин и морфы переживают сжатие', () => {
  it('заготовка и правда «три меша на ОДНОМ скине, с морфами»', async () => {
    // Тест, не проверивший свою заготовку, проверяет неизвестно что. И здесь это не
    // формальность: сведи меши в один — и дефект перестанет воспроизводиться, а файл
    // продолжит зеленеть, ничего не стерегя.
    const doc = await (await reader()).read(modelPath(MODEL));
    const root = doc.getRoot();
    expect(root.listSkins().length, 'скин должен быть ровно один').toBe(1);
    expect(root.listSkins()[0].listJoints().length, 'суставов меньше двух — расщеплять нечего').toBe(2);
    expect(root.listMeshes().length, 'мешей меньше трёх — своя область квантования не у кого').toBe(3);
    expect(targets(doc), 'морф-целей не шесть').toBe(6);
    expect(root.listAnimations().length).toBe(1);
    // Все меши висят на ОДНОМ скине — иначе расщеплять было бы нечего.
    const skinned = root.listNodes().filter((n) => n.getSkin());
    expect(skinned.length, 'скиннутых узлов не три').toBe(3);
    expect(new Set(skinned.map((n) => n.getSkin())).size, 'узлы висят на разных скинах').toBe(1);
  });

  for (const features of [['safe'], ['safe', 'meshopt'], ['safe', 'quantize'], ['safe', 'draco'], ['safe', 'join']]) {
    it(`${features.join(' + ')}: скин остаётся ОДНИМ, морфы и анимация целы`, async () => {
      const { result, doc } = await build(features);
      expect(result.status, 'сборка отказала').toBe('ok');
      expect(doc, 'файл не записан').toBeTruthy();

      // ГЛАВНОЕ УТВЕРЖДЕНИЕ. Расщепление скина — это TESTBUG-007.
      expect(result.metrics.after.skins,
        `скин расщепился: 1 → ${result.metrics.after.skins}. Похоже, снят сторож quantizeOptions`).toBe(1);
      expect(doc.getRoot().listSkins().length, 'в записанном файле скинов не один').toBe(1);

      // Морфы и анимация — работа автора, сжатие их не касается (Правило 11).
      expect(targets(doc), 'морф-цели потеряны').toBe(6);
      expect(doc.getRoot().listAnimations().length, 'анимация потеряна').toBe(1);
      expect(result.metrics.after.triangles, 'треугольники изменились').toBe(result.metrics.before.triangles);
    }, 120_000);
  }

  it('обратные матрицы связывания доезжают до файла', async () => {
    // Без них скин есть только на бумаге: движок не сможет перевести вершины в
    // пространство суставов, и модель развалится при первом же кадре анимации.
    const { doc } = await build(['safe', 'meshopt']);
    const skin = doc.getRoot().listSkins()[0];
    expect(skin.getInverseBindMatrices(), 'обратные матрицы пропали при сжатии').toBeTruthy();
    expect(skin.getInverseBindMatrices().getCount(), 'матриц не столько, сколько суставов')
      .toBe(skin.listJoints().length);
  });
});
