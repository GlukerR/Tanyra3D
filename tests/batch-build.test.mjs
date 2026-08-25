// tests/batch-build.test.mjs — пакетная сборка: несколько моделей, выбор галочками.
//
// Слово Александра 2026-08-18: «если пакетная обработка, то слева в меню в приложении
// должна быть галочка на выбор каждой модели. то есть я из 50 загруженных для гугл стор
// хочу только 20. я должен иметь возможность их все 20 и выбрать».
//
// Проверки статические — поведение живёт в браузере, а сюда смотрит сторож за теми
// местами, откуда беда уже приходила или придёт молча. Сквозная проверка сделана в живом
// приложении 2026-08-18: четыре файла (три .glb и один .txt) → три строки в списке, одна
// строка отказа, «Собрать выбранные (3)», три запроса `/api/optimize`, три галочки
// «собрана». Тем же прогоном найден дефект, который стережёт первый тест ниже.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const HTML = read('ui', 'index.html');
const RU = read('translations', 'ru.js');
const EN = read('ui', 'locales', 'en.js');

/**
 * Исходник без комментариев.
 *
 * Сторожа смотрят на ПОРЯДОК строк («проверка пакета стоит до проверки сборки», «записи
 * снимаются до первого await»), и комментарий, объясняющий ровно это, содержит те же
 * слова. Первый заход сломался на собственных пояснениях: фраза «до первого await» шла
 * раньше самого await, и тест объявил дефектом текст, который его же и описывает.
 *
 * `https://` не трогаем: двоеточие перед слэшами выводит ссылку из-под правила.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

const APP = stripComments(readSource('ui/app'));

/** Тело функции по её объявлению — грубо, по балансу фигурных скобок. */
function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

