export interface InferenceRequest {
  model: {
    providerId: string;
    modelId: string;
  };
  messages: readonly {
    role: 'user';
    text: string;
  }[];
}

export interface InferenceOptions {
  signal?: AbortSignal;
  thinking?: ThinkingOptions;
}

export type FinishReason =
  | 'stop'
  | 'tool_use'
  | 'length'
  | 'aborted'
  | 'error'
  | 'unsupported';

export type ThinkingVisibility = 'visible' | 'summary' | 'opaque' | 'unknown';

export type ThinkingEffort = 'low' | 'medium' | 'high';

export type ThinkingAvailability = 'available' | 'unavailable';

export interface ThinkingOptions {
  effort?: ThinkingEffort;
}

export interface ThinkingSupport {
  available: boolean;
  supportedEfforts: readonly ThinkingEffort[];
}

export interface ModelToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export type ModelBlock =
  | {
      id: string;
      type: 'text';
      text: string;
    }
  | {
      id: string;
      type: 'thinking';
      visibility: ThinkingVisibility;
      text?: string;
    }
  | {
      id: string;
      type: 'toolcall';
      toolCall: ModelToolCall;
    };

export interface ModelResponse {
  requestId: string;
  messageId: string;
  model: InferenceRequest['model'];
  finishReason: FinishReason;
  blocks: readonly ModelBlock[];
  thinkingAvailability?: ThinkingAvailability;
  nativeContinuation?: NativeContinuation;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  failure?: {
    code: string;
    message: string;
  };
}

interface EventIdentity {
  requestId: string;
  messageId: string;
}

interface BlockEventIdentity extends EventIdentity {
  blockId: string;
}

export type ModelEvent =
  | (EventIdentity & {
      type: 'response.started';
    })
  | (BlockEventIdentity & {
      type: 'text.started';
    })
  | (BlockEventIdentity & {
      type: 'text.delta';
      delta: string;
    })
  | (BlockEventIdentity & {
      type: 'text.completed';
      text: string;
    })
  | (BlockEventIdentity & {
      type: 'thinking.started';
      visibility: ThinkingVisibility;
    })
  | (BlockEventIdentity & {
      type: 'thinking.delta';
      delta: string;
    })
  | (BlockEventIdentity & {
      type: 'thinking.completed';
      visibility: ThinkingVisibility;
      text?: string;
    })
  | (BlockEventIdentity & {
      type: 'toolcall.started';
    })
  | (BlockEventIdentity & {
      type: 'toolcall.arguments.delta';
      delta: string;
    })
  | (BlockEventIdentity & {
      type: 'toolcall.completed';
      toolCall: ModelToolCall;
    })
  | (EventIdentity & {
      type: 'response.completed';
      response: ModelResponse;
    })
  | (EventIdentity & {
      type: 'response.failed';
      response: ModelResponse;
    });

export interface ModelStream extends AsyncIterable<ModelEvent> {
  result(): Promise<ModelResponse>;
}

export interface InferenceEngine {
  stream(request: InferenceRequest, options?: InferenceOptions): ModelStream;
}

export interface NativeContinuation {
  readonly format: 'pi-ai/in-memory-v1';
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: string;
}
