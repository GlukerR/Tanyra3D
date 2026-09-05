import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'addons', 'gltf', 'rules.mts'),
  'utf8',
);

describe('правило «переживи сбой одного элемента» (находка 2)', () => {
  it('шов attempt существует — единственное место, где сбой элемента превращается в результат', () => {
    expect(rulesSrc).toMatch(/async function attempt</);
  });

  it('per-element вызовы sharp/compressTexture идут через attempt, а не голыми', () => {
    const seams = (rulesSrc.match(/await attempt\(/g) || []).length;
    expect(seams, 'вызовов attempt меньше трёх — точку обработки элемента увели мимо шва').toBeGreaterThanOrEqual(3);
  });

  it('в fix() правил нет ручного try/catch — только шов и два санкционированных места', () => {
    const catches = rulesSrc.match(/} catch/g) || [];
    expect(catches, 'в rules.mts должно быть ровно 3 catch: шов attempt, нечитаемый json, уборка временной папки').toHaveLength(3);

    expect(rulesSrc).toContain('return { ok: true, value: await fn() }');
    expect(rulesSrc).toMatch(/catch\s*\{\s*json = null;\s*\}/);
    expect(rulesSrc).toMatch(/fs\.rmSync\(tmpDir[^)]*\);\s*\}\s*catch\s*\{/);
  });
});
