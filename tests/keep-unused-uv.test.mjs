import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as fns from '@gltf-transform/functions';

import { optimizeFile, inspectFile } from '../optimize2.mjs';
import { dropUnusedExceptUv } from '../addons/gltf/prune-attributes.mjs';
import { REPO_MODELS, modelPath } from './helpers/model-files.mjs';

const мусор = [];
afterAll(() => {
  for (const d of мусор) fs.rmSync(d, { recursive: true, force: true });
});

function панель({ сНормалями = false } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const куски = [Buffer.from(pos.buffer), Buffer.from(uv.buffer)];
  if (сНормалями) куски.push(Buffer.from(nrm.buffer));
  const bin = Buffer.concat(куски);
  const attributes = { POSITION: 0, TEXCOORD_0: 1 };
  if (сНормалями) attributes.NORMAL = 2;
  const material = { name: 'Дуб', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.45, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 } };
  if (сНормалями) material.extensions = { KHR_materials_unlit: {} };
  const json = {
    asset: { version: '2.0', generator: 'Tanyra3D test (configurator panel)' },
    ...(сНормалями ? { extensionsUsed: ['KHR_materials_unlit'] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Панель' }],
    meshes: [{ name: 'Панель', primitives: [{ attributes, material: 0 }] }],
    materials: [material],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 6, type: 'VEC2', min: [0, 0], max: [1, 1] },
      ...(сНормалями ? [{ bufferView: 2, componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 1], max: [0, 0, 1] }] : []),
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength, target: 34962 },
      ...(сНормалями ? [{ buffer: 0, byteOffset: pos.byteLength + uv.byteLength, byteLength: nrm.byteLength, target: 34962 }] : []),
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (b, f) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), f)]) : b);
  const jc = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const bc = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.writeUInt32LE(0x004e4942, 4);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-src-'));
  мусор.push(dir);
  const file = path.join(dir, 'Панель конфигуратора.glb');
  fs.writeFileSync(file, Buffer.concat([head, jh, jc, bh, bc]));
  return file;
}

const читать = (f) => {
  const b = fs.readFileSync(f);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
};
const атрибуты = (f) => Object.keys(читать(f).meshes[0].primitives[0].attributes).sort();

const собрать = async (src, features) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-out-'));
  мусор.push(outDir);
  const r = await optimizeFile(src, { advancedFeatures: features, outDir, locale: 'ru' });
  expect(r.status, `сборка не прошла: ${r.error || ''}`).not.toBe('fail');
  return r;
};

