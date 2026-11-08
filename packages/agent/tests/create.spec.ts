import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  InferenceOptions,
  InferenceRequest,
  ModelEvent,
  ModelId,
  ModelResponse,
  ModelStream,
} from '@russet/ai';

import { createAgent } from '../src/index.js';

const model: ModelId = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function completedResponse(
  changes: Partial<ModelResponse> = {},
): ModelResponse {
  return {
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
    nativeContinuation: {
      format: 'pi-ai/in-memory-v1',
      providerId: 'ollama',
      modelId: 'gpt-oss:20b',
      protocol: 'openai-completions',
    },
    ...changes,
  };
}

function scriptedInference(responses: readonly ModelResponse[]) {
  const requests: InferenceRequest[] = [];
  const options: (InferenceOptions | undefined)[] = [];

  const inference: InferenceEngine = {
    stream(request, settings): ModelStream {
      const response = responses[requests.length];

      if (response === undefined) {
        throw new Error('No scripted response remains.');
      }

      requests.push(request);
      options.push(settings);

      let consumed = false;
      let exhausted = false;

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          if (consumed) {
            throw new Error('Stream consumed twice.');
          }

          consumed = true;

          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          exhausted = true;

          yield {
            type:
              response.failure === undefined
                ? 'response.completed'
                : 'response.failed',
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        async result(): Promise<ModelResponse> {
          if (!exhausted) {
            throw new Error('Result requested before stream completion.');
          }

          return response;
        },
      };
    },
  };

  return { inference, requests, options };
}

describe('createAgent', () => {
  it('commits a completed inference response', async () => {
    const response = completedResponse();
    const scripted = scriptedInference([response]);
    const agent = createAgent({
      inference: scripted.inference,
    });

    const run = agent.start({
      message: 'Explain this workspace.',
      model,
      systemPrompt: 'Be concise.',
      thinking: { effort: 'low' },
    });

    await expect(run.result).resolves.toEqual({
      runId: run.id,
      status: 'completed',
    });

    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.systemPrompt).toBe('Be concise.');
    expect(scripted.options[0]?.thinking).toEqual({
      effort: 'low',
    });
    expect(scripted.options[0]?.signal).toBeInstanceOf(AbortSignal);

    const conversation = agent.getConversation();

    expect(conversation.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);

    expect(conversation[1]).toEqual({
      role: 'assistant',
      response,
    });

    const assistant = conversation[1];

    if (assistant?.role !== 'assistant') {
      throw new Error('Missing completed assistant message.');
    }

    expect(assistant.response.nativeContinuation).toBe(
      response.nativeContinuation,
    );
  });

  it('reuses completed conversation across runs', async () => {
    const scripted = scriptedInference([
      completedResponse(),
      completedResponse({ requestId: 'request-2' }),
    ]);
    const agent = createAgent({
      inference: scripted.inference,
    });

    await agent.start({ message: 'First.', model }).result;
    await agent.start({ message: 'Second.', model }).result;

    expect(
      scripted.requests[1]?.messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'user']);

    expect(agent.getConversation()).toHaveLength(4);
  });

  it('preserves structured inference failures', async () => {
    const response = completedResponse({
      finishReason: 'error',
      failure: {
        code: 'provider_error',
        message: 'Inference did not complete successfully.',
        retryable: false,
      },
    });

    const agent = createAgent({
      inference: scriptedInference([response]).inference,
    });

    const result = await agent.start({
      message: 'Explain.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure).toEqual({
      kind: 'inference',
      failure: response.failure,
    });
    expect(agent.getConversation()).toEqual([]);
  });

  it('rejects tool-use without executing tools', async () => {
    const response = completedResponse({
      finishReason: 'tool_use',
      blocks: [
        {
          id: 'tool-block',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'fs.read',
            arguments: { path: 'README.md' },
          },
        },
      ],
    });

    const agent = createAgent({
      inference: scriptedInference([response]).inference,
    });

    const result = await agent.start({
      message: 'Read it.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('tool_execution_unavailable');
    expect(agent.getConversation()).toEqual([]);
  });

  it('rejects a stop response containing tool calls', async () => {
    const response = completedResponse({
      blocks: [
        {
          id: 'tool-block',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'fs.read',
            arguments: {},
          },
        },
      ],
    });

    const agent = createAgent({
      inference: scriptedInference([response]).inference,
    });

    const result = await agent.start({
      message: 'Explain.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('invalid_model_response');
    expect(agent.getConversation()).toEqual([]);
  });

  it('reports truncated responses without committing them', async () => {
    const agent = createAgent({
      inference: scriptedInference([
        completedResponse({ finishReason: 'length' }),
      ]).inference,
    });

    const result = await agent.start({
      message: 'Explain.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('model_truncated');
    expect(agent.getConversation()).toEqual([]);
  });

  it('supports cancellation before inference begins', async () => {
    const scripted = scriptedInference([completedResponse()]);
    const agent = createAgent({
      inference: scripted.inference,
    });

    const run = agent.start({
      message: 'Explain.',
      model,
    });

    run.cancel();

    expect((await run.result).status).toBe('cancelled');
    expect(scripted.requests).toHaveLength(0);
    expect(agent.getConversation()).toEqual([]);
  });

  it('rejects overlapping runs and use after disposal', async () => {
    const scripted = scriptedInference([completedResponse()]);
    const agent = createAgent({
      inference: scripted.inference,
    });

    const run = agent.start({
      message: 'First.',
      model,
    });

    expect(() =>
      agent.start({
        message: 'Second.',
        model,
      }),
    ).toThrow('An agent run is already active.');

    await run.result;
    await agent.dispose();

    expect(() =>
      agent.start({
        message: 'Later.',
        model,
      }),
    ).toThrow('The agent has been disposed.');
  });
});
