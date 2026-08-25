// tests/instance-animated.test.mjs — инстансинг рядом с анимацией.
//
// ПОВОД (Александр, 2026-08-23): «EXT_mesh_gpu_instancing но ведь анимируются не детали
// на которых инстансинги. тогда почему отказывается делать инстанс? исправляй».
//
// Отказ был не наш. `fns.instance()` из @gltf-transform/functions начинается с
// `if (root.listAnimations().length) return` — ОДНА анимация где угодно в файле
// отключала инстансинг целиком, даже если она крутит вентилятор, а инстансить надо полки.
//
// Опасение библиотеки при этом настоящее: инстансинг ЗАПЕКАЕТ мировое преобразование узла
// и убирает меш с самого узла. Анимированный узел после этого замирает — движение
// прекращается, а все числа остаются верными. Поймать это можно только глазом.
//
// Отсюда наша граница: поузловая, а не на весь файл. Непригоден узел, который движется
// сам ИЛИ у которого движется предок. Эти тесты стерегут обе половины — что неподвижное
// инстансится ПРИ анимации в файле, и что движущееся не замирает.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

import '../addons/gltf/index.mjs';
import { instanceStatic } from '../addons/gltf/instance.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-anim-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Сцена из копий одного меша.
 *
 * @param count      сколько копий
 * @param animate    имена узлов, которые двигает анимация
 * @param nest       true — копии лежат ПОД общим родителем (проверка предков)
 */
function scene({ count = 6, animate = [], nest = false } = {}) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const sc = doc.createScene('S');
  doc.getRoot().setDefaultScene(sc);
  const acc = (a, t) => doc.createAccessor().setType(t).setBuffer(buf).setArray(a);
  const mat = doc.createMaterial('m');

  // ОДИН меш на всех — то состояние, в которое `dedup` приводит настоящие копии.
  const prim = doc.createPrimitive().setMode(4)
    .setAttribute('POSITION', acc(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 'VEC3'))
    .setIndices(acc(new Uint16Array([0, 1, 2, 1, 3, 2]), 'SCALAR'))
    .setMaterial(mat);
  const mesh = doc.createMesh('cube').addPrimitive(prim);

  const parent = nest ? doc.createNode('parent') : null;
  if (parent) sc.addChild(parent);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const n = doc.createNode('n' + i).setMesh(mesh).setTranslation([i * 2, 0, 0]);
    nodes.push(n);
    if (parent) parent.addChild(n); else sc.addChild(n);
  }

  if (animate.length) {
    const anim = doc.createAnimation('A');
    const input = acc(new Float32Array([0, 1]), 'SCALAR');
    const output = acc(new Float32Array([0, 0, 0, 0, 5, 0]), 'VEC3');
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler);
    for (const name of animate) {
      const target = name === 'parent' ? parent : nodes[Number(name.slice(1))];
      anim.addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath('translation').setSampler(sampler));
    }
  }
  return { doc, mesh, nodes, parent };
}

const drawNodes = (doc) => doc.getRoot().listNodes().filter((n) => n.getMesh()).length;

