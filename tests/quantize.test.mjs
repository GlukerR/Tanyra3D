import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult, render } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath, eachModel, describeLocal, describeIfModels } from './helpers/model-files.mjs';

const ioPromise = gltfAddon.createIO();

async function accessorBytes(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  let n = 0;
  for (const a of doc.getRoot().listAccessors()) n += a.getArray()?.byteLength || 0;
  return n;
}

async function requiredExtensions(file) {
  const io = await ioPromise;
  const doc = await io.read(file);
  return doc.getRoot().listExtensionsRequired().map((e) => e.extensionName);
}

function validatorDidNotWorsen(result) {
  const zero = result.validation.find((v) => v.i18n?.text?.messageId === 'check.validatorZeroErrors');
  if (zero) return zero.level === 'pass';
  const remain = result.validation.find((v) => v.i18n?.text?.messageId === 'check.validatorErrorsRemain');
  return !!remain && remain.i18n.text.data.errs <= remain.i18n.text.data.inErrs;
}

const QUANTIZE_CORPUS = [
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Linked Duplicates Grid 01.glb',
  'Preinstanced Grid 01.glb',
  'Unlinked Duplicates 01.glb',
  'Draco Compressed Input 01.glb',
  'parkergirl.glb',
  'RiggedSimple.glb',
  'MosquitoInAmber2.glb',
  'BoomBox.glb',
];

describe('Квантование — инварианты на корпусе с геометрией', () => {
  eachModel('quantize: треугольники те же, геометрия легче, расширение в required, status ok', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const beforeBytes = await accessorBytes(modelPath(name));
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');

    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);

    expect(await accessorBytes(result.file.dst)).toBeLessThan(beforeBytes);

    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');

    expect(validatorDidNotWorsen(result)).toBe(true);

    const q = result.applied.find((a) => a.ruleId === 'geometry/quantize');
    expect(q).toBeDefined();
    expect(q.i18n.text.messageId).toBe('quantize.done');
  });

  it(`${QUANTIZE_CORPUS.length} моделей в инвариантном корпусе`, () => {
    expect(QUANTIZE_CORPUS.length).toBeGreaterThan(0);
  });
});

describeLocal('parkergirl.glb', 'Квантование — сторож скинов (parkergirl, TESTBUG-007)', () => {
  it('скинов 1 → 1, в applied quantize.done.scene', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);

    const scene = result.applied.find((a) => a.i18n?.text?.messageId === 'quantize.done.scene');
    expect(scene).toBeDefined();
  });
});

describeIfModels(['RiggedSimple.glb'], 'Квантование — RiggedSimple (1 скин)', () => {
  it('скинов 1 → 1, в applied quantize.done.scene', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);

    const scene = result.applied.find((a) => a.i18n?.text?.messageId === 'quantize.done.scene');
    expect(scene).toBeDefined();
  });
});

describe('Квантование — отказы', () => {
  it("['safe','draco','quantize'] — воздержалось, в skipped «геометрия уже упакована (draco)»", async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['safe', 'draco', 'quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);

    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('draco');
  });

  it("['safe','meshopt','quantize'] — воздержалось, в skipped «геометрия уже упакована (meshopt)»", async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      advancedFeatures: ['safe', 'meshopt', 'quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);

    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('meshopt');
  });

  it('повторный проход по уже квантованной модели — воздержание, потерь не добавляет', async () => {
    const outDir1 = tmpOutDir();
    const r1 = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir: outDir1,
    });
    expect(r1.status).toBe('ok');
    const pass1Bytes = await accessorBytes(r1.file.dst);

    const outDir2 = tmpOutDir();
    const r2 = await optimizeFile(r1.file.dst, {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir: outDir2,
    });
    expect(r2.status).toBe('ok');

    expect(r2.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = r2.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.already');

    expect(await accessorBytes(r2.file.dst)).toBe(pass1Bytes);
  });

  it('Meshopt Compressed Input 01 — KHR_mesh_quantization на входе, воздержание', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();
    expect(skip.i18n.text.messageId).toBe('quantize.skipped.already');
  });

  it('Orphan Texture Cube 01 — status ok, ничего не падает', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
  });
});

