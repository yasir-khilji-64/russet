import { opendir } from 'node:fs/promises';

import { evaluateWorkspacePolicy } from '../../policy/evaluate.js';
import type { WorkspacePolicy } from '../../policy/types.js';
import { resolveExistingWorkspacePath } from '../../workspace/paths.js';
import type { Workspace } from '../../workspace/types.js';
import { ManagedToolError } from '../errors.js';

export interface DiscoveredEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export interface DiscoveryResult {
  readonly entries: readonly DiscoveredEntry[];
  readonly visited: number;
  readonly incomplete: boolean;
}

export const MAX_VISITED_ENTRIES = 2_048;
export const MAX_DISCOVERY_DEPTH = 6;

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
]);

interface PendingDirectory {
  readonly path: string;
  readonly depth: number;
}

export async function discoverWorkspaceEntries(
  workspace: Workspace,
  policy: WorkspacePolicy,
  root: string,
  recursive: boolean,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const queue: PendingDirectory[] = [{ path: root, depth: 0 }];

  const entries: DiscoveredEntry[] = [];

  let visited = 0;
  let incomplete = false;

  while (queue.length > 0) {
    signal.throwIfAborted();

    const next = queue.shift();

    if (next === undefined) {
      break;
    }

    const directory = await resolveExistingWorkspacePath(workspace, next.path);

    if (directory.kind !== 'directory') {
      throw new ManagedToolError('Directory changed during discovery.');
    }

    const handle = await opendir(directory.absolutePath);

    for await (const entry of handle) {
      signal.throwIfAborted();

      if (visited >= MAX_VISITED_ENTRIES) {
        incomplete = true;
        break;
      }

      visited++;

      if (!entry.isFile() && !entry.isDirectory()) {
        continue;
      }

      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const path =
        next.path === '.' ? entry.name : `${next.path}/${entry.name}`;

      const kind = entry.isDirectory()
        ? ('directory' as const)
        : ('file' as const);

      const decision = evaluateWorkspacePolicy(policy, {
        action: 'fs.search',
        relativePath: path,
        kind,
      });

      if (decision.decision !== 'allow') {
        continue;
      }

      const resolved = await resolveExistingWorkspacePath(workspace, path);

      if (resolved.kind !== kind) {
        throw new ManagedToolError(
          'Resource changed during directory discovery.',
        );
      }

      entries.push({ path, kind });

      if (recursive && kind === 'directory') {
        if (next.depth < MAX_DISCOVERY_DEPTH) {
          queue.push({
            path,
            depth: next.depth + 1,
          });
        } else {
          incomplete = true;
        }
      }
    }

    if (visited >= MAX_VISITED_ENTRIES) {
      incomplete = true;
      break;
    }
  }

  return {
    entries: entries.toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    visited,
    incomplete,
  };
}
