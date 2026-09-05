import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel, describeLocal } from './helpers/model-files.mjs';

const ALLOWED_LATIN = new Set([
  'gl', 'glb', 'gltf', 'ktx', 'ktx2', 'uastc', 'etc1s', 'basis',
  'draco', 'meshopt', 'drc', 'mesh',
  'png', 'jpeg', 'jpg', 'webp', 'svg', 'tga', 'tiff', 'tif', 'bmp', 'hdr', 'exr',
  'gltf-validator',

  'khr', 'ext',
  'khr_draco_mesh_compression', 'ext_mesh_gpu_instancing', 'ext_meshopt_compression',
  'khr_texture_basisu', 'khr_materials_variants', 'khr_animation_pointer',
  'khr_materials_transmission', 'khr_materials_volume', 'khr_materials_specular',

  'toktx', 'khronos', 'sharp', 'zstd', 'rdo', 'wsl', 'cli',
  'gltf-transform',

  'dedup', 'prune', 'weld', 'join', 'resample', 'instance',
  'quantize',
  'orphan', 'degenerate', 'compress',
  'safe', 'strip', 'cleanup',
  'flatten',
  'strip-vertex-colors',
  'keep-parts',
  'strip-dead-interactivity',
  'keep-unused-uv',

  'vram', 'gpu', 'cpu', 'ram',
  'mb', 'kb', 'gb', 'byte', 'bytes',
  'id', 'ids', 'url', 'uri', 'urn',

  'skin', 'skins',
  'bounding', 'box',
  'epsilon', 'diag',
  'vertex', 'vertices',
  'mesh', 'meshes',
  'primitive', 'primitives',
  'accessor', 'accessors',
  'attribute', 'attributes',
  'buffer', 'buffers', 'bufferview', 'bufferviews',
  'indices', 'index',
  'target', 'targets',
  'morph', 'morphs', 'morphtargets',
  'node', 'nodes',
  'scene', 'scenes',
  'animation', 'animations',
  'texture', 'textures',
  'material', 'materials',
  'sampler', 'samplers',
  'channel', 'channels',
  'interpolation',
  'color', 'colors',
  'color_0', 'color_1', 'color_2', 'color_3',
  'normal', 'normals',
  'tangent', 'tangents',
  'texcoord', 'texcoords',
  'texcoord_0', 'texcoord_1', 'texcoord_2', 'texcoord_3',
  'texcoord_4', 'texcoord_5', 'texcoord_6', 'texcoord_7',
  'joint', 'joints', 'weights',
  'inverse', 'bind', 'matrices',
  'matrix',
  'getbounds',

  'baseline', 'checkpoint', 'baseline-checkpoint',

  'safety', 'tier',
  'perceptual', 'numeric', 'provable', 'lossy',

  'advancedfeatures',
  'triangles',
  'drawcalls',
  'filebytes',
  'texturebytes',
  'gpubytes',

  'validator',
  'unsupported', 'extension', 'unused', 'object',
  'value', 'not', 'in', 'list',
  'image', 'unrecognized', 'format',
  'used', 'zero', 'weight',
  'missing', 'optional',
  'pointer',
  'unsatisfied_dependency',
  'images',
  'severity', 'code',
  'num', 'errors', 'infos', 'warnings', 'hints',
  'issues',

  'cube',
  'dirty',
  'orphan',
  'grid',
  'instance',
  'linked',
  'duplicates',
  'morph',
  'vertex',
  'colors',
  'draco',
  'meshopt',
  'compressed',
  'preinstanced',
  'truncated',
  'broken',
  'ab','beautiful','game',
  'animation','pointer','uvs','uv',
  'anisotropy','barn','lamp',
  'car','concept',
  'chronograph','watch',
  'commercial','refrigerator',
  'diffuse','transmission','plant','teacup',
  'iridescence','iridescent','dish','olives',
  'mosquito','amber',
  'pot','coals',
  'sheen','wood','leather','sofa',
  'specular','silk','pouf',
  'sunglasses','khronos',
  'toy',
  'cthulhu','stone',
  'lilith','character',
  'fringe','frame','fabric','frame_fabric','paisley','stripes','brown',
  'glassdish','goldleaf',

  'unicode', 'ascii', 'utf', 'base64',
  'lock', 'mutex', 'semaphore',
  'io', 'fs', 'tmp', 'tmpdir', 'temp',
  'pid', 'uuid', 'guid',

  'ms', 'ns', 'us', 'hz', 'khz', 'mhz', 'ghz',
  'px', 'dpi', 'ppi', 'fps',

  'v', 'ver', 'version',

  'rgb', 'rgba', 'argb', 'bgr', 'bgra',
  'xyz', 'uvw',
  'x', 'y', 'z', 'w',
  'min', 'max', 'avg', 'sum', 'count', 'total',
  'src', 'dst',
  'bin',
]);

