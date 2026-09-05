import { describe, it, expect, beforeAll } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import gltfAddon from '../addons/gltf/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

const COMBOS = [
  { name: 'passthrough',        flags: [] },
  { name: 'safe',               flags: ['safe'] },
  { name: 'safe+join',          flags: ['safe', 'join'] },
  { name: 'safe+join+instance', flags: ['safe', 'join', 'instance'] },
  { name: 'safe+meshopt',       flags: ['safe', 'meshopt'] },
  { name: 'safe+draco',         flags: ['safe', 'draco'] },
  { name: 'safe+ktx2',          flags: ['safe', 'ktx2'] },
  { name: 'safe+resample',      flags: ['safe', 'resample'] },
  { name: 'safe+webp',          flags: ['safe', 'webp'] },
  { name: 'safe+draco+ktx2',    flags: ['safe', 'draco', 'ktx2'] },
];

const GROWTH_LIMIT_PCT = 25;
const TEST_TIMEOUT_MS = 300_000;

const inputExists = fs.existsSync(INPUT_DIR);
let inputModels = [];
if (inputExists) {
  inputModels = fs.readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    .sort();
}

const MATRIX_TOTAL = inputModels.length * COMBOS.length;

const shouldRun = process.env.FULL_MATRIX === '1';


const ioPromise = gltfAddon.createIO();

async function imageBytesOf(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  let bytes = 0;
  for (const t of doc.getRoot().listTextures()) bytes += t.getImage()?.byteLength || 0;
  return bytes;
}

function metricsAreSound(m) {
  if (!m || typeof m !== 'object') return false;
  const required = [
    'fileBytes', 'drawCalls', 'triangles', 'vertices',
    'textureBytes', 'gpuBytes', 'meshes', 'materials',
    'nodes', 'animations',
  ];
  for (const k of required) {
    if (!(k in m)) return false;
    const v = m[k];
    if (v === null || v === undefined) return false;
    if (typeof v === 'number' && Number.isNaN(v)) return false;
  }
  return true;
}

function hasFailReason(result) {
  if (result.error && typeof result.error === 'string' && result.error.length > 0) return true;
  if (Array.isArray(result.validation) && result.validation.some((v) => v.level === 'fail')) return true;
  return false;
}


const matrixDescribe = shouldRun ? describe : describe.skip;

matrixDescribe(`Input folder — matrix: ${inputModels.length} models × ${COMBOS.length} combos = ${MATRIX_TOTAL} runs`, () => {
  beforeAll(() => {
    if (!inputExists || inputModels.length === 0) {
      console.warn('  ⚠️  input/ directory empty or missing — matrix tests will have nothing to run.');
    }
  });

  for (const combo of COMBOS) {
    describe(`${combo.name} [${combo.flags.join(',') || 'none'}]`, () => {
      it.each(inputModels)(
        `${combo.name}: %s`,
        async (modelName) => {
          const modelFullPath = path.join(INPUT_DIR, modelName);
          expect(fs.existsSync(modelFullPath)).toBe(true);

          const isWebp = combo.flags.includes('webp');
          const tmpOutDir = isWebp ? fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-webp-')) : null;

          let result;
          try {
            result = await optimizeFile(modelFullPath, {
              advancedFeatures: combo.flags,
              dryRun: !isWebp,
              outDir: tmpOutDir || undefined,
            });
          } catch (e) {
            throw new Error(
              `optimizeFile бросил исключение на ${modelName} / ${combo.name}: ${e.message}`,
              { cause: e },
            );
          }

          try {
            expect(result.status, `status undefined on ${modelName} / ${combo.name}`).toBeDefined();
            expect(['ok', 'fail', 'skip']).toContain(result.status);

            if (result.status === 'ok') {
              expect(metricsAreSound(result.metrics.before),
                `metrics.before broken on ${modelName} / ${combo.name}`).toBe(true);
              expect(metricsAreSound(result.metrics.after),
                `metrics.after broken on ${modelName} / ${combo.name}`).toBe(true);

              const triBefore = result.metrics.before.triangles;
              const triAfter = result.metrics.after.triangles;
              expect(triAfter,
                `triangles grew ${triBefore} → ${triAfter} on ${modelName} / ${combo.name}`
              ).toBeLessThanOrEqual(triBefore);

              if (!combo.flags.includes('ktx2')) {
                const fileBefore = result.metrics.before.fileBytes;
                const fileAfter = result.metrics.after.fileBytes;
                const limit = Math.ceil(fileBefore * (1 + GROWTH_LIMIT_PCT / 100));

                if (fileAfter > limit) {
                  const allRecords = [
                    ...(result.findings || []), ...(result.skipped || []),
                    ...(result.applied || []),
                  ];
                  const explained = allRecords.some((r) => {
                    const id = String(r.i18n?.text?.messageId || '');
                    if (id.includes('inputCompression')) return true;
                    return r.ruleId === 'scene/join';
                  });
                  expect(explained,
                    `file grew >${GROWTH_LIMIT_PCT}% БЕЗ объяснения в отчёте: `
                    + `${fileBefore} → ${fileAfter} on ${modelName} / ${combo.name}`
                  ).toBe(true);
                }
              } else {
                const gpuBefore = result.metrics.before.gpuBytes;
                const gpuAfter = result.metrics.after.gpuBytes;
                if (gpuBefore > 0) {
                  expect(gpuAfter,
                    `gpuBytes grew under ktx2: ${gpuBefore} → ${gpuAfter} on ${modelName}`
                  ).toBeLessThan(gpuBefore);
                }
              }

              if (isWebp) {
                const imgBefore = await imageBytesOf(modelFullPath);
                const imgAfter = await imageBytesOf(result.file.dst);
                expect(imgAfter,
                  `images grew: ${imgBefore} → ${imgAfter} bytes on ${modelName} / ${combo.name}`
                ).toBeLessThanOrEqual(imgBefore);
              }
            }

            if (result.status === 'fail') {
              expect(hasFailReason(result),
                `fail без причины на ${modelName} / ${combo.name}`
              ).toBe(true);
            }
          } finally {
            if (tmpOutDir) {
              try { fs.rmSync(tmpOutDir, { recursive: true, force: true }); } catch {  }
            }
          }
        },
        TEST_TIMEOUT_MS,
      );
    });
  }
});
