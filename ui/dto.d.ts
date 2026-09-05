interface ReportEntryDto {
  ruleId?: string;
  text: string;
  reason?: string;
  kind?: string;
  feature?: string | null;
  fixSafety?: string;
  reversible?: boolean;
  dataLoss?: string;
  level?: string;
  [key: string]: any;
}

interface RunResultDto {
  status: 'ok' | 'skip' | 'fail';
  file: { src: string; dst: string | null; written: boolean; reportPath: string | null };
  findings: ReportEntryDto[];
  skipped: ReportEntryDto[];
  applied: ReportEntryDto[];
  validation: ReportEntryDto[];
  metrics: { before: Record<string, any> | null; after: Record<string, any> | null };
  error?: string;
  [key: string]: any;
}

interface ExplainDto {
  summary?: string;
  highlights?: string[];
  warnings?: string[];
  budgetChecks?: Array<{
    id: string;
    name: string;
    actualText: string;
    level: string;
    advice?: string;
    [key: string]: any;
  }>;
  [key: string]: any;
}

interface InspectDto {
  format?: string | null;
  sourceFormat?: string;
  asset?: { version?: string; generator?: string };
  extensions?: string[];
  metadata?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
  validation?: Array<Record<string, any>>;
  [key: string]: any;
}

interface PlatformDto {
  id: string;
  title: string;
  description?: string;
  unknown?: string[];
  [key: string]: any;
}

interface EngineDto {
  id: string;
  title: string;
  description?: string;
  viewer?: string;
  [key: string]: any;
}

interface BudgetFieldDto {
  id: string;
  name: string;
  unit: string;
}

interface ExtensionDto {
  id: string;
  title?: string;
  description?: string;
  impact?: string;
  opts?: Record<string, any>;
  [key: string]: any;
}

interface Stats {
  [key: string]: any;
}

interface Detection {
  [key: string]: any;
}

interface ModelIssue {
  kind: 'unreadable' | 'incomplete' | 'validation';
  count?: number;
  detail?: string;
  [key: string]: any;
}

interface UiSelection {
  geometryChoice: string;
  textureSizeChoice: string;
  ktx2Mode: string;
  checked: string[];
  keepUnusedUv?: boolean;
  [key: string]: any;
}

interface DroppedFile {
  file: File;
  path: string;
}

interface PackFile {
  path: string;
  file: File;
}

interface ModelEntry {
  id: string;
  file: File;
  pack: PackFile[];
  packSourceId: string | null;
  packChecked: boolean;
  packMissing: number;
  heavyWarned: boolean;
  state: Record<string, any>;
  picked: boolean;
  [key: string]: any;
}
