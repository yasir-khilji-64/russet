import { randomUUID } from 'node:crypto';

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';

import { preservePiContinuation } from './continuation.js';
import { buildPiContext } from './conversation.js';
import { classifyThinking, resolveThinkingEffort } from './thinking.js';
import type {
  FinishReason,
  InferenceEngine,
  InferenceFailure,
  InferenceFailureCode,
  InferenceOptions,
  InferenceRequest,
  ModelBlock,
  ModelEvent,
  ModelResponse,
  ModelStream,
  ModelToolCall,
  ThinkingSupport,
  ThinkingVisibility,
} from './types.js';
import { normalizeUsage } from './usage.js';

type PiModels = Pick<Models, 'getModel' | 'streamSimple'>;

type BlockKind = ModelBlock['type'];

interface ActiveBlock {
  id: string;
  kind: BlockKind;
  ended: boolean;
}

class InferenceSetupError extends Error {
  constructor(
    readonly code: InferenceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'InferenceSetupError';
  }
}

function argumentsError(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    'argumentsError' in value &&
    typeof value.argumentsError === 'string'
  ) {
    return value.argumentsError;
  }

  return undefined;
}

function blockVisibility(
  content: Extract<AssistantMessage['content'][number], { type: 'thinking' }>,
): ThinkingVisibility {
  return classifyThinking(content);
}

function thinkingAvailability(
  blocks: readonly ModelBlock[],
): ModelResponse['thinkingAvailability'] {
  return blocks.some(
    (block) =>
      block.type === 'thinking' &&
      (block.visibility === 'opaque' ||
        block.visibility === 'summary' ||
        (block.text?.length ?? 0) > 0),
  )
    ? 'available'
    : 'unavailable';
}

function normalizeFinishReason(
  reason: AssistantMessage['stopReason'],
): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';

    case 'toolUse':
      return 'tool_use';

    case 'length':
      return 'length';

    case 'aborted':
      return 'aborted';

    case 'error':
      return 'error';

    default:
      return 'unsupported';
  }
}

function normalizeCompletedResponse(
  final: AssistantMessage,
  request: InferenceRequest,
  requestId: string,
  messageId: string,
  active: Map<number, ActiveBlock>,
): ModelResponse {
  const blocks: ModelBlock[] = final.content.map(
    (content, index): ModelBlock => {
      const kind: BlockKind =
        content.type === 'toolCall' ? 'toolcall' : content.type;

      const state = active.get(index);

      if (!state || state.kind !== kind || !state.ended) {
        throw new InferenceSetupError(
          'invalid_response',
          `Invalid final content block at index ${index}.`,
        );
      }

      if (content.type === 'text') {
        return {
          id: state.id,
          type: 'text',
          text: content.text,
        };
      }

      if (content.type === 'thinking') {
        const visibility = blockVisibility(content);

        return {
          id: state.id,
          type: 'thinking',
          visibility,
          ...(visibility === 'visible' ? { text: content.thinking } : {}),
        };
      }

      const toolCall: ModelToolCall = {
        toolCallId: content.id,
        name: content.name,
        arguments: structuredClone(content.arguments),
      };

      const error = argumentsError(content);

      if (error !== undefined) {
        toolCall.argumentsError = error;
      }

      return {
        id: state.id,
        type: 'toolcall',
        toolCall,
      };
    },
  );

  return {
    requestId,
    messageId,
    model: { ...request.model },
    protocol: final.api,
    timestamp: final.timestamp,
    finishReason: normalizeFinishReason(final.stopReason),
    blocks,
    thinkingAvailability: thinkingAvailability(blocks),
    usage: normalizeUsage(final.usage),
    nativeContinuation: preservePiContinuation(final),
  };
}

function snapshotPartialBlocks(
  partial: AssistantMessage,
  active: Map<number, ActiveBlock>,
): ModelBlock[] {
  const blocks: ModelBlock[] = [];

  for (const [index, content] of partial.content.entries()) {
    const state = active.get(index);

    if (!state) {
      continue;
    }

    if (content.type === 'text' && state.kind === 'text') {
      blocks.push({
        id: state.id,
        type: 'text',
        text: content.text,
      });

      continue;
    }

    if (content.type === 'thinking' && state.kind === 'thinking') {
      const visibility = blockVisibility(content);

      blocks.push({
        id: state.id,
        type: 'thinking',
        visibility,
        ...(visibility === 'visible' ? { text: content.thinking } : {}),
      });
    }
  }

  return blocks;
}

