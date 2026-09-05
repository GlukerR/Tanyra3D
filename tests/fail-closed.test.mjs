import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runOptimize, orderRules } from '../core/engine.mjs';
import { TIER_RANK, isKnownTier } from '../core/contract.mjs';


const rule = (id, runAfter) => ({ meta: { id, ...(runAfter ? { runAfter } : {}) } });

describe('orderRules — неизвестная зависимость это ошибка настройки, а не «выполнено»', () => {
  it('опечатка в runAfter останавливает сборку порядка', () => {
    const rules = [rule('geometry/dedupe'), rule('geometry/weld', ['geometry/dedpe'])];
    expect(() => orderRules(rules)).toThrow(/geometry\/dedpe/);
  });

  it('но существующая зависимость по-прежнему выстраивает порядок', () => {
    const ordered = orderRules([
      rule('geometry/weld', ['geometry/dedupe']),
      rule('geometry/dedupe'),
    ]).map((r) => r.meta.id);
    expect(ordered).toEqual(['geometry/dedupe', 'geometry/weld']);
  });

  it('дубликат в runAfter запрещён явно', () => {
    const rules = [rule('a'), rule('b', ['a', 'a'])];
    expect(() => orderRules(rules)).toThrow(/duplicate/);
  });

  it('правило не может зависеть от самого себя', () => {
    expect(() => orderRules([rule('a', ['a'])])).toThrow(/itself/);
  });

  it('цикл по-прежнему ловится (проверка не подменила старую)', () => {
    expect(() => orderRules([rule('a', ['b']), rule('b', ['a'])])).toThrow(/cycle/);
  });

  it('реальные правила аддона проходят проверку', async () => {
    const { default: gltfAddon } = await import('../addons/gltf/index.mjs');
    expect(gltfAddon.rules.length).toBeGreaterThan(0);
    expect(orderRules(gltfAddon.rules)).toHaveLength(gltfAddon.rules.length);
  });
});


function mockAddon(rules) {
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
      locale: 'ru',
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
    validate: ({ result }) => { result.validation.push({ level: 'pass', text: 'mock-validate: ok' }); },
    writeReport: ({ name, opts }) => {
      const reportName = name.replace(/\.mock$/, '.report.md');
      fs.writeFileSync(path.join(opts.outDir, reportName), '# mock report\n', 'utf8');
      return reportName;
    },
  };
}

function bumpRule(fixSafety, { force = false } = {}) {
  return {
    meta: {
      id: 'mock/bump', category: 'scene', title: 'Mock rule',
      severity: 'info', fixSafety, tier: 'basic',
      reversible: true, dataLoss: 'none',
      feature: 'mockFeature',
      enabled: (o) => !!o.mockFeature,
    },
    analyze: () => [{ messageId: 'pipeline', data: {} }],
    canFix: () => ({ safe: true, force }),
    fix: (finding, ctx) => {
      ctx.document.bumped = (ctx.document.bumped || 0) + 1;
      return { details: [{ messageId: 'engine.nothingToDo', data: {} }] };
    },
  };
}

async function run(rule) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-closed-'));
  const src = path.join(tmp, 'scene.mock');
  const outDir = path.join(tmp, 'out');
  fs.writeFileSync(src, 'mock-format-bytes', 'utf8');
  const result = await runOptimize(mockAddon([rule]), src, {
    outDir, force: true, advancedFeatures: ['mockFeature'],
  });
  return result;
}

const appliedBump = (r) => r.applied.filter((a) => a.ruleId === 'mock/bump');
const skippedBump = (r) => r.skipped.filter((s) => s.ruleId === 'mock/bump');

describe('ворота безопасности — неизвестный уровень не применяется', () => {
  it('опечатка «perceptal» НЕ применяет правило', async () => {
    const r = await run(bumpRule('perceptal'));
    expect(r.status).toBe('ok');
    expect(appliedBump(r)).toHaveLength(0);
  });

  it('и правило видно в «пропущено» с причиной, а не исчезает молча', async () => {
    const r = await run(bumpRule('perceptal'));
    const s = skippedBump(r);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('policy');
    expect(s[0].reason).toMatch(/perceptal/);
  });

  it('контроль: с правильным «perceptual» ровно то же правило применяется', async () => {
    const r = await run(bumpRule('perceptual'));
    expect(appliedBump(r)).toHaveLength(1);
    expect(skippedBump(r)).toHaveLength(0);
  });

  it('force не открывает ворота неизвестному уровню', async () => {
    const ok = await run(bumpRule('lossy', { force: true }));
    expect(appliedBump(ok)).toHaveLength(1);
    const bad = await run(bumpRule('perceptal', { force: true }));
    expect(appliedBump(bad)).toHaveLength(0);
  });

  it('пустой уровень тоже не проходит', async () => {
    for (const tier of [undefined, '', null]) {
      const r = await run(bumpRule(tier));
      expect(appliedBump(r), `уровень ${JSON.stringify(tier)} прошёл ворота`).toHaveLength(0);
    }
  });
});

describe('isKnownTier — спрашивать надо им, а не индексом', () => {
  it('знает ровно четыре уровня из TIER_RANK', () => {
    for (const tier of Object.keys(TIER_RANK)) expect(isKnownTier(tier)).toBe(true);
  });

  it('не путается на свойствах прототипа', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(isKnownTier(name), `${name} принят за уровень безопасности`).toBe(false);
    }
  });
});
