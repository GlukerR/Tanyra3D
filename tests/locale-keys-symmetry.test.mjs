import { describe, it, expect } from 'vitest';

import gltfEn from '../addons/gltf/messages/en.mjs';
import gltfRu from '../addons/gltf/messages/ru.mjs';

import coreEn from '../core/messages/en.mjs';
import coreRu from '../core/messages/ru.mjs';

import asstEn from '../messages/en.mjs';
import asstRu from '../messages/ru.mjs';

import { readFileSync } from 'node:fs';

const ISSUES_PATH = new URL('../node_modules/gltf-validator/ISSUES.md', import.meta.url);

const uiEnPath = new URL('../ui/locales/en.js', import.meta.url);
const uiRuPath = new URL('../translations/ru.js', import.meta.url);
const valEnPath = new URL('../ui/locales/validator-en.js', import.meta.url);
const valRuPath = new URL('../translations/validator-ru.js', import.meta.url);

function extractKeys(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return [...content.matchAll(/'([\w.]+)':\s/g)].map(m => m[1]);
}

function validatorCodes() {
  const content = readFileSync(ISSUES_PATH, 'utf-8');
  const codes = new Set();
  for (const m of content.matchAll(/^\|([A-Z][A-Z0-9_]+)\|/gm)) codes.add(m[1]);
  return codes;
}

