// core/i18n.mjs — крошечный шов локализации. НЕ библиотека и НЕ переключатель языка:
// ровно столько машинерии, чтобы текст правил жил в словаре по ключу (messageId), а не
// был зашит в логику. Сейчас каталог один — английский (addons/gltf/messages/en.mjs);
// второй язык добавляется отдельным файлом-словарём, движок при этом не переписывается
// (docs/EXTENDING.md §5 — «не усложняй раньше времени»).
//
// Использование:
//   import { register, render } from './core/i18n.mjs';
//   register('en', { 'geometry.compress.ok': ({codec}) => `Geometry compressed (${codec})` });
//   render('geometry.compress.ok', { codec: 'meshopt' });   // → строка
//
// Отсутствие ключа/каталога — это ОШИБКА (кидаем), а не пустая строка: пропущенный
// перевод ловится сразу при разработке, а не всплывает у пользователя.

/** @type {Map<string, Record<string, string | ((data: object) => string)>>} locale → каталог */
const catalogs = new Map();

// Язык-основа: на него откатывается любой другой каталог при нехватке ключа.
const BASE_LOCALE = 'en';

/**
 * Зарегистрировать (или дополнить) каталог сообщений для локали. Аддоны регистрируют
 * свои словари при импорте; ключи разных аддонов сливаются в один каталог локали.
 * @param {string} locale
 * @param {Record<string, string | ((data: object) => string)>} messages
 */
export function register(locale, messages) {
  const cur = catalogs.get(locale) || {};
  catalogs.set(locale, { ...cur, ...messages });
}

/**
 * Отрендерить сообщение по ключу. Шаблон — либо функция (data → строка), либо строка с
 * плейсхолдерами {ключ}, которые заменяются значениями из data.
 * @param {string} messageId
 * @param {object} [data]
 * @param {string} [locale]
 * @returns {string}
 */
export function render(messageId, data = {}, locale = BASE_LOCALE) {
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
  if (typeof tpl === 'function') return tpl(data);
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (k in data ? String(data[k]) : `{${k}}`));
}
