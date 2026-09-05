import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';

import { runOptimize } from '../core/engine.mjs';
import gltfAddon from '../addons/gltf/index.mjs';

const RULE = 'attributes/vertex-colors';

async function paintedModel(file) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const color = doc.createAccessor()
    .setType('VEC4')
    .setArray(new Float32Array([0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1]))
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('COLOR_0', color);
  const mesh = doc.createMesh('Painted').addPrimitive(prim);
  const node = doc.createNode('PaintedNode').setMesh(mesh);
  doc.createScene('Scene').addChild(node);
  await new NodeIO().write(file, doc);
}

async function run(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-labels-'));
  const src = path.join(tmp, 'painted.glb');
  await paintedModel(src);
  return runOptimize(gltfAddon, src, { outDir: path.join(tmp, 'out'), force: true, ...opts });
}

describe('уровень безопасности правила vertex-colors', () => {
  it('это numeric, а не provable — допуск 0.999 не строгое равенство', () => {
    const rule = gltfAddon.rules.find((r) => r.meta.id === RULE);
    expect(rule, `правило ${RULE} не найдено`).toBeTruthy();
    expect(rule.meta.fixSafety).toBe('numeric');
  });

  it('и правило по-прежнему применяется автоматически — потолок это допускает', async () => {
    const r = await run({ safe: true });
    expect(r.status).toBe('ok');
    const mentioned = [...r.applied, ...r.skipped, ...r.findings].some((x) => x.ruleId === RULE);
    expect(mentioned, 'правило вовсе не дошло до работы — проверка ниже ничего не значит').toBe(true);
  });
});

describe('разрушительная ветка не прячется за ярлыком правила', () => {
  it('удаление раскрашенных цветов отчитывается как lossy', async () => {
    const r = await run({ safe: true, stripColors: true, advancedFeatures: ['strip-colors'] });
    const lost = r.applied.filter((a) => a.ruleId === RULE && a.dataLoss === 'significant');
    expect(lost.length, 'разрушительная ветка не сработала — нечего проверять').toBeGreaterThan(0);
    for (const entry of lost) {
      expect(entry.fixSafety, `запись о потере данных помечена как «${entry.fixSafety}»`).toBe('lossy');
      expect(entry.reversible).toBe(false);
    }
  });

  it('а безопасные строки того же правила остаются на своём уровне', async () => {
    const r = await run({ safe: true, stripColors: true, advancedFeatures: ['strip-colors'] });
    const safe = r.applied.filter((a) => a.ruleId === RULE && a.dataLoss !== 'significant');
    for (const entry of safe) {
      expect(entry.fixSafety, 'безопасная строка внезапно стала lossy').toBe('numeric');
    }
  });
});
