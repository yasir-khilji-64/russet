import type Type from 'typebox';

import type { ToolExecutionGateway } from '@russet/agent';

import type { WorkspaceFileAction } from '../policy/types.js';
import type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
} from '../workspace/types.js';

type ModelToolDefinition = Awaited<
  ReturnType<ToolExecutionGateway['listModelTools']>
>[number];

export interface RuntimeToolTarget {
  readonly path: string;
  readonly expectation: 'existing' | 'new_file';
}

export interface RuntimeToolContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly modelRequestId: string;
  readonly toolExecutionId: string;
  readonly resource: ExistingWorkspaceResource | NewWorkspaceFileTarget;
}

export interface RuntimeTool<TArguments extends object> {
  readonly name: string;
  readonly description: string;
  readonly action: WorkspaceFileAction;
  readonly parameters: ReturnType<typeof Type.Object>;
  readonly failureSideEffects?: 'none' | 'possible';
  readonly requiresRead?: boolean;
  readonly requiresPreparedContext?: boolean;

  target(arguments_: Readonly<TArguments>): RuntimeToolTarget;
  execute(
    arguments_: Readonly<TArguments>,
    context: RuntimeToolContext,
  ): Promise<string> | string;
}

export interface RegisteredRuntimeTool {
  readonly name: string;
  readonly action: WorkspaceFileAction;
  readonly modelDefinition: ModelToolDefinition;
  readonly failureSideEffects: 'none' | 'possible';
  readonly requiresRead: boolean;
  readonly requiresPreparedContext: boolean;

  validate(input: unknown): Readonly<Record<string, unknown>> | undefined;
  target(arguments_: Readonly<Record<string, unknown>>): RuntimeToolTarget;
  execute(
    arguments_: Readonly<Record<string, unknown>>,
    context: RuntimeToolContext,
  ): Promise<string> | string;
}

export interface RuntimeToolRegistry {
  get(name: string): RegisteredRuntimeTool | undefined;
  list(): readonly ModelToolDefinition[];
}
