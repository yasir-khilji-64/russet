import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  InferenceRequest,
  ModelEvent,
  ModelResponse,
  ModelStream,
  ModelToolCall,
  ModelToolDefinition,
  ToolResultConversationMessage,
} from '@russet/ai';

import type {
  AgentEvent,
  AgentRun,
  ToolExecutionGateway,
  ToolExecutionResult,
} from '../src/index.js';
import { createAgent } from '../src/index.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const toolDefinitions: readonly ModelToolDefinition[] = [
  {
    name: 'fs.read',
    description: 'Read a permitted file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    },
  },
];

function toolCall(id: string): ModelToolCall {
  return {
    toolCallId: id,
    name: 'fs.read',
    arguments: { path: id },
  };
}

function toolResponse(id: string, ids: readonly string[]): ModelResponse {
  return {
    requestId: id,
    messageId: `message-${id}`,
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: ids.map((callId) => ({
      id: `block-${callId}`,
      type: 'toolcall' as const,
      toolCall: toolCall(callId),
    })),
  };
}

function finalResponse(id: string): ModelResponse {
  return {
    requestId: id,
    messageId: `message-${id}`,
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: `block-${id}`,
        type: 'text',
        text: 'Done.',
      },
    ],
  };
}

function scriptedInference(responses: readonly ModelResponse[]): {
  inference: InferenceEngine;
  requests: InferenceRequest[];
} {
  const requests: InferenceRequest[] = [];

  const inference: InferenceEngine = {
    stream(request): ModelStream {
      const response = responses[requests.length];

      if (response === undefined) {
        throw new Error('No scripted model response is available.');
      }

      requests.push(request);

      let consumed = false;
      let exhausted = false;

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          if (consumed) {
            throw new Error('Model stream consumed twice.');
          }

          consumed = true;

          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          for (const block of response.blocks) {
            if (block.type === 'toolcall') {
              yield {
                type: 'toolcall.completed',
                requestId: response.requestId,
                messageId: response.messageId,
                blockId: block.id,
                toolCall: block.toolCall,
              };
            }
          }

          exhausted = true;

          yield {
            type: 'response.completed',
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        async result(): Promise<ModelResponse> {
          if (!exhausted) {
            throw new Error('Result retrieved before completion.');
          }

          return response;
        },
      };
    },
  };

  return { inference, requests };
}

function gateway(
  execute: ToolExecutionGateway['execute'],
): ToolExecutionGateway {
  return {
    async listModelTools() {
      return toolDefinitions;
    },
    execute,
  };
}

const success: ToolExecutionResult = {
  status: 'success',
  content: [
    {
      type: 'text',
      text: 'File content.',
    },
  ],
};

