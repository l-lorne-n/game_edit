'use client';

import { useEffect, useMemo, useRef } from 'react';

import { makeEvaluatorResult, type EvaluatorResult } from '@/lib/evaluator/types';
import type { GeneratedGamePackage } from '@/lib/package/contracts';

type SandboxMessage = {
  channel: 'game_edit_sandbox';
  type: 'READY' | 'RUNTIME_ERROR' | 'UNHANDLED_REJECTION' | 'CONSOLE_ERROR' | 'TEST_RESULT';
  payload?: Record<string, unknown>;
};

type Props = {
  packageData: GeneratedGamePackage | null;
  timeoutMs?: number;
  onReport?: (result: EvaluatorResult) => void;
  runtimeNonce?: number;
};

function escScript(text: string): string {
  return text.replace(/<\/script>/gi, '<\\/script>');
}

function buildStorageShim(): string {
  return `
(() => {
  const makeMemoryStorage = () => {
    const store = new Map();
    return {
      get length() { return store.size; },
      clear() { store.clear(); },
      getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
      key(index) { return Array.from(store.keys())[index] ?? null; },
      removeItem(key) { store.delete(String(key)); },
      setItem(key, value) { store.set(String(key), String(value)); },
    };
  };

  const installFallback = (name) => {
    let works = false;
    try {
      const probe = window[name];
      const testKey = '__game_edit_probe__';
      probe.setItem(testKey, '1');
      probe.removeItem(testKey);
      works = true;
    } catch {
      works = false;
    }

    if (!works) {
      const fallback = makeMemoryStorage();
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: fallback,
      });
    }
  };

  installFallback('localStorage');
  installFallback('sessionStorage');
})();
`.trim();
}

