import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSource } from './helpers/source-files.mjs';

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

const БЕЗ_ОПИСАНИЯ = new Set(['resize-512', 'resize-1024', 'resize-2048', 'resize-4096']);


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
          if (!e.description && !БЕЗ_ОПИСАНИЯ.has(e.id)) {
            empty.push(`${name} [${lang}]: у ${e.id} пустое description`);
          }
        }
      }
    }
    expect(empty, empty.join('\n  ')).toEqual([]);
  });

  it('русский текст опции отличается от английского (перевод есть, а не копия)', () => {
    const список = (lang) => getAvailableExtensions('', lang, 'threejs');
    const same = [];
    for (const e of список('ru')) {
      const en = список('en').find((x) => x.id === e.id);
      if (e.description && en && e.description === en.description) same.push(e.id);
    }
    expect(список('ru').length, 'список опций пуст — тест проверяет пустоту').toBeGreaterThan(0);
    expect(same, `описание не переведено: ${same.join(', ')}`).toEqual([]);
  });
});


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
    const src = readSource('ui/app');
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


describe('Единственное объявление — режим KTX2', () => {
  const MODES = ['uastc', 'mixed'];

  it('умолчание даёт аддон, а не тот, кто его вызвал', () => {
    const bare = gltfAddon.normalizeOpts({});
    expect(MODES).toContain(bare.texMode);
    expect(gltfAddon.normalizeOpts({ advancedFeatures: ['ktx2'] }).texMode).toBe(bare.texMode);
    expect(gltfAddon.normalizeOpts({ texMode: undefined }).texMode).toBe(bare.texMode);
  });

  it('режим, объявленный профилем площадки, доживает до опций движка', () => {
    const lost = [];
    for (const { name, json } of profiles) {
      const wanted = (json.baselineOpts || {}).texMode;
      if (!wanted) continue;
      const got = gltfAddon.normalizeOpts({ ...json.baselineOpts, advancedFeatures: ['ktx2'] }).texMode;
      if (got !== wanted) lost.push(`${name}: просит ${wanted}, получает ${got}`);
    }
    expect(lost, lost.join('\n  ')).toEqual([]);
  });

  it('сервер не ставит свой режим поверх профиля', () => {
    const src = readSource('server');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const merge = code.match(/const engineOpts = \{[^;]*\};/);
    expect(merge, 'в server.mjs больше нет сборки engineOpts — тест устарел, обновить').toBeTruthy();
    expect(merge[0], 'сервер снова назначает texMode безусловно — профиль до движка не дойдёт')
      .not.toMatch(/texMode\s*:/);
  });

  it('интерфейс берёт режим у площадки, а не назначает сам', () => {
    const src = readSource('ui/app');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const bodyOf = (name) => {
      const at = code.indexOf(`function ${name}(`);
      if (at === -1) return null;
      let depth = 0;
      for (let i = code.indexOf('{', at); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(at, i + 1);
      }
      return null;
    };

    for (const fn of ['seedSelection', 'restoreSelection']) {
      const body = bodyOf(fn);
      expect(body, `в ui/app.js больше нет ${fn}() — тест устарел, обновить`).toBeTruthy();
      expect(body, `${fn}() перестала спрашивать площадку о режиме KTX2`).toMatch(/defaultKtx2Mode\(\)/);
    }

    expect(code, 'ui/app.js должен читать defaults с /api/extensions').toMatch(/platformDefaults\s*=/);
  });
});

describe('состав группы геометрии объявлен один раз (аудит Ф3-2)', () => {
  const members = exclusiveGroups().find((g) => g.id === 'geometry').members;

  it('первоисточник на месте и непуст', () => {
    expect(members.length, 'группа geometry исчезла — сторож ниже потерял смысл')
      .toBeGreaterThan(1);
  });

  for (const file of ['server.mts', 'ui/app.ts']) {
    it(`${file} не держит своей копии списка кодеков`, () => {
      const src = readSource(file);
      const код = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const имена = members.map((m) => `'${m}'`);
      const перечисления = [];
      for (const line of код.split(/\r?\n/)) {
        const сколько = имена.filter((n) => line.includes(n)).length;
        if (сколько >= 2) перечисления.push(line.trim().slice(0, 90));
      }
      expect(перечисления,
        `${file}: список кодеков переписан руками. Первоисточник — exclusiveGroups(), `
        + 'группа geometry; читать надо его, а не синхронизировать копию')
        .toEqual([]);
    });
  }
});
