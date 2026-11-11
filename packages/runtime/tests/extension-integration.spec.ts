import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

import { activateTrustedExtensions } from '../src/extensions/host.js';
import {
  RUSSET_EXTENSION_API_VERSION,
  type RussetExtension,
} from '../src/extensions/types.js';
import {
  createRuntimeGateway,
  createWorkspace,
  createWorkspacePolicy,
  defineRuntimeTool,
} from '../src/index.js';
import type { RegisteredRuntimeTool, Workspace } from '../src/index.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

const readSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

function registeredRead(
  name: string,
  onExecute: () => void = () => {},
): RegisteredRuntimeTool {
  return defineRuntimeTool<{ path: string }>({
    name,
    description: 'Read a workspace file through an extension.',
    action: 'fs.read',
    parameters: readSchema,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    execute() {
      onExecute();
      return 'Extension read completed.';
    },
  });
}

function registeredWrite(onExecute: () => void): RegisteredRuntimeTool {
  return defineRuntimeTool<{ path: string }>({
    name: 'extension_write',
    description: 'Simulate workspace file creation.',
    action: 'fs.write',
    requiresPreparedContext: false,
    parameters: readSchema,

    target(args) {
      return {
        path: args.path,
        expectation: 'new_file',
      };
    },

    execute() {
      onExecute();
      return 'Extension write completed.';
    },
  });
}

function scriptedInference(toolName: string, path: string) {
  const requests: ModelRequest[] = [];

  const responses: FakeResponse[] = [
    {
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
            name: toolName,
            arguments: { path },
          },
        },
      ],
    },
    {
      requestId: 'request-2',
      messageId: 'message-2',
      model,
      finishReason: 'stop',
      thinkingAvailability: 'unavailable',
      blocks: [
        {
          id: 'final-text',
          type: 'text',
          text: 'The extension operation was acknowledged.',
        },
      ],
    },
  ];

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

