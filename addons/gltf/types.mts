// addons/gltf/types.mts — контракт правил ЭТОГО аддона.
//
// Ядро описывает правило формат-агностично (core/types.mts): документ для него —
// непрозрачное `unknown`, потому что трогать содержимое вправе только тот, кто знает
// формат. Здесь это «тот, кто знает»: документ становится `Document` из
// @gltf-transform/core, io — `NodeIO`, а опции — тем набором полей, который на самом
// деле возвращает normalizeOpts.
//
// Заведено 2026-08-11 вместе с переводом правил на TypeScript. Без такого сужения
// правила не типизируются вовсе: `ctx.document.getRoot()` на `unknown` — ошибка.
//
// Тип-псевдонимы, а не интерфейсы: у интерфейса нет индексной сигнатуры, и он не
// подошёл бы под `NormalizedOpts` ядра, где она есть.

import type { Document, NodeIO } from '@gltf-transform/core';

import type {
  Context,
  ExclusiveConflict,
  Finding,
  FixDecision,
  FixResult,
  FixSafety,
  Message,
  NormalizedOpts,
  RuleMeta,
} from '../../core/types.mjs';

/**
 * Опции после нормализации аддоном. Базовые поля (outDir/force/dryRun/onProgress/log)
 * читает движок, остальные — правила отсюда.
 *
 * Про `compress` и `codec` стоит знать: их читает ещё и движок, хотя в его контракте
 * их нет (core/engine.mts, входное сжатие). Это давняя протечка формата в ядро,
 * замеченная при переводе; здесь она только зафиксирована, не узаконена.
 */
export type GltfOpts = {
  // --- поля контракта ядра ---
  outDir: string;
  force: boolean;
  dryRun: boolean;
  onProgress: ((e: Record<string, unknown>) => void) | null;
  log: (msg: string) => void;
  advancedFeatures: string[];
  locale: string;
  exclusiveConflicts: ExclusiveConflict[];

  // --- поля аддона: что именно делать с моделью ---
  /** безопасная чистка (бандл правил) */
  safe: boolean;
  /** сжимать ли геометрию вообще */
  compress: boolean;
  /** какой кодек, если compress включён */
  codec: 'draco' | 'meshopt';
  quantize: boolean;
  /** склейка мешей; отменяется keepParts */
  join: boolean;
  instance: boolean;
  resample: boolean;
  /**
   * Снять пометки нажатия с частей, на которые в графе поведения нет отклика.
   *
   * НЕОБРАТИМО и НИКОГДА по умолчанию: метку ставил автор. Узкое исключение Правила 11 —
   * человек выбирает это сам, отдельной галочкой, а цена названа до нажатия и записана
   * в отчёт после (заказ Александра, 2026-08-28).
   */
  stripDeadInteractivity: boolean;
  /** UASTC для всего либо ETC1S для цвета + UASTC для карт данных */
  texMode: 'uastc' | 'mixed';
  keepParts: boolean;
  /** ВЫКЛЮЧАТЕЛЬ, а не включатель: true означает «KTX2 не делать» */
  noKtx: boolean;
  /** такой же выключатель для WebP */
  noWebp: boolean;
  /**
   * Качество WebP как ДОЛЯ от качества исходника, 0…100. Сотня — «как в исходнике»:
   * выше потолка прыгнуть нельзя, поэтому шкала там и кончается. Умолчание — 100
   * («как в исходнике»), его держит `WEBP_QUALITY_DEFAULT` в `rules.mts`;
   * `undefined` означает «не задавали». Как узнаётся потолок — `source-quality.mts`.
   */
  webpQuality?: number | undefined;
  stripColors: boolean;
  /**
   * Потолок большей стороны текстуры в пикселях: 4096, 2048, 1024, 512 либо 0 —
   * «не уменьшать» (значение по умолчанию). Ровно четыре значения, а не произвольное
   * число: это выбор из списка в интерфейсе, а не поле ввода.
   */
  maxTextureSize: number;
};

/**
 * Накопитель строк результата внутри fix(). От FixResult отличается тем, что каналы —
 * всегда массивы: правило кладёт в них строки по ходу дела, а `Message | Message[]`
 * из контракта ядра push не умеет. Наружу уходит как FixResult — массив под него подходит.
 *
 * Обязательные поля — те три, что правило заводит сразу; условные (cost, irreversible)
 * необязательны, потому что появляются только на своей ветке.
 */
export type FixOut = {
  found: Message[];
  skipped: Message[];
  details: Message[];
  cost?: Message[];
  irreversible?: Message[];
  irreversibleSafety?: FixSafety;
};

/** Рабочий контекст правила: тот же, что у ядра, но документ и io — настоящие. */
export type GltfContext = Omit<Context, 'document' | 'io' | 'opts'> & {
  document: Document;
  io: NodeIO;
  opts: GltfOpts;
};

/**
 * Правило glTF: та же форма, что у ядра, но со знанием формата.
 *
 * НЕ наследник `Rule` — и это не упущение. Правило ядра обязано принимать ЛЮБОЙ контекст
 * и любые опции; правило glTF принимает только свои. По правилам подстановки функций это
 * сужение входа, то есть обратное тому, что требуется от наследника: подставить glTF-
 * правило туда, где ждут произвольное, формально нельзя. Во время работы подстановка
 * верна — движок зовёт правила аддона только с контекстом, который сам же и собрал из
 * того, что аддон загрузил, — но выражается это не наследованием, а приведением в одном
 * месте: там, где аддон отдаёт RULES движку (addons/gltf/index).
 *
 * У meta поле `enabled` переопределено через `Omit`, а не пересечением: пересечение двух
 * функциональных типов даёт перегрузку, и при выводе типа параметра берётся ПЕРВАЯ
 * сигнатура — опции ядра, где у полей тип `unknown`. Отсюда была бы россыпь
 * «unknown не присваивается boolean» на каждом `enabled: (o) => o.safe`.
 */
export interface GltfRule {
  meta: Omit<RuleMeta, 'enabled'> & { enabled: (opts: GltfOpts) => boolean };
  analyze: (ctx: GltfContext) => Finding[];
  canFix?: (finding: Finding, ctx: GltfContext) => FixDecision;
  fix?: (finding: Finding, ctx: GltfContext) => FixResult | Promise<FixResult>;
}

export type { Finding, FixDecision, FixResult, NormalizedOpts };
