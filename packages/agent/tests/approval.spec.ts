import { describe, expect, it } from 'vitest';

import type {
  ConversationMessage,
  ModelResponse,
  ModelToolCall,
} from '@russet/ai';

import { AgentRunController } from '../src/agent/run.js';
import type { AgentEvent } from '../src/events/types.js';
import { executeToolBatch } from '../src/tools/execute.js';
import type {
  ToolExecutionContext,
  ToolExecutionGateway,
  ToolExecutionResult,
} from '../src/tools/types.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const success: ToolExecutionResult = {
  status: 'success',
  content: [{ type: 'text', text: 'File content.' }],
};

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  const state: {
    resolve: (() => void) | undefined;
  } = {
    resolve: undefined,
  };

  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });

  if (state.resolve === undefined) {
    throw new Error('Deferred promise was not initialized.');
  }

  return {
    promise,
    resolve: state.resolve,
  };
}

function scenario(
  run: AgentRunController,
  execute: ToolExecutionGateway['execute'],
  ids: readonly string[] = ['A', 'B'],
) {
  const calls: readonly ModelToolCall[] = ids.map((id) => ({
    toolCallId: id,
    name: 'fs.read',
    arguments: { path: id },
  }));

  const response: ModelResponse = {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: calls.map((call) => ({
      id: `block-${call.toolCallId}`,
      type: 'toolcall' as const,
      toolCall: call,
    })),
  };

  const conversation: ConversationMessage[] = [
    { role: 'user', text: 'Read the files.' },
    { role: 'assistant', response },
  ];

  const gateway: ToolExecutionGateway = {
    async listModelTools() {
      return [];
    },
    execute,
  };

  return {
    conversation,
    execute: () =>
      executeToolBatch({
        run,
        gateway,
        response,
        calls,
        conversation,
      }),
  };
}

