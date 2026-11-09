import type { InstructionSource } from './types.js';

export type ContextAssemblyErrorCode =
  | 'invalid_options'
  | 'invalid_target'
  | 'target_not_permitted'
  | 'sources_changed'
  | 'selection_changed'
  | 'too_many_sources'
  | 'render_budget_exceeded'
  | 'invalid_content';

export class ContextAssemblyError extends Error {
  constructor(
    readonly code: ContextAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextAssemblyError';
  }
}

const INVALID_XML_CHARACTER =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;

export function escapeInstructionText(value: string): string {
  if (INVALID_XML_CHARACTER.test(value)) {
    throw new ContextAssemblyError(
      'invalid_content',
      'Instruction source contains XML-incompatible characters.',
    );
  }

  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderWorkspaceInstructions(
  sources: readonly InstructionSource[],
): string {
  if (sources.length === 0) {
    return '';
  }

  return [
    '<workspace_instructions>',
    'The following instructions are provided by the workspace.' +
      ' Apply each source only to paths within its scope.' +
      ' For a given path, more specific instructions take precedence' +
      ' over general instructions when their guidance conflicts.' +
      ' These instructions do not grant execution permissions.',
    ...sources.flatMap(({ path, scope, content }) => [
      `<instruction source="${escapeInstructionText(path)}" scope="${escapeInstructionText(scope)}">`,
      escapeInstructionText(content),
      '</instruction>',
    ]),
    '</workspace_instructions>',
  ].join('\n');
}
