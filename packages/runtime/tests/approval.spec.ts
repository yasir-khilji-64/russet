import { afterEach, expect, it, vi } from 'vitest';

import { awaitApproval } from '../src/approvals/once.js';
import type { ApprovalBroker, ApprovalRequest } from '../src/approvals/once.js';

afterEach(() => {
  vi.useRealTimers();
});

it('aborts a pending broker when approval expires', async () => {
  vi.useFakeTimers();

  const expiresAt = Date.now() + 1_000;

  const request: ApprovalRequest = {
    id: 'approval-1',
    fingerprint: 'fingerprint-1',
    description: 'Create a file',
    expiresAt,
    operation: {
      toolName: 'fs_create',
      target: 'example.txt',
      arguments: {
        path: 'example.txt',
        content: 'Example',
      },
    },
  };

  let brokerSignal: AbortSignal | undefined;

  const broker: ApprovalBroker = {
    request(_request, signal) {
      brokerSignal = signal;

      return new Promise<'allow' | 'deny'>(() => {
        // Deliberately unresponsive broker.
      });
    },
  };

  const parent = new AbortController();

  const outcome = awaitApproval(broker, request, parent.signal);

  await vi.advanceTimersByTimeAsync(1_000);

  expect(await outcome).toBe('expired');
  expect(brokerSignal?.aborted).toBe(true);

  // Expiration must not cancel the Agent's parent signal.
  expect(parent.signal.aborted).toBe(false);
});
