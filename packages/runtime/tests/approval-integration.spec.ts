import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

import type { ApprovalBroker, ApprovalRequest } from '../src/approvals/once.js';
import { createMutationContextGuard } from '../src/context/mutation.js';
import { createWorkspaceContext } from '../src/context/provider.js';
import {
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspacePolicy,
} from '../src/index.js';
import { createManagedWriteTools } from '../src/tools/builtins/write.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

function toolResponse(path: string, content: string): FakeResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: 'block-1',
        type: 'toolcall',
        toolCall: {
          toolCallId: 'call-1',
          name: 'fs_create',
          arguments: { path, content },
        },
      },
    ],
  };
}

function stopResponse(): FakeResponse {
  return {
    requestId: 'request-2',
    messageId: 'message-2',
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: 'final-text',
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

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });

  return { promise, resolve };
}

describe('Agent–Runtime integration: approvals', () => {
  let sandbox: string;
  let root: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-approvals-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), {
      recursive: true,
    });

    await writeFile(
      join(root, 'AGENTS.md'),
      [
        '# Workspace instructions',
        '',
        'Use only authorized Runtime operations.',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();

    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  async function createHarness(
    broker: ApprovalBroker,
    path: string,
    content: string,
    approvalTimeoutMs = 5_000,
  ) {
    const workspace = await createWorkspace(root);

    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.write': 'ask',
      },
    });

    const context = createWorkspaceContext({
      workspace,
      policy,
    });

    const mutationContext = createMutationContextGuard({
      workspace,
      policy,
      context,
      onRelevantTarget(target) {
        context.setRelevantTargets([{ kind: 'directory', path: '.' }, target]);
      },
    });

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      mutationContext,
      approvalBroker: broker,
      approvalTimeoutMs,
      registry: createToolRegistry(createManagedWriteTools({ workspace })),
    });

    const scripted = scriptedInference([
      toolResponse(path, content),
      stopResponse(),
    ]);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
      contextProvider: context,
    });

    return {
      agent,
      requests: scripted.requests,
    };
  }

  it('executes an approved creation and continues inference', async () => {
    const path = 'src/approved.txt';
    const content = 'Approved by the test broker.\n';

    const approvals: ApprovalRequest[] = [];

    const broker: ApprovalBroker = {
      async request(request) {
        approvals.push(request);

        expect(request.operation.toolName).toBe('fs_create');
        expect(request.operation.target).toBe(path);
        expect(request.operation.arguments).toEqual({
          path,
          content,
        });

        expect(request.id).toBeTruthy();
        expect(request.fingerprint).toMatch(/^[a-f0-9]{64}$/);

        return 'allow';
      },
    };

    const harness = await createHarness(broker, path, content);

    const events: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: `Create ${path}.`,
        },
        (event) => {
          events.push(event.type);
        },
      ).result;

      expect(result.status).toBe('completed');

      expect(approvals).toHaveLength(1);

      expect(await readFile(join(root, path), 'utf8')).toBe(content);

      expect(harness.requests).toHaveLength(2);

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult).toMatchObject({
        role: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'fs_create',
        isError: false,
      });

      expect(toolResult?.content[0]?.text).toContain('Created:');

      expect(events).toContain('tool.approval.requested');
      expect(events).toContain('tool.approval.resolved');
      expect(events).toContain('tool.execution.started');
      expect(events.at(-1)).toBe('run.finished');
    } finally {
      await harness.agent.dispose();
    }
  });

  it('does not create a file when approval is denied', async () => {
    const path = 'src/denied.txt';
    const content = 'Must not be written.\n';

    let approvals = 0;

    const broker: ApprovalBroker = {
      async request() {
        approvals++;
        return 'deny';
      },
    };

    const harness = await createHarness(broker, path, content);

    const events: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: `Create ${path}.`,
        },
        (event) => {
          events.push(event.type);
        },
      ).result;

      // The model can finish normally after a denied operation.
      expect(result.status).toBe('completed');

      expect(approvals).toBe(1);

      await expect(readFile(join(root, path), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('permission_denied');

      expect(events).toContain('tool.approval.requested');
      expect(events).toContain('tool.approval.resolved');
      expect(events).not.toContain('tool.execution.started');
    } finally {
      await harness.agent.dispose();
    }
  });

  it('does not let a broker modify the executed arguments', async () => {
    const path = 'src/unchanged.txt';
    const content = 'Original validated content.\n';

    const broker: ApprovalBroker = {
      async request(request) {
        // Deliberately mutate the broker-visible preview.
        // This must not modify Runtime's validated handler args.
        Object.assign(request.operation.arguments, {
          content: 'TAMPERED CONTENT\n',
        });

        return 'allow';
      },
    };

    const harness = await createHarness(broker, path, content);

    try {
      const result = await harness.agent.start({
        model,
        message: `Create ${path}.`,
      }).result;

      expect(result.status).toBe('completed');

      expect(await readFile(join(root, path), 'utf8')).toBe(content);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('expires pending approval and aborts the broker signal', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });

    const path = 'src/expired.txt';
    const content = 'Must not be written.\n';

    const brokerStarted = deferred<AbortSignal>();

    const broker: ApprovalBroker = {
      request(_request, signal) {
        brokerStarted.resolve(signal);

        // Deliberately unresponsive broker.
        return new Promise<'allow' | 'deny'>(() => {});
      },
    };

    const harness = await createHarness(broker, path, content, 250);

    try {
      const run = harness.agent.start({
        model,
        message: `Create ${path}.`,
      });

      // Wait until the actual Runtime approval broker starts.
      const brokerSignal = await brokerStarted.promise;

      expect(brokerSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(250);

      const result = await run.result;

      // Approval expiry rejects the tool, not the Agent turn.
      expect(result.status).toBe('completed');
      expect(brokerSignal.aborted).toBe(true);

      expect(harness.requests).toHaveLength(2);

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('approval_expired');

      await expect(readFile(join(root, path), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await harness.agent.dispose();
    }
  });
});
