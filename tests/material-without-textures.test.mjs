// tests/material-without-textures.test.mjs — материал БЕЗ текстур это тоже работа автора.
//
// ПОВОД. Александр 2026-08-22, на своей же модели:
//
//   «на версии 2.8 с моей модели на которой был 1 цвет (фиолетовый) спал полностью этот
//    цвет. цвета и материалы которые встроены в модель без текстур не должны сами собой
//    пропадать и/или заменяться на глину».
//
// Дефект был в ПОСЫЛКЕ, а не в коде. Глина включалась сама у всякой модели без текстур,
// потому что считалось: нет картинок — нет и цвета, экспортёр оставил белое по умолчанию.
// Его модель эту посылку опровергает целиком: текстур ноль, а цвет `[0.447, 0.298, 0.616]`,
// шероховатость 0,55 и металличность 0,05 он задал руками.
//
// Показ чинится во вьюпорте (`ui/viewer/*`, сторожа в `import-formats.test.mjs`). Здесь
// стережётся вторая половина, без которой первая бессмысленна: ДВИЖОК не должен терять
// эти величины при сборке. Разница важна — там мы врали глазу, тут врали бы файлу.
//
// Заготовка коммитимая (164 КБ, разрешение автора — см. sidecar). Сочетание «материал
// настроен, текстур нет, есть анимация» в коммитимой части корпуса не встречалось.

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

const MODEL = 'GLUKE Purple 01.glb';

// Автор задал ровно это. Числа стоят здесь намеренно: «цвет не белый» прошло бы и на
// сером, а нам нужно, чтобы доехал ИМЕННО его фиолетовый.
const PURPLE = [0.447, 0.298, 0.616, 1];
const ROUGHNESS = 0.55;
const METALLIC = 0.05;

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

/** Близко ли, с допуском на упаковку цвета в файл. */
const near = (got, want, eps = 0.02) => Math.abs(got - want) <= eps;

describeIfModels([MODEL], 'материал без текстур доезжает целым', () => {
  it('заготовка и правда «настроен материал, текстур нет»', async () => {
    // Тест, не проверивший свою заготовку, проверяет неизвестно что. И конкретно здесь
    // это не формальность: если у модели однажды появится текстура, весь смысл файла
    // пропадёт, а тесты продолжат зеленеть.
    const doc = await (await reader()).read(modelPath(MODEL));
    const root = doc.getRoot();
    expect(root.listTextures().length, 'у заготовки появились текстуры — она больше не про этот случай').toBe(0);
    const mat = root.listMaterials()[0];
    expect(mat, 'материала нет').toBeTruthy();
    expect(mat.getBaseColorFactor().every((v, i) => near(v, PURPLE[i])), 'цвет заготовки не тот').toBe(true);
    expect(root.listAnimations().length, 'анимация пропала').toBe(1);
  });

  for (const features of [['safe'], ['safe', 'join'], ['safe', 'join', 'meshopt']]) {
    it(`${features.join(' + ')}: цвет, шероховатость и металличность на месте`, async () => {
      const { result, doc } = await build(features);
      expect(result.status).toBe('ok');
      expect(doc, 'файл не записан').toBeTruthy();

      const mats = doc.getRoot().listMaterials();
      expect(mats.length, 'материал выброшен целиком').toBe(1);

      const color = mats[0].getBaseColorFactor();
      expect(color.every((v, i) => near(v, PURPLE[i])),
        `цвет автора изменён: было ${PURPLE.join(', ')}, стало ${color.join(', ')}`).toBe(true);
      expect(near(mats[0].getRoughnessFactor(), ROUGHNESS), 'шероховатость автора изменена').toBe(true);
      expect(near(mats[0].getMetallicFactor(), METALLIC), 'металличность автора изменена').toBe(true);

      // Текстур мы не выдумываем: у модели их не было и появиться им неоткуда.
      expect(doc.getRoot().listTextures().length, 'откуда-то взялась текстура').toBe(0);
    }, 120_000);
  }

  it('анимация переживает сборку', async () => {
    // У неё 18 каналов на 7 мешей. Анимация — замысел автора (Правило 11), и склейка
    // мешей обязана её сохранить.
    const { result, doc } = await build(['safe', 'join']);
    expect(result.status).toBe('ok');
    const anim = doc.getRoot().listAnimations();
    expect(anim.length, 'анимация потеряна').toBe(1);
    expect(anim[0].listChannels().length, 'каналов убыло').toBeGreaterThan(0);
  }, 120_000);
});
