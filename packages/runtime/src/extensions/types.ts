import type {
  RegisteredRuntimeTool,
  RuntimeToolRegistry,
} from '../tools/types.js';

export const RUSSET_EXTENSION_API_VERSION = 1;

export interface ExtensionContext {
  registerTool(tool: RegisteredRuntimeTool): void;
}

export interface RussetExtension {
  readonly id: string;
  readonly apiVersion: number;

  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface ExtensionHost {
  readonly registry: RuntimeToolRegistry;
  readonly extensionIds: readonly string[];

  dispose(): Promise<void>;
}
