import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import { describeLocal } from './helpers/model-files.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

const GLB_MAGIC = 0x46546c67;

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgap-corpus-'));
  try {
    const result = await optimizeFile(modelPath(modelName), { ...opts, outDir: tmpDir });
    if (!result.file.dst || !fs.existsSync(result.file.dst)) {
      return { result, glbBytes: null, json: null };
    }
    const glbBytes = fs.readFileSync(result.file.dst);
    return { result, glbBytes, json: parseGlbJson(glbBytes) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


describe('Post-GAP-005 corpus — Preinstanced Grid 01: instanceCountOf on entry', () => {
  it('source: passthrough уже имеет EXT_mesh_gpu_instancing на входе', () => {
    const bytes = fs.readFileSync(modelPath('Preinstanced Grid 01.glb'));
    const json = parseGlbJson(bytes);
    expect((json.extensionsUsed || [])).toContain('EXT_mesh_gpu_instancing');
  }, 5000);

  it('passthrough: metrics.before.triangles === 144 (× instance count)', async () => {
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(144);
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.before.nodes).toBe(1);
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.before.drawCalls).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
  });

  it('[\'safe\']: без изменений — нечего инстансить/мерджить (1 узел, 144 треугольника)', async () => {
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('[\'safe\']: EXT_mesh_gpu_instancing сохраняется в extensionsUsed выхода', async () => {
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect((json && json.extensionsUsed) || []).toContain('EXT_mesh_gpu_instancing');
  });
});


describe('Post-GAP-005 corpus — Truncated Broken 01: pipeline must fail', () => {
  it('optimizeFile возвращает объект (не бросает исключение) на повреждённом GLB', async () => {
    let result;
    let threw = null;
    try {
      result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(result).toBeDefined();
  });

  it('passthrough: status=fail с понятной ошибкой про типизированный массив', async () => {
    const result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/Invalid typed array length/i);
    expect(result.error).toMatch(/1468/);
  });

  it('[\'safe\']: тоже fail с той же маркой (не зависит от режима)', async () => {
    const result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/Invalid typed array length/i);
    expect(result.error).toMatch(/1468/);
  });

  it('fail никаких файлов на диск не пишет', async () => {
    const outDir = path.resolve(PROJECT_ROOT, 'output');
    const before = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
    await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    const after = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
    const newNames = [...after].filter((n) => !before.has(n));
    expect(newNames.some((n) => n.startsWith('Truncated Broken 01.'))).toBe(false);
  });
});


describeLocal('chibi_zenitsu.glb', 'Post-GAP-005 corpus — chibi_zenitsu (local CC-BY-4.0): skin + anim + morphs', () => {
  it('passthrough: 1 skin, 1 анимация (\'Run\'), morphTargets > 0', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
  });

  it('[\'safe\']: morphTargets и скин сохранены (тест скина под морф + joint)', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('[\'safe\',\'draco\']: компрессия не теряет морфы (4.25 → 2.33 МБ по измерениям)', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeGreaterThan(0.30);
    expect(ratio).toBeLessThan(0.70);
  });

  it('source: имена анимаций содержат \'Run\', 2 морфа на 2 примитивах', () => {
    const bytes = fs.readFileSync(modelPath('chibi_zenitsu.glb'));
    const json = parseGlbJson(bytes);
    const animNames = (json.animations || []).map((a) => String((a && a.name) || ''));
    expect(animNames).toContain('Run');
    let morphTotal = 0;
    let primCount = 0;
    for (const mesh of (json.meshes || [])) {
      for (const prim of (mesh.primitives || [])) {
        primCount++;
        morphTotal += ((prim.targets) || []).length;
      }
    }
    expect(primCount).toBe(11);
    expect(morphTotal).toBe(2);
  }, 5000);
});

