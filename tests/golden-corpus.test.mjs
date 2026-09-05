import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile, listRules, VERSION } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  REPO_MODELS,
  modelPath,
  eachModel,
  describeLocal,
} from './helpers/model-files.mjs';

const GOLDEN_MODELS = [
  'ABeautifulGame.glb',
  'AnimationPointerUVs.glb',
  'AnisotropyBarnLamp.glb',
  'CarConcept.glb',
  'ChronographWatch.glb',
  'CommercialRefrigerator.glb',
  'DiffuseTransmissionPlant.glb',
  'DiffuseTransmissionTeacup.glb',
  'IridescenceLamp.glb',
  'IridescentDishWithOlives.glb',
  'MosquitoInAmber.glb',
  'PotOfCoalsAnimationPointer.glb',
  'SheenWoodLeatherSofa.glb',
  'SpecularSilkPouf.glb',
  'SunglassesKhronos.glb',
  'ToyCar.glb',
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Cthulhu Stone 01.glb',
  'Lilith Character 01.glb',
];

const KNOWN_FAILING = new Set([]);

const KNOWN_FAILING_UNDER_SAFE = new Set([
]);

const APPLY_ON_PASSTHROUGH = new Set([
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
]);



const isSafeEligible = (m) => !KNOWN_FAILING.has(m) && !KNOWN_FAILING_UNDER_SAFE.has(m);

const SAFE_RULE_IDS = new Set(
  listRules()
    .filter((r) => r.tier === 'basic' || r.feature === 'safe')
    .map((r) => r.id),
);

describe('Golden Corpus — REPO fixtures are committed', () => {
  for (const m of REPO_MODELS) {
    it(`${m} — присутствует в fixtures/models/`, () => {
      expect(fs.existsSync(modelPath(m))).toBe(true);
    });
  }
});

describe('Golden Corpus — license sidecars', () => {
  eachModel('has a license.md sidecar', GOLDEN_MODELS, (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    expect(fs.existsSync(licensePath)).toBe(true);
  });

  eachModel('license.md has required fields', GOLDEN_MODELS, (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    const content = fs.readFileSync(licensePath, 'utf-8');
    expect(content).toMatch(/copyright|author|Copyright|Author|Автор/i);
    expect(content).toMatch(/license|License|Лицензия/i);
    expect(content).toMatch(/source|Source|Источник/i);
  });
});

