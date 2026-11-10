import Type from 'typebox';

import type { InstructionTarget } from '../../context/types.js';
import { evaluateWorkspacePolicy } from '../../policy/evaluate.js';
import type { WorkspacePolicy } from '../../policy/types.js';
import type { Workspace } from '../../workspace/types.js';
import { ManagedToolError } from '../errors.js';
import { defineRuntimeTool } from '../registry.js';
import type { RegisteredRuntimeTool } from '../types.js';
import { textSha256 } from './mutate.js';
import { readWorkspaceText, UnsupportedTextFileError } from './text.js';
import { discoverWorkspaceEntries } from './walk.js';

const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_DISPLAYED_ENTRIES = 120;
const MAX_SEARCHED_FILES = 120;
const MAX_SEARCH_MATCHES = 80;
const MAX_READ_LINES = 120;

export interface ManagedReadToolsOptions {
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;

  readonly onRelevantTarget?: (target: InstructionTarget) => void;
}

interface ReadArguments {
  path: string;
  startLine?: number;
  maxLines?: number;
}

interface ListArguments {
  path: string;
  recursive?: boolean;
}

interface SearchArguments {
  path: string;
  query: string;
  mode: 'path' | 'content';
}

const ReadParameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    maxLines: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_READ_LINES }),
    ),
  },
  { additionalProperties: false },
);

const ListParameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    recursive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SearchParameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    query: Type.String({ minLength: 1, maxLength: 128 }),
    mode: Type.Union([Type.Literal('path'), Type.Literal('content')]),
  },
  { additionalProperties: false },
);

function escapeControls(value: string): string {
  return value.replace(
    // oxlint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function boundLines(lines: readonly string[]): string {
  const result: string[] = [];
  let used = 0;

  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;

    if (used + bytes > MAX_OUTPUT_BYTES - 512) {
      result.push(
        '[Output limit reached. Narrow the request or read a smaller range.]',
      );
      break;
    }

    result.push(line);
    used += bytes;
  }

  return result.join('\n');
}

function renderRead(
  path: string,
  text: string,
  startLine: number,
  maxLines: number,
): string {
  const lines = text.split(/\r?\n/u);

  if (text.endsWith('\n')) {
    lines.pop();
  }

  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);

  const output = [
    `File: ${JSON.stringify(path)}`,
    `Lines: ${startLine}-${startLine + selected.length - 1} of ${lines.length}`,
    `SHA-256: ${textSha256(text)}`,
    '',
    ...selected.map(
      (line, index) =>
        `${startLine + index} | ${escapeControls(
          line.slice(0, 1_600),
        )}${line.length > 1_600 ? ' [line shortened]' : ''}`,
    ),
  ];

  if (startLine - 1 + selected.length < lines.length) {
    output.push('', '[Additional lines available. Use startLine to continue.]');
  }

  return boundLines(output);
}

function renderList(
  path: string,
  discovery: Awaited<ReturnType<typeof discoverWorkspaceEntries>>,
): string {
  const selected = discovery.entries.slice(0, MAX_DISPLAYED_ENTRIES);

  const output = [
    `Directory: ${JSON.stringify(path)}`,
    `Discovered entries: ${discovery.entries.length}`,
    '',
    ...selected.map(
      (entry) =>
        `${entry.kind === 'directory' ? 'dir ' : 'file'} ${JSON.stringify(entry.path)}`,
    ),
  ];

  if (discovery.incomplete || discovery.entries.length > selected.length) {
    output.push(
      '',
      '[Discovery incomplete or output limited. Narrow the directory.]',
    );
  }

  return boundLines(output);
}

