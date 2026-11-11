import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentOptions, type AgentRun } from '@russet/agent';

import type { ApprovalBroker } from '../src/approvals/once.js';
import { createMutationContextGuard } from '../src/context/mutation.js';
import { createWorkspaceContext } from '../src/context/provider.js';
import {
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspacePolicy,
  defineRuntimeTool,
} from '../src/index.js';
import type {
  RegisteredRuntimeTool,
  Workspace,
  WorkspacePolicy,
} from '../src/index.js';
import { createManagedWriteTools } from '../src/tools/builtins/write.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

interface ProposedCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function toolResponse(calls: readonly ProposedCall[]): FakeResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: calls.map((call) => ({
      id: `block-${call.id}`,
      type: 'toolcall' as const,
      toolCall: {
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    })),
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
        text: 'The completed operations were acknowledged.',
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

interface HarnessOptions {
  readonly policy?: WorkspacePolicy;
  readonly broker?: ApprovalBroker;
  readonly tools?: readonly RegisteredRuntimeTool[];
}

describe('Agent–Runtime integration: cancellation', () => {
  let sandbox: string;
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-cancel-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), {
      recursive: true,
    });

    await writeFile(
      join(root, 'AGENTS.md'),
      [
        '# Workspace instructions',
        '',
        'Use only authorized workspace tools.',
      ].join('\n'),
    );

    workspace = await createWorkspace(root);
  });

  afterEach(async () => {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  function createHarness(
    responses: readonly FakeResponse[],
    options: HarnessOptions = {},
  ) {
    const policy =
      options.policy ??
      createWorkspacePolicy({
        mode: 'workspace_write',
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
      registry: createToolRegistry(
        options.tools ?? createManagedWriteTools({ workspace }),
      ),
      ...(options.broker === undefined
        ? {}
        : { approvalBroker: options.broker }),
    });

    const scripted = scriptedInference(responses);

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

  it('cancels pending approval without executing the mutation', async () => {
    const path = 'src/pending.txt';

    const brokerStarted = deferred<AbortSignal>();

    const broker: ApprovalBroker = {
      request(_request, signal) {
        brokerStarted.resolve(signal);

        return new Promise<'allow' | 'deny'>((resolve) => {
          if (signal.aborted) {
            resolve('deny');
            return;
          }

          signal.addEventListener('abort', () => resolve('deny'), {
            once: true,
          });
        });
      },
    };

    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.write': 'ask',
      },
    });

    const harness = createHarness(
      [
        toolResponse([
          {
            id: 'call-1',
            name: 'fs_create',
            arguments: {
              path,
              content: 'Never created.\n',
            },
          },
        ]),
      ],
      { policy, broker },
    );

    try {
      const run = harness.agent.start({
        model,
        message: `Create ${path}.`,
      });

      const brokerSignal = await brokerStarted.promise;

      expect(brokerSignal.aborted).toBe(false);

      run.cancel('Cancelled during approval.');

      const result = await run.result;

      expect(result.status).toBe('cancelled');
      expect(brokerSignal.aborted).toBe(true);

      // The cancelled run must not initiate another inference.
      expect(harness.requests).toHaveLength(1);

      await expect(readFile(join(root, path), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const results = harness.agent
        .getConversation()
        .filter((message) => message.role === 'tool_result');

      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('does not dispatch the next tool after cancellation', async () => {
    const firstPath = 'src/first.txt';
    const secondPath = 'src/second.txt';

    const harness = createHarness([
      toolResponse([
        {
          id: 'call-1',
          name: 'fs_create',
          arguments: {
            path: firstPath,
            content: 'First operation completed.\n',
          },
        },
        {
          id: 'call-2',
          name: 'fs_create',
          arguments: {
            path: secondPath,
            content: 'Must not be created.\n',
          },
        },
      ]),
    ]);

    const skipped: string[] = [];
    let run: AgentRun | undefined;

    try {
      run = harness.agent.start(
        {
          model,
          message: 'Create two files.',
        },
        (event) => {
          if (
            event.type === 'tool.dispatch.finished' &&
            event.toolCallId === 'call-1' &&
            event.status === 'success'
          ) {
            run?.cancel('Stop after the first tool.');
          }

          if (event.type === 'tool.skipped') {
            skipped.push(event.toolCallId);
          }
        },
      );

      const result = await run.result;

      expect(result.status).toBe('cancelled');

      expect(await readFile(join(root, firstPath), 'utf8')).toBe(
        'First operation completed.\n',
      );

      await expect(
        readFile(join(root, secondPath), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // No second model request after cancellation.
      expect(harness.requests).toHaveLength(1);

      expect(skipped).toEqual(['call-2']);

      const toolResults = harness.agent
        .getConversation()
        .filter((message) => message.role === 'tool_result');

      expect(toolResults.map((message) => message.toolCallId)).toEqual([
        'call-1',
        'call-2',
      ]);

      expect(toolResults.map((message) => message.isError)).toEqual([
        false,
        true,
      ]);

      expect(toolResults[1]?.content[0]?.text).toContain('Not executed');
    } finally {
      await harness.agent.dispose();
    }
  });

  it('interrupts after uncertain execution and skips later tools', async () => {
    let uncertainExecutions = 0;
    let subsequentExecutions = 0;

    const schema = Type.Object(
      {
        path: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    );

    const uncertainTool = defineRuntimeTool<{ path: string }>({
      name: 'uncertain_write',
      description: 'Simulate a write with an unconfirmed outcome.',
      action: 'fs.write',
      failureSideEffects: 'possible',
      parameters: schema,

      target(args) {
        return {
          path: args.path,
          expectation: 'new_file',
        };
      },

      execute() {
        uncertainExecutions++;

        // The gateway cannot independently prove whether
        // a side effect occurred before this exception.
        throw new Error('Execution outcome was not confirmed.');
      },
    });

    const subsequentTool = defineRuntimeTool<{ path: string }>({
      name: 'later_write',
      description: 'An operation that must never start.',
      action: 'fs.write',
      parameters: schema,

      target(args) {
        return {
          path: args.path,
          expectation: 'new_file',
        };
      },

      execute() {
        subsequentExecutions++;
        return 'Unexpected execution.';
      },
    });

    const harness = createHarness(
      [
        toolResponse([
          {
            id: 'call-1',
            name: 'uncertain_write',
            arguments: {
              path: 'src/uncertain.txt',
            },
          },
          {
            id: 'call-2',
            name: 'later_write',
            arguments: {
              path: 'src/later.txt',
            },
          },
        ]),
        stopResponse(),
      ],
      {
        tools: [uncertainTool, subsequentTool],
      },
    );

    const skipped: string[] = [];
    const outcomes: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Perform the requested operations.',
        },
        (event) => {
          if (event.type === 'tool.skipped') {
            skipped.push(event.toolCallId);
          }

          if (event.type === 'tool.dispatch.finished') {
            outcomes.push(event.status);
          }
        },
      ).result;

      expect(result.status).toBe('interrupted');

      expect(result.failure?.kind).toBe('tool_execution_uncertain');

      expect(uncertainExecutions).toBe(1);
      expect(subsequentExecutions).toBe(0);

      expect(skipped).toEqual(['call-2']);
      expect(outcomes).toEqual(['uncertain']);

      // The second scripted model response must not be used.
      expect(harness.requests).toHaveLength(1);

      const toolResults = harness.agent
        .getConversation()
        .filter((message) => message.role === 'tool_result');

      expect(toolResults.map((message) => message.toolCallId)).toEqual([
        'call-1',
        'call-2',
      ]);

      expect(toolResults.map((message) => message.isError)).toEqual([
        true,
        true,
      ]);

      // The same Agent instance cannot automatically retry
      // after an uncertain operation.
      expect(() =>
        harness.agent.start({
          model,
          message: 'Try again.',
        }),
      ).toThrow(/reconciliation/i);
    } finally {
      await harness.agent.dispose();
    }
  });
});
