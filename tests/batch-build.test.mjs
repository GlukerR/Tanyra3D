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

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

const APP = stripComments(readSource('ui/app'));

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
    expect(
      /const selectedFile = \(\) =>[^\n]*activeModel\(\)/.test(APP),
      'файл на экране больше не вычисляется из активной записи — значит его снова где-то '
        + 'присваивают, и следующий забытый путь даст тот же дефект',
    ).toBe(true);
    expect(
      APP.split('\n').filter((l) => /^\s*selectedFile\s*=/.test(l)),
      'файлу на экране снова присваивают значение вручную',
    ).toEqual([]);
    const snapshot = APP.slice(APP.indexOf('PER_MODEL_STATE'), APP.indexOf('];', APP.indexOf('PER_MODEL_STATE')));
    expect(snapshot, 'selectedFile вернулся в снимок состояния').not.toContain("key: 'selectedFile'");
  });

  it('галочка выбора не переключает показанную модель', () => {
    const i = APP.indexOf("pick.className = 'model-pick'");
    expect(i, 'галочка выбора в списке не найдена').toBeGreaterThan(-1);
    const near = APP.slice(i, i + 1200);
    expect(
      /pick\.addEventListener\('click',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/.test(near),
      'клик по галочке обязан останавливаться на ней (stopPropagation)',
    ).toBe(true);
  });

  it('во время пакета кнопка остаётся рабочей — иначе остановиться нельзя', () => {
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
    expect(/webkitGetAsEntry/.test(APP), 'бросок папки не поддержан').toBe(true);
    const body = bodyOf(APP, 'async function filesFromEntries(');
    expect(body, 'разворачивание папки не найдено').toBeTruthy();
    expect(
      /for\s*\(;;\)|while\s*\(true\)/.test(body),
      'readEntries отдаёт порцию: без цикла у большой папки потеряется хвост',
    ).toBe(true);

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
    const used = [...APP.matchAll(/'((?:batch|log\.batch|log\.loadedMany|log\.rejectedMany|btn\.(?:buildPicked|stop|stopping|nothingPicked)|status\.batch)[\w.]*)'/g)]
      .map((m) => m[1]);
    expect(used.length, 'ключей пакета в коде не нашлось — проверять нечего').toBeGreaterThan(8);
    for (const key of new Set(used)) {
      expect(RU.includes(`'${key}'`), `нет русского перевода: ${key}`).toBe(true);
      expect(EN.includes(`'${key}'`), `нет английского перевода: ${key}`).toBe(true);
    }
  });

  it('модель из пачки разбирается при первом показе, а не остаётся с чужими кнопками', () => {
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
    const body = bodyOf(APP, 'function summaryRows(');
    expect(body, 'summaryRows не найдена').toBeTruthy();
    expect(
      /rec\.id === activeModelId/.test(body) && /lastResult/.test(body),
      'сводка обязана различать активную модель: её результат живёт в переменных, '
        + 'а не в снимке состояния',
    ).toBe(true);
  });

  it('итог складывает только те модели, у которых есть оба числа', () => {
    const body = bodyOf(APP, 'function summaryTotal(');
    expect(body, 'summaryTotal не найдена').toBeTruthy();
    expect(
      /fileBefore == null \|\| r\.fileAfter == null/.test(body),
      'итог складывает всё подряд: модель без чисел добавит ноль и завысит экономию',
    ).toBe(true);
  });

  it('вердикт бюджета — худший из порогов модели', () => {
    const body = bodyOf(APP, 'function summaryRows(');
    const over = body.indexOf("=== 'over'");
    const warn = body.indexOf("=== 'warn'");
    expect(over, 'уровень over не проверяется').toBeGreaterThan(-1);
    expect(over < warn, 'предел площадки обязан перебивать рекомендацию').toBe(true);
    expect(/break/.test(body.slice(over, warn)), 'найдя предел, перебор пора прекращать').toBe(true);
  });

  it('сводка переводится без пересборки пакета (Правило 8)', () => {
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
    const used = [...APP.matchAll(/'((?:summary\.[\w.]+|win\.summary|batch\.summary|log\.summarySaved))'/g)]
      .map((m) => m[1]);
    expect(used.length, 'ключей сводки в коде не нашлось').toBeGreaterThan(8);
    for (const key of new Set(used)) {
      expect(RU.includes(`'${key}'`), `нет русского перевода: ${key}`).toBe(true);
      expect(EN.includes(`'${key}'`), `нет английского перевода: ${key}`).toBe(true);
    }
  });

  it('полоса выбора появляется только со второй моделью', () => {
    const body = bodyOf(APP, 'function renderBatchBar(');
    expect(body, 'renderBatchBar не найдена').toBeTruthy();
    expect(/batchMode\(\)/.test(body), 'полоса показывается всегда').toBe(true);
    const mode = APP.match(/const batchMode = \(\) =>([^;]+);/);
    expect(mode, 'признак пакетного режима не найден').toBeTruthy();
    expect(/models\.length\s*>\s*1/.test(mode[1]), 'пакетный режим включается не второй моделью').toBe(true);
  });
});

describe('надпись кнопки не врёт о числе выбранных', () => {
  it('число берётся там же, где рисуется список', () => {
    const at = APP.indexOf('function renderModelList()');
    expect(at, 'не нашёл перерисовку списка').toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf('\n  function ', at + 10));
    const tail = body.slice(body.lastIndexOf('syncDropzone()'));
    expect(tail.length, 'не нашёл конец перерисовки списка').toBeGreaterThan(0);
    expect(tail.includes('updateRunButtonState()'),
      'перерисовка списка не пересчитывает кнопку в конце — число разойдётся с составом').toBe(true);
  });

  it('надпись ставится заново на каждом проходе, а не наследуется', () => {
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
