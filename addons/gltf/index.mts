// addons/gltf/index.mjs — аддон формата glTF/GLB. Всегда включён и невыключаем (Фаза C):
// единственный формат ядра. Собирает воедино правила (rules.mjs), метрики (metrics.mjs)
// и внешний тулинг (tools.mjs) и отдаёт движку (core/engine.mjs) набор хуков формата:
//   formats · outputName · rules · BASELINE_METRICS · normalizeOpts · createIO ·
//   load · writeBytes · readBytes · collectMetrics · baselineMetrics ·
//   stripInputCompression · validate · writeReport
//
// Draco/Meshopt/KTX2 работают ТОЛЬКО с Document из @gltf-transform/core — это конкретные
// glTF-расширения, поэтому весь их код живёт здесь, одним пакетом (не дробится на
// addons/draco|meshopt|textures — резать по meta.category можно позже, при втором формате).

import fs from 'node:fs';
import path from 'node:path';

import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

// Общий словарь, а не внутренности движка: аддон не должен зависеть от того, кто его
// вызывает (ARCH-001). core/contract.mjs не зависит ни от кого.
import { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from '../../core/contract.mjs';
import { register, render } from '../../core/i18n.mjs';
import {
  BASELINE_METRICS, BASELINE_SOFT, MB, collectMetrics, baselineSnapshot,
} from './metrics.mjs';
import enMessages from './messages/en.mjs';
import ruMessages from './messages/ru.mjs';
import { importForeign, isImportFormat, IMPORT_FORMATS } from './importers.mjs';
import { readSourceJson, sourceStamp } from './source-json.mjs';
import { RULES } from './rules.mjs';
import { TOKTX } from './tools.mjs';

import type { Document, NodeIO as NodeIOType } from '@gltf-transform/core';
import type { ExclusiveConflict, ReportArgs, ValidateArgs } from '../../core/types.mjs';
import type { GltfMetrics } from './metrics.mjs';
import type { ValidatorMessage } from 'gltf-validator';
import type { GltfContext, GltfOpts } from './types.mjs';

/** Что движок передаёт аддону в фазе 4: контракт ядра, но с документом своего формата. */
type GltfValidateArgs = Omit<ValidateArgs, 'ctx' | 'before' | 'after'> & {
  ctx: GltfContext;
  before: GltfMetrics;
  after: GltfMetrics;
};

/** Что движок передаёт аддону в фазе 5: то же, но опции — свои. */
type GltfReportArgs = Omit<ReportArgs, 'opts' | 'before' | 'after'> & {
  opts: GltfOpts;
  before: GltfMetrics;
  after: GltfMetrics;
};

/**
 * Сообщение валидатора, помеченное расширением, из-за которого оно появилось.
 * Сообщения НЕ удаляются: данные валидатора остаются полными, а интерфейс показывает
 * помеченные отдельной свёрнутой группой и не считает их за проблемы модели.
 */
type ExplainedMessage = ValidatorMessage & { explainedBy?: string };

/** Схлопнутая запись: один вид нарушения, число повторений и несколько примеров. */
type GroupedMessage = ExplainedMessage & { count: number; pointers: string[] };

/** Индекс объекта → имя расширения, которое на него ссылается (валидатор его не читает). */
interface HiddenRefs {
  bufferViews: Map<number, string>;
  buffers: Map<number, string>;
  accessors: Map<number, string>;
  images: Map<number, string>;
}

/** Разобранный JSON ассета: читаем ровно те массивы, где прячутся ссылки расширений. */
type GltfJson = Record<string, any>;

/**
 * Таблицы метаданных. Форма — от fns.inspect(); своё имя нужно ради запасного значения:
 * без него пустые таблицы вывелись бы как `properties: never[]`, и настоящий отчёт
 * в ту же переменную уже не лёг бы.
 */
type InspectLike = ReturnType<typeof fns.inspect> | {
  scenes: { properties: unknown[] };
  meshes: { properties: unknown[] };
  materials: { properties: unknown[] };
  textures: { properties: unknown[] };
  animations: { properties: unknown[] };
};

/** Опции, как они пришли снаружи: до нормализации о них не известно ничего. */
type RawOpts = Record<string, unknown>;

/** Объявление взаимоисключающей группы. Читается и отсюда, и интерфейсом через API. */
interface ExclusiveGroupDef {
  ruleId: string;
  members: string[];
  /** порядок совместимости, а не порядок флажков пользователя */
  priority: string[];
  /**
   * Члены, которые движок ДЕЙСТВИТЕЛЬНО делает взаимоисключающими: лишние вычёркиваются
   * из advancedFeatures, побеждает ПОСЛЕДНИЙ присланный. Не указан — группа только
   * объявлена (интерфейс сам гасит соседа), а движок исполняет всё, что пришло.
   *
   * Почему последний, а не по priority: в интерфейсе клик по галочке гасит соседнюю,
   * то есть выигрывает тот, кого выбрали последним. Движок обязан вести себя так же,
   * иначе один и тот же выбор даёт разный результат в приложении и через API.
   */
  enforce?: string[];
  titleKeys: Record<string, string>;
  /** кого объясняет САМ движок; остальных объясняют их правила */
  engineExplains: string[];
}

// Каталоги правил регистрируются при импорте аддона. Английский обязателен — на него
// core/i18n.mjs откатывается, когда в другом каталоге не хватает ключа.
register('en', enMessages);
register('ru', ruMessages);

const { NodeIO } = gltfCore;

// io с декодерами создаётся один раз и переиспользуется всеми вызовами: инициализация
// тянет за собой WASM-модули Draco и Meshopt, и делать её на каждый вызов — заметная
// плата. NodeIO держит регистрации расширений и зависимостей, но не состояние документа,
// поэтому один экземпляр на процесс корректен: состояния между вызовами он не
// держит, а повторное создание стоит дороже переиспользования.
let _ioPromise: Promise<NodeIOType> | null = null;
function createIO(): Promise<NodeIOType> {
  if (!_ioPromise) {
    _ioPromise = (async () => {
      await MeshoptEncoder.ready;
      await MeshoptDecoder.ready;
      return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'draco3d.decoder': await draco3d.createDecoderModule(),
          'draco3d.encoder': await draco3d.createEncoderModule(),
          'meshopt.decoder': MeshoptDecoder,
          'meshopt.encoder': MeshoptEncoder,
        });
    })();
    // Отвергнутый промис нельзя оставлять в кэше: разовый сбой инициализации (не
    // собрался WASM, нет памяти) иначе делает процесс нерабочим навсегда — каждый
    // следующий вызов получал бы ту же самую старую ошибку и никогда не пробовал снова.
    _ioPromise.catch(() => { _ioPromise = null; });
  }
  return _ioPromise;
}

// Расширенные возможности (tier advanced): id → человекочитаемое имя для ошибок.
// Каждая фича транслируется в конкретную опцию ядра ниже в normalizeOpts.
// v0.1.1: ВСЁ — opt-in. По умолчанию ничего не делаем (passthrough); каждая оптимизация
// включается своим флажком (advancedFeatures). Флажок может бандлить много правил (safe).
const ADVANCED_FEATURES = {
  safe: 'safe lossless cleanup: dedup, prune unused, weld, remove degenerate/orphan geometry',
  meshopt: 'Meshopt geometry compression',
  draco: 'Draco geometry compression (instead of Meshopt)',
  quantize: 'geometry quantization (KHR_mesh_quantization) — smaller geometry, no decoder needed',
  join: 'join meshes / flatten scene — fewer draw calls (structural, irreversible)',
  instance: 'GPU instancing (EXT_mesh_gpu_instancing) — repeated meshes as instances',
  resample: 'resample animations — drop redundant keyframes (lossless)',
  ktx2: 'textures → KTX2 (needs browser/engine support)',
  webp: 'textures → WebP (EXT_texture_webp; smaller file, video memory unchanged)',
  'strip-colors': 'removal of painted vertex colors (lossy)',
  // Четыре размера — четыре члена одной группы, а не четыре независимых флажка
  // (решение Александра 2026-08-12: «изменение размера 4к, 2к, 1к, 512 на 512»).
  // Ничего не выбрано — размер не трогается вовсе, это и есть значение по умолчанию.
  'resize-4096': 'downscale textures to 4096 px on the longer side (lossy)',
  'resize-2048': 'downscale textures to 2048 px on the longer side (lossy)',
  'resize-1024': 'downscale textures to 1024 px on the longer side (lossy)',
  'resize-512': 'downscale textures to 512 px on the longer side (lossy)',
};

/** Фича выбора размера → сам размер в пикселях. Единственное место, где это записано. */
const RESIZE_TARGETS: Record<string, number> = {
  'resize-4096': 4096,
  'resize-2048': 2048,
  'resize-1024': 1024,
  'resize-512': 512,
};

