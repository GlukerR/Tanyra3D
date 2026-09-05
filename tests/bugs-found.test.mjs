import { it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile, VERSION } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { modelPath, describeIfModels, eachModel, isPresent } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describeIfModels(['CarConcept.glb'], 'TESTBUG-* — regression documentation (currently empty)', () => {
  it('skeleton — registry file present, vitest accepts an empty describe', async () => {
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe('string');

    const r = await optimizeFile(modelPath('CarConcept.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(['ok', 'fail']).toContain(r.status);
  });
});

describeIfModels(['parkergirl.glb'], 'TESTBUG-007 (закрыт) — parkergirl под safe+meshopt сохраняет скин', () => {
  const isParkergirlLocal = fs.existsSync(modelPath('parkergirl.glb'));
  const targetModel = 'parkergirl.glb';
  const expectedMode = ['safe', 'meshopt'];

  const fn = isParkergirlLocal ? it : it.skip;
  fn(`${targetModel} ${JSON.stringify(expectedMode)} — status='ok', скин один, морфы целы`, async () => {
    const result = await optimizeFile(modelPath(targetModel), {
      outDir: tmpOutDir(),
      advancedFeatures: expectedMode,
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    const { before, after } = result.metrics;
    expect(after.skins).toBe(before.skins);
    expect(after.morphTargets).toBe(before.morphTargets);
    expect(after.triangles).toBe(before.triangles);

    const failed = (result.validation || []).filter((v) => v.level === 'fail');
    expect(failed).toEqual([]);
  });
});

describeIfModels(['AnimationPointerUVs.glb', 'PotOfCoalsAnimationPointer.glb'], 'TESTBUG-006 (ЗАКРЫТ 2026-07-31) — KHR_animation_pointer models survive safe-cleanup', () => {
  const affectedModels = ['AnimationPointerUVs.glb', 'PotOfCoalsAnimationPointer.glb'];
  eachModel('safe-cleanup returns ok, animations preserved', affectedModels, async (name) => {
    const result = await optimizeFile(modelPath(name), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.animations).toBe(result.metrics.before.animations);
    const refused = result.skipped.filter((s) =>
      s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.some((s) => s.ruleId === 'structure/prune-final')).toBe(true);
  });
});

describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-008 (ЗАКРЫТ 2026-08-01) — meshopt+quantize объясняет воздержание codec-специфично', () => {
  const isPresent = fs.existsSync(modelPath('Dirty Cube 01.glb'));
  const fn = isPresent ? it : it.skip;
  fn("['safe','meshopt','quantize'] — в skipped «геометрия уже упакована (meshopt)»", async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt', 'quantize'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.applied.some((a) => a.ruleId === 'geometry/quantize')).toBe(false);
    const skip = result.skipped.find((s) => s.ruleId === 'geometry/quantize');
    expect(skip).toBeDefined();

    expect(skip.i18n.text.messageId).toBe('quantize.skipped.compressed');
    expect(skip.i18n.text.data.codec).toBe('meshopt');
  });
});

describeIfModels(['Dirty Cube 01.glb'], 'TESTBUG-009 (ЗАКРЫТ 2026-08-01) — join+instance: join не разворачивает защищённую инстансингом общую геометрию', () => {
  const isPresent = fs.existsSync(modelPath('Dirty Cube 01.glb'));
  const fn = isPresent ? it : it.skip;
  fn("['join','instance'] — в skipped нет join.expandedShared, инстансинг применился", async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['join', 'instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');

    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);

    const expanded = result.skipped.find(
      (s) => s.ruleId === 'scene/join' && s.i18n?.text?.messageId === 'join.expandedShared',
    );
    expect(expanded).toBeUndefined();
  });
});


const readGlbJson = (file) => {
  const buf = fs.readFileSync(file);
  return JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
};

