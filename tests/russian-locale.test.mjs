// tests/russian-locale.test.mjs — проверка русской локализации: все текстовые поля
// из RunResult (validation, findings, skipped, applied) должны быть на русском,
// за исключением технических терминов из белого списка.
//
// Белый список: устоявшиеся англицизмы в русской документации по glTF/3D-графике,
// имена расширений, названия технологий, идентификаторы правил, названия форматов
// и т.д. Если в тексте встречается латинское слово, не входящее в белый список —
// тест падает, сигнализируя о непереведённой строке.
//
// Прогоняется на CarConcept.glb (присутствует у всех) и, при наличии, на всём
// золотом корпусе.

import { describe, it, expect } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel, describeLocal } from './helpers/model-files.mjs';

// ============================================================================
// Белый список разрешённых латинских терминов
// ============================================================================
// Все ключи ДОЛЖНЫ быть строчными — сравнение идет после toLowerCase()
// и обрезки ведущих/хвостовых спецсимволов.
const ALLOWED_LATIN = new Set([
  // --- Форматы / технологии / кодеки ---
  'gl', 'glb', 'gltf', 'ktx', 'ktx2', 'uastc', 'etc1s', 'basis',
  'draco', 'meshopt', 'drc', 'mesh',
  'png', 'jpeg', 'jpg', 'webp', 'svg', 'tga', 'tiff', 'tif', 'bmp', 'hdr', 'exr',
  'gltf-validator',

  // --- Расширения glTF (Khronos) ---
  'khr', 'ext',
  'khr_draco_mesh_compression', 'ext_mesh_gpu_instancing', 'ext_meshopt_compression',
  'khr_texture_basisu', 'khr_materials_variants', 'khr_animation_pointer',
  'khr_materials_transmission', 'khr_materials_volume', 'khr_materials_specular',

  // --- Инструменты / библиотеки ---
  'toktx', 'khronos', 'sharp', 'zstd', 'rdo', 'wsl', 'cli',
  'gltf-transform',

  // --- Названия правил / CLI-флаги ---
  'dedup', 'prune', 'weld', 'join', 'resample', 'instance',
  'orphan', 'degenerate', 'compress',
  'safe', 'strip', 'cleanup',
  'flatten',                           // из "flatten + join" в названии правила
  'strip-vertex-colors',               // CLI-флаг в skipped-сообщении
  'keep-parts',                        // CLI-флаг

  // --- Поля метрик / данных ---
  'vram', 'gpu', 'cpu', 'ram',
  'mb', 'kb', 'gb', 'byte', 'bytes',
  'id', 'ids', 'url', 'uri', 'urn',

  // --- Технические термины (стандартные англицизмы) ---
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
  'morph', 'morphs', 'morphtargets',   // morphTargets — имя метрики
  'node', 'nodes',
  'scene', 'scenes',
  'animation', 'animations',
  'texture', 'textures',
  'material', 'materials',
  'sampler', 'samplers',
  'channel', 'channels',
  'interpolation',
  'color', 'colors',
  'color_0', 'color_1', 'color_2', 'color_3',  // COLOR_n семантики
  'normal', 'normals',
  'tangent', 'tangents',
  'texcoord', 'texcoords',
  'texcoord_0', 'texcoord_1', 'texcoord_2', 'texcoord_3',
  'texcoord_4', 'texcoord_5', 'texcoord_6', 'texcoord_7',
  'joint', 'joints', 'weights',
  'inverse', 'bind', 'matrices',
  'matrix',
  'getbounds',

  // --- Baseline / checkpoint ---
  'baseline', 'checkpoint', 'baseline-checkpoint',

  // --- Политика безопасности (tier names) ---
  'safety', 'tier',
  'perceptual', 'numeric', 'provable', 'lossy',

  // --- Имена метрик в baseline-сообщениях ---
  'advancedfeatures',                   // из feature.notEnabled: advancedFeatures: [...]
  'triangles',
  'drawcalls',
  'filebytes',
  'texturebytes',
  'gpubytes',

  // --- glTF-валидатор ---
  'validator',
  'unsupported', 'extension', 'unused', 'object',
  'value', 'not', 'in', 'list',
  'image', 'unrecognized', 'format',
  'used', 'zero', 'weight',
  'missing', 'optional',
  'pointer',
  'unsatisfied_dependency',          // код сообщения gltf-validator
  'images',                          // из pointer /images/N/...
  'severity', 'code',
  'num', 'errors', 'infos', 'warnings', 'hints',
  'issues',

  // --- Имена мешей / моделей (встречаются в русском тексте как данные) ---
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

  // --- Другое ---
  'unicode', 'ascii', 'utf', 'base64',
  'lock', 'mutex', 'semaphore',
  'io', 'fs', 'tmp', 'tmpdir', 'temp',
  'pid', 'uuid', 'guid',

  // --- Единицы измерения ---
  'ms', 'ns', 'us', 'hz', 'khz', 'mhz', 'ghz',
  'px', 'dpi', 'ppi', 'fps',

  // --- Версии / семвер ---
  'v', 'ver', 'version',

  // --- Разное ---
  'rgb', 'rgba', 'argb', 'bgr', 'bgra',
  'xyz', 'uvw',
  'x', 'y', 'z', 'w',
  'min', 'max', 'avg', 'sum', 'count', 'total',
  'src', 'dst',
  'bin',
]);