function failedResponse(
  request: InferenceRequest,
  requestId: string,
  messageId: string,
  failure: InferenceFailure,
  partial?: AssistantMessage,
  active?: Map<number, ActiveBlock>,
): ModelResponse {
  const blocks =
    partial && active ? snapshotPartialBlocks(partial, active) : [];

  return {
    requestId,
    messageId,
    model: { ...request.model },

    ...(partial
      ? {
          protocol: partial.api,
          timestamp: partial.timestamp,
          usage: normalizeUsage(partial.usage),
        }
      : {}),

    finishReason:
      failure.code === 'cancelled' ||
      failure.code === 'timeout' ||
      failure.code === 'stream_closed'
        ? 'aborted'
        : 'error',

    blocks,
    thinkingAvailability: thinkingAvailability(blocks),
    failure,
  };
}

function timeoutRequested(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason;

  return reason instanceof Error && reason.name === 'TimeoutError';
}

function failureFromError(
  error: unknown,
  aborted: boolean,
  signal?: AbortSignal,
): InferenceFailure {
  if (aborted) {
    if (timeoutRequested(signal)) {
      return {
        code: 'timeout',
        message: 'Inference request timed out.',
        retryable: false,
      };
    }

    return {
      code: 'cancelled',
      message: 'Inference request was cancelled.',
      retryable: false,
    };
  }

  if (error instanceof InferenceSetupError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: 'provider_error',
    message: 'Inference did not complete successfully.',
    retryable: false,
  };
}

