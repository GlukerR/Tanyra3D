(function () {
  const FALLBACK = 'en';
  const STORAGE_KEY = 'tanyra.lang';
  const catalogs = window.I18N_CATALOGS || {};
  const listeners: Array<(lang: string) => void> = [];
  let lang = FALLBACK;

  function known() {
    return Object.keys(catalogs);
  }

  function detect() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {  }
    if (stored && catalogs[stored]) return stored;
    return catalogs[FALLBACK] ? FALLBACK : (known()[0] || FALLBACK);
  }

  function interpolate(text: string, params?: UiParams): string {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] != null ? String(params[k]) : m));
  }

  function t(key: string, params?: UiParams): string {
    const entry = (catalogs[lang] && catalogs[lang]![key]) ?? (catalogs[FALLBACK] && catalogs[FALLBACK]![key]);
    if (entry == null) return key;
    if (typeof entry === 'function') return entry(params || {});
    return interpolate(entry, params);
  }

  function plural(n: number, forms: string[]): string {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (lang === 'ru') {
      if (abs > 10 && abs < 20) return forms[2]!;
      if (last > 1 && last < 5) return forms[1]!;
      if (last === 1) return forms[0]!;
      return forms[2]!;
    }
    return n === 1 ? forms[0]! : forms[1]!;
  }

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

  function params(el: Element, attr: string): UiParams | undefined {
    return el.__i18n && el.__i18n[attr];
  }

  function mark(el: Element | null, attr: string, key: string, values?: UiParams): void {
    if (!el) return;
    el.setAttribute(attr, key);
    const bag = el.__i18n || (el.__i18n = {});
    if (values) bag[attr] = values;
    else delete bag[attr];
    const pair = ATTRS.find(([a]) => a === attr);
    if (pair) pair[1](el, t(key, values));
  }

  function setRaw(el: Element | null, text: string): void {
    if (!el) return;
    el.removeAttribute('data-i18n');
    if (el.__i18n) delete el.__i18n['data-i18n'];
    el.textContent = text;
  }

  function setLang(next: string): void {
    if (!catalogs[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {  }
    apply();
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
    setRaw,
    get lang() { return lang; },
    languages: known,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();
