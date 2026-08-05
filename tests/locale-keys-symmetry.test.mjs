// tests/locale-keys-symmetry.test.mjs — статическая проверка симметрии каталогов сообщений.
//
// Для каждой пары en.* + ru.* проверяет:
//   1. Все ключи английского каталога есть в русском (нет пропусков перевода).
//   2. Все ключи русского каталога есть в английском (нет осиротевших ключей).
//
// Это СТАТИЧЕСКИЙ тест, он не запускает оптимизатор. Импортирует только каталоги.
// Покрывает четыре пары:
//   - addons/gltf/messages/     (строки правил)
//   - core/messages/            (строки ядра)
//   - messages/                 (строки ассистента / отчёта)
//   - ui/locales/               (строки интерфейса — две пары: основные + validator)

import { describe, it, expect } from 'vitest';

import gltfEn from '../addons/gltf/messages/en.mjs';
import gltfRu from '../addons/gltf/messages/ru.mjs';

import coreEn from '../core/messages/en.mjs';
import coreRu from '../core/messages/ru.mjs';

import asstEn from '../messages/en.mjs';
import asstRu from '../messages/ru.mjs';

// UI-каталоги — .js файлы, их ключи определяем через статический разбор
import { readFileSync } from 'node:fs';

// Канонический список кодов gltf-validator — ISSUES.md из пакета (задание
// 2026-08-04-валидатор-остаток). Здесь же проверка: каждый validator.* ключ
// каталогов существует в пакете (нет сирот), и каждый код пакета переведён
// в обоих каталогах (нет пропусков).
const ISSUES_PATH = new URL('../node_modules/gltf-validator/ISSUES.md', import.meta.url);

const uiEnPath = new URL('../ui/locales/en.js', import.meta.url);
const uiRuPath = new URL('../translations/ru.js', import.meta.url);
const valEnPath = new URL('../ui/locales/validator-en.js', import.meta.url);
const valRuPath = new URL('../translations/validator-ru.js', import.meta.url);

function extractKeys(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return [...content.matchAll(/'([\w.]+)':\s/g)].map(m => m[1]);
}

// Все коды, которые умеет выдавать gltf-validator: строки ISSUES.md вида
// `|CODE|Message|Severity|` (заголовки таблиц `| Code | Message |` не матчатся
// из-за пробелов). Это единственный канонический источник: сирота в каталоге
// ловится здесь же, рядом с симметрией, а не в engine-contract (он про аддон
// и ядро, не про validator.*).
function validatorCodes() {
  const content = readFileSync(ISSUES_PATH, 'utf-8');
  const codes = new Set();
  for (const m of content.matchAll(/^\|([A-Z][A-Z0-9_]+)\|/gm)) codes.add(m[1]);
  return codes;
}

const uiEnKeys = extractKeys(uiEnPath);
const uiRuKeys = extractKeys(uiRuPath);
const valEnKeys = extractKeys(valEnPath);
const valRuKeys = extractKeys(valRuPath);

/**
 * Проверить, что все ключи каталога A присутствуют в каталоге B.
 * @param {Record<string, unknown>} a — исходный каталог
 * @param {Record<string, unknown>} b — целевой каталог
 * @param {string} label — подпись для сообщения об ошибке
 * @returns {string[]} список отсутствующих ключей
 */
function missingKeys(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = new Set(Object.keys(b));
  return aKeys.filter((k) => !bKeys.has(k));
}

// ============================================================================
// addons/gltf/messages — строки правил glTF-аддона
// ============================================================================

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

// ============================================================================
// core/messages — строки ядра
// ============================================================================

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

// ============================================================================
// messages (ассистент) — строки отчёта
// ============================================================================

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

// ============================================================================
// ui/locales/en.js ↔ ru.js — строки интерфейса (основной каталог)
// ============================================================================

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

// ============================================================================
// ui/locales/validator-*.js — перевод сообщений gltf-validator (отдельный файл)
// ============================================================================

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

// ============================================================================
// validator-каталоги ↔ пакет gltf-validator (ISSUES.md)
// ============================================================================
// Сторож задания 2026-08-04-валидатор-остаток: будущий переводчик не должен
// ни выдумать код (сирота в каталоге), ни забыть пару (пропуск кода пакета).
// Оба направления проверяются для ОБОИХ языков — сирота в одном каталоге
// валит симметрию, но пропуск кода оба каталога могут «пройти» вместе.

describe('validator-каталоги ↔ пакет gltf-validator (ISSUES.md)', () => {
  // Читаем и парсим ISSUES.md один раз на весь блок: три теста делят один
  // источник, а не читают файл заново.
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