/**
 * Извлечь из текста «латинские слова» — последовательности латинских букв
 * и цифр с дефисами/подчёркиваниями, длиной >=2 символов.
 *
 * Ведущие/хвостовые дефисы, подчёркивания и точки обрезаются (чтобы "gpu-"
 * из "GPU-инстансинг" превратилось в "gpu" и совпало со списком).
 * Внутренние дефисы и подчёркивания СОХРАНЯЮТСЯ — белый список содержит
 * ключи вида 'khr_draco_mesh_compression', 'baseline-checkpoint'.
 */
function extractLatinWords(text) {
  const found = text.match(/[a-zA-Z][a-zA-Z0-9_.\-]*/g) || [];
  const result = new Set();
  for (const w of found) {
    // toLowerCase + обрезка ведущих/хвостовых не-буквенно-цифровых символов
    const clean = w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (clean.length >= 2) result.add(clean);
  }
  return [...result];
}

/** Проверить текст на латинские слова вне белого списка. */
function checkLatinWords(text) {
  return extractLatinWords(text).filter((w) => !ALLOWED_LATIN.has(w));
}

/** Собрать нарушения из всех текстовых секций RunResult. */
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

// ============================================================================
// Модели
// ============================================================================
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

// ============================================================================
// CarConcept — 4 комбинации флагов, все секции
// ============================================================================
// CarConcept — модель Khronos, в репозиторий не коммитится (fixtures/.gitignore).
// Без обёртки весь блок краснел после свежего `git clone`: prerequisite падал, а
// следующие четыре теста разбивались об `sharedResult === null`.
describeLocal(BASE_MODEL, 'Russian locale — CarConcept', () => {
  const SHARED_FLAGS = ['safe', 'meshopt'];
  let sharedResult = null;

  it('prerequisite — прогон успешен', async () => {
    sharedResult = await optimizeFile(modelPath(BASE_MODEL), {
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
      advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true, locale: 'ru',
    });
    expect(r.status).toBe('ok');
    expect(collectViolations(r)).toEqual([]);
  });
});

// ============================================================================
// Золотой корпус — 2 комбинации флагов
// ============================================================================
describe('Russian locale — golden corpus', () => {
  const FLAG_SETS = [
    { label: 'passthrough', flags: [] },
    { label: 'safe+meshopt', flags: ['safe', 'meshopt'] },
  ];

  for (const { label, flags } of FLAG_SETS) {
    eachModel(`[${label}] все поля локализованы — whitelist OK`, GOLDEN, async (name) => {
      const r = await optimizeFile(modelPath(name), {
        advancedFeatures: flags, dryRun: true, locale: 'ru',
      });
      // Модели с KHR_animation_pointer и т.д. могут вернуть fail — это ок.
      expect(r.status).toBeOneOf(['ok', 'fail']);
      expect(collectViolations(r)).toEqual([]);
    });
  }

  it(`${GOLDEN.length} models * ${FLAG_SETS.length} flag sets = ${GOLDEN.length * FLAG_SETS.length} total`, () => {
    expect(GOLDEN.length).toBeGreaterThan(0);
  });
});