function extractTexts(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const out = new Map();
  const re = /'(validator\.[A-Z0-9_]+)':\s*\(\)\s*=>\s*(['"])([\s\S]*?)\2\s*,/g;
  for (const m of content.matchAll(re)) out.set(m[1], m[3]);
  return out;
}

const uiEnKeys = extractKeys(uiEnPath);
const uiRuKeys = extractKeys(uiRuPath);
const valEnKeys = extractKeys(valEnPath);
const valRuKeys = extractKeys(valRuPath);

function missingKeys(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = new Set(Object.keys(b));
  return aKeys.filter((k) => !bKeys.has(k));
}


describe('addons/gltf/messages — en.mjs ↔ ru.mjs', () => {
  it('все ключи en.mjs есть в ru.mjs (нет пропусков перевода)', () => {
    const missing = missingKeys(gltfEn, gltfRu);
    expect(missing, `Пропущенные ключи в ru.mjs: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи ru.mjs есть в en.mjs (нет осиротевших ключей)', () => {
    const missing = missingKeys(gltfRu, gltfEn);
    expect(missing, `Лишние ключи в ru.mjs (нет в en.mjs): ${missing.join(', ')}`).toEqual([]);
  });

  it('количество ключей совпадает', () => {
    expect(Object.keys(gltfRu).length).toBe(Object.keys(gltfEn).length);
  });
});


describe('core/messages — en.mjs ↔ ru.mjs', () => {
  it('все ключи en.mjs есть в ru.mjs', () => {
    const missing = missingKeys(coreEn, coreRu);
    expect(missing, `Пропущенные ключи в ru.mjs: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи ru.mjs есть в en.mjs', () => {
    const missing = missingKeys(coreRu, coreEn);
    expect(missing, `Лишние ключи в ru.mjs (нет в en.mjs): ${missing.join(', ')}`).toEqual([]);
  });

  it('количество ключей совпадает', () => {
    expect(Object.keys(coreRu).length).toBe(Object.keys(coreEn).length);
  });
});


describe('messages (assistant) — en.mjs ↔ ru.mjs', () => {
  it('все ключи en.mjs есть в ru.mjs', () => {
    const missing = missingKeys(asstEn, asstRu);
    expect(missing, `Пропущенные ключи в ru.mjs: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи ru.mjs есть в en.mjs', () => {
    const missing = missingKeys(asstRu, asstEn);
    expect(missing, `Лишние ключи в ru.mjs (нет в en.mjs): ${missing.join(', ')}`).toEqual([]);
  });

  it('количество ключей совпадает', () => {
    expect(Object.keys(asstRu).length).toBe(Object.keys(asstEn).length);
  });
});


describe('ui/locales — en.js ↔ ru.js', () => {
  it('все ключи en.js есть в ru.js', () => {
    const ruSet = new Set(uiRuKeys);
    const missing = uiEnKeys.filter(k => !ruSet.has(k));
    expect(missing, `Пропущенные ключи в ru.js: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи ru.js есть в en.js', () => {
    const enSet = new Set(uiEnKeys);
    const missing = uiRuKeys.filter(k => !enSet.has(k));
    expect(missing, `Лишние ключи в ru.js (нет в en.js): ${missing.join(', ')}`).toEqual([]);
  });

  it('количество ключей совпадает', () => {
    expect(uiRuKeys.length).toBe(uiEnKeys.length);
  });
});


describe('ui/locales — validator-en.js ↔ validator-ru.js', () => {
  it('все ключи validator-en.js есть в validator-ru.js', () => {
    const ruSet = new Set(valRuKeys);
    const missing = valEnKeys.filter(k => !ruSet.has(k));
    expect(missing, `Пропущенные ключи в validator-ru.js: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи validator-ru.js есть в validator-en.js', () => {
    const enSet = new Set(valEnKeys);
    const missing = valRuKeys.filter(k => !enSet.has(k));
    expect(missing, `Лишние ключи в validator-ru.js (нет в validator-en.js): ${missing.join(', ')}`).toEqual([]);
  });

  it('количество ключей совпадает', () => {
    expect(valRuKeys.length).toBe(valEnKeys.length);
  });
});


describe('validator-каталоги ↔ пакет gltf-validator (ISSUES.md)', () => {
  const packageCodes = validatorCodes();

  it('пакет gltf-validator установлен и ISSUES.md не пуст (страховка от тихого зелёного)', () => {
    expect(packageCodes.size, 'node_modules/gltf-validator/ISSUES.md не найден или не содержит кодов').toBeGreaterThan(0);
  });

  it('каждый код пакета переведён в validator-en.js и validator-ru.js (нет пропусков)', () => {
    const enSet = new Set(valEnKeys);
    const ruSet = new Set(valRuKeys);
    const uncovered = [...packageCodes]
      .filter((c) => !enSet.has('validator.' + c) || !ruSet.has('validator.' + c))
      .sort();
    expect(uncovered, `Коды пакета без перевода (нет хотя бы в одном каталоге):\n  ${uncovered.join('\n  ')}`).toEqual([]);
  });

  it('каждый validator.* ключ каталогов существует в пакете (нет сирот)', () => {
    const orphans = [...new Set([...valEnKeys, ...valRuKeys])]
      .filter((k) => k.startsWith('validator.') && !packageCodes.has(k.slice('validator.'.length)))
      .sort();
    expect(orphans, `validator.* ключи, которых нет в ISSUES.md (сироты):\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('количество validator.* ключей равно числу кодов пакета', () => {
    expect(valEnKeys.length).toBe(packageCodes.size);
    expect(valRuKeys.length).toBe(packageCodes.size);
  });
});


describe('validator-каталоги — вид фразы', () => {
  const catalogs = [['validator-en.js', extractTexts(valEnPath)], ['validator-ru.js', extractTexts(valRuPath)]];

  it.each(catalogs)('%s — каждая фраза заканчивается знаком конца предложения', (_name, texts) => {
    const bad = [...texts].filter(([, v]) => !/[.!?…»)]$/.test(v.trim())).map(([k, v]) => `${k} :: ${v}`);
    expect(bad, `Фразы без завершающего знака:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it.each(catalogs)('%s — нет идентификаторов расширений, загрузчиков и движков (Правило 10)', (_name, texts) => {
    const forbidden = /KHR_[A-Za-z_]+|EXT_[A-Za-z_]+|KTX2Loader|Three\.?js|basisu|Basis Universal/i;
    const bad = [...texts].filter(([, v]) => forbidden.test(v)).map(([k, v]) => `${k} :: ${v}`);
    expect(bad, `Технические имена в тексте для человека:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it.each(catalogs)('%s — ни одна фраза не пуста', (_name, texts) => {
    const bad = [...texts].filter(([, v]) => v.trim().length < 8).map(([k, v]) => `${k} :: ${v}`);
    expect(bad, `Пустые или обрубленные фразы:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('разбор текстов не молчит: найдено столько же фраз, сколько ключей', () => {
    expect(extractTexts(valEnPath).size).toBe(valEnKeys.length);
    expect(extractTexts(valRuPath).size).toBe(valRuKeys.length);
  });
});
