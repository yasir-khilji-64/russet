import Type from 'typebox';

import type { InstructionTarget } from '../../context/types.js';
import type { Workspace } from '../../workspace/types.js';
import { defineRuntimeTool } from '../registry.js';
import type { RegisteredRuntimeTool } from '../types.js';
import {
  createWorkspaceFile,
  editWorkspaceFile,
  replaceWorkspaceFile,
} from './mutate.js';

interface CreateArguments {
  path: string;
  content: string;
}

interface WriteArguments extends CreateArguments {
  expectedSha256: string;
}

interface EditArguments {
  path: string;
  expectedSha256: string;
  oldText: string;
  newText: string;
}

export interface ManagedWriteToolsOptions {
  readonly workspace: Workspace;
  readonly onRelevantTarget?: (target: InstructionTarget) => void;
}

const existingFilePath = Type.String({
  minLength: 1,
  description:
    'Path to an existing file, relative to the workspace root. ' +
    'Absolute paths are not supported.',
});

const newFilePath = Type.String({
  minLength: 1,
  description:
    'Path for a new file, relative to the workspace root. ' +
    'The parent directory must already exist. ' +
    'The destination must not exist.',
});

const expectedSha256 = Type.String({
  pattern: '^[0-9a-f]{64}$',
  description:
    'Lowercase SHA-256 digest of the complete current file content, ' +
    'as returned by fs_read. Must contain exactly 64 hexadecimal characters.',
});

const CreateParameters = Type.Object(
  {
    path: newFilePath,

    content: Type.String({
      description:
        'Complete UTF-8 content to write into the new file. ' +
        'An empty string creates an empty file.',
    }),
  },
  { additionalProperties: false },
);

const WriteParameters = Type.Object(
  {
    path: existingFilePath,

    content: Type.String({
      description:
        'Complete replacement content for the existing file. ' +
        'This operation replaces the entire file, not just selected lines. ' +
        'An empty string produces an empty file.',
    }),

    expectedSha256,
  },
  { additionalProperties: false },
);

const EditParameters = Type.Object(
  {
    path: existingFilePath,

    expectedSha256,

    oldText: Type.String({
      minLength: 1,
      description:
        'Exact, case-sensitive text to replace. ' +
        'Must occur exactly once in the current file. ' +
        'Regular expressions are not supported.',
    }),

    newText: Type.String({
      description:
        'Replacement text for the matched occurrence. ' +
        'May be empty to remove the matched text.',
    }),
  },
  { additionalProperties: false },
);

export function createManagedWriteTools(
  options: ManagedWriteToolsOptions,
): readonly RegisteredRuntimeTool[] {
  const { workspace, onRelevantTarget } = options;

  const create = defineRuntimeTool<CreateArguments>({
    name: 'fs_create',
    description:
      'Create a new UTF-8 workspace file. Fails if it already exists.',
    action: 'fs.write',
    parameters: CreateParameters,
    requiresPreparedContext: true,
    failureSideEffects: 'possible',

    target(args) {
      return {
        path: args.path,
        expectation: 'new_file',
      };
    },

    async execute(args, context) {
      const sha = await createWorkspaceFile(
        workspace,
        context.resource.relativePath,
        args.content,
        context.signal,
      );

      onRelevantTarget?.({
        kind: 'file',
        path: context.resource.relativePath,
      });

      return [
        `Created: ${JSON.stringify(context.resource.relativePath)}`,
        `SHA-256: ${sha}`,
      ].join('\n');
    },
  });

  const write = defineRuntimeTool<WriteArguments>({
    name: 'fs_write',
    description:
      'Replace an existing UTF-8 workspace file. ' +
      'Requires the SHA-256 of its complete current content.',
    action: 'fs.write',
    parameters: WriteParameters,
    requiresRead: true,
    requiresPreparedContext: true,
    failureSideEffects: 'possible',

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    async execute(args, context) {
      const sha = await replaceWorkspaceFile(
        workspace,
        context.resource.relativePath,
        args.content,
        args.expectedSha256,
        context.signal,
      );

      onRelevantTarget?.({
        kind: 'file',
        path: context.resource.relativePath,
      });

      return [
        `Replaced: ${JSON.stringify(context.resource.relativePath)}`,
        `SHA-256: ${sha}`,
      ].join('\n');
    },
  });

  const edit = defineRuntimeTool<EditArguments>({
    name: 'fs_edit',
    description:
      'Replace exactly one matching text occurrence in a ' +
      'workspace file. Requires its current SHA-256 and rejects ' +
      'missing, repeated, or stale matches.',
    action: 'fs.write',
    parameters: EditParameters,
    requiresRead: true,
    requiresPreparedContext: true,
    failureSideEffects: 'possible',

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    async execute(args, context) {
      const sha = await editWorkspaceFile(
        workspace,
        context.resource.relativePath,
        args.oldText,
        args.newText,
        args.expectedSha256,
        context.signal,
      );

      onRelevantTarget?.({
        kind: 'file',
        path: context.resource.relativePath,
      });

      return [
        `Edited: ${JSON.stringify(context.resource.relativePath)}`,
        'Replacements: 1',
        `SHA-256: ${sha}`,
      ].join('\n');
    },
  });

  return Object.freeze([create, write, edit]);
}