describe('Tool approval coordination', () => {
  it('tracks approval, handler start, and execution result', async () => {
    const run = new AgentRunController('run-1');
    const events: AgentEvent[] = [];

    run.subscribe((event) => {
      events.push(event);
    });

    const approvalRequested = deferred();
    const approvalGranted = deferred();

    let reportUpdate: ToolExecutionContext['onUpdate'] | undefined;

    const operation = scenario(
      run,
      async (_, context) => {
        reportUpdate = context.onUpdate;

        context.onUpdate({
          type: 'approval.requested',
          approvalRequestId: 'approval-1',
          description: 'Read the selected file.',
        });

        approvalRequested.resolve();
        await approvalGranted.promise;

        context.onUpdate({
          type: 'approval.resolved',
          approvalRequestId: 'approval-1',
          decision: 'allow',
        });

        context.onUpdate({
          type: 'execution.started',
        });

        return success;
      },
      ['A'],
    );

    const pending = operation.execute();

    await approvalRequested.promise;

    expect(run.state).toEqual({
      kind: 'active',
      phase: 'awaiting_approval',
    });

    expect(
      events.some((event) => event.type === 'tool.execution.started'),
    ).toBe(false);

    approvalGranted.resolve();

    const batch = await pending;

    expect(batch).toEqual({
      resolution: 'continue',
      attempted: 1,
    });

    expect(run.state).toEqual({
      kind: 'active',
      phase: 'dispatching',
    });

    expect(operation.conversation.at(-1)).toMatchObject({
      role: 'tool_result',
      toolCallId: 'A',
      isError: false,
    });

    const types = events.map((event) => event.type);

    expect(types.indexOf('tool.dispatch.started')).toBeLessThan(
      types.indexOf('tool.approval.requested'),
    );

    expect(types.indexOf('tool.approval.requested')).toBeLessThan(
      types.indexOf('tool.approval.resolved'),
    );

    expect(types.indexOf('tool.approval.resolved')).toBeLessThan(
      types.indexOf('tool.execution.started'),
    );

    expect(types.indexOf('tool.execution.started')).toBeLessThan(
      types.indexOf('tool.dispatch.finished'),
    );

    const approval = events.find(
      (event) => event.type === 'tool.approval.requested',
    );

    expect(approval).toMatchObject({
      toolCallId: 'A',
      approvalRequestId: 'approval-1',
      description: 'Read the selected file.',
    });

    // Late runtime updates cannot reopen a settled invocation.
    const count = events.length;

    reportUpdate?.({
      type: 'execution.started',
    });

    expect(events).toHaveLength(count);
  });

  it('records denial without claiming handler execution', async () => {
    const run = new AgentRunController('run-2');
    const events: AgentEvent[] = [];
    const invoked: string[] = [];

    run.subscribe((event) => {
      events.push(event);
    });

    const operation = scenario(run, async (request, context) => {
      invoked.push(request.toolCall.toolCallId);

      context.onUpdate({
        type: 'approval.requested',
        approvalRequestId: 'approval-2',
        description: 'Read a protected file.',
      });

      context.onUpdate({
        type: 'approval.resolved',
        approvalRequestId: 'approval-2',
        decision: 'deny',
      });

      return {
        status: 'rejected',
        code: 'permission_denied',
        message: 'Permission denied.',
      };
    });

    const batch = await operation.execute();

    expect(batch.resolution).toBe('continue');
    expect(invoked).toEqual(['A']);

    expect(
      operation.conversation
        .filter((message) => message.role === 'tool_result')
        .map((message) => [message.toolCallId, message.isError]),
    ).toEqual([
      ['A', true],
      ['B', true],
    ]);

    expect(
      events.some((event) => event.type === 'tool.execution.started'),
    ).toBe(false);

    expect(events.some((event) => event.type === 'tool.skipped')).toBe(true);
  });

  it('handles unavailable headless approval as a rejection', async () => {
    const run = new AgentRunController('run-3');
    const events: AgentEvent[] = [];

    run.subscribe((event) => {
      events.push(event);
    });

    const operation = scenario(
      run,
      async () => ({
        status: 'rejected',
        code: 'approval_unavailable',
        message: 'An approval service is unavailable.',
      }),
      ['A'],
    );

    const batch = await operation.execute();

    expect(batch).toEqual({
      resolution: 'continue',
      attempted: 1,
    });

    expect(operation.conversation.at(-1)).toMatchObject({
      role: 'tool_result',
      isError: true,
    });

    expect(
      events.some(
        (event) =>
          event.type === 'tool.approval.resolved' ||
          event.type === 'tool.execution.started',
      ),
    ).toBe(false);
  });

  it('cancels while Runtime is waiting for approval', async () => {
    const run = new AgentRunController('run-4');
    const approvalRequested = deferred();

    const invoked: string[] = [];

    const operation = scenario(run, async (request, context) => {
      invoked.push(request.toolCall.toolCallId);

      context.onUpdate({
        type: 'approval.requested',
        approvalRequestId: 'approval-4',
        description: 'Approval required.',
      });

      approvalRequested.resolve();

      return new Promise<ToolExecutionResult>((resolve) => {
        const cancel = () => {
          resolve({
            status: 'cancelled',
            message: 'Approval cancelled.',
            sideEffects: 'none',
          });
        };

        if (context.signal.aborted) {
          cancel();
        } else {
          context.signal.addEventListener('abort', cancel, {
            once: true,
          });
        }
      });
    });

    const pending = operation.execute();

    await approvalRequested.promise;

    expect(run.state).toEqual({
      kind: 'active',
      phase: 'awaiting_approval',
    });

    run.cancel('User cancelled.');

    const batch = await pending;

    expect(batch).toEqual({
      resolution: 'cancelled',
      attempted: 1,
    });

    expect(invoked).toEqual(['A']);

    expect(
      operation.conversation.filter(
        (message) => message.role === 'tool_result',
      ),
    ).toHaveLength(2);
  });

  it('does not invoke Runtime after cancellation during dispatch', async () => {
    const run = new AgentRunController('run-5');

    run.subscribe((event) => {
      if (event.type === 'tool.dispatch.started') {
        run.cancel('Cancelled before invocation.');
      }
    });

    let invocations = 0;

    const operation = scenario(run, async () => {
      invocations++;
      return success;
    });

    const batch = await operation.execute();

    expect(batch).toEqual({
      resolution: 'cancelled',
      attempted: 0,
    });

    expect(invocations).toBe(0);

    expect(
      operation.conversation
        .filter((message) => message.role === 'tool_result')
        .map((message) => message.isError),
    ).toEqual([true, true]);
  });
});
