'use client';

import type { CSSProperties } from 'react';

import type { AiSessionTransportLogEntry, AiSessionTransportSnapshot } from '@/lib/ai-sessions/types';

type Props = {
  transport: AiSessionTransportSnapshot | null;
  initTranscript: AiSessionTransportLogEntry[];
  turnTranscript: AiSessionTransportLogEntry[];
  loading: boolean;
};

function panelStyle(): CSSProperties {
  return {
    margin: 0,
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--panel-2)',
    padding: 10,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--text-dim)',
    fontSize: 13,
    maxHeight: 260,
    overflow: 'auto',
  };
}

function formatLogs(entries: AiSessionTransportLogEntry[]): string {
  if (entries.length === 0) {
    return 'No transcript entries yet.';
  }

  return entries
    .map(entry => `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.direction.toUpperCase()} ${entry.message}`)
    .join('\n');
}

export default function CodexPanel({ transport, initTranscript, turnTranscript, loading }: Props) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Codex Transport</h3>
        <pre style={panelStyle()}>
          {JSON.stringify(
            transport ?? {
              phase: 'uninitialized',
              requiresReinit: true,
            },
            null,
            2,
          )}
        </pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Init Transcript {loading ? '(loading...)' : ''}</h3>
        <pre style={panelStyle()}>{formatLogs(initTranscript)}</pre>
      </div>

      <div>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Turn Transcript {loading ? '(loading...)' : ''}</h3>
        <pre style={panelStyle()}>{formatLogs(turnTranscript)}</pre>
      </div>
    </div>
  );
}
