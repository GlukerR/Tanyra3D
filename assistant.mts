// assistant.mjs — слой ассистента (ai-assistant) поверх ядра optimize2.mjs.
//
// Роль: превратить выбор платформы в план обработки (engineOpts для ядра) и
// перевести результат работы ядра (RunResult из ARCHITECTURE.md §4b) на человеческий
// язык — для правой панели «Анализ» веб-интерфейса. Пользовательский текст — английский
// (продукт англоязычный); комментарии — рабочие заметки, остаются русскими.
//
// ВАЖНО: этот модуль НЕ импортирует optimize2.mjs. Ядро вызывает web-interface, не мы.
// Профили платформ — это ДАННЫЕ (profiles/*.json). Новая платформа = новый json-файл
// без правки этого кода.
//
// Экспорты — зафиксированный контракт с web-interface (ARCHITECTURE.md §4c):
//   listPlatforms()                     → [{ id, title, description }]
//   planFor(platformId)                 → { profileId, title, engineOpts, explanation: [string],
//                                           availableExtensions: [...] }  // engineOpts = БАЗОВЫЙ план (без KTX2/Draco)
//   getAvailableExtensions(platformId)  → [{ id, title, description, impact, opts }]
//   listExtensions(platformId)          → алиас getAvailableExtensions (имя, которое ждёт server.mjs)
//   explainResult(runResult, platformId)→ { summary, highlights, budgetChecks, warnings }
//
// v0.0.8: профиль разделён на baselineOpts (базовые оптимизации — всегда и везде,
// KTX2 ВЫКЛЮЧЕН: noKtx:true) и availableExtensions (опциональные расширения — KTX2,
// Draco, strip-colors; включает пользователь). web-interface передаёт выбранные id
// расширений в optimizeFile как advancedFeatures: ['ktx2', ...] — ядро само
// переводит их в опции; поле opts у расширения — эквивалент для legacy-пути.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


import type { MessageCatalog, MessageData } from './core/types.mjs';

/** Функция перевода для выбранного языка: ключ (+ подстановки) → готовая строка. */
type Translate = (key: string, data?: MessageData) => string;

/**
 * Профиль площадки — ДАННЫЕ (profiles/*.json), а не код. Полей у него много и они
 * растут вместе с площадками, поэтому здесь описана только форма доступа: любое поле
 * читается, состав задаёт сам файл. Ужесточать это описание нельзя, не запретив
 * сторонним профилям иметь свои ключи (docs/EXTENDING.md §4).
 */
type ProfileJson = Record<string, any>;

/** То же для описания движка (engines/*.json). */
type EngineJson = Record<string, any>;

/**
 * Запись списка возможностей, как её видит интерфейс. Слова опции живут в messages/
 * и подставляются здесь (Правило 10б: один текст на язык, независимо от площадки).
 */
type ExtensionEntry = Record<string, any> & { id: string };

/** Метрики результата, как их читает ассистент. Состав задаёт аддон — берём нужное. */
type MetricsLike = Record<string, any>;

/** Результат прогона, как его читает ассистент: он смотрит метрики и списки записей. */
type RunResultLike = Record<string, any>;

/** Порог площадки: жёлтое число плюс, по возможности, ссылка на источник. */
interface BudgetEntry {
  warn?: number;
  limit?: number;
  /** ссылка на документ площадки — откуда взято число */
  source?: string;
  /** наше собственное решение вместо ссылки: тоже законно, но выглядит иначе */
  by?: string;
  [key: string]: unknown;
}

/** Строка сверки с бюджетом площадки, как её читает интерфейс. */
interface BudgetCheck {
  id: string;
  name: string;
  actualText: string;
  /** none — в пределах; warn — жёлтое число превышено; over — отказ площадки. */
  level: string;
  source?: string;
  by?: string;
  limitText?: string;
  warnText?: string;
  advice?: string;
}

/** Как считать одну метрику бюджета и в чём измеряется её порог. */
interface BudgetSpec {
  nameKey: string;
  adviceKey: string;
  value: (after: MetricsLike) => number | undefined;
  unit: 'int' | 'mb' | 'px';
}

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const ENGINES_DIR = path.join(BASE_DIR, 'engines');

// ----------------------------------------------------------------------------
// Язык отчёта
//
// Английский — основа: на него откатывается любой каталог при нехватке ключа, и он
// же используется, когда язык не передан. Добавить язык = положить messages/<код>.mjs.
// Больше ничего: перечня языков в коде нет.
// ----------------------------------------------------------------------------

const DEFAULT_LANG = 'en';

// Каталоги отчёта читаются из ПАПКИ, а не перечисляются здесь. Перечень был третьим по
// счёту (ядро, аддон и этот файл) и держался статическими импортами — из-за них язык,
// добавленный по инструкции `ui/locales/README.md`, переводил обвязку интерфейса и
// оставлял английскими описания площадок, подписи опций и весь отчёт (аудит Ф4-3,
// 2026-08-26). Разбор — в шапке `loadCatalogs`.
//
// Свой словарь, а не core/i18n: у ассистента формат значения другой (функция от data),
// и объединять два разных каталога в один реестр значило бы смешивать их ключи.
const CATALOGS: Record<string, MessageCatalog> = {};
await (async () => {
  const dir = path.join(BASE_DIR, 'messages');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { /* папки нет — останется только английский */ }
  for (const name of names.sort()) {
    const m = /^([a-z]{2}(?:-[a-z]{2})?)\.mjs$/i.exec(name);
    if (!m) continue;
    try {
      const mod = await import(pathToFileURL(path.join(dir, name)).href);
      if (mod.default && typeof mod.default === 'object') CATALOGS[m[1]!.toLowerCase()] = mod.default;
    } catch (e) {
      console.warn(`[i18n] каталог отчёта ${name} не загрузился: ${(e as Error).message}`);
    }
  }
})();

export function listLanguages() {
  return Object.keys(CATALOGS);
}

// Возвращает функцию t(key, data) для выбранного языка.
function messages(lang: string): Translate {
  const cat = CATALOGS[lang] || CATALOGS[DEFAULT_LANG]!;
  return (key: string, data?: MessageData) => {
    const fn = cat[key] || CATALOGS[DEFAULT_LANG]![key];
    // Отсутствующий ключ отдаём как есть — недоперевод должен быть виден, а не
    // превращаться в пустую строку посреди отчёта.
    return typeof fn === 'function' ? fn(data || {}) : key;
  };
}

// Поле профиля может быть строкой (тогда это английский) или объектом { en, ru, ... }.
// Профиль от стороннего автора с обычными строками работает без изменений — требовать
// от него перевода на все языки значит не получить сторонних профилей.
function pick(value: unknown, lang: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return (value as Record<string, string>)[lang] ?? (value as Record<string, string>)[DEFAULT_LANG] ?? '';
  return String(value);
}

// ----------------------------------------------------------------------------
// Загрузка профилей (данные, не код)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Свои профили: вторая папка рядом с настройками приложения (сделано 2026-08-12)
//
// Механика «положил файл — площадка появилась» работала и раньше, но класть файл было
// некуда, кроме папки установки: там его затирает обновление, а на macOS её ещё и не
// даёт править система. Второй каталог решает ровно это.
//
// Путь считается по системе, а не спрашивается у Electron: ассистент работает и без
// оболочки (CLI, сервер, программный вызов), и зависеть от неё не вправе. Переменная
// TANYRA3D_PROFILES_DIR перекрывает всё — ею пользуются тесты и тот, кто держит профили
// в своей папке (общий диск команды, репозиторий заказчика).
// ----------------------------------------------------------------------------

