import type { ToolExecutionGateway, ToolExecutionResult } from '@russet/agent';

import { evaluateWorkspacePolicy } from '../policy/evaluate.js';
import type { WorkspaceAction, WorkspacePolicy } from '../policy/types.js';
import {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../workspace/paths.js';
import { WorkspaceError } from '../workspace/types.js';
import type { Workspace } from '../workspace/types.js';
import type { RuntimeToolRegistry } from './types.js';

const MAX_OUTPUT_BYTES = 64 * 1024;

export interface RuntimeGatewayOptions {
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;
  readonly registry: RuntimeToolRegistry;
}

function canAdvertise(
  policy: WorkspacePolicy,
  action: WorkspaceAction,
): boolean {
  if (
    policy.userCeiling[action] !== 'allow' ||
    policy.workspaceRestrictions[action] !== 'allow'
  ) {
    return false;
  }

  if (policy.mode === 'read_only') {
    return action === 'fs.read' || action === 'fs.search';
  }

  if (policy.mode === 'workspace_write') {
    return (
      action === 'fs.read' || action === 'fs.search' || action === 'fs.write'
    );
  }

  return false;
}

function rejected(
  code: Extract<ToolExecutionResult, { status: 'rejected' }>['code'],
  message: string,
): ToolExecutionResult {
  return { status: 'rejected', code, message };
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

  return {
    status: 'failed',
    message: 'The workspace resource could not be resolved.',
    sideEffects: 'none',
  };
}

function boundedOutput(text: string): {
  text: string;
  truncated: boolean;
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

export function createRuntimeGateway(
  options: RuntimeGatewayOptions,
): ToolExecutionGateway {
  const { workspace, policy, registry } = options;

  return {
    async listModelTools(context) {
      context.signal.throwIfAborted();

      return registry.list().filter((definition) => {
        const tool = registry.get(definition.name);

        return tool !== undefined && canAdvertise(policy, tool.action);
      });
    },

    async execute(request, context) {
      if (context.signal.aborted) {
        return cancelled('none');
      }

      const call = request.toolCall;
      const tool = registry.get(call.name);

      if (!tool) {
        return rejected('unknown_tool', 'Unknown runtime tool.');
      }

      if (call.argumentsError !== undefined) {
        return rejected(
          'invalid_arguments',
          'The model returned invalid tool arguments.',
        );
      }

      const args = tool.validate(call.arguments);

      if (args === undefined) {
        return rejected(
          'invalid_arguments',
          'Tool arguments do not match the registered schema.',
        );
      }

      let target: ReturnType<typeof tool.target>;

      try {
        target = tool.target(args);
      } catch {
        return {
          status: 'failed',
          message: 'The tool could not prepare its target.',
          sideEffects: 'none',
        };
      }

      if (
        !target ||
        typeof target.path !== 'string' ||
        (target.expectation !== 'existing' &&
          target.expectation !== 'new_file') ||
        (target.expectation === 'new_file' && tool.action !== 'fs.write')
      ) {
        return rejected('invalid_arguments', 'Invalid tool resource target.');
      }

      let resource;

      try {
        resource =
          target.expectation === 'new_file'
            ? await resolveNewWorkspaceFilePath(workspace, target.path)
            : await resolveExistingWorkspacePath(workspace, target.path);
      } catch (error) {
        if (context.signal.aborted) {
          return cancelled('none');
        }

        return workspaceFailure(error);
      }

      if (context.signal.aborted) {
        return cancelled('none');
      }

      const evaluation = evaluateWorkspacePolicy(policy, {
        action: tool.action,
        relativePath: resource.relativePath,
        kind: resource.kind,
      });

      if (evaluation.decision === 'deny') {
        return rejected(
          'permission_denied',
          'The runtime policy does not allow this operation.',
        );
      }

      if (evaluation.decision === 'ask') {
        return rejected(
          'approval_unavailable',
          'This operation requires approval, which is not configured.',
        );
      }

      if (context.signal.aborted) {
        return cancelled('none');
      }

      try {
        context.onUpdate({ type: 'execution.started' });
        if (context.signal.aborted) {
          return cancelled('none');
        }
      } catch {
        return {
          status: 'failed',
          message: 'Execution coordination failed.',
          sideEffects: 'none',
        };
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
          return cancelled('possible');
        }

        if (typeof text !== 'string') {
          throw new TypeError('Invalid tool output.');
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
      } catch {
        if (context.signal.aborted) {
          return cancelled('possible');
        }

        return {
          status: 'failed',
          message: 'The runtime tool did not complete successfully.',
          sideEffects: 'possible',
        };
      }
    },
  };
}