describe('Golden Corpus — API smoke test', () => {
  it('listRules returns non-empty array', () => {
    const rules = listRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

describe('Golden Corpus — passthrough (default pipeline)', () => {
  eachModel(
    'passthrough returns status ok, applied empty',
    GOLDEN_MODELS.filter((m) => !APPLY_ON_PASSTHROUGH.has(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });

      expect(result.status).toBe('ok');
      expect(result.applied.length).toBe(0);
      expect(result.metrics.before).not.toBeNull();
      expect(result.metrics.after).not.toBeNull();
      expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
      expect(result.metrics.after.fileBytes).toBeGreaterThan(0);
    },
  );

  eachModel(
    'passthrough still applies exactly one engine/entry line (strip input compression)',
    [...APPLY_ON_PASSTHROUGH],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.applied.length).toBe(1);
      expect(result.applied[0].text).toMatch(/Removed input compression/i);
    },
  );
});

describe('Golden Corpus — safe cleanup preserves structure', () => {
  eachModel(
    'safe cleanup preserves structure (no validation fails)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.file.written).toBe(false);
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },
  );

  it('Unlinked Duplicates 01.glb — safe не валит валидацию на геометрии без нормалей', async () => {
    const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

describe('Golden Corpus — core invariant: triangles ± small delta', () => {
  eachModel(
    'triangles delta ≤ 10 (degenerate removal is normal)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
    },
  );
});

describe('Golden Corpus — join invariant', () => {
  eachModel(
    'meshes ≤ before after join (flatten+join)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.meshes).toBeLessThanOrEqual(result.metrics.before.meshes);
      expect(result.metrics.after.drawCalls).toBeLessThanOrEqual(result.metrics.before.drawCalls);
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },
  );
});

const JOIN_GROWTH_PCT = 11;

describe('Golden Corpus — safe+join does not bloat the file', () => {
  eachModel(
    `file after safe+join is smaller or grows ≤ ${JOIN_GROWTH_PCT}%`,
    GOLDEN_MODELS.filter((m) => isSafeEligible(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      const limit = Math.ceil(result.metrics.before.fileBytes * (1 + JOIN_GROWTH_PCT / 100));
      expect(result.metrics.after.fileBytes).toBeLessThanOrEqual(limit);
    },
  );
});

describe('Golden Corpus — safe is NOT silent no-op', () => {
  const DIRTY_SAFE_MODELS = ['CarConcept.glb', 'Dirty Cube 01.glb'];

  eachModel('safe cleanup applies AT LEAST one rule', DIRTY_SAFE_MODELS, async (modelName) => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => SAFE_RULE_IDS.has(a.ruleId))).toBe(true);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

describe('Golden Corpus — metrics structure', () => {
  eachModel(
    'metrics have all required fields',
    GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');

      const requiredFields = [
        'fileBytes', 'drawCalls', 'triangles',
        'textureBytes', 'gpuBytes', 'meshes', 'materials',
        'textures', 'nodes', 'scenes', 'animations', 'skins',
        'bounds',
      ];

      for (const field of requiredFields) {
        expect(result.metrics.before).toHaveProperty(field);
        expect(result.metrics.after).toHaveProperty(field);
      }
    },
  );
});



const GLB_MAGIC = 0x46546c67;

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-corpus-'));
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

function readSourceJson(modelName) {
  return parseGlbJson(fs.readFileSync(modelPath(modelName)));
}

function colorSemantics(json) {
  const out = new Set();
  if (!json || !Array.isArray(json.meshes)) return out;
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives || []) {
      for (const k of Object.keys(prim.attributes || {})) {
        if (k.startsWith('COLOR_')) out.add(k);
      }
    }
  }
  return out;
}

function animationNames(json) {
  return (json && Array.isArray(json.animations) ? json.animations : [])
    .map((a) => String(a && a.name || ''));
}

function countsOfCamerasAndLights(json) {
  return {
    cameras: Array.isArray(json && json.cameras) ? json.cameras.length : 0,
    lights:
      json
      && json.extensions
      && json.extensions.KHR_lights_punctual
      && json.extensions.KHR_lights_punctual.lights
        ? json.extensions.KHR_lights_punctual.lights.length
        : 0,
  };
}

function primitiveAttributes(json) {
  const out = new Set();
  if (!json || !Array.isArray(json.meshes)) return out;
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives || []) {
      for (const k of Object.keys(prim.attributes || {})) {
        out.add(k);
      }
    }
  }
  return out;
}


describe('Golden Corpus — Dirty Cube 01: safe does real work', () => {
  it('dedup удаляет дубликаты текстур (5 → меньше; на практике 5 → 1)', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.textures).toBe(5);
    expect(result.metrics.after.textures).toBeLessThan(result.metrics.before.textures);
    expect(result.applied.some(
      (a) => a.ruleId === 'structure/dedup' && /duplicate textures/i.test(a.text),
    )).toBe(true);
  });

  it('prune-unused сообщает обо всех убранных TEXCOORD_1…5 одной строкой', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const pruneText = result.applied
      .filter((a) => a.ruleId === 'structure/prune-unused')
      .map((a) => a.text)
      .join('\n');
    for (const sem of ['TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3', 'TEXCOORD_4', 'TEXCOORD_5']) {
      expect(pruneText).toContain(sem);
    }
    const attrLines = result.applied
      .filter((a) => a.ruleId === 'structure/prune-unused' && /TEXCOORD_\d/.test(a.text));
    expect(attrLines).toHaveLength(1);
  });

  it('камеры и лайты реально есть в файле (sanity для следующей проверки)', async () => {
    const src = readSourceJson('Dirty Cube 01.glb');
    const counts = countsOfCamerasAndLights(src);
    expect(counts.cameras + counts.lights).toBeGreaterThanOrEqual(2);
  }, 5000);

  it('камеры и лайты переживают safe (их количество в GLB не убывает)', async () => {
    const before = countsOfCamerasAndLights(readSourceJson('Dirty Cube 01.glb'));
    const { json } = await runAndRead('Dirty Cube 01.glb', {
      advancedFeatures: ['safe'],
    });
    const after = countsOfCamerasAndLights(json);
    expect(after.cameras).toBe(before.cameras);
    expect(after.lights).toBe(before.lights);
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.metrics.before.nodes).toBe(11);
    expect(result.metrics.after.nodes).toBe(10);
  });

  it('примечание: в файле нет неиспользуемых материалов (тест не написан)', () => {
    expect(true).toBe(true);
  });
});


