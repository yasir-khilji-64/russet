import { createToolRegistry } from '../tools/registry.js';
import type { RegisteredRuntimeTool } from '../tools/types.js';
import { RUSSET_EXTENSION_API_VERSION } from './types.js';
import type { ExtensionHost, RussetExtension } from './types.js';

const VALID_EXTENSION_ID = /^[a-z][a-z0-9._-]{0,127}$/;

async function deactivateAll(
  items: readonly RussetExtension[],
): Promise<unknown[]> {
  const errors: unknown[] = [];

  for (const extension of items.toReversed()) {
    try {
      await extension.deactivate?.();
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}

export async function activateTrustedExtensions(
  builtins: readonly RegisteredRuntimeTool[],
  extensions: readonly RussetExtension[],
): Promise<ExtensionHost> {
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const tool of builtins) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate built-in tool: ${tool.name}`);
    }

    names.add(tool.name);
  }

  for (const extension of extensions) {
    if (!VALID_EXTENSION_ID.test(extension.id)) {
      throw new TypeError('Invalid extension ID.');
    }

    if (extension.apiVersion !== RUSSET_EXTENSION_API_VERSION) {
      throw new Error(`Unsupported extension API version: ${extension.id}`);
    }

    if (
      typeof extension.activate !== 'function' ||
      (extension.deactivate !== undefined &&
        typeof extension.deactivate !== 'function')
    ) {
      throw new TypeError(`Invalid extension lifecycle: ${extension.id}`);
    }

    if (ids.has(extension.id)) {
      throw new Error(`Duplicate extension ID: ${extension.id}`);
    }

    ids.add(extension.id);
  }

  const tools = [...builtins];
  const activated: RussetExtension[] = [];

  for (const extension of extensions) {
    let accepting = true;
    const staged: RegisteredRuntimeTool[] = [];
    const stagedNames = new Set<string>();

    try {
      await extension.activate(
        Object.freeze({
          registerTool(tool: RegisteredRuntimeTool) {
            if (!accepting) {
              throw new Error('Extension registration is no longer active.');
            }

            if (
              !tool ||
              typeof tool.name !== 'string' ||
              names.has(tool.name) ||
              stagedNames.has(tool.name)
            ) {
              throw new Error(
                `Invalid or conflicting tool registration: ${tool?.name}`,
              );
            }

            stagedNames.add(tool.name);
            staged.push(tool);
          },
        }),
      );

      // Commit registrations only after successful activation.
      tools.push(...staged);

      for (const name of stagedNames) {
        names.add(name);
      }

      activated.push(extension);
    } catch (error) {
      const cleanupErrors = await deactivateAll([...activated, extension]);

      throw new AggregateError(
        [error, ...cleanupErrors],
        `Extension activation failed: ${extension.id}`,
        { cause: error },
      );
    } finally {
      accepting = false;
    }
  }

  const registry = createToolRegistry(tools);
  let disposed = false;

  return Object.freeze({
    registry,
    extensionIds: Object.freeze([...ids]),

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;

      const errors = await deactivateAll(activated);

      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'One or more extensions failed to deactivate.',
        );
      }
    },
  });
}
