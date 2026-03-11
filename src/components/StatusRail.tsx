'use client';

import type { GenerationStatus } from '@/lib/state/session';

type Props = {
  status: GenerationStatus;
  message: string;
  provider: string;
  model: string;
  repaired: boolean;
  fallbackUsed: boolean;
  loadingSeconds: number;
};

function statusColor(status: GenerationStatus): string {
  switch (status) {
    case 'ready':
      return 'var(--ok)';
    case 'repaired':
      return 'var(--warn)';
    case 'fallback':
    case 'error':
      return 'var(--err)';
    case 'generating':
    case 'validating':
      return 'var(--accent)';
    default:
      return 'var(--text-dim)';
  }
}

export default function StatusRail({
  status,
  message,
  provider,
  model,
  repaired,
  fallbackUsed,
  loadingSeconds,
}: Props) {
  const inProgress = status === 'generating' || status === 'validating';

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 12,
        minHeight: 140,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: statusColor(status),
          }}
        />
        <strong style={{ textTransform: 'uppercase', fontSize: 12 }}>{status}</strong>
      </div>
      <div style={{ color: 'var(--text)', lineHeight: 1.4 }}>{message}</div>
      {inProgress ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          Working {loadingSeconds}s. If model is slow, it will auto-fallback.
        </div>
      ) : null}
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        Provider: {provider || '-'} | Model: {model || '-'}
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        repaired: {String(repaired)} | fallback: {String(fallbackUsed)}
      </div>
    </section>
  );
}