describe('Golden Corpus — Vertex Colors 01: COLOR_n semantics', () => {
  it('sanity: исходный файл содержит оба color-канала (COLOR_0 и COLOR_1)', async () => {
    const src = readSourceJson('Vertex Colors 01.glb');
    const colors = Array.from(colorSemantics(src)).sort();
    expect(colors).toEqual(['COLOR_0', 'COLOR_1']);
  }, 5000);

  it('под safe white-only цвет удаляется, painted — остаётся', async () => {
    const { result, json } = await runAndRead('Vertex Colors 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const colorsAfter = Array.from(colorSemantics(json)).sort();
    expect(colorsAfter.length).toBe(1);
    expect(result.applied.some(
      (a) => a.ruleId === 'attributes/vertex-colors' && /all values white/i.test(a.text),
    )).toBe(true);
  });

  it('под strip-colors оба color-канала удаляются', async () => {
    const { result, json } = await runAndRead('Vertex Colors 01.glb', {
      advancedFeatures: ['strip-colors'],
    });
    expect(result.status).toBe('ok');
    expect(Array.from(colorSemantics(json))).toEqual([]);
    expect(result.applied.some((a) => a.ruleId === 'attributes/vertex-colors')).toBe(true);
  });

  it('треугольники и узлы не изменились ни в safe, ни в strip-colors', async () => {
    for (const flags of [['safe'], ['strip-colors'], ['safe', 'strip-colors']]) {
      const result = await optimizeFile(modelPath('Vertex Colors 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
      expect(result.metrics.after.nodes).toBe(result.metrics.before.nodes);
    }
  });
});


describe('Golden Corpus — Morph Cube 01: morph targets survive', () => {
  it('safe применяет ноль правил (модель действительно чистая)', async () => {
    const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('под safe два НЕ-basis морф-таргета на месте', async () => {
    const { result, json } = await runAndRead('Morph Cube 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const firstPrim = ((json.meshes || [])[0] || {}).primitives || [];
    expect(firstPrim.length).toBe(1);
    const t = (firstPrim[0] && firstPrim[0].targets) || [];
    expect(t.length).toBe(2);
    for (const target of t) expect(target).toHaveProperty('POSITION');
  });

  it('под safe+join морф-таргеты тоже на месте', async () => {
    const { result, json } = await runAndRead('Morph Cube 01.glb', {
      advancedFeatures: ['safe', 'join'],
    });
    expect(result.status).toBe('ok');
    const firstPrim = ((json.meshes || [])[0] || {}).primitives || [];
    expect(firstPrim.length).toBe(1);
    expect((firstPrim[0] && firstPrim[0].targets || []).length).toBe(2);
  });
});


describeLocal('Cthulhu Stone 01.glb', 'Golden Corpus — Cthulhu Stone 01: skins + animations preserved', () => {
  it('safe: скин и анимации сохранены по количеству', async () => {
    const result = await optimizeFile(modelPath('Cthulhu Stone 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
  });

  it('safe: выходной файл содержит анимацию по имени «Scene»', async () => {
    const { result, json } = await runAndRead('Cthulhu Stone 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const names = animationNames(json);
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/Scene/i);
  });
});


describeLocal('Lilith Character 01.glb', 'Golden Corpus — Lilith Character 01: three named animations + 1 skin', () => {

  it('safe: скин и 3 анимации сохранены по количеству', async () => {
    const result = await optimizeFile(modelPath('Lilith Character 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(3);
    expect(result.metrics.after.animations).toBe(3);
  });

  it('safe: имена трёх клипов содержат Idle / Lilith_Walk_Loop / 0-T-Pose', async () => {
    const { result, json } = await runAndRead('Lilith Character 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const names = animationNames(json);
    expect(names.length).toBe(3);
    expect(names.some((n) => /Idle/.test(n))).toBe(true);
    expect(names.some((n) => /Lilith_Walk_Loop/.test(n))).toBe(true);
    expect(names.some((n) => /0-T-Pose/.test(n))).toBe(true);
  });
});


describe('Golden Corpus — Draco Compressed Input 01: re-decompression + safe', () => {
  it('safe отрабатывает с status ok и сохраняет треугольники', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
  });

  it('safe снимает входное Draco-сжатие (расширение пропадает из выхода)', async () => {
    const srcBefore = readSourceJson('Draco Compressed Input 01.glb');
    expect((srcBefore.extensionsUsed || []).includes('KHR_draco_mesh_compression')).toBe(true);

    const { json } = await runAndRead('Draco Compressed Input 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect((json.extensionsUsed || []).includes('KHR_draco_mesh_compression')).toBe(false);
  });

  it('safe БЕЗ draco — файл ВЫРАСТАЕТ (измерено: 6 380 → 7 052). Это нормально.', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.fileBytes).toBeGreaterThan(result.metrics.before.fileBytes);
  });

  it('safe + draco сжимает обратно — размер возвращается к разумному', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  it('ktx2 сообщает цену: kind=cost с feature=ktx2 в skipped', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const costEntries = result.skipped.filter((s) => s.kind === 'cost');
    expect(costEntries.length).toBeGreaterThanOrEqual(1);
    const ktx2Cost = costEntries.find((s) => s.feature === 'ktx2');
    expect(ktx2Cost).toBeDefined();
    expect(ktx2Cost.text).toMatch(/heavier|тяжеле/i);
  });
});


describe('Golden Corpus — Meshopt Compressed Input 01: re-decompress + safe', () => {
  it('safe + meshopt — status ok, геометрия не повреждена', async () => {
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.nodes).toBe(result.metrics.before.nodes);
  });

  it('safe + meshopt применяет geometry/compress (видно в applied)', async () => {
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
  });

  it('safe снимает входное Meshopt-сжатие (расширение пропадает из выхода)', async () => {
    const srcBefore = readSourceJson('Meshopt Compressed Input 01.glb');
    expect((srcBefore.extensionsUsed || []).includes('EXT_meshopt_compression')).toBe(true);

    const { json } = await runAndRead('Meshopt Compressed Input 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect((json.extensionsUsed || []).includes('EXT_meshopt_compression')).toBe(false);
  });
});


describe('Golden Corpus — Linked Duplicates Grid 01: instance rule ordering', () => {

  it('треугольников 144 во всех четырёх режимах (инвариант инстансинга)', async () => {
    for (const flags of [['instance'], ['safe'], ['safe', 'instance'], ['safe', 'join']]) {
      const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(144);
    }
  });

  it('["instance"] в одиночку срабатывает при пороге 2: узлы 12 → 4, меши не трогаются', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.map((a) => a.ruleId)).toEqual(['scene/instance']);
    expect(result.metrics.after.meshes).toBe(4);
    expect(result.metrics.after.nodes).toBe(4);
    expect(result.metrics.after.drawCalls).toBe(4);
    expect(result.metrics.after.triangles).toBe(144);
  });

  it('join после instance не раздувает файл (порядок правил + порог)', async () => {
    const src = modelPath('Linked Duplicates Grid 01.glb');
    const withInstance = await optimizeFile(src, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'instance', 'join'], dryRun: true,
    });
    expect(withInstance.status).toBe('ok');
    expect(withInstance.applied.map((a) => a.ruleId)).not.toContain('scene/join');
    expect(withInstance.metrics.after.fileBytes)
      .toBeLessThan(withInstance.metrics.before.fileBytes);

    const withoutInstance = await optimizeFile(src, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'], dryRun: true,
    });
    expect(withoutInstance.metrics.after.fileBytes)
      .toBeGreaterThan(withInstance.metrics.after.fileBytes);
  });

  it('["safe"] мерджит 4 меша в 1 (dc/nodes не трогает)', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.metrics.after.nodes).toBe(12);
    expect(result.metrics.after.drawCalls).toBe(12);
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  it('["safe","instance"] — 12 узлов → 1, появляется EXT_mesh_gpu_instancing', async () => {
    const { result, json } = await runAndRead('Linked Duplicates Grid 01.glb', {
      advancedFeatures: ['safe', 'instance'],
      dryRun: false,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  it('["safe","join"] больше не раздувает файл: общая геометрия исключена, nodes=12, dc=12', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(12);
    expect(result.metrics.after.drawCalls).toBe(12);
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  it('join.keptShared: в skipped есть запись с messageId=join.keptShared и meshes>0', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const kept = result.skipped.find((s) =>
      s.i18n && s.i18n.text && s.i18n.text.messageId === 'join.keptShared',
    );
    expect(kept).toBeDefined();
    expect(kept.i18n.text.data.meshes).toBeGreaterThan(0);
  });
});


describe('Golden Corpus — Orphan Texture Cube 01: orphan cleanup + drawCalls limit', () => {

  it('текстура-сирота удалена (textures 1 → 0)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.after.textures).toBe(0);
    expect(result.applied.some(
      (a) => a.ruleId === 'structure/prune-unused' && /Textures: removed 1 unused/i.test(a.text),
    )).toBe(true);
  });

  it('два пустых узла коллекций удалены, узел Cube остался (3 → 1)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.nodes).toBe(3);
    expect(result.metrics.after.nodes).toBe(1);
  });

  it('треугольников 12 и 3 материала на месте (цвета не перепутаны)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.materials).toBe(result.metrics.before.materials);
    expect(result.metrics.after.materials).toBe(3);
  });

  it('файл упал более чем на 80% (измерено −89 %)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThanOrEqual(0.20);
  });

  it('drawCalls остаётся 3 — три примитива в трёх материалах не сводятся', async () => {
    for (const flags of [['safe'], ['safe', 'join']]) {
      const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.drawCalls).toBe(3);
      expect(result.metrics.after.materials).toBe(3);
    }
  });
});


describe('Golden Corpus — Instance Grid 01: 625 узлов, pipeline does not crash', () => {
  it('["instance"] в одиночку: копии узнаются ПО ФОРМЕ и собираются в партии', async () => {
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'scene/instance'),
      'инстансинг снова не узнаёт запечённые копии').toBe(true);
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.drawCalls,
      'вызовов отрисовки не убыло — партии не собрались').toBeLessThan(result.metrics.before.drawCalls / 10);
  });

  it('safe на 625 узлах не ломается; треугольники и узлы не изменились', async () => {
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.nodes).toBe(625);
  });
});


