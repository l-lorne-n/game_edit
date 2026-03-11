'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import GamePreview from '@/components/GamePreview';
import PromptPanel from '@/components/PromptPanel';
import StatusRail from '@/components/StatusRail';
import Workbench from '@/components/Workbench';
import type { ModelAttempt } from '@/lib/ai/types';
import { validateDsl } from '@/lib/game/validate';
import {
  ARCHIVE_STORAGE_KEY,
  archiveDescendantIds,
  buildArchiveDisplay,
  dslHash,
  makeArchiveEntry,
  pushArchive,
  removeArchiveSubtree,
  sanitizeArchiveEntries,
} from '@/lib/state/versioning';
import {
  initialSessionState,
  type ModifyBaseType,
  type SessionState,
} from '@/lib/state/session';
import styles from '@/components/AppShell.module.css';

type HudSnapshot = {
  score: number;
  lives: number;
  timeLeftSec: number;
  status: 'running' | 'won' | 'lost';
};

type ApiSuccess = {
  ok: true;
  dsl: NonNullable<SessionState['liveDsl']>;
  validation: NonNullable<SessionState['liveValidation']>;
  repaired: boolean;
  fallbackUsed: boolean;
  source: Exclude<SessionState['dslSource'], 'archive' | null>;
  provider: string;
  model: string;
  statusMessage: string;
  attempts?: ModelAttempt[];
};

function nextStatusFromResult(result: ApiSuccess): SessionState['status'] {
  if (result.fallbackUsed) {
    return 'fallback';
  }
  if (result.repaired) {
    return 'repaired';
  }
  return 'ready';
}

function deriveSourceMeta(result: ApiSuccess): {
  attempts: ModelAttempt[];
  dslSource: SessionState['dslSource'];
  finalSourceProvider: string | null;
  finalSourceModel: string | null;
  lastAttemptProvider: string | null;
  lastAttemptModel: string | null;
} {
  const attempts = result.attempts ?? [];
  const lastAttempt = attempts.at(-1);
  const lastSuccess = [...attempts].reverse().find(attempt => attempt.outcome === 'success');
  const fromModel = result.source === 'model' || result.source === 'repair';

  return {
    attempts,
    dslSource: result.source,
    finalSourceProvider: fromModel ? (lastSuccess?.provider ?? result.provider) : null,
    finalSourceModel: fromModel ? (lastSuccess?.model ?? result.model) : null,
    lastAttemptProvider: lastAttempt?.provider ?? null,
    lastAttemptModel: lastAttempt?.model ?? null,
  };
}

function resolveModifyBase(
  state: SessionState,
  baseType: ModifyBaseType,
  archiveId: string,
): { dsl: NonNullable<SessionState['liveDsl']>; parentArchiveId: string | null } | null {
  if (baseType === 'archive') {
    const archive = state.archives.find(entry => entry.id === archiveId);
    if (!archive) {
      return null;
    }
    return {
      dsl: archive.dsl,
      parentArchiveId: archive.id,
    };
  }

  if (baseType === 'staged') {
    if (state.stagedDsl) {
      return {
        dsl: state.stagedDsl,
        parentArchiveId: state.stagedParentArchiveId,
      };
    }
    if (state.liveDsl) {
      return {
        dsl: state.liveDsl,
        parentArchiveId: state.liveParentArchiveId,
      };
    }
    return null;
  }

  if (state.liveDsl) {
    return {
      dsl: state.liveDsl,
      parentArchiveId: state.liveParentArchiveId,
    };
  }

  return null;
}

function archiveOptionLabel(input: {
  title: string;
  createdAt: string;
  depth: number;
  parentTitle: string | null;
}): string {
  const indent = input.depth > 0 ? `${'  '.repeat(input.depth)}|- ` : '';
  const suffix = input.parentTitle ? ` [from: ${input.parentTitle}]` : '';
  return `${indent}${input.title} (${new Date(input.createdAt).toLocaleString()})${suffix}`;
}

