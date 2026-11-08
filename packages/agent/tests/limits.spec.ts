import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  ModelEvent,
  ModelResponse,
  ModelStream,
} from '@russet/ai';

import { resolveAgentExecutionLimits } from '../src/agent/limits.js';
import { createAgent } from '../src/index.js';
import type { ToolExecutionGateway } from '../src/tools/types.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function scripted(response: ModelResponse) {
  const requests: number[] = [];

  const inference: InferenceEngine = {
    stream(): ModelStream {
      requests.push(1);

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

  return { inference, requests };
}

const toolResponse: ModelResponse = {
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

function gateway(onExecute: () => void): ToolExecutionGateway {
  return {
    async listModelTools() {
      return [
        {
          name: 'fs.read',
          description: 'Read file',
          parameters: { type: 'object' },
        },
      ];
    },

    async execute() {
      onExecute();

      return {
        status: 'success',
        content: [{ type: 'text', text: 'ok' }],
      };
    },
  };
}

describe('Agent execution limits', () => {
  it('preserves defaults and partial overrides', () => {
    expect(resolveAgentExecutionLimits(undefined)).toEqual({
      maxModelRequests: 16,
      maxToolAttempts: 40,
      maxCancellationWaitMs: 5_000,
    });

    expect(resolveAgentExecutionLimits({ maxToolAttempts: 3 })).toEqual({
      maxModelRequests: 16,
      maxToolAttempts: 3,
      maxCancellationWaitMs: 5_000,
    });
  });

  it('rejects invalid limits without reserving a run', async () => {
    const fixture = scripted({
      requestId: 'req-1',
      messageId: 'msg-1',
      model,
      finishReason: 'stop',
      thinkingAvailability: 'unavailable',
      blocks: [],
    });

    const agent = createAgent({
      inference: fixture.inference,
    });

    expect(() =>
      agent.start({
        message: 'Hello',
        model,
        limits: { maxModelRequests: 0 },
      }),
    ).toThrow('maxModelRequests');

    expect(() =>
      agent.start({
        message: 'Hello',
        model,
        limits: { maxToolAttempts: 1.5 },
      }),
    ).toThrow('maxToolAttempts');

    expect(() =>
      agent.start({
        message: 'Hello',
        model,
        limits: { maxCancellationWaitMs: 2_147_483_648 },
      }),
    ).toThrow('maxCancellationWaitMs');

    const run = agent.start({
      message: 'Hello',
      model,
      limits: { maxModelRequests: 1 },
    });

    expect((await run.result).status).toBe('completed');
    expect(fixture.requests).toHaveLength(1);
  });

  it('rejects an oversized batch before dispatch', async () => {
    const fixture = scripted(toolResponse);
    let invocations = 0;

    const agent = createAgent({
      inference: fixture.inference,
      toolGateway: gateway(() => {
        invocations++;
      }),
    });

    const result = await agent.start({
      message: 'Read files',
      model,
      limits: { maxToolAttempts: 1 },
    }).result;

    expect(result.status).toBe('limit_reached');
    expect(invocations).toBe(0);
    expect(agent.getConversation()).toEqual([]);
  });

  it('does not exceed the model request budget', async () => {
    const fixture = scripted(toolResponse);
    let invocations = 0;

    const agent = createAgent({
      inference: fixture.inference,
      toolGateway: gateway(() => {
        invocations++;
      }),
    });

    const result = await agent.start({
      message: 'Read files',
      model,
      limits: { maxModelRequests: 1 },
    }).result;

    expect(result.status).toBe('limit_reached');
    expect(fixture.requests).toHaveLength(1);
    expect(invocations).toBe(2);
  });
});
