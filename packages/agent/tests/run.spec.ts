import { describe, expect, it } from 'vitest';

import { AgentRunController, AgentRunManager } from '../src/agent/run.js';

describe('AgentRunController', () => {
  it('settles with the specified terminal result', async () => {
    const run = new AgentRunController('run-1');

    expect(run.finish('completed')).toBe(true);

    await expect(run.result).resolves.toEqual({
      runId: 'run-1',
      status: 'completed',
    });
  });

  it('settles only once', async () => {
    const run = new AgentRunController('run-1');

    expect(run.finish('failed')).toBe(true);
    expect(run.finish('completed')).toBe(false);

    await expect(run.result).resolves.toEqual({
      runId: 'run-1',
      status: 'failed',
    });
  });

  it('propagates external cancellation', async () => {
    const external = new AbortController();
    const run = new AgentRunController('run-1', external.signal);

    const reason = new Error('Cancelled by caller');
    external.abort(reason);

    expect(run.signal.aborted).toBe(true);
    expect(run.signal.reason).toBe(reason);

    run.finish('cancelled');

    await expect(run.result).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('recognizes an already aborted signal', async () => {
    const external = new AbortController();
    external.abort('cancelled');

    const run = new AgentRunController('run-1', external.signal);

    expect(run.signal.aborted).toBe(true);

    run.finish('cancelled');

    await expect(run.result).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('does not settle immediately on cancellation', async () => {
    const run = new AgentRunController('run-1');

    let settled = false;

    void run.result.then(() => {
      settled = true;
    });

    run.cancel('User cancelled');
    await Promise.resolve();

    expect(run.signal.aborted).toBe(true);
    expect(settled).toBe(false);

    expect(run.finish('cancelled')).toBe(true);

    await run.result;
    expect(settled).toBe(true);
  });

  it('does not allow successful completion after cancellation', () => {
    const run = new AgentRunController('run-1');

    run.cancel();

    expect(() => run.finish('completed')).toThrow(
      'A cancelled run cannot complete successfully.',
    );

    expect(run.finish('cancelled')).toBe(true);
  });

  it('ignores cancellation after settlement', async () => {
    const run = new AgentRunController('run-1');

    run.finish('completed');
    run.cancel();

    expect(run.signal.aborted).toBe(false);

    await expect(run.result).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('rejects an empty run identity', () => {
    expect(() => new AgentRunController('')).toThrow(
      'Agent run ID must not be empty.',
    );
  });
});

describe('AgentRunManager', () => {
  it('allows only one active run', () => {
    const manager = new AgentRunManager();

    const first = manager.createRun('run-1');

    expect(manager.activeRun).toBe(first);

    expect(() => manager.createRun('run-2')).toThrow(
      'An agent run is already active.',
    );
  });

  it('releases ownership after settlement', () => {
    const manager = new AgentRunManager();

    const first = manager.createRun('run-1');

    first.finish('completed');

    expect(manager.activeRun).toBeUndefined();

    const second = manager.createRun('run-2');

    expect(manager.activeRun).toBe(second);
  });

  it('retains ownership during cancellation', () => {
    const manager = new AgentRunManager();

    const run = manager.createRun('run-1');

    run.cancel();

    expect(manager.activeRun).toBe(run);

    expect(() => manager.createRun('run-2')).toThrow(
      'An agent run is already active.',
    );

    run.finish('cancelled');

    expect(manager.activeRun).toBeUndefined();
  });
});
