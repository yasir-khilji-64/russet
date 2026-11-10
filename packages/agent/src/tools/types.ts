import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolResultConversationMessage,
} from '@russet/ai';

export interface ToolExecutionGateway {
  listModelTools(
    context: ToolDiscoveryContext,
  ): Promise<readonly ModelToolDefinition[]>;
  execute(
    request: ToolExecutionRequest,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface ToolDiscoveryContext {
  readonly signal: AbortSignal;
}

export interface ToolExecutionRequest {
  readonly runId: string;
  readonly modelRequestId: string;
  readonly toolExecutionId: string;
  readonly toolCall: ModelToolCall;
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly onUpdate: (update: ToolExecutionUpdate) => void;
}

export type ToolExecutionUpdate =
  | {
      readonly type: 'approval.requested';
      readonly approvalRequestId: string;
      readonly description: string;
    }
  | {
      readonly type: 'approval.resolved';
      readonly approvalRequestId: string;
      readonly decision: 'allow' | 'deny';
    }
  | {
      readonly type: 'execution.started';
    };

export type ToolExecutionResult =
  | {
      readonly status: 'success';
      readonly content: ToolResultConversationMessage['content'];
      readonly truncated?: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'unknown_tool'
        | 'invalid_arguments'
        | 'permission_denied'
        | 'approval_unavailable'
        | 'context_refresh_required'
        | 'approval_expired';
      readonly message: string;
    }
  | {
      readonly status: 'failed' | 'cancelled';
      readonly message: string;
      readonly sideEffects: 'none' | 'possible';
    };
