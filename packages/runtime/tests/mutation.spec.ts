import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

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

interface ProposedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toolResponse(call: ProposedCall): FakeResponse {
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
          name: call.name,
          arguments: call.arguments,
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
        text: 'The tool outcome was acknowledged.',
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
        throw new Error('Unexpected additional inference request.');
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

describe('Agent–Runtime integration: managed mutations', () => {
  let sandbox: string;
  let root: string;

  const initial = 'export const value = 1;\n';

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-mutation-'));
    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), { recursive: true });

    await writeFile(
      join(root, 'AGENTS.md'),
      '# Workspace instructions\nUse authorized operations.\n',
    );

    await writeFile(join(root, 'src/main.ts'), initial);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function createHarness(call: ProposedCall) {
    const workspace = await createWorkspace(root);

    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const context = createWorkspaceContext({
      workspace,
      policy,
    });

    const onRelevantTarget: Parameters<
      typeof context.setRelevantTargets
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
      mutationContext,
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
          onRelevantTarget,
        }),
      ),
    });

    const scripted = scriptedInference([toolResponse(call), stopResponse()]);

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

  async function runMutation(call: ProposedCall) {
    const harness = await createHarness(call);

    try {
      const result = await harness.agent.start({
        model,
        message: `Execute ${call.name} using the provided arguments.`,
      }).result;

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      return {
        result,
        toolResult,
        requests: harness.requests,
      };
    } finally {
      await harness.agent.dispose();
    }
  }

  it('creates a new file with the exact requested content', async () => {
    const path = 'src/created.txt';
    const content = 'Created by Russet.\n';

    const outcome = await runMutation({
      name: 'fs_create',
      arguments: { path, content },
    });

    expect(outcome.result.status).toBe('completed');

    expect(await readFile(join(root, path), 'utf8')).toBe(content);

    expect(outcome.toolResult?.isError).toBe(false);

    expect(outcome.toolResult?.content[0]?.text).toContain(
      `SHA-256: ${sha256(content)}`,
    );

    expect(outcome.requests).toHaveLength(2);

    // Successful staging leaves no temporary artifacts.
    const entries = await readdir(join(root, 'src'));

    expect(
      entries.filter(
        (entry) => entry.startsWith('.russet-') && entry.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('never replaces an existing file through fs_create', async () => {
    const outcome = await runMutation({
      name: 'fs_create',
      arguments: {
        path: 'src/main.ts',
        content: 'Attempted overwrite.\n',
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(initial);
  });

  it('replaces a file when the expected SHA-256 matches', async () => {
    const replacement = 'export const value = 2;\n';

    const outcome = await runMutation({
      name: 'fs_write',
      arguments: {
        path: 'src/main.ts',
        content: replacement,
        expectedSha256: sha256(initial),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(false);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(replacement);

    expect(outcome.toolResult?.content[0]?.text).toContain(
      `SHA-256: ${sha256(replacement)}`,
    );
  });

  it('rejects stale replacement without changing the destination', async () => {
    const outcome = await runMutation({
      name: 'fs_write',
      arguments: {
        path: 'src/main.ts',
        content: 'Stale replacement.\n',
        expectedSha256: sha256('An older version.\n'),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(initial);
  });

  it('edits exactly one matching occurrence', async () => {
    const updated = 'export const value = 42;\n';

    const outcome = await runMutation({
      name: 'fs_edit',
      arguments: {
        path: 'src/main.ts',
        oldText: 'value = 1',
        newText: 'value = 42',
        expectedSha256: sha256(initial),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(false);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(updated);

    expect(outcome.toolResult?.content[0]?.text).toContain('Replacements: 1');
  });

  it('rejects an edit when its search text is absent', async () => {
    const outcome = await runMutation({
      name: 'fs_edit',
      arguments: {
        path: 'src/main.ts',
        oldText: 'does not exist',
        newText: 'replacement',
        expectedSha256: sha256(initial),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(initial);
  });

  it('rejects ambiguous edits without modifying the file', async () => {
    const repeated = 'item\nitem\n';

    await writeFile(join(root, 'src/main.ts'), repeated);

    const outcome = await runMutation({
      name: 'fs_edit',
      arguments: {
        path: 'src/main.ts',
        oldText: 'item',
        newText: 'other',
        expectedSha256: sha256(repeated),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(repeated);
  });

  it('rejects an edit whose expected SHA-256 is stale', async () => {
    const outcome = await runMutation({
      name: 'fs_edit',
      arguments: {
        path: 'src/main.ts',
        oldText: 'value = 1',
        newText: 'value = 99',
        expectedSha256: sha256('outdated contents'),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(initial);
  });

  it('rejects content larger than the managed write limit', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);

    const outcome = await runMutation({
      name: 'fs_write',
      arguments: {
        path: 'src/main.ts',
        content: oversized,
        expectedSha256: sha256(initial),
      },
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.toolResult?.isError).toBe(true);

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(initial);
  });
});
