import { randomUUID } from 'node:crypto';

import { getCompletedToolCalls } from '@russet/ai';
import type {
  ConversationMessage,
  InferenceEngine,
  InferenceOptions,
  InferenceRequest,
  ModelResponse,
  UserConversationMessage,
} from '@russet/ai';

import type { AgentEventListener } from '../events/types.js';
import { listToolsUntilCancelled } from '../tools/cancellation.js';
import { executeToolBatch } from '../tools/execute.js';
import type { ToolExecutionGateway } from '../tools/types.js';
import { prepareContextUntilCancelled } from './context.js';
import { snapshotConversation } from './conversation.js';
import { resolveAgentExecutionLimits } from './limits.js';
import { isExpectedModelResponse } from './response.js';
import type { AgentRunController } from './run.js';
import { AgentRunManager } from './run.js';
import type {
  Agent,
  AgentContextProvider,
  AgentExecutionLimits,
  AgentOptions,
  AgentRun,
  AgentRunRequest,
} from './types.js';

interface AgentState {
  disposed: boolean;
  requiresReconciliation: boolean;
  conversation: ConversationMessage[];
}

class AgentKernel implements Agent {
  private readonly inference: InferenceEngine;
  private readonly toolGateway: ToolExecutionGateway | undefined;
  private readonly contextProvider: AgentContextProvider | undefined;
  private readonly runs = new AgentRunManager();

  private readonly state: AgentState = {
    disposed: false,
    requiresReconciliation: false,
    conversation: [],
  };

  constructor(options: AgentOptions) {
    this.inference = options.inference;
    this.toolGateway = options.toolGateway;
    this.contextProvider = options.contextProvider;
  }

  start(request: AgentRunRequest, onEvent?: AgentEventListener): AgentRun {
    if (this.state.disposed) {
      throw new Error('The agent has been disposed.');
    }

    if (this.state.requiresReconciliation) {
      throw new Error('An uncertain tool outcome requires reconciliation.');
    }

    if (request.message.trim().length === 0) {
      throw new Error('Agent run message must not be empty.');
    }

    const limits = resolveAgentExecutionLimits(request.limits);

    const userMessage: UserConversationMessage = {
      role: 'user',
      text: request.message,
      timestamp: Date.now(),
    };

    const initialRequest: InferenceRequest = {
      model: { ...request.model },
      messages: [...this.state.conversation, userMessage],
      ...(request.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.systemPrompt }),
    };

    const run = this.runs.createRun(randomUUID(), request.signal, onEvent);

    const options: InferenceOptions = {
      signal: run.signal,
      ...(request.thinking === undefined
        ? {}
        : { thinking: { ...request.thinking } }),
    };

    run.publish({
      type: 'run.started',
      model: Object.freeze({ ...initialRequest.model }),
      phase: 'preparing',
    });

    queueMicrotask(() => {
      void this.executeRun(
        run,
        userMessage,
        initialRequest,
        options,
        limits,
      ).catch(() => {
        // An unexpected failure after dispatch cannot prove
        // that side effects did not occur.
        if (run.state.kind === 'finished') {
          return;
        }

        if (run.state.phase === 'dispatching') {
          this.state.requiresReconciliation = true;

          run.finish('interrupted', {
            kind: 'tool_execution_uncertain',
            message: 'Tool coordination ended unexpectedly.',
          });
        } else if (run.signal.aborted) {
          run.finish('cancelled');
        } else {
          run.finish('failed', {
            kind: 'internal_error',
            message: 'Agent execution failed unexpectedly.',
          });
        }
      });
    });

