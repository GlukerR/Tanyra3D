import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../addons/gltf/index.mjs';
import { RULES } from '../addons/gltf/rules.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = path.join(PROJECT_ROOT, 'docs', 'РЕШЕНИЯ_правил.md');

describe('Свод решений правил', () => {
  it('файл существует и покрывает все правила движка', () => {
    expect(fs.existsSync(REGISTER), 'docs/РЕШЕНИЯ_правил.md нет — сгенерировать: node _work/gen-decisions.mjs').toBe(true);
    const text = fs.readFileSync(REGISTER, 'utf8');
    const missing = RULES.map((r) => r.meta.id).filter((id) => !text.includes(`\`${id}\``));
    expect(missing, `правил нет в своде: ${missing.join(', ')} — перегенерировать`).toEqual([]);
    expect(text).toContain(`Правил всего: ${RULES.length}.`);
  });

  it('удалять замысел автора могут РОВНО четыре места (узкое исключение Правила 11)', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'addons', 'gltf', 'rules.mts'), 'utf8');
    const ids = [...src.matchAll(/id: '([^']+)'/g)];
    const destructive = [];
    for (let i = 0; i < ids.length; i++) {
      const to = i + 1 < ids.length ? ids[i + 1].index : src.length;
      const body = src.slice(ids[i].index, to)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      const fillsChannel = /\birreversible\s*(?:\?\?=|=[^=])|irreversibleSafety/.test(body);
      const meta = RULES.find((r) => r.meta.id === ids[i][1])?.meta;
      if (fillsChannel || meta?.dataLoss === 'significant') destructive.push(ids[i][1]);
    }

    expect(
      [...new Set(destructive)].sort(),
      'Список необратимых правил изменился. Правило 11 разрешает ровно четыре и требует '
      + 'разговора с Александром перед добавлением пятого. Если это намеренно — '
      + 'обновить CLAUDE.md и этот тест вместе.',
    ).toEqual(['attributes/vertex-colors', 'interactivity/strip-dead', 'scene/join', 'textures/resize']);
  });

  it('ни одно разрушительное правило не включается само', () => {
    for (const id of ['scene/join', 'textures/resize']) {
      const meta = RULES.find((r) => r.meta.id === id)?.meta;
      expect(meta, `правило ${id} исчезло`).toBeTruthy();
      const gated = Boolean(meta.feature || meta.featureGroup);
      expect(gated, `${id} должно требовать явной галочки`).toBe(true);
    }
    const vc = RULES.find((r) => r.meta.id === 'attributes/vertex-colors')?.meta;
    expect(String(vc.enabled)).toMatch(/stripColors/);
  });
});
