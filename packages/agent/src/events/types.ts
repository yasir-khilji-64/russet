import type {
  FinishReason,
  InferenceFailure,
  ModelEvent,
  ModelId,
} from '@russet/ai';

import type { AgentRunResult } from '../agent/types.js';
import type { ToolExecutionResult } from '../tools/types.js';

export type AgentRunPhase =
  | 'preparing'
  | 'inference'
  | 'dispatching'
  | 'awaiting_approval'
  | 'executing_tool';

export type ModelObservationEvent = Exclude<
  ModelEvent,
  { type: 'response.completed' | 'response.failed' }
>;

export type AgentEventPayload =
  | {
      readonly type: 'run.started';
      readonly model: Readonly<ModelId>;
      readonly phase: 'preparing';
    }
  | {
      readonly type: 'run.phase_changed';
      readonly phase: AgentRunPhase;
    }
  | {
      readonly type: 'model.request.started';
      readonly ordinal: number;
    }
  | {
      readonly type: 'model.event';
      readonly event: ModelObservationEvent;
    }
  | {
      readonly type: 'model.request.finished';
      readonly requestId: string;
      readonly messageId: string;
      readonly finishReason: FinishReason;
      readonly failure?: InferenceFailure;
    }
  | {
      readonly type: 'model.request.failed';
      readonly reason: 'stream_error';
    }
  | {
      readonly type: 'model.context.prepared';
      readonly ordinal: number;
      readonly revision: string;
    }
  | {
      readonly type: 'tool.proposed';
      readonly toolCallId: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool.dispatch.started';
      readonly toolCallId: string;
      readonly toolExecutionId: string;
    }
  | {
      readonly type: 'tool.dispatch.finished';
      readonly toolCallId: string;
      readonly toolExecutionId: string;
      readonly status: ToolExecutionResult['status'] | 'uncertain';
    }
  | {
      readonly type: 'tool.approval.requested';
      readonly toolCallId: string;
      readonly toolExecutionId: string;
      readonly approvalRequestId: string;
      readonly description: string;
    }
  | {
      readonly type: 'tool.approval.resolved';
      readonly toolCallId: string;
      readonly toolExecutionId: string;
      readonly approvalRequestId: string;
      readonly decision: 'allow' | 'deny';
    }
  | {
      readonly type: 'tool.execution.started';
      readonly toolCallId: string;
      readonly toolExecutionId: string;
    }
  | {
      readonly type: 'tool.skipped';
      readonly toolCallId: string;
      readonly reason: 'cancelled' | 'batch_stopped';
    }
  | {
      readonly type: 'run.finished';
      readonly result: AgentRunResult;
    };

export type AgentEvent = Readonly<{
  runId: string;
  sequence: number;
  timestamp: number;
}> &
  AgentEventPayload;

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
