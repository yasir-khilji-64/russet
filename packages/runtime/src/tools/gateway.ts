import { basename } from 'node:path';

import type { ToolExecutionGateway, ToolExecutionResult } from '@russet/agent';

import { awaitApproval, createApprovalRequest } from '../approvals/once.js';
import type { ApprovalBroker } from '../approvals/once.js';
import type { MutationContextGuard } from '../context/mutation.js';
import { evaluateWorkspacePolicy } from '../policy/evaluate.js';
import type {
  Permission,
  WorkspaceAction,
  WorkspacePolicy,
} from '../policy/types.js';
import {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../workspace/paths.js';
import { WorkspaceError } from '../workspace/types.js';
import type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
  Workspace,
} from '../workspace/types.js';
import { ManagedToolError, WritePreconditionError } from './errors.js';
import type {
  RegisteredRuntimeTool,
  RuntimeToolRegistry,
  RuntimeToolTarget,
} from './types.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const MAX_APPROVAL_TIMEOUT_MS = 300_000;

type Resource = ExistingWorkspaceResource | NewWorkspaceFileTarget;

type RejectionCode = Extract<
  ToolExecutionResult,
  { status: 'rejected' }
>['code'];

export interface RuntimeGatewayOptions {
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;
  readonly registry: RuntimeToolRegistry;

  readonly approvalBroker?: ApprovalBroker;
  readonly approvalTimeoutMs?: number;
  readonly mutationContext?: MutationContextGuard;
}

function modeDecision(
  policy: WorkspacePolicy,
  action: WorkspaceAction,
): Permission {
  if (policy.mode === 'read_only') {
    return action === 'fs.read' || action === 'fs.search' ? 'allow' : 'deny';
  }

  if (policy.mode === 'workspace_write') {
    return action === 'fs.read' ||
      action === 'fs.search' ||
      action === 'fs.write'
      ? 'allow'
      : 'ask';
  }

  return 'deny';
}

function canAdvertise(
  policy: WorkspacePolicy,
  action: WorkspaceAction,
  approvalsAvailable: boolean,
): boolean {
  const decisions = [
    policy.userCeiling[action],
    policy.workspaceRestrictions[action],
    modeDecision(policy, action),
  ];

  if (decisions.includes('deny')) {
    return false;
  }

  return approvalsAvailable || !decisions.includes('ask');
}

function rejected(code: RejectionCode, message: string): ToolExecutionResult {
  return { status: 'rejected', code, message };
}

function failed(
  message: string,
  sideEffects: 'none' | 'possible' = 'none',
): ToolExecutionResult {
  return { status: 'failed', message, sideEffects };
}

function cancelled(sideEffects: 'none' | 'possible'): ToolExecutionResult {
  return {
    status: 'cancelled',
    message: 'Tool execution was cancelled.',
    sideEffects,
  };
}

function workspaceFailure(error: unknown): ToolExecutionResult {
  if (error instanceof WorkspaceError) {
    switch (error.code) {
      case 'outside_workspace':
      case 'symlink_disallowed':
        return rejected(
          'permission_denied',
          'The target is outside the permitted workspace boundary.',
        );

      case 'invalid_path':
      case 'not_found':
      case 'not_directory':
      case 'already_exists':
      case 'unsupported_resource':
        return rejected(
          'invalid_arguments',
          'The requested workspace target is invalid.',
        );
    }
  }

  return failed('The workspace resource could not be resolved.');
}

async function resolveTarget(
  workspace: Workspace,
  target: RuntimeToolTarget,
): Promise<Resource> {
  return target.expectation === 'new_file'
    ? resolveNewWorkspaceFilePath(workspace, target.path)
    : resolveExistingWorkspacePath(workspace, target.path);
}

function evaluateAuthority(
  policy: WorkspacePolicy,
  tool: RegisteredRuntimeTool,
  resource: Resource,
): {
  readonly deny: boolean;
  readonly ask: boolean;
} {
  const operation = evaluateWorkspacePolicy(policy, {
    action: tool.action,
    relativePath: resource.relativePath,
    kind: resource.kind,
  });

  const read = tool.requiresRead
    ? evaluateWorkspacePolicy(policy, {
        action: 'fs.read',
        relativePath: resource.relativePath,
        kind: resource.kind,
      })
    : undefined;

  return {
    deny: operation.decision === 'deny' || read?.decision === 'deny',

    ask: operation.decision === 'ask' || read?.decision === 'ask',
  };
}

