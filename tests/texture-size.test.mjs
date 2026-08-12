// tests/texture-size.test.mjs — размерность текстур: замер в ядре и сверка с порогом.
//
// Зачем этот набор. До 2026-08-12 размерности не было вовсе, и порог `textureMaxSize`
// лежал ВО ВСЕХ профилях мёртвым: число человеку показывали, сверить его было не с чем.
// Дыра была записана в трёх местах (README, `profiles/_none.json`, `ЧТО_УМЕЕТ.md`) —
// значит и закрытие обязано быть под сторожем, иначе оно вернётся молча.
//
// Проверяется ровно две вещи и обе по отдельности:
//   1. ядро МЕРИТ — и мерит большую сторону, а не площадь и не первую попавшуюся;
//   2. ассистент СВЕРЯЕТ — и не выносит оценку там, где мерить было нечего.
//
// Второе важнее: ноль в этой метрике означает «текстур нет либо размер не прочитался»,
// а не «ноль пикселей». Зелёная строка «0 при рекомендуемых 2048» была бы враньём.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';

import { collectMetrics } from '../addons/gltf/metrics.mjs';
import { explainResult } from '../assistant.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'texture-size-'));
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Документ с одной текстурой заданного размера. Картинка настоящая, а не заглушка. */
async function docWithTexture(width, height) {
  const raw = crypto.randomBytes(width * height * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();

  const doc = new Document();
  doc.createBuffer();
  const tex = doc.createTexture('tex').setMimeType('image/png').setImage(png);
  const mat = doc.createMaterial('mat').setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setMaterial(mat);
  doc.createScene('Scene').addChild(doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim)));
  return doc;
}

describe('ядро мерит размерность текстур', () => {
  it('квадратная текстура: наибольшая сторона равна стороне', async () => {
    const doc = await docWithTexture(256, 256);
    expect(collectMetrics(doc, 0).textureMaxSize).toBe(256);
  });

  // Порог площадки задан ОДНОЙ стороной («textures width/height maximum 2048» у
  // Khronos), поэтому сравнивать надо по большей стороне. Площадь или ширина дали бы
  // другой ответ на этой же текстуре — 512 против 1024.
  it('неквадратная: берётся БОЛЬШАЯ сторона, а не ширина и не площадь', async () => {
    const doc = await docWithTexture(512, 1024);
    expect(collectMetrics(doc, 0).textureMaxSize).toBe(1024);
  });

  it('несколько текстур: берётся самая крупная', async () => {
    const doc = await docWithTexture(128, 128);
    const big = await sharp(crypto.randomBytes(64 * 640 * 4), { raw: { width: 64, height: 640, channels: 4 } })
      .png().toBuffer();
    doc.createTexture('second').setMimeType('image/png').setImage(big);
    expect(collectMetrics(doc, 0).textureMaxSize).toBe(640);
  });

  it('модель без текстур даёт ноль, а не выдуманное число', () => {
    const doc = new Document();
    doc.createScene('Scene');
    expect(collectMetrics(doc, 0).textureMaxSize).toBe(0);
  });

  // Битую картинку читать нечем, и это НЕ повод уронить весь замер: остальные метрики
  // модели нужны человеку независимо от того, что экспортёр положил в текстуру.
  it('нечитаемая картинка пропускается, замер не падает', () => {
    const doc = new Document();
    doc.createBuffer();
    doc.createTexture('broken').setMimeType('image/ktx2').setImage(new Uint8Array([1, 2, 3, 4]));
    doc.createScene('Scene');
    expect(() => collectMetrics(doc, 0)).not.toThrow();
    expect(collectMetrics(doc, 0).textureMaxSize).toBe(0);
  });

  const REPO_MODEL = 'Orphan Texture Cube 01.glb';
  const body = async () => {
    const doc = await new NodeIO().read(modelPath(REPO_MODEL));
    const size = collectMetrics(doc, 0).textureMaxSize;
    expect(size, 'у модели корпуса с текстурой размер не прочитался').toBeGreaterThan(0);
  };
  if (isPresent(REPO_MODEL)) it(`на модели корпуса ${REPO_MODEL} размер читается`, body);
  else it.skip(`${REPO_MODEL} отсутствует локально`, () => {});
});

describe('сверка размерности с порогом площадки', () => {
  const withSize = (px) => ({
    status: 'ok',
    metrics: {
      before: { fileBytes: 1, gpuBytes: 1, triangles: 1, materials: 1, drawCalls: 1, textureMaxSize: px },
      after: { fileBytes: 1, gpuBytes: 1, triangles: 1, materials: 1, drawCalls: 1, textureMaxSize: px },
    },
  });
  const checkOf = (px, platform = '') => explainResult(withSize(px), platform, 'ru')
    .budgetChecks.find((c) => c.id === 'textureMaxSize');

  it('4096 при рекомендованных 2048 — жёлтый, с советом', () => {
    const check = checkOf(4096);
    expect(check, 'строки про размер текстуры нет вовсе — порог снова мёртв').toBeTruthy();
    expect(check.level).toBe('warn');
    expect(check.advice, 'жёлтое число без объяснения бесполезно').toBeTruthy();
  });

  it('1024 укладывается — зелёный', () => {
    expect(checkOf(1024).level).toBe('ok');
  });

  // Главная ловушка этой метрики: ноль означает «мерить было нечего».
  it('ноль не даёт зелёной строки — мерить было нечего, а не «уложились»', () => {
    expect(checkOf(0), 'модель без текстур отчиталась об уложенном бюджете').toBeUndefined();
  });

  it('порог показывается вместе со ссылкой на источник', () => {
    const check = checkOf(4096);
    expect(check.warnText, 'не сказано, какое число рекомендовано').toBeTruthy();
    expect(check.source || check.by, 'число без источника — ровно то, что запрещено').toBeTruthy();
  });
});