export function buildSandboxDoc(pkg: GeneratedGamePackage): string {
  const bridge = `
(() => {
  const CHANNEL = 'game_edit_sandbox';
  const HOST_CHANNEL = 'game_edit_host';
  let readySent = false;
  const toText = value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (type, payload = {}) => {
    parent.postMessage({ channel: CHANNEL, type, payload }, '*');
  };
  const emitReady = () => {
    if (readySent) {
      return;
    }
    readySent = true;
    send('READY', { ts: Date.now(), readyState: document.readyState });
  };

  window.addEventListener('error', event => {
    send('RUNTIME_ERROR', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack ? String(event.error.stack) : '',
    });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    send('UNHANDLED_REJECTION', {
      message: reason && reason.message ? String(reason.message) : toText(reason),
      stack: reason && reason.stack ? String(reason.stack) : '',
    });
  });

  const originalError = console.error.bind(console);
  console.error = (...args) => {
    send('CONSOLE_ERROR', { message: args.map(toText).join(' ') });
    originalError(...args);
  };

  window.addEventListener('message', async event => {
    const data = event.data;
    if (!data || data.channel !== HOST_CHANNEL) {
      return;
    }

    if (data.type === 'PING') {
      emitReady();
      return;
    }

    if (data.type === 'RUN_TESTS') {
      if (typeof window.runTests !== 'function') {
        send('TEST_RESULT', { ok: true, message: 'No runTests hook defined.' });
        return;
      }

      try {
        const result = await window.runTests();
        send('TEST_RESULT', {
          ok: result && result.ok !== false,
          message: result && result.message ? String(result.message) : 'runTests completed.',
        });
      } catch (error) {
        send('TEST_RESULT', {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(emitReady, 0);
  } else {
    window.addEventListener('DOMContentLoaded', emitReady, { once: true });
    window.addEventListener('load', emitReady, { once: true });
  }
})();
`.trim();

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${pkg.styleCss}</style>
  </head>
  <body>
    ${pkg.indexHtml}
    <script>${escScript(bridge)}</script>
    <script>${escScript(buildStorageShim())}</script>
    <script>${escScript(pkg.gameJs)}</script>
  </body>
</html>`;
}

export default function SandboxPreview({
  packageData,
  timeoutMs = 50000,
  onReport,
  runtimeNonce = 0,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const reportRef = useRef(onReport);
  const doc = useMemo(
    () => (packageData ? buildSandboxDoc(packageData) : ''),
    [packageData],
  );

  useEffect(() => {
    reportRef.current = onReport;
  }, [onReport]);

  useEffect(() => {
    if (!packageData) {
      return;
    }

    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const started = Date.now();
    let done = false;
    let testTimer: number | null = null;

    const report = (result: EvaluatorResult) => {
      reportRef.current?.(result);
    };

    const readyTimer = window.setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      report(
        makeEvaluatorResult({
          ok: false,
          source: 'sandbox',
          code: 'READY_TIMEOUT',
          summary: 'Sandbox did not report READY before timeout.',
          bootMs: timeoutMs,
          errors: ['READY timeout'],
        }),
      );
    }, timeoutMs);

    const pingTimer = window.setInterval(() => {
      frameRef.current?.contentWindow?.postMessage({ channel: 'game_edit_host', type: 'PING' }, '*');
    }, 300);

    frameRef.current?.contentWindow?.postMessage({ channel: 'game_edit_host', type: 'PING' }, '*');

    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) {
        return;
      }

      const data = event.data as SandboxMessage | undefined;
      if (!data || data.channel !== 'game_edit_sandbox') {
        return;
      }

      if (done) {
        return;
      }

      if (data.type === 'READY') {
        clearTimeout(readyTimer);
        const bootMs = Math.max(0, Date.now() - started);
        report(
          makeEvaluatorResult({
            ok: true,
            source: 'sandbox',
            code: 'READY',
            summary: 'Sandbox booted and reported READY.',
            bootMs,
          }),
        );

        frameRef.current.contentWindow?.postMessage({ channel: 'game_edit_host', type: 'RUN_TESTS' }, '*');
        if (testTimer === null) {
          testTimer = window.setTimeout(() => {
            if (done) {
              return;
            }
            done = true;
            report(
              makeEvaluatorResult({
                ok: false,
                source: 'sandbox',
                code: 'TEST_FAILED',
                summary: 'runTests did not respond before timeout.',
                bootMs: Math.max(0, Date.now() - started),
                errors: ['runTests timeout'],
              }),
            );
          }, timeoutMs);
        }
        return;
      }

      if (data.type === 'TEST_RESULT') {
        const ok = data.payload?.ok !== false;
        clearTimeout(readyTimer);
        if (testTimer !== null) {
          clearTimeout(testTimer);
        }
        if (ok) {
          done = true;
          report(
            makeEvaluatorResult({
              ok: true,
              source: 'sandbox',
              code: 'READY',
              summary:
                typeof data.payload?.message === 'string'
                  ? data.payload.message
                  : 'Sandbox tests passed.',
              bootMs: Math.max(0, Date.now() - started),
            }),
          );
        } else {
          done = true;
          report(
            makeEvaluatorResult({
              ok: false,
              source: 'sandbox',
              code: 'TEST_FAILED',
              summary: 'Sandbox runTests reported failure.',
              bootMs: Math.max(0, Date.now() - started),
              errors: [
                typeof data.payload?.message === 'string'
                  ? data.payload.message
                  : 'runTests returned failure.',
              ],
            }),
          );
        }
        return;
      }

      if (data.type === 'RUNTIME_ERROR' || data.type === 'UNHANDLED_REJECTION' || data.type === 'CONSOLE_ERROR') {
        done = true;
        clearTimeout(readyTimer);
        if (testTimer !== null) {
          clearTimeout(testTimer);
        }

        const message =
          typeof data.payload?.message === 'string'
            ? data.payload.message
            : 'Runtime error reported from sandbox.';

        report(
          makeEvaluatorResult({
            ok: false,
            source: 'sandbox',
            code:
              data.type === 'RUNTIME_ERROR'
                ? 'RUNTIME_ERROR'
                : data.type === 'UNHANDLED_REJECTION'
                  ? 'UNHANDLED_REJECTION'
                  : 'CONSOLE_ERROR',
            summary: message,
            bootMs: Math.max(0, Date.now() - started),
            errors: [message],
          }),
        );
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      clearTimeout(readyTimer);
      if (testTimer !== null) {
        clearTimeout(testTimer);
      }
      clearInterval(pingTimer);
      window.removeEventListener('message', handleMessage);
    };
  }, [packageData, runtimeNonce, timeoutMs]);

  if (!packageData) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 12,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
          color: 'var(--text-dim)',
          display: 'grid',
          placeItems: 'center',
          padding: 12,
          textAlign: 'center',
        }}
      >
        No package loaded yet. Create a project prompt to generate a mini-game.
      </div>
    );
  }

  return (
    <iframe
      key={runtimeNonce}
      ref={frameRef}
      title="Sandbox Preview"
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{
        width: '100%',
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--panel-2)',
      }}
    />
  );
}