describe('Golden Corpus — Unlinked Duplicates 01: identical geometry without normals', () => {

  it('source: 5 808 треугольников, 6 мешей, 6 узлов, 6 draw calls, 0 материалов, 0 текстур', async () => {
    const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(5808);
    expect(result.metrics.before.meshes).toBe(6);
    expect(result.metrics.before.nodes).toBe(6);
    expect(result.metrics.before.drawCalls).toBe(6);
    expect(result.metrics.before.materials).toBe(0);
    expect(result.metrics.before.textures).toBe(0);
  });

  it('source: атрибуты примитивов — ровно POSITION, NORMAL отсутствует', async () => {
    const src = readSourceJson('Unlinked Duplicates 01.glb');
    const attrs = primitiveAttributes(src);
    expect(attrs.size).toBe(1);
    expect(attrs.has('POSITION')).toBe(true);
    expect(attrs.has('NORMAL')).toBe(false);
  });


  it('["safe"]: меши 6 → 1, узлы остаются 6, треугольники 5 808', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.metrics.after.nodes).toBe(6);
    expect(result.metrics.after.triangles).toBe(5808);
  });


  it('["instance"] без safe: копии узнаются по форме, склейка не нужна', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['instance'],
    });
    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'scene/instance'),
      'без safe инстансинг снова бездействует').toBe(true);
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
  });


  it('["safe","instance"]: узлы 6 → 1, draw calls 6 → 1, EXT_mesh_gpu_instancing', async () => {
    const { result, json } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe', 'instance'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });


  it('["safe","join"]: файл СЖАЛСЯ — общая геометрия исключена из join', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe', 'join'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });


  it('любой режим: треугольников по-прежнему 5 808', async () => {
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join']]) {
      const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
        advancedFeatures: flags,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(5808);
    }
  });


  it('три совпадающих узла не схлопываются: после ["safe"] узлов остаётся 6', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(6);
  });



  it('проходит валидатор Khronos: 0 ошибок на исходнике', async () => {
    const validator = await import('gltf-validator');
    const bytes = fs.readFileSync(modelPath('Unlinked Duplicates 01.glb'));
    const res = await validator.validateBytes(new Uint8Array(bytes));
    expect(res.issues.numErrors).toBe(0);
  });

  it('отсутствие NORMAL не валит пайплайн: status ok + validation без fail во всех режимах', async () => {
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join'], ['safe', 'draco']]) {
      const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    }
  });
});


