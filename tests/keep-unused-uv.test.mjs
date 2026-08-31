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
//
// Модель строится здесь: нужна панель С развёрткой и БЕЗ единой карты, а искать такую
// среди готовых значило бы проверять не то.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile, inspectFile } from '../optimize2.mjs';

const мусор = [];
afterAll(() => {
  for (const d of мусор) fs.rmSync(d, { recursive: true, force: true });
});

/** Панель конфигуратора: развёртка есть, материал с цветом, ни одной картинки. */
function панель() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer)]);
  const json = {
    asset: { version: '2.0', generator: 'Tanyra3D test (configurator panel)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Панель' }],
    meshes: [{ name: 'Панель', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ name: 'Дуб', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.45, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 6, type: 'VEC2', min: [0, 0], max: [1, 1] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength, target: 34962 },
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