function userProfilesDir(): string {
  const override = process.env.TANYRA3D_PROFILES_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Tanyra3D', 'profiles');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Tanyra3D', 'profiles');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Tanyra3D', 'profiles');
}

/** Имена файлов профилей в каталоге. Нет каталога — пустой список, это не ошибка. */
function profileFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function safeId(id: string): string {
  // защита от выхода за пределы папки профилей (id приходит из UI)
  return String(id).replace(/[^a-z0-9_-]/gi, '');
}

/** Порядок просмотра каталогов. Встроенные первыми — они выигрывают спор об одном id. */
const PROFILE_DIRS = () => [
  { dir: PROFILES_DIR, custom: false },
  { dir: userProfilesDir(), custom: true },
];

/**
 * Все профили каталога: id ИЗНУТРИ файла, путь и разобранное содержимое.
 *
 * Единственный ответ на вопрос «какие площадки есть». Заведён 2026-08-26 по итогам
 * аудита, фаза Ф4: до него ответов было два и они расходились. Список для интерфейса
 * читал `id` внутри файла, а загрузка искала файл ПО ИМЕНИ — совпадали они ровно до тех
 * пор, пока имя файла равно id. Стоило контрибутору назвать файл иначе, и площадка
 * появлялась в списке, но при выборе падала сообщением, которое само себе противоречило:
 * «Unknown platform "авито". Available: … авито».
 *
 * Содержимое отдаётся вместе с путём намеренно: без этого `listPlatforms` читал бы
 * каждый файл во второй раз.
 */
function profileEntries(dir: string): Array<{ id: string; file: string; profile: ProfileJson }> {
  const out = [];
  for (const f of profileFiles(dir)) {
    const file = path.join(dir, f);
    try {
      const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (profile && profile.id) out.push({ id: String(profile.id), file, profile });
    } catch {
      /* повреждённый профиль пропускаем: он не должен рушить весь список */
    }
  }
  return out;
}

/**
 * Файл профиля: сначала встроенный, потом пользовательский.
 *
 * Порядок именно такой, и это решение, а не случайность. Свой файл с чужим id НЕ
 * подменяет встроенный молча: у встроенных порогов есть ссылка на документ площадки, и
 * подмена значила бы, что человек читает чужое число со ссылкой, которая ему не
 * принадлежит. Свою площадку заводят своим id.
 *
 * Проходов два, и второй не роскошь. Первый — по имени файла: так названы все встроенные
 * и всё, что пишет `saveCustomProfile`, и на этом пути не читается ни один файл. Второй —
 * по `id` внутри файла, тем же способом, каким площадка попадает в список. Он и
 * подбирает случай, ради которого всё это переписано: имя файла не равно id (или id не
 * латиницей — `safeId` вырезает остальное, и прямого пути у такого профиля нет вовсе).
 */
function profilePath(id: string): { file: string; custom: boolean } | null {
  const wanted = String(id);
  const name = `${safeId(wanted)}.json`;
  if (name !== '.json') {
    for (const { dir, custom } of PROFILE_DIRS()) {
      const direct = path.join(dir, name);
      if (fs.existsSync(direct)) return { file: direct, custom };
    }
  }
  for (const { dir, custom } of PROFILE_DIRS()) {
    const hit = profileEntries(dir).find((e) => e.id === wanted);
    if (hit) return { file: hit.file, custom };
  }
  return null;
}

// «Площадка не выбрана» — такой же законный выбор, как любая площадка (решение
// Александра, 2026-08-10). Человек берёт движок и видит ВСЁ, что тот умеет, без
// требований какой-либо витрины. Прочерк в списке площадок — это он.
//
// Сделано синтетическим профилем, а не особым случаем во всех вызовах: ниже по течению
// (planFor, explainResult, extensionsOf) ничего не меняется — им приходит обычный
// профиль, просто без бюджетов и без имени.
export const NO_PLATFORM = '';

// Числа прочерка живут в profiles/_none.json — обычным файлом того же формата, со всеми
// ссылками на источник. Он помечен enabled: false, поэтому в списке площадок его нет:
// это не площадка, а общие рекомендации для веба (пороги Khronos glTF Asset Auditor).
//
// Раньше они были отдельной площадкой «Веб (Three.js)» — то есть площадкой, названной
// именем движка. Слито 2026-08-10 по решению Александра: выбор без площадки и «просто
// веб» — одно и то же, держать их порознь значило спрашивать человека о разнице,
// которой нет.
const NONE_DEFAULTS = '_none';

function noneDefaults() {
  try {
    const found = profilePath(NONE_DEFAULTS);
    if (found) return JSON.parse(fs.readFileSync(found.file, 'utf8'));
  } catch {
    /* файла нет или он битый — прочерк просто останется без рекомендаций */
  }
  return {};
}

function syntheticProfile(engineId: string, lang: string = DEFAULT_LANG): ProfileJson {
  const id = engineId || DEFAULT_ENGINE;
  const engine = loadEngine(id);
  const defaults = noneDefaults();
  return {
    id: NO_PLATFORM,
    engine: id,
    // Имя прочерка — ключ интерфейса (insp.platform.none), а не поле файла: это подпись
    // элемента управления, и вторая копия той же строки разошлась бы с первой.
    title: null,
    description: pick(defaults.description, lang),
    // Только советы, жёстких пределов тут не бывает и быть не может: отказать в файле
    // может площадка, а её не выбрали. Сторожит tests/engine-target-split.test.mjs.
    budgets: defaults.budgets || {},
    // Базовый план — у движка: он единственный, кто тут вообще что-то знает.
    baselineOpts: (engine && engine.baselineOpts) || defaults.baselineOpts || {},
    notes: defaults.notes || [],
  };
}

function loadProfile(platformId: string, engineId?: string, lang: string = DEFAULT_LANG): ProfileJson {
  if (!platformId) return syntheticProfile(engineId!, lang);
  const found = profilePath(platformId);
  if (!found) {
    const known = listPlatforms().map((p) => p.id).join(', ');
    throw new Error(`Unknown platform "${platformId}". Available: ${known || '—'}.`);
  }
  try {
    const profile = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    // Пометку ставит ЗАГРУЗЧИК по тому, откуда взят файл, а не сам файл. Иначе свой
    // профиль объявил бы себя встроенным, и его придуманные числа показывались бы
    // наравне с выверенными по первоисточнику.
    profile.custom = found.custom;
    return profile;
  } catch (e) {
    // cause сохраняем: без него из сообщения не видно, в каком месте JSON сломан,
    // а именно это и нужно тому, кто правит профиль.
    throw new Error(`Profile "${platformId}" is corrupted: ${(e as Error).message}`, { cause: e });
  }
}

// ----------------------------------------------------------------------------
// Загрузка движков (ARCHITECTURE.md §4g)
//
// Движок — вторая ось, равноправная площадке. Ему принадлежит то, что зависит от
// ЧИТАТЕЛЯ файла: какие расширения вообще предлагать и какой модуль вьюпорта
// монтировать. Площадке принадлежат лимиты. Раньше список расширений лежал в каждом
// профиле — четырьмя побайтно одинаковыми копиями.
//
// Отсутствующий файл движка — не поломка: список расширений окажется пустым, панель
// «Расширенные опции» просто не покажется. Это честнее выдуманного списка.
// ----------------------------------------------------------------------------