function extractLatinWords(text) {
  const found = text.match(/[a-zA-Z][a-zA-Z0-9_.-]*/g) || [];
  const result = new Set();
  for (const w of found) {
    const clean = w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (clean.length >= 2) result.add(clean);
  }
  return [...result];
}

function checkLatinWords(text) {
  return extractLatinWords(text).filter((w) => !ALLOWED_LATIN.has(w));
}

function collectViolations(result) {
  const violations = [];
  const each = (arr, label) => {
    for (const entry of arr) {
      const t = entry.text || (typeof entry === 'string' ? entry : '');
      for (const w of checkLatinWords(t)) {
        violations.push(`${label}: "${t}" — unallowed word "${w}"`);
      }
    }
  };
  each(result.validation, 'validation');
  each(result.findings, 'findings');
  each(result.skipped, 'skipped');
  each(result.applied, 'applied');
  return violations;
}

const BASE_MODEL = 'CarConcept.glb';

const GOLDEN = [
  'ABeautifulGame.glb',
  'AnimationPointerUVs.glb',
  'AnisotropyBarnLamp.glb',
  'CarConcept.glb',
  'ChronographWatch.glb',
  'CommercialRefrigerator.glb',
  'DiffuseTransmissionPlant.glb',
  'DiffuseTransmissionTeacup.glb',
  'Dirty Cube 01.glb',
  'Draco Compressed Input 01.glb',
  'Instance Grid 01.glb',
  'IridescenceLamp.glb',
  'IridescentDishWithOlives.glb',
  'Linked Duplicates Grid 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Morph Cube 01.glb',
  'MosquitoInAmber.glb',
  'Orphan Texture Cube 01.glb',
  'PotOfCoalsAnimationPointer.glb',
  'Preinstanced Grid 01.glb',
  'SheenWoodLeatherSofa.glb',
  'SpecularSilkPouf.glb',
  'SunglassesKhronos.glb',
  'ToyCar.glb',
  'Truncated Broken 01.glb',
  'Vertex Colors 01.glb',
];

describeLocal(BASE_MODEL, 'Russian locale — CarConcept', () => {
  const SHARED_FLAGS = ['safe', 'meshopt'];
  let sharedResult = null;

  it('prerequisite — прогон успешен', async () => {
    sharedResult = await optimizeFile(modelPath(BASE_MODEL), {
      outDir: tmpOutDir(),
      advancedFeatures: SHARED_FLAGS, dryRun: true, locale: 'ru',
    });
    expect(sharedResult.status).toBe('ok');
  });

  it('validation — только разрешённые термины', () => {
    const bad = [];
    for (const v of sharedResult.validation) {
      for (const w of checkLatinWords(v.text)) bad.push(`validation.${v.level}: "${v.text}" → "${w}"`);
    }
    expect(bad).toEqual([]);
  });

  it('findings — только разрешённые термины', () => {
    const bad = [];
    for (const f of sharedResult.findings) {
      for (const w of checkLatinWords(f.text)) bad.push(`finding ${f.ruleId}: "${f.text}" → "${w}"`);
    }
    expect(bad).toEqual([]);
  });

  it('skipped — только разрешённые термины', () => {
    const bad = [];
    for (const s of sharedResult.skipped) {
      for (const w of checkLatinWords(s.text)) bad.push(`skipped ${s.ruleId}: "${s.text}" → "${w}"`);
    }
    expect(bad).toEqual([]);
  });

  it('applied — только разрешённые термины', () => {
    const bad = [];
    for (const a of sharedResult.applied) {
      for (const w of checkLatinWords(a.text)) bad.push(`applied ${a.ruleId}: "${a.text}" → "${w}"`);
    }
    expect(bad).toEqual([]);
  });

  it('safe+meshopt+join — сводно все секции', async () => {
    const r = await optimizeFile(modelPath(BASE_MODEL), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true, locale: 'ru',
    });
    expect(r.status).toBe('ok');
    expect(collectViolations(r)).toEqual([]);
  });
});

describe('Russian locale — golden corpus', () => {
  const FLAG_SETS = [
    { label: 'passthrough', flags: [] },
    { label: 'safe+meshopt', flags: ['safe', 'meshopt'] },
  ];

  for (const { label, flags } of FLAG_SETS) {
    eachModel(`[${label}] все поля локализованы — whitelist OK`, GOLDEN, async (name) => {
      const r = await optimizeFile(modelPath(name), {
        outDir: tmpOutDir(),
        advancedFeatures: flags, dryRun: true, locale: 'ru',
      });
      expect(r.status).toBeOneOf(['ok', 'fail']);
      expect(collectViolations(r)).toEqual([]);
    });
  }

  it(`${GOLDEN.length} models * ${FLAG_SETS.length} flag sets = ${GOLDEN.length * FLAG_SETS.length} total`, () => {
    expect(GOLDEN.length).toBeGreaterThan(0);
  });
});

afterAll(cleanupTmpOutDirs);
