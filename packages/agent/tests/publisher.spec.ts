import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  ModelEvent,
  ModelResponse,
  ModelStream,
} from '@russet/ai';

import { AgentEventPublisher } from '../src/events/publisher.js';
import type { AgentEvent } from '../src/events/types.js';
import { createAgent } from '../src/index.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function inference(): InferenceEngine {
  return {
    stream(): ModelStream {
      const response: ModelResponse = {
        requestId: 'request-1',
        messageId: 'message-1',
        model,
        finishReason: 'stop',
        blocks: [
          {
            id: 'block-1',
            type: 'text',
            text: 'Ready.',
          },
        ],
        thinkingAvailability: 'unavailable',
      };

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          yield {
            type: 'text.delta',
            requestId: response.requestId,
            messageId: response.messageId,
            blockId: 'block-1',
            delta: 'Ready.',
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

describe('AgentEventPublisher', () => {
  it('isolates throwing and rejected listeners', async () => {
    const publisher = new AgentEventPublisher('run-1');
    const received: number[] = [];

    publisher.subscribe(() => {
      throw new Error('Synchronous listener failure.');
    });

    publisher.subscribe(async () => {
      throw new Error('Asynchronous listener failure.');
    });

    publisher.subscribe((event) => {
      received.push(event.sequence);
    });

    publisher.publish({
      type: 'run.started',
      model,
      phase: 'preparing',
    });

    publisher.publish({
      type: 'run.finished',
      result: {
        runId: 'run-1',
        status: 'completed',
      },
    });

    publisher.publish({
      type: 'run.finished',
      result: {
        runId: 'run-1',
        status: 'failed',
      },
    });

    await Promise.resolve();

    expect(received).toEqual([1, 2]);
  });

  it('supports unsubscribing before publication', () => {
    const publisher = new AgentEventPublisher('run-1');
    const observed: AgentEvent[] = [];

    const unsubscribe = publisher.subscribe((event) => {
      observed.push(event);
    });

    unsubscribe();

    publisher.publish({
      type: 'run.started',
      model,
      phase: 'preparing',
    });

    expect(observed).toHaveLength(0);
  });
});

describe('Agent lifecycle observation', () => {
  it('emits ordered and correlated events', async () => {
    const agent = createAgent({
      inference: inference(),
    });

    const observed: AgentEvent[] = [];

    const run = agent.start(
      {
        message: 'Hello.',
        model,
      },
      (event) => {
        observed.push(event);
      },
    );

    expect(run.state).toEqual({
      kind: 'active',
      phase: 'preparing',
    });

    const later: AgentEvent[] = [];

    run.subscribe((event) => {
      later.push(event);
    });

    const result = await run.result;

    expect(result.status).toBe('completed');

    expect(run.state).toEqual({
      kind: 'finished',
      result,
    });

    expect(observed.map((event) => event.type)).toEqual([
      'run.started',
      'run.phase_changed',
      'model.request.started',
      'model.event',
      'model.event',
      'model.request.finished',
      'run.finished',
    ]);

    expect(observed.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);

    expect(observed.every((event) => event.runId === run.id)).toBe(true);

    expect(later.map((event) => event.type)).toEqual(
      observed.slice(1).map((event) => event.type),
    );

    expect(
      observed.filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);

    const finish = observed.find(
      (event) => event.type === 'model.request.finished',
    );

    expect(finish).toMatchObject({
      requestId: 'request-1',
      messageId: 'message-1',
      finishReason: 'stop',
    });

    expect(agent.getConversation()).toHaveLength(2);
  });

  it('prevents inference after cancellation at model start', async () => {
    let streamCalls = 0;

    const agent = createAgent({
      inference: {
        stream(): ModelStream {
          streamCalls++;

          return inference().stream({
            model,
            messages: [],
          });
        },
      },
    });

    let cancelRun: ReturnType<typeof agent.start> | undefined = undefined;

    const run = agent.start(
      {
        message: 'Hello.',
        model,
      },
      (event) => {
        if (event.type === 'model.request.started') {
          cancelRun?.cancel();
        }
      },
    );

    cancelRun = run;

    expect((await run.result).status).toBe('cancelled');
    expect(streamCalls).toBe(0);
  });
});
