// tests/decisions-register.test.mjs — сторож свода docs/РЕШЕНИЯ_правил.md.
//
// Повод (Александр, 2026-08-18): «список решений таких есть? чтобы я мог проверить на
// разногласия?». Свод существует ради ОДНОЙ проверки — что код и заявленные правила не
// разошлись. Устаревший свод хуже отсутствующего: он даёт ложное спокойствие ровно там,
// где нужна тревога, — поэтому его актуальность сторожится, а не поддерживается вручную.
//
// Второе утверждение здесь важнее первого: Правило 11 (CLAUDE.md) называет РОВНО ТРИ
// места, где допустимо удалять замысел автора. Если в коде появится четвёртое —
// молча, без разговора с Александром, — падение этого теста будет единственным
// сигналом. Ни один другой сторож этого не ловит.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../addons/gltf/index.mjs'; // регистрирует каталоги в i18n
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

  it('удалять замысел автора могут РОВНО три места (узкое исключение Правила 11)', () => {
    // Список дословно из CLAUDE.md, Правило 11: scene/join (теряются структура узлов и
    // имена частей), textures/resize (выброшенные пиксели не вернуть), strip-colors
    // (настоящая раскраска вершин — ветка правила attributes/vertex-colors).
    //
    // «Список не должен расти без разговора» — это и проверяем. Признак разрушительности
    // берём из кода, а не из свода: свод сгенерирован, а сгенерированному верить на слово
    // здесь нельзя — иначе сторож проверял бы сам себя.
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'addons', 'gltf', 'rules.mts'), 'utf8');
    const ids = [...src.matchAll(/id: '([^']+)'/g)];
    const destructive = [];
    for (let i = 0; i < ids.length; i++) {
      const to = i + 1 < ids.length ? ids[i + 1].index : src.length;
      const body = src.slice(ids[i].index, to)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//')) // слово встречается и в пояснениях
        .join('\n');
      const fillsChannel = /\birreversible\s*(?:\?\?=|=[^=])|irreversibleSafety/.test(body);
      const meta = RULES.find((r) => r.meta.id === ids[i][1])?.meta;
      if (fillsChannel || meta?.dataLoss === 'significant') destructive.push(ids[i][1]);
    }

    expect(
      [...new Set(destructive)].sort(),
      'Список необратимых правил изменился. Правило 11 разрешает ровно три и требует '
      + 'разговора с Александром перед добавлением четвёртого. Если это намеренно — '
      + 'обновить CLAUDE.md и этот тест вместе.',
    ).toEqual(['attributes/vertex-colors', 'scene/join', 'textures/resize']);
  });

  it('ни одно разрушительное правило не включается само', () => {
    // Главная проверка на разногласия: удаление замысла обязано требовать явного выбора
    // человека в этом прогоне (Правило 11, условие 1). Правило, которое сносит замысел
    // «вместе с безопасными», — дефект, и найти его надо здесь, а не на модели клиента.
    for (const id of ['scene/join', 'textures/resize']) {
      const meta = RULES.find((r) => r.meta.id === id)?.meta;
      expect(meta, `правило ${id} исчезло`).toBeTruthy();
      const gated = Boolean(meta.feature || meta.featureGroup);
      expect(gated, `${id} должно требовать явной галочки`).toBe(true);
    }
    // vertex-colors — особый случай: правило входит в safe своей БЕЗОПАСНОЙ веткой
    // (белые каналы), а разрушительную включает отдельный флажок. Проверяем, что
    // второй выключатель на месте: без него safe снёс бы настоящую раскраску.
    const vc = RULES.find((r) => r.meta.id === 'attributes/vertex-colors')?.meta;
    expect(String(vc.enabled)).toMatch(/stripColors/);
  });
});
