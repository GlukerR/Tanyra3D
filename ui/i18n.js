// ui/i18n.js — слой локализации интерфейса.
//
// Каталоги подключаются обычными <script> ДО app.js и складываются в window.I18N_CATALOGS.
// Не fetch(JSON): приложение без сборщика рисует панель сразу, и асинхронный каталог
// давал бы вспышку английского при каждом открытии. Новый язык = ещё один файл каталога
// плюс одна строка <script> — правки в app.js не нужны.
//
// Значение ключа — строка с подстановками {name} или функция (params) => string.
// Функции нужны там, где язык требует согласования (в русском три формы множественного
// числа против двух в английском) — тот же приём, что в addons/gltf/messages/en.mjs.

(function () {
  const FALLBACK = 'en';
  const STORAGE_KEY = 'tanyra.lang';
  const catalogs = window.I18N_CATALOGS || {};
  const listeners = [];
  let lang = FALLBACK;

  function known() {
    return Object.keys(catalogs);
  }

  // Язык интерфейса: сохранённый выбор пользователя → английский.
  //
  // По языку браузера НЕ определяем намеренно. Английский — основа проекта: скриншоты,
  // документация, отчёты об ошибках и любой разговор о приложении идут на нём. Открыть
  // незнакомому человеку интерфейс на языке, которого нет в документации, — сделать
  // хуже, а не лучше. Язык выбирается один раз явно и с тех пор помнится.
  function detect() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) { /* приватный режим */ }
    if (stored && catalogs[stored]) return stored;
    return catalogs[FALLBACK] ? FALLBACK : (known()[0] || FALLBACK);
  }

  function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  }

  // Ключ, которого нет в каталоге, отдаётся как есть: недоперевод должен быть виден
  // в интерфейсе, а не молча превращаться в пустоту.
  function t(key, params) {
    const entry = (catalogs[lang] && catalogs[lang][key]) ?? (catalogs[FALLBACK] && catalogs[FALLBACK][key]);
    if (entry == null) return key;
    if (typeof entry === 'function') return entry(params || {});
    return interpolate(entry, params);
  }

  // Русский требует три формы вместо двух: 1 замечание / 2 замечания / 5 замечаний.
  // Каталог передаёт формы, правило выбора живёт здесь — по языку, а не по строке.
  function plural(n, forms) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (lang === 'ru') {
      if (abs > 10 && abs < 20) return forms[2];
      if (last > 1 && last < 5) return forms[1];
      if (last === 1) return forms[0];
      return forms[2];
    }
    return n === 1 ? forms[0] : forms[1];
  }

  // Разметка помечается атрибутами, а не переписывается из JS: перевод статики
  // остаётся в HTML рядом с элементом, к которому относится.
  const ATTRS = [
    ['data-i18n', (el, s) => { el.textContent = s; }],
    ['data-i18n-html', (el, s) => { el.innerHTML = s; }],
    ['data-i18n-title', (el, s) => { el.title = s; }],
    ['data-i18n-aria', (el, s) => { el.setAttribute('aria-label', s); }],
    ['data-i18n-placeholder', (el, s) => { el.placeholder = s; }],
  ];

  function apply(root) {
    const scope = root || document;
    for (const [attr, set] of ATTRS) {
      for (const el of scope.querySelectorAll(`[${attr}]`)) set(el, t(el.getAttribute(attr)));
    }
    document.documentElement.lang = lang;
  }

  function setLang(next) {
    if (!catalogs[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* приватный режим */ }
    apply();
    // Динамические тексты (отчёт, журнал, панель опций) рисует app.js — он их и
    // перерисовывает по сигналу: i18n не знает, что сейчас на экране.
    for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
  }

  lang = detect();

  window.I18n = {
    t,
    plural,
    apply,
    setLang,
    get lang() { return lang; },
    languages: known,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();
