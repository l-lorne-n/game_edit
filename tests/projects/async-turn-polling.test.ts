import { describe, expect, it, vi } from 'vitest';

import { createAsyncTurnPollController, getAsyncTurnPollDelay } from '@/lib/ai-sessions/async-turn-polling';

describe('async turn polling helpers', () => {
  it('caps delay progression at 15 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(getAsyncTurnPollDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('schedules polling with backoff and resets to the initial delay', () => {
    const onPoll = vi.fn();
    const scheduled: Array<{ handle: number; delayMs: number; callback: () => void }> = [];
    const cancelled: number[] = [];
    let nextHandle = 1;

    const controller = createAsyncTurnPollController({
      schedule: (callback, delayMs) => {
        const handle = nextHandle++;
        scheduled.push({ handle, delayMs, callback });
        return handle;
      },
      cancel: handle => {
        cancelled.push(handle as number);
      },
      onPoll,
    });

    controller.scheduleNext();
    controller.scheduleNext();
    controller.scheduleNext();

    expect(scheduled.map(entry => entry.delayMs)).toEqual([1000, 2000, 4000]);
    expect(cancelled).toEqual([1, 2]);
    expect(controller.getAttempt()).toBe(3);

    controller.reset();
    controller.scheduleNext();

    expect(controller.getAttempt()).toBe(1);
    expect(scheduled.at(-1)?.delayMs).toBe(1000);
    expect(cancelled).toContain(3);
  });

  it('stops pending callbacks after dispose', () => {
    const onPoll = vi.fn();
    let pendingCallback: (() => void) | null = null;

    const controller = createAsyncTurnPollController({
      schedule: callback => {
        pendingCallback = callback;
        return 1;
      },
      cancel: () => {
        pendingCallback = null;
      },
      onPoll,
    });

    controller.scheduleNext();
    controller.dispose();
    pendingCallback?.();

    expect(onPoll).not.toHaveBeenCalled();
  });
});