eachModel(
  'TESTBUG-010: незнакомое расширение переживает passthrough',
  ['Unknown Ext LOD 01.glb', 'Unknown Ext Interactivity 01.glb', 'Unknown Ext Pointer 01.glb'],
  async (modelName) => {
    const src = modelPath(modelName);
    const declared = readGlbJson(src).extensionsUsed || [];
    expect(declared.length, 'модель-образец обязана нести расширение').toBe(1);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug010-'));
    try {
      const result = await optimizeFile(src, { advancedFeatures: [], outDir: dir });
      expect(result.status).toBe('ok');
      expect(result.applied.length, 'passthrough не применяет правил').toBe(0);

      const after = readGlbJson(path.join(dir, modelName)).extensionsUsed || [];
      expect(
        after,
        `${declared[0]} обязано пережить passthrough — иначе модель молча теряет ` +
        'возможность, о которой человеку никто не скажет',
      ).toContain(declared[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

eachModel(
  'TESTBUG-010: указатель анимации возвращается на место целиком',
  ['PotOfCoalsAnimationPointer.glb'],
  async (modelName) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug010b-'));
    try {
      await optimizeFile(modelPath(modelName), { advancedFeatures: [], outDir: dir });
      const json = readGlbJson(path.join(dir, modelName));
      expect(json.extensionsUsed).toContain('KHR_animation_pointer');

      const target = json.animations[0].channels[0].target;
      expect(target.path).toBe('pointer');
      expect(
        target.extensions?.KHR_animation_pointer?.pointer,
        'канал говорит «анимирую указатель», но не говорит что именно',
      ).toMatch(/^\//);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);


eachModel(
  'TESTBUG-011 (закрыт): указатель переживает safe и join',
  ['Animated Pointer 01.glb'],
  async (modelName) => {
    for (const flags of [['safe'], ['safe', 'join'], ['safe', 'quantize']]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug011-'));
      try {
        await optimizeFile(modelPath(modelName), { advancedFeatures: flags, outDir: dir });
        const json = readGlbJson(path.join(dir, modelName));
        const label = flags.join(',');

        expect(json.extensionsUsed, `[${label}] расширение обязано остаться`).toContain('KHR_animation_pointer');
        const target = json.animations[0].channels[0].target;
        expect(target.path).toBe('pointer');
        expect(
          target.extensions?.KHR_animation_pointer?.pointer,
          `[${label}] канал говорит «анимирую указатель», но не говорит что именно`,
        ).toBe('/materials/0/pbrMetallicRoughness/baseColorFactor');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

eachModel(
  'TESTBUG-011 (закрыт): все 103 указателя AnimationPointerUVs остаются с адресами',
  ['AnimationPointerUVs.glb'],
  async (modelName) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug011b-'));
    try {
      await optimizeFile(modelPath(modelName), { advancedFeatures: [], outDir: dir });
      const json = readGlbJson(path.join(dir, modelName));
      const channels = json.animations.flatMap((a) => a.channels);
      const addressed = channels.filter((c) => c.target?.extensions?.KHR_animation_pointer?.pointer);
      expect(channels.length).toBeGreaterThan(100);
      expect(addressed.length, 'указатели без адреса — это осиротевшие каналы').toBe(channels.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

const { TOKTX, HAS_GLTF_CLI } = await import('../addons/gltf/tools.mjs');

const ktx2Ready = Boolean(TOKTX && HAS_GLTF_CLI);
const itKtx2 = (name, body, timeout) => (ktx2Ready
  ? it(name, body, timeout)
  : it.skip(`${name} [пропущено: нет toktx/gltf-transform CLI]`, () => {}, timeout));

for (const model of ['PotOfCoalsAnimationPointer.glb']) {
  if (!isPresent(model)) continue;
  itKtx2(`TESTBUG-012 (закрыт): ${model} — KTX2 не уносит адрес указателя`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbug012-'));
    try {
      await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'ktx2'], texMode: 'uastc', outDir: dir,
      });
      const json = readGlbJson(path.join(dir, model));
      const channels = json.animations.flatMap((a) => a.channels);
      const addressed = channels.filter((c) => c.target?.extensions?.KHR_animation_pointer?.pointer);
      expect(channels.length).toBeGreaterThan(0);
      expect(addressed.length, 'KTX2 унёс адреса указателей — вернулся круг через временный файл')
        .toBe(channels.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
}


it('правило истины: writeBytes принимает ИСХОДНЫЙ файл, а не только документ', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'addons', 'gltf', 'index.mts'), 'utf8');
  const sig = /const writeBytes = async \(\s*io: NodeIOType,\s*doc: Document,\s*src\?: string/.test(src);
  expect(
    sig,
    'writeBytes потерял довод src — значит снова сверяется с промежуточным документом, '
      + 'а не с первоначальным файлом (правило Александра 2026-08-15)',
  ).toBe(true);

  expect(
    /sourceJson\(src\)/.test(src),
    'writeBytes не читает исходный файл — источник правды подменён',
  ).toBe(true);
});

for (const model of ['Animated Pointer 01.glb', 'Unknown Ext LOD 01.glb', 'Unknown Ext Interactivity 01.glb']) {
  for (const flags of [[], ['safe'], ['safe', 'join'], ['safe', 'quantize']]) {
    const label = `правило истины: ${model} [${flags.join(',') || 'passthrough'}] — расширения входа есть в выходе`;
    eachModel(label, [model], async (m) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-'));
      try {
        const before = readGlbJson(modelPath(m)).extensionsUsed || [];
        await optimizeFile(modelPath(m), { advancedFeatures: flags, outDir: dir });
        const after = readGlbJson(path.join(dir, m)).extensionsUsed || [];
        for (const name of before) {
          expect(after, `${name} объявлено во входном файле, но пропало из выходного`).toContain(name);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  }
}

afterAll(cleanupTmpOutDirs);
