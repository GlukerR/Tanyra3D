// tests/architecture/per-model-state.test.mjs — состояние экрана принадлежит ТОЙ модели,
// которая на экране.
//
// Заведено 2026-08-21 после четвёртого дефекта одной и той же природы. Первые три нашёл
// браузер 2026-08-19 (`selectedFile` из пустого снимка; результат активной модели в
// сводке; кнопки инспекции у модели из пачки). Четвёртый — этот же ревью: стоит открыть
// модель, которую движок не читает, и обе кнопки инспекции гаснут ПРАВИЛЬНО, но дальше
// остаются погашенными на всех моделях, куда ни переключись, — до конца сеанса.
//
// Природа у всех четырёх одна: величина помодельная (живёт в rec.state), а её отражение
// на экране — общее, и переключение уносит его от соседа. Лечится не очередным
// присваиванием в очередном месте, а ОДНИМ источником правды.
//
// Метод честно ограничен: DOM в node-тестах нет, разметку и код читаем как ТЕКСТ.
// Сторож ловит возврат приёма («опять присвоили .disabled по месту»), а не всякий
// возможный дефект этого класса. Живьём такое по-прежнему ловится только браузером —
// поэтому в CONTEXT.md записано правило щёлкать переключение руками после правок
// жизненного цикла модели.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.ts'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'ui', 'i18n.ts'), 'utf8');

