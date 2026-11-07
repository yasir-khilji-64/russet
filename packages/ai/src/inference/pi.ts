import { randomUUID } from 'node:crypto';

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';

import type {
  InferenceEngine,
  InferenceOptions,
  InferenceRequest,
  ModelBlock,
  ModelEvent,
  ModelResponse,
  ModelStream,
  ModelToolCall,
  ThinkingVisibility,
} from './types.js';

type PiModels = Pick<Models, 'getModel' | 'streamSimple'>;

type BlockKind = ModelBlock['type'];

interface ActiveBlock {
  id: string;
  kind: BlockKind;
  ended: boolean;
}

function thinkingVisibility(
  content: Extract<AssistantMessage['content'][number], { type: 'thinking' }>,
): ThinkingVisibility {
  if (content.redacted) {
    return 'opaque';
  }

  return content.thinking ? 'visible' : 'unknown';
}

function normalizeFinishedResponse(
  final: AssistantMessage,
  request: InferenceRequest,
  requestId: string,
  messageId: string,
  active: Map<number, ActiveBlock>,
): ModelResponse {
  const blocks: ModelBlock[] = final.content.map((content, index) => {
    const kind = content.type === 'toolCall' ? 'toolcall' : content.type;

    const state = active.get(index);

    if (!state || state.kind !== kind || !state.ended) {
      throw new Error(`Invalid final block at index ${index}`);
    }

    if (content.type === 'text') {
      return {
        id: state.id,
        type: 'text',
        text: content.text,
      };
    }

    if (content.type === 'thinking') {
      return {
        id: state.id,
        type: 'thinking',
        visibility: thinkingVisibility(content),
        text: content.redacted ? '' : content.thinking,
      };
    }

    return {
      id: state.id,
      type: 'toolcall',
      toolCall: {
        toolCallId: content.id,
        name: content.name,
        arguments: structuredClone(content.arguments),
      },
    };
  });

  const finishReason =
    final.stopReason === 'toolUse'
      ? 'tool_use'
      : final.stopReason === 'stop'
        ? 'stop'
        : final.stopReason === 'length'
          ? 'length'
          : 'unsupported';

  return {
    requestId,
    messageId,
    model: { ...request.model },
    finishReason,
    blocks,
    usage: {
      inputTokens: final.usage.input,
      outputTokens: final.usage.output,
      totalTokens: final.usage.totalTokens,
      ...(final.usage.reasoning === undefined
        ? {}
        : { reasoningTokens: final.usage.reasoning }),
    },
  };
}

function failedResponse(
  request: InferenceRequest,
  requestId: string,
  messageId: string,
  reason: 'aborted' | 'error' | 'unsupported',
  code: string,
): ModelResponse {
  return {
    requestId,
    messageId,
    model: { ...request.model },
    finishReason: reason,
    blocks: [],
    failure: {
      code,
      message: 'Inference did not complete successfully.',
    },
  };
}