    return run;
  }

  getConversation(): readonly ConversationMessage[] {
    return snapshotConversation(this.state.conversation);
  }

  async dispose(): Promise<void> {
    this.state.disposed = true;

    const activeRun = this.runs.activeRun;

    if (activeRun !== undefined) {
      activeRun.cancel('Agent disposed.');
      await activeRun.result;
    }
  }

  private async executeRun(
    run: AgentRunController,
    userMessage: UserConversationMessage,
    initialRequest: InferenceRequest,
    options: InferenceOptions,
    limits: Readonly<AgentExecutionLimits>,
  ): Promise<void> {
    let pendingUserMessage: UserConversationMessage | undefined = userMessage;

    let modelRequests = 0;
    let toolAttempts = 0;

    while (true) {
      if (run.signal.aborted) {
        run.finish('cancelled');
        return;
      }

      run.setPhase('preparing');

      if (modelRequests >= limits.maxModelRequests) {
        run.finish('limit_reached', {
          kind: 'execution_limit',
          message: 'Model request limit reached.',
        });
        return;
      }

      let tools: InferenceRequest['tools'];

      if (this.toolGateway !== undefined) {
        try {
          tools = await listToolsUntilCancelled(this.toolGateway, run.signal);
        } catch {
          if (run.signal.aborted) {
            run.finish('cancelled');
          } else {
            run.finish('failed', {
              kind: 'tool_gateway_error',
              message: 'The runtime could not describe model tools.',
            });
          }

          return;
        }
      }

      if (run.signal.aborted) {
        run.finish('cancelled');
        return;
      }

      const conversation =
        pendingUserMessage === undefined
          ? [...this.state.conversation]
          : [...this.state.conversation, pendingUserMessage];

      let systemPrompt = initialRequest.systemPrompt;

      if (this.contextProvider !== undefined) {
        try {
          const prepared = await prepareContextUntilCancelled(
            this.contextProvider,
            {
              runId: run.id,
              modelRequestOrdinal: modelRequests + 1,
              model: Object.freeze({ ...initialRequest.model }),
              conversation: snapshotConversation(conversation),
              signal: run.signal,
            },
          );

          if (
            typeof prepared.instructions !== 'string' ||
            typeof prepared.revision !== 'string' ||
            prepared.revision.trim().length === 0
          ) {
            throw new Error('Invalid prepared agent context.');
          }

          if (prepared.instructions.length > 0) {
            systemPrompt =
              systemPrompt === undefined || systemPrompt.length === 0
                ? prepared.instructions
                : `${systemPrompt}\n\n${prepared.instructions}`;
          }

          if (run.signal.aborted) {
            run.finish('cancelled');
            return;
          }

          run.publish({
            type: 'model.context.prepared',
            ordinal: modelRequests + 1,
            revision: prepared.revision,
          });
        } catch {
          if (run.signal.aborted) {
            run.finish('cancelled');
          } else {
            run.finish('failed', {
              kind: 'context_preparation_error',
              message: 'The agent could not prepare its inference context.',
            });
          }
          return;
        }
      }

      if (run.signal.aborted) {
        run.finish('cancelled');
        return;
      }

      const inferenceRequest: InferenceRequest = {
        model: initialRequest.model,
        messages: conversation,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(tools === undefined ? {} : { tools }),
      };

      run.setPhase('inference');

      modelRequests++;

      run.publish({
        type: 'model.request.started',
        ordinal: modelRequests,
      });

      if (run.signal.aborted) {
        run.finish('cancelled');
        return;
      }

      let response: ModelResponse;

      try {
        const stream = this.inference.stream(inferenceRequest, options);

        for await (const event of stream) {
          if (
            event.type !== 'response.completed' &&
            event.type !== 'response.failed'
          ) {
            run.publish({
              type: 'model.event',
              event: structuredClone(event),
            });
          }
        }

        response = await stream.result();
      } catch {
        run.publish({
          type: 'model.request.failed',
          reason: 'stream_error',
        });

        if (run.signal.aborted) {
          run.finish('cancelled');
        } else {
          run.finish('failed', {
            kind: 'stream_error',
            message: 'The inference stream did not complete successfully.',
          });
        }

        return;
      }

      run.publish({
        type: 'model.request.finished',
        requestId: response.requestId,
        messageId: response.messageId,
        finishReason: response.finishReason,
        ...(response.failure === undefined
          ? {}
          : {
              failure: Object.freeze({ ...response.failure }),
            }),
      });

      if (run.signal.aborted || response.failure?.code === 'cancelled') {
        run.finish('cancelled');
        return;
      }

      if (!isExpectedModelResponse(response, initialRequest.model)) {
        run.finish('failed', {
          kind: 'invalid_model_response',
          message: 'The completed model response has an invalid identity.',
        });
        return;
      }

      if (response.failure !== undefined) {
        run.finish('failed', {
          kind: 'inference',
          failure: response.failure,
        });
        return;
      }

      if (response.finishReason === 'aborted') {
        run.finish('cancelled');
        return;
      }

      if (response.finishReason === 'stop') {
        if (response.blocks.some((block) => block.type === 'toolcall')) {
          run.finish('failed', {
            kind: 'invalid_model_response',
            message: 'A stop response cannot contain tool calls.',
          });
          return;
        }

        if (pendingUserMessage !== undefined) {
          this.state.conversation.push(pendingUserMessage);
        }

        this.state.conversation.push({
          role: 'assistant',
          response,
        });

        run.finish('completed');
        return;
      }

      if (response.finishReason === 'tool_use') {
        if (this.toolGateway === undefined) {
          run.finish('failed', {
            kind: 'tool_execution_unavailable',
            message: 'Tool execution is not configured for this agent.',
          });
          return;
        }

        let calls: ReturnType<typeof getCompletedToolCalls>;

        try {
          calls = getCompletedToolCalls(response);
        } catch {
          run.finish('failed', {
            kind: 'invalid_model_response',
            message: 'The model returned invalid completed tool calls.',
          });
          return;
        }

        if (run.signal.aborted) {
          run.finish('cancelled');
          return;
        }

        if (calls.length > limits.maxToolAttempts - toolAttempts) {
          run.finish('limit_reached', {
            kind: 'execution_limit',
            message: 'Tool attempt limit reached.',
          });
          return;
        }

        if (pendingUserMessage !== undefined) {
          this.state.conversation.push(pendingUserMessage);
          pendingUserMessage = undefined;
        }

        // Commit the authoritative assistant message
        // before runtime dispatch.
        this.state.conversation.push({
          role: 'assistant',
          response,
        });

        const batch = await executeToolBatch({
          run,
          gateway: this.toolGateway,
          response,
          calls,
          conversation: this.state.conversation,
          maxCancellationWaitMs: limits.maxCancellationWaitMs,
        });

        toolAttempts += batch.attempted;

        if (batch.resolution === 'interrupted') {
          this.state.requiresReconciliation = true;

          run.finish('interrupted', {
            kind: 'tool_execution_uncertain',
            message: 'Tool execution outcome requires reconciliation.',
          });
          return;
        }

        if (batch.resolution === 'cancelled') {
          run.finish('cancelled');
          return;
        }

        // Every tool proposal now has an ordered result.
        // The updated conversation can be sent to AI.
        continue;
      }

      if (response.finishReason === 'length') {
        run.finish('failed', {
          kind: 'model_truncated',
          message: 'The model response was truncated.',
        });
        return;
      }

      run.finish('failed', {
        kind: 'invalid_model_response',
        message: 'The model response did not finish successfully.',
      });
      return;
    }
  }
}

export function createAgent(options: AgentOptions): Agent {
  return new AgentKernel(options);
}
