// Large texture edge case tests — проверка обработки больших текстур (4K+) с KTX2.
//
// KTX2 правило конвертирует JPEG/PNG → PNG → toktx. Большие текстуры (4K+)
// требуют значительной памяти (4096×4096 RGBA raw ≈ 67 MB; 8192×4096 ≈ 134 MB).
// Тест проверяет, что пайплайн не падает с OOM/crash при worst-case текстурах.
//
// Текстуры генерируются с реальным шумом (crypto.randomBytes), а не solid color:
// шум принципиально несжимаем PNG-компрессией — это даёт реальную memory load
// при декодировании в raw RGBA и при перекодировании JPEG→PNG.
//
// Проверяет:
// 1. Модель с шумовой текстурой 4096×4096 + ktx2 — не краш, статус ok/fail
// 2. Модель с шумовой текстурой 8192×4096 (2:1 ultrawide) + ktx2 — не краш
// 3. Модель с шумовой текстурой 1×16384 (экстремальный aspect) + ktx2 — не краш
// 4. textureBytes > 0 до и после — текстура не потеряна
// 5. Core invariant: треугольники сохранены

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.resolve(PROJECT_ROOT, 'fixtures', '_large_tex_test');
const TIMEOUT = 120000;

const LARGE_MODELS = {};

// Генерация RGBA noise-буфера заданного размера
function generateNoiseBuffer(width, height) {
  return crypto.randomBytes(width * height * 4);
}

// Генерация тестовых GLB-файлов с шумовыми текстурами
beforeAll(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const io = new NodeIO();

  for (const [label, width, height] of [
    ['4k_square', 4096, 4096],     // 67 MB raw
    ['8k_wide', 8192, 4096],       // 134 MB raw
    ['1xnarrow', 1, 16384],        // 64 KB raw — экстремальный aspect
  ]) {
    // Генерация шумовой PNG: несжимаемый контент → worst-case для памяти
    const noiseRaw = generateNoiseBuffer(width, height);
    const texBuffer = await sharp(noiseRaw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    // Создаём GLB-документ с этой текстурой
    const doc = new Document();
    doc.createBuffer(); // необходим для хранения данных текстуры
    const tex = doc.createTexture(`${label}_tex`)
      .setMimeType('image/png')
      .setImage(texBuffer);

    const mat = doc.createMaterial(`${label}_mat`)
      .setBaseColorTexture(tex);

    const mesh = doc.createMesh(`${label}_mesh`)
      .addPrimitive(
        doc.createPrimitive()
          .setAttribute('POSITION', doc.createAccessor()
            .setArray(new Float32Array([
              -1, -1, 0,
               1, -1, 0,
               1,  1, 0,
              -1,  1, 0,
            ]))
            .setType('VEC3')
          )
          .setAttribute('TEXCOORD_0', doc.createAccessor()
            .setArray(new Float32Array([
              0, 0,
              1, 0,
              1, 1,
              0, 1,
            ]))
            .setType('VEC2')
          )
          .setIndices(doc.createAccessor()
            .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
            .setType('SCALAR')
          )
          .setMaterial(mat),
      );

    const scene = doc.createScene(`${label}_scene`).addChild(
      doc.createNode(`${label}_node`).setMesh(mesh),
    );
    doc.getRoot().setDefaultScene(scene);

    const glbPath = path.join(FIXTURE_DIR, `${label}.glb`);
    await io.write(glbPath, doc);
    LARGE_MODELS[label] = glbPath;

    const noiseMb = (noiseRaw.length / 1024 / 1024).toFixed(1);
    const pngMb = (texBuffer.length / 1024 / 1024).toFixed(1);
    const glbMb = (fs.statSync(glbPath).size / 1024 / 1024).toFixed(1);
    console.log(`  • ${label}: ${width}×${height} → raw ${noiseMb} MB, PNG ${pngMb} MB, GLB ${glbMb} MB`);
  }
});

afterAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    for (const f of fs.readdirSync(FIXTURE_DIR)) {
      try { fs.rmSync(path.join(FIXTURE_DIR, f)); } catch { /* ок */ }
    }
    try { fs.rmSync(FIXTURE_DIR); } catch { /* ок */ }
  }
});

// ---- 4K квадратная шумовая текстура ----

describe('Large texture — 4K noise (4096×4096)', () => {
  it('ktx2 does not crash on noise 4K texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);

    if (result.status === 'fail') {
      const hasDiagnostics = result.validation.some((v) => v.level === 'fail') || !!result.error;
      expect(hasDiagnostics).toBe(true);
    }

    // Core invariant: треугольники сохранены (2 треугольника)
    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    // Текстура на месте
    expect(result.metrics.after.textures).toBe(1);
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
  }, TIMEOUT);

  it('baseline pipeline works alongside 4K noise texture + ktx2', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);

    if (result.status === 'ok') {
      expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    }
  }, TIMEOUT);
});

// ---- 8K ultrawide (2:1) ----

describe('Large texture — 8K noise (8192×4096)', () => {
  it('ktx2 does not crash on noise 8K wide texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['8k_wide'], {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    expect(result.metrics.after.textures).toBe(1);
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---- 1×16384 (экстремальный узкий формат) ----

describe('Large texture — 1×16384 noise strip', () => {
  it('ktx2 does not crash on extreme aspect ratio noise texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['1xnarrow'], {
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    expect(result.metrics.after.textures).toBe(1);
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---- KTX2 vs default: сравнение метрик ----

describe('Large texture — metrics comparison', () => {
  it('default pipeline (without ktx2) handles 4K noise texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      advancedFeatures: [],
      dryRun: true,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textures).toBe(1);
  }, TIMEOUT);

  it('all 3 noise textures report non-zero textureBytes', async () => {
    for (const [label, glbPath] of Object.entries(LARGE_MODELS)) {
      const result = await optimizeFile(glbPath, {
        advancedFeatures: ['ktx2'],
        dryRun: true,
      });

      expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
      expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
    }
  }, TIMEOUT * 3);
});

// ---- Статистика ----

describe('Large texture — stats', () => {
  it(`${Object.keys(LARGE_MODELS).length} noise-texture models created`, () => {
    expect(Object.keys(LARGE_MODELS).length).toBe(3);
    for (const [label, p] of Object.entries(LARGE_MODELS)) {
      expect(fs.existsSync(p)).toBe(true);
      const mb = (fs.statSync(p).size / 1024 / 1024).toFixed(1);
      console.log(`  • ${label}: ${mb} MB`);
    }
  });
});
