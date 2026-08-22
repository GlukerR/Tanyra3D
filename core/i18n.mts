// core/i18n.mts — крошечный шов локализации. НЕ библиотека и НЕ переключатель языка:
// ровно столько машинерии, чтобы текст правил жил в словаре по ключу (messageId), а не
// был зашит в логику (Правило 8). Каталоги регистрируются при импорте своего модуля:
// ядро — из core/messages/, аддон — из addons/*/messages/.
//
// Использование:
//   import { register, render } from './core/i18n.mjs';
//   register('en', { 'geometry.compress.ok': ({codec}) => `Geometry compressed (${codec})` });
//   render('geometry.compress.ok', { codec: 'meshopt' });   // → строка
//
// Отсутствие ключа/каталога — это ОШИБКА (кидаем), а не пустая строка: пропущенный
// перевод ловится сразу при разработке, а не всплывает у пользователя.
//
// Переведён на TypeScript 2026-08-11 вместе с движком: движок его импортирует, а
// рукописное описание типов рядом с JS-файлом было бы вторым источником правды —
// разошлись бы при первой же правке, и молча.
//
// САМИ КАТАЛОГИ остаются на JavaScript намеренно, и это не «руки не дошли».
// core/messages/*.mjs и addons/*/messages/*.mjs правит переводчик (см.
// assistants/translate/TRANSLATOR_PROMPT.md) — если сделать их собранными из .mts,
// его правка попадёт в файл, который затрёт следующая сборка. Каталог — данные, а не
// код; типизировать его нечего, кроме формы значения, которую здесь и объявляем.

import type { MessageCatalog, MessageData, MessageRef } from './types.mjs';

/** locale → каталог */
const catalogs = new Map<string, MessageCatalog>();

// Язык-основа: на него откатывается любой другой каталог при нехватке ключа.
const BASE_LOCALE = 'en';

/**
 * Зарегистрировать (или дополнить) каталог сообщений для локали. Аддоны регистрируют
 * свои словари при импорте; ключи разных аддонов сливаются в один каталог локали.
 */
export function register(locale: string, messages: MessageCatalog): void {
  const cur = catalogs.get(locale) || {};
  catalogs.set(locale, { ...cur, ...messages });
}

/**
 * Отрендерить сообщение по ключу. Шаблон — либо функция (data → строка), либо строка с
 * плейсхолдерами {ключ}, которые заменяются значениями из data.
 */
export function render(messageId: string, data: MessageData = {}, locale: string = BASE_LOCALE): string {
  // Каталог другого языка может быть неполным — тогда берём английский. Сторонний аддон
  // не обязан переводиться на все языки, и его английская строка в отчёте лучше, чем
  // упавшая сборка. Строгость сохраняется там, где она ловит ошибку разработчика:
  // отсутствие ключа в САМОМ английском каталоге по-прежнему кидает.
  const cat = catalogs.get(locale);
  const tpl = cat ? cat[messageId] : undefined;
  if (tpl == null) {
    if (locale !== BASE_LOCALE) return render(messageId, data, BASE_LOCALE);
    const why = cat ? `missing message '${messageId}'` : `no catalog for locale '${locale}'`;
    throw new Error(`i18n: ${why} for locale '${locale}'`);
  }
  const values = resolveNested(data, locale);
  if (typeof tpl === 'function') return tpl(values);
  return String(tpl).replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}

/**
 * Подстановка сама может быть сообщением: { messageId, data }. Так собираются строки из
 * кусков — «Входное сжатие снято: draco — перекодировано с нуля». Разворачиваем перед
 * подстановкой, иначе вложенный кусок пришлось бы рендерить заранее, и при пересборке на
 * другом языке он остался бы на прежнем: внешняя фраза переведена, хвост — нет.
 */
function resolveNested(data: MessageData, locale: string): MessageData {
  let out = data;
  for (const [k, v] of Object.entries(data)) {
    if (!isMessageRef(v)) continue;
    if (out === data) out = { ...data };
    out[k] = render(v.messageId, v.data || {}, locale);
  }
  return out;
}

/**
 * Подстановка — это вложенное сообщение? Проверка ровно та же, что была до перевода:
 * объект с непустым messageId. Соблазн ужесточить её до `typeof === 'string'` здесь
 * сознательно не поддержан — это изменило бы поведение на краю, а перевод на TypeScript
 * задуман как перенос без изменения поведения.
 */
function isMessageRef(v: unknown): v is MessageRef {
  return !!v && typeof v === 'object' && !!(v as MessageRef).messageId;
}

// Списки отчёта, строки которых собраны из messageId (см. entriesOf в core/engine.mjs).
// validation здесь не для полноты: именно её строки интерфейс выносит к кнопке выгрузки,
// когда результат не сошёлся с исходником. Строка, застрявшая на языке сборки, в этом
// месте — худший вид недоперевода: человек читает предупреждение, ради которого всё и
// затевалось, на чужом языке.
const LOCALIZED_LISTS = ['applied', 'skipped', 'findings', 'validation'];

/**
 * Пересобрать тексты готового результата на другом языке.
 *
 * Смена языка в интерфейсе не имеет права запускать обработку заново: это перерисовка,
 * а не работа. Записи отчёта несут рецепт своих строк (поле i18n: поле записи → messageId
 * и data), поэтому те же строки собираются из готового результата за микросекунды.
 * Запись без рецепта — сообщение, которого не из чего пересобрать, — остаётся как есть:
 * недоперевод видно, но ничего не теряется и ничего не падает.
 *
 * Функция чистая: исходный результат не трогается, возвращается копия.
 *
 * Тип-параметр возвращает вызывающему ровно то, что он передал: сервер отдаёт RunResult
 * и получает RunResult, а не «объект». Внутри работа идёт по нетипизированным ключам —
 * список полей известен только во время работы, — поэтому приведения здесь неизбежны и
 * заперты в одной функции.
 */
export function localizeResult<T>(result: T, locale: string): T {
  if (!result || !locale) return result;
  const src = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  // Причина, по которой прогон не состоялся, — такая же строка отчёта, как остальные, и
  // рецепт у неё лежит там же (RunResult.i18n.error). Отдельная ветка нужна потому, что
  // живёт она не в списке, а в корне результата: обход ниже до неё не доходит.
  //
  // Пока этой ветки не было, смена языка оставляла единственную важную строку экрана на
  // языке сборки — а интерфейс, не найдя её, подставлял вместо неё общую фразу про
  // проверку целостности, то есть НЕ ТУ причину (найдено 2026-08-21).
  const rootRefs = src.i18n as Record<string, unknown> | undefined;
  if (rootRefs) {
    for (const [field, ref] of Object.entries(rootRefs)) {
      if (!isMessageRef(ref)) continue;
      try {
        out[field] = render(ref.messageId, ref.data || {}, locale);
      } catch (e) {
        /* ключа нет ни в одном каталоге — прежний текст лучше пустого места */
      }
    }
  }
  for (const key of LOCALIZED_LISTS) {
    const list = src[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((rec: unknown) => {
      const entry = rec as Record<string, unknown> | null;
      if (!entry || !entry.i18n) return rec;
      const next: Record<string, unknown> = { ...entry };
      for (const [field, ref] of Object.entries(entry.i18n as Record<string, unknown>)) {
        if (!isMessageRef(ref)) continue;
        try {
          next[field] = render(ref.messageId, ref.data || {}, locale);
        } catch (e) {
          /* ключа нет ни в одном каталоге — прежний текст лучше пустого места */
        }
      }
      return next;
    });
  }
  return out as T;
}