describe('пакетная сборка', () => {
  it('файл берётся из записи модели, а не из снимка состояния', () => {
    // ДЕФЕКТ, найденный проверкой в браузере 2026-08-18. Снимок состояния заполняется
    // в captureActiveModel, то есть при УХОДЕ с модели. У той, с которой ещё не уходили,
    // он пуст — и applyModelState обнулял `selectedFile`. При загрузке по одному это
    // никогда не всплывало: пустой снимок всегда принадлежал активной модели, а на
    // активную selectModel не переключается. Бросок пачки заводит N записей разом и
    // возвращается на первую, поэтому снимок ПОСЛЕДНЕЙ так и остаётся пустым — и её
    // сборка тихо не делала ничего: runOptimize выходит на первой строке без файла.
    // В браузере это выглядело как «три модели, два запроса на сервер».
    //
    // ПОЧИНКА ПЕРЕЕХАЛА (2026-08-21), и утверждение вслед за ней. Раньше здесь стояло
    // «selectModel обязан содержать selectedFile = rec.file» — то есть проверялась ФОРМА
    // одной починки в одном пути. Она и подвела: тот же дефект вылез вторым путём
    // (removeModel), где строчку просто забыли, а сторож этого не видел — он смотрел не
    // туда. Удалил активную модель — соседняя не разбиралась, кнопки инспекции мертвы,
    // «Собрать» погашена; спасал только перезаход.
    //
    // Теперь файл ВЫЧИСЛЯЕТСЯ из активной записи, и забыть его негде: путей присваивания
    // не осталось вовсе. Утверждаем именно это — гарантию, а не строчку в одной функции.
    // Подробный разбор класса — tests/architecture/per-model-state.test.mjs.
    expect(
      /const selectedFile = \(\) =>[^\n]*activeModel\(\)/.test(APP),
      'файл на экране больше не вычисляется из активной записи — значит его снова где-то '
        + 'присваивают, и следующий забытый путь даст тот же дефект',
    ).toBe(true);
    expect(
      APP.split('\n').filter((l) => /^\s*selectedFile\s*=/.test(l)),
      'файлу на экране снова присваивают значение вручную',
    ).toEqual([]);
    // И снимок его не хранит: снимок пуст у модели, с которой ещё не уходили.
    const snapshot = APP.slice(APP.indexOf('PER_MODEL_STATE'), APP.indexOf('];', APP.indexOf('PER_MODEL_STATE')));
    expect(snapshot, 'selectedFile вернулся в снимок состояния').not.toContain("key: 'selectedFile'");
  });

  it('галочка выбора не переключает показанную модель', () => {
    // Отметить модель для сборки и вывести её в вьюпорт — разные действия. Без
    // stopPropagation щелчок по двадцатой галочке перезагружал бы вьюпорт двадцатой
    // моделью, чего человек не просил. Та же причина, что у крестика удаления.
    const i = APP.indexOf("pick.className = 'model-pick'");
    expect(i, 'галочка выбора в списке не найдена').toBeGreaterThan(-1);
    const near = APP.slice(i, i + 1200);
    expect(
      /pick\.addEventListener\('click',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/.test(near),
      'клик по галочке обязан останавливаться на ней (stopPropagation)',
    ).toBe(true);
  });

  it('во время пакета кнопка остаётся рабочей — иначе остановиться нельзя', () => {
    // Кнопка сборки на время пакета становится «Остановить». Общая ветка «идёт сборка →
    // кнопка выключена» погасила бы единственный способ прервать полсотни моделей.
    const body = bodyOf(APP, 'function updateRunButtonState(');
    expect(body).toBeTruthy();
    const batchAt = body.indexOf('batchInFlight');
    const buildAt = body.indexOf('buildInFlight');
    expect(batchAt, 'updateRunButtonState не знает про пакет').toBeGreaterThan(-1);
    expect(
      batchAt < buildAt,
      'проверка пакета обязана стоять ДО проверки buildInFlight: внутри пакета сборка '
        + 'идёт почти всегда, и общая ветка выключила бы кнопку «Остановить»',
    ).toBe(true);

    const run = bodyOf(APP, 'async function runOptimize(');
    expect(
      /if\s*\(!batchInFlight\)\s*runBtn\.disabled\s*=\s*true/.test(run),
      'runOptimize гасит кнопку, не спросив про пакет — остановить станет нечем',
    ).toBe(true);
  });

  it('модели собираются по одной, а не пачкой запросов', () => {
    // Пятьдесят разборов разом положат вкладку: одна ABeautifulGame — 704 МБ
    // видеопамяти. Та же причина, по которой в сцене всегда одна модель.
    const body = bodyOf(APP, 'async function runBatch(');
    expect(body, 'функция runBatch не найдена').toBeTruthy();
    expect(/for\s*\(/.test(body), 'пакет обязан идти циклом').toBe(true);
    expect(/await\s+runOptimize\(\)/.test(body), 'каждая сборка ожидается').toBe(true);
    expect(
      /Promise\.all|Promise\.allSettled/.test(body),
      'параллельный запуск моделей запрещён: сцена одна и память одна',
    ).toBe(false);
  });

  it('пакет пишет ОДНУ строку итога, а не строку на модель (Правило 9)', () => {
    const body = bodyOf(APP, 'async function runBatch(');
    const loopStart = body.indexOf('for (');
    const loopEnd = body.indexOf('} finally {');
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loop = body.slice(loopStart, loopEnd);
    expect(
      /log\.batchDone|log\.batchStopped/.test(loop),
      'итог пакета пишется ВНУТРИ цикла — получится полсотни одинаковых строк',
    ).toBe(false);
  });

  it('отказ по расширению — одна строка на все файлы разом', () => {
    // Бросили папку с сотней картинок: человек должен увидеть «пропущено файлов: 100»,
    // а не сто одинаковых строк.
    const body = bodyOf(APP, 'async function handleFiles(');
    expect(body, 'функция handleFiles не найдена').toBeTruthy();
    expect(/log\.rejectedMany/.test(body), 'нет массовой формы отказа').toBe(true);
    const loopWithReject = /for\s*\([^)]*\)\s*\{[^}]*log\.rejected/.test(body);
    expect(loopWithReject, 'отказ пишется в цикле по файлам').toBe(false);
  });

  it('разметка принимает несколько файлов', () => {
    const input = HTML.match(/<input[^>]*id="file-input"[^>]*>/);
    expect(input, 'поле выбора файла не найдено').toBeTruthy();
    expect(/\bmultiple\b/.test(input[0]), 'без multiple диалог отдаёт один файл').toBe(true);
  });

  it('папка разворачивается в файлы, и записи снимаются до первого await', () => {
    // Бросок папки даёт в dataTransfer.files одну нечитаемую запись. Настоящее
    // содержимое лежит в items → webkitGetAsEntry, и снять его надо СИНХРОННО:
    // после возврата из обработчика DataTransfer недействителен.
    expect(/webkitGetAsEntry/.test(APP), 'бросок папки не поддержан').toBe(true);
    const body = bodyOf(APP, 'async function filesFromEntries(');
    expect(body, 'разворачивание папки не найдено').toBeTruthy();
    expect(
      /for\s*\(;;\)|while\s*\(true\)/.test(body),
      'readEntries отдаёт порцию: без цикла у большой папки потеряется хвост',
    ).toBe(true);

    // Сам обработчик броска обязан собрать записи ДО первого await.
    const drop = APP.slice(APP.indexOf("window.addEventListener('drop'"), APP.indexOf("window.addEventListener('drop'") + 1400);
    const entriesAt = drop.indexOf('webkitGetAsEntry');
    const awaitAt = drop.indexOf('await');
    expect(entriesAt).toBeGreaterThan(-1);
    expect(
      awaitAt === -1 || entriesAt < awaitAt,
      'записи файловой системы снимаются после await — папка приедет пустой',
    ).toBe(true);
  });

  it('все строки пакета есть в обоих каталогах и ни одной нет в коде', () => {
    // Правило 8: язык отдельно от кода. Список ключей собираем из самого кода, а не
    // пишем рядом второй копией — второй список разошёлся бы с первым молча.
    const used = [...APP.matchAll(/'((?:batch|log\.batch|log\.loadedMany|log\.rejectedMany|btn\.(?:buildPicked|stop|stopping|nothingPicked)|status\.batch)[\w.]*)'/g)]
      .map((m) => m[1]);
    expect(used.length, 'ключей пакета в коде не нашлось — проверять нечего').toBeGreaterThan(8);
    for (const key of new Set(used)) {
      expect(RU.includes(`'${key}'`), `нет русского перевода: ${key}`).toBe(true);
      expect(EN.includes(`'${key}'`), `нет английского перевода: ${key}`).toBe(true);
    }
  });

  it('модель из пачки разбирается при первом показе, а не остаётся с чужими кнопками', () => {
    // ДЕФЕКТ, найденный проверкой в браузере 2026-08-19. Записи заводятся всем файлам
    // пачки сразу, а инспекция достаётся только первой — иначе бросок папки запустил бы
    // полсотни разборов разом. Следствие: у второй модели своей инспекции нет, а кнопки
    // «Метаданные» и «Проверка» остались включёнными ОТ ПЕРВОЙ. В браузере это выглядело
    // так: модель загружена и видна, кнопка работает, окно пишет «модель не загружена».
    //
    // ПОЧИНКА ПЕРЕЕХАЛА (2026-08-21). Прежняя гасила кнопки прямо здесь и только когда
    // разбора нет — и ровно поэтому пропускала обратный случай: у модели, которую движок
    // НЕ ЧИТАЕТ, кнопки гасли правильно, но дальше оставались погашенными на всех
    // моделях, куда ни переключись, до конца сеанса. Условие-то не срабатывало.
    //
    // Теперь доступность считается из разбора активной модели в одном месте
    // (updateInspectButtons), а показ модели зовёт его БЕЗУСЛОВНО. Утверждаем обе
    // половины гарантии: кнопки приводятся в согласие с этой моделью всегда, и разбор
    // внутри пакета по-прежнему пропускается.
    const body = bodyOf(APP, 'async function showActiveModel(');
    expect(body, 'showActiveModel не найдена').toBeTruthy();
    const call = body.split('\n').find((l) => l.trim() === 'updateInspectButtons();');
    expect(
      call,
      'показ модели не приводит кнопки инспекции в согласие с ней — они останутся от соседней',
    ).toBeTruthy();
    expect(
      call.length - call.trimStart().length,
      'вызов вложен в условие — значит срабатывает не всегда, и погашенные кнопки соседа переедут',
    ).toBe(4);
    expect(
      /!batchInFlight\)?\s*inspectModel\(rec\.file\)/.test(body),
      'разбор при показе обязан пропускаться внутри пакета: сборка и так грузит файл, '
        + 'второй заход удвоил бы работу на каждой из полусотни моделей',
    ).toBe(true);
  });

  it('сводка берёт результат активной модели из живых переменных', () => {
    // Тот же класс дефекта, что у `selectedFile`, и он тут страшнее: снимок состояния
    // заполняется при УХОДЕ с модели, поэтому у той, что сейчас на экране, свежего
    // результата в записи ещё нет. Читать только `rec.state.lastResult` значит молча
    // терять из сводки последнюю собранную модель — а в пакете это как раз та, ради
    // которой сводку и открыли.
    const body = bodyOf(APP, 'function summaryRows(');
    expect(body, 'summaryRows не найдена').toBeTruthy();
    expect(
      /rec\.id === activeModelId/.test(body) && /lastResult/.test(body),
      'сводка обязана различать активную модель: её результат живёт в переменных, '
        + 'а не в снимке состояния',
    ).toBe(true);
  });

  it('итог складывает только те модели, у которых есть оба числа', () => {
    // Без этой проверки отсутствующее «было» приходит как null, превращается в 0 при
    // сложении, и итоговая экономия оказывается больше настоящей. Сводку читают как
    // отчёт — врать в ней нельзя даже на одну модель.
    const body = bodyOf(APP, 'function summaryTotal(');
    expect(body, 'summaryTotal не найдена').toBeTruthy();
    expect(
      /fileBefore == null \|\| r\.fileAfter == null/.test(body),
      'итог складывает всё подряд: модель без чисел добавит ноль и завысит экономию',
    ).toBe(true);
  });

  it('вердикт бюджета — худший из порогов модели', () => {
    // Строка сводки отвечает на один вопрос: есть ли повод открыть отчёт этой модели.
    // Если из трёх порогов один превышен, а два в норме, показать надо превышение.
    const body = bodyOf(APP, 'function summaryRows(');
    const over = body.indexOf("=== 'over'");
    const warn = body.indexOf("=== 'warn'");
    expect(over, 'уровень over не проверяется').toBeGreaterThan(-1);
    expect(over < warn, 'предел площадки обязан перебивать рекомендацию').toBe(true);
    expect(/break/.test(body.slice(over, warn)), 'найдя предел, перебор пора прекращать').toBe(true);
  });

  it('сводка переводится без пересборки пакета (Правило 8)', () => {
    // Числа в сводке чужие — они пришли из отчётов. А подписи наши: заголовки колонок,
    // вердикт, итоговая строка. Смена языка обязана их перерисовать и НЕ трогать
    // ничего больше: пересобирать двадцать моделей ради перевода слова «Модель» —
    // ровно то, что Правило 8 запрещает.
    const onChange = bodyOf(APP, 'window.I18n.onChange(');
    expect(onChange, 'обработчик смены языка не найден').toBeTruthy();
    expect(
      /summaryWindow\.classList\.contains\('hidden'\)[\s\S]{0,40}renderSummaryWindow\(\)/.test(onChange),
      'при смене языка открытая сводка остаётся на прежнем языке',
    ).toBe(true);
  });

  it('CSV несёт BOM — иначе Excel покажет кириллицу кракозябрами', () => {
    const i = APP.indexOf("summarySaveBtn.addEventListener");
    expect(i, 'сохранение сводки не найдено').toBeGreaterThan(-1);
    const body = APP.slice(i, i + 1800);
    // Ищем escape-последовательность \uFEFF, а не живой символ. Живой символ в этом
    // файле стоил красного CI на всех трёх версиях Node: eslint запрещает «неправильные
    // пробелы» внутри регулярных выражений (no-irregular-whitespace), а BOM — из них.
    expect(/new Blob\(\[`\\uFEFF/.test(body), 'в начале файла нет BOM').toBe(true);
    expect(/charset=utf-8/.test(body), 'кодировка не объявлена').toBe(true);
  });

  it('кнопка сводки выключена, пока показывать нечего (Правило 12)', () => {
    const body = bodyOf(APP, 'function updateSummaryButton(');
    expect(body, 'updateSummaryButton не найдена').toBeTruthy();
    expect(
      /batchSummaryBtn\.disabled = summaryRows\(\)\.length === 0/.test(body),
      'кнопка сводки живёт своей жизнью: нажатие на пустоте покажет пустое окно',
    ).toBe(true);
  });

  it('все строки сводки есть в обоих каталогах', () => {
    // Ключ — только с точкой внутри либо из явного списка. Без этого в улов попадал
    // `document.createElement('summary')`: тег HTML, а не строка каталога.
    const used = [...APP.matchAll(/'((?:summary\.[\w.]+|win\.summary|batch\.summary|log\.summarySaved))'/g)]
      .map((m) => m[1]);
    expect(used.length, 'ключей сводки в коде не нашлось').toBeGreaterThan(8);
    for (const key of new Set(used)) {
      expect(RU.includes(`'${key}'`), `нет русского перевода: ${key}`).toBe(true);
      expect(EN.includes(`'${key}'`), `нет английского перевода: ${key}`).toBe(true);
    }
  });

  it('полоса выбора появляется только со второй моделью', () => {
    // Правило 10: простота для новичка. Над единственной строкой «все / ничего» —
    // две кнопки, которые нечего выбирать.
    const body = bodyOf(APP, 'function renderBatchBar(');
    expect(body, 'renderBatchBar не найдена').toBeTruthy();
    expect(/batchMode\(\)/.test(body), 'полоса показывается всегда').toBe(true);
    const mode = APP.match(/const batchMode = \(\) =>([^;]+);/);
    expect(mode, 'признак пакетного режима не найден').toBeTruthy();
    expect(/models\.length\s*>\s*1/.test(mode[1]), 'пакетный режим включается не второй моделью').toBe(true);
  });
});

describe('надпись кнопки не врёт о числе выбранных', () => {
  // ДЕФЕКТ, найденный Александром 2026-08-23: «если удаляешь или добавляешь слева разные
  // модели, то пишет собрать выбранные и число. но там часто неактуальные данные.
  // особенно после удаления моделей. либо убрать вообще уточнение на кнопке про
  // количество. либо сделать так что бы оно всегда было верным».
  //
  // Причин оказалось две, и вторая шире первой.
  //
  //   1. Пересчёт стоял ПО МЕСТАМ, а не в одном. Удалили активную модель — сработает
  //      showActiveModel(); удалили любую другую — removeModel уходил ранним возвратом
  //      сразу после перерисовки списка, и число оставалось прежним.
  //
  //   2. Ветки НИЖЕ пакетной трогали только `disabled` и подсказку, а текст не
  //      переписывали — он доживал с прошлого раза. Значит соврать могло любое
  //      возвращение из пакетного режима в одиночный: удалили предпоследнюю модель, и на
  //      кнопке осталось «Собрать выбранные (2)» при одной строке и без единой галочки.
  //
  // Замер в живом приложении 2026-08-23 после починки: 3 → снял галочку (2) → удалил
  // неактивную (2 при двух строках) → осталась одна («Собрать») → удалил последнюю
  // («Собрать», гаснет).

  it('число берётся там же, где рисуется список', () => {
    // Надпись — производная от состава списка. Держать пересчёт по местам значит ждать,
    // когда следующий путь его забудет.
    const at = APP.indexOf('function renderModelList()');
    expect(at, 'не нашёл перерисовку списка').toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf('\n  function ', at + 10));
    // Смотреть надо на ХВОСТ функции, а не на всё её тело: внутри, в обработчике
    // галочки, `updateRunButtonState()` стоит и без нашей правки — и первая редакция
    // этого сторожа ловила именно его, то есть зеленела, когда пересчёт из хвоста был
    // уже убран. Проба на красноту это и показала.
    const tail = body.slice(body.lastIndexOf('syncDropzone()'));
    expect(tail.length, 'не нашёл конец перерисовки списка').toBeGreaterThan(0);
    expect(tail.includes('updateRunButtonState()'),
      'перерисовка списка не пересчитывает кнопку в конце — число разойдётся с составом').toBe(true);
  });

  it('надпись ставится заново на каждом проходе, а не наследуется', () => {
    // Без этой строки любой путь ниже пакетной ветки оставляет прошлый текст.
    const at = APP.indexOf('function updateRunButtonState()');
    expect(at, 'не нашёл пересчёт кнопки').toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf('\n  function ', at + 10));
    const reset = body.indexOf("setText(runBtn, 'btn.build')");
    const batch = body.indexOf('if (batchMode())');
    expect(reset, 'надпись по умолчанию не ставится вовсе').toBeGreaterThan(-1);
    expect(batch, 'не нашёл пакетную ветку').toBeGreaterThan(-1);
    expect(reset, 'надпись по умолчанию ставится ПОСЛЕ пакетной ветки — она её затрёт')
      .toBeLessThan(batch);
  });
});
