import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

import type { ApprovalBroker } from '../src/approvals/once.js';
import { createMutationContextGuard } from '../src/context/mutation.js';
import { createWorkspaceContext } from '../src/context/provider.js';
import {
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspacePolicy,
} from '../src/index.js';
import type { WorkspacePolicy } from '../src/index.js';
import { createManagedWriteTools } from '../src/tools/builtins/write.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

const rootInstructions = [
  '# Root instructions',
  '',
  'Use only authorized workspace operations.',
].join('\n');

const nestedInstructions = [
  '# Nested instructions',
  '',
  'Apply the nested workspace conventions.',
].join('\n');

const updatedNestedInstructions = [
  '# Updated nested instructions',
  '',
  'These instructions supersede the previous nested guidance.',
].join('\n');

function createResponse(
  ordinal: number,
  callId: string,
  path: string,
  content: string,
): FakeResponse {
  return {
    requestId: `request-${ordinal}`,
    messageId: `message-${ordinal}`,
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: `block-${callId}`,
        type: 'toolcall',
        toolCall: {
          toolCallId: callId,
          name: 'fs_create',
          arguments: {
            path,
            content,
          },
        },
      },
    ],
  };
}

function stopResponse(ordinal: number): FakeResponse {
  return {
    requestId: `request-${ordinal}`,
    messageId: `message-${ordinal}`,
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: `final-${ordinal}`,
        type: 'text',
        text: 'The operation outcome has been acknowledged.',
      },
    ],
  };
}

function scriptedInference(responses: readonly FakeResponse[]) {
  const requests: ModelRequest[] = [];
  let index = 0;

  const inference: AgentOptions['inference'] = {
    stream(request) {
      requests.push(request);

      const response = responses[index++];

      if (!response) {
        throw new Error('Unexpected inference request.');
      }

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'response.started' as const,
            requestId: response.requestId,
            messageId: response.messageId,
          };

          yield {
            type: 'response.completed' as const,
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        async result() {
          return response;
        },
      };
    },
  };

  return { inference, requests };
}

