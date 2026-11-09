import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  ModelEvent,
  ModelResponse,
  ModelStream,
  NativeContinuation,
} from '@russet/ai';

import { createAgent } from '../src/index.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function completedResponse(
  overrides: Partial<ModelResponse> = {},
): ModelResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'stop',
    blocks: [
      {
        id: 'text-1',
        type: 'text',
        text: 'Original response.',
      },
    ],
    thinkingAvailability: 'unavailable',
    ...overrides,
  };
}

function inferenceFor(response: ModelResponse): InferenceEngine {
  return {
    stream(): ModelStream {
      let consumed = false;
      let exhausted = false;

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          if (consumed) {
            throw new Error('Stream consumed more than once.');
          }

          consumed = true;

          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          exhausted = true;

          yield {
            type: 'response.completed',
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        result(): Promise<ModelResponse> {
          if (!exhausted) {
            return Promise.reject(new Error('Stream has not completed.'));
          }

          return Promise.resolve(response);
        },
      };
    },
  };
}

describe('Agent execution integrity', () => {
  it('rejects a response from a different model', async () => {
    const agent = createAgent({
      inference: inferenceFor(
        completedResponse({
          model: {
            providerId: 'groq',
            modelId: 'openai/gpt-oss-20b',
          },
        }),
      ),
    });

    const result = await agent.start({
      message: 'Explain this workspace.',
      model,
    }).result;

    expect(result.status).toBe('failed');

    expect(result.failure?.kind).toBe('invalid_model_response');

    expect(agent.getConversation()).toEqual([]);
  });

  it('rejects an empty response identity', async () => {
    const agent = createAgent({
      inference: inferenceFor(completedResponse({ requestId: '' })),
    });

    const result = await agent.start({
      message: 'Explain.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('invalid_model_response');
  });

  it('classifies an aborted response as cancelled', async () => {
    const agent = createAgent({
      inference: inferenceFor(
        completedResponse({
          finishReason: 'aborted',
        }),
      ),
    });

    const result = await agent.start({
      message: 'Explain.',
      model,
    }).result;

    expect(result.status).toBe('cancelled');
    expect(agent.getConversation()).toEqual([]);
  });

  it('returns isolated conversation snapshots', async () => {
    const continuation: NativeContinuation = Object.freeze({
      format: 'pi-ai/in-memory-v1',
      providerId: model.providerId,
      modelId: model.modelId,
      protocol: 'openai-completions',
    });

    const agent = createAgent({
      inference: inferenceFor(
        completedResponse({
          nativeContinuation: continuation,
        }),
      ),
    });

    const result = await agent.start({
      message: 'Original user message.',
      model,
    }).result;

    expect(result.status).toBe('completed');

    const snapshot = agent.getConversation();

    const user = snapshot[0];

    if (user?.role !== 'user') {
      throw new Error('Expected a user message.');
    }

    user.text = 'Modified externally.';

    const assistant = snapshot[1];

    if (assistant?.role !== 'assistant') {
      throw new Error('Expected an assistant response.');
    }

    assistant.response.model.modelId = 'modified-model';

    const textBlock = assistant.response.blocks[0];

    if (textBlock?.type !== 'text') {
      throw new Error('Expected a text block.');
    }

    textBlock.text = 'Modified response.';

    const current = agent.getConversation();

    expect(current[0]).toMatchObject({
      role: 'user',
      text: 'Original user message.',
    });

    expect(current[1]).toMatchObject({
      role: 'assistant',
      response: {
        model,
        blocks: [
          {
            type: 'text',
            text: 'Original response.',
          },
        ],
      },
    });

    const retained = current[1];

    if (retained?.role !== 'assistant') {
      throw new Error('Expected an assistant response.');
    }

    expect(retained.response.nativeContinuation).toBe(continuation);
  });
});