// Взаимоисключение объявляет АДДОН, а не UI: программный вызов и HTTP API могут
// передать сочетание, которое интерфейс выразить не даёт. Нормализатор сохраняет
// выбранный по прежнему правилу Draco, но передаёт движку проигравший выбор, чтобы
// тот не исчезал из отчёта. Для следующей группы достаточно добавить такую же
// декларацию — движок не знает ни GLTF, ни имён кодеков.
// ЕДИНСТВЕННОЕ объявление групп на весь проект (2026-08-04). До этого списков было
// два: `EXCLUSIVE_FEATURES` здесь и `EXCLUSIVE_GROUPS` в ui/app.js — независимые, и
// уже разъехавшиеся: здесь была пара кодеков, там пара текстур, а группа геометрии
// в интерфейсе жила третьим способом (geometryChoice). Разойдись они дальше —
// интерфейс погасил бы одну галочку, а движок выбрал другую.
//
// Теперь список один, и интерфейс читает его через API. Новая фича объявляет свою
// группу здесь один раз и получает поведение везде.
//
// `engineExplains` — кого объясняет САМ движок. Там, где причину уже называет
// правило, и называет лучше (с именем кодека или формата), движок молчит: две
// записи об одном — это толпа строк (docs/EXTENDING.md §5b).
const EXCLUSIVE_FEATURES: Record<string, ExclusiveGroupDef> = {
  geometry: {
    ruleId: 'geometry/compress',
    members: ['meshopt', 'draco', 'quantize'],
    priority: ['draco', 'meshopt', 'quantize'],
    // Пара кодеков ВЗАИМОИСКЛЮЧАЮЩАЯ и в движке тоже (Александр, 2026-08-17: «они просто
    // должны всегда быть взаимоисключающими, выбирается последний, как с галочками»).
    // Побеждает ПОСЛЕДНИЙ присланный — тем же образом, каким в интерфейсе клик по одной
    // галочке гасит соседнюю. До этого порядок аргументов игнорировался, и ['draco',
    // 'meshopt'] молча давал draco: движок переигрывал последний выбор человека.
    // Квантование в enforce НЕ входит: это третий, независимый способ, и оно объясняет
    // себя само (quantize.skipped.compressed с именем кодека).
    enforce: ['meshopt', 'draco'],
    titleKeys: { meshopt: 'feature.meshopt', draco: 'feature.draco', quantize: 'rule.geometryQuantize' },
    // Пару кодеков объяснить некому: meshopt и draco — две ветки ОДНОГО правила
    // geometry/compress, и воздержаться там нечему. Квантование объясняет себя само
    // (quantize.skipped.compressed, с именем кодека) — его сюда не берём.
    engineExplains: ['meshopt', 'draco'],
  },
  'texture-format': {
    ruleId: 'textures/webp',
    members: ['ktx2', 'webp'],
    priority: ['ktx2', 'webp'],
    // Взаимоисключающая не только в интерфейсе, но и в движке — по той же причине и тем
    // же способом, что пара кодеков: KTX2 и WebP делают с текстурами противоположное,
    // и «два процесса друг за другом» означали бы, что второй разбирает работу первого.
    // Побеждает последний присланный.
    enforce: ['ktx2', 'webp'],
    titleKeys: { ktx2: 'rule.texturesKtx2', webp: 'rule.texturesWebp' },
    // Теперь объясняет движок: проигравшее правило просто не запускается, и сказать
    // «выбран KTX2, а не WebP» больше некому.
    engineExplains: ['ktx2', 'webp'],
  },
  'texture-size': {
    ruleId: 'textures/resize',
    members: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
    // Порядок = «кто победит, если попросили несколько». Побеждает САМЫЙ КРУПНЫЙ:
    // из двух просьб выполняется та, что выбрасывает меньше пикселей. Интерфейс
    // выбрать два и не даст — это про программный вызов и HTTP, где приходит что
    // угодно, и молча выкинуть больше данных, чем просили, нельзя.
    priority: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
    titleKeys: {
      'resize-4096': 'feature.resize4096',
      'resize-2048': 'feature.resize2048',
      'resize-1024': 'feature.resize1024',
      'resize-512': 'feature.resize512',
    },
    // Объясняет движок: у отвергнутого размера своего правила нет — правило одно на
    // всю группу, и сказать «выбран 2048, а не 512» может только он.
    engineExplains: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
  },
};

/** Группы для интерфейса: [{ id, members }] — без внутренностей движка. */
export function exclusiveGroups() {
  return Object.entries(EXCLUSIVE_FEATURES).map(([id, d]) => ({ id, members: [...d.members] }));
}

/**
 * Разводит взаимоисключающие члены групп с `enforce`: победитель — ПОСЛЕДНИЙ присланный,
 * проигравшие вычёркиваются из списка фич. Возвращает очищенный список.
 *
 * Порядок здесь единственный источник правды о выборе человека, поэтому вычёркивать надо
 * ДО того, как из списка выведутся compress/codec — иначе движок посчитает флаги по
 * фиче, которую сам же и отменил.
 */
function enforceExclusives(adv: string[]): { adv: string[]; dropped: Map<string, string> } {
  const dropped = new Map<string, string>(); // проигравший → победитель
  for (const definition of Object.values(EXCLUSIVE_FEATURES)) {
    const enforce = definition.enforce;
    if (!enforce) continue;
    const asked = adv.filter((feature) => enforce.includes(feature));
    if (asked.length < 2) continue;
    const winner = asked[asked.length - 1]!;
    for (const loser of asked.slice(0, -1)) dropped.set(loser, winner);
  }
  return { adv: adv.filter((feature) => !dropped.has(feature)), dropped };
}

// Список приходит УПОРЯДОЧЕННЫМ, а не множеством: для групп с enforce победитель — тот,
// кого выбрали последним, и без порядка его не определить (Set это знание терял).
function exclusiveConflicts(requested: string[]): ExclusiveConflict[] {
  const conflicts: ExclusiveConflict[] = [];
  const asked = (feature: string) => requested.includes(feature);
  for (const [group, definition] of Object.entries(EXCLUSIVE_FEATURES)) {
    // У групп с enforce победителя выбирает тот же закон, что и в enforceExclusives —
    // последний присланный. Спрашивать здесь priority значило бы назвать в отчёте не того.
    const selected = definition.enforce
      ? requested.filter((feature) => definition.enforce!.includes(feature)).pop()
      : definition.priority.find(asked);
    if (!selected) continue;
    const explains = definition.engineExplains || definition.members;
    const rejected = definition.members
      .filter((feature) => feature !== selected && asked(feature))
      .filter((feature) => explains.includes(feature));
    if (!rejected.length) continue;
    conflicts.push({
      group,
      ruleId: definition.ruleId,
      selected: { feature: selected, titleKey: definition.titleKeys[selected]! },
      rejected: rejected.map((feature) => ({ feature, titleKey: definition.titleKeys[feature]! })),
    });
  }
  return conflicts;
}

