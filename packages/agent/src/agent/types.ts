import type {
  ConversationMessage,
  InferenceEngine,
  InferenceFailure,
  ModelId,
  ThinkingOptions,
} from '@russet/ai';

import type { AgentEventListener, AgentRunPhase } from '../events/types.js';
import type { ToolExecutionGateway } from '../tools/types.js';

export interface AgentContextRequest {
  readonly runId: string;
  readonly modelRequestOrdinal: number;
  readonly model: Readonly<ModelId>;
  readonly conversation: readonly ConversationMessage[];
  readonly signal: AbortSignal;
}

export interface PreparedAgentContext {
  readonly instructions: string;
  readonly revision: string;
}

export interface AgentOptions {
  inference: InferenceEngine;
  toolGateway?: ToolExecutionGateway;
  contextProvider?: AgentContextProvider;
}

export interface AgentExecutionLimits {
  readonly maxModelRequests: number;
  readonly maxToolAttempts: number;
  readonly maxCancellationWaitMs: number;
}

export interface AgentRunRequest {
  message: string;
  model: ModelId;
  systemPrompt?: string;
  thinking?: ThinkingOptions;
  limits?: Partial<AgentExecutionLimits>;
  signal?: AbortSignal;
}

export type AgentRunStatus =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'limit_reached'
  | 'interrupted';

export type AgentRunFailure =
  | {
      kind: 'context_preparation_error';
      message: string;
    }
  | {
      kind: 'inference';
      failure: InferenceFailure;
    }
  | {
      kind: 'invalid_model_response';
      message: string;
    }
  | {
      kind: 'model_truncated';
      message: string;
    }
  | {
      kind: 'tool_execution_unavailable';
      message: string;
    }
  | {
      kind: 'tool_gateway_error';
      message: string;
    }
  | {
      kind: 'tool_execution_uncertain';
      message: string;
    }
  | {
      kind: 'execution_limit';
      message: string;
    }
  | {
      kind: 'stream_error';
      message: string;
    }
  | {
      kind: 'internal_error';
      message: string;
    };

export interface AgentRunResult {
  runId: string;
  status: AgentRunStatus;
  failure?: AgentRunFailure;
}

export type AgentRunState =
  | {
      readonly kind: 'active';
      readonly phase: AgentRunPhase;
    }
  | {
      readonly kind: 'finished';
      readonly result: AgentRunResult;
    };

export interface AgentContextProvider {
  prepare(request: AgentContextRequest): Promise<PreparedAgentContext>;
}

export interface AgentRun {
  readonly id: string;
  readonly result: Promise<AgentRunResult>;
  readonly state: AgentRunState;

  cancel(reason?: string): void;
  subscribe(listener: AgentEventListener): () => void;
}

export interface Agent {
  start(request: AgentRunRequest, onEvent?: AgentEventListener): AgentRun;
  getConversation(): readonly ConversationMessage[];
  dispose(): Promise<void>;
}