const DEFAULT_ENGINE = 'threejs';

function enginePath(id: string): string {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  return path.join(ENGINES_DIR, `${safe}.json`);
}

function loadEngine(engineId: string): EngineJson | null {
  const id = engineId || DEFAULT_ENGINE;
  const file = enginePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Engine "${id}" is corrupted: ${(e as Error).message}`, { cause: e });
  }
}

// Движок площадки — или ЕГО ОТСУТСТВИЕ, и это законное состояние (решение Александра
// 2026-08-18: «убери движок у mobile и quest»).
//
// Площадка диктует движок только если она И ЕСТЬ конкретная витрина с конкретным
// просмотрщиком. Shopify такова: её карточка товара рисуется через model-viewer, и
// выбрать под неё Babylon нельзя — такой пары не существует. А «Смартфоны» и «Meta
// Quest» — это КЛАССЫ УСТРОЙСТВ, а не витрины. Браузер телефона и браузер шлема
// одинаково запустят three.js, Babylon, model-viewer и что угодно ещё: движок выбирает
// сайт, а не устройство. Стоявшее там "engine": "threejs" было утверждением, которого
// никто не делал, — тем же по природе, что и "engine": "threejs" у Shopify до сверки
// 2026-08-10; только у Shopify нашёлся настоящий ответ, а здесь его нет и быть не может.
//
// Молча подставлять DEFAULT_ENGINE вместо отсутствующего поля нельзя: по §4g выбранная
// площадка ПЕРЕБИВАЕТ выбор движка, и подстановка означала бы, что человек, выбравший
// «Мобильные», молча получает палитру three.js — при том что его мобильный сайт может
// быть на чём угодно.
//
// Поэтому: поле есть — оно и есть ответ; поля нет — берём тот движок, который человек
// выбрал сам; не выбрал ничего — DEFAULT_ENGINE как последняя опора, чтобы приложение
// не осталось без списка опций.
function engineIdOf(profile: ProfileJson, asked?: string): string {
  return (profile && profile.engine) || asked || DEFAULT_ENGINE;
}

/** Диктует ли площадка движок. Пусто — значит годится любому, как прочерк. */
function dictatesEngine(profile: ProfileJson): boolean {
  return !!(profile && profile.engine);
}

export function listEngines(lang: string = DEFAULT_LANG) {
  let files;
  try {
    files = fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8'));
      if (e && e.id && e.enabled !== false) {
        out.push({
          id: e.id,
          title: pick(e.title, lang) || e.id,
          description: pick(e.description, lang),
          viewer: e.viewer || e.id,
          primary: e.primary === true,
        });
      }
    } catch {
      /* повреждённый движок просто не показываем — как и профиль */
    }
  }
  // Ведущий движок — первым. Когда площадка не выбрана, выбирать движок больше не по
  // чему, и алфавит решал бы за человека: «model-viewer» встал бы раньше «threejs»
  // просто по букве. Признак лежит в данных (primary), а не в коде интерфейса, —
  // иначе смена ведущего движка потребовала бы правки js.
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

// Какие площадки достижимы на этом движке. Нужно для симметрии двух полей (§4g):
// выбор движка переупорядочивает список площадок ровно так же, как выбор площадки —
// список движков. Сегодня движок один и ответ всегда полный список; смысл в том, что
// интерфейс уже спрашивает, а не узнаёт об этом при появлении второго движка.
// Что показать под книжечкой у прочерка. Не площадка, поэтому и не в listPlatforms():
// отдельным полем ответа, чтобы список площадок остался списком площадок.
export function noPlatformInfo(lang: string = DEFAULT_LANG) {
  const d = noneDefaults();
  return { description: pick(d.description, lang) };
}

export function platformsForEngine(engineId: string, lang: string = DEFAULT_LANG) {
  return listPlatforms(lang).filter((p) => {
    try {
      const profile = loadProfile(p.id);
      // Площадка, которая движок не диктует, годится ЛЮБОМУ — как прочерк.
      return !dictatesEngine(profile) || engineIdOf(profile) === engineId;
    } catch {
      return false;
    }
  });
}

// Обратная сторона той же симметрии: какие движки годятся для площадки.
export function enginesForPlatform(platformId: string, lang: string = DEFAULT_LANG) {
  let profile;
  try {
    profile = loadProfile(platformId);
  } catch {
    return [];
  }
  // Не диктует движок — годятся все: выбор остаётся за человеком.
  if (!dictatesEngine(profile)) return listEngines(lang);
  const wanted = engineIdOf(profile);
  return listEngines(lang).filter((e) => e.id === wanted);
}

// ----------------------------------------------------------------------------
// Форматирование чисел для человеческих текстов (байты → МБ здесь, не в ядре)
// ----------------------------------------------------------------------------

const MB = (bytes: number) => bytes / (1024 * 1024);

// Единицы и разделитель разрядов — часть языка, а не константа. «11.4 MB» и «500,000»
// посреди русского текста читаются как недоделка, потому что это она и есть.
const UNITS: Record<string, { kb: string; mb: string; locale: string }> = {
  en: { kb: 'KB', mb: 'MB', locale: 'en-US' },
  ru: { kb: 'КБ', mb: 'МБ', locale: 'ru-RU' },
};

// Возвращает форматтеры под язык. Внутри exported-функций результат кладётся в
// одноимённые const — они перекрывают модульные, поэтому вызовы не переписываются.
function formatters(lang: string) {
  const u = UNITS[lang] || UNITS[DEFAULT_LANG]!;
  return {
    // Человеческий размер: до 1 МБ показываем в КБ, иначе в МБ — крошечные модели
    // не должны выглядеть как «0.0 МБ».
    fmtMB: (bytes: number) => (bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} ${u.kb}`
      : `${MB(bytes).toFixed(1)} ${u.mb}`),
    fmtInt: (n: number) => Number(n).toLocaleString(u!.locale),
  };
}


// Величина изменения в процентах, без знака: «18» / «220» / «0.06».
//
// Точность подбирается по величине, и это не педантизм. Округление до целого прятало
// настоящие изменения: 6 380 → 6 376 байт — это −0.06 %, а показанный ноль рядом с
// зелёной строкой читается как «инструмент ничего не сделал». Чем меньше изменение,
// тем больше знаков; если и двух мало — говорим «меньше сотой доли», но не ноль.
function pctMagnitude(before: number, after: number) {
  if (!before) return '0';
  const abs = Math.abs(((after - before) / before) * 100);
  const shown = abs.toFixed(abs >= 1 ? 0 : abs >= 0.1 ? 1 : 2);
  return Number(shown) === 0 && abs > 0 ? '<0.01' : shown;
}

// «−18%» / «+220%» / «0%». Ноль — только когда числа совпали ровно: словами «без
// изменений» подписывать результат нельзя там, где что-то изменилось.
function pctText(before: number, after: number) {
  if (!before || after === before) return '0%';
  return (after < before ? '−' : '+') + pctMagnitude(before, after) + '%';
}

// Порог раздела «главные улучшения»: ниже процента хвастаться нечем (см. highlights).
const HIGHLIGHT_MIN_PCT = 1;