// Значения по умолчанию — ровно как у CLI без флагов (контракт §4b): ТОЛЬКО базовые
// оптимизации, расширения — через advancedFeatures. Неизвестная фича → Error
// (optimizeFile превратит его в status:'fail', а не молча проигнорирует).
function normalizeOpts(opts: RawOpts = {}): GltfOpts {
  const adv = [...new Set(((opts.advancedFeatures as unknown[]) || []).map(String))];
  const unknown = adv.filter((f) => !(f in ADVANCED_FEATURES));
  if (unknown.length) {
    throw new Error(`Unknown advancedFeatures: ${unknown.join(', ')}. Available: ${Object.keys(ADVANCED_FEATURES).join(', ')}.`);
  }
  const allMembers = Object.values(EXCLUSIVE_FEATURES).flatMap((d) => d.members);
  // Что человек ВЫБРАЛ, по порядку выбора. Legacy-поля дописываются сюда же: конфликт
  // между codec:'draco' и явным meshopt — такой же выбор, и прятать его нельзя.
  const requestedCodecs = adv.filter((feature) => allMembers.includes(feature));
  if (opts.codec === 'draco' && !requestedCodecs.includes('draco')) requestedCodecs.push('draco');
  // `compress: true` — НЕ выбор кодека, а общий выключатель «сжимать геометрию».
  // Дописывать его как выбор meshopt можно только когда кодек не назван вовсе: иначе
  // он оказывался последним в списке и по закону «побеждает последний» отменял ЯВНО
  // запрошенный draco, а отчёт называл победителем meshopt, которого человек не выбирал
  // (найдено ревью 2026-08-18: `{compress:true, advancedFeatures:['draco']}` давал
  // meshopt, хотя до этого коммита давал draco).
  const codecAsked = EXCLUSIVE_FEATURES.geometry!.enforce!;
  if (opts.compress && opts.codec !== 'draco' && !requestedCodecs.some((f) => codecAsked.includes(f))) {
    requestedCodecs.push('meshopt');
  }

  // Взаимоисключающие пары разводятся ОДИН раз и ДО вывода флагов: иначе compress/codec
  // считались бы по фиче, которую движок сам же и отменил.
  const conflicts = exclusiveConflicts(requestedCodecs);
  const { dropped } = enforceExclusives(requestedCodecs);
  const kept = adv.filter((feature) => !dropped.has(feature));

  // Качество WebP: значением считается ТОЛЬКО число либо непустая строка с числом.
  // Всё прочее (null, '', false, [], объект) — это «не задавали», а не ноль. Ловушка
  // одна и та же на весь список: `Number(null)`, `Number('')`, `Number(false)` и
  // `Number([])` дают 0, то есть «сжать до предела», — самое разрушительное положение
  // ползунка молча получалось из пустого значения. Числовой мусор ('abc' → NaN) сюда
  // проходит намеренно: диапазон и откат к умолчанию держит правило (webpShare).
  const rawQuality = opts.webpQuality;
  const webpQuality = (typeof rawQuality === 'number'
    || (typeof rawQuality === 'string' && rawQuality.trim() !== ''))
    ? Number(rawQuality)
    : undefined;

  // Компрессия геометрии — opt-in: флажок 'meshopt' или 'draco' (либо legacy codec/compress).
  // Legacy-поля проходят через тот же фильтр: проигравший кодек не влияет на выбор,
  // каким бы способом его ни попросили.
  const draco = kept.includes('draco') || (opts.codec === 'draco' && !dropped.has('draco'));
  const compress = draco || kept.includes('meshopt') || (!!opts.compress && !dropped.has('meshopt'));

  return {
    advancedFeatures: kept,
    exclusiveConflicts: conflicts,
    // opt-in-флаги: по умолчанию всё выключено (passthrough).
    safe: kept.includes('safe') || !!opts.safe, // безопасная чистка (бандл)
    compress, // сжимать ли геометрию вообще
    codec: draco ? 'draco' : 'meshopt', // какой кодек — если compress включён
    // Квантование — третий способ сжать геометрию, единственный без декодера. Одна
    // группа с Draco/Meshopt в интерфейсе, но движок не отменяет чужой выбор молча:
    // если попросили и то и другое, правило само скажет, что поверх сжатия квантовать
    // нечего (та же логика, что у пары KTX2/WebP).
    quantize: adv.includes('quantize') || !!opts.quantize,
    join: (adv.includes('join') || !!opts.join) && !opts.keepParts, // склейка мешей — отдельный флажок
    instance: adv.includes('instance') || !!opts.instance, // GPU-инстансинг (нужен декодер на сайте)
    resample: adv.includes('resample') || !!opts.resample, // чистка кадров анимации (без потерь)
    // KTX2-режим: UASTC по умолчанию (самый безопасный/качественный для новичков);
    // ETC1S (максимальное сжатие) — texMode:'mixed' (ETC1S цвет + UASTC data-карты).
    texMode: opts.texMode === 'mixed' ? 'mixed' : 'uastc',
    keepParts: !!opts.keepParts,
    // KTX2 по умолчанию ВЫКЛЮЧЕН (advanced). Приоритет: фича 'ktx2' > явный boolean noKtx
    // (legacy) > default true.
    noKtx: kept.includes('ktx2') ? false : (typeof opts.noKtx === 'boolean' ? opts.noKtx : true),
    // WebP — тоже opt-in и тоже про текстуры, но противоположный KTX2 по смыслу
    // (меньше файл против меньше видеопамяти). Пара взаимоисключающая и в движке
    // (enforce), поэтому читаем из ОЧИЩЕННОГО списка: если пришли обе, здесь останется
    // только последняя выбранная, а про отменённую отчёт скажет вслух.
    noWebp: kept.includes('webp') ? false : (typeof opts.noWebp === 'boolean' ? opts.noWebp : true),
    // Качество WebP — доля от качества ИСХОДНИКА, 0…100. Умолчание и проверку диапазона
    // держит само правило (WEBP_QUALITY_DEFAULT в rules.mts): значение приходит и из
    // интерфейса, и из чужого вызова по API, и одно место на оба входа надёжнее двух.
    // Здесь только отделяем «задали» от «не задавали» (см. rawQuality выше).
    webpQuality,
    stripColors: !!opts.stripColors || adv.includes('strip-colors'),
    // Ноль — «не уменьшать», и это значение по умолчанию. Из нескольких просьб берётся
    // самая крупная цель (см. приоритет группы texture-size): выбросить больше пикселей,
    // чем попросили, нельзя. Число, пришедшее прямым полем opts.maxTextureSize, обязано
    // быть одним из четырёх — произвольный размер это уже другая функция, и молча
    // принимать его значило бы обещать то, чего в интерфейсе нет.
    maxTextureSize: (() => {
      const chosen = ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512']
        .find((f) => adv.includes(f));
      if (chosen) return RESIZE_TARGETS[chosen]!;
      const direct = Number(opts.maxTextureSize);
      return Object.values(RESIZE_TARGETS).includes(direct) ? direct : 0;
    })(),
    dryRun: !!opts.dryRun,
    // §4b: opts.locale можно добавлять свободно (default 'en'). Неизвестная локаль
    // всплывёт ошибкой рендера при первом сообщении (→ status:'fail'), а не пустой строкой.
    locale: typeof opts.locale === 'string' ? opts.locale : 'en',
    outDir: path.resolve(String(opts.outDir || 'output')),
    force: !!opts.force,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress as GltfOpts['onProgress'] : null,
    // аддитивная опция (не в контракте, разрешено правилами стабильности): приёмник
    // строк хода работы. По умолчанию тишина; CLI передаёт console.log.
    log: typeof opts.log === 'function' ? opts.log as GltfOpts['log'] : () => {},
  };
}

// Список СОБИРАЕТСЯ из IMPORT_FORMATS, а не переписан руками. Это ПЯТАЯ копия того же
// перечня, и она уже разошлась: 2026-08-22 сюда забыли дописать fbx, и файл выходил с
// именем «модель.fbx», внутри которого лежал двоичный glTF. Сторож в
// tests/import-stl-ply.test.mjs стерёг четыре места; это было пятым и незамеченным.
const OUTPUT_RENAME = new RegExp(`\\.(gltf|${IMPORT_FORMATS.join('|')})$`, 'i');

function outputName(src: string): string {
  // Выход у нас всегда glTF, каким бы ни был вход: `.gltf` и `.stl` одинаково становятся
  // `.glb`. Без чужих расширений здесь `модель.stl` дала бы файл `модель.stl` с двоичным
  // glTF внутри — имя, которое врёт про содержимое.
  return path.basename(src).replace(OUTPUT_RENAME, '.glb');
}

// ---------------------------------------------------------------------------
// Расширения, которых библиотека не знает, обязаны пережить проход через нас
// ---------------------------------------------------------------------------
//
// Дефект (TESTBUG-010, найден 2026-08-14). gltf-transform при загрузке выбрасывает
// расширение, которого не знает, и записывает документ уже без него. Наши правила тут
// ни при чём: структурные правила на таких моделях честно отказываются работать, а
// потеря происходит в самом цикле чтение→запись. Проверено на passthrough: ноль
// применённых правил — расширение всё равно исчезает.
//
// Чем это плохо на деле, на образце Khronos PotOfCoalsAnimationPointer:
//   до     target = { extensions: { KHR_animation_pointer: { pointer: "/materials/2/…" } },
//                     path: "pointer" }
//   после  target = { path: "pointer" }
// Канал по-прежнему говорит «анимирую указатель», но больше не говорит ЧТО. Валидатор
// Khronos меняет вердикт с INCOMPLETE_EXTENSION_SUPPORT на VALUE_NOT_IN_LIST.
//
// Расширения держатся на НОМЕРАХ объектов, и приклеить такое расширение к ЧУЖОМУ
// объекту хуже, чем потерять его: получится файл, который выглядит целым и врёт. Поэтому
// возврат не безусловный — сверяется, не сдвинулась ли нумерация.
//
// Первая версия (2026-08-14) сверяла ВЕСЬ документ сразу и чинила только passthrough.
// Этого оказалось мало: слово Александра 2026-08-15 — «анимация текстур не должна
// пропадать и должна показываться в обоих вьюпортах». Общая сверка отказывала ровно
// там, где отказывать было не за что: сварка вершин добавляла треугольнику индексы, и
// указатель на МАТЕРИАЛ пропадал, хотя материалы не шелохнулись.
//
// Теперь сверка не общая, а по предмету: расширение само называет свои цели, и
// проверяется только тот массив, на который оно смотрит (см. arraysAddressedBy).
// Расширение, которое адресов не называет, осталось под полной сверкой — строгость
// не ослаблена, она направлена. TESTBUG-011.

// Типы `Carried`/`CarriedSpot` и сам реестр — в addons/gltf/carried.mts. Вынесены туда
// 2026-08-15: правило KTX2 подменяет документ (круг через временный файл под внешнюю
// утилиту), и ему надо перенести реестр за собой, не импортируя этот файл — обратный
// импорт замкнул бы круг.

// Массивы, по длинам которых видно, сдвинулась ли структура.
//
// `bufferViews` и `buffers` в список НЕ входят намеренно: их перепаковывает сам
// сериализатор, и на passthrough они меняются законно (26 → 15 на образце
// PotOfCoalsAnimationPointer). Расширения адресуют логические объекты — материалы,
// узлы, анимации, — а не куски буфера, поэтому их перенумерация ссылки не рвёт.
// Первая версия отпечатка включала их и отказывалась чинить ровно там, где надо.
const SHAPE_ARRAYS = [
  'scenes', 'nodes', 'meshes', 'materials', 'accessors',
  'textures', 'images', 'samplers', 'skins', 'animations', 'cameras',
];

/** Одно место в документе, где висело незнакомое расширение. */
interface CarriedSpot {
  /** Путь до объекта-владельца, например ['animations', 0, 'channels', 1, 'target']. */
  path: Array<string | number>;
  name: string;
  value: unknown;
}

interface Carried {
  used: string[];
  required: string[];
  spots: CarriedSpot[];
  /** Длины логических массивов ИСХОДНИКА: 'materials' → 12. */
  shape: Record<string, number>;
}

