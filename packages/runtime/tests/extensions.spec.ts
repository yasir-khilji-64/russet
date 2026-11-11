import Type from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { activateTrustedExtensions, defineRuntimeTool } from '../src/index.js';
import type { RussetExtension } from '../src/index.js';

function mockTool(name: string) {
  return defineRuntimeTool<{ path: string }>({
    name,
    description: 'Inspect a workspace resource.',
    action: 'fs.read',

    parameters: Type.Object(
      { path: Type.String() },
      { additionalProperties: false },
    ),

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    execute() {
      return 'Inspected.';
    },
  });
}

describe('trusted extension lifecycle', () => {
  it('registers tools without modifying Agent', async () => {
    const extension: RussetExtension = {
      id: 'example.inspector',
      apiVersion: 1,

      activate(context) {
        context.registerTool(mockTool('custom_inspect'));
      },
    };

    const host = await activateTrustedExtensions(
      [mockTool('builtin_read')],
      [extension],
    );

    expect(host.registry.list().map((tool) => tool.name)).toEqual([
      'builtin_read',
      'custom_inspect',
    ]);

    expect(host.extensionIds).toEqual(['example.inspector']);

    await host.dispose();
  });

  it('rejects duplicate registrations', async () => {
    const extension: RussetExtension = {
      id: 'example.duplicate',
      apiVersion: 1,

      activate(context) {
        context.registerTool(mockTool('builtin_read'));
      },
    };

    await expect(
      activateTrustedExtensions([mockTool('builtin_read')], [extension]),
    ).rejects.toThrow(/activation failed/i);
  });

  it('rejects unsupported extension versions', async () => {
    const extension: RussetExtension = {
      id: 'example.future',
      apiVersion: 999,
      activate() {},
    };

    await expect(activateTrustedExtensions([], [extension])).rejects.toThrow(
      /Unsupported extension API version/,
    );
  });

  it('deactivates extensions in reverse order', async () => {
    const events: string[] = [];

    function extension(id: string): RussetExtension {
      return {
        id,
        apiVersion: 1,
        activate() {
          events.push(`activate:${id}`);
        },
        deactivate() {
          events.push(`deactivate:${id}`);
        },
      };
    }

    const host = await activateTrustedExtensions(
      [],
      [extension('first'), extension('second')],
    );

    await host.dispose();
    await host.dispose();

    expect(events).toEqual([
      'activate:first',
      'activate:second',
      'deactivate:second',
      'deactivate:first',
    ]);
  });

  it('attempts cleanup when activation fails', async () => {
    const cleanup = vi.fn();

    const extension: RussetExtension = {
      id: 'example.failing',
      apiVersion: 1,

      activate() {
        throw new Error('Activation failure');
      },

      deactivate: cleanup,
    };

    await expect(activateTrustedExtensions([], [extension])).rejects.toThrow(
      /activation failed/i,
    );

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