export function createPiInferenceEngine(
  models: PiModels,
  createId: () => string = randomUUID,
): InferenceEngine {
  return {
    stream(request: InferenceRequest, options?: InferenceOptions): ModelStream {
      const requestId = createId();
      const messageId = createId();

      const active = new Map<number, ActiveBlock>();
      const controller = new AbortController();

      const onAbort = () => controller.abort();

      let consumed = false;
      let settle!: (response: ModelResponse) => void;

      const completed = new Promise<ModelResponse>((resolve) => {
        settle = resolve;
      });

      const identity = { requestId, messageId };

      function open(index: number, kind: BlockKind): ActiveBlock {
        if (active.has(index)) {
          throw new Error('Duplicate content block');
        }

        const block: ActiveBlock = {
          id: createId(),
          kind,
          ended: false,
        };

        active.set(index, block);
        return block;
      }

      function get(index: number, kind: BlockKind): ActiveBlock {
        const block = active.get(index);

        if (!block || block.kind !== kind || block.ended) {
          throw new Error('Unexpected content block event');
        }

        return block;
      }

      function end(index: number, kind: BlockKind): ActiveBlock {
        const block = get(index, kind);
        block.ended = true;
        return block;
      }

      async function* iterate(): AsyncGenerator<ModelEvent> {
        let outcome: ModelResponse | undefined;

        try {
          if (options?.signal) {
            if (options.signal.aborted) {
              controller.abort();
            } else {
              options.signal.addEventListener('abort', onAbort, { once: true });
            }
          }

          if (controller.signal.aborted) {
            throw new Error('Cancelled');
          }

          const model = models.getModel(
            request.model.providerId,
            request.model.modelId,
          );

          if (!model) {
            throw new Error('Model is not registered');
          }

          const source = models.streamSimple(
            model,
            {
              messages: request.messages.map((message) => ({
                role: 'user' as const,
                content: message.text,
                timestamp: Date.now(),
              })),
            },
            { signal: controller.signal },
          );

          let started = false;

          let terminal:
            | Extract<AssistantMessageEvent, { type: 'done' | 'error' }>
            | undefined;

          for await (const event of source) {
            if (terminal) {
              throw new Error('Events emitted after terminal event');
            }

            if (event.type === 'start') {
              if (started) {
                throw new Error('Duplicate response start');
              }

              started = true;

              yield {
                ...identity,
                type: 'response.started',
              };

              continue;
            }

            if (event.type === 'done' || event.type === 'error') {
              terminal = event;
              continue;
            }

            if (!started) {
              throw new Error('Block event before response start');
            }

            switch (event.type) {
              case 'text_start': {
                const block = open(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.started',
                };
                break;
              }

              case 'text_delta': {
                const block = get(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.delta',
                  delta: event.delta,
                };
                break;
              }

              case 'text_end': {
                const block = end(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.completed',
                  text: event.content,
                };
                break;
              }

              case 'thinking_start': {
                const block = open(event.contentIndex, 'thinking');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.started',
                  visibility: 'unknown',
                };
                break;
              }

              case 'thinking_delta': {
                const block = get(event.contentIndex, 'thinking');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.delta',
                  delta: event.delta,
                };
                break;
              }

              case 'thinking_end': {
                const block = end(event.contentIndex, 'thinking');

                const content = event.partial.content[event.contentIndex];

                const visibility =
                  content?.type === 'thinking'
                    ? thinkingVisibility(content)
                    : 'unknown';

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.completed',
                  visibility,
                  text: visibility === 'opaque' ? '' : event.content,
                };
                break;
              }

              case 'toolcall_start': {
                const block = open(event.contentIndex, 'toolcall');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'toolcall.started',
                };
                break;
              }

              case 'toolcall_delta': {
                const block = get(event.contentIndex, 'toolcall');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'toolcall.arguments.delta',
                  delta: event.delta,
                };
                break;
              }

              case 'toolcall_end': {
                const block = end(event.contentIndex, 'toolcall');

                const toolCall: ModelToolCall = {
                  toolCallId: event.toolCall.id,
                  name: event.toolCall.name,
                  arguments: structuredClone(event.toolCall.arguments),
                };

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'toolcall.completed',
                  toolCall,
                };
                break;
              }
            }
          }

          if (!terminal) {
            throw new Error('Stream ended without terminal event');
          }

          const final = await source.result();

          if (terminal.type === 'error') {
            const aborted = terminal.reason === 'aborted';

            outcome = failedResponse(
              request,
              requestId,
              messageId,
              aborted ? 'aborted' : 'error',
              aborted ? 'cancelled' : 'provider_error',
            );
          } else if (terminal.reason === 'deferred') {
            outcome = failedResponse(
              request,
              requestId,
              messageId,
              'unsupported',
              'deferred_not_supported',
            );
          } else {
            if (terminal.reason !== final.stopReason) {
              throw new Error('Terminal reason mismatch');
            }

            outcome = normalizeFinishedResponse(
              final,
              request,
              requestId,
              messageId,
              active,
            );
          }
        } catch {
          const aborted = controller.signal.aborted;

          outcome = failedResponse(
            request,
            requestId,
            messageId,
            aborted ? 'aborted' : 'error',
            aborted ? 'cancelled' : 'inference_error',
          );
        } finally {
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }

          controller.abort();

          if (!outcome) {
            outcome = failedResponse(
              request,
              requestId,
              messageId,
              'aborted',
              'stream_not_consumed',
            );
          }

          settle(outcome);
        }

        yield {
          ...identity,
          type: outcome.failure ? 'response.failed' : 'response.completed',
          response: outcome,
        };
      }

      return {
        [Symbol.asyncIterator]() {
          if (consumed) {
            throw new Error('ModelStream is single-consumer');
          }

          consumed = true;
          return iterate();
        },

        result: () => completed,
      };
    },
  };
}
