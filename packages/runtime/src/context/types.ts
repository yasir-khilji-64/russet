export type InstructionTarget =
  | {
      readonly kind: 'file' | 'directory';
      readonly path: string;
    }
  | {
      readonly kind: 'new_file';
      readonly path: string;
    };

export interface InstructionSource {
  readonly path: string;
  readonly scope: string;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface WorkspaceInstructions {
  readonly sources: readonly InstructionSource[];
  readonly revision: string;
  readonly totalBytes: number;
}

export type InstructionErrorCode =
  | 'invalid_target'
  | 'not_permitted'
  | 'file_too_large'
  | 'total_budget_exceeded'
  | 'too_many_sources'
  | 'invalid_encoding'
  | 'source_changed'
  | 'source_unavailable';

export class InstructionLoadError extends Error {
  constructor(
    readonly code: InstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InstructionLoadError';
  }
}