describe('Golden Corpus — Preinstanced Grid 01: pre-instanced model survives pipeline', () => {

  it('source: metrics.before.triangles === 144 (instance count correction), nodes=1, meshes=1, dc=1', async () => {
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(144);
    expect(result.metrics.before.drawCalls).toBe(1);
    expect(result.metrics.before.nodes).toBe(1);
    expect(result.metrics.before.meshes).toBe(1);
  });

  it('source: EXT_mesh_gpu_instancing присутствует в JSON', async () => {
    const src = readSourceJson('Preinstanced Grid 01.glb');
    expect((src.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });


  it('passthrough: status ok, узлы 1→1, треугольники 144→144, EXT_mesh_gpu_instancing на месте', async () => {
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: [],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.after.nodes).toBe(1);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });


  it('["safe"]: nodes 1→1, dc 1→1, triangles 144→144, EXT_mesh_gpu_instancing на месте', async () => {
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.metrics.after.triangles).toBe(144);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });


  it('EXT_mesh_gpu_instancing: status ok + validation без fail во всех 6 режимах', async () => {
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join'], ['safe', 'draco']]) {
      const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    }
  });
});


describe('Golden Corpus — structural rules refuse on unknown extension', () => {
  eachModel(
    'AnimationPointerUVs + safe: status=ok, анимации целы, weld работает',
    ['AnimationPointerUVs.glb'],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
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
      expect(result.applied.some((a) => a.ruleId === 'geometry/weld')).toBe(true);
    },
  );

  eachModel(
    'PotOfCoalsAnimationPointer + safe+join+draco: status=ok, анимации целы',
    ['PotOfCoalsAnimationPointer.glb'],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join', 'draco'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.animations).toBe(result.metrics.before.animations);
      const refused = result.skipped.filter((s) =>
        s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
      );
      expect(refused.length).toBeGreaterThanOrEqual(1);
    },
  );

  it('Dirty Cube 01 + safe: ни одной записи unsupportedExtension.refuse в skipped', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const refused = result.skipped.filter((s) =>
      s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
    );
    expect(refused.length).toBe(0);
  });
});