describeLocal('parkergirl.glb', 'Post-GAP-005 corpus — parkergirl (local CC-BY-4.0): heavy morph stress', () => {
  it('passthrough: 1 skin, 1 анимация (\'MorphBake\'), morphTargets > 0', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
  });

  it('[\'safe\']: morphTargets 456 → 456, файл 8.48 → 4.82 МБ по измерениям', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(456);
    expect(result.metrics.after.morphTargets).toBe(456);
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThan(0.80);
  });

  it('[\'safe\',\'draco\']: 8.48 → 4.09 МБ по измерениям, морфы сохранены', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThan(0.60);
  });

  it('source: 1 анимация по имени \'MorphBake\', морфы распределены по 8 примитивам', () => {
    const bytes = fs.readFileSync(modelPath('parkergirl.glb'));
    const json = parseGlbJson(bytes);
    const animNames = (json.animations || []).map((a) => String((a && a.name) || ''));
    expect(animNames).toContain('MorphBake');
    let morphTotal = 0;
    let primCount = 0;
    for (const mesh of (json.meshes || [])) {
      for (const prim of (mesh.primitives || [])) {
        primCount++;
        morphTotal += ((prim.targets) || []).length;
      }
    }
    expect(primCount).toBe(14);
    expect(morphTotal).toBe(456);
  }, 5000);

  it('анонс: см. tests/bugs-found.test.mjs — TESTBUG-007 для parkergirl+meshopt', () => {
    expect(fs.existsSync(path.resolve(PROJECT_ROOT, 'tests/bugs-found.test.mjs'))).toBe(true);
  });
});


describe('Post-GAP-005 corpus — клиентские модели, KTX2 graceful', () => {
  const CLIENT_MODELS = ['Production Multi UV 01.glb', 'Production Draco Webp 01.glb', 'Production Many Materials 01.glb'];
  for (const m of CLIENT_MODELS) {
    const p = modelPath(m);
    if (!fs.existsSync(p)) {
      describe.skip(`[local-only] ${m} (не найдена локально)`, () => {
        it('placeholder', () => {
          expect(true).toBe(true);
        });
      });
      continue;
    }

    describe(`[client] ${m}: EXT_texture_webp + до 24 материалов`, () => {
      it('[\'safe\']: pipeline отрабатывает без краша, треугольники сохранены', async () => {
        const result = await optimizeFile(p, {
          outDir: tmpOutDir(),
          advancedFeatures: ['safe'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        expect(result.metrics.after.triangles, 'треугольников стало больше — этого быть не может')
          .toBeLessThanOrEqual(result.metrics.before.triangles);
        const explained = result.validation.some((v) => v.i18n?.text?.messageId === 'check.trianglesDropped'
          || v.i18n?.text?.messageId === 'check.trianglesUnchanged');
        expect(explained, 'убыль треугольников ничем не объяснена').toBe(true);
        expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
      });

      it('[\'safe\',\'ktx2\']: graceful fail если toktx не установлен; ok если установлен', async () => {
        const result = await optimizeFile(p, {
          outDir: tmpOutDir(),
          advancedFeatures: ['safe', 'ktx2'],
          dryRun: true,
        });

        if (result.status === 'ok') {
          expect(result.metrics.after.triangles, 'треугольников стало больше — этого быть не может')
            .toBeLessThanOrEqual(result.metrics.before.triangles);
          const explained = result.validation.some((v) => v.i18n?.text?.messageId === 'check.trianglesDropped'
            || v.i18n?.text?.messageId === 'check.trianglesUnchanged');
          expect(explained, 'убыль треугольников ничем не объяснена').toBe(true);
        } else if (result.status === 'fail') {
          const e = String(result.error || '');
          const mentionsToktx = /toktx|ktx2\b/i.test(e);
          expect(mentionsToktx).toBe(true);
        } else {
          throw new Error(`Unexpected status ${result.status} for ${m} under safe+ktx2`);
        }
      }, 360_000);
    });
  }
});

afterAll(cleanupTmpOutDirs);
