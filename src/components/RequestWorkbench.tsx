'use client';

import type { CSSProperties } from 'react';

import { executionStageLabel, summarizeExecutionTraceMode, type ExecutionOutcome } from '@/lib/ai/execution-trace';
import type { ModelAttempt } from '@/lib/ai/types';
import type { EvaluatorResult } from '@/lib/evaluator/types';
import type { RouteDecision, ExecutionTrace } from '@/lib/workspace/types';

type Props = {
  routeDecision: RouteDecision | null;
  executionTrace: ExecutionTrace | null;
  currentEvaluator: EvaluatorResult | null;
  attempts: ModelAttempt[];
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
  };
}

function outcomeLabel(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case 'pending':
      return '进行中';
    case 'recovered_success':
      return '恢复成功';
    case 'hard_failure':
      return '硬失败';
    case 'direct_success':
    default:
      return '直接成功';
  }
}

function outcomeTone(outcome: ExecutionOutcome): CSSProperties {
  if (outcome === 'pending') {
    return {
      border: '1px solid rgba(59, 130, 246, 0.4)',
      background: 'rgba(30, 64, 175, 0.22)',
    };
  }
  if (outcome === 'hard_failure') {
    return {
      border: '1px solid rgba(239, 68, 68, 0.45)',
      background: 'rgba(127, 29, 29, 0.35)',
    };
  }
  if (outcome === 'recovered_success') {
    return {
      border: '1px solid rgba(245, 158, 11, 0.4)',
      background: 'rgba(120, 53, 15, 0.3)',
    };
  }
  return {
    border: '1px solid rgba(34, 197, 94, 0.35)',
    background: 'rgba(20, 83, 45, 0.28)',
  };
}

function inferOutcome(executionTrace: ExecutionTrace | null, failureContext: ExecutionTrace['failureContext']): ExecutionOutcome {
  if (executionTrace?.outcome) {
    return executionTrace.outcome;
  }
  if (executionTrace?.engine?.outcome) {
    return executionTrace.engine.outcome;
  }
  if (
    executionTrace?.engine?.fallbackReason === 'workspace_recovered_after_transport_error'
    || executionTrace?.statusMessage.toLowerCase().includes('recovered package from workspace')
  ) {
    return 'recovered_success';
  }
  if (failureContext || executionTrace?.source === 'request-error' || executionTrace?.staticCode === 'REQUEST_FAILED') {
    return 'hard_failure';
  }
  return 'direct_success';
}