export default function AppShell() {
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [runtimeNonce, setRuntimeNonce] = useState(0);
  const [selectedArchiveId, setSelectedArchiveId] = useState('');
  const [modifyBaseType, setModifyBaseType] = useState<ModifyBaseType>('staged');
  const [modifyArchiveId, setModifyArchiveId] = useState('');
  const latestRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch('/api/health');
        const json = (await response.json()) as {
          provider: string;
          models: { logic: string };
        };
        if (cancelled) {
          return;
        }
        setSession(prev => ({
          ...prev,
          provider: json.provider,
          model: json.models.logic,
        }));
      } catch {
        if (cancelled) {
          return;
        }
        setSession(prev => ({
          ...prev,
          statusMessage: 'Health check failed. Routes can still run locally.',
        }));
      }
    }

    loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      const archives = sanitizeArchiveEntries(parsed);
      setSession(prev => ({
        ...prev,
        archives,
      }));
      if (archives.length > 0) {
        setSelectedArchiveId(archives[0].id);
      }
    } catch {
      // ignore malformed local storage
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(session.archives));
    } catch {
      // ignore storage quota issues for MVP
    }
  }, [session.archives]);

  useEffect(() => {
    if (!selectedArchiveId && session.archives.length > 0) {
      setSelectedArchiveId(session.archives[0].id);
      return;
    }
    if (selectedArchiveId && !session.archives.some(entry => entry.id === selectedArchiveId)) {
      setSelectedArchiveId(session.archives[0]?.id ?? '');
    }
  }, [selectedArchiveId, session.archives]);

  useEffect(() => {
    if (!modifyArchiveId && session.archives.length > 0) {
      setModifyArchiveId(session.archives[0].id);
      return;
    }
    if (modifyArchiveId && !session.archives.some(entry => entry.id === modifyArchiveId)) {
      setModifyArchiveId(session.archives[0]?.id ?? '');
    }
  }, [modifyArchiveId, session.archives]);

  useEffect(() => {
    if (modifyBaseType === 'staged' && !session.stagedDsl) {
      if (session.liveDsl) {
        setModifyBaseType('live');
        return;
      }
      if (session.archives.length > 0) {
        setModifyBaseType('archive');
      }
      return;
    }

    if (modifyBaseType === 'live' && !session.liveDsl) {
      if (session.stagedDsl) {
        setModifyBaseType('staged');
        return;
      }
      if (session.archives.length > 0) {
        setModifyBaseType('archive');
      }
      return;
    }

    if (modifyBaseType === 'archive' && session.archives.length === 0) {
      if (session.stagedDsl) {
        setModifyBaseType('staged');
        return;
      }
      if (session.liveDsl) {
        setModifyBaseType('live');
      }
    }
  }, [modifyBaseType, session.archives, session.liveDsl, session.stagedDsl]);

  const busy = session.status === 'generating' || session.status === 'validating';

  useEffect(() => {
    if (!busy) {
      setLoadingSeconds(0);
      return;
    }

    const timer = window.setInterval(() => {
      setLoadingSeconds(prev => prev + 1);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [busy]);

  const previewTitle = useMemo(() => {
    if (!session.liveDsl) {
      return 'No live version yet';
    }
    if (session.stagedDsl) {
      return `${session.liveDsl.meta.title} (staged update ready)`;
    }
    return session.liveDsl.meta.title;
  }, [session.liveDsl, session.stagedDsl]);

  const archiveDisplay = useMemo(() => buildArchiveDisplay(session.archives), [session.archives]);
  const hasEditableGame = Boolean(session.stagedDsl ?? session.liveDsl ?? session.archives.length > 0);
  const canUpdate = Boolean(session.stagedDsl) && !busy;
  const modifyBaseResolved = useMemo(
    () => resolveModifyBase(session, modifyBaseType, modifyArchiveId),
    [modifyArchiveId, modifyBaseType, session],
  );
  const modifyArchiveOptions = useMemo(
    () =>
      archiveDisplay.map(item => ({
        id: item.entry.id,
        label: archiveOptionLabel({
          title: item.entry.title,
          createdAt: item.entry.createdAt,
          depth: item.depth,
          parentTitle: item.parentTitle,
        }),
      })),
    [archiveDisplay],
  );
  const selectedArchive = useMemo(
    () => session.archives.find(entry => entry.id === selectedArchiveId) ?? null,
    [selectedArchiveId, session.archives],
  );

  function beginRequest(): number {
    latestRequestRef.current += 1;
    return latestRequestRef.current;
  }

  function isLatestRequest(requestId: number): boolean {
    return latestRequestRef.current === requestId;
  }

  async function handleGenerate(prompt: string) {
    const requestId = beginRequest();
    setSession(prev => ({
      ...prev,
      status: 'generating',
      statusMessage: 'Generating staged game DSL with logic model...',
      prompt,
    }));

    try {
      const response = await fetch('/api/game/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          lastKnownGood: session.lastKnownGoodLive ?? session.liveDsl,
        }),
      });

      const json = (await response.json()) as ApiSuccess | { ok: false; error?: string };
      if (!isLatestRequest(requestId)) {
        return;
      }
      if (!response.ok || !('ok' in json) || !json.ok) {
        throw new Error('error' in json ? json.error : 'generation failed');
      }

      setSession(prev => {
        const status = nextStatusFromResult(json);
        const sourceMeta = deriveSourceMeta(json);

        if (!prev.liveDsl) {
          return {
            ...prev,
            status,
            statusMessage: `${json.statusMessage} Auto-applied as first live version.`,
            provider: json.provider,
            model: json.model,
            liveDsl: json.dsl,
            stagedDsl: null,
            stagedParentArchiveId: null,
            lastKnownGoodLive: json.dsl,
            liveParentArchiveId: null,
            liveValidation: json.validation,
            stagedValidation: null,
            repaired: json.repaired,
            fallbackUsed: json.fallbackUsed,
            dslSource: sourceMeta.dslSource,
            finalSourceProvider: sourceMeta.finalSourceProvider,
            finalSourceModel: sourceMeta.finalSourceModel,
            lastAttemptProvider: sourceMeta.lastAttemptProvider,
            lastAttemptModel: sourceMeta.lastAttemptModel,
            attempts: sourceMeta.attempts,
          };
        }

        const sameAsLive = dslHash(prev.liveDsl) === dslHash(json.dsl);
        return {
          ...prev,
          status,
          statusMessage: sameAsLive
            ? `${json.statusMessage} Live version unchanged.`
            : `${json.statusMessage} Staged version ready. Click Update to apply.`,
          provider: json.provider,
          model: json.model,
          stagedDsl: sameAsLive ? prev.stagedDsl : json.dsl,
          stagedParentArchiveId: sameAsLive ? prev.stagedParentArchiveId : null,
          stagedValidation: sameAsLive ? prev.stagedValidation : json.validation,
          repaired: json.repaired,
          fallbackUsed: json.fallbackUsed,
          dslSource: sourceMeta.dslSource,
          finalSourceProvider: sourceMeta.finalSourceProvider,
          finalSourceModel: sourceMeta.finalSourceModel,
          lastAttemptProvider: sourceMeta.lastAttemptProvider,
          lastAttemptModel: sourceMeta.lastAttemptModel,
          attempts: sourceMeta.attempts,
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestId)) {
        return;
      }
      setSession(prev => ({
        ...prev,
        status: 'error',
        statusMessage:
          error instanceof Error ? `Generation failed: ${error.message}` : 'Generation failed.',
      }));
    }
  }

  async function handleModify(instruction: string) {
    const base = modifyBaseResolved;
    if (!base) {
      setSession(prev => ({
        ...prev,
        status: 'error',
        statusMessage: 'No valid modify baseline available.',
      }));
      return;
    }

    const baseDsl = base.dsl;
    const baseParentArchiveId = base.parentArchiveId;
    const baseLabel =
      modifyBaseType === 'archive'
        ? 'selected archive'
        : modifyBaseType === 'staged'
          ? 'staged/live baseline'
          : 'live baseline';

    const requestId = beginRequest();
    setSession(prev => ({
      ...prev,
      status: 'validating',
      statusMessage: `Applying modification from ${baseLabel} and validating...`,
      latestInstruction: instruction,
    }));

    try {
      const response = await fetch('/api/game/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction,
          currentDsl: baseDsl,
          lastKnownGood: session.lastKnownGoodLive ?? session.liveDsl,
        }),
      });

      const json = (await response.json()) as ApiSuccess | { ok: false; error?: string };
      if (!isLatestRequest(requestId)) {
        return;
      }
      if (!response.ok || !('ok' in json) || !json.ok) {
        throw new Error('error' in json ? json.error : 'modification failed');
      }

      setSession(prev => {
        const status = nextStatusFromResult(json);
        const sourceMeta = deriveSourceMeta(json);

        if (!prev.liveDsl) {
          return {
            ...prev,
            status,
            statusMessage: `${json.statusMessage} Auto-applied as first live version.`,
            provider: json.provider,
            model: json.model,
            liveDsl: json.dsl,
            stagedDsl: null,
            stagedParentArchiveId: null,
            lastKnownGoodLive: json.dsl,
            liveParentArchiveId: baseParentArchiveId,
            liveValidation: json.validation,
            stagedValidation: null,
            repaired: json.repaired,
            fallbackUsed: json.fallbackUsed,
            dslSource: sourceMeta.dslSource,
            finalSourceProvider: sourceMeta.finalSourceProvider,
            finalSourceModel: sourceMeta.finalSourceModel,
            lastAttemptProvider: sourceMeta.lastAttemptProvider,
            lastAttemptModel: sourceMeta.lastAttemptModel,
            attempts: sourceMeta.attempts,
          };
        }

        const sameAsLive = dslHash(prev.liveDsl) === dslHash(json.dsl);
        return {
          ...prev,
          status,
          statusMessage: sameAsLive
            ? `${json.statusMessage} Live version unchanged.`
            : `${json.statusMessage} Staged modification ready. Click Update to apply.`,
          provider: json.provider,
          model: json.model,
          stagedDsl: sameAsLive ? prev.stagedDsl : json.dsl,
          stagedParentArchiveId: sameAsLive ? prev.stagedParentArchiveId : baseParentArchiveId,
          stagedValidation: sameAsLive ? prev.stagedValidation : json.validation,
          repaired: json.repaired,
          fallbackUsed: json.fallbackUsed,
          dslSource: sourceMeta.dslSource,
          finalSourceProvider: sourceMeta.finalSourceProvider,
          finalSourceModel: sourceMeta.finalSourceModel,
          lastAttemptProvider: sourceMeta.lastAttemptProvider,
          lastAttemptModel: sourceMeta.lastAttemptModel,
          attempts: sourceMeta.attempts,
        };
      });
    } catch (error) {
      if (!isLatestRequest(requestId)) {
        return;
      }
      setSession(prev => ({
        ...prev,
        status: 'error',
        statusMessage:
          error instanceof Error ? `Modification failed: ${error.message}` : 'Modification failed.',
      }));
    }
  }

  function handlePlay(): void {
    if (!session.liveDsl) {
      return;
    }
    setRuntimeNonce(prev => prev + 1);
    setSession(prev => ({
      ...prev,
      statusMessage: 'Restarted current live version.',
    }));
  }

  function handleUpdate(): void {
    if (!session.stagedDsl) {
      return;
    }

    setRuntimeNonce(prev => prev + 1);
    setSession(prev => ({
      ...prev,
      status: 'ready',
      statusMessage: 'Updated live version from staged draft.',
      liveDsl: prev.stagedDsl,
      stagedDsl: null,
      liveParentArchiveId: prev.stagedParentArchiveId,
      stagedParentArchiveId: null,
      lastKnownGoodLive: prev.stagedDsl,
      liveValidation: prev.stagedValidation,
      stagedValidation: null,
    }));
  }

  function handleArchive(): void {
    if (!session.liveDsl) {
      return;
    }

    const archiveEntry = makeArchiveEntry(session.liveDsl, 'live', session.liveParentArchiveId);
    setSession(prev => ({
      ...prev,
      archives: pushArchive(prev.archives, archiveEntry),
      statusMessage: 'Archived current live version.',
    }));
    setSelectedArchiveId(archiveEntry.id);
  }

  function handleRestore(): void {
    if (!selectedArchiveId) {
      return;
    }

    const selected = session.archives.find(entry => entry.id === selectedArchiveId);
    if (!selected) {
      return;
    }

    const checked = validateDsl(selected.dsl);
    if (!checked.ok) {
      setSession(prev => ({
        ...prev,
        status: 'error',
        statusMessage: 'Selected archive failed validation and could not be restored.',
      }));
      return;
    }

    setRuntimeNonce(prev => prev + 1);
    setSession(prev => ({
      ...prev,
      status: 'ready',
      statusMessage: `Restored archived version: ${selected.title}.`,
      liveDsl: selected.dsl,
      stagedDsl: null,
      liveParentArchiveId: selected.id,
      stagedParentArchiveId: null,
      lastKnownGoodLive: selected.dsl,
      liveValidation: checked.validation,
      stagedValidation: null,
      fallbackUsed: false,
      repaired: false,
      dslSource: 'archive',
      finalSourceProvider: null,
      finalSourceModel: null,
    }));
  }

  function handleDeleteArchive(): void {
    if (!selectedArchiveId) {
      return;
    }

    const target = session.archives.find(entry => entry.id === selectedArchiveId);
    if (!target) {
      return;
    }

    const descendants = archiveDescendantIds(session.archives, selectedArchiveId);
    if (descendants.length > 0) {
      const confirmed = window.confirm(
        `Delete archive "${target.title}" and ${descendants.length} derived version(s)? This action cannot be undone.`,
      );
      if (!confirmed) {
        return;
      }
    }

    const removed = removeArchiveSubtree(session.archives, selectedArchiveId);
    const removedSet = new Set(removed.removedIds);
    setSession(prev => ({
      ...prev,
      archives: removed.entries,
      liveParentArchiveId:
        prev.liveParentArchiveId && removedSet.has(prev.liveParentArchiveId)
          ? null
          : prev.liveParentArchiveId,
      stagedParentArchiveId:
        prev.stagedParentArchiveId && removedSet.has(prev.stagedParentArchiveId)
          ? null
          : prev.stagedParentArchiveId,
      statusMessage:
        descendants.length > 0
          ? `Deleted archive branch: ${target.title} and ${descendants.length} derived version(s).`
          : `Deleted archive: ${target.title}.`,
    }));
  }

  return (
    <main className={styles.main}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>AI Dodge Prototype Editor</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
          Left: prompt | Center: status | Right: live playable preview
        </p>
      </header>

      <section className={styles.grid}>
        <PromptPanel
          onGenerate={handleGenerate}
          onModify={handleModify}
          disabled={busy}
          hasEditableGame={hasEditableGame}
          modifyBaseType={modifyBaseType}
          onModifyBaseTypeChange={setModifyBaseType}
          modifyArchiveId={modifyArchiveId}
          onModifyArchiveIdChange={setModifyArchiveId}
          modifyArchiveOptions={modifyArchiveOptions}
        />

        <StatusRail
          status={session.status}
          message={session.statusMessage}
          provider={session.provider}
          model={session.model}
          repaired={session.repaired}
          fallbackUsed={session.fallbackUsed}
          loadingSeconds={loadingSeconds}
        />

        <section className={styles.previewPanel}>
          <div className={styles.previewHeaderRow}>
            <strong>{previewTitle}</strong>
            <div className={styles.previewControls}>
              <button type="button" onClick={handlePlay} disabled={!session.liveDsl} className={styles.ctrlBtn}>
                Play
              </button>
              <button type="button" onClick={handleUpdate} disabled={!canUpdate} className={styles.ctrlBtnPrimary}>
                Update
              </button>
              <button type="button" onClick={handleArchive} disabled={!session.liveDsl} className={styles.ctrlBtn}>
                Archive
              </button>
              <select
                value={selectedArchiveId}
                onChange={event => setSelectedArchiveId(event.target.value)}
                className={styles.archiveSelect}
              >
                <option value="">选择归档</option>
                {archiveDisplay.map(item => (
                  <option key={item.entry.id} value={item.entry.id}>
                    {archiveOptionLabel({
                      title: item.entry.title,
                      createdAt: item.entry.createdAt,
                      depth: item.depth,
                      parentTitle: item.parentTitle,
                    })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleRestore}
                disabled={!selectedArchiveId}
                className={styles.ctrlBtn}
              >
                Restore
              </button>
              <button
                type="button"
                onClick={handleDeleteArchive}
                disabled={!selectedArchiveId}
                className={styles.ctrlBtn}
              >
                Delete Archive
              </button>
              <button
                type="button"
                onClick={() => setWorkbenchOpen(prev => !prev)}
                className={styles.ctrlBtn}
              >
                {workbenchOpen ? '隐藏 Workbench' : '打开 Workbench'}
              </button>
            </div>
          </div>

          <div style={{ color: 'var(--text-dim)', marginBottom: 8, fontSize: 13 }}>
            Controls: WASD / Arrow Keys |{' '}
            {hud
              ? `Score ${hud.score} | Lives ${hud.lives} | Time ${hud.timeLeftSec.toFixed(1)}s | ${hud.status}`
              : session.liveDsl
                ? 'Live runtime ready'
                : 'No live runtime yet'}
          </div>

          <div className={styles.previewBody}>
            <GamePreview dsl={session.liveDsl} runtimeNonce={runtimeNonce} onHudChange={setHud} />
          </div>
        </section>
      </section>

      <Workbench
        open={workbenchOpen}
        liveDsl={session.liveDsl}
        stagedDsl={session.stagedDsl}
        liveValidation={session.liveValidation}
        stagedValidation={session.stagedValidation}
        provider={session.provider}
        model={session.model}
        repaired={session.repaired}
        fallbackUsed={session.fallbackUsed}
        dslSource={session.dslSource}
        finalSourceProvider={session.finalSourceProvider}
        finalSourceModel={session.finalSourceModel}
        lastAttemptProvider={session.lastAttemptProvider}
        lastAttemptModel={session.lastAttemptModel}
        attempts={session.attempts}
        archives={session.archives}
        selectedArchive={selectedArchive}
      />
    </main>
  );
}
