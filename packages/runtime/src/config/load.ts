import { open } from 'node:fs/promises';

import { resolveExistingWorkspacePath } from '../workspace/paths.js';
import { WorkspaceError } from '../workspace/types.js';
import type { Workspace } from '../workspace/types.js';
import { assertWorkspaceIdentity } from '../workspace/workspace.js';
import {
  composeRuntimeConfiguration,
  parseRuntimeConfiguration,
  RuntimeConfigurationError,
} from './configuration.js';
import type { RuntimeConfiguration } from './configuration.js';

const PROJECT_CONFIG = '.russet/project.yaml';
const MAX_CONFIG_BYTES = 32 * 1024;

export interface RuntimeConfigurationLoadOptions {
  readonly workspace: Workspace;
  readonly userConfigPath?: string;
  readonly workspaceTrusted?: boolean;
  readonly signal?: AbortSignal;
}

export interface ConfigurationSourceStatus {
  readonly path: string;
  readonly status: 'applied' | 'ignored_untrusted';
}

export interface LoadedRuntimeConfiguration {
  readonly policy: ReturnType<typeof composeRuntimeConfiguration>;
  readonly sources: readonly ConfigurationSourceStatus[];
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Read at most 32 KiB + 1 from a configuration file.
 * Does not follow arbitrary workspace paths; that check is
 * performed separately for workspace configuration.
 */
async function readOptionalConfig(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();

  let handle;

  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const info = await handle.stat();

    if (!info.isFile()) {
      throw new Error('Configuration source is not a regular file.');
    }

    if (info.size > MAX_CONFIG_BYTES) {
      throw new Error('Configuration exceeds 32 KiB.');
    }

    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let read = 0;

    while (read < bytes.length) {
      signal?.throwIfAborted();

      const { bytesRead } = await handle.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );

      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
    }

    if (read > MAX_CONFIG_BYTES) {
      throw new Error('Configuration exceeds 32 KiB.');
    }

    return new TextDecoder('utf-8', {
      fatal: true,
    }).decode(bytes.subarray(0, read));
  } finally {
    await handle.close();
  }
}

export async function loadRuntimeConfiguration(
  options: RuntimeConfigurationLoadOptions,
): Promise<LoadedRuntimeConfiguration> {
  const {
    workspace,
    userConfigPath,
    workspaceTrusted = false,
    signal,
  } = options;

  const sources: ConfigurationSourceStatus[] = [];

  let user: RuntimeConfiguration | undefined;
  let project: RuntimeConfiguration | undefined;

  if (userConfigPath !== undefined) {
    let text: string | undefined;

    try {
      text = await readOptionalConfig(userConfigPath, signal);
    } catch (error) {
      throw new RuntimeConfigurationError(
        userConfigPath,
        '$',
        error instanceof Error ? error.message : 'Read failed.',
      );
    }

    if (text !== undefined) {
      user = parseRuntimeConfiguration(userConfigPath, text);

      sources.push({
        path: userConfigPath,
        status: 'applied',
      });
    }
  }

  let projectPath: string | undefined;

  try {
    const resource = await resolveExistingWorkspacePath(
      workspace,
      PROJECT_CONFIG,
    );

    if (resource.kind !== 'file') {
      throw new RuntimeConfigurationError(
        PROJECT_CONFIG,
        '$',
        'Expected a regular file.',
      );
    }

    projectPath = resource.absolutePath;
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') {
      throw error;
    }
  }

  if (projectPath !== undefined) {
    if (!workspaceTrusted) {
      sources.push({
        path: PROJECT_CONFIG,
        status: 'ignored_untrusted',
      });
    } else {
      let text: string | undefined;

      try {
        text = await readOptionalConfig(projectPath, signal);
        await assertWorkspaceIdentity(workspace);
      } catch (error) {
        throw new RuntimeConfigurationError(
          PROJECT_CONFIG,
          '$',
          error instanceof Error ? error.message : 'Read failed.',
        );
      }

      if (text === undefined) {
        throw new RuntimeConfigurationError(
          PROJECT_CONFIG,
          '$',
          'Configuration disappeared during loading.',
        );
      }

      project = parseRuntimeConfiguration(PROJECT_CONFIG, text);

      sources.push({
        path: PROJECT_CONFIG,
        status: 'applied',
      });
    }
  }

  signal?.throwIfAborted();

  return Object.freeze({
    policy: composeRuntimeConfiguration(user, project),
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
  });
}