export default function RequestWorkbench({
  routeDecision,
  executionTrace,
  currentEvaluator,
  attempts,
}: Props) {
  const stages = executionTrace?.stages ?? [];
  const failureContext = executionTrace?.failureContext ?? null;
  const testsRun = executionTrace?.testsRun ?? [];
  const filesProduced = executionTrace?.filesProduced ?? [];
  const outcome = inferOutcome(executionTrace, failureContext);
  const recovery = executionTrace?.recovery ?? executionTrace?.engine?.recovery ?? null;

  return (
    <details
      style={{
        marginTop: 12,
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--panel)',
        padding: 12,
      }}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Workbench</summary>

      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <div
          style={{
            ...panelStyle(),
            ...outcomeTone(outcome),
            display: 'grid',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Outcome</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{outcomeLabel(outcome)}</div>
            </div>
            <div style={{ minWidth: 220 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Final status</div>
              <div style={{ color: 'var(--text)' }}>{executionTrace?.statusMessage ?? 'No execution trace recorded yet.'}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Original failure</div>
              <div style={{ color: 'var(--text)' }}>
                {failureContext
                  ? `${failureContext.code ?? failureContext.reason ?? 'unknown'} · ${failureContext.message}`
                  : 'No original failure recorded.'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Recovery source</div>
              <div style={{ color: 'var(--text)' }}>
                {recovery
                  ? `${recovery.source}${typeof recovery.workspaceVersion === 'number' ? ` · workspace v${recovery.workspaceVersion}` : ''}`
                  : 'No recovery path used.'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Engine path</div>
              <div style={{ color: 'var(--text)' }}>
                {executionTrace?.engine
                  ? `${executionTrace.engine.requestedEngine} → ${executionTrace.engine.actualEngine}`
                  : 'No engine metadata recorded.'}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <h3 style={{ marginTop: 0 }}>Routing Summary</h3>
            <pre style={panelStyle()}>
              {routeDecision
                ? JSON.stringify(
                    {
                      primaryReasonCode: routeDecision.primaryReasonCode,
                      allowedPaths: routeDecision.allowedPaths,
                      allowedChangeTypes: routeDecision.allowedChangeTypes,
                      summary: routeDecision.summary,
                      why: routeDecision.why,
                      targetId: routeDecision.targetId,
                    },
                    null,
                    2,
                  )
                : 'No routing decision recorded yet.'}
            </pre>
          </div>

          <div>
            <h3 style={{ marginTop: 0 }}>Execution Trace</h3>
            <pre style={panelStyle()}>
              {executionTrace
                ? JSON.stringify(
                    {
                      modeLabel: summarizeExecutionTraceMode(executionTrace.requestMode),
                      requestMode: executionTrace.requestMode,
                      endpoint: executionTrace.endpoint,
                      targetId: executionTrace.targetId,
                      roleLabel: executionTrace.roleLabel,
                       statusMessage: executionTrace.statusMessage,
                      outcome,
                      recovery,
                      source: executionTrace.source,
                      provider: executionTrace.provider,
                      model: executionTrace.model,
                      repaired: executionTrace.repaired,
                      fallbackUsed: executionTrace.fallbackUsed,
                      staticCode: executionTrace.staticCode,
                      sandboxCode: executionTrace.sandboxCode,
                      testsRun,
                      filesProduced,
                      engine: executionTrace.engine,
                      stagesCount: stages.length,
                      failureContext: executionTrace.failureContext,
                    },
                    null,
                    2,
                  )
                : 'No execution trace recorded yet.'}
            </pre>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <h3 style={{ marginTop: 0 }}>Stage Timeline</h3>
            <div style={panelStyle()}>
              {stages.length > 0 ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  {stages.map(stage => (
                    <div
                      key={stage.key}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '140px 90px 90px 1fr',
                        gap: 8,
                        alignItems: 'start',
                      }}
                    >
                      <strong>{executionStageLabel(stage.key)}</strong>
                      <span>{stage.status}</span>
                      <span>{stage.durationMs}ms</span>
                      <span>{stage.detail ?? '-'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                'No stage timings recorded yet.'
              )}
            </div>
          </div>

          <div>
            <h3 style={{ marginTop: 0 }}>Failure Context</h3>
            <pre style={panelStyle()}>
              {failureContext
                ? JSON.stringify(failureContext, null, 2)
                : outcome === 'recovered_success'
                  ? 'Recovered success should preserve original failure context, but none was recorded.'
                  : 'No failure context recorded.'}
            </pre>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <h3 style={{ marginTop: 0 }}>Evaluator</h3>
            <pre style={panelStyle()}>
              {currentEvaluator ? JSON.stringify(currentEvaluator, null, 2) : 'No evaluator result yet.'}
            </pre>
          </div>

          <div>
            <h3 style={{ marginTop: 0 }}>Attempts</h3>
            <pre style={panelStyle()}>
              {JSON.stringify(
                {
                  attemptsCount: attempts.length,
                  attempts: attempts.map(attempt => ({
                    provider: attempt.provider,
                    model: attempt.model,
                    mode: attempt.mode,
                    outcome: attempt.outcome,
                    durationMs: attempt.durationMs,
                    errorMessage: attempt.errorMessage,
                  })),
                },
                null,
                2,
              )}
            </pre>
          </div>
        </div>
      </div>
    </details>
  );
}
