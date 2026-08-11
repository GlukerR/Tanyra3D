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
  const listeners: Array<(lang: string) => void> = [];
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

  function interpolate(text: string, params?: UiParams): string {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] != null ? String(params[k]) : m));
  }

  // Ключ, которого нет в каталоге, отдаётся как есть: недоперевод должен быть виден
  // в интерфейсе, а не молча превращаться в пустоту.
  function t(key: string, params?: UiParams): string {
    const entry = (catalogs[lang] && catalogs[lang]![key]) ?? (catalogs[FALLBACK] && catalogs[FALLBACK]![key]);
    if (entry == null) return key;
    if (typeof entry === 'function') return entry(params || {});
    return interpolate(entry, params);
  }

  // Русский требует три формы вместо двух: 1 замечание / 2 замечания / 5 замечаний.
  // Каталог передаёт формы, правило выбора живёт здесь — по языку, а не по строке.
  function plural(n: number, forms: string[]): string {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    // `!` вместо проверок: формы приходят из каталога, и их там столько, сколько требует
    // язык (две в английском, три в русском). Недостача форм — ошибка каталога, и она
    // должна быть видна как «undefined» в интерфейсе, а не спрятана пустой строкой.
    if (lang === 'ru') {
      if (abs > 10 && abs < 20) return forms[2]!;
      if (last > 1 && last < 5) return forms[1]!;
      if (last === 1) return forms[0]!;
      return forms[2]!;
    }
    return n === 1 ? forms[0]! : forms[1]!;
  }

  // Разметка помечается атрибутами, а не переписывается из JS: перевод статики
  // остаётся в HTML рядом с элементом, к которому относится.
  const ATTRS: Array<[string, (el: Element, s: string) => void]> = [
    ['data-i18n', (el, s) => { el.textContent = s; }],
    ['data-i18n-html', (el, s) => { el.innerHTML = s; }],
    ['data-i18n-title', (el, s) => { (el as HTMLElement).title = s; }],
    ['data-i18n-aria', (el, s) => { el.setAttribute('aria-label', s); }],
    ['data-i18n-placeholder', (el, s) => { (el as HTMLInputElement).placeholder = s; }],
  ];

  function apply(root?: ParentNode | null): void {
    const scope = root || document;
    for (const [attr, set] of ATTRS) {
      for (const el of scope.querySelectorAll(`[${attr}]`)) set(el, t(el.getAttribute(attr)!, params(el, attr)));
    }
    document.documentElement.lang = lang;
  }

  // Подстановки динамической подписи хранятся на самом элементе, по атрибуту:
  // у текста и у подсказки они разные (⊞ Metadata (12) при подсказке без чисел).
  function params(el: Element, attr: string): UiParams | undefined {
    return el.__i18n && el.__i18n[attr];
  }

  // Подпись, которую ставит не разметка, а код.
  //
  // Помечаем элемент тем же атрибутом, что и статику, — иначе apply() при смене
  // языка перерисует его по ключу ИЗ РАЗМЕТКИ и откатит подпись к исходной:
  // «Пересобрать» снова станет «Собрать», статус сборки — «Готово», а счётчик
  // замечаний на кнопке Validation просто исчезнет. Смена языка обязана менять
  // слова и только слова.
  function mark(el: Element | null, attr: string, key: string, values?: UiParams): void {
    if (!el) return;
    el.setAttribute(attr, key);
    const bag = el.__i18n || (el.__i18n = {});
    if (values) bag[attr] = values;
    else delete bag[attr];
    const pair = ATTRS.find(([a]) => a === attr);
    if (pair) pair[1](el, t(key, values));
  }

  function setLang(next: string): void {
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
    setText: (el: Element | null, key: string, values?: UiParams) => mark(el, 'data-i18n', key, values),
    setTitle: (el: Element | null, key: string, values?: UiParams) => mark(el, 'data-i18n-title', key, values),
    setAria: (el: Element | null, key: string, values?: UiParams) => mark(el, 'data-i18n-aria', key, values),
    get lang() { return lang; },
    languages: known,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();
