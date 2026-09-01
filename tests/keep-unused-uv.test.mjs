// tests/keep-unused-uv.test.mjs — развёртка, которой пока не пользуется ни одна картинка.
//
// ЗАКАЗ (Александр, 2026-08-29): «если я готовлю для конфигуратора мебель или предметы,
// там могут быть уже готовы юви, но не быть прикрепленной никакой текстуры даже простой,
// и модель нужна нам для конфигуратора на сайте где клиент может выбирать кучи разных
// вариантов покрытия. что наше приложение сделает с такой юви?»
//
// Делало оно с ней вот что: убирало. И это было ЕГО ЖЕ решением от 2026-08-22 — «так и
// должно быть, что удаляется юви канал». Здесь оно пересмотрено, и пересмотрено УЗКО:
// умолчание не изменилось ни на шаг, появилась возможность сказать «не убирай».
//
// ЧТО СТЕРЕЖЁТСЯ И ПОЧЕМУ ИМЕННО ЭТО:
//
//   1. Умолчание. Без просьбы развёртка по-прежнему уходит — иначе пересмотр превратился
//      бы в тихую смену поведения у всех.
//   2. Просьба доходит до КОНЦА конвейера. Первая редакция сохраняла развёртку в чистке и
//      теряла её в финальной подчистке: у библиотеки умолчание `keepAttributes: false`, и
//      второй проход сносил её снова. Отчёт при этом рапортовал, что всё оставлено, —
//      то есть врал. Ловится только сквозным прогоном, поэтому проверка сквозная.
//   3. Метрика, по которой интерфейс решает, показывать ли строку вообще (Правило 12).
//   4. ТОЧЕЧНОСТЬ просьбы и согласие с библиотекой. Первая редакция оставляла вместе с
//      развёрткой всё прочее — нормали, касательные, лишние цветовые каналы, — потому что
//      ручка у библиотеки одна на все данные вершин. Человек платил за то, чего не
//      просил: у `parkergirl` развёртка весит 2 КБ из 212. Александр, 2026-09-01: «мы
//      ранее когда просто сейф оптимизацию делали всё лишнее сносили. мы не можем сделать
//      так же, но оставлять юви неиспользуемую?» Теперь отбор наш (`prune-attributes.mts`),
//      и у своей копии чужого счёта ровно один способ навредить — разойтись с оригиналом
//      МОЛЧА. Против этого стоит раздел «согласие с библиотекой».
//
// Модель строится здесь: нужна панель С развёрткой и БЕЗ единой карты, а искать такую
// среди готовых значило бы проверять не то.

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

/**
 * Панель конфигуратора: развёртка есть, материал с цветом, ни одной картинки.
 *
 * `сНормалями` добавляет НОРМАЛИ и делает материал несветящимся (`KHR_materials_unlit`).
 * Такому материалу нормали не нужны ни для чего — это второй класс лишних данных вершин,
 * и он нужен, чтобы отличить «оставили развёртку» от «оставили вообще всё».
 */
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
    // Решение Александра от 2026-08-22 в силе. Пересмотр добавил выбор, а не сменил
    // поведение у всех.
    const r = await собрать(панель(), ['safe']);
    expect(атрибуты(r.file.dst), 'развёртка вдруг стала сохраняться сама').toEqual(['POSITION']);
  }, 300000);

  it('по просьбе развёртка доезжает целой', async () => {
    const r = await собрать(панель(), ['safe', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'развёртку убрали, хотя просили оставить')
      .toEqual(['POSITION', 'TEXCOORD_0']);
  }, 300000);

  it('просьба доходит до конца конвейера, а не до середины', async () => {
    // Сторож найденной поломки: чистка развёртку сохраняла, а финальная подчистка сносила
    // её снова — у библиотеки умолчание `keepAttributes: false`. Отчёт при этом говорил,
    // что всё оставлено. Набор здесь нарочно ПОЛНЫЙ: финальная подчистка включается и от
    // склейки, и от сжатия, а не только от safe.
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
    // По этому числу интерфейс решает, показывать ли подчинённую строку (Правило 12):
    // сохранять нечего — строки нет.
    const insp = await inspectFile(панель());
    expect(insp.metrics.uvWithoutTextures, 'панель без карт не посчитана').toBe(1);
  }, 300000);
});


// ============================================================================
// 4. Точечность: просьба про развёртку — просьба ТОЛЬКО про развёртку.
// ============================================================================

describe('просьба точечная, а не «оставь всё»', () => {
  it('нормали у несветящегося материала уходят, развёртка остаётся', async () => {
    // Первая редакция оставляла и то и другое: ручка у библиотеки одна на все данные
    // вершин. Человек просил развёртку, а платил нормалями — у `parkergirl` это +65%
    // при развёртке в 2 КБ. Здесь красное означает возврат к тому поведению.
    const r = await собрать(панель({ сНормалями: true }), ['safe', 'keep-unused-uv']);
    expect(атрибуты(r.file.dst), 'вместе с развёрткой оставили и то, чего не просили')
      .toEqual(['POSITION', 'TEXCOORD_0']);
  }, 300000);

  it('без просьбы уходит и то и другое — умолчание не поехало', async () => {
    const r = await собрать(панель({ сНормалями: true }), ['safe']);
    expect(атрибуты(r.file.dst), 'умолчание перестало убирать лишнее').toEqual(['POSITION']);
  }, 300000);
});

// ============================================================================
// 5. Согласие с библиотекой.
// ============================================================================
// Правила «что материал действительно читает» библиотека наружу не отдаёт, поэтому в
// `addons/gltf/prune-attributes.mts` они ПОВТОРЕНЫ. Своя копия чужого счёта опасна ровно
// одним: она может разойтись с оригиналом молча — библиотека обновится, а мы продолжим
// считать по-старому и начнём сносить нужное или хранить лишнее.
//
// Сторож сверяет ИТОГ, а не код: на каждой модели корпуса гоняется библиотечная чистка и
// наша, и остаток данных вершин обязан совпасть — с точностью до развёртки, которую мы
// как раз и оставляем намеренно.

/** Что осталось у каждого примитива, кроме развёртки: `мешN/примM` → отсортированный список. */
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

    for (const name of [...REPO_MODELS].sort()) {
      let исходный;
      try {
        исходный = await io2.read(modelPath(name));
      } catch {
        // Модель, которую не открыть без внешнего декодера (meshopt) или битая нарочно.
        // Пропуск здесь безопасен: снизу стоит порог на число реально сверенных.
        continue;
      }

      const наш = fns.cloneDocument(исходный);
      dropUnusedExceptUv(наш);
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
    // Сверять оказалось не на чем — тест зелёный и бесполезный. Порог держит его честным.
    expect(сверено, 'ни одной модели корпуса не удалось прочитать').toBeGreaterThanOrEqual(10);
  }, 300000);
});