describe('инстансинг не пасует перед чужой анимацией', () => {
  it('неподвижные копии собираются в партию, хотя анимация в файле ЕСТЬ', () => {
    // Главное утверждение. Раньше здесь был отказ на весь файл.
    const { doc, nodes } = scene({ count: 6, animate: [] });
    // Заводим анимацию, которая не трогает ни один из наших узлов: отдельный пустой узел.
    const other = doc.createNode('fan');
    doc.getRoot().listScenes()[0].addChild(other);
    const buf = doc.getRoot().listBuffers()[0];
    const acc = (a, t) => doc.createAccessor().setType(t).setBuffer(buf).setArray(a);
    const sampler = doc.createAnimationSampler()
      .setInput(acc(new Float32Array([0, 1]), 'SCALAR'))
      .setOutput(acc(new Float32Array([0, 0, 0, 0, 5, 0]), 'VEC3'))
      .setInterpolation('LINEAR');
    doc.createAnimation('A').addSampler(sampler)
      .addChannel(doc.createAnimationChannel().setTargetNode(other).setTargetPath('translation').setSampler(sampler));

    expect(doc.getRoot().listAnimations().length, 'заготовка без анимации — тест проверял бы не то').toBe(1);
    const res = instanceStatic(doc, { min: 2 });
    expect(res.batches, 'партия не собрана — анимация вентилятора снова отменила весь инстансинг').toBe(1);
    expect(res.instances).toBe(nodes.length);
    expect(res.animatedSkipped, 'неподвижные узлы посчитаны движущимися').toBe(0);
  });

  it('движущиеся узлы в партию НЕ попадают — иначе они замрут', () => {
    // Обратная половина, и без неё первая опасна. Запечённое преобразование
    // останавливает движение, а числа остаются верными: по отчёту не увидишь.
    const { doc } = scene({ count: 6, animate: ['n0', 'n1'] });
    const res = instanceStatic(doc, { min: 2 });
    expect(res.animatedSkipped, 'движущиеся узлы не отмечены').toBe(2);
    expect(res.instances, 'в партию попали движущиеся узлы').toBe(4);
  });

  it('движется предок — потомок тоже непригоден', () => {
    // У предка меняется преобразование, значит меняется и мировое положение потомка.
    // Проверять только сам узел значило бы заморозить всё, что под анимированным.
    const { doc } = scene({ count: 6, animate: ['parent'], nest: true });
    const res = instanceStatic(doc, { min: 2 });
    expect(res.batches, 'собрали партию из узлов под анимированным предком').toBe(0);
    expect(res.animatedSkipped, 'потомки анимированного предка не отмечены').toBe(6);
  });

  it('партия и правда убирает вызовы отрисовки', () => {
    // Смысл всей затеи. Шесть узлов с мешем превращаются в один.
    const { doc } = scene({ count: 6 });
    expect(drawNodes(doc)).toBe(6);
    instanceStatic(doc, { min: 2 });
    expect(drawNodes(doc), 'узлы с мешем не свелись в один — партия не собрана').toBe(1);
  });

  it('узлы со скином не трогаем', () => {
    // Запрет сохранён из библиотеки дословно: у скина своё преобразование.
    const { doc, nodes } = scene({ count: 4 });
    const skin = doc.createSkin('sk');
    for (const n of nodes) n.setSkin(skin);
    const res = instanceStatic(doc, { min: 2 });
    expect(res.batches, 'скиннутые узлы собраны в партию').toBe(0);
  });

  it('расширение и его данные доезжают до ЗАПИСАННОГО файла', async () => {
    // Тест, не открывший файл, проверяет память, а не результат. Смотрим прямо в JSON
    // внутри GLB: расширение должно быть объявлено, а у узла партии — лежать привязка
    // с преобразованиями. Без второй половины файл объявлял бы возможность, которой в
    // нём нет.
    const { doc } = scene({ count: 5 });
    instanceStatic(doc, { min: 2 });
    const file = path.join(tmp, 'batched.glb');
    // Писатель С РАСШИРЕНИЯМИ. Голый NodeIO выбрасывает всё, чего не знает, — и файл
    // выходил бы пустым не по вине правила. Настоящий конвейер регистрирует их так же
    // (optimize2.mjs), поэтому тест повторяет его условия, а не свои.
    await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(file, doc);

    const glb = fs.readFileSync(file);
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString('utf8'));
    expect(json.extensionsUsed || [], 'расширение не объявлено в файле').toContain('EXT_mesh_gpu_instancing');
    const batched = (json.nodes || []).filter((n) => n.extensions && n.extensions.EXT_mesh_gpu_instancing);
    expect(batched.length, 'узла с партией в файле нет').toBe(1);
    expect(batched[0].extensions.EXT_mesh_gpu_instancing.attributes,
      'партия без преобразований — копии сошлись бы в одну точку').toBeTruthy();
  });
});