const shapeOf = (json: Record<string, unknown>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of SHAPE_ARRAYS) out[k] = Array.isArray(json[k]) ? (json[k] as unknown[]).length : -1;
  return out;
};

// Куда именно смотрит расширение — по его собственному тексту.
//
// Зачем. Сверять СРАЗУ ВСЕ массивы — грубо: сварка вершин добавляет один аксессор, и
// проверка отказывалась возвращать указатель на материал, которому эта сварка ничем не
// мешала. Расширение теряло адрес и анимация пропадала на ровном месте.
//
// `KHR_animation_pointer` называет цель прямо: `/materials/0/pbrMetallicRoughness/
// baseColorFactor`. Первый сегмент такого адреса — имя массива, и достаточно убедиться,
// что НЕ СДВИНУЛСЯ ОН. Проверено по трём моделям: `Animated Pointer 01` — 1 адрес,
// `PotOfCoalsAnimationPointer` — 2, `AnimationPointerUVs` — 103, и все до единого
// указывают в `materials`.
//
// Расширение без адресов-строк (`MSFT_lod` перечисляет узлы числами, `KHR_interactivity`
// хранит граф) остаётся под ПОЛНОЙ проверкой: мы не знаем, на что оно смотрит, и гадать
// не будем. То есть строгость не ослаблена — она направлена.
const POINTER_RE = /^\/([A-Za-z_][A-Za-z_0-9]*)\/\d/;

function arraysAddressedBy(value: unknown): Set<string> | null {
  const names = new Set<string>();
  let sawString = false;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('/')) {
        sawString = true;
        const m = POINTER_RE.exec(v);
        if (m && m[1]) names.add(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  // Адресов не нашли — значит расширение адресует как-то иначе, и сузить проверку не на
  // чем. `null` читается вызывающим как «сверяй всё».
  return sawString && names.size ? names : null;
}

// Чтение JSON-части исходника переехало в addons/gltf/source-json.mts: спрашивающих
// трое, а читателей до 2026-08-22 было тоже трое, и каждый читал по-своему. Здесь
// осталось только имя, под которым его знает остальной файл.
const sourceJson = readSourceJson;

/** Обойти документ и собрать всё, что относится к незнакомым расширениям. */
function collectCarried(json: Record<string, unknown>): Carried | null {
  const known = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));
  const used = ((json.extensionsUsed as string[]) || []).filter((n) => !known.has(n));
  if (!used.length) return null;
  const unknown = new Set(used);
  const required = ((json.extensionsRequired as string[]) || []).filter((n) => unknown.has(n));

  const spots: CarriedSpot[] = [];
  const walk = (value: unknown, at: Array<string | number>) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...at, i]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    const ext = obj.extensions;
    if (ext && typeof ext === 'object') {
      for (const [name, payload] of Object.entries(ext as Record<string, unknown>)) {
        if (unknown.has(name)) spots.push({ path: at, name, value: payload });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'extensions') walk(v, [...at, k]);
    }
  };
  // Корень обходим сам, но его собственные `extensions` тоже учитываем — расширение
  // уровня документа (KHR_interactivity, KHR_lights_punctual) живёт именно там.
  walk(json, []);

  return { used, required, spots, shape: shapeOf(json) };
}

/** Общая механика правки JSON-чанка GLB: разобрать → поправить → пересобрать.
 *
 * restoreCarried и dropEmptyArrays правят СЕРИАЛИЗОВАННЫЙ JSON-чанк, а не документ, и обе
 * пересобирают контейнер с выравниванием JSON-чанка пробелами до кратности четырём
 * (спецификация §4.4). Раньше каждая делала это сама — и один и тот же JSON гонялся через
 * parse→rebuild дважды за запись. Теперь контейнер разбирается и собирается здесь один
 * раз, а правки получают уже разобранный объект.
 *
 * patch(json, hasBinChunk) возвращает false, когда правки ничего не изменили, — тогда
 * возвращается исходный массив без пересборки. Не GLB, не JSON-чанк или нечитаемый JSON —
 * тоже возвращается как есть. Бинарный чанк (если он есть) переносится без изменений.
 */
function withGlbJson(
  glb: Uint8Array,
  patch: (json: GltfJson, hasBinChunk: boolean) => boolean,
): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  // GLB (спецификация §4.4): заголовок 12 байт, дальше чанки. Первый — JSON.
  if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return glb;
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) return glb; // не JSON-чанк — не трогаем
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  } catch {
    return glb;
  }

  const rest = glb.subarray(20 + jsonLen);
  if (!patch(json, rest.length > 0)) return glb;

  // Пересобираем контейнер. JSON-чанк выравнивается пробелами до кратности четырём —
  // требование спецификации; без выравнивания следующий чанк начнётся не там.
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(0x20);
  padded.set(encoded);

  const out = new Uint8Array(12 + 8 + padded.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, padded.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  out.set(rest, 20 + padded.length);
  return out;
}

/** Вернуть собранное в разобранный JSON-чанк, если структура не сдвинулась. */
function restoreCarried(json: Record<string, unknown>, carried: Carried | undefined): boolean {
  if (!carried) return false;

  // Сдвинулась ли структура — теперь вопрос НЕ ко всему документу сразу, а к тем
  // массивам, на которые смотрит конкретное расширение (см. arraysAddressedBy).
  //
  // Прежняя, общая сверка отказывалась чинить ровно там, где чинить было безопасно.
  // Два замера: сварка вершин добавляет один аксессор — и указатель на материал
  // пропадал, хотя материалы не шелохнулись; сериализатор схлопывает одинаковые
  // текстуры и сэмплеры (на AnimationPointerUVs — 61 → 13 и 61 → 1) — и 103 указателя,
  // все до одного адресующие материалы, терялись из-за чужой перенумерации.
  //
  // Приклеить расширение к ЧУЖОМУ объекту по-прежнему хуже, чем потерять его: файл
  // выглядел бы целым и врал. Поэтому сверка не отменена, а сужена до предмета.
  const after = shapeOf(json);
  const intact = (names: Set<string> | null) => {
    const keys = names ? [...names] : SHAPE_ARRAYS;
    return keys.every((k) => !(k in carried.shape) || carried.shape[k] === after[k]);
  };

  const resolve = (at: Array<string | number>): Record<string, unknown> | null => {
    let cur: unknown = json;
    for (const step of at) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = (cur as Record<string | number, unknown>)[step];
    }
    return cur && typeof cur === 'object' && !Array.isArray(cur)
      ? cur as Record<string, unknown>
      : null;
  };

  // Решение принимается ПООБЪЕКТНО, а не одно на весь файл. Раньше один сдвинувшийся
  // массив отменял возврат всего — включая то, что этого массива не касалось.
  let touched = false;
  let refused = 0;
  for (const spot of carried.spots) {
    if (!intact(arraysAddressedBy(spot.value))) { refused++; continue; }
    const owner = resolve(spot.path);
    if (!owner) continue;
    const bag = (owner.extensions ||= {}) as Record<string, unknown>;
    if (!(spot.name in bag)) { bag[spot.name] = spot.value; touched = true; }
  }
  if (refused) {
    // Поток событий для разбора, а не итог для человека (правило 9). По-английски —
    // правило 8 запрещает кириллицу в коде движка, и статический гейт это сторожит:
    // русская фраза здесь падала как «готовая пользовательская строка».
    console.warn(`[gltf] carried extensions not restored: ${refused} (addressed arrays shifted)`);
  }

  // Объявление без содержимого — тоже потеря. Файл мог объявить расширение и не
  // воспользоваться им ни разу; passthrough обещает вернуть файл как был, а не «как
  // было бы разумно». Поэтому смотрим и на сам список, а не только на находки выше.
  const declared = Array.isArray(json.extensionsUsed) ? json.extensionsUsed as string[] : [];
  if (carried.used.some((n) => !declared.includes(n))) touched = true;

  if (!touched) return false;

  const addNames = (key: 'extensionsUsed' | 'extensionsRequired', names: string[]) => {
    if (!names.length) return;
    const list = Array.isArray(json[key]) ? json[key] as string[] : (json[key] = [] as string[]);
    for (const n of names) if (!list.includes(n)) list.push(n);
    (list as string[]).sort();
  };
  addNames('extensionsUsed', carried.used);
  addNames('extensionsRequired', carried.required);
  return true;
}

// Что снято с ЭТОГО документа. WeakMap, а не поле: документ принадлежит библиотеке, и
// дописывать в него своё — значит зависеть от её внутренностей.


// Ничего снимать при загрузке больше НЕ НУЖНО. Раньше здесь собирались чужие расширения
// и клались в реестр по объекту документа — и терялись, как только правило подменяло
// документ (KTX2, круг через временный файл). Теперь ответ берётся из исходного файла в
// момент записи, и промежуточные состояния на него не влияют. См. writeBytes.
const load = (io: NodeIOType, src: string) => (
  isImportFormat(src) ? importForeign(src) : readOrExplain(io, src)
);

const readBytes = (io: NodeIOType, bytes: Uint8Array) => io.readBinary(bytes);