describe('Agent tool execution and continuation', () => {
  it('waits for authoritative completion before dispatch', async () => {
    const scripted = scriptedInference([
      toolResponse('request-1', ['call-1']),
      finalResponse('request-2'),
    ]);

    const invoked: string[] = [];
    const events: AgentEvent[] = [];
    const observedBeforeDispatch: boolean[] = [];

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        expect(request.modelRequestId).toBe('request-1');

        return success;
      }),
    });

    const result = await agent.start(
      {
        message: 'Read the file.',
        model,
      },
      (event) => {
        events.push(event);

        if (
          event.type === 'model.event' &&
          event.event.type === 'toolcall.completed'
        ) {
          observedBeforeDispatch.push(invoked.length === 0);
        }
      },
    ).result;

    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['call-1']);
    expect(observedBeforeDispatch).toEqual([true]);

    expect(scripted.requests).toHaveLength(2);

    expect(scripted.requests[0]?.tools).toEqual(toolDefinitions);

    expect(
      scripted.requests[1]?.messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'tool_result']);

    expect(agent.getConversation().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
    ]);

    expect(
      events.filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
  });

  it('executes multiple calls sequentially', async () => {
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;

    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const invoked: string[] = [];

    const scripted = scriptedInference([
      toolResponse('request-1', ['A', 'B', 'C']),
      finalResponse('request-2'),
    ]);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        if (request.toolCall.toolCallId === 'A') {
          firstStarted?.();
          await firstGate;
        }

        return success;
      }),
    });

    const run = agent.start({
      message: 'Read files.',
      model,
    });

    await started;

    expect(invoked).toEqual(['A']);

    releaseFirst?.();

    expect((await run.result).status).toBe('completed');

    expect(invoked).toEqual(['A', 'B', 'C']);
  });

  it('records denial and skips remaining calls', async () => {
    const scripted = scriptedInference([
      toolResponse('request-1', ['A', 'B', 'C']),
      finalResponse('request-2'),
    ]);

    const invoked: string[] = [];

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        return request.toolCall.toolCallId === 'B'
          ? {
              status: 'rejected',
              code: 'permission_denied',
              message: 'Denied.',
            }
          : success;
      }),
    });

    const result = await agent.start({
      message: 'Read files.',
      model,
    }).result;

    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['A', 'B']);

    const results = scripted.requests[1]?.messages.filter(
      (message): message is ToolResultConversationMessage =>
        message.role === 'tool_result',
    );

    expect(results?.map((entry) => [entry.toolCallId, entry.isError])).toEqual([
      ['A', false],
      ['B', true],
      ['C', true],
    ]);

    expect(results?.[2]?.content[0]?.text).toContain('Not executed');
  });

  it('never dispatches duplicate completed tool calls', async () => {
    const scripted = scriptedInference([toolResponse('request-1', ['A', 'A'])]);

    const invoked: string[] = [];

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);
        return success;
      }),
    });

    const result = await agent.start({
      message: 'Read.',
      model,
    }).result;

    expect(result.status).toBe('failed');

    expect(result.failure?.kind).toBe('invalid_model_response');

    expect(invoked).toEqual([]);
    expect(agent.getConversation()).toEqual([]);
  });

  it('prevents further dispatch after cancellation', async () => {
    const scripted = scriptedInference([toolResponse('request-1', ['A', 'B'])]);

    const invoked: string[] = [];
    let activeRun: AgentRun | undefined = undefined;

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        activeRun?.cancel();

        return success;
      }),
    });

    activeRun = agent.start({
      message: 'Read.',
      model,
    });

    expect((await activeRun.result).status).toBe('cancelled');

    expect(invoked).toEqual(['A']);

    expect(
      agent
        .getConversation()
        .filter((message) => message.role === 'tool_result'),
    ).toHaveLength(2);
  });

  it('blocks new runs after an uncertain tool outcome', async () => {
    const scripted = scriptedInference([toolResponse('request-1', ['A', 'B'])]);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async () => {
        throw new Error('Gateway lost contact after dispatch.');
      }),
    });

    const result = await agent.start({
      message: 'Read.',
      model,
    }).result;

    expect(result.status).toBe('interrupted');

    expect(result.failure?.kind).toBe('tool_execution_uncertain');

    expect(() =>
      agent.start({
        message: 'Again.',
        model,
      }),
    ).toThrow('requires reconciliation');
  });

  it('preflights the tool batch against the attempt limit', async () => {
    const ids = Array.from({ length: 41 }, (_, index) => `call-${index}`);

    const scripted = scriptedInference([toolResponse('request-1', ids)]);

    const invoked: string[] = [];

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);
        return success;
      }),
    });

    const result = await agent.start({
      message: 'Read many files.',
      model,
    }).result;

    expect(result.status).toBe('limit_reached');
    expect(invoked).toEqual([]);
  });

  it('bounds repeated model tool-use requests', async () => {
    const responses = Array.from({ length: 16 }, (_, index) =>
      toolResponse(`request-${index}`, [`call-${index}`]),
    );

    const scripted = scriptedInference(responses);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway(async () => success),
    });

    const result = await agent.start({
      message: 'Keep reading.',
      model,
    }).result;

    expect(result.status).toBe('limit_reached');
    expect(scripted.requests).toHaveLength(16);
  });
});
