// tests/architecture/rule-resilience.test.mjs — структурный сторож «переживи сбой элемента».
//
// Находка 2 ревью 2026-08-15 (assistants/review/ЗАДАНИЕ_2026-08-15-заплатки-в-правила.md):
// осторожность «одна битая картинка не роняет прогон» была выражена в rules.mts разными
// способами и держалась на памяти автора — новое правило с внешним инструментом могло её
// забыть, и прогон падал на первой же битой текстуре. Теперь правило закреплено структурно:
//
//   1. Шов один — attempt() в addons/gltf/rules.mts. Он ловит отказ ОДНОГО элемента и
//      возвращает { ok:false, reason }, а что делать дальше решает само правило.
//   2. В fix() правил нет ручного try/catch: единственные catch-блоки во всём файле —
//      сам шов, деградация чтения исходника (unsupportedExtensions) и чистка временного
//      каталога KTX2. Новый catch в правиле — сигнал, что автор обходит шов.
//
// Тот же приём, что у «правила истины» (tests/bugs-found.test.mjs): тест читает ИСХОДНИК
// и ломается, когда дисциплина нарушена, а не когда результат стал хуже. Строки ниже —
// решение, а не подгонка: легитимный новый catch добавляется сюда явно, как в белый
// список i18n-discipline.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'addons', 'gltf', 'rules.mts'),
  'utf8',
);

describe('правило «переживи сбой одного элемента» (находка 2)', () => {
  it('шов attempt существует — единственное место, где сбой элемента превращается в результат', () => {
    expect(rulesSrc).toMatch(/async function attempt</);
  });

  it('per-element вызовы sharp/compressTexture идут через attempt, а не голыми', () => {
    // Три точки, где обрабатывается ОДИН элемент из списка: textures/resize (sharp),
    // textures/webp (compressTexture), textures/ktx2 (перекодирование в PNG перед toktx).
    //
    // Граница снизу, а не точное число: четвёртая такая точка в новом правиле — это
    // соблюдение дисциплины, а не её нарушение, и краснеть на ней тест не должен.
    // Обратную сторону — «шов обошли» — стережёт проверка ниже: она считает catch-блоки,
    // и голый try/catch в правиле покраснеет независимо от того, как названа переменная.
    const seams = (rulesSrc.match(/await attempt\(/g) || []).length;
    expect(seams, 'вызовов attempt меньше трёх — точку обработки элемента увели мимо шва').toBeGreaterThanOrEqual(3);
  });

  it('в fix() правил нет ручного try/catch — только шов и два санкционированных места', () => {
    // Ровно три catch-блока во всём rules.mts. Любой новый catch в правиле — это обход
    // шва: либо сбой одного элемента снова начнёт ронять прогон, либо место обязано быть
    // добавлено в белый список ниже с обоснованием.
    const catches = rulesSrc.match(/} catch/g) || [];
    expect(catches, 'в rules.mts должно быть ровно 3 catch-блока (см. комментарий к тесту)').toHaveLength(3);

    // Три санкционированных места — по подстроке на каждое.
    expect(rulesSrc).toContain('return { ok: true, value: await fn() }'); // сам шов attempt
    expect(rulesSrc).toContain('list = []; // файл не разобрался'); // unsupportedExtensions: деградация чтения
    expect(rulesSrc).toContain('/* занят — подчистит ОС */'); // ktx2: чистка временного каталога
  });
});
