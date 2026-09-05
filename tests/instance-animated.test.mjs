import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

import '../addons/gltf/index.mjs';
import { instanceStatic, unbakeCopies } from '../addons/gltf/instance.mjs';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-anim-')); });
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function scene({ count = 6, animate = [], nest = false } = {}) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const sc = doc.createScene('S');
  doc.getRoot().setDefaultScene(sc);
  const acc = (a, t) => doc.createAccessor().setType(t).setBuffer(buf).setArray(a);
  const mat = doc.createMaterial('m');

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
    const { doc, nodes } = scene({ count: 6, animate: [] });
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
    const { doc } = scene({ count: 6, animate: ['n0', 'n1'] });
    const res = instanceStatic(doc, { min: 2 });
    expect(res.animatedSkipped, 'движущиеся узлы не отмечены').toBe(2);
    expect(res.instances, 'в партию попали движущиеся узлы').toBe(4);
  });

  it('движется предок — потомок тоже непригоден', () => {
    const { doc } = scene({ count: 6, animate: ['parent'], nest: true });
    const res = instanceStatic(doc, { min: 2 });
    expect(res.batches, 'собрали партию из узлов под анимированным предком').toBe(0);
    expect(res.animatedSkipped, 'потомки анимированного предка не отмечены').toBe(6);
  });

  it('партия и правда убирает вызовы отрисовки', () => {
    const { doc } = scene({ count: 6 });
    expect(drawNodes(doc)).toBe(6);
    instanceStatic(doc, { min: 2 });
    expect(drawNodes(doc), 'узлы с мешем не свелись в один — партия не собрана').toBe(1);
  });

  it('узлы со скином не трогаем', () => {
    const { doc, nodes } = scene({ count: 4 });
    const skin = doc.createSkin('sk');
    for (const n of nodes) n.setSkin(skin);
    const res = instanceStatic(doc, { min: 2 });
    expect(res.batches, 'скиннутые узлы собраны в партию').toBe(0);
  });

  it('расширение и его данные доезжают до ЗАПИСАННОГО файла', async () => {
    const { doc } = scene({ count: 5 });
    instanceStatic(doc, { min: 2 });
    const file = path.join(tmp, 'batched.glb');
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


describe('одинаковые копии узнаются по форме, а не по ссылке', () => {
  function baked(count, { rotate = false } = {}) {
    const doc = new Document();
    const buf = doc.createBuffer();
    const sc = doc.createScene('S');
    doc.getRoot().setDefaultScene(sc);
    const mat = doc.createMaterial('m');
    const shape = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    for (let i = 0; i < count; i++) {
      const off = i * 3;
      const arr = new Float32Array(shape.length);
      for (let k = 0; k < shape.length; k++) arr[k] = shape[k] + (k % 3 === 0 ? off : 0);
      const acc = (a, t) => doc.createAccessor().setType(t).setBuffer(buf).setArray(a);
      const prim = doc.createPrimitive().setMode(4)
        .setAttribute('POSITION', acc(arr, 'VEC3'))
        .setIndices(acc(new Uint16Array([0, 1, 2, 1, 3, 2]), 'SCALAR'))
        .setMaterial(mat);
      const node = doc.createNode('n' + i).setMesh(doc.createMesh('cube_' + i).addPrimitive(prim));
      if (rotate) node.setRotation([0, 0.7071068, 0, 0.7071068]);
      sc.addChild(node);
    }
    return doc;
  }

  function worldPoints(doc) {
    const out = [];
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const t = node.getWorldTranslation();
      const pos = mesh.listPrimitives()[0].getAttribute('POSITION');
      const pts = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const v = [];
        pos.getElement(i, v);
        pts.push((v[0] + t[0]).toFixed(4), (v[1] + t[1]).toFixed(4), (v[2] + t[2]).toFixed(4));
      }
      out.push(pts.join(','));
    }
    return out.sort();
  }

  it('десять запечённых копий сводятся к одному мешу', () => {
    const doc = baked(10);
    expect(doc.getRoot().listMeshes().length, 'заготовка не про этот случай').toBe(10);
    const res = unbakeCopies(doc);
    expect(res.groups, 'форма не узнана').toBe(1);
    expect(res.merged, 'сведены не все копии').toBe(9);
    expect(doc.getRoot().listMeshes().length, 'лишние меши остались').toBe(1);
  });

  it('КАРТИНКА НЕ МЕНЯЕТСЯ: все вершины остаются на своих местах', () => {
    const doc = baked(10);
    const before = worldPoints(doc);
    unbakeCopies(doc);
    expect(worldPoints(doc), 'детали разъехались — сдвиг перенесён неверно').toEqual(before);
  });

  it('поворот узла учитывается: сдвиг переносится ЧЕРЕЗ его преобразование', () => {
    const doc = baked(6, { rotate: true });
    const before = worldPointsRotated(doc);
    unbakeCopies(doc);
    expect(worldPointsRotated(doc), 'повёрнутые копии разъехались').toEqual(before);
  });

  function worldPointsRotated(doc) {
    const out = [];
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const m = node.getWorldMatrix();
      const pos = mesh.listPrimitives()[0].getAttribute('POSITION');
      const pts = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const v = [];
        pos.getElement(i, v);
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        pts.push(x.toFixed(3), y.toFixed(3), z.toFixed(3));
      }
      out.push(pts.join(','));
    }
    return out.sort();
  }

  it('разные формы не сваливаются в одну', () => {
    const doc = baked(4);
    const odd = doc.getRoot().listMeshes()[2].listPrimitives()[0].getAttribute('POSITION');
    const v = [];
    odd.getElement(1, v);
    odd.setElement(1, [v[0], v[1] + 0.01, v[2]]);
    const res = unbakeCopies(doc);
    expect(doc.getRoot().listMeshes().length, 'непохожий меш сведён с остальными').toBe(2);
    expect(res.merged).toBe(2);
  });

  it('узел с детьми не трогаем — правка утащила бы поддерево', () => {
    const doc = baked(6);
    const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
    nodes[1].addChild(doc.createNode('child'));
    const res = unbakeCopies(doc);
    expect(res.merged).toBe(4);
    expect(nodes[1].getMesh(), 'меш узла с детьми подменили').toBeTruthy();
  });
});
