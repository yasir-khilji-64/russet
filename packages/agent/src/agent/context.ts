import type {
  AgentContextProvider,
  AgentContextRequest,
  PreparedAgentContext,
} from './types.js';

export function prepareContextUntilCancelled(
  provider: AgentContextProvider,
  request: AgentContextRequest,
): Promise<PreparedAgentContext> {
  const { signal } = request;

  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(callback: () => void): void {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    }

    function onAbort(): void {
      settle(() => reject(signal.reason));
    }

    signal.addEventListener('abort', onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
      return;
    }

    try {
      void provider.prepare(request).then(
        (prepared) => settle(() => resolve(prepared)),
        (error: unknown) => settle(() => reject(error)),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