export function createPiInferenceEngine(
  models: PiModels,
  createId: () => string = randomUUID,
  getThinkingSupport?: (
    model: InferenceRequest['model'],
  ) => ThinkingSupport | undefined,
): InferenceEngine {
  return {
    stream(request: InferenceRequest, options?: InferenceOptions): ModelStream {
      const requestId = createId();
      const messageId = createId();

      const identity = {
        requestId,
        messageId,
      };

      const active = new Map<number, ActiveBlock>();
      const controller = new AbortController();

      const onAbort = () => {
        controller.abort(options?.signal?.reason);
      };

      let consumed = false;
      let started = false;

      let settle!: (response: ModelResponse) => void;

      const completed = new Promise<ModelResponse>((resolve) => {
        settle = resolve;
      });

      function openBlock(index: number, kind: BlockKind): ActiveBlock {
        if (!Number.isSafeInteger(index) || index < 0 || active.has(index)) {
          throw new InferenceSetupError(
            'invalid_response',
            'Invalid or duplicate content block.',
          );
        }

        const block: ActiveBlock = {
          id: createId(),
          kind,
          ended: false,
        };

        active.set(index, block);

        return block;
      }

      function getBlock(index: number, kind: BlockKind): ActiveBlock {
        const block = active.get(index);

        if (!block || block.kind !== kind || block.ended) {
          throw new InferenceSetupError(
            'invalid_response',
            'Unexpected content block event.',
          );
        }

        return block;
      }

      function endBlock(index: number, kind: BlockKind): ActiveBlock {
        const block = getBlock(index, kind);

        block.ended = true;

        return block;
      }

      async function* iterate(): AsyncGenerator<ModelEvent> {
        started = true;

        let outcome: ModelResponse | undefined;
        let lastPartial: AssistantMessage | undefined;

        try {
          if (options?.signal) {
            if (options.signal.aborted) {
              onAbort();
            } else {
              options.signal.addEventListener('abort', onAbort, { once: true });
            }
          }

          if (controller.signal.aborted) {
            throw new Error('Inference aborted.');
          }

          const model = models.getModel(
            request.model.providerId,
            request.model.modelId,
          );

          if (!model) {
            throw new InferenceSetupError(
              'model_not_found',
              'Selected model is not registered.',
            );
          }

          let effort: ReturnType<typeof resolveThinkingEffort>;

          try {
            effort = resolveThinkingEffort(
              options?.thinking,
              getThinkingSupport?.(request.model),
            );
          } catch {
            throw new InferenceSetupError(
              'unsupported_capability',
              'Requested thinking effort is unsupported.',
            );
          }

          if (effort !== undefined && !model.reasoning) {
            throw new InferenceSetupError(
              'unsupported_capability',
              'Selected model does not support reasoning.',
            );
          }

          let context: ReturnType<typeof buildPiContext>;

          try {
            context = buildPiContext(request, model.api);
          } catch {
            throw new InferenceSetupError(
              'invalid_context',
              'Conversation context is invalid.',
            );
          }

          const source = models.streamSimple(model, context, {
            signal: controller.signal,
            ...(effort === undefined ? {} : { reasoning: effort }),
          });

          let responseStarted = false;

          let terminal:
            | Extract<AssistantMessageEvent, { type: 'done' | 'error' }>
            | undefined;

          for await (const event of source) {
            if (terminal) {
              throw new InferenceSetupError(
                'invalid_response',
                'Provider emitted events after completion.',
              );
            }

            if ('partial' in event) {
              lastPartial = event.partial;
            }

            if (event.type === 'start') {
              if (responseStarted) {
                throw new InferenceSetupError(
                  'invalid_response',
                  'Duplicate response start.',
                );
              }

              responseStarted = true;

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

            if (!responseStarted) {
              throw new InferenceSetupError(
                'invalid_response',
                'Content received before response start.',
              );
            }

            switch (event.type) {
              case 'text_start': {
                const block = openBlock(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.started',
                };

                break;
              }

              case 'text_delta': {
                const block = getBlock(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.delta',
                  delta: event.delta,
                };

                break;
              }

              case 'text_end': {
                const block = endBlock(event.contentIndex, 'text');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'text.completed',
                  text: event.content,
                };

                break;
              }

              case 'thinking_start': {
                const block = openBlock(event.contentIndex, 'thinking');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.started',
                  visibility: 'unknown',
                };

                break;
              }

              case 'thinking_delta': {
                const block = getBlock(event.contentIndex, 'thinking');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.delta',
                  delta: event.delta,
                };

                break;
              }

              case 'thinking_end': {
                const block = endBlock(event.contentIndex, 'thinking');

                const content = event.partial.content[event.contentIndex];

                const visibility =
                  content?.type === 'thinking'
                    ? blockVisibility(content)
                    : 'unknown';

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'thinking.completed',
                  visibility,
                  ...(visibility === 'visible' ? { text: event.content } : {}),
                };

                break;
              }

              case 'toolcall_start': {
                const block = openBlock(event.contentIndex, 'toolcall');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'toolcall.started',
                };

                break;
              }

              case 'toolcall_delta': {
                const block = getBlock(event.contentIndex, 'toolcall');

                yield {
                  ...identity,
                  blockId: block.id,
                  type: 'toolcall.arguments.delta',
                  delta: event.delta,
                };

                break;
              }

              case 'toolcall_end': {
                const block = endBlock(event.contentIndex, 'toolcall');

                const toolCall: ModelToolCall = {
                  toolCallId: event.toolCall.id,
                  name: event.toolCall.name,
                  arguments: structuredClone(event.toolCall.arguments),
                };

                const error = argumentsError(event.toolCall);

                if (error !== undefined) {
                  toolCall.argumentsError = error;
                }

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
            throw new InferenceSetupError(
              'invalid_response',
              'Provider stream ended without a terminal event.',
            );
          }

          if (terminal.type === 'error') {
            const aborted =
              terminal.reason === 'aborted' || controller.signal.aborted;

            outcome = failedResponse(
              request,
              requestId,
              messageId,
              failureFromError(undefined, aborted, options?.signal),
              terminal.error,
              active,
            );
          } else if (terminal.reason === 'deferred') {
            outcome = failedResponse(
              request,
              requestId,
              messageId,
              {
                code: 'unsupported_capability',
                message: 'Deferred inference is not supported.',
                retryable: false,
              },
              terminal.message,
              active,
            );
          } else {
            const final = await source.result();

            if (final.stopReason !== terminal.reason) {
              throw new InferenceSetupError(
                'invalid_response',
                'Terminal reason mismatch.',
              );
            }

            outcome = normalizeCompletedResponse(
              final,
              request,
              requestId,
              messageId,
              active,
            );
          }
        } catch (error) {
          outcome = failedResponse(
            request,
            requestId,
            messageId,
            failureFromError(error, controller.signal.aborted, options?.signal),
            lastPartial,
            active,
          );
        } finally {
          options?.signal?.removeEventListener('abort', onAbort);

          if (!outcome) {
            outcome = failedResponse(
              request,
              requestId,
              messageId,
              {
                code: 'stream_closed',
                message: 'Inference stream was closed.',
                retryable: false,
              },
              lastPartial,
              active,
            );
          }

          controller.abort();
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
            throw new Error('ModelStream supports only one consumer.');
          }

          consumed = true;

          return iterate();
        },

        result() {
          if (!started) {
            return Promise.reject(
              new Error(
                'Consume the model stream before retrieving its result.',
              ),
            );
          }

          return completed;
        },
      };
    },
  };
}