// «4×» / «4.5×» — множитель для нейтрального объяснения падения VRAM
function timesLess(before: number, after: number) {
  if (!after) return null;
  const ratio = before / after;
  if (ratio < 1.15) return null;
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}

// ----------------------------------------------------------------------------
// listPlatforms()
// ----------------------------------------------------------------------------

export function listPlatforms(lang: string = DEFAULT_LANG) {
  const out = [];
  const seen = new Set<string>();
  // Тот же перебор, которым площадку ИЩЕТ profilePath. Две копии этого обхода разошлись
  // на первом же файле, названном не по id, — см. шапку profileEntries.
  for (const { dir, custom } of PROFILE_DIRS()) {
    for (const { id, profile: p } of profileEntries(dir)) {
      // v0.1.0: показываем только включённые платформы (enabled: true или не указано = true)
      if (p.enabled === false) continue;
      // Свой профиль с чужим id в список не попадает и встроенный не подменяет:
      // подмена значила бы чужое число под ссылкой на документ настоящей площадки.
      if (seen.has(id)) continue;
      seen.add(id);
      // engine — аддитивное поле (§4c): интерфейс держит два поля согласованными,
      // не делая запрос на каждую площадку по отдельности.
      out.push({
        id,
        title: pick(p.title, lang) || id,
        description: pick(p.description, lang),
        // Откуда у площадки её запреты и числа. Второй вопрос, отдельный от «что это
        // за площадка», и в книжечке он идёт отдельной строкой.
        source: pick(p.source, lang),
        // null, а не подставленный движок: интерфейс по этому полю решает, показывать
        // ли «нужен другой движок». Площадка без движка годится любому.
        engine: dictatesEngine(p) ? engineIdOf(p) : null,
        // Откуда взялся профиль. Интерфейсу это нужно, чтобы не выдавать свои числа
        // за выверенные по первоисточнику (решение 2026-08-12).
        custom,
      });
    }
  }
  return out;
}

/** Папка, куда человек кладёт свои профили. Интерфейсу — чтобы показать путь. */
export function customProfilesDir(): string {
  return userProfilesDir();
}

// ----------------------------------------------------------------------------
// planFor(platformId) — план обработки + объяснение выбора настроек
// ----------------------------------------------------------------------------

// engineId нужен ТОЛЬКО когда площадка не выбрана: без неё движок больше неоткуда взять,
// две оси стали по-настоящему независимыми. У выбранной площадки движок свой, и
// переданное значение игнорируется — иначе можно было бы посчитать план для пары,
// которой не существует.
export function planFor(platformId: string, lang: string = DEFAULT_LANG, engineId?: string) {
  const t = messages(lang);
  const { fmtInt } = formatters(lang);
  const profile = loadProfile(platformId, engineId, lang);
  // v0.0.8: базовый план строится из baselineOpts (KTX2/Draco выключены);
  // engineOpts — legacy-поле старых профилей, оставлено как фолбэк.
  //
  // Третий фолбэк — движок. Базовый план принадлежит ему: площадка вправе его сузить,
  // но обязанности переписывать целиком у неё нет. Без этой строки профиль, не
  // назвавший baselineOpts, получал пустой план — и объяснение начиналось со слов про
  // meshopt, потому что `opts.codec` не был равен 'draco'. Своя площадка из формы
  // baselineOpts не пишет вовсе: спрашивать про кодек того, кто заводит площадку по
  // письму менеджера, — ровно то, чего Правило 10 не велит.
  const opts = profile.baselineOpts || profile.engineOpts
    || (loadEngine(engineIdOf(profile, engineId)) || {}).baselineOpts || {};
  const b = profile.budgets || {};

  const explanation = [];

  // геометрия
  explanation.push(t(opts.codec === 'draco' ? 'plan.geometry.draco' : 'plan.geometry.meshopt'));

  // чистка структуры — базовая часть плана, происходит всегда
  explanation.push(t('plan.cleanup'));

  // текстуры
  if (opts.noKtx) explanation.push(t('plan.textures.keep'));
  else if (opts.texMode === 'uastc') explanation.push(t('plan.textures.uastc'));
  else explanation.push(t('plan.textures.mixed'));

  // сборка деталей
  explanation.push(t(opts.keepParts ? 'plan.parts.keep' : 'plan.parts.join'));

  // цвета вершин
  if (opts.stripColors) explanation.push(t('plan.stripColors'));

  // цель по бюджету платформы
  const warnOf = (id: string) => (budgetEntry(b[id]) || {}).warn;
  const targetBits = [];
  if (warnOf('triangles')) targetBits.push(t('plan.goal.triangles', { n: fmtInt(warnOf('triangles')!) }));
  if (warnOf('textureMaxSize')) targetBits.push(t('plan.goal.textureSize', { px: warnOf('textureMaxSize') }));
  if (warnOf('vramMB')) targetBits.push(t('plan.goal.vram', { mb: warnOf('vramMB') }));
  if (targetBits.length) {
    explanation.push(t('plan.goal', { title: pick(profile.title, lang), bits: targetBits.join(', ') }));
  }

  return {
    profileId: profile.id,
    title: pick(profile.title, lang),
    // Движок, для которого посчитан план. Сегодня он один и поле выглядит лишним —
    // в этом и смысл: пара «площадка + движок» должна быть видна в данных, а не
    // прятаться в названии вроде «Web (Three.js)» (ARCHITECTURE.md §4g). Когда
    // движков станет несколько, добавление будет данными, а не сменой протокола.
    engine: engineIdOf(profile, engineId),
    // Как движок называется и какой вьюпорт монтировать — из engines/<id>.json.
    // null, если файла движка нет: интерфейс покажет площадку без движка, но не
    // выдумает имя.
    engineInfo: (() => {
      const e = loadEngine(engineIdOf(profile, engineId));
      return e ? { id: e.id, title: pick(e.title, lang) || e.id, description: pick(e.description, lang), viewer: e.viewer || e.id } : null;
    })(),
    engineOpts: { ...opts },
    // Что площадка СОВЕТУЕТ человеку — отдельно от того, чем движок жмёт по плану.
    //
    // Разница не косметическая. `engineOpts` (из `baselineOpts`) есть у всего: у
    // прочерка, у самого движка, у любого профиля, — и заполнен всегда. Прочитать его
    // как совет значит советовать ВСЕГДА, в том числе там, где мы ничего не проверяли.
    // Ровно это и случилось 2026-08-26: площадка Shopify ставила человеку галочку
    // Meshopt, хотя её собственный профиль называет это ОТКРЫТЫМ ВОПРОСОМ — читает ли
    // витрина Meshopt, выяснить снаружи не удалось.
    //
    // Александр, 2026-08-26: «если где-то нет проверки, то ВСЕГДА мы не должны ничего
    // рекомендовать и всё. лучше быть глупым инструментом и молчать, чем казаться умным
    // и портить работу клиента».
    //
    // Поэтому поле НЕОБЯЗАТЕЛЬНОЕ и пустое по умолчанию: нет поля — нет совета. Площадка
    // молчит, пока её автор не назвал источник и не проверил.
    advises: profile.advises || {},
    explanation,
    // аддитивное поле (в рамках правил стабильности §4c): web-interface может взять
    // список расширений прямо из плана, не делая второй вызов
    availableExtensions: extensionsOf(profile, lang),
  };
}

// ----------------------------------------------------------------------------
// getAvailableExtensions(platformId) — расширенные опции платформы (opt-in)
// ----------------------------------------------------------------------------