/**
 * Тело функции по имени — по балансу фигурных скобок.
 *
 * Первая редакция искала закрывающую скобку по ОТСТУПУ, и на `async function` отступ
 * считался неверно: перед именем стоит ещё слово, и «пробелы строки до имени» давали на
 * один пробел больше настоящего. Закрытие не находилось, функция возвращала весь остаток
 * файла — а сторож, которому подсунули полфайла, находит что угодно и не краснеет
 * никогда. Поймано пробой 2026-08-22: убрал вызов из showActiveModel, а тест прошёл.
 *
 * Баланс скобок отступа не знает и потому не ошибается. Строк со скобками внутри кавычек
 * в этих функциях нет; появятся — сторож придётся усложнить, и это будет видно сразу.
 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

describe('доступность кнопок инспекции считается в одном месте', () => {
  it('.disabled этих кнопок присваивается только внутри updateInspectButtons', () => {
    const lines = app.split('\n');
    const body = functionBody(app, 'updateInspectButtons');
    expect(body, 'не нашёл updateInspectButtons — якорь сменился').toBeTruthy();

    const strays = [];
    lines.forEach((line, i) => {
      if (!/\b(btnMetadata|btnValidation)\.disabled\s*=/.test(line)) return;
      if (body.includes(line)) return;
      strays.push(`${i + 1}: ${line.trim()}`);
    });
    expect(
      strays,
      'доступность кнопок снова ставится по месту — при переключении она уедет от соседней модели:\n'
      + strays.join('\n'),
    ).toEqual([]);
  });

  it('она считается из разбора активной модели, а не из чего попало', () => {
    const body = functionBody(app, 'updateInspectButtons');
    expect(body).toMatch(/btnMetadata\.disabled\s*=\s*!modelInspect/);
    expect(body).toMatch(/btnValidation\.disabled\s*=\s*!modelInspect/);
  });

  it('переключение на другую модель приводит кнопки в согласие с ней', () => {
    const body = functionBody(app, 'showActiveModel');
    expect(body, 'не нашёл showActiveModel — якорь сменился').toBeTruthy();
    // Вызов должен стоять БЕЗУСЛОВНО. Пока он жил внутри `if (!modelInspect …)`,
    // модель с разбором получала погашенные кнопки от соседа без разбора.
    const call = body.split('\n').find((l) => l.trim() === 'updateInspectButtons();');
    expect(call, 'showActiveModel не приводит кнопки в согласие с активной моделью').toBeTruthy();
    expect(
      call.length - call.trimStart().length,
      'вызов вложен в условие — значит срабатывает не всегда',
    ).toBe(4);
  });
});

describe('файл на экране берётся у записи, а не хранится отдельно', () => {
  // Пятый дефект того же класса (2026-08-21). Пока `selectedFile` была переменной, её
  // приходилось выставлять в КАЖДОМ пути, который меняет активную модель. Забытый путь
  // давал одно и то же: снимок модели, с которой ещё не уходили, пуст, applyModelState
  // обнуляет из него файл — и модель на экране есть, а файла у программы нет.
  //
  // 2026-08-18 так не собиралась последняя модель пачки; починили в selectModel.
  // 2026-08-21 то же самое всплыло в removeModel: удалил активную — соседняя не
  // разбиралась, кнопки инспекции мертвы, «Собрать» погашена, спасал только перезаход.
  it('selectedFile — вычисление, а не переменная', () => {
    expect(app, 'selectedFile снова объявлена переменной — путь переключения опять можно забыть')
      .not.toMatch(/\blet selectedFile\b/);
    expect(app, 'selectedFile больше не вычисляется из активной записи')
      .toMatch(/const selectedFile = \(\) =>/);
  });

  it('файл не лежит в снимке состояния модели', () => {
    // В снимке ему не место по той же причине: снимок пуст у модели, с которой ещё не
    // уходили, и любое чтение из него даёт null там, где файл заведомо есть.
    const start = app.indexOf('PER_MODEL_STATE');
    const end = app.indexOf('];', start);
    expect(start, 'не нашёл PER_MODEL_STATE — якорь сменился').toBeGreaterThan(-1);
    expect(app.slice(start, end), 'selectedFile вернулся в снимок состояния')
      .not.toContain("key: 'selectedFile'");
  });

  it('ему нигде не присваивают значение', () => {
    const strays = app.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*selectedFile\s*=/.test(l))
      .map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(strays, 'файлу на экране снова присваивают значение вручную:\n' + strays.join('\n')).toEqual([]);
  });
});

describe('подпись не из каталога не откатывается при смене языка', () => {
  it('у слоя языка есть чем снять ключ с элемента', () => {
    // Без этого единственным способом записать чужой текст остаётся `textContent =`,
    // а элемент помечен ключом — и apply() при смене языка вернёт фразу из разметки.
    expect(i18n, 'в ui/i18n.ts нет setRaw').toContain('function setRaw(');
    expect(i18n, 'setRaw не снимает ключ — тогда он ничего не решает').toMatch(
      /function setRaw[\s\S]{0,400}removeAttribute\('data-i18n'\)/,
    );
  });

  it('плашка отказа не пишется в обход слоя языка', () => {
    // Оба места (renderFail и showGenericError) ставят туда текст, которого в каталоге
    // нет: причину от движка и сообщение об ошибке запроса.
    const strays = app.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\.fail-(text|title)'\)!?\.textContent\s*=/.test(l))
      .map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(
      strays,
      'подпись плашки отказа снова ставится напрямую — смена языка её сотрёт:\n' + strays.join('\n'),
    ).toEqual([]);
  });

  it('в разметке плашка по-прежнему помечена ключом', () => {
    // Именно поэтому setRaw и нужен: пометка правильная и снимать её из разметки нельзя —
    // при пустой причине подпись обязана приходить из каталога.
    expect(html).toMatch(/class="fail-text"[^>]*data-i18n="fail\.text"/);
  });
});


describe('интерфейс не предлагает файл, которого нет', () => {
  // Сервер вправе убрать собранный файл САМ, и делает это в обычных случаях:
  // «Очистить рабочую папку», потолок в двенадцать исходников, потолок по объёму.
  // Интерфейс же держал ссылку и кнопку выгрузки дальше — и на нажатие писал в журнал
  // «Файл сохранён», хотя не сохранялось ничего (замер 2026-08-22).

  it('есть чем сверить ссылку, и сверка не выкачивает файл', () => {
    expect(app, 'нет проверки наличия результата').toMatch(/async function resultAlive\(/);
    const body = functionBody(app, 'resultAlive');
    expect(body, "проверка выкачивает файл целиком вместо HEAD").toMatch(/method:\s*'HEAD'/);
  });

  it('исчезнувший результат забывается целиком, а не одной ссылкой', () => {
    const body = functionBody(app, 'forgetResult');
    expect(body, 'нет forgetResult').toBeTruthy();
    // Числа без файла ещё правдивы, но галочка «собрана» уже врёт, а «Пересобрать»
    // осталась бы погашенной — человек заперт: файла нет и получить его нечем.
    for (const key of ['lastResult', 'lastBuildSignature', 'resultDownloadUrl']) {
      expect(body, `forgetResult не сбрасывает ${key}`).toContain(key);
    }
  });

  it('сверка идёт и при показе модели, и перед сохранением', () => {
    const show = functionBody(app, 'showActiveModel');
    expect(show, 'показ модели не сверяет результат — покажет кнопку, за которой ничего нет')
      .toContain('dropVanishedResults()');
    const save = app.slice(app.indexOf("exportSave.addEventListener"), app.indexOf("exportSave.addEventListener") + 900);
    expect(save, 'сохранение снова докладывает об успехе, не убедившись в нём')
      .toContain('resultAlive(');
  });

  it('«Очистить» забывает результаты, а не только чистит диск', () => {
    const i = app.indexOf("workdirClear.addEventListener");
    expect(i, 'не нашёл кнопку очистки').toBeGreaterThan(-1);
    expect(app.slice(i, i + 1200), 'после очистки список слева продолжит показывать галочки «собрана»')
      .toContain('dropVanishedResults()');
  });

  it('галочка «собрана» у активной модели берётся из живых переменных', () => {
    // Тот же класс, что у selectedFile и сводки: у активной модели снимок отстаёт на
    // одно действие. Пока значок читал только снимок, галочка ПОЯВЛЯЛАСЬ вовремя
    // (снимок после сборки делают нарочно) и не ИСЧЕЗАЛА — после очистки папки список
    // продолжал показывать ✓ у модели, результат которой уже забыт.
    const body = functionBody(app, 'renderModelList');
    expect(body, 'не нашёл отрисовку списка').toBeTruthy();
    expect(body, 'значок «собрана» снова читает только снимок состояния')
      .toMatch(/rec\.id === activeModelId \? lastResult : rec\.state\.lastResult/);
    // Второе условие того же значка, добавлено 2026-08-26: УСПЕШНАЯ сборка, а не любая.
    // `lastResult` заполняется и при `status: 'fail'` — в отчёте есть метрики и находки,
    // нет только файла, — и голое `!!lastResult` ставило «✓ собрана» упавшей модели.
    expect(body, 'значок «собрана» снова считает упавшую сборку успешной')
      .toMatch(/result\.status !== 'fail'/);
  });
});
describe('отказ сборки не выдаёт одну причину за другую', () => {
  it('журнал называет причину, когда она известна', () => {
    const body = functionBody(app, 'renderFail');
    expect(body, 'не нашёл renderFail — якорь сменился').toBeTruthy();
    expect(body, 'в журнал снова уходит одна фраза на любой отказ').toContain('log.notProcessed');
    expect(body, 'причина не берётся из результата движка').toMatch(/result\.error/);
  });

  it('общая фраза больше не утверждает непройденную проверку целостности', () => {
    // Она достаётся тому отказу, о котором мы НИЧЕГО не знаем, — и говорить в ней о
    // проверке, которой не было, значит называть выдуманную причину.
    for (const file of ['ui/locales/en.js', 'translations/ru.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const line = src.split('\n').find((l) => l.includes("'fail.text'"));
      expect(line, `в ${file} нет ключа fail.text`).toBeTruthy();
      expect(line, `${file}: fail.text снова называет причину, которой не знает`)
        .not.toMatch(/integrity|целостност/i);
    }
  });

  it('подсказка «!» не приклеивает догадку к известной причине', () => {
    // Два ключа вместо одного: причина известна — показываем её; неизвестна — только
    // тогда и уместна догадка про обрезанный файл.
    for (const file of ['ui/locales/en.js', 'translations/ru.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `в ${file} нет отдельного ключа для известной причины`)
        .toContain("'issue.unreadable.reason'");
      const withReason = src.split('\n').find((l) => l.includes("'issue.unreadable.reason'"));
      expect(withReason, `${file}: к названной причине снова приклеен совет про переэкспорт`)
        .not.toMatch(/re-export|переэкспорт|truncated|обрез/i);
    }
    const body = functionBody(app, 'issueTitle');
    expect(body, 'issueTitle не различает два случая').toContain('issue.unreadable.reason');
  });
});
