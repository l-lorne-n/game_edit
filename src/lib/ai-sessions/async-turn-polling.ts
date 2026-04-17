export const ASYNC_TURN_POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const;

export function getAsyncTurnPollDelay(attempt: number): number {
  if (attempt <= 0) {
    return ASYNC_TURN_POLL_DELAYS_MS[0];
  }

  return ASYNC_TURN_POLL_DELAYS_MS[Math.min(attempt, ASYNC_TURN_POLL_DELAYS_MS.length - 1)];
}

type SchedulerHandle = number | ReturnType<typeof setTimeout>;

type AsyncTurnPollControllerInput = {
  schedule: (callback: () => void, delayMs: number) => SchedulerHandle;
  cancel: (handle: SchedulerHandle) => void;
  onPoll: () => void;
};

export function createAsyncTurnPollController(input: AsyncTurnPollControllerInput) {
  let attempt = 0;
  let disposed = false;
  let pendingHandle: SchedulerHandle | null = null;

  function clearPendingHandle() {
    if (pendingHandle !== null) {
      input.cancel(pendingHandle);
      pendingHandle = null;
    }
  }

  return {
    scheduleNext() {
      if (disposed) {
        return;
      }

      const delayMs = getAsyncTurnPollDelay(attempt);
      attempt += 1;
      clearPendingHandle();
      pendingHandle = input.schedule(() => {
        pendingHandle = null;
        if (!disposed) {
          input.onPoll();
        }
      }, delayMs);
    },

    reset() {
      attempt = 0;
      clearPendingHandle();
    },

    dispose() {
      disposed = true;
      clearPendingHandle();
    },

    getAttempt() {
      return attempt;
    },
  };
}
