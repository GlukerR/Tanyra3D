// tests/ktx-manifest.test.mjs — сторож манифеста нативного KTX.
//
// Ревью 2026-08-10 (P1.7): сборочный путь качал нативную программу с GitHub,
// распаковывал, запускал и вкладывал в устанавливаемое приложение — не проверяя ничего.
//
// Здесь проверяется не «работает ли сборка» (для этого нужны четыре платформы), а то,
// что ломается молча: манифест разошёлся с версией в скрипте, или в нём нет записи для
// платформы, которую скрипт умеет просить. И то и другое обнаружилось бы только на
// релизном раннере — то есть в самый неудобный момент.
//
// Сеть здесь не трогаем: хеши сверяются с публикацией Khronos руками при обновлении
// версии, а тест следит за целостностью самой таблицы.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'bundle-ktx.mjs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ktx-manifest.json'), 'utf8'));

/** Версия, которую скрипт кладёт в пакет. Оракул — сам скрипт, а не наша память. */
const VERSION = (SCRIPT.match(/const VERSION = '([^']+)'/) || [])[1];

// Имена, которые умеет попросить assetName() — по одному на платформу и разрядность.
// Список выведен из кода скрипта, а не написан рядом: разойдётся код — разойдётся и он.
const EXPECTED = [
  'Windows-x64.exe', 'Windows-arm64.exe',
  'Darwin-x86_64.pkg', 'Darwin-arm64.pkg',
  'Linux-x86_64.tar.bz2', 'Linux-arm64.tar.bz2',
].map((tail) => `KTX-Software-${VERSION}-${tail}`);

describe('манифест KTX', () => {
  it('версия читается из скрипта — иначе проверки ниже бессмысленны', () => {
    expect(VERSION, 'в bundle-ktx.mjs не нашлось const VERSION').toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('запись есть на каждую платформу, которую скрипт умеет просить', () => {
    const have = Object.keys(manifest.sha256 || {});
    const missing = EXPECTED.filter((n) => !have.includes(n));
    expect(
      missing,
      `нет хешей: ${missing.join(', ')}. Сборка на этих платформах пойдёт непроверенной. `
        + 'Посчитать SHA-256 архива из релиза Khronos и вписать в scripts/ktx-manifest.json.',
    ).toEqual([]);
  });

  it('в манифесте нет записей от прошлой версии', () => {
    // Хеш старой версии — хуже отсутствия: он выглядит как проверка, но относится
    // к файлу, который мы уже не качаем.
    const stale = Object.keys(manifest.sha256 || {}).filter((n) => !n.includes(`-${VERSION}-`));
    expect(stale, `записи не от версии ${VERSION}: ${stale.join(', ')}`).toEqual([]);
  });

  it('все значения — настоящие SHA-256', () => {
    for (const [name, hash] of Object.entries(manifest.sha256 || {})) {
      expect(hash, `${name}: не похоже на SHA-256`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('ОТСУТСТВИЕ записи тоже останавливает сборку, а не просто предупреждает', () => {
    // Ревью 2026-08-10 (D3). Сначала здесь было «скажем громко и продолжим»: расчёт
    // был на то, что сторож не даст манифесту разойтись. Расчёт неверный — сторож
    // живёт в test.yml, а установщик собирает release.yml, где тестов не было вовсе.
    // Ворота стояли открытыми ровно на том раннере, ради которого писались.
    const src = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const verify = src.slice(src.indexOf('function verifyHash'), src.indexOf('async function download'));
    const noEntry = verify.slice(verify.indexOf('if (!expected)'));
    expect(noEntry, 'ветка «нет записи» не останавливает сборку').toMatch(/halt\(/);
    expect(noEntry.slice(0, noEntry.indexOf('halt(')), 'до halt стоит return — сборка продолжится')
      .not.toMatch(/\breturn\b/);
  });

  it('релизный раннер прогоняет этого сторожа перед сборкой', () => {
    // Иначе всё вышесказанное — украшение: проверять манифест некому.
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const bundleAt = wf.indexOf('scripts/bundle-ktx.mjs');
    expect(bundleAt, 'в release.yml не нашлось шага сборки ktx').toBeGreaterThan(-1);
    const before = wf.slice(0, bundleAt);
    expect(before, 'сторож манифеста не гоняется ДО укладки бинарника').toMatch(/ktx-manifest\.test\.mjs/);
  });

  it('несовпадение останавливает сборку и не смягчается --optional', () => {
    // Проверка по исходнику: гонять настоящую сборку в тестах нельзя — она качает
    // мегабайты из сети. Но отличить halt от die можно и здесь, и это ровно та
    // разница, ради которой halt заведён.
    const src = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src, 'нет отказа, не смягчаемого --optional').toMatch(/const halt = /);
    // verifyHash обязан звать именно halt: die() при --optional промолчал бы и собрал
    const verify = src.slice(src.indexOf('function verifyHash'), src.indexOf('async function download'));
    expect(verify).toMatch(/halt\(/);
    expect(verify, 'verifyHash смягчает отказ через die()').not.toMatch(/\bdie\(/);
  });

  it('версия инструмента сверяется, а не только факт запуска', () => {
    const src = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src).toMatch(/function checkBinary/);
    // С границей, а не подстрокой: '4.4.20'.includes('4.4.2') — истина, и версия
    // 4.4.20 прошла бы за 4.4.2. Ревью 2026-08-10 (D7).
    expect(src, 'версия не сверяется с VERSION').toMatch(/versionRe\.test\(out\)/);
    expect(src, 'сверка подстрокой — 4.4.20 пройдёт за 4.4.2').not.toMatch(/out\.includes\(VERSION\)/);
    // и на ОБОИХ путях: уже лежащий файл — тот самый случай, который хешем не ловится
    const calls = (src.match(/checkBinary\(/g) || []).length;
    expect(calls, 'checkBinary зовётся не на обоих путях').toBeGreaterThanOrEqual(3);
  });
});