describe('Agent–Runtime integration: trusted extensions', () => {
  let sandbox: string;
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-extensions-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), { recursive: true });

    await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');

    workspace = await createWorkspace(root);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('executes a registered extension tool through Runtime', async () => {
    const executed = vi.fn();
    const lifecycle: string[] = [];

    const extension: RussetExtension = {
      id: 'example.read',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate');

        context.registerTool(registeredRead('extension_read', executed));
      },

      deactivate() {
        lifecycle.push('deactivate');
      },
    };

    const host = await activateTrustedExtensions([], [extension]);

    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      registry: host.registry,
    });

    const scripted = scriptedInference('extension_read', 'src/main.ts');

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
    });

    try {
      const result = await agent.start({
        model,
        message: 'Inspect src/main.ts through the extension.',
      }).result;

      expect(result.status).toBe('completed');
      expect(executed).toHaveBeenCalledOnce();

      expect(scripted.requests).toHaveLength(2);

      expect(scripted.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
        'extension_read',
      ]);

      const toolResult = scripted.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult).toMatchObject({
        role: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'extension_read',
        isError: false,
      });

      expect(toolResult?.content[0]?.text).toContain(
        'Extension read completed',
      );

      expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
        'export const value = 1;\n',
      );
    } finally {
      await agent.dispose();
      await host.dispose();
    }

    expect(lifecycle).toEqual(['activate', 'deactivate']);
  });

  it('does not authorize an extension write in read-only mode', async () => {
    const executed = vi.fn();

    const extension: RussetExtension = {
      id: 'example.write',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        context.registerTool(registeredWrite(executed));
      },
    };

    const host = await activateTrustedExtensions([], [extension]);

    const gateway = createRuntimeGateway({
      workspace,
      policy: createWorkspacePolicy({
        mode: 'read_only',
      }),
      registry: host.registry,
    });

    const scripted = scriptedInference('extension_write', 'src/forbidden.txt');

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
    });

    try {
      const result = await agent.start({
        model,
        message: 'Attempt an extension write.',
      }).result;

      expect(result.status).toBe('completed');
      expect(executed).not.toHaveBeenCalled();

      expect(scripted.requests[0]?.tools ?? []).toHaveLength(0);

      const toolResult = scripted.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('permission_denied');

      await expect(
        readFile(join(root, 'src/forbidden.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it('enforces prepared context for an extension write', async () => {
    const executed = vi.fn();

    const write = registeredWrite(executed);

    // H1 ensures that fs.write cannot opt out.
    expect(write.requiresPreparedContext).toBe(true);

    const extension: RussetExtension = {
      id: 'example.context',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        context.registerTool(write);
      },
    };

    const host = await activateTrustedExtensions([], [extension]);

    const gateway = createRuntimeGateway({
      workspace,
      policy: createWorkspacePolicy({
        mode: 'workspace_write',
      }),
      registry: host.registry,

      // Deliberately no mutationContext.
    });

    const scripted = scriptedInference('extension_write', 'src/unprepared.txt');

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
    });

    try {
      const result = await agent.start({
        model,
        message: 'Attempt an unprepared extension mutation.',
      }).result;

      expect(result.status).toBe('completed');
      expect(executed).not.toHaveBeenCalled();

      expect(scripted.requests[0]?.tools ?? []).toHaveLength(0);

      const toolResult = scripted.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('permission_denied');

      await expect(
        readFile(join(root, 'src/unprepared.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it('deactivates successful extensions in reverse order', async () => {
    const lifecycle: string[] = [];

    const first: RussetExtension = {
      id: 'example.first',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate:first');

        context.registerTool(registeredRead('first_read'));
      },

      deactivate() {
        lifecycle.push('deactivate:first');
      },
    };

    const second: RussetExtension = {
      id: 'example.second',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate:second');

        context.registerTool(registeredRead('second_read'));
      },

      deactivate() {
        lifecycle.push('deactivate:second');
      },
    };

    const host = await activateTrustedExtensions([], [first, second]);

    expect(host.registry.get('first_read')).toBeDefined();
    expect(host.registry.get('second_read')).toBeDefined();

    await host.dispose();
    await host.dispose();

    expect(lifecycle).toEqual([
      'activate:first',
      'activate:second',
      'deactivate:second',
      'deactivate:first',
    ]);
  });

  it('rejects late tool registration after activation', async () => {
    let registerLater: ((tool: RegisteredRuntimeTool) => void) | undefined;

    const extension: RussetExtension = {
      id: 'example.late',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        registerLater = (tool) => {
          context.registerTool(tool);
        };
      },
    };

    const host = await activateTrustedExtensions([], [extension]);

    try {
      expect(registerLater).toBeDefined();

      expect(() => registerLater?.(registeredRead('late_read'))).toThrow(
        /registration is no longer active/i,
      );

      expect(host.registry.get('late_read')).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it('deactivates activated extensions when registration fails', async () => {
    const lifecycle: string[] = [];

    const first: RussetExtension = {
      id: 'example.first',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate:first');

        context.registerTool(registeredRead('shared_read'));
      },

      deactivate() {
        lifecycle.push('deactivate:first');
      },
    };

    const second: RussetExtension = {
      id: 'example.second',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate:second');

        // Conflicts with the previously activated extension.
        context.registerTool(registeredRead('shared_read'));
      },

      deactivate() {
        lifecycle.push('deactivate:second');
      },
    };

    await expect(
      activateTrustedExtensions([], [first, second]),
    ).rejects.toThrow(/extension activation failed/i);

    expect(lifecycle).toEqual([
      'activate:first',
      'activate:second',
      'deactivate:second',
      'deactivate:first',
    ]);
  });

  it('cleans up extensions when final registry construction fails', async () => {
    const lifecycle: string[] = [];

    const builtin = registeredRead('builtin_read');

    const extension: RussetExtension = {
      id: 'example.registry',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        lifecycle.push('activate');

        // A deliberately mutable registered tool simulates
        // a broken trusted extension changing its metadata.
        const registered = {
          ...registeredRead('initial_read'),
        };

        context.registerTool(registered);

        // The host's registration check has already passed.
        // The final registry must detect this name collision.
        Object.defineProperty(registered, 'name', {
          value: 'builtin_read',
        });
      },

      deactivate() {
        lifecycle.push('deactivate');
      },
    };

    await expect(
      activateTrustedExtensions([builtin], [extension]),
    ).rejects.toThrow(/registry construction failed/i);

    expect(lifecycle).toEqual(['activate', 'deactivate']);
  });
});