describe('развёртка без картинок', () => {
  it('умолчание не изменилось: без просьбы чистка её убирает', async () => {
    const r = await собрать(панель(), ['safe']);
    expect(атрибуты(r.file.dst), 'развёртка вдруг стала сохраняться сама').toEqual(['POSITION']);
  }, 300000);

  it('по просьбе развёртка доезжает целой', async () => {
    const r = await собрать(панель(), ['safe', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'развёртку убрали, хотя просили оставить')
      .toEqual(['POSITION', 'TEXCOORD_0']);
  }, 300000);

  it('просьба доходит до конца конвейера, а не до середины', async () => {
    const r = await собрать(панель(), ['safe', 'join', 'meshopt', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'до конца конвейера просьба не дошла')
      .toContain('TEXCOORD_0');
  }, 300000);

  it('отчёт говорит, что оставил, — иначе человек не узнает, применилось ли', async () => {
    const r = await собрать(панель(), ['safe', 'keep-unused-uv']);
    const текст = [...(r.applied || []), ...(r.findings || [])]
      .map((f) => String(f.message || f.text || '')).join('\n');
    expect(текст, 'о сохранении развёртки не сказано ни слова').toMatch(/оставлен/i);
  }, 300000);

  it('движок считает, у скольких частей развёртка есть, а карт нет', async () => {
    const insp = await inspectFile(панель());
    expect(insp.metrics.uvWithoutTextures, 'панель без карт не посчитана').toBe(1);
  }, 300000);
});



describe('просьба точечная, а не «оставь всё»', () => {
  it('нормали у несветящегося материала уходят, развёртка остаётся', async () => {
    const r = await собрать(панель({ сНормалями: true }), ['safe', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'вместе с развёрткой оставили и то, чего не просили')
      .toEqual(['POSITION', 'TEXCOORD_0']);
  }, 300000);

  it('без просьбы уходит и то и другое — умолчание не поехало', async () => {
    const r = await собрать(панель({ сНормалями: true }), ['safe']);
    expect(атрибуты(r.file.dst), 'умолчание перестало убирать лишнее').toEqual(['POSITION']);
  }, 300000);
});


function остаток(doc) {
  const out = new Map();
  doc.getRoot().listMeshes().forEach((mesh, mi) => {
    mesh.listPrimitives().forEach((prim, pi) => {
      out.set(`меш${mi}/прим${pi}`, prim.listSemantics().filter((sem) => !sem.startsWith('TEXCOORD_')).sort());
    });
  });
  return out;
}

describe('согласие с библиотекой', () => {
  it('наш отбор совпадает с библиотечным с точностью до развёртки', async () => {
    const io2 = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const расхождения = [];
    let сверено = 0;
    let снято = 0;

    for (const name of [...REPO_MODELS].sort()) {
      let исходный;
      try {
        исходный = await io2.read(modelPath(name));
      } catch (e) {
        if (e?.code === 'ENOENT' || !fs.existsSync(modelPath(name))) throw e;
        continue;
      }

      const наш = fns.cloneDocument(исходный);
      снято += dropUnusedExceptUv(наш).length;
      await наш.transform(fns.prune({ keepAttributes: true, keepLeaves: false }));

      const библиотечный = fns.cloneDocument(исходный);
      await библиотечный.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));

      const a = остаток(наш);
      const b = остаток(библиотечный);
      const ключи = new Set([...a.keys(), ...b.keys()]);
      for (const k of ключи) {
        const наше = (a.get(k) || []).join(',');
        const их = (b.get(k) || []).join(',');
        if (наше !== их) расхождения.push(`${name} ${k}: у нас [${наше}], у библиотеки [${их}]`);
      }
      сверено += 1;
    }

    expect(расхождения, 'наш счёт разошёлся с библиотечным').toEqual([]);
    expect(сверено, 'ни одной модели корпуса не удалось прочитать').toBeGreaterThanOrEqual(10);
    expect(снято, 'на корпусе не нашлось ни одного лишнего атрибута — сторожу нечего сторожить')
      .toBeGreaterThan(0);
  }, 300000);
});



describe('след просьбы в отчёте', () => {
  const следов = (r) => [...(r.applied || []), ...(r.findings || [])]
    .filter((f) => /развёртка оставлена/i.test(String(f.message || f.text || ''))).length;

  it('без safe — сжатие геометрии тоже сохраняет развёртку и говорит об этом', async () => {
    const r = await собрать(панель(), ['meshopt', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'развёртку убрали, хотя просили оставить').toContain('TEXCOORD_0');
    expect(следов(r), 'развёртку сохранили молча — человек не увидел следа флажка').toBe(1);
  }, 300000);

  it('без safe — склейка ведёт себя так же', async () => {
    const r = await собрать(панель(), ['join', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'развёртку убрали, хотя просили оставить').toContain('TEXCOORD_0');
    expect(следов(r), 'развёртку сохранили молча').toBe(1);
  }, 300000);

  it('с safe и сжатием сразу — след всё равно ОДИН', async () => {
    const r = await собрать(панель(), ['safe', 'meshopt', 'keep-unused-uv']);
    expect(следов(r), 'одна просьба — одна строка').toBe(1);
  }, 300000);

  it('не просили — не говорим', async () => {
    const r = await собрать(панель(), ['safe', 'meshopt']);
    expect(следов(r), 'отчёт сообщил о том, чего человек не просил').toBe(0);
  }, 300000);
});