describe('Квантование — морфы и анимация', () => {
  eachModel('quantize: морфы и анимации не изменились, baseline-checkpoint зелёный', ['Morph Cube 01.glb', 'parkergirl.glb'], async (name) => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.morphTargets).toBe(result.metrics.before.morphTargets);
    expect(result.metrics.after.animations).toBe(result.metrics.before.animations);

    const baseline = result.validation.find((v) => v.i18n?.text?.messageId === 'check.baselineMatch');
    expect(baseline).toBeDefined();
    expect(baseline.level).toBe('pass');
  });
});

describe('Квантование × join — инвариант сочетания на корпусе', () => {
  eachModel('safe+quantize+join: треугольники и скины целы, расширение в required, status ok', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe', 'quantize', 'join'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.skins).toBe(result.metrics.before.skins);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(validatorDidNotWorsen(result)).toBe(true);
  });

  it('Instance Grid 01 — join применён, квантование поверх него живо, итог строго легче исходника', async () => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath('Instance Grid 01.glb'));
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['safe', 'quantize', 'join'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(true);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });
});

describe('Квантование × instance — инвариант сочетания на корпусе', () => {
  eachModel('safe+quantize+join+instance: треугольники и скины целы, расширение в required, итог легче исходника', QUANTIZE_CORPUS, async (name) => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath(name));
    const result = await optimizeFile(modelPath(name), {
      advancedFeatures: ['safe', 'quantize', 'join', 'instance'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.skins).toBe(result.metrics.before.skins);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(validatorDidNotWorsen(result)).toBe(true);
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });

  it('Instance Grid 01 — копии узнаны по форме: instance и join работают вместе, итог легче исходника', async () => {
    const outDir = tmpOutDir();
    const before = await accessorBytes(modelPath('Instance Grid 01.glb'));
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['safe', 'quantize', 'join', 'instance'],
      dryRun: false,
      outDir,
    });

    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'scene/instance'),
      'инстансинг снова не узнаёт запечённые копии').toBe(true);
    expect(result.applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    expect(result.metrics.after.drawCalls,
      'вызовов отрисовки почти не убыло').toBeLessThan(result.metrics.before.drawCalls / 50);
    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(true);
    expect(await requiredExtensions(result.file.dst)).toContain('KHR_mesh_quantization');
    expect(await accessorBytes(result.file.dst)).toBeLessThan(before);
  });
});

describeIfModels(['Instance Grid 01.glb'], 'Квантование — отчёт переживает смену языка (Правило 8)', () => {
  it('localizeResult: тексты меняются, структура и числа те же; новые ключи рендерятся', async () => {
    const outDir = tmpOutDir();
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      advancedFeatures: ['quantize'],
      dryRun: false,
      outDir,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBeGreaterThan(0);

    const ru = localizeResult(result, 'ru');
    const en = localizeResult(result, 'en');

    expect(ru.applied.length).toBe(result.applied.length);
    expect(ru.applied.map((a) => a.ruleId)).toEqual(result.applied.map((a) => a.ruleId));
    expect(ru.applied.map((a) => a.i18n?.text?.messageId)).toEqual(result.applied.map((a) => a.i18n?.text?.messageId));
    expect(JSON.stringify(ru.applied.map((a) => a.i18n?.text?.data))).toBe(
      JSON.stringify(result.applied.map((a) => a.i18n?.text?.data)),
    );

    expect(ru.applied.some((a, i) => a.text !== en.applied[i].text)).toBe(true);

    for (const id of ['quantize.done', 'quantize.done.scene', 'quantize.skipped.already', 'quantize.skipped.compressed']) {
      const data = id === 'quantize.done' ? { pct: 41 } : id === 'quantize.skipped.compressed' ? { codec: 'draco' } : {};
      expect(render(id, data, 'ru').length).toBeGreaterThan(0);
      expect(render(id, data, 'en').length).toBeGreaterThan(0);
    }
  });
});

afterAll(cleanupTmpOutDirs);
