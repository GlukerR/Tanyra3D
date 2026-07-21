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
export function render(messageId, data = {}, locale = 'en') {
  const cat = catalogs.get(locale);
  if (!cat) throw new Error(`i18n: no catalog for locale '${locale}'`);
  const tpl = cat[messageId];
  if (tpl == null) throw new Error(`i18n: missing message '${messageId}' for locale '${locale}'`);
  if (typeof tpl === 'function') return tpl(data);
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (k in data ? String(data[k]) : `{${k}}`));
}
