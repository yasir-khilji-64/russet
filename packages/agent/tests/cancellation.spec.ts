import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  InferenceEngine,
  ModelEvent,
  ModelResponse,
  ModelStream,
} from '@russet/ai';

import { createAgent } from '../src/index.js';
import type {
  ToolExecutionGateway,
  ToolExecutionUpdate,
} from '../src/tools/types.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function modelStub(
  response: ModelResponse,
  onStream: () => void,
): InferenceEngine {
  return {
    stream(): ModelStream {
      onStream();

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          yield {
            type: 'response.completed',
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        async result(): Promise<ModelResponse> {
          return response;
        },
      };
    },
  };
}

const response: ModelResponse = {
  requestId: 'req-1',
  messageId: 'msg-1',
  model,
  finishReason: 'tool_use',
  thinkingAvailability: 'unavailable',
  blocks: ['A', 'B'].map((id) => ({
    id: `block-${id}`,
    type: 'toolcall' as const,
    toolCall: {
      toolCallId: id,
      name: 'fs.read',
      arguments: { path: id },
    },
  })),
};

function deferred<T>() {
  const state: {
    resolve: ((value: T) => void) | undefined;
  } = { resolve: undefined };

  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });

  if (state.resolve === undefined) {
    throw new Error('Uninitialized promise.');
  }

  return {
    promise,
    resolve: state.resolve,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Agent cancellation', () => {
  it('cancels unresponsive tool discovery', async () => {
    let inferenceCalls = 0;
    const discovery = deferred<AbortSignal>();

    const gateway: ToolExecutionGateway = {
      listModelTools(context) {
        discovery.resolve(context.signal);
        return new Promise(() => {});
      },

      async execute() {
        throw new Error('Execution should not begin.');
      },
    };

    const agent = createAgent({
      inference: modelStub(response, () => {
        inferenceCalls++;
      }),
      toolGateway: gateway,
    });

    const run = agent.start({
      message: 'Read',
      model,
    });

    const signal = await discovery.promise;
    run.cancel();

    expect(signal.aborted).toBe(true);
    expect((await run.result).status).toBe('cancelled');
    expect(inferenceCalls).toBe(0);
  });

  it('interrupts an unresponsive operation after the grace period', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    });

    const started = deferred<void>();

    let lateUpdate: ((update: ToolExecutionUpdate) => void) | undefined;

    let executions = 0;

    const gateway: ToolExecutionGateway = {
      async listModelTools() {
        return [];
      },

      execute(_request, context) {
        executions++;
        lateUpdate = context.onUpdate;

        context.onUpdate({
          type: 'approval.requested',
          approvalRequestId: 'approval-1',
          description: 'Read a file',
        });

        started.resolve();

        return new Promise(() => {});
      },
    };

    const agent = createAgent({
      inference: modelStub(response, () => {}),
      toolGateway: gateway,
    });

    const eventTypes: string[] = [];

    const run = agent.start(
      {
        message: 'Read',
        model,
        limits: { maxCancellationWaitMs: 10 },
      },
      (event) => {
        eventTypes.push(event.type);
      },
    );

    await started.promise;

    expect(run.state).toMatchObject({
      kind: 'active',
      phase: 'awaiting_approval',
    });

    run.cancel();

    await vi.advanceTimersByTimeAsync(10);

    const outcome = await run.result;

    expect(outcome.status).toBe('interrupted');
    expect(executions).toBe(1);

    expect(
      agent
        .getConversation()
        .filter((message) => message.role === 'tool_result'),
    ).toHaveLength(2);

    const eventCount = eventTypes.length;

    lateUpdate?.({ type: 'execution.started' });

    expect(eventTypes).toHaveLength(eventCount);

    expect(() =>
      agent.start({
        message: 'Again',
        model,
      }),
    ).toThrow('requires reconciliation');
  });

  it('records confirmed success after cancellation', async () => {
    let run: ReturnType<ReturnType<typeof createAgent>['start']> | undefined =
      undefined;

    let executions = 0;

    const gateway: ToolExecutionGateway = {
      async listModelTools() {
        return [];
      },

      async execute() {
        executions++;
        run?.cancel();

        return {
          status: 'success',
          content: [
            {
              type: 'text',
              text: 'completed',
            },
          ],
        };
      },
    };

    const agent = createAgent({
      inference: modelStub(response, () => {}),
      toolGateway: gateway,
    });

    run = agent.start({
      message: 'Read',
      model,
    });

    expect((await run.result).status).toBe('cancelled');
    expect(executions).toBe(1);

    expect(
      agent
        .getConversation()
        .filter((message) => message.role === 'tool_result')
        .map((message) => message.isError),
    ).toEqual([false, true]);
  });
});
