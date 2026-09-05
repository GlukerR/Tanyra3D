import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runOptimize } from '../../core/engine.mjs';
import gltfAddon from '../../addons/gltf/index.mjs';
import { readSource } from '../helpers/source-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.resolve(__dirname, '../../core/engine.mjs');


function engineAddonApi() {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...new Set([...src.matchAll(/\baddon\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
}

function optionalAddonApi() {
  const clean = fs.readFileSync(ENGINE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const names = new Set();
  for (const m of clean.matchAll(/\baddon\.([A-Za-z_][A-Za-z0-9_]*)\s*(\?\.|\?[^.])/g)) names.add(m[1]);
  return [...names].sort();
}

const DOCUMENTED_API = [
  'BASELINE_METRICS', 'baselineMetrics', 'collectMetrics', 'createIO',
  'load', 'normalizeOpts', 'outputName', 'readBytes', 'rules',
  'stripInputCompression', 'validate', 'writeBytes', 'writeReport',
  'sourceBytes',
].sort();

const DOCUMENTED_OPTIONAL = ['sourceBytes'];


function makeMockRule() {
  return {
    meta: {
      id: 'mock/bump', category: 'scene', title: 'Mock rule',
      severity: 'info', fixSafety: 'provable', tier: 'basic',
      reversible: true, dataLoss: 'none',
      feature: 'mockFeature',
      enabled: (o) => !!o.mockFeature,
    },
    analyze: () => [{ messageId: 'pipeline', data: {} }],
    canFix: () => ({ safe: true }),
    fix: (finding, ctx) => {
      ctx.document.bumped = (ctx.document.bumped || 0) + 1;
      return { details: [{ messageId: 'engine.nothingToDo', data: {} }] };
    },
  };
}

function makeMockAddon({ rules = [] } = {}) {
  return {
    formats: ['mock'],
    rules,
    BASELINE_METRICS: [],
    outputName: (src) => path.basename(src).replace(/\.[^.]+$/, '.mock'),
    normalizeOpts: (opts = {}) => ({
      outDir: String(opts.outDir || '.'),
      force: !!opts.force,
      dryRun: !!opts.dryRun,
      onProgress: null,
      log: () => {},
      locale: 'en',
      codec: 'mock',
      advancedFeatures: opts.advancedFeatures || [],
      mockFeature: (opts.advancedFeatures || []).includes('mockFeature'),
    }),
    createIO: async () => ({}),
    load: async () => ({ kind: 'mock-doc' }),
    writeBytes: async () => new Uint8Array([1, 2, 3]),
    readBytes: async () => ({ kind: 'mock-doc' }),
    collectMetrics: () => ({
      fileBytes: 0, drawCalls: 0, triangles: 0, vertices: 0,
      meshes: 0, materials: 0, textures: 0, nodes: 0, scenes: 0,
      animations: 0, skins: 0, gpuBytes: 0, textureBytes: 0,
    }),
    baselineMetrics: () => ({}),
    stripInputCompression: () => [],
    validate: ({ result }) => {
      result.validation.push({ level: 'pass', text: 'mock-validate: ok' });
    },
    writeReport: ({ name, opts }) => {
      const reportName = name.replace(/\.mock$/, '.report.md');
      fs.writeFileSync(path.join(opts.outDir, reportName), `# mock report\n`, 'utf8');
      return reportName;
    },
  };
}


describe('addon-contract — контракт аддона живёт в исходнике движка', () => {
  it('движок вызывает ровно документированный набор addon.*', () => {
    const api = engineAddonApi();
    expect(api).toEqual(DOCUMENTED_API);
  });

  it('необязательные хуки названы поимённо и зовутся с запасным путём', () => {
    expect(optionalAddonApi()).toEqual([...DOCUMENTED_OPTIONAL].sort());
  });

  it('реальный addons/gltf/index.mjs реализует каждый вызванный движком метод', () => {
    for (const name of engineAddonApi()) {
      expect(gltfAddon, `gltfAddon.${name} отсутствует`).toHaveProperty(name);
      if (name === 'rules' || name === 'BASELINE_METRICS') {
        expect(Array.isArray(gltfAddon[name]), `gltfAddon.${name} должен быть массивом`).toBe(true);
      } else {
        expect(typeof gltfAddon[name], `gltfAddon.${name} должен быть функцией`).toBe('function');
      }
    }
  });
});


describe('addon-contract — движок работает на выдуманном формате (формат-агностичность)', () => {
  it('runOptimize(мок-аддон, файл .mock) проходит все пять фаз и пишет результат', async () => {
    const mockAddon = makeMockAddon();
    const optional = new Set(optionalAddonApi());
    for (const name of engineAddonApi()) {
      if (optional.has(name)) continue;
      expect(mockAddon, `мок-аддон не реализует ${name}`).toHaveProperty(name);
    }
    for (const name of optional) {
      expect(mockAddon, `мок реализует ${name} — запасной путь больше не проверяется`)
        .not.toHaveProperty(name);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-'));
    const src = path.join(tmp, 'scene.mock');
    const outDir = path.join(tmp, 'out');
    fs.writeFileSync(src, 'mock-format-bytes', 'utf8');

    const result = await runOptimize(mockAddon, src, { outDir, force: true });

    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(true);
    expect(fs.existsSync(result.file.dst)).toBe(true);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    expect(result.validation.some((v) => v.level === 'pass')).toBe(true);
    expect(result.file.reportPath).toBeTruthy();
    expect(fs.existsSync(result.file.reportPath)).toBe(true);
  });

  it('конвейер правил работает на выдуманном формате: правило планируется, применяется и отчитывается', async () => {
    const mockAddon = makeMockAddon({ rules: [makeMockRule()] });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-rules-'));
    const src = path.join(tmp, 'scene.mock');
    fs.writeFileSync(src, 'mock-format-bytes', 'utf8');

    const on = await runOptimize(mockAddon, src, {
      outDir: path.join(tmp, 'out-on'), force: true, advancedFeatures: ['mockFeature'],
    });
    expect(on.status).toBe('ok');
    expect(on.applied.some((a) => a.ruleId === 'mock/bump')).toBe(true);
    expect(on.applied.find((a) => a.ruleId === 'mock/bump').i18n.text.messageId).toBeTruthy();

    const off = await runOptimize(mockAddon, src, {
      outDir: path.join(tmp, 'out-off'), force: true, advancedFeatures: [],
    });
    expect(off.status).toBe('ok');
    expect(off.applied.some((a) => a.ruleId === 'mock/bump')).toBe(false);
    expect(off.skipped.some((s) => s.ruleId === 'mock/bump')).toBe(true);
  });

  it('незнакомый методу аддон не валит процесс — движок превращает это в status:fail', async () => {
    const mockAddon = makeMockAddon();
    delete mockAddon.collectMetrics;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-'));
    const src = path.join(tmp, 'broken.mock');
    fs.writeFileSync(src, 'x', 'utf8');

    const result = await runOptimize(mockAddon, src, { outDir: path.join(tmp, 'out'), force: true });
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/collectMetrics/);
  });
});

describe('JSON исходника читает один модуль', () => {
  const files = [
    ['addons/gltf/index', readSource('addons/gltf/index')],
    ['addons/gltf/rules', readSource('addons/gltf/rules')],
  ];

  it('общий читатель существует и читает у GLB только чанк', () => {
    const src = readSource('addons/gltf/source-json');
    expect(src, 'нет общего читателя JSON исходника').toBeTruthy();
    expect(src, 'общий читатель вычитывает GLB целиком — ради килобайта оглавления')
      .toMatch(/readSync\(/);
    expect(src, 'у GLB читается не заголовок с чанком, а весь файл')
      .toMatch(/GLB_MAGIC|0x46546c67/);
  });

  it('никто больше не разбирает исходник своим способом', () => {
    const strays = [];
    for (const [name, src] of files) {
      if (!src) continue;
      const hits = src.match(/JSON\.parse\(\s*fs\.readFileSync/g) || [];
      for (let i = 0; i < hits.length; i += 1) strays.push(`${name}: JSON.parse(fs.readFileSync(...))`);
    }
    expect(
      strays,
      'исходник снова разбирают на месте, минуя общий читатель:\n' + strays.join('\n'),
    ).toEqual([]);
  });

  it('оба спрашивающих берут его из общего модуля', () => {
    for (const [name, src] of files) {
      expect(src, `${name} не пользуется общим читателем`)
        .toMatch(/from '\.\/source-json\.mjs'/);
    }
  });
});