function boundedOutput(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }

  let end = MAX_OUTPUT_BYTES;

  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }

  return {
    text: bytes.subarray(0, end).toString('utf8'),
    truncated: true,
  };
}

function invalidArgumentsMessage(tool: RegisteredRuntimeTool): string {
  const schema = JSON.stringify(tool.modelDefinition.parameters);

  const hint =
    schema.length <= 2_048
      ? ` Expected parameter schema: ${schema}`
      : ' Refer to the advertised tool parameter schema.';

  return (
    `Invalid arguments for "${tool.name}".` +
    hint +
    ' Correct the invalid fields before retrying.'
  );
}

export function createRuntimeGateway(
  options: RuntimeGatewayOptions,
): ToolExecutionGateway {
  const { workspace, policy, registry, approvalBroker, mutationContext } =
    options;

  const approvalTimeoutMs =
    options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  if (
    !Number.isSafeInteger(approvalTimeoutMs) ||
    approvalTimeoutMs < 1 ||
    approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS
  ) {
    throw new TypeError('Invalid approval timeout.');
  }

  return {
    async listModelTools(context) {
      context.signal.throwIfAborted();

      return registry.list().filter((definition) => {
        const tool = registry.get(definition.name);

        return (
          tool !== undefined &&
          (!tool.requiresPreparedContext || mutationContext !== undefined) &&
          canAdvertise(policy, tool.action, approvalBroker !== undefined) &&
          (!tool.requiresRead ||
            canAdvertise(policy, 'fs.read', approvalBroker !== undefined))
        );
      });
    },

    async execute(request, context) {
      if (context.signal.aborted) {
        return cancelled('none');
      }

      const call = request.toolCall;
      const tool = registry.get(call.name);

      if (tool === undefined) {
        return rejected('unknown_tool', 'Unknown runtime tool.');
      }

      if (call.argumentsError !== undefined) {
        return rejected(
          'invalid_arguments',
          'The model returned invalid tool arguments.',
        );
      }

      let args: ReturnType<typeof tool.validate>;

      try {
        args = tool.validate(call.arguments);
      } catch {
        return failed('The runtime could not validate tool arguments.');
      }

      if (args === undefined) {
        return rejected('invalid_arguments', invalidArgumentsMessage(tool));
      }

      let target: RuntimeToolTarget;

      try {
        target = tool.target(args);
      } catch {
        return failed('The tool could not prepare its target.');
      }

      if (
        target === null ||
        typeof target !== 'object' ||
        typeof target.path !== 'string' ||
        (target.expectation !== 'existing' &&
          target.expectation !== 'new_file') ||
        (target.expectation === 'new_file' && tool.action !== 'fs.write')
      ) {
        return rejected('invalid_arguments', 'Invalid tool resource target.');
      }

      let resource: Resource;

      try {
        resource = await resolveTarget(workspace, target);
      } catch (error) {
        return context.signal.aborted
          ? cancelled('none')
          : workspaceFailure(error);
      }

      if (context.signal.aborted) {
        return cancelled('none');
      }

      let authority = evaluateAuthority(policy, tool, resource);

      if (authority.deny) {
        return rejected(
          'permission_denied',
          'The runtime policy does not allow this operation.',
        );
      }

      const requiresPreparedContext = tool.requiresPreparedContext;

      async function checkPreparedContext(): Promise<
        'ready' | 'refresh' | 'unavailable'
      > {
        if (!requiresPreparedContext) {
          return 'ready';
        }

        if (mutationContext === undefined) {
          return 'unavailable';
        }

        return mutationContext.check(request.runId, resource, context.signal);
      }

      async function enforceContext(): Promise<
        ToolExecutionResult | undefined
      > {
        let status: Awaited<ReturnType<typeof checkPreparedContext>>;

        try {
          status = await checkPreparedContext();
        } catch {
          return context.signal.aborted
            ? cancelled('none')
            : failed('Workspace context could not be verified.');
        }

        if (context.signal.aborted) {
          return cancelled('none');
        }

        if (status === 'unavailable') {
          return rejected(
            'permission_denied',
            'Required mutation-context verification is not configured.',
          );
        }

        if (status === 'refresh') {
          return rejected(
            'context_refresh_required',
            'Applicable workspace instructions must be refreshed before this operation is retried.',
          );
        }

        return undefined;
      }

      const beforeApproval = await enforceContext();

      if (beforeApproval !== undefined) {
        return beforeApproval;
      }

      const modifiesAgentsMd =
        tool.action === 'fs.write' &&
        basename(resource.relativePath).toLowerCase() === 'agents.md';

      let approvedUntil: number | undefined;

      if (authority.ask || modifiesAgentsMd) {
        if (approvalBroker === undefined) {
          return rejected(
            'approval_unavailable',
            'This operation requires approval, which is not configured.',
          );
        }

        const approval = createApprovalRequest(
          {
            execution: request,
            arguments: args,
            resource,
            workspace,
            policy,
          },
          approvalTimeoutMs,
        );

        try {
          context.onUpdate({
            type: 'approval.requested',
            approvalRequestId: approval.id,
            description: approval.description,
          });
        } catch {
          return failed('Approval coordination failed.');
        }

        let outcome: Awaited<ReturnType<typeof awaitApproval>>;

        try {
          outcome = await awaitApproval(
            approvalBroker,
            approval,
            context.signal,
          );
        } catch {
          return context.signal.aborted
            ? cancelled('none')
            : failed('Approval coordination failed.');
        }

        try {
          context.onUpdate({
            type: 'approval.resolved',
            approvalRequestId: approval.id,
            decision: outcome === 'allow' ? 'allow' : 'deny',
          });
        } catch {
          return failed('Approval coordination failed.');
        }

        if (context.signal.aborted || outcome === 'cancelled') {
          return cancelled('none');
        }

        if (outcome === 'expired') {
          return rejected('approval_expired', 'The approval request expired.');
        }

        if (outcome !== 'allow') {
          return rejected(
            'permission_denied',
            'The operation was not approved.',
          );
        }

        approvedUntil = approval.expiresAt;
      }

      let current: Resource;

      try {
        current = await resolveTarget(workspace, target);
      } catch (error) {
        return context.signal.aborted
          ? cancelled('none')
          : workspaceFailure(error);
      }

      if (
        current.relativePath !== resource.relativePath ||
        current.kind !== resource.kind
      ) {
        return rejected(
          'invalid_arguments',
          'The operation target changed before execution.',
        );
      }

      resource = current;

      authority = evaluateAuthority(policy, tool, resource);

      if (authority.deny) {
        return rejected(
          'permission_denied',
          'The operation is no longer permitted.',
        );
      }

      if (authority.ask && approvedUntil === undefined) {
        return rejected(
          'approval_unavailable',
          'The operation requires approval.',
        );
      }

      const afterApproval = await enforceContext();

      if (afterApproval !== undefined) {
        return afterApproval;
      }

      if (approvedUntil !== undefined && Date.now() >= approvedUntil) {
        return rejected('approval_expired', 'The approval request expired.');
      }

      if (context.signal.aborted) {
        return cancelled('none');
      }

      try {
        context.onUpdate({
          type: 'execution.started',
        });
      } catch {
        return failed('Execution coordination failed.');
      }

      if (context.signal.aborted) {
        return cancelled('none');
      }

      try {
        const text = await tool.execute(args, {
          signal: context.signal,
          runId: request.runId,
          modelRequestId: request.modelRequestId,
          toolExecutionId: request.toolExecutionId,
          resource,
        });

        if (context.signal.aborted) {
          return cancelled(tool.failureSideEffects);
        }

        if (typeof text !== 'string') {
          throw new TypeError('Runtime tool returned non-text output.');
        }

        const output = boundedOutput(text);

        return {
          status: 'success',
          content: [
            {
              type: 'text',
              text: output.text,
            },
          ],
          ...(output.truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        if (context.signal.aborted) {
          return cancelled(tool.failureSideEffects);
        }

        // Only valid for pre-mutation failures.
        if (error instanceof WritePreconditionError) {
          return failed(error.message, 'none');
        }

        return failed(
          error instanceof ManagedToolError
            ? error.message
            : 'The runtime tool did not complete successfully.',
          tool.failureSideEffects,
        );
      }
    },
  };
}
