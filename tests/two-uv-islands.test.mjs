// tests/two-uv-islands.test.mjs — две части, две развёртки, две карты: ничего не путается.
//
// ЗАКАЗ (Александр, 2026-08-22): «у нас есть вообще модель в которой объеденены две модели
// с двумя разными юви островами? это очень важно. если нет срочно объедини две маленькие
// модели с юви и текстурами осознанными и нужно это проверить».
//
// Замер ответил: такие модели в корпусе ЕСТЬ — двенадцать штук, — но ВСЕ до одной
// локальные (Khronos, Sketchfab, клиентские). Ни одной коммитимой. То есть на чистом
// клоне и на CI это обещание не проверял никто и никогда, а звучит оно громко: склейка
// мешей — единственное правило, которое перекладывает геометрию между частями.
//
// Заготовка сделана нами (`_work/make-two-uv-islands.mjs`, 2,4 КБ, Apache-2.0) и едет в
// репозиторий. Развёртки в ней РАЗНЫЕ намеренно: левая часть смотрит в верхнюю половину
// своей карты (V 0…0,49), правая — в нижнюю своей (V 0,51…1).
//
// ПОЧЕМУ ИМЕННО ТАК. Перепутать развёртки можно НЕЗАМЕТНО ДЛЯ ЧИСЕЛ: треугольники,
// материалы и текстуры останутся прежними, а цвет на модели сменится. Случайная развёртка
// такую ошибку не ловит. Эта ловит — диапазоны V не пересекаются, и по ним видно, чья
// часть куда смотрит.

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

// Читатель со ВСЕМИ расширениями: результат бывает сжат (meshopt, draco), и обычный
// NodeIO на таком файле бросает «Missing required extension». Тест обязан читать то же,
// что читает движок, иначе он проверяет не результат, а свою неспособность его открыть.
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

/** Прогнать и вернуть разобранный результат. */
async function build(features) {
  const outDir = tmpOutDir();
  const result = await optimizeFile(modelPath(MODEL), { outDir, advancedFeatures: features, locale: 'ru' });
  const name = fs.readdirSync(outDir).find((n) => n.toLowerCase().endsWith('.glb'));
  const doc = name ? await (await reader()).read(path.join(outDir, name)) : null;
  return { result, doc };
}

/** Для каждого примитива: имя материала, имя его карты и диапазон V. */
function layout(doc) {
  const out = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!mat || !uv) continue;
      // getElement, а не getArray: после meshopt развёртка хранится ЦЕЛЫМИ числами с
      // флагом «нормализованные» (0…65535 вместо 0…1). Сырой массив дал бы 65535 там,
      // где на самом деле единица, — и тест ловил бы собственную ошибку чтения, а не
      // ошибку продукта. getElement разворачивает нормализацию сам.
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
    // Тест, который не проверил свою заготовку, проверяет неизвестно что.
    const doc = await (await reader()).read(modelPath(MODEL));
    const parts = layout(doc);
    expect(parts.length, 'частей с развёрткой должно быть две').toBe(2);
    expect(parts[0].texture).not.toBe(parts[1].texture);
    // Диапазоны V не пересекаются — иначе подмена одной развёртки другой была бы незаметна.
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
      // Карты у частей разные — то есть их не свели в одну.
      expect(left.texture, 'у части пропала карта').toBeTruthy();
      expect(right.texture, 'у части пропала карта').toBeTruthy();
      expect(left.texture, 'обе части смотрят в одну карту — склейка их перепутала').not.toBe(right.texture);

      // И развёртки на своих местах: острова по-прежнему не пересекаются.
      expect(left.vMax, 'развёртки съехали друг на друга').toBeLessThan(right.vMin);
      expect(left.vMin).toBeCloseTo(0, 2);
      expect(right.vMax).toBeCloseTo(1, 2);

      // Геометрия цела: два квадрата — четыре треугольника.
      expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    }, 120_000);
  }

  it('склейка НЕ сводит части с разными материалами', async () => {
    // Главное, ради чего заготовка и заводилась. join объединяет только то, что делит
    // материал; две части с разными материалами обязаны остаться двумя вызовами
    // отрисовки. Сведи их в один — и одна из карт исчезнет с модели.
    const { result, doc } = await build(['safe', 'join']);
    expect(result.status).toBe('ok');
    expect(doc.getRoot().listMaterials().length, 'материалы слиты — одна из карт пропала').toBe(2);
    expect(doc.getRoot().listTextures().length, 'текстуры слиты').toBe(2);
    expect(result.metrics.after.drawCalls, 'части с разными материалами свели в один вызов').toBe(2);
  }, 120_000);
});