// Вырожденные записи, которые пишет сериализатор: пустые массивы и пустой буфер.
//
// Спецификация glTF 2.0 требует, чтобы массив, если он есть, был непустым — валидатор
// Khronos отвечает на это ошибкой EMPTY_ENTITY. А gltf-transform 4.4.2 пишет пустой
// массив всегда, даже когда детей у сцены не осталось (проверено напрямую: документ с
// одной сценой без детей → `{"name":"Scene","nodes":[]}`).
//
// Дойти до этого можно так: модель без геометрии (например одни текстуры), человек
// ставит «объединить меши», внутренняя чистка убирает единственный пустой узел — и
// сцена остаётся ни с чем. Найдено 2026-08-10 сетью проверок по валидатору
// (tests/validator-net.test.mjs): join добавлял EMPTY_ENTITY на четырёх моделях корпуса.
//
// Убираем ключ, а не выдумываем узел: сцена без поля `nodes` — законная пустая сцена,
// и рисуется она ровно так же, то есть никак. Правилом это не сделать: пустой массив
// существует только в сериализованном виде, в документе его нет.
function dropEmptyArrays(json: GltfJson, hasBinChunk: boolean): boolean {
  let touched = false;
  for (const scene of json.scenes || []) {
    if (Array.isArray(scene.nodes) && scene.nodes.length === 0) { delete scene.nodes; touched = true; }
  }
  for (const node of json.nodes || []) {
    if (Array.isArray(node.children) && node.children.length === 0) { delete node.children; touched = true; }
  }

  // Буфер без единого байта. Та же болезнь этажом ниже: у модели не осталось двоичных
  // данных, а запись о буфере пишется всё равно — `"buffers": [{}]`, без обязательного
  // byteLength. Валидатор отвечает UNDEFINED_PROPERTY.
  //
  // Убираем только когда убирать заведомо нечего: двоичного чанка в файле нет вовсе и
  // ни одна запись буфера ни на что не ссылается. Иначе легко снести буфер, на который
  // смотрит геометрия, — а это уже не чистка отчёта, а порча модели.
  const noBinChunk = !hasBinChunk;
  const noViews = !Array.isArray(json.bufferViews) || json.bufferViews.length === 0;
  const allBuffersEmpty = Array.isArray(json.buffers)
    && json.buffers.length > 0
    && json.buffers.every((b: unknown) => b && typeof b === 'object' && Object.keys(b).length === 0);
  if (noBinChunk && noViews && allBuffersEmpty) { delete json.buffers; touched = true; }

  return touched;
}

/**
 * Записать документ в байты — и вернуть в них всё, что снял с ИСХОДНОГО ФАЙЛА.
 *
 * ПРАВИЛО (Александр, 2026-08-15): «брать за основу только первоначальный файл и
 * последний всегда проверять с самым первым, а не с промежуточными нашими».
 *
 * Поэтому третий довод здесь — `src`, путь к исходнику, а не какое-нибудь состояние,
 * накопленное по дороге. Что вернуть, вычисляется ЗАНОВО из файла на диске в момент
 * записи. Промежуточный документ на этот ответ не влияет никак.
 *
 * Чем это лучше прежнего. Раньше снятое лежало в реестре, привязанном к объекту
 * документа. Правило KTX2 перекодирует картинки внешней утилитой и ради этого делает
 * круг через временный файл — документ после него ДРУГОЙ ОБЪЕКТ, в реестре его нет, и
 * возвращать оказывалось нечего: анимация по указателю исчезала ровно на одной галочке
 * из десяти (TESTBUG-012). Теперь такой класс поломки невозможен: сколько бы раз
 * документ ни подменяли, источник ответа — тот же файл, что человек положил на вход.
 *
 * Цена — повторное чтение JSON-чанка исходника. Не всего файла: `sourceJson` читает у
 * GLB заголовок и ровно один чанк, поэтому на модели в 600 МБ это по-прежнему
 * килобайты (см. её же комментарий).
 */
const writeBytes = async (io: NodeIOType, doc: Document, src?: string) => {
  const bytes = await io.writeBinary(doc);
  const json = src ? sourceJson(src) : null;
  const carried = (json && collectCarried(json)) || undefined;
  // Один проход по JSON-чанку на обе правки: раньше каждая сама разбирала и
  // пересобирала контейнер, и один и тот же JSON гонялся через parse→rebuild дважды.
  return withGlbJson(bytes, (out, hasBinChunk) => {
    const restored = restoreCarried(out, carried);
    const dropped = dropEmptyArrays(out, hasBinChunk);
    return restored || dropped;
  });
};

// Входное сжатие геометрии (Draco/Meshopt) снимаем сразу после загрузки — иначе каждая
// запись молча пережимает геометрию заново (ARCHITECTURE.md §6). Возвращаем имена снятых
// кодеков — движок отражает их в отчёте (engine/input-compression).
function stripInputCompression(doc: Document): string[] {
  const stripped = [];
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression' || ext.extensionName === 'EXT_meshopt_compression') {
      stripped.push(ext.extensionName);
      ext.dispose();
    }
  }
  return stripped;
}

// -------- ФАЗА 4 · валидация всего ассета (специфична для glTF) --------
// Наполняет result.validation в порядке отчёта; baseline-checkpoint (2b) считает движок
// (compareBaseline). При level:'fail' статус прогона становится 'fail', но .glb всё
// равно ЗАПИСЫВАЕТСЯ (решение Александра 2026-07-30: отказ громкий, а не запирающий —
// человек должен иметь возможность посмотреть, насколько всё плохо). Здесь до
// 2026-08-10 стояло обратное утверждение — комментарий отстал от кода на полтора
// месяца и был найден ревью (P1.4).
async function validate({ ctx, before, after, glbBytes, src, result, advancedPlannedIds, addFound, log }: GltfValidateArgs): Promise<void> {
  const v = result.validation;
  // vp — обёртка для записей валидации. Принимает messageId + data и кладёт в запись
  // не только готовую строку, но и рецепт (поле i18n) — по нему localizeResult() соберёт
  // её заново на другом языке. Без рецепта строки проверки застревали на языке сборки,
  // а именно их интерфейс показывает у кнопки выгрузки — то есть в самом важном месте.
  const locale = ctx.opts.locale;
  const vp = (level: 'pass' | 'info' | 'fail', messageId: string, data: Record<string, unknown> = {}) => v.push({
    level,
    text: render(messageId, data, locale),
    i18n: { text: { messageId, data } },
  });

  // материалы резолвятся: ни один примитив не ссылается на удалённый материал
  let materialsOk = true;
  for (const mesh of ctx.document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat && typeof mat.isDisposed === 'function' && mat.isDisposed()) materialsOk = false;
    }
  }

  // 1. геометрия на месте
  if (before.triangles === 0) vp('info', 'check.geometryEmpty');
  else if (after.triangles > 0) vp('pass', 'check.geometryPresent');
  else vp('fail', 'check.geometryBroken');
  // 2. треугольники не изменились (кроме вырожденных); окно отсчёта — как в v2 (до weld)
  // Кэш общий для всех правил, значения в нём нетипизированы — сужаем на месте.
  const trianglesBase = (ctx.cache.get('trianglesBeforeWeld') as number | undefined) ?? before.triangles;
  const degenerateRemoved = (ctx.cache.get('degenerateRemoved') as number | undefined) ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) vp('pass', 'check.trianglesUnchanged');
  else if (triangleDelta === degenerateRemoved) vp('info', 'check.trianglesDropped', { n: triangleDelta });
  else vp('fail', 'check.trianglesMismatch', { expected: trianglesBase - degenerateRemoved, got: after.triangles });
  // 2b. BASELINE-CHECKPOINT — строгая сверка структуры со снимком после базового прохода (движок)
  for (const line of compareBaseline(ctx.baselineMetrics!, after, BASELINE_METRICS, { advancedPlannedIds, log, soft: BASELINE_SOFT })) {
    // compareBaseline возвращает { level, messageId, data } — рендерим через vp
    vp(line.level, line.messageId, line.data);
  }
  // 3-5. анимации, скины, сцены
  if (before.animations === after.animations) vp('pass', 'check.animationsPreserved', { n: after.animations });
  else vp('fail', 'check.animationsLost', { before: before.animations, after: after.animations });
  if (before.skins === after.skins) vp('pass', 'check.skinsPreserved', { n: after.skins });
  else vp('fail', 'check.skinsLost', { before: before.skins, after: after.skins });
  if (before.scenes === after.scenes) vp('pass', 'check.scenesPreserved', { n: after.scenes });
  else vp('fail', 'check.scenesLost', { before: before.scenes, after: after.scenes });
  // 6. bounding box в пределах эпсилон (квантование кодека даёт микросдвиг — допуск 1% диагонали)
  //
  // Сначала отдельный случай: у модели БЕЗ геометрии габаритов не существует.
  // getBounds() отдаёт для неё min = +Infinity, max = −Infinity, разность даёт NaN,
  // а любое сравнение с NaN ложно — и проверка объявляла «модель смещена или
  // разрушена» на сцене из пустых узлов, которую никто не трогал. Найдено 2026-08-04
  // на `Empty Nodes 01` при закрытии дыры корпуса «модель без геометрии».
  const noGeometry = before.triangles === 0 && after.triangles === 0;
  if (noGeometry) {
    vp('info', 'check.boundsNoGeometry');
  } else if (before.bounds && after.bounds) {
    // `!` вместо локальных переменных: проверка на непустоту стоит строкой выше, но
    // внутри стрелки компилятор о ней уже не помнит. Заводить локальные копии значило бы
    // менять собранный код — приведения из него исчезают без следа.
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds!.max[i]! - before.bounds!.min[i]!));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds!.min[i]! - after.bounds!.min[i]!) <= eps && Math.abs(before.bounds!.max[i]! - after.bounds!.max[i]!) <= eps);
    if (ok) vp('pass', 'check.boundsUnchanged');
    // @gltf-transform/core getBounds() не умеет EXT_mesh_gpu_instancing (не учитывает
    // per-instance трансформы) — после реального инстансинга даёт заведомо неверные
    // числа, хотя рендер не меняется. Не блокируем запись в этом единственном известном
    // случае — только информируем; иначе (без инстансинга) расхождение остаётся fail.
    else if (result.applied.some((a: { ruleId: string }) => a.ruleId === 'scene/instance')) {
      vp('info', 'check.boundsSkippedAfterInstance');
    // Второй случай, где инструмент меряет не то. У скинованной модели трансформация узла
    // по спецификации glTF ИГНОРИРУЕТСЯ — форму задают матрицы скина (inverseBindMatrices).
    // Квантование это учитывает и вносит компенсацию именно в IBM (проверено на parkergirl:
    // узел остаётся scale [1,1,1], а IBM меняется 1 → 0.8099). getBounds() читает POSITION и
    // трансформации узлов, до IBM не добирается — и после квантования показывает
    // непозированную геометрию, а не то, что увидит зритель.
    //
    // Условие узкое: только когда скины есть И геометрия действительно квантована. Модель
    // без скинов и модель без квантования по-прежнему обязаны сойтись по bbox.
    } else if (after.skins > 0 && ctx.document.getRoot().listExtensionsUsed()
      .some((e: { extensionName: string }) => e.extensionName === 'KHR_mesh_quantization')) {
      vp('info', 'check.boundsSkinnedQuantized');
    } else vp('fail', 'check.boundsChanged');
  } else {
    vp('info', 'check.boundsNotComputed');
  }
  // 7. материалы
  if (materialsOk) vp('pass', 'check.materialsResolve');
  else vp('fail', 'check.materialsBroken');
  // 8. gltf-validator (Khronos)
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glbBytes));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      vp('pass', 'check.validatorZeroErrors');
    } else {
      // вход мог быть битым изначально — проверяем исходник и блокируем только НОВЫЕ ошибки
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      // Рецепт, а не готовая строка: иначе запись не переживает смену языка —
      // движок разворачивает { messageId, data } сам.
      if (inErrs > 0) addFound(ENGINE_META.inputValidation!, { messageId: 'engine.inputValidation.found', data: { n: inErrs } });
      if (errs <= inErrs) {
        vp('info', 'check.validatorErrorsRemain', { errs, inErrs });
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          vp('info', 'check.validatorExample', { code: m.code, pointer: m.pointer || '—' });
        }
      } else {
        vp('fail', 'check.validatorErrorsIncreased', { errs, inErrs });
      }
    }
  } catch {
    vp('info', 'check.validatorSkipped');
  }
}

