import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(os.tmpdir(), 'glb_optimize_large_tex_' + Date.now());
const TIMEOUT_LONG = 360_000;

const LARGE_MODELS = {};

function generateNoiseBuffer(width, height) {
  return crypto.randomBytes(width * height * 4);
}

beforeAll(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  try {
    const io = new NodeIO();

    for (const [label, width, height] of [
      ['4k_square', 4096, 4096],
      ['8k_wide', 8192, 4096],
      ['1xnarrow', 1, 16384],
    ]) {
      const noiseRaw = generateNoiseBuffer(width, height);
      const texBuffer = await sharp(noiseRaw, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();

      const doc = new Document();
      doc.createBuffer();
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
  } catch (e) {
    try {
      if (fs.existsSync(FIXTURE_DIR)) {
        fs.rmSync(FIXTURE_DIR, { force: true, recursive: true });
      }
    } catch (cleanupError) {
      console.warn(`cleanup: cannot remove ${FIXTURE_DIR} (${cleanupError.message}); оригинальная ошибка ниже`);
    }
    throw e;
  }
});

afterAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    for (const f of fs.readdirSync(FIXTURE_DIR)) {
      try { fs.rmSync(path.join(FIXTURE_DIR, f)); } catch {  }
    }
    try { fs.rmSync(FIXTURE_DIR); } catch {  }
  }
});


describe('Large texture — 4K noise (4096×4096)', () => {
  it('ktx2 does not crash on noise 4K texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.status).toBeOneOf(['ok', 'fail']);

    if (result.status === 'fail') {
      const hasDiagnostics = result.validation.some((v) => v.level === 'fail') || !!result.error;
      expect(hasDiagnostics).toBe(true);
    }

    const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(delta).toBeLessThanOrEqual(10);

    expect(result.metrics.after.textures).toBe(1);
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
  }, TIMEOUT_LONG);

  it('safe + meshopt + ktx2 work alongside 4K noise texture (no crash)', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt', 'ktx2'],
      dryRun: true,
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);

    expect(result.status).toBeOneOf(['ok', 'fail']);
    if (result.status === 'ok') {
      expect(result.applied.some((a) => a.ruleId === 'textures/ktx2')).toBe(true);
    }
  }, TIMEOUT_LONG);
});


describe('Large texture — 8K noise (8192×4096)', () => {
  it('ktx2 does not crash on noise 8K wide texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['8k_wide'], {
      outDir: tmpOutDir(),
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
  }, TIMEOUT_LONG);
});


describe('Large texture — 1×16384 noise strip', () => {
  it('ktx2 does not crash on extreme aspect ratio noise texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['1xnarrow'], {
      outDir: tmpOutDir(),
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
  }, TIMEOUT_LONG);
});


describe('Large texture — metrics comparison', () => {
  it('default pipeline (without ktx2) handles 4K noise texture', async () => {
    const result = await optimizeFile(LARGE_MODELS['4k_square'], {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
    expect(result.metrics.after.textures).toBe(1);
  });

  it('all 3 noise textures report non-zero textureBytes', async () => {
    for (const [, glbPath] of Object.entries(LARGE_MODELS)) {
      const result = await optimizeFile(glbPath, {
        outDir: tmpOutDir(),
        advancedFeatures: ['ktx2'],
        dryRun: true,
      });

      expect(result.metrics.before.textureBytes).toBeGreaterThan(0);
      expect(result.metrics.after.textureBytes).toBeGreaterThan(0);
    }
  }, TIMEOUT_LONG);
});


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

afterAll(cleanupTmpOutDirs);