// Текст опции берётся ИЗ КАТАЛОГА по её id, а не из профиля.
//
// Профиль остаётся данными о площадке — набор опций, числа бюджетов, обратимость.
// Текст один на язык: до 2026-08-04 четыре профиля держали четыре копии одного и
// того же (13 065 знаков, из них ~10 000 — дубли), и каждая новая площадка означала
// повторный перевод всех десяти опций. Теперь площадка не платит за язык вовсе.
//
// Переопределение оставлено намеренно: если у площадки опция и правда работает
// иначе, профиль может задать СВОЁ поле — оно победит. Это одно поле, а не копия
// блока, и такой случай обязан быть исключением, а не нормой.
function optionText(id: string, field: string, lang: string, override?: unknown) {
  if (override != null && override !== '') return pick(override, lang);
  const t = messages(lang);
  const key = `option.${id}.${field}`;
  const text = t(key);
  // messages() отдаёт сам ключ, если перевода нет: не молчим, но и не подставляем
  // ключ в интерфейс — пустая строка честнее, поле просто не покажется.
  return text === key ? '' : text;
}

// Состав списка берётся у ДВИЖКА (§4g): «читает ли этот проигрыватель KTX2 без
// декодера» — свойство читателя, а не витрины. Слова к каждому id по-прежнему из
// core/messages/, здесь только состав.
//
// Площадка может ВЫЧЕСТЬ из этого списка, но не задать его (решение Александра,
// 2026-08-10). Разница существенная: «движок умеет Meshopt» верно на любом сайте, а
// «декодер на витрине подключён» — свойство конкретного развёртывания. Если бы список
// задавала площадка, мы вернулись бы к четырём одинаковым копиям, из которых только что
// ушли.
//
// Вычтенное НЕ показывается серым с объяснением, а исчезает совсем. Человеку, выбравшему
// Shopify, незачем знать про десятки возможностей, которых там нет: правило «показывать,
// а не прятать» (§4g) написано для ПОЛЕЙ ВЫБОРА, где человек ищет знакомое имя и, не
// найдя, уходит искать ответ наружу. В списке опций искать нечего — ожидания нет, обмануть
// его нельзя. Полную палитру движка человек видит, выбрав движок без площадки.
export function narrowToPlatform(list: ExtensionEntry[], profile: ProfileJson): ExtensionEntry[] {
  const drop = new Set(Array.isArray(profile && profile.excludeExtensions) ? profile.excludeExtensions : []);
  return drop.size ? list.filter((e) => !drop.has(e.id)) : list;
}

function extensionsOf(profile: ProfileJson, lang: string = DEFAULT_LANG, engineId?: string): ExtensionEntry[] {
  // engineId — движок, выбранный человеком. Он применяется ТОЛЬКО когда площадка своего
  // не назвала: у Shopify палитру задаёт model-viewer и спорить не с чем, а у «Смартфонов»
  // движка нет вовсе, и палитра обязана прийти от того, что выбрано в соседнем поле.
  const engine = loadEngine(engineIdOf(profile, engineId));
  const all = engine && Array.isArray(engine.availableExtensions) ? engine.availableExtensions : [];
  const list = narrowToPlatform(all, profile);
  // копии: мутации у потребителя не должны влиять на закешированные профили
  return list.map((e) => ({
    ...e,
    title: optionText(e.id, 'title', lang, e.title),
    description: optionText(e.id, 'description', lang, e.description),
    impact: optionText(e.id, 'impact', lang, e.impact),
    opts: { ...(e.opts || {}) },
  }));
}

export function getAvailableExtensions(platformId: string, lang: string = DEFAULT_LANG, engineId?: string) {
  return extensionsOf(loadProfile(platformId, engineId, lang), lang, engineId);
}

// Алиас под имя, которое web-interface (server.mjs) уже ищет у ассистента.
export const listExtensions = getAvailableExtensions;

// ----------------------------------------------------------------------------
// explainResult(runResult, platformId)
// ----------------------------------------------------------------------------