// -------- ФАЗА 5 · отчёт (централизованно из данных RunResult, специфичен для glTF) --------
function diffLine(label: string, before: number, after: number, fmt: (v: number) => string | number = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

// уровень → префикс строки валидации в md (разбор обратно: level хранится в RunResult)
const LEVEL_PREFIX: Record<string, string> = { pass: '✅', info: 'ℹ', fail: '❌' };

function writeReport({ name, result, before, after, assetWritten, opts }: GltfReportArgs): string {
  const report = result;
  const flags = (opts.keepParts ? ' · no join' : '')
    + (opts.noKtx ? ' · no KTX2' : ` · textures: ${opts.texMode}`)
    + (opts.stripColors ? ' · strip-vertex-colors' : '')
    + (opts.dryRun ? ' · **DRY-RUN**' : '');
  // Рамка отчёта — заголовки, подписи таблицы, примечания — берётся по ключу, как
  // и всё остальное (docs/ARCHITECTURE.md §4b). До 2026-08-04 она была зашита по-английски: тело
  // записей переводилось вслед за интерфейсом, а заголовки над ним оставались
  // английскими, и русский человек скачивал отчёт наполовину на чужом языке.
  const t = (key: string, data: Record<string, unknown> = {}) => render(key, data, opts.locale);
  const lines = [
    `# ${t('report.title', { name })}`,
    '',
    t('report.meta', { date: new Date().toISOString().slice(0, 10), codec: opts.codec, tier: AUTOFIX_MAX_TIER, flags }),
    '',
    `## ${t('report.section.found')}`,
    '',
    ...(report.findings.length ? report.findings.map((f: { text: string }) => `- ✓ ${f.text}`) : [`- ${t('report.found.none')}`]),
    '',
    `## ${t('report.section.skipped')}`,
    '',
    ...(report.skipped.length ? report.skipped.map((s: { text: string }) => `- ${s.text}`) : [`- ${t('report.none')}`]),
    '',
    `## ${t('report.section.applied')}`,
    '',
    ...(report.applied.length ? report.applied.map((a: { text: string }) => `- ${a.text}`) : [`- ${t('report.none')}`]),
    '',
    `## ${t('report.section.validation')}`,
    '',
    ...report.validation.map((s: { level: string; text: string }) => `- ${LEVEL_PREFIX[s.level]} ${s.text}`),
    ...(assetWritten ? [] : [
      '',
      opts.dryRun ? t('report.dryRun') : t('report.notWritten'),
    ]),
    '',
    `## ${t('report.section.improvements')}`,
    '',
    `| ${t('report.col.metric')} | ${t('report.col.before')} | ${t('report.col.after')} |`,
    '|---|---|---|',
    diffLine(t('report.metric.file'), before.fileBytes, after.fileBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.gpuBytes'), before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.textureBytes'), before.textureBytes, after.textureBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.drawCalls'), before.drawCalls, after.drawCalls),
    diffLine(t('report.metric.triangles'), before.triangles, after.triangles),
    diffLine(t('report.metric.vertices'), before.vertices, after.vertices),
    // Хранимые вершины стоят рядом с рисуемыми намеренно: расхождение между ними и
    // есть ответ на вопрос «почему файл потяжелел, а рисуется столько же» (§5b).
    diffLine(t('report.metric.verticesStored'), before.verticesStored, after.verticesStored),
    diffLine(t('report.metric.meshes'), before.meshes, after.meshes),
    diffLine(t('report.metric.materials'), before.materials, after.materials),
    diffLine(t('report.metric.textures'), before.textures, after.textures),
    diffLine(t('report.metric.nodes'), before.nodes, after.nodes),
    '',
  ];
  // dry-run пишет отчёт под отдельным именем, чтобы не затирать отчёт реального прогона
  const reportName = name.replace(/\.(glb|gltf)$/i, opts.dryRun ? '.dryrun.report.md' : '.report.md');
  fs.writeFileSync(path.join(opts.outDir, reportName), lines.join('\n'), 'utf8');
  return reportName;
}

// -------- Слепые зоны Khronos-валидатора --------
// Валидатор не умеет часть расширений и честно сообщает об этом (UNSUPPORTED_EXTENSION).
// Побочный эффект: ссылки, лежащие ВНУТРИ такого расширения, он не видит — и помечает живые
// объекты как UNUSED_OBJECT; данные в неизвестном ему контейнере — как дефект формата. Ни то,
// ни другое не является проблемой модели: она грузится движком с нужным декодером.
//
// Мы знаем, где именно каждое расширение прячет ссылки, поэтому помечаем такие сообщения
// полем `explainedBy: '<имя расширения>'`. Сообщения НЕ удаляются — данные валидатора остаются
// полностью, а UI показывает их отдельной свёрнутой группой и не считает за проблемы.
// Проверено на реальных сборках: draco прячет bufferViews, meshopt — buffers,
// EXT_mesh_gpu_instancing — accessors, KHR_texture_basisu — images (+ mime image/ktx2).

// JSON-чанк РОВНО тех байтов, которые проверял валидатор: пере-сериализация документа дала бы
// другие индексы, и указатели сообщений (`/bufferViews/3`) перестали бы совпадать.
function parseGltfJson(bytes: Buffer): GltfJson | null {
  try {
    const GLB_MAGIC = 0x46546c67;
    if (bytes.length >= 20 && bytes.readUInt32LE(0) === GLB_MAGIC) {
      const jsonLength = bytes.readUInt32LE(12);
      return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null; // не разобрали — просто не объясняем сообщения
  }
}

// Индекс объекта → имя расширения, которое на него ссылается (и которое валидатор не читает).
function referencesHiddenInExtensions(json: GltfJson, unsupported: Set<string>): HiddenRefs {
  const refs: HiddenRefs = { bufferViews: new Map(), buffers: new Map(), accessors: new Map(), images: new Map() };
  const add = (kind: keyof HiddenRefs, index: unknown, ext: string) => { if (Number.isInteger(index)) refs[kind].set(index as number, ext); };

  if (unsupported.has('KHR_draco_mesh_compression')) {
    // сжатая геометрия: у accessors нет bufferView, данные лежат в буфере расширения
    for (const mesh of json.meshes || []) {
      for (const prim of mesh.primitives || []) {
        const d = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
        if (d) add('bufferViews', d.bufferView, 'KHR_draco_mesh_compression');
      }
    }
  }
  if (unsupported.has('EXT_meshopt_compression')) {
    for (const bv of json.bufferViews || []) {
      const m = bv.extensions && bv.extensions.EXT_meshopt_compression;
      if (m) add('buffers', m.buffer, 'EXT_meshopt_compression');
    }
  }
  if (unsupported.has('EXT_mesh_gpu_instancing')) {
    // per-instance TRANSLATION/ROTATION/SCALE — обычные accessors, но видны только изнутри
    for (const node of json.nodes || []) {
      const i = node.extensions && node.extensions.EXT_mesh_gpu_instancing;
      for (const idx of Object.values((i && i.attributes) || {})) add('accessors', idx, 'EXT_mesh_gpu_instancing');
    }
  }
  if (unsupported.has('KHR_texture_basisu')) {
    for (const tex of json.textures || []) {
      const b = tex.extensions && tex.extensions.KHR_texture_basisu;
      if (b) add('images', b.source, 'KHR_texture_basisu');
    }
  }
  return refs;
}

// Какое расширение объясняет это сообщение (или null, если сообщение настоящее).
function explanationFor(message: ValidatorMessage, refs: HiddenRefs, json: GltfJson, unsupported: Set<string>): string | null {
  const pointer = String(message.pointer || '');

  if (message.code === 'UNUSED_OBJECT') {
    const hit = /^\/(bufferViews|buffers|accessors|images)\/(\d+)$/.exec(pointer);
    if (hit) return refs[hit[1] as keyof HiddenRefs].get(Number(hit[2])) || null;
    return null;
  }

  // KTX2: базовая спека не знает mime image/ktx2 и не умеет прочитать такой контейнер —
  // оба сообщения появляются ровно потому, что расширение не поддержано.
  if (unsupported.has('KHR_texture_basisu')) {
    const images = json.images || [];
    const isKtx2 = (i: number) => images[i] && images[i].mimeType === 'image/ktx2';
    const mime = /^\/images\/(\d+)\/mimeType$/.exec(pointer);
    if (message.code === 'VALUE_NOT_IN_LIST' && mime && isKtx2(Number(mime[1]))) return 'KHR_texture_basisu';
    const img = /^\/images\/(\d+)$/.exec(pointer);
    if (message.code === 'IMAGE_UNRECOGNIZED_FORMAT' && img && isKtx2(Number(img[1]))) return 'KHR_texture_basisu';
  }
  return null;
}

// Имя расширения из текста «Cannot validate an extension ... : '<name>'.» (см. ISSUES.md
// валидатора — формат сообщения с именем в кавычках стабилен для UNSUPPORTED_EXTENSION).
function unsupportedExtName(message: ValidatorMessage): string | null {
  const hit = /'([^']+)'/.exec(message.message || '');
  return hit ? hit[1]! : null;
}

