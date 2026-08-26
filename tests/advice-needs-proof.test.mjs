// tests/advice-needs-proof.test.mjs — сторож правила «нет проверки — нет совета».
//
// ЗАКАЗ (Александр, 2026-08-26): «если где-то нет проверки, то ВСЕГДА мы не должны ничего
// рекомендовать и всё. лучше быть глупым инструментом и молчать, чем казаться умным и
// портить работу клиента».
//
// ОТКУДА ВЗЯЛОСЬ. В тот же день интерфейс научился ставить человеку галочку кодека по
// слову площадки — и брал это слово из `baselineOpts.codec`. А `baselineOpts` есть У
// ВСЕГО: у прочерка (`profiles/_none.json`), у самого движка (`engines/*.json`), у любого
// профиля. Читать его как совет значит советовать ВСЕГДА, включая места, где ничего не
// проверено.
//
// Цена была не теоретической. Площадка Shopify ставила человеку Meshopt, хотя её
// собственный профиль записывает это ОТКРЫТЫМ ВОПРОСОМ с 2026-08-10: читает ли витрина
// Meshopt, снаружи выяснить не удалось. Тот же движок в профиле Google рассуждает
// обратное — «базовый план обязан работать у того, кто ничего не настраивал».
//
// ЧТО СТЕРЕЖЁМ:
//   1. Совет живёт в отдельном поле `advises` и НЕ выводится из `baselineOpts`.
//   2. Умолчание — молчание: нет поля, нет совета.
//   3. У Shopify совета нет, пока открытый вопрос не закрыт.
//   4. Там, где совет есть, у профиля есть и источник.
//
// ПРОБА НА КРАСНОТУ пройдена: вернул чтение `planDefaults.codec` в сервер — краснеет
// раздел 1; дописал `advises` в shopify.json — краснеет раздел 3.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const profile = (id) => JSON.parse(read(`profiles/${id}.json`));

const SERVER = read('server.mts');
const ASSISTANT = read('assistant.mts');

// Все площадки, а не переписанный сюда руками список: новая площадка попадает под
// правило сама, и забыть её нельзя.
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
    // `|| {}` вместо подстановки чего-либо своего. Стоит здесь появиться фолбэку на
    // baselineOpts — и правило отменено, а тесты про Shopify всё ещё зелёные.
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

  it('где совет есть — у профиля названы источники', () => {
    // Совет без источника это и есть «казаться умным». Ссылку ищем в notes: там она и
    // живёт у всех профилей (`docs/ИСТОЧНИКИ.md` дублирует их таблицей).
    const советующие = PROFILES.filter((id) => (profile(id).advises || {}).codec);
    expect(советующие.length, 'советов не осталось вовсе — проверка выродилась')
      .toBeGreaterThan(0);
    for (const id of советующие) {
      const notes = (profile(id).notes || []).join(' ');
      expect(notes, `${id} советует кодек, но источника в notes нет`).toMatch(/https?:\/\//);
    }
  });

  it('советуемый кодек — из тех, что движок вообще знает', () => {
    for (const id of PROFILES) {
      const codec = (profile(id).advises || {}).codec;
      if (!codec) continue;
      expect(['meshopt', 'draco', 'quantize'], `${id}: неизвестный кодек ${codec}`)
        .toContain(codec);
    }
  });
});
