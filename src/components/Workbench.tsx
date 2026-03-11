'use client';

import type { CSSProperties } from 'react';

import type { ModelAttempt } from '@/lib/ai/types';
import type { GameDsl } from '@/lib/game/dsl';
import type { CombinedValidationResult } from '@/lib/game/validate';
import type { ArchivedVersion, DslSource } from '@/lib/state/session';

type Props = {
  open: boolean;
  liveDsl: GameDsl | null;
  stagedDsl: GameDsl | null;
  liveValidation: CombinedValidationResult | null;
  stagedValidation: CombinedValidationResult | null;
  provider: string;
  model: string;
  repaired: boolean;
  fallbackUsed: boolean;
  dslSource: DslSource;
  finalSourceProvider: string | null;
  finalSourceModel: string | null;
  lastAttemptProvider: string | null;
  lastAttemptModel: string | null;
  attempts: ModelAttempt[];
  archives: ArchivedVersion[];
  selectedArchive: ArchivedVersion | null;
};

function panelStyle(): CSSProperties {
  return {
    margin: 0,
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 8,
    maxHeight: 320,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--text-dim)',
  };
}

export default function Workbench({
  open,
  liveDsl,
  stagedDsl,
  liveValidation,
  stagedValidation,
  provider,
  model,
  repaired,
  fallbackUsed,
  dslSource,
  finalSourceProvider,
  finalSourceModel,
  lastAttemptProvider,
  lastAttemptModel,
  attempts,
  archives,
  selectedArchive,
}: Props) {
  if (!open) {
    return null;
  }

  const latestDiagnosticAttempt = [...attempts]
    .reverse()
    .find(attempt => attempt.rawText || attempt.extractedJson || attempt.normalizedJson || attempt.schemaIssues);
  const liveBackground = liveDsl?.arena.backgroundColor ?? null;
  const selectedArchiveBackground = selectedArchive?.dsl.arena.backgroundColor ?? null;
  const backgroundDiffers =
    liveBackground !== null && selectedArchiveBackground !== null && liveBackground !== selectedArchiveBackground;

  return (
    <section
      style={{
        marginTop: 12,
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--panel)',
        padding: 12,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
      }}
    >
      <div>
        <h3 style={{ marginTop: 0 }}>Runtime Snapshot</h3>
        <pre style={panelStyle()}>
          {JSON.stringify(
            {
              provider,
              model,
              repaired,
              fallbackUsed,
              dslSource,
              finalDslOrigin: {
                provider: finalSourceProvider,
                model: finalSourceModel,
              },
              lastAttemptOrigin: {
                provider: lastAttemptProvider,
                model: lastAttemptModel,
              },
              liveTitle: liveDsl?.meta.title ?? null,
              stagedTitle: stagedDsl?.meta.title ?? null,
              archiveCount: archives.length,
              liveValidation,
              stagedValidation,
            },
            null,
            2,
          )}
        </pre>
        <div
          style={{
            marginTop: 8,
            border: `1px solid ${backgroundDiffers ? '#f59e0b' : 'var(--border)'}`,
            borderRadius: 8,
            padding: '8px 10px',
            background: backgroundDiffers ? 'rgba(245, 158, 11, 0.08)' : 'var(--panel-2)',
            color: backgroundDiffers ? '#fcd34d' : 'var(--text-dim)',
            fontSize: 13,
          }}
        >
          {selectedArchive
            ? backgroundDiffers
              ? `Diff hint: arena.backgroundColor changed (Live: ${liveBackground} vs Archive: ${selectedArchiveBackground}).`
              : 'Diff hint: arena.backgroundColor matches selected archive.'
            : 'Diff hint: choose an archive to compare with live DSL.'}
        </div>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Model Attempts</h3>
        <pre style={panelStyle()}>
          {attempts.length > 0
            ? JSON.stringify(attempts, null, 2)
            : 'No model attempts recorded yet.'}
        </pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Latest Raw Model Payload</h3>
        <pre style={panelStyle()}>
          {latestDiagnosticAttempt
            ? JSON.stringify(
                {
                  provider: latestDiagnosticAttempt.provider,
                  model: latestDiagnosticAttempt.model,
                  mode: latestDiagnosticAttempt.mode,
                  outcome: latestDiagnosticAttempt.outcome,
                  extractedFormat: latestDiagnosticAttempt.extractedFormat,
                  rawText: latestDiagnosticAttempt.rawText,
                  extractedJson: latestDiagnosticAttempt.extractedJson,
                  normalizedJson: latestDiagnosticAttempt.normalizedJson,
                  schemaIssues: latestDiagnosticAttempt.schemaIssues,
                },
                null,
                2,
              )
            : 'No raw payload captured yet.'}
        </pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Live DSL (read-only)</h3>
        <pre style={panelStyle()}>{liveDsl ? JSON.stringify(liveDsl, null, 2) : 'No live DSL yet.'}</pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Staged DSL (read-only)</h3>
        <pre style={panelStyle()}>
          {stagedDsl ? JSON.stringify(stagedDsl, null, 2) : 'No staged DSL currently.'}
        </pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0 }}>Selected Archive DSL (read-only)</h3>
        <pre
          style={{
            ...panelStyle(),
            border: `1px solid ${backgroundDiffers ? '#f59e0b' : 'var(--border)'}`,
          }}
        >
          {selectedArchive
            ? JSON.stringify(selectedArchive.dsl, null, 2)
            : 'No archive selected. Pick one from the archive dropdown.'}
        </pre>
      </div>
    </section>
  );
}