function explainValidatorBlindSpots(json: GltfJson | null, messages: ExplainedMessage[]): ExplainedMessage[] {
  if (!json || !messages.length) return messages;
  const unsupported = new Set<string>();
  for (const m of messages) {
    if (m.code !== 'UNSUPPORTED_EXTENSION') continue;
    const name = unsupportedExtName(m);
    if (name) unsupported.add(name);
  }
  if (!unsupported.size) return messages;

  const refs = referencesHiddenInExtensions(json, unsupported);
  return messages.map((m): ExplainedMessage => {
    // сама строка «расширение не поддержано» — не дефект, а объяснение остальных; в ту же группу
    if (m.code === 'UNSUPPORTED_EXTENSION') {
      const name = unsupportedExtName(m);
      return name ? { ...m, explainedBy: name } : m;
    }
    const by = explanationFor(m, refs, json, unsupported);
    return by ? { ...m, explainedBy: by } : m;
  });
}

// Валидатор Khronos пишет по сообщению на КАЖДОЕ нарушение, а не на каждый вид нарушения.
// На `Lilith Character 01.glb` это 81 050 сообщений, из них 79 398 — один и тот же
// ACCESSOR_JOINTS_USED_ZERO_WEIGHT: по строке на вершину. В JSON это 18 МБ, которые
// сервер отдаёт, браузер разбирает, а человек всё равно не прочтёт.
//
// Схлопываем по (код + важность + причина): одна запись на вид нарушения, с числом
// повторений и несколькими примерами указателей. Количество сохраняется — оно и есть
// главное, что говорит эта груда: не «есть проблема», а «проблема в 79 398 местах».
const VALIDATION_EXAMPLES = 5;

