'use client';

import type { CSSProperties } from 'react';

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

export default function RequestWorkbench({
  routeDecision,
  executionTrace,
  currentEvaluator,
  attempts,
}: Props) {
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
                      requestMode: executionTrace.requestMode,
                      endpoint: executionTrace.endpoint,
                      targetId: executionTrace.targetId,
                      roleLabel: executionTrace.roleLabel,
                      statusMessage: executionTrace.statusMessage,
                      source: executionTrace.source,
                      provider: executionTrace.provider,
                      model: executionTrace.model,
                      repaired: executionTrace.repaired,
                      fallbackUsed: executionTrace.fallbackUsed,
                      staticCode: executionTrace.staticCode,
                      sandboxCode: executionTrace.sandboxCode,
                      testsRun: executionTrace.testsRun,
                      filesProduced: executionTrace.filesProduced,
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
