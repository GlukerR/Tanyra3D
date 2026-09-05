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

export type GltfOpts = {
  outDir: string;
  force: boolean;
  dryRun: boolean;
  onProgress: ((e: Record<string, unknown>) => void) | null;
  log: (msg: string) => void;
  advancedFeatures: string[];
  locale: string;
  exclusiveConflicts: ExclusiveConflict[];

  safe: boolean;
  compress: boolean;
  codec: 'draco' | 'meshopt';
  quantize: boolean;
  join: boolean;
  keepUnusedUv: boolean;
  instance: boolean;
  resample: boolean;
  stripDeadInteractivity: boolean;
  texMode: 'uastc' | 'mixed';
  keepParts: boolean;
  noKtx: boolean;
  noWebp: boolean;
  webpQuality?: number | undefined;
  stripColors: boolean;
  maxTextureSize: number;
};

export type FixOut = {
  found: Message[];
  skipped: Message[];
  details: Message[];
  cost?: Message[];
  irreversible?: Message[];
  irreversibleSafety?: FixSafety;
};

export type GltfContext = Omit<Context, 'document' | 'io' | 'opts'> & {
  document: Document;
  io: NodeIO;
  opts: GltfOpts;
};

export interface GltfRule {
  meta: Omit<RuleMeta, 'enabled'> & { enabled: (opts: GltfOpts) => boolean };
  analyze: (ctx: GltfContext) => Finding[];
  canFix?: (finding: Finding, ctx: GltfContext) => FixDecision;
  fix?: (finding: Finding, ctx: GltfContext) => FixResult | Promise<FixResult>;
}

export type { Finding, FixDecision, FixResult, NormalizedOpts };
