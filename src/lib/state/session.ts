import type { ModelAttempt } from '@/lib/ai/types';
import type { GameDsl } from '@/lib/game/dsl';
import type { CombinedValidationResult } from '@/lib/game/validate';

export type GenerationStatus =
  | 'idle'
  | 'generating'
  | 'validating'
  | 'ready'
  | 'repaired'
  | 'fallback'
  | 'error';

export type DslSource =
  | 'model'
  | 'template'
  | 'repair'
  | 'last-known-good'
  | 'archive'
  | null;

export type ArchivedVersion = {
  id: string;
  title: string;
  createdAt: string;
  source: 'live' | 'staged';
  parentArchiveId: string | null;
  dsl: GameDsl;
};

export type ModifyBaseType = 'staged' | 'live' | 'archive';

export type SessionState = {
  status: GenerationStatus;
  statusMessage: string;
  prompt: string;
  latestInstruction: string;
  provider: string;
  model: string;
  liveDsl: GameDsl | null;
  stagedDsl: GameDsl | null;
  stagedParentArchiveId: string | null;
  lastKnownGoodLive: GameDsl | null;
  liveParentArchiveId: string | null;
  liveValidation: CombinedValidationResult | null;
  stagedValidation: CombinedValidationResult | null;
  repaired: boolean;
  fallbackUsed: boolean;
  dslSource: DslSource;
  finalSourceProvider: string | null;
  finalSourceModel: string | null;
  lastAttemptProvider: string | null;
  lastAttemptModel: string | null;
  archives: ArchivedVersion[];
  attempts: ModelAttempt[];
};

export const initialSessionState: SessionState = {
  status: 'idle',
  statusMessage: 'Ready to generate a playable prototype.',
  prompt: '',
  latestInstruction: '',
  provider: '',
  model: '',
  liveDsl: null,
  stagedDsl: null,
  stagedParentArchiveId: null,
  lastKnownGoodLive: null,
  liveParentArchiveId: null,
  liveValidation: null,
  stagedValidation: null,
  repaired: false,
  fallbackUsed: false,
  dslSource: null,
  finalSourceProvider: null,
  finalSourceModel: null,
  lastAttemptProvider: null,
  lastAttemptModel: null,
  archives: [],
  attempts: [],
};
