// eslint.config.js — линтер ищет ОШИБКИ, а не спорит о стиле.
//
// Заведён 2026-08-10 по ревью («в package.json нет отдельных команд lint/format/
// typecheck; нужен единый gate»). Настройка сознательно узкая, и вот почему.
//
// Форматирования здесь нет и не будет. Код в этом проекте написан с плотными
// комментариями, где абзацы и переносы несут смысл: объяснение решения, замер, ссылка
// на дату и причину. Автоформаттер перепашет это по своим правилам и уничтожит ровно ту
// часть, которая ценнее всего. Поэтому prettier не подключён, а из правил взяты только
// те, что ловят настоящие ошибки: необъявленная переменная, недостижимый код, дубль
// ключа в объекте, забытый await у промиса.
//
// Отдельно про `no-unused-vars`. Ловит опечатки в именах — то есть настоящие ошибки, —
// но ругается на два законных приёма, которые тут в ходу: `catch (e) {}` без обращения
// к e и неиспользуемый параметр перед используемым. Оба разрешены исключениями ниже,
// а не выключением правила целиком.

import js from '@eslint/js';

// Глобальные имена. Списки короткие и явные: пакет `globals` ради двух десятков имён —
// лишняя зависимость.
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  globalThis: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Image: 'readonly',
  // Раскодировать data:-адрес холста в байты — так браузерная проверка собирает GLB.
  atob: 'readonly',
  createImageBitmap: 'readonly',
  // Нажатие мышью проверяется настоящим событием: браузерный тест шлёт его холсту сам.
  PointerEvent: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  ResizeObserver: 'readonly',
  EventSource: 'readonly',
  DataTransfer: 'readonly',
  customElements: 'readonly',
  HTMLElement: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  localStorage: 'readonly',
  alert: 'readonly',
  structuredClone: 'readonly',
};

const UNUSED = ['error', {
  // `catch (e) {}` без обращения к e — законно: причина иногда неважна, важен сам факт
  caughtErrors: 'none',
  // неиспользуемый параметр ПЕРЕД используемым убрать нельзя — позиция значима
  args: 'after-used',
  // подчёркивание впереди — общепринятая пометка «знаю, что не нужен»
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
}];

export default [
  {
    ignores: [
      'node_modules/**',
      'dist-app/**',      // собранный пакет — чужой код и копия нашего
      '_web/**',          // рабочая папка сервера
      '_work/**',         // рабочая зона Клода, не поставляется
      '.tools/**',
      'output/**',
      'input/**',
      'fixtures/**',
      'tests/__optimized__/**',
      'coverage/**',
      // Собранное из TypeScript: ругаться надо на источник, а не на след. Сами .mts
      // линтер не читает (для этого нужен парсер TS, а это отдельная зависимость) —
      // за них отвечает `tsc` со strict, и он ловит тот же класс: необъявленное имя,
      // недостижимый код, забытый await. Появится смысл в правилах, которых у tsc нет,
      // — тогда и подключим typescript-eslint.
      'core/types.mjs',
      'core/contract.mjs',
      'core/registry.mjs',
      'core/i18n.mjs',
      'core/engine.mjs',
      'addons/gltf/metrics.mjs',
      'addons/gltf/tools.mjs',
      'addons/gltf/rules.mjs',
      'addons/gltf/types.mjs',
      'addons/gltf/index.mjs',
      'optimize2.mjs',
      'server.mjs',
      'assistant.mjs',
      'ui/app.js',
      'ui/i18n.js',
      'ui/viewer/index.js',
      'ui/viewer/viewer.js',
    ],
  },

  // Общая база для всего кода проекта.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': UNUSED,
      'require-atomic-updates': 'off', // слишком много ложных на нашем стиле async
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Неразрывный пробел в русском тексте — типографика, а не опечатка: он держит
      // «5 МБ» и «т. е.» от переноса. В КОДЕ он по-прежнему ошибка, а в строках и
      // шаблонах — норма, там и живут переводы.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },

  // Оболочка Electron — CommonJS.
  {
    files: ['desktop/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: NODE_GLOBALS },
  },

  // Интерфейс и каталоги переводов — браузер. Переводы тоже: они подключаются тегом
  // <script> и кладут словарь в window, а не экспортируют его.
  {
    files: ['ui/**/*.js', 'translations/**/*.js'],
    languageOptions: { sourceType: 'script', globals: BROWSER_GLOBALS },
  },
  {
    files: ['ui/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },

  // Тесты — node плюс глобальные vitest, если где-то без импорта.
  {
    files: ['tests/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS, vi: 'readonly' },
    },
  },
];