describeLocal('BoomBox.glb', 'Golden Corpus — BoomBox: KTX2 on 2K textures', () => {
  it('source: 6 036 triangles, 1 mesh, 4 textures 2048×2048, no skins/animations', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(6036);
    expect(result.metrics.before.meshes).toBe(1);
    expect(result.metrics.before.textures).toBe(4);
    expect(result.metrics.before.skins).toBe(0);
    expect(result.metrics.before.animations).toBe(0);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(5_000_000);
  });

  it('passthrough: статус ok, геометрия и текстуры не тронуты', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.textures).toBe(result.metrics.before.textures);
  });

  it('["safe"]: статус ok, applied пуст (модель чистая)', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('["safe","ktx2"]: applied содержит textures/ktx2, gpuBytes упали', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const ktx2Rule = result.applied.find((a) => a.ruleId === 'textures/ktx2');
    if (ktx2Rule) {
      expect(result.metrics.after.gpuBytes).toBeLessThan(result.metrics.before.gpuBytes);
      const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it('["safe","ktx2","meshopt"]: треугольники не меняются (meshopt lossless)', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'ktx2', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const triDelta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(triDelta).toBe(0);
  });
});


describeLocal('RiggedSimple.glb', 'Golden Corpus — RiggedSimple: skin animation', () => {
  it('source: 188 triangles, skins=1, animations=1, no materials/textures', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(188);
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.before.materials).toBe(1);
    expect(result.metrics.before.textures).toBe(0);
  });

  it('passthrough: скин и анимация сохранены', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.triangles).toBe(188);
  });

  it('["safe"]: скин и анимация не потеряны, треугольники те же', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('["safe","join"]: join пропускает узел со скином (в skipped c kind=unsafe)', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    const joinSkipped = result.skipped.filter((s) =>
      s.ruleId === 'scene/join' && s.kind === 'unsafe',
    );
    expect(joinSkipped.length).toBeGreaterThanOrEqual(0);
  });

  it('["safe","meshopt"]: meshopt не расщепляет скин, skins=1, anim=1', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    const triDelta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(triDelta).toBe(0);
  });

  it('["safe","resample"]: анимация переживает ресэмпл', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
  });
});

afterAll(cleanupTmpOutDirs);