function groupValidation(messages: ExplainedMessage[], examples: number = VALIDATION_EXAMPLES): GroupedMessage[] {
  const groups = new Map<string, GroupedMessage>();
  for (const m of messages) {
    if (!m) continue;
    const key = `${m.code}|${m.severity}|${m.explainedBy || ''}`;
    let g = groups.get(key);
    if (!g) {
      // первое сообщение вида задаёт текст и указатель — остальные к нему добавляют счёт
      g = { ...m, count: 0, pointers: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (g.pointers.length < examples && m.pointer) g.pointers.push(m.pointer);
  }
  return [...groups.values()];
}

/**
 * Сколько весит ИСХОДНАЯ модель целиком.
 *
 * У `.glb` это размер файла — там всё внутри. У `.gltf` файл сам по себе почти ничего не
 * весит: это оглавление, а геометрия и картинки лежат рядом отдельными файлами. Считать
 * весом только оглавление — врать в самом заметном месте отчёта: сборка пачки на 64 КБ,
 * давшая 11 КБ, показывала «8.9 КБ → 10.7 КБ, +20 %», то есть рост вместо шестикратного
 * уменьшения (найдено 2026-08-20 живой проверкой в браузере).
 *
 * Считаем то, что модель ДЕЙСТВИТЕЛЬНО читает, — файлы по ссылкам из `buffers` и
 * `images`, а не всё, что валяется в папке: рядом могут лежать исходники, readme и
 * чужие модели, к нашему весу отношения не имеющие.
 *
 * Ссылку, ведущую выше папки модели, тоже считаем. Она законна (общая папка текстур на
 * несколько моделей — обычная раскладка), и раз движок такой файл читает, то отказаться
 * его взвесить значило бы разойтись с собственной работой. Берём при этом только размер.
 *
 * Один файл по двум ссылкам весит один раз — иначе общая карта нормалей у пяти
 * материалов раздула бы «до» впятеро.
 *
 * Живёт в АДДОНЕ, а не в движке: `buffers`, `images` и `data:` — знание про glTF, и
 * ядро, которое однажды получит второй формат, не должно его нести. Движок спрашивает
 * через необязательный хук и без него берёт размер файла (core/types.mts).
 */
const referencedCache = new Map<string, { uri: string; full: string }[]>();

function referencedResources(srcPath: string): { uri: string; full: string }[] {
  if (!/\.gltf$/i.test(srcPath)) return [];
  // Спрашивают дважды за прогон — на вес пачки и на имена недостающих соседей, — а разбор
  // самодостаточного .gltf стоит вдвое больше самого файла (замер: 24 МБ → 73 МБ кучи).
  // Запоминаем МАЛЫЙ вывод, а не разобранный документ: список ссылок — это десяток строк,
  // а документ — те самые встроенные картинки, которые незачем держать в памяти.
  //
  // Памяти хватает одной записи: за прогон спрашивают об одном файле, а отпечаток
  // (путь, время, размер) не даст принять за него другой.
  const stamp = sourceStamp(srcPath);
  const known = referencedCache.get(stamp);
  if (known) return known;
  const json: any = readSourceJson(srcPath);
  if (!json) return [];   // не JSON — пусть об этом скажет разбор, а не обход ссылок
  const dir = path.dirname(srcPath);
  const seen = new Set<string>();
  const out: { uri: string; full: string }[] = [];
  for (const item of [...(json.buffers || []), ...(json.images || [])]) {
    const uri = item && item.uri;
    // Встроенное (`data:`) отдельным файлом не лежит — ни весить, ни теряться не может.
    if (!uri || typeof uri !== 'string' || /^data:/i.test(uri)) continue;
    let rel = uri;
    try { rel = decodeURIComponent(uri); } catch { /* адрес закодирован не по правилам */ }
    const full = path.resolve(dir, rel);
    if (seen.has(full)) continue;   // один файл по двум ссылкам — одна запись
    seen.add(full);
    out.push({ uri, full });
  }
  referencedCache.clear();          // одна запись: держать историю незачем
  referencedCache.set(stamp, out);
  return out;
}

function sourceBytes(srcPath: string): number {
  const own = fs.statSync(srcPath).size;
  let extra = 0;
  for (const r of referencedResources(srcPath)) {
    try { extra += fs.statSync(r.full).size; } catch { /* файла нет — весит ноль */ }
  }
  return own + extra;
}

/**
 * На кого модель ссылается, а его нет на диске.
 *
 * Нужно ради одной строки в ответе. `.gltf` без единого соседнего файла не читается
 * вовсе, и разбор падает изнутри библиотеки сообщением про ENOENT по временному пути —
 * человек (и командная строка) видели «Inspection failed (500)» и гадали. Причина же
 * всегда одна и та же: бросили файл, а не папку.
 *
 * Особо коварен файл-СИРОТА: картинка, которую не использует ни один материал. Показу
 * она не мешает (загрузчик её и не спросит), а разбору мешает — читаются все.
 */
function missingResources(srcPath: string): string[] {
  return referencedResources(srcPath).filter((r) => !fs.existsSync(r.full)).map((r) => r.uri);
}

/**
 * Прочитать модель, а при неудаче объяснить причину, если она известна.
 *
 * Исходную ошибку не прячем — она уходит следом за нашей: у пачки бывает и вторая беда
 * помимо нехватки файлов, и подменять один диагноз другим значит терять второй.
 */
async function readOrExplain(io: NodeIOType, srcPath: string) {
  try {
    return await io.read(srcPath);
  } catch (e: any) {
    const gone = missingResources(srcPath);
    if (!gone.length) throw e;
    // Строка берётся ИЗ КАТАЛОГА, а не пишется здесь (Правило 8: ни одной готовой
    // пользовательской фразы в коде движка). Первая редакция собирала её на месте, и
    // сторож `tests/i18n-discipline` совершенно правильно на этом покраснел.
    //
    // `i18n` на ошибке — рецепт для тех, кто знает язык человека: сервер пересобирает
    // строку на его языке (сам аддон запроса не видит и языка не знает). `message`
    // остаётся английским: его читают командная строка и журнал сервера.
    const err: Error & { i18n?: { messageId: string; data: Record<string, unknown> } } =
      new Error(render('io.missingResources', { names: gone.join(', ') }));
    err.i18n = { messageId: 'io.missingResources', data: { names: gone.join(', ') } };
    err.cause = e;
    throw err;
  }
}

// -------- Инспекция ассета (Metadata + Validation, как на gltf.report) --------
// Формат-специфично: метаданные из fns.inspect (те же таблицы, что у gltf.report) +
// issues от Khronos gltf-validator. Ядро отдаёт это через inspectFile() формат-агностично;
// будущий аддон другого формата реализует тот же хук со своими данными.
async function inspect(srcPath: string): Promise<Record<string, unknown>> {
  const io = await createIO();
  const bytes = fs.readFileSync(srcPath);
  // Чужой формат читается переходником — тем же, каким его читает сборка. Разойдись эти
  // два пути, человек увидел бы в метаданных одно, а собрал бы другое.
  const foreign = isImportFormat(srcPath);
  const doc = foreign ? await importForeign(srcPath) : await readOrExplain(io, srcPath);
  const asset = doc.getRoot().getAsset() || {};
  const extensions = doc.getRoot().listExtensionsUsed().map((e: { extensionName: string }) => e.extensionName);

  // «Генератор» читаем из СЫРОГО json, а не из документа. gltf-transform на чтении
  // подставляет в asset.generator СВОЮ версию, и панель метаданных у любой модели
  // показывала «glTF-Transform v4.4.2» — то есть поле, которое должно назвать Blender
  // или Sketchfab, всегда называло нас. Найдено 2026-08-17 на двух образцах подряд:
  // в файлах стояло v4.2.1 и v4.4.1, на экране — одинаковое v4.4.2.
  let rawGenerator = '';
  try { rawGenerator = parseGltfJson(bytes)?.asset?.generator || ''; } catch { /* не GLB или битый JSON — оставим пустым */ }

  let metadata: InspectLike = { scenes: { properties: [] }, meshes: { properties: [] }, materials: { properties: [] }, textures: { properties: [] }, animations: { properties: [] } };
  try { metadata = fns.inspect(doc); } catch { /* экзотика — отдаём пустые таблицы */ }

  let validation: ExplainedMessage[] = [];
  // Валидатор Khronos проверяет glTF. У STL и PLY проверять по стандарту glTF нечего:
  // это не glTF и не притворяется им. Прогнать валидатор по НАШЕЙ конверсии было бы
  // подменой — человек читал бы отчёт о своём файле, а получил бы отчёт о нашей работе.
  // Поэтому пусто, и это честное «замечаний нет», а не спрятанные замечания.
  if (foreign) return foreignInspect(doc, srcPath);
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(bytes));
    validation = (res && res.issues && res.issues.messages) || [];
    // пометить сообщения, вызванные слепотой валидатора к расширениям (не удаляя их)
    validation = explainValidatorBlindSpots(parseGltfJson(bytes), validation);
    validation = groupValidation(validation);
  } catch { /* валидатор не установлен — пустой список */ }

  // Те же метрики, что попадают в metrics.before после сборки, — и считает их та же
  // функция. Раньше цифры о модели ДО сборки интерфейс считал сам, из отрисованной
  // сцены three.js, и это давало два разных источника для одних и тех же строк:
  // до сборки клиентский, после — движковый. Хуже того, не отрисовалось — значит
  // человек не узнавал о модели ничего, хотя разобран файл уже был.
  //
  // Обходится это даром: документ уже прочитан выше ради metadata, второго чтения
  // файла не происходит.
  let metrics = null;
  // Вес — через sourceBytes, а не bytes.length: у `.gltf` сам файл почти ничего не весит,
  // и панель «Метаданные» показывала бы килобайты у модели на шестьдесят мегабайт.
  try { metrics = collectMetrics(doc, sourceBytes(srcPath)); } catch { /* экзотика — цифр не будет, таблицы останутся */ }

  return {
    format: 'gltf',
    asset: { version: asset.version || '', generator: rawGenerator || asset.generator || '' },
    extensions,
    metadata,
    metrics,
    validation,
  };
}

/**
 * Инспекция ЧУЖОГО формата: те же таблицы и те же метрики, но без отчёта валидатора.
 *
 * Отдельной функцией, а не набором «если» внутри общей: у чужого формата не бывает ни
 * расширений стандарта, ни генератора в файле, и полтора десятка ветвлений по этому
 * поводу превратили бы общий путь в лабиринт. Здесь же видно и главное — ЧТО отдаётся
 * пустым и почему.
 */
function foreignInspect(doc: Document, srcPath: string): Record<string, unknown> {
  let metadata: InspectLike = { scenes: { properties: [] }, meshes: { properties: [] }, materials: { properties: [] }, textures: { properties: [] }, animations: { properties: [] } };
  try { metadata = fns.inspect(doc); } catch { /* экзотика — отдаём пустые таблицы */ }
  let metrics = null;
  try { metrics = collectMetrics(doc, fs.statSync(srcPath).size); } catch { /* цифр не будет, таблицы останутся */ }
  return {
    format: 'gltf',
    // Откуда модель ПРИШЛА. Интерфейс говорит об этом одной строкой: человек бросил .stl,
    // а получит .glb, и знать про это он должен от нас, а не догадываться по имени файла.
    sourceFormat: path.extname(srcPath).toLowerCase().replace(/^\./, ''),
    // Ни версии стандарта, ни генератора в этих форматах нет. Пусто — это факт о файле,
    // а не пробел в нашей работе; подставлять сюда своё имя было бы враньём.
    asset: { version: '', generator: '' },
    extensions: [],
    metadata,
    metrics,
    validation: [],
  };
}

// -------- Экспорт glTF как самодостаточного JSON (как «Export → JSON» на gltf.report) --------
// Буферы/изображения инлайнятся data-URI, чтобы получился один JSON без внешних файлов.
function mimeFromUri(uri: string): string {
  const ext = (String(uri).split('.').pop() || '').toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    ktx2: 'image/ktx2', bin: 'application/octet-stream',
  }[ext] || 'application/octet-stream';
}

async function toJSON(srcPath: string): Promise<Record<string, unknown>> {
  const io = await createIO();
  const doc = isImportFormat(srcPath) ? await importForeign(srcPath) : await readOrExplain(io, srcPath);
  const { json, resources } = await io.writeJSON(doc, {});
  const inline = (uri: string, mime: string) => {
    const bytes = resources && resources[uri];
    if (!bytes) return uri;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  };
  for (const b of json.buffers || []) if (b.uri) b.uri = inline(b.uri, 'application/octet-stream');
  for (const img of json.images || []) if (img.uri) img.uri = inline(img.uri, img.mimeType || mimeFromUri(img.uri));
  // Приведение, а не преобразование: наружу уходит тот же объект. Тип библиотеки
  // (IGLTF) описывает конкретные поля glTF и под «просто объект» формально не подходит.
  return json as unknown as Record<string, unknown>;
}

// Прямой аннотации `: Addon` здесь нет намеренно, и JSDoc-пометка (она стояла тут со
// времён JavaScript) убрана: в `.mts` компилятор её не читает вовсе — она обещала
// проверку, которой не было. Настоящее согласование с типом ядра — одно, явное, в
// точке сборки: `gltfAddon as unknown as Addon` в optimize2.mts, там же объяснено,
// почему прямое соответствие невозможно (правила аддона сужают контекст ядра).
const gltfAddon = {
  // Принимаем больше, чем отдаём: STL и PLY приходят на вход, а выход всегда glTF
  // (см. importers.mts). Реестр ядра выбирает аддон по расширению — значит и командная
  // строка получает эти форматы тем же движением.
  formats: ['glb', 'gltf', ...IMPORT_FORMATS],
  rules: RULES,
  BASELINE_METRICS,
  ADVANCED_FEATURES,
  exclusiveGroups, // единственное объявление взаимоисключений — читает и интерфейс
  TOKTX, // для CLI-баннера (наличие toktx)
  outputName,
  normalizeOpts,
  createIO,
  load,
  writeBytes,
  readBytes,
  collectMetrics,
  sourceBytes,
  baselineMetrics: baselineSnapshot,
  stripInputCompression,
  validate,
  writeReport,
  inspect,
  toJSON,
};

export default gltfAddon;