describe('Agent–Runtime integration: workspace context', () => {
  let sandbox: string;
  let root: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-context-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src/nested'), {
      recursive: true,
    });

    await writeFile(join(root, 'AGENTS.md'), rootInstructions);

    await writeFile(join(root, 'src/nested/AGENTS.md'), nestedInstructions);
  });

  afterEach(async () => {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  async function createHarness(
    responses: readonly FakeResponse[],
    approvalBroker?: ApprovalBroker,
    selectedPolicy?: WorkspacePolicy,
  ) {
    const workspace = await createWorkspace(root);

    const policy =
      selectedPolicy ??
      createWorkspacePolicy({
        mode: 'workspace_write',
        workspaceRestrictions: {
          'fs.write': 'ask',
        },
      });

    const context = createWorkspaceContext({
      workspace,
      policy,
    });

    const onRelevantTarget: Parameters<
      ReturnType<typeof createWorkspaceContext>['setRelevantTargets']
    >[0][number] extends infer T
      ? (target: T) => void
      : never = (target) => {
      context.setRelevantTargets([{ kind: 'directory', path: '.' }, target]);
    };

    const mutationContext = createMutationContextGuard({
      workspace,
      policy,
      context,
      onRelevantTarget,
    });

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
          onRelevantTarget,
        }),
      ),
      mutationContext,
      ...(approvalBroker === undefined ? {} : { approvalBroker }),
    });

    const scripted = scriptedInference(responses);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
      contextProvider: context,
    });

    return {
      agent,
      context,
      requests: scripted.requests,
    };
  }

  it('refreshes nested instructions before approving a new proposal', async () => {
    const content = 'Created after context refresh.\n';
    const approvals: string[] = [];

    const broker: ApprovalBroker = {
      async request(request) {
        approvals.push(request.operation.target);

        expect(request.operation.toolName).toBe('fs_create');
        expect(request.operation.arguments).toEqual({
          path: 'src/nested/new.ts',
          content,
        });

        return 'allow';
      },
    };

    const harness = await createHarness(
      [
        createResponse(1, 'call-before-refresh', 'src/nested/new.ts', content),
        createResponse(2, 'call-after-refresh', 'src/nested/new.ts', content),
        stopResponse(3),
      ],
      broker,
    );

    const preparedRevisions: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Create src/nested/new.ts.',
        },
        (event) => {
          if (event.type === 'model.context.prepared') {
            preparedRevisions.push(event.revision);
          }
        },
      ).result;

      expect(result.status).toBe('completed');
      expect(harness.requests).toHaveLength(3);

      // Initial context contains only root instructions.
      expect(harness.requests[0]?.systemPrompt).toContain('Root instructions');

      expect(harness.requests[0]?.systemPrompt).not.toContain(
        'Apply the nested workspace conventions.',
      );

      // The second inference sees the newly discovered scope.
      expect(harness.requests[1]?.systemPrompt).toContain('Root instructions');

      expect(harness.requests[1]?.systemPrompt).toContain(
        'Apply the nested workspace conventions.',
      );

      expect(preparedRevisions).toHaveLength(3);
      expect(preparedRevisions[0]).not.toBe(preparedRevisions[1]);

      const firstResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(firstResult?.toolCallId).toBe('call-before-refresh');

      expect(firstResult?.isError).toBe(true);

      expect(firstResult?.content[0]?.text).toContain(
        'context_refresh_required',
      );

      // No approval was requested for the stale first proposal.
      // Only the second proposal is eligible for execution.
      expect(approvals).toEqual(['src/nested/new.ts']);

      expect(await readFile(join(root, 'src/nested/new.ts'), 'utf8')).toBe(
        content,
      );

      const secondResults = harness.requests[2]?.messages.filter(
        (message) => message.role === 'tool_result',
      );

      expect(secondResults?.map((message) => message.toolCallId)).toEqual([
        'call-before-refresh',
        'call-after-refresh',
      ]);

      expect(secondResults?.map((message) => message.isError)).toEqual([
        true,
        false,
      ]);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('rejects execution when instructions change during approval', async () => {
    const path = 'src/nested/changed.ts';
    const content = 'Must not be created from stale instructions.\n';

    let approvals = 0;

    const broker: ApprovalBroker = {
      async request() {
        approvals++;

        // Deterministically change the applicable instructions
        // while the operation is awaiting approval.
        await writeFile(
          join(root, 'src/nested/AGENTS.md'),
          updatedNestedInstructions,
        );

        return 'allow';
      },
    };

    const harness = await createHarness(
      [createResponse(1, 'call-1', path, content), stopResponse(2)],
      broker,
    );

    // Unlike the previous test, nested context is prepared
    // before the model's first inference request.
    harness.context.setRelevantTargets([
      { kind: 'directory', path: '.' },
      { kind: 'directory', path: 'src/nested' },
    ]);

    try {
      const result = await harness.agent.start({
        model,
        message: `Create ${path}.`,
      }).result;

      expect(result.status).toBe('completed');
      expect(approvals).toBe(1);
      expect(harness.requests).toHaveLength(2);

      expect(harness.requests[0]?.systemPrompt).toContain(
        'Apply the nested workspace conventions.',
      );

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain(
        'context_refresh_required',
      );

      // The next inference receives the changed instructions.
      expect(harness.requests[1]?.systemPrompt).toContain(
        'These instructions supersede the previous nested guidance.',
      );

      await expect(readFile(join(root, path), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // A successful approval of a stale proposal must not
      // turn that stale proposal into a successful mutation.
    } finally {
      await harness.agent.dispose();
    }
  });

  it('fails context preparation when instruction reading is denied', async () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.read': 'deny',
        'fs.write': 'ask',
      },
    });

    let approvals = 0;

    const broker: ApprovalBroker = {
      async request() {
        approvals++;
        return 'allow';
      },
    };

    const harness = await createHarness(
      [createResponse(1, 'call-1', 'src/nested/denied.ts', 'Never created.\n')],
      broker,
      policy,
    );

    try {
      const result = await harness.agent.start({
        model,
        message: 'Create src/nested/denied.ts.',
      }).result;

      expect(result.status).toBe('failed');

      expect(result.failure?.kind).toBe('context_preparation_error');

      expect(harness.requests).toHaveLength(0);
      expect(approvals).toBe(0);

      await expect(
        readFile(join(root, 'src/nested/denied.ts'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await harness.agent.dispose();
    }
  });
});
