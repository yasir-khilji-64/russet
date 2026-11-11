import { createHash, randomUUID } from 'node:crypto';

import type { ToolExecutionRequest } from '@russet/agent';

import type { WorkspacePolicy } from '../policy/types.js';
import type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
  Workspace,
} from '../workspace/types.js';

export interface ApprovalRequest {
  readonly id: string;
  readonly fingerprint: string;
  readonly description: string;
  readonly expiresAt: number;
  readonly operation: Readonly<{
    toolName: string;
    target: string;
    arguments: Readonly<Record<string, unknown>>;
  }>;
}

export interface ApprovalBroker {
  request(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<'allow' | 'deny'>;
}

export type ApprovalOutcome = 'allow' | 'deny' | 'expired' | 'cancelled';

export interface ApprovalIdentity {
  readonly execution: ToolExecutionRequest;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resource: ExistingWorkspaceResource | NewWorkspaceFileTarget;
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;
}

export function createApprovalRequest(
  identity: ApprovalIdentity,
  timeoutMs: number,
): ApprovalRequest {
  const { arguments: args, execution, policy, resource, workspace } = identity;

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        runId: execution.runId,
        modelRequestId: execution.modelRequestId,
        toolExecutionId: execution.toolExecutionId,
        toolCallId: execution.toolCall.toolCallId,
        toolName: execution.toolCall.name,
        arguments: args,
        resource: {
          path: resource.relativePath,
          kind: resource.kind,
        },
        workspace: {
          rootPath: workspace.rootPath,
          identity: workspace.identity,
        },
        policy,
      }),
    )
    .digest('hex');

  return Object.freeze({
    id: randomUUID(),
    fingerprint: fingerprint,
    description:
      `Execute ${execution.toolCall.name} on ` +
      `${JSON.stringify(resource.relativePath)}?`,
    expiresAt: Date.now() + timeoutMs,
    operation: Object.freeze({
      toolName: execution.toolCall.name,
      target: resource.relativePath,
      arguments: structuredClone(args),
    }),
  });
}

export function awaitApproval(
  broker: ApprovalBroker,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: ApprovalOutcome): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      signal.removeEventListener('abort', onAbort);

      if (outcome === 'expired' || outcome === 'cancelled') {
        controller.abort(new Error(`Approval ${outcome}.`));
      }

      resolve(outcome);
    };

    const onAbort = (): void => {
      finish('cancelled');
    };

    signal.addEventListener('abort', onAbort, {
      once: true,
    });

    if (signal.aborted) {
      finish('cancelled');
      return;
    }

    if (Date.now() >= request.expiresAt) {
      finish('expired');
      return;
    }

    timer = setTimeout(
      () => {
        finish('expired');
      },
      Math.max(0, request.expiresAt - Date.now()),
    );

    void Promise.resolve()
      .then(() => {
        if (settled) {
          return undefined;
        }

        return broker.request(request, controller.signal);
      })
      .then((decision) => {
        if (settled) {
          return;
        }

        if (signal.aborted) {
          finish('cancelled');
        } else if (Date.now() >= request.expiresAt) {
          finish('expired');
        } else {
          finish(decision === 'allow' ? 'allow' : 'deny');
        }
      })
      .catch(() => {
        if (settled) {
          return;
        }

        if (signal.aborted) {
          finish('cancelled');
        } else if (Date.now() >= request.expiresAt) {
          finish('expired');
        } else {
          finish('deny');
        }
      });
  });
}
