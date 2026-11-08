import type { ModelToolDefinition } from '@russet/ai';

import type { ToolExecutionGateway, ToolExecutionResult } from './types.js';

// Tool discovery must not execute handlers.
export function listToolsUntilCancelled(
  gateway: ToolExecutionGateway,
  signal: AbortSignal,
): Promise<readonly ModelToolDefinition[]> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };

    signal.addEventListener('abort', onAbort, {
      once: true,
    });

    try {
      void gateway.listModelTools({ signal }).then(
        (definitions) => {
          signal.removeEventListener('abort', onAbort);
          resolve(definitions);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}

// A cancellation deadline does not terminate the operation.
export function awaitExecutionOutcome(
  operation: Promise<ToolExecutionResult>,
  signal: AbortSignal,
  maxCancellationWaitMs: number,
): Promise<ToolExecutionResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const resolveOnce = (result: ToolExecutionResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }

      timer = setTimeout(() => {
        resolveOnce({
          status: 'cancelled',
          sideEffects: 'possible',
          message:
            'Runtime did not confirm the operation outcome after cancellation.',
        });
      }, maxCancellationWaitMs);
    };

    signal.addEventListener('abort', onAbort, {
      once: true,
    });

    if (signal.aborted) {
      onAbort();
    }

    void operation.then(resolveOnce, rejectOnce);
  });
}
