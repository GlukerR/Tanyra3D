// tests/single-declaration.test.mjs — сторожа принципа «объявлено один раз».
//
// Два дефекта одного рода, закрытых 2026-08-04:
//
//   1. Текст опций лежал в profiles/*.json — четыре площадки держали четыре копии
//      одного и того же (13 065 знаков, из них ~10 000 дубли). Новая площадка
//      означала повторный перевод всех десяти опций, а три из четырёх профилей были
//      к тому же одноязычными: включение любого показало бы английский текст в
//      русском интерфейсе.
//   2. Взаимоисключающие группы объявлялись ДВАЖДЫ: EXCLUSIVE_FEATURES в аддоне и
//      EXCLUSIVE_GROUPS в ui/app.js. Списки были разные (пара кодеков против пары
//      текстур) и никто их не сверял — интерфейс мог погасить одну галочку, а
//      движок выбрать другую.
//
// Оба лечатся одинаково: объявление одно, остальные читают. Эти тесты сторожат,
// что копия не вернётся.
//
// Слой 1 карты тестов (tests/КАРТА_ТЕСТОВ.md): движка просмотра не знают, площадки
// перебираются данными — второй профиль и второй аддон подхватятся сами.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exclusiveGroups } from '../optimize2.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { getAvailableExtensions } from '../assistant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');

const profileNames = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
const profiles = profileNames.map((f) => ({
  name: f,
  json: JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')),
}));

const catalogs = {
  ru: (await import('../messages/ru.mjs')).default,
  en: (await import('../messages/en.mjs')).default,
};

// ============================================================================
// 1. Текст опций объявлен один раз — в каталоге, не в профиле
// ============================================================================

describe('Единственное объявление — текст опций живёт в каталоге', () => {
  it('профили не несут title/description/impact у опций (копия не вернулась)', () => {
    const offenders = [];
    for (const { name, json } of profiles) {
      for (const e of json.availableExtensions || []) {
        for (const field of ['title', 'description', 'impact']) {
          if (field in e) offenders.push(`${name}: опция ${e.id} снова несёт ${field}`);
        }
      }
    }
    expect(offenders, offenders.join('\n  ')).toEqual([]);
  });

  it('у каждой опции каждого профиля есть ключи текста в ОБОИХ каталогах', () => {
    const missing = [];
    for (const { name, json } of profiles) {
      for (const e of json.availableExtensions || []) {
        for (const field of ['title', 'description', 'impact']) {
          for (const lang of ['ru', 'en']) {
            const key = `option.${e.id}.${field}`;
            if (!(key in catalogs[lang])) missing.push(`${name}: ${key} нет в ${lang}`);
          }
        }
      }
    }
    expect(missing, missing.join('\n  ')).toEqual([]);
  });

  it('ассистент отдаёт непустой текст на обоих языках для всех площадок', () => {
    const empty = [];
    for (const { name, json } of profiles) {
      for (const lang of ['ru', 'en']) {
        for (const e of getAvailableExtensions(json.id, lang)) {
          if (!e.title) empty.push(`${name} [${lang}]: у ${e.id} пустой title`);
          if (!e.description) empty.push(`${name} [${lang}]: у ${e.id} пустое description`);
        }
      }
    }
    expect(empty, empty.join('\n  ')).toEqual([]);
  });

  it('русский текст опции отличается от английского (перевод есть, а не копия)', () => {
    // Ловит подстановку английской строки вместо перевода: до правки три профиля
    // из четырёх были одноязычными и именно так себя и вели.
    const same = [];
    for (const e of getAvailableExtensions('threejs', 'ru')) {
      const en = getAvailableExtensions('threejs', 'en').find((x) => x.id === e.id);
      if (e.description && en && e.description === en.description) same.push(e.id);
    }
    expect(same, `описание не переведено: ${same.join(', ')}`).toEqual([]);
  });
});

// ============================================================================
// 2. Взаимоисключающие группы объявлены один раз — в аддоне
// ============================================================================

describe('Единственное объявление — взаимоисключающие группы', () => {
  it('ядро отдаёт группы аддона наружу', () => {
    const groups = exclusiveGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(typeof g.id).toBe('string');
      expect(Array.isArray(g.members)).toBe(true);
      expect(g.members.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('каждый член группы — существующая фича аддона', () => {
    const known = new Set(Object.keys(gltfAddon.ADVANCED_FEATURES));
    const unknown = [];
    for (const g of exclusiveGroups()) {
      for (const m of g.members) if (!known.has(m)) unknown.push(`${g.id}: ${m}`);
    }
    expect(unknown, unknown.join('\n  ')).toEqual([]);
  });

  it('группы не пересекаются: фича принадлежит одной группе', () => {
    const seen = new Map();
    const dupes = [];
    for (const g of exclusiveGroups()) {
      for (const m of g.members) {
        if (seen.has(m)) dupes.push(`${m}: ${seen.get(m)} и ${g.id}`);
        seen.set(m, g.id);
      }
    }
    expect(dupes, dupes.join('\n  ')).toEqual([]);
  });

  it('в интерфейсе нет своего списка взаимоисключений (копия не вернулась)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8');
    // Комментарии вырезаем: в них про старый список рассказывает история правки.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code, 'ui/app.js снова объявляет группы сам — их объявляет аддон')
      .not.toMatch(/EXCLUSIVE_GROUPS\s*=/);
  });

  it('копия отдаётся наружу, а не внутренний объект аддона', () => {
    const first = exclusiveGroups();
    first[0].members.push('подделка');
    expect(exclusiveGroups()[0].members).not.toContain('подделка');
  });
});
