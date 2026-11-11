import { randomUUID } from 'node:crypto';

import type {
  ConversationMessage,
  ModelResponse,
  ModelToolCall,
  ToolResultConversationMessage,
} from '@russet/ai';

import { DEFAULT_AGENT_EXECUTION_LIMITS } from '../agent/limits.js';
import type { AgentRunController } from '../agent/run.js';
import { awaitExecutionOutcome } from './cancellation.js';
import { assertToolBatchIntegrity } from './integrity.js';
import type {
  ToolExecutionGateway,
  ToolExecutionResult,
  ToolExecutionUpdate,
} from './types.js';

export type ToolBatchResolution = 'continue' | 'cancelled' | 'interrupted';

export interface ToolBatchResult {
  readonly resolution: ToolBatchResolution;
  readonly attempted: number;
}

export interface ToolBatchRequest {
  readonly run: AgentRunController;
  readonly gateway: ToolExecutionGateway;
  readonly response: ModelResponse;
  readonly calls: readonly ModelToolCall[];
  readonly conversation: ConversationMessage[];
  readonly maxCancellationWaitMs?: number;
}

interface InvocationState {
  settled: boolean;
  pendingApprovalId: string | undefined;
  handlerStarted: boolean;
}

function reportUpdate(
  run: AgentRunController,
  call: ModelToolCall,
  toolExecutionId: string,
  state: InvocationState,
  update: ToolExecutionUpdate,
): void {
  if (state.settled) {
    return;
  }

  switch (update.type) {
    case 'approval.requested': {
      if (state.pendingApprovalId !== undefined || state.handlerStarted) {
        return;
      }

      state.pendingApprovalId = update.approvalRequestId;

      run.setPhase('awaiting_approval');

      run.publish({
        type: 'tool.approval.requested',
        toolCallId: call.toolCallId,
        toolExecutionId,
        approvalRequestId: update.approvalRequestId,
        description: update.description,
      });

      return;
    }

    case 'approval.resolved': {
      if (state.pendingApprovalId !== update.approvalRequestId) {
        return;
      }

      state.pendingApprovalId = undefined;

      run.setPhase('dispatching');

      run.publish({
        type: 'tool.approval.resolved',
        toolCallId: call.toolCallId,
        toolExecutionId,
        approvalRequestId: update.approvalRequestId,
        decision: update.decision,
      });

      return;
    }

    case 'execution.started': {
      if (state.handlerStarted) {
        return;
      }

      state.handlerStarted = true;

      run.setPhase('executing_tool');

      run.publish({
        type: 'tool.execution.started',
        toolCallId: call.toolCallId,
        toolExecutionId,
      });

      return;
    }
  }
}

function toToolResult(
  call: ModelToolCall,
  result: ToolExecutionResult,
): ToolResultConversationMessage {
  const content: { type: 'text'; text: string }[] =
    result.status === 'success'
      ? result.content.map((block) => ({
          type: 'text',
          text: block.text,
        }))
      : [
          {
            type: 'text',
            text:
              result.status === 'rejected'
                ? `${result.code}: ${result.message}`
                : result.message,
          },
        ];

  if (result.status === 'success' && result.truncated === true) {
    content.push({
      type: 'text',
      text:
        '[Russet notice: Tool output was truncated. ' +
        'The returned content is incomplete.]',
    });
  }

  return {
    role: 'tool_result',
    toolCallId: call.toolCallId,
    toolName: call.name,
    content,
    isError: result.status !== 'success',
    timestamp: Date.now(),
  };
}

function appendSkipped(
  conversation: ConversationMessage[],
  run: AgentRunController,
  call: ModelToolCall,
  reason: 'cancelled' | 'batch_stopped',
): void {
  conversation.push({
    role: 'tool_result',
    toolCallId: call.toolCallId,
    toolName: call.name,
    content: [
      {
        type: 'text',
        text:
          reason === 'cancelled'
            ? 'Not executed: agent run was cancelled.'
            : 'Not executed: an earlier tool did not succeed.',
      },
    ],
    isError: true,
    timestamp: Date.now(),
  });

  run.publish({
    type: 'tool.skipped',
    toolCallId: call.toolCallId,
    reason,
  });
}

export async function executeToolBatch(
  request: ToolBatchRequest,
): Promise<ToolBatchResult> {
  const { run, gateway, response, calls, conversation } = request;
  const firstResultIndex = conversation.length;

  run.setPhase('dispatching');

  for (const call of calls) {
    run.publish({
      type: 'tool.proposed',
      toolCallId: call.toolCallId,
      name: call.name,
    });
  }

  let skipReason: 'cancelled' | 'batch_stopped' | undefined;

  let uncertain = false;
  let cancelledByRuntime = false;
  let attempted = 0;

  for (const call of calls) {
    if (skipReason !== undefined || run.signal.aborted) {
      skipReason = skipReason ?? 'cancelled';
      appendSkipped(conversation, run, call, skipReason);
      continue;
    }

    const toolExecutionId = randomUUID();

    run.publish({
      type: 'tool.dispatch.started',
      toolCallId: call.toolCallId,
      toolExecutionId,
    });

    // Event observers can request cancellation synchronously.
    if (run.signal.aborted) {
      skipReason = 'cancelled';
      appendSkipped(conversation, run, call, skipReason);
      continue;
    }

    const invocation: InvocationState = {
      settled: false,
      pendingApprovalId: undefined,
      handlerStarted: false,
    };

    let result: ToolExecutionResult;

    try {
      attempted++;

      const operation = gateway.execute(
        {
          runId: run.id,
          modelRequestId: response.requestId,
          toolExecutionId,
          toolCall: structuredClone(call),
        },
        {
          signal: run.signal,
          onUpdate: (update) => {
            reportUpdate(run, call, toolExecutionId, invocation, update);
          },
        },
      );

      result = await awaitExecutionOutcome(
        operation,
        run.signal,
        request.maxCancellationWaitMs ??
          DEFAULT_AGENT_EXECUTION_LIMITS.maxCancellationWaitMs,
      );
    } catch {
      // A rejected gateway promise cannot prove that
      // an already-started operation had no side effects.
      result = {
        status: 'failed',
        message: 'The runtime did not confirm the tool outcome.',
        sideEffects: 'possible',
      };
    } finally {
      invocation.settled = true;
      run.setPhase('dispatching');
    }

    conversation.push(toToolResult(call, result));

    const possibleEffects =
      (result.status === 'failed' || result.status === 'cancelled') &&
      result.sideEffects === 'possible';

    run.publish({
      type: 'tool.dispatch.finished',
      toolCallId: call.toolCallId,
      toolExecutionId,
      status: possibleEffects ? 'uncertain' : result.status,
    });

    if (possibleEffects) {
      uncertain = true;
      skipReason = 'batch_stopped';
    } else if (result.status === 'cancelled') {
      cancelledByRuntime = true;
      skipReason = 'cancelled';
    } else if (run.signal.aborted) {
      skipReason = 'cancelled';
    } else if (result.status !== 'success') {
      skipReason = 'batch_stopped';
    }
  }

  assertToolBatchIntegrity(calls, conversation, firstResultIndex);

  if (uncertain) {
    return { resolution: 'interrupted', attempted };
  }

  if (run.signal.aborted || cancelledByRuntime) {
    return { resolution: 'cancelled', attempted };
  }

  return { resolution: 'continue', attempted };
}
