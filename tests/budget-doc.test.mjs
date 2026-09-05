import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ДОК = 'docs/БЮДЖЕТЫ_источники.md';
const текст = fs.readFileSync(path.join(root, ДОК), 'utf8');

const площадки = fs.readdirSync(path.join(root, 'profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'profiles', f), 'utf8'));
    return { id: j.id, title: j.title || j.id, enabled: j.enabled !== false };
  });

describe('документ источников не называет несуществующих площадок', () => {
  const бывшие = ['threejs', 'model-viewer', 'quest', 'mobile'];
  const живые = new Set(площадки.map((p) => p.id));

  for (const имя of бывшие) {
    it(`«${имя}» не выдаётся за площадку`, () => {
      if (живые.has(имя)) return;
      const до = текст.split('## Что было выброшено при сверке')[0]
        .split(`engines/${имя}.json`).join('');
      const строки = до.split('\n').filter((l) => l.includes(имя) && !l.trimStart().startsWith('*'));
      expect(
        строки,
        `${ДОК} называет «${имя}» как площадку, а такого профиля нет. `
        + 'Движок и цель — две разные оси (ARCHITECTURE.md §4g): проверить, не имелся ли в виду прочерк (_none).',
      ).toEqual([]);
    });
  }
});

describe('у каждой площадки есть источники её чисел', () => {
  for (const p of площадки.filter((x) => x.enabled)) {
    it(`${p.title} — свой раздел в документе`, () => {
      const заголовки = [...текст.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      expect(
        заголовки.some((h) => h.includes(p.title)),
        `Площадка «${p.title}» есть в profiles/, а раздела с её источниками в ${ДОК} нет. `
        + 'Правило проекта: числа без источника не пишутся — завести раздел с цитатами из первоисточника.',
      ).toBe(true);
    });
  }
});
