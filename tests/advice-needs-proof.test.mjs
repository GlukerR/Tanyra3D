import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exclusiveGroups } from '../optimize2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const profile = (id) => JSON.parse(read(`profiles/${id}.json`));

const SERVER = read('server.mts');
const ASSISTANT = read('assistant.mts');

const типСтроки = (v) => (typeof v === 'string' ? 'строка' : `${v === undefined ? 'поля нет' : typeof v}`);

const PROFILES = fs.readdirSync(path.join(ROOT, 'profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

describe('совет отделён от плана сборки', () => {
  it('сервер берёт кодек-совет из advises, а не из baselineOpts', () => {
    expect(SERVER).toMatch(/const advises = \(plan\.advises \|\| \{\}\)/);
    expect(SERVER).toMatch(/includes\(advises\.codec/);
    expect(SERVER, 'совет снова выводится из плана сборки — он есть у всего и всегда')
      .not.toMatch(/includes\(planDefaults\.codec\)/);
  });

  it('план сборки доносит advises до интерфейса', () => {
    expect(ASSISTANT).toMatch(/advises: profile\.advises \|\| \{\}/);
  });

  it('умолчание — молчание: поля нет, значит совета нет', () => {
    const at = ASSISTANT.indexOf('advises: profile.advises');
    const line = ASSISTANT.slice(at, ASSISTANT.indexOf('\n', at));
    expect(line, 'у совета появился фолбэк — молчание перестало быть умолчанием')
      .not.toMatch(/baselineOpts|engineOpts/);
  });
});

describe('площадка советует только проверенное', () => {
  it('у Shopify совета по кодеку нет — вопрос открыт с 2026-08-10', () => {
    const p = profile('shopify');
    expect(p.advises && p.advises.codec,
      'Shopify снова советует кодек. Вопрос «читает ли витрина Meshopt» закрывался? '
      + 'Если да — источник в notes, и тогда правь этот тест вместе с профилем')
      .toBeFalsy();
  });

  it('прочерк не советует ничего — он не площадка', () => {
    const p = profile('_none');
    expect(p.advises && p.advises.codec).toBeFalsy();
  });

  it('у совета назван СВОЙ источник, а не какая-нибудь ссылка из файла', () => {
    const советующие = PROFILES.filter((id) => (profile(id).advises || {}).codec);
    expect(советующие.length, 'советов не осталось вовсе — проверка выродилась')
      .toBeGreaterThan(0);
    for (const id of советующие) {
      const источник = (profile(id).advises || {}).codecSource;
      expect(типСтроки(источник),
        `${id} советует кодек, но не называет источник. Добавь advises.codecSource — `
        + 'ссылку на документ площадки либо разбор с датой. Нет источника — нет совета')
        .toBe('строка');
      expect(источник.trim().length,
        `${id}: advises.codecSource пуст. Пустая строка — это не источник`)
        .toBeGreaterThan(20);
    }
  });

  it('советуемый кодек — из тех, что движок вообще знает', () => {
    const известные = exclusiveGroups().find((g) => g.id === 'geometry').members;
    for (const id of PROFILES) {
      const codec = (profile(id).advises || {}).codec;
      if (!codec) continue;
      expect(известные, `${id}: неизвестный кодек ${codec}`).toContain(codec);
    }
  });
});