export function createManagedReadTools(
  options: ManagedReadToolsOptions,
): readonly RegisteredRuntimeTool[] {
  const { workspace, policy, onRelevantTarget } = options;

  const read = defineRuntimeTool<ReadArguments>({
    name: 'fs_read',
    description:
      'Read a permitted UTF-8 workspace file with numbered lines. ' +
      'Use startLine and maxLines to select a range.',
    action: 'fs.read',
    failureSideEffects: 'none',
    parameters: ReadParameters,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    async execute(args, context) {
      if (context.resource.kind !== 'file') {
        throw new ManagedToolError('fs_read requires a regular file.');
      }

      const text = await readWorkspaceText(
        workspace,
        context.resource.relativePath,
        context.signal,
      );

      const result = renderRead(
        context.resource.relativePath,
        text,
        args.startLine ?? 1,
        args.maxLines ?? MAX_READ_LINES,
      );

      context.signal.throwIfAborted();

      onRelevantTarget?.({
        kind: 'file',
        path: context.resource.relativePath,
      });

      return result;
    },
  });

  const list = defineRuntimeTool<ListArguments>({
    name: 'fs_list',
    description:
      'List permitted workspace files and directories. ' +
      'Recursive discovery is bounded and excludes generated directories.',
    action: 'fs.search',
    failureSideEffects: 'none',
    parameters: ListParameters,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    async execute(args, context) {
      if (context.resource.kind !== 'directory') {
        throw new ManagedToolError('fs_list requires a directory.');
      }

      const discovery = await discoverWorkspaceEntries(
        workspace,
        policy,
        context.resource.relativePath,
        args.recursive ?? false,
        context.signal,
      );

      const result = renderList(context.resource.relativePath, discovery);

      context.signal.throwIfAborted();

      onRelevantTarget?.({
        kind: 'directory',
        path: context.resource.relativePath,
      });

      return result;
    },
  });

  const search = defineRuntimeTool<SearchArguments>({
    name: 'fs_search',
    description:
      'Search permitted workspace paths or UTF-8 text using a ' +
      'case-insensitive literal substring. This is not regex search.',
    action: 'fs.search',
    failureSideEffects: 'none',
    parameters: SearchParameters,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    async execute(args, context) {
      if (context.resource.kind !== 'directory') {
        throw new ManagedToolError('fs_search requires a directory.');
      }

      // oxlint-disable-next-line no-control-regex
      if (/[\r\n\u0000]/u.test(args.query)) {
        throw new ManagedToolError('Search query must be a single line.');
      }

      const discovery = await discoverWorkspaceEntries(
        workspace,
        policy,
        context.resource.relativePath,
        true,
        context.signal,
      );

      const needle = args.query.toLowerCase();
      const lines: string[] = [
        `Search: ${JSON.stringify(args.query)}`,
        `Mode: ${args.mode}`,
        `Directory: ${JSON.stringify(context.resource.relativePath)}`,
        '',
      ];

      let limited = discovery.incomplete;
      let matches = 0;

      if (args.mode === 'path') {
        for (const entry of discovery.entries) {
          if (!entry.path.toLowerCase().includes(needle)) {
            continue;
          }

          if (matches >= MAX_SEARCH_MATCHES) {
            limited = true;
            break;
          }

          lines.push(JSON.stringify(entry.path));
          matches++;
        }
      } else {
        let examinedFiles = 0;
        let skippedFiles = 0;

        for (const entry of discovery.entries) {
          context.signal.throwIfAborted();

          if (entry.kind !== 'file') {
            continue;
          }

          // Search permission is not permission to read contents.
          const decision = evaluateWorkspacePolicy(policy, {
            action: 'fs.read',
            relativePath: entry.path,
            kind: 'file',
          });

          if (decision.decision !== 'allow') {
            skippedFiles++;
            continue;
          }

          if (examinedFiles >= MAX_SEARCHED_FILES) {
            limited = true;
            break;
          }

          examinedFiles++;

          let text: string;

          try {
            text = await readWorkspaceText(
              workspace,
              entry.path,
              context.signal,
            );
          } catch (error) {
            if (error instanceof UnsupportedTextFileError) {
              skippedFiles++;
              continue;
            }

            throw error;
          }

          const fileLines = text.split(/\r?\n/u);

          for (const [index, line] of fileLines.entries()) {
            const position = line.toLowerCase().indexOf(needle);

            if (position === -1) {
              continue;
            }

            if (matches >= MAX_SEARCH_MATCHES) {
              limited = true;
              break;
            }

            const excerpt = line.slice(
              Math.max(0, position - 80),
              position + needle.length + 120,
            );

            lines.push(
              `${JSON.stringify(entry.path)}:${index + 1}: ` +
                escapeControls(excerpt),
            );

            matches++;
          }

          if (limited) {
            break;
          }
        }

        lines.push(
          '',
          `Files inspected for content: ${examinedFiles}`,
          `Files skipped (policy or unsupported text): ${skippedFiles}`,
        );
      }

      lines.push('', `Matches shown: ${matches}`);

      if (limited) {
        lines.push(
          '[Search incomplete: traversal, file, or match limit reached.]',
        );
      }

      const result = boundLines(lines);

      context.signal.throwIfAborted();

      onRelevantTarget?.({
        kind: 'directory',
        path: context.resource.relativePath,
      });

      return result;
    },
  });

  return Object.freeze([read, list, search]);
}
