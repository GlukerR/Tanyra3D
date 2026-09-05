export type AddonDocument = unknown;

export type AddonIO = unknown;

export type Metrics = Record<string, unknown>;

export type FixSafety = 'provable' | 'numeric' | 'perceptual' | 'lossy';


export type MessageData = Record<string, unknown>;

export interface MessageRef {
  messageId: string;
  data?: MessageData;
}

export type MessageTemplate = string | ((data: MessageData) => string);

export type MessageCatalog = Record<string, MessageTemplate>;

export type Message = string | MessageRef;

export interface RuleMeta {
  id: string;
  category: string;
  title: string;
  titleKey?: string;
  severity: 'info' | 'warn' | 'error';
  fixSafety: FixSafety;
  tier: 'basic' | 'advanced';
  feature?: string;
  featureGroup?: string;
  runAfter: string[];
  touches: string[];
  reversible: boolean;
  dataLoss: 'none' | 'minor' | 'significant';
  reversalRuleId?: string;
  reversalNoteKey?: string;
  enabled: (opts: NormalizedOpts) => boolean;
}

export interface Rule {
  meta: RuleMeta;
  analyze: (ctx: Context) => Finding[];
  canFix?: (finding: Finding, ctx: Context) => FixDecision;
  fix?: (finding: Finding, ctx: Context) => FixResult | Promise<FixResult>;
}

export interface Finding {
  messageId: string;
  data?: Record<string, unknown>;
  text?: string;
  fixSafety?: string;
}

export interface FixDecision {
  safe: boolean;
  reason?: string;
  messageId?: string;
  data?: MessageData;
  force?: boolean;
}

export type ReportLines = Message | Message[];

export interface FixResult {
  found?: ReportLines;
  skipped?: ReportLines;
  cost?: ReportLines;
  details?: ReportLines;
  detail?: ReportLines;
  irreversible?: ReportLines;
  irreversibleSafety?: FixSafety;
}

export interface Context {
  document: AddonDocument;
  io: AddonIO;
  opts: NormalizedOpts;
  src: string;
  outDir: string;
  dstName: string;
  cache: Map<string, unknown>;
  log: (msg: string) => void;
  baselineMetrics?: Metrics;
}

export interface NormalizedOpts {
  outDir: string;
  force: boolean;
  dryRun: boolean;
  onProgress: ((e: Record<string, unknown>) => void) | null;
  log: (msg: string) => void;
  advancedFeatures: string[];
  locale?: string;
  exclusiveConflicts?: ExclusiveConflict[];
  [key: string]: unknown;
}

export interface ExclusiveConflict {
  group: string;
  ruleId: string;
  selected: { feature: string; titleKey: string };
  rejected: Array<{ feature: string; titleKey: string }>;
}

export interface FoundMeta {
  id: string;
  category: string;
  severity: string;
  fixSafety: string;
}

export interface ValidateArgs {
  ctx: Context;
  before: Metrics;
  after: Metrics;
  glbBytes: Uint8Array;
  src: string;
  result: RunResult;
  advancedPlannedIds: string[];
  addFound: (meta: FoundMeta, value: ReportLines) => void;
  log: (msg: string) => void;
}

export interface ReportArgs {
  name: string;
  result: RunResult;
  before: Metrics;
  after: Metrics;
  assetWritten: boolean;
  opts: NormalizedOpts;
}

export interface Addon {
  formats: string[];
  outputName: (src: string) => string;
  rules: Rule[];
  BASELINE_METRICS: string[];
  normalizeOpts: (opts: Record<string, unknown>) => NormalizedOpts;
  createIO: () => Promise<AddonIO>;
  load: (io: AddonIO, src: string) => Promise<AddonDocument>;
  writeBytes: (io: AddonIO, doc: AddonDocument, src?: string, opts?: NormalizedOpts) => Promise<Uint8Array>;
  readBytes: (io: AddonIO, bytes: Uint8Array) => Promise<AddonDocument>;
  collectMetrics: (doc: AddonDocument, fileBytes: number) => Metrics;
  sourceBytes?: (src: string) => number;
  baselineMetrics: (doc: AddonDocument) => Metrics;
  stripInputCompression: (doc: AddonDocument) => string[];
  validate: (args: ValidateArgs) => void | Promise<void>;
  writeReport: (args: ReportArgs) => string;
  exclusiveGroups?: () => Array<{ id: string; members: string[] }>;
  textureSlots?: () => Array<{ slot: string; pattern: string; flags: string }>;
  inspect?: (srcPath: string) => Promise<Record<string, unknown>>;
  toJSON?: (srcPath: string) => Promise<Record<string, unknown>>;
}

export type I18nRefs = Record<string, MessageRef>;

export type SkipKind =
  | 'disabled'
  | 'nothing'
  | 'unsafe'
  | 'policy'
  | 'cost'
  | 'exclusive';

export interface FindingEntry {
  ruleId: string;
  category: string;
  severity: string;
  fixSafety: string;
  text: string;
  i18n?: I18nRefs;
}

export interface SkippedEntry {
  ruleId: string;
  feature: string | null;
  text: string;
  reason: string;
  kind: SkipKind;
  i18n?: I18nRefs;
}

export interface AppliedEntry {
  ruleId: string;
  fixSafety: string;
  reversible: boolean;
  dataLoss: string;
  text: string;
  i18n?: I18nRefs;
}

export interface ValidationEntry {
  level: 'pass' | 'info' | 'fail';
  text: string;
  i18n?: I18nRefs;
}

export interface RunResult {
  status: 'ok' | 'skip' | 'fail';
  file: { src: string; dst: string | null; written: boolean; reportPath: string | null };
  findings: FindingEntry[];
  skipped: SkippedEntry[];
  applied: AppliedEntry[];
  validation: ValidationEntry[];
  metrics: { before: Metrics | null; after: Metrics | null };
  error?: string;
  i18n?: I18nRefs;
}