export function explainResult(runResult: RunResultLike, platformId: string, lang: string = DEFAULT_LANG) {
  const t = messages(lang);
  const { fmtMB, fmtInt } = formatters(lang);
  // валидирует platformId (throws на неизвестном) — контракт §4c; budgets нужны для сверки
  const profile = loadProfile(platformId);

  const rr = runResult || {};
  const before = rr.metrics && rr.metrics.before;
  const after = rr.metrics && rr.metrics.after;

  // --- нештатные статусы ---
  if (rr.error) {
    return {
      summary: t('status.error', { error: rr.error }),
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (rr.status === 'skip') {
    return {
      summary: t('status.skip'),
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (!before || !after) {
    return {
      summary: t('status.noMetrics'),
      highlights: [],
      budgetChecks: [],
      warnings: collectWarnings(rr, t),
    };
  }

  // --- summary: файл + видеопамять ---
  const fileGrew = after.fileBytes > before.fileBytes;
  const vramDropped = after.gpuBytes < before.gpuBytes;

  // Одно сообщение целиком под каждый исход, а не приставка к общему: склеивать строки
  // в коде нельзя — разделитель и порядок слов принадлежат языку.
  const sizes = {
    fileBefore: fmtMB(before.fileBytes),
    fileAfter: fmtMB(after.fileBytes),
    filePct: pctText(before.fileBytes, after.fileBytes),
    vramBefore: fmtMB(before.gpuBytes),
    vramAfter: fmtMB(after.gpuBytes),
    vramPct: pctText(before.gpuBytes, after.gpuBytes),
  };
  let summary = t(rr.status === 'fail' ? 'summary.doneWithIssue' : 'summary.done', sizes);
  if (rr.status !== 'fail' && fileGrew && vramDropped) {
    // рост файла при падении VRAM — не ошибка, объясняем нейтрально
    summary += t('summary.fileGrewVramDropped');
  }

  // --- highlights: главные улучшения человеческим языком ---
  //
  // Это раздел похвальбы, и у него есть порог. Замер в итоге и в HUD — точный, там
  // «−0.06 %» законно; здесь — заявка на достижение, и «Файл легче на 0 %» дискредитирует
  // весь список: если приложение хвалится ничем, читать его перестают. Не дотянуло до
  // порога — строки просто нет.
  const highlights = [];
  const gainPct = (b: number, a: number) => (b ? ((b - a) / b) * 100 : 0);

  if (gainPct(before.fileBytes, after.fileBytes) >= HIGHLIGHT_MIN_PCT) {
    highlights.push(t('hi.fileLighter', { pct: Math.round(gainPct(before.fileBytes, after.fileBytes)) }));
  } else if (fileGrew && vramDropped) {
    const tl = timesLess(before.gpuBytes, after.gpuBytes);
    highlights.push(tl ? t('hi.vramTimesLess', { times: tl }) : t('hi.vramDropped'));
  }

  if (!fileGrew && gainPct(before.gpuBytes, after.gpuBytes) >= HIGHLIGHT_MIN_PCT) {
    highlights.push(t('hi.vramPct', { pct: Math.round(gainPct(before.gpuBytes, after.gpuBytes)) }));
  }

  if (after.drawCalls < before.drawCalls) {
    highlights.push(t('hi.drawCalls', { before: fmtInt(before.drawCalls), after: fmtInt(after.drawCalls) }));
  }

  if (before.triangles > 0 && after.triangles === before.triangles) {
    highlights.push(t('hi.shapeKept', { n: fmtInt(after.triangles) }));
  } else if (before.triangles > 0 && after.triangles < before.triangles) {
    highlights.push(t('hi.trianglesRemoved', { before: fmtInt(before.triangles), after: fmtInt(after.triangles) }));
  }

  if (Array.isArray(rr.applied) && rr.applied.length) {
    highlights.push(t('hi.applied', { n: rr.applied.length }));
  }

  // Раньше здесь стоял пустой массив: сверять результат с абстрактными бюджетами
  // платформы без явной цели пользователя было бессмысленно. Теперь бюджет говорит не
  // «не проходишь», а «измерено столько, документация платформы рекомендует столько» —
  // и только там, где документация действительно есть.
  return {
    summary,
    highlights: highlights.slice(0, 6),
    budgetChecks: buildBudgetChecks(
      profile.budgets || {}, after, lang, profile.custom === true, pick(profile.source, lang),
    ),
    warnings: collectWarnings(rr, t),
  };
}

// ----------------------------------------------------------------------------
// budgetChecks — измеренное значение и, если для него есть документированный порог,
// оценка относительно этого порога.
//
// Три уровня, и разница между ними принципиальная:
//   ok    — порог есть, укладываемся;
//   warn  — превышена документированная РЕКОМЕНДАЦИЯ платформы. Жёлтый. Это совет;
//   over  — превышен документированный ЖЁСТКИЙ ПРЕДЕЛ площадки: файл отклонят или
//           пережмут без спроса. Красный. Только там, где такой предел объявлен
//           (магазины), — у Three.js его нет и быть не может, это не витрина.
//
// Метрика без порогов НЕ исчезает: значение показывается, оценка не выносится. Придуманный
// порог пользователь примет за требование платформы — а мы не отличим на глаз выверенное
// число от выдуманного через месяц. Поэтому в профилях порога без source быть не должно.
// ----------------------------------------------------------------------------

// метрика профиля → откуда брать значение результата и в чём измеряются пороги
const BUDGET_SPEC: Record<string, BudgetSpec> = {
  triangles: { nameKey: 'budget.triangles', adviceKey: 'advice.triangles', value: (a) => a.triangles, unit: 'int' },
  materials: { nameKey: 'budget.materials', adviceKey: 'advice.materials', value: (a) => a.materials, unit: 'int' },
  drawCalls: { nameKey: 'budget.drawCalls', adviceKey: 'advice.drawCalls', value: (a) => a.drawCalls, unit: 'int' },
  vramMB: { nameKey: 'budget.vram', adviceKey: 'advice.vram', value: (a) => a.gpuBytes, unit: 'mb' },
  fileMB: { nameKey: 'budget.file', adviceKey: 'advice.file', value: (a) => a.fileBytes, unit: 'mb' },
  // Появилась 2026-08-12 вместе с замером размерности в ядре. До этого порог во всех
  // профилях лежал мёртвым: сравнивать было не с чем. Значение 0 (текстур нет либо
  // размер не прочитался) в сверку не идёт — см. проверку ниже.
  textureMaxSize: {
    nameKey: 'budget.textureSize', adviceKey: 'advice.textureSize',
    value: (a) => a.textureMaxSize, unit: 'px',
  },
};

// Голое число в профиле = рекомендация без ссылки. Так пишут сторонние профили, и это
// допустимо: автор отвечает за своё число сам. В наших профилях так быть не должно.
function budgetEntry(raw: unknown): BudgetEntry | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return { warn: raw };
  if (typeof raw === 'object') return raw as BudgetEntry;
  return null;
}

function buildBudgetChecks(
  budgets: Record<string, unknown>,
  after: MetricsLike,
  lang: string = DEFAULT_LANG,
  custom = false,
  defaultSource = '',
) {
  const t = messages(lang);
  const { fmtMB, fmtInt } = formatters(lang);
  const checks = [];

  for (const [id, spec] of Object.entries(BUDGET_SPEC)) {
    const entry = budgetEntry(budgets[id]);
    if (!entry) continue;
    const raw = spec.value(after);
    if (raw == null) continue;
    // Размерность текстур — единственная метрика, у которой ноль означает «нечего
    // мерить» (текстур нет либо размер не прочитался), а не «ноль пикселей». Показать
    // «0» рядом с порогом 2048 значило бы соврать зелёным цветом.
    if (spec.unit === 'px' && raw === 0) continue;

    // пороги профиля заданы в МБ, метрика приходит в байтах — сравниваем в единицах порога
    const actual = spec.unit === 'mb' ? MB(raw) : raw;
    const show = spec.unit === 'mb' ? fmtMB(raw)
      : spec.unit === 'px' ? t('unit.pxValue', { v: fmtInt(raw) })
        : fmtInt(raw);
    const fmt = (v: number) => (
      spec.unit === 'mb' ? `${v} ${t('unit.mb')}`
        : spec.unit === 'px' ? t('unit.pxValue', { v: fmtInt(v) })
          : fmtInt(v)
    );

    // Поля source/by/limitText/warnText/advice появляются ниже по ветвям — объявляем
    // форму записи заранее, иначе к литералу из четырёх полей пятое не добавить.
    const check: BudgetCheck = { id, name: t(spec.nameKey), actualText: show, level: 'none' };
    // Откуда порог: ссылка на документ платформы либо наше собственное решение. Второе
    // тоже законно, но обязано выглядеть иначе — выдавать решение проекта за требование
    // платформы значит ровно то же враньё, ради борьбы с которым всё это затевалось.
    //
    // `defaultSource` — источник, названный на весь профиль. Своя площадка называет его
    // один раз в форме, а не копией у каждого порога: один и тот же адрес, повторённый
    // в файле шесть раз, — ровно то «полотно», которого быть не должно.
    if (entry.source || defaultSource) check.source = entry.source || defaultSource;
    if (!check.source && entry.by) check.by = entry.by;
    // Порог из СВОЕГО профиля. Пометка ставится ЗДЕСЬ, а не берётся из файла: объявить
    // своё число выверенным по документу площадки не должно быть возможно (§5i).
    //
    // Ставится ВМЕСТЕ со ссылкой, а не вместо неё. Ссылка отвечает на вопрос «откуда
    // число», пометка — на вопрос «чьё оно»; это разные вопросы, и подменять второй
    // первым значило бы, что придуманный порог со ссылкой на чей-то сайт выглядит как
    // выверенный по документу площадки.
    if (custom) check.by = 'user';

    if (entry.limit != null) check.limitText = t('budget.limit', { v: fmt(entry.limit) });
    if (entry.warn != null) check.warnText = t('budget.recommended', { v: fmt(entry.warn) });

    if (entry.limit != null && actual > entry.limit) {
      check.level = 'over';
      check.advice = t('advice.overLimit', { name: check.name, actual: show, limit: fmt(entry.limit) });
    } else if (entry.warn != null && actual > entry.warn) {
      check.level = 'warn';
      check.advice = t(spec.adviceKey, { actual: show, warn: fmt(entry.warn) });
    } else if (entry.warn != null || entry.limit != null) {
      check.level = 'ok';
    }

    checks.push(check);
  }

  return checks;
}

// ----------------------------------------------------------------------------
// Своя площадка: собрать формой, а не писать JSON руками (решение 2026-08-12)
//
// Форма спрашивает ровно то, чего вывести неоткуда: как площадка называется, каким
// движком её читают и какие у неё пороги. Всё остальное — состав списка опций, слова
// опций, базовый план обработки — принадлежит движку и подставляется само
// (Правило 10б). Поэтому автору своей площадки достаётся имя, движок и несколько
// чисел, а не двадцать галочек, в половине которых он ошибётся.
//
// Список полей НЕ дублируется: он и есть BUDGET_SPEC. Новая метрика бюджета появится
// в форме сама, вместе с уже написанной подписью. Вторая копия такого списка уже
// расходилась с первой — см. EXCLUSIVE_FEATURES в аддоне.
// ----------------------------------------------------------------------------

/**
 * Отказ формы. Несёт КОД, а не фразу: текст отказа принадлежит интерфейсу и его
 * каталогу строк (Правило 8), иначе английская фраза из этого модуля попала бы на
 * русский экран.
 */
export class ProfileError extends Error {
  code: string;
  /** Какое поле формы виновато. Пустая строка — отказ не про поле, а про форму целиком. */
  field: string;
  constructor(code: string, field = '') {
    super(code);
    this.name = 'ProfileError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Сколько букв даётся на описание и на источник.
 *
 * Предел назвал Александр 2026-08-13: «для написания своего описания продукта нужно
 * использовать минимальное количество разрешённых символов, например 150». Это не
 * экономия места в файле — это Правило 10: подсказку читает новичок, и абзац на экране
 * он не читает вовсе. Два коротких поля вместо одного длинного отвечают на два разных
 * вопроса: ЧТО это за площадка и ОТКУДА взялись её запреты и числа.
 */
const MAX_TEXT = 150;

/** Что спрашивает форма. Обязательно только название. */
export interface CustomProfileInput {
  id?: string;
  title?: string;
  /**
   * Движок площадки — или null, если площадка его НЕ ДИКТУЕТ. Пустое значение законно
   * и означает «годится любому»: так живут классы устройств (смартфоны, VR-шлем), где
   * движок выбирает сайт, а не устройство. Отличать от отсутствия поля в форме своей
   * площадки — там его просто не спрашивают.
   */
  engine?: string | null;
  description?: string;
  /**
   * Откуда взяты запреты и числа этой площадки: ссылка на документ или пояснение
   * словами. Лежит ОДИН раз на весь профиль, а не копией у каждого порога — иначе
   * один и тот же адрес повторялся бы в файле шесть раз.
   */
  source?: string;
  budgets?: Record<string, unknown>;
  /**
   * Что эта площадка НЕ читает — список id опций движка.
   *
   * Единственная форма, в которой площадке позволено говорить о возможностях:
   * ВЫЧИТАТЬ из палитры движка. Объявлять их она не вправе — иначе вернётся дефект,
   * ради которого движок и площадку разводили: четыре профиля держали четыре
   * побайтно одинаковые копии десяти опций (Правило 10б).
   */
  excludeExtensions?: unknown;
}

/**
 * Описание формы для интерфейса: куда кладутся файлы и какие поля порогов бывают.
 * Подписи берутся из того же каталога, что и панель бюджета, — второго перевода
 * слова «Треугольники» в проекте не заводим.
 */
export function profileTemplate(lang: string = DEFAULT_LANG) {
  const t = messages(lang);
  const fields = Object.entries(BUDGET_SPEC).map(([id, spec]) => ({
    id,
    name: t(spec.nameKey),
    // Подпись единицы рядом с полем ввода. У счётных метрик её нет: приписать
    // «штук» к числу треугольников значит сказать то, чего человек и так не спрашивал.
    unit: spec.unit === 'mb' ? t('unit.mb') : spec.unit === 'px' ? t('unit.px') : '',
  }));
  return { dir: userProfilesDir(), fields };
}

// Кириллица → латиница для имени файла. Не «перевод» и не для показа человеку: это
// таблица подстановки, чтобы файл назывался «vitrina-zakazchika.json», а не
// «platform-3.json». Имя файла видно — папку форма показывает прямо под полями, и
// профилем делятся файлом (решение 2026-08-12). Языки, которых в таблице нет
// (китайский, арабский), дают пустой корень и служебное имя — это честный исход, а не
// поломка: площадка от имени файла не зависит, в списке стоит её название.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Имя файла из названия площадки. Только латиница: id ездит в адресе запроса
 * (`?platform=<id>`) и служит именем файла.
 */
function slugFrom(title: string): string {
  const latin = [...String(title).toLowerCase()]
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('');
  return safeId(latin.replace(/\s+/g, '-'))
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const FALLBACK_PROFILE_ID = 'platform';

/** Свободный id: занятое имя получает номер, чужой файл не затирается. */
function freeProfileId(base: string): string {
  const root = base || FALLBACK_PROFILE_ID;
  if (!profilePath(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!profilePath(candidate)) return candidate;
  }
  throw new ProfileError('id_taken');
}

/**
 * Записать свою площадку файлом в пользовательскую папку.
 *
 * Возвращает id — интерфейсу он нужен, чтобы сразу выбрать созданную площадку в
 * списке. Правка существующей своей площадки — тот же вызов с её id.
 */
export function saveCustomProfile(input: CustomProfileInput) {
  const title = String((input && input.title) || '').trim();
  if (!title) throw new ProfileError('title_required');

  const engine = String((input && input.engine) || DEFAULT_ENGINE);
  // Движок обязан существовать: без него площадке нечем предложить ни одной опции,
  // и человек получил бы пустую панель вместо объяснения.
  if (!loadEngine(engine)) throw new ProfileError('engine_unknown', 'engine');

  let id = safeId(String((input && input.id) || ''));
  if (id) {
    // Встроенную площадку формой не перезаписать. Файл лёг бы в другую папку и всё
    // равно проиграл спор об id (profilePath), то есть человек нажал бы «Сохранить»,
    // получил «готово» и не увидел никаких изменений. Честнее отказать.
    const found = profilePath(id);
    if (found && !found.custom) throw new ProfileError('builtin_id', 'title');
  } else {
    id = freeProfileId(slugFrom(title));
  }

  const budgets: Record<string, { warn: number }> = {};
  for (const key of Object.keys(BUDGET_SPEC)) {
    const raw = input && input.budgets ? input.budgets[key] : undefined;
    // Пустое поле — законный ответ «порога нет»: метрика будет показана числом без
    // оценки, ровно как у встроенных площадок, которым источник ничего не назвал.
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ProfileError('bad_number', key);
    // Объектом, а не голым числом: рядом с warn человек дописывает limit руками, когда
    // у его площадки есть настоящий отказ. Формат тот же, что у встроенных профилей, —
    // файл остаётся пригодным для правки текстовым редактором.
    budgets[key] = { warn: n };
  }

  // Что площадка не читает. Пустой список не пишем вовсе: `excludeExtensions: []` и
  // отсутствие поля значат одно и то же, а лишнее поле в файле следующий читатель
  // примет за осмысленное решение автора.
  const raw = input && input.excludeExtensions;
  const exclude = Array.isArray(raw)
    ? [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
    : [];

  // Длинный текст не режем молча: обрезанная посреди слова фраза выглядит как поломка
  // программы, а не как наше решение. Отказ называет поле, чтобы человек знал, какое
  // из двух сокращать.
  const description = String((input && input.description) || '').trim();
  if (description.length > MAX_TEXT) throw new ProfileError('too_long', 'description');
  const source = String((input && input.source) || '').trim();
  if (source.length > MAX_TEXT) throw new ProfileError('too_long', 'source');

  const profile: ProfileJson = {
    id,
    engine,
    enabled: true,
    title,
    ...(description ? { description } : {}),
    ...(source ? { source } : {}),
    budgets,
    ...(exclude.length ? { excludeExtensions: exclude } : {}),
    // Пометки «свой» в файле НЕТ намеренно: её ставит загрузчик по тому, откуда взят
    // файл. Иначе профиль объявил бы себя встроенным, и придуманное число встало бы
    // рядом с выверенным по документу площадки (решение 2026-08-12).
    // baselineOpts тоже нет: базовый план принадлежит движку (см. planFor).
    createdAt: new Date().toISOString(),
  };

  const dir = userProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return { id, file };
}

/**
 * Своя площадка обратно в поля формы. Встроенную так не открыть — её и не правят.
 *
 * Название и описание отдаются ОДНОЙ строкой на текущем языке: поле ввода одно, и
 * многоязычный профиль, написанный руками ({ en, ru }), после сохранения формой
 * останется на том языке, на котором его открыли. Это честнее, чем показать один
 * язык, а сохранить все: человек видит ровно то, что уйдёт в файл.
 */
export function readCustomProfile(id: string, lang: string = DEFAULT_LANG): CustomProfileInput {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  const p = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const budgets: Record<string, number> = {};
  for (const key of Object.keys(BUDGET_SPEC)) {
    const entry = budgetEntry((p.budgets || {})[key]);
    if (entry && entry.warn != null) budgets[key] = entry.warn;
  }
  return {
    id: p.id,
    title: pick(p.title, lang) || p.id,
    engine: dictatesEngine(p) ? engineIdOf(p) : null,
    description: pick(p.description, lang),
    source: pick(p.source, lang),
    budgets,
    excludeExtensions: Array.isArray(p.excludeExtensions) ? p.excludeExtensions : [],
  };
}

// ----------------------------------------------------------------------------
// Обмен площадками: файлом, а не архивом (решение 2026-08-12)
//
// Профиль — один .json, поэтому «поделиться» это «отправить файл». ZIP осмыслен
// только когда в пакете действительно несколько профилей плюс значок; заводить его
// раньше — упаковка ради упаковки.
//
// Ходит СЫРОЙ файл, а не поля формы. Профиль, написанный руками, может нести то, чего
// форма не спрашивает: жёсткий предел `limit`, ссылку на документ площадки `source`,
// список вычитаемых опций `excludeExtensions`, свой базовый план. Пропусти файл через
// форму — всё это молча пропадёт, и получатель увидит не ту площадку, которую ему
// отправили.
// ----------------------------------------------------------------------------

/**
 * Своя площадка файлом — ровно тем, что лежит на диске.
 *
 * Встроенную не отдаём, и это не мелочь: её пороги несут ссылки на документы настоящей
 * площадки. Отданная как образец, поправленная и внесённая обратно, она стала бы своим
 * профилем с чужими ссылками — тем самым враньём, ради борьбы с которым §5i и написан.
 */
export function exportCustomProfile(id: string) {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  return { id: safeId(String(id)), json: fs.readFileSync(found.file, 'utf8') };
}

/**
 * Принять чужую площадку файлом.
 *
 * Возвращает `{ id, replaced }`: интерфейсу нужно сказать человеку, добавилась площадка
 * или обновилась существующая. Молчать об этом нельзя — «обновилась» означает, что
 * прежний файл с его правками перезаписан.
 */
export function importCustomProfile(text: string) {
  let raw: ProfileJson;
  try {
    raw = JSON.parse(String(text));
  } catch {
    throw new ProfileError('bad_file');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('bad_file');
  // Название читаем на любом языке, который есть в файле: профиль от стороннего автора
  // вправе быть написан только по-русски или только по-английски (см. pick). Пусто на
  // всех — отказ: безымянная строка в списке хуже, чем отказ с причиной.
  const title = pick(raw.title, DEFAULT_LANG)
    || (raw.title && typeof raw.title === 'object' ? Object.values(raw.title as Record<string, string>).find(Boolean) || '' : '');
  if (!title) throw new ProfileError('title_required');

  const wanted = safeId(String(raw.id || '')) || slugFrom(title);
  const found = wanted ? profilePath(wanted) : null;
  // Встроенный id занят навсегда: свой файл его всё равно не подменит (profilePath
  // отдаёт встроенный первым), поэтому берём свободное имя, а не отказываем. Отказ
  // здесь означал бы «вашу площадку нельзя назвать Shopify», хотя можно — просто
  // файл будет называться иначе.
  const id = found && !found.custom ? freeProfileId(wanted) : (wanted || freeProfileId(''));
  const replaced = Boolean(found && found.custom);

  const profile: ProfileJson = {
    ...raw,
    id,
    // Импорт — это и есть акт включения. `enabled: false` придуман для черновиков,
    // которые лежат в поставке и до поры не показываются; файл, который человек принёс
    // руками, обязан появиться в списке, иначе успешный импорт выглядит поломкой.
    enabled: true,
  };
  // Пометку «свой» ставит загрузчик по тому, откуда взят файл. В файле её быть не
  // должно даже как мусора: чужой профиль не вправе объявлять себя встроенным.
  delete profile.custom;

  const dir = userProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return { id, replaced };
}

/** Убрать свою площадку. Встроенную не трогаем: её файл не наш. */
export function deleteCustomProfile(id: string) {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  fs.unlinkSync(found.file);
  return { id: safeId(String(id)) };
}

// ----------------------------------------------------------------------------
// warnings — из skipped и validation (info|fail)
// ----------------------------------------------------------------------------

function collectWarnings(rr: RunResultLike, t: Translate = messages(DEFAULT_LANG)) {
  const warnings: string[] = [];

  if (Array.isArray(rr.skipped)) {
    for (const s of rr.skipped) {
      if (!s || !s.text) continue;
      // Предупреждение — это когда мы ХОТЕЛИ сделать, но не стали. «Фича не включена»
      // и «делать было нечего» предупреждениями не являются: первое — выбор
      // пользователя, второе — нормальный исход. Раньше они шли сюда наравне с
      // настоящими отказами, и панель заполнялась строками вида «Not applied: no
      // animations to resample» — перечислением того, чего в модели нет. Настоящий
      // отказ («небезопасно на этой модели») тонул среди них.
      if (s.kind === 'disabled' || s.kind === 'nothing') continue;
      // 'cost' — правило отработало, и вот чего это стоило. Приклеивать сюда
      // «Не применено» нельзя: смысл прямо противоположный, а текст правила уже
      // объясняет и цену, и что с ней делать.
      if (s.kind === 'cost') { warnings.push(s.text); continue; }
      // Причина часто уже вписана в текст («Правило — потому что…»), и приклеивать
      // её вторым хвостом значило печатать одно и то же дважды в одной строке.
      const reason = s.reason && s.reason !== s.text && !s.text.includes(s.reason) ? ` — ${s.reason}` : '';
      warnings.push(t('warn.notApplied', { text: s.text, reason }));
    }
  }

  if (Array.isArray(rr.validation)) {
    for (const v of rr.validation) {
      if (!v || !v.text) continue;
      if (v.level === 'info' || v.level === 'fail') warnings.push(v.text);
    }
  }

  return warnings;
}
