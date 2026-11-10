import type Type from 'typebox';
import Schema from 'typebox/schema';

import { normalizeToolArguments } from './arguments.js';
import type {
  RegisteredRuntimeTool,
  RuntimeTool,
  RuntimeToolRegistry,
} from './types.js';

const VALID_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function deepFreezeJson(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }

  Object.freeze(value);
}

export function defineRuntimeTool<TArguments extends object>(
  definition: RuntimeTool<TArguments>,
): RegisteredRuntimeTool {
  if (!VALID_TOOL_NAME.test(definition.name)) {
    throw new TypeError('Invalid runtime tool name.');
  }

  if (!definition.description.trim()) {
    throw new TypeError('Runtime tool description is required.');
  }

  if (
    definition.action !== 'fs.read' &&
    definition.action !== 'fs.search' &&
    definition.action !== 'fs.write' &&
    definition.action !== 'fs.delete'
  ) {
    throw new TypeError('Unsupported runtime tool action.');
  }

  if (
    definition.parameters.type !== 'object' ||
    !('additionalProperties' in definition.parameters) ||
    definition.parameters.additionalProperties !== false
  ) {
    throw new TypeError('Tool parameters must be a strict object schema.');
  }

  if (
    typeof definition.target !== 'function' ||
    typeof definition.execute !== 'function'
  ) {
    throw new TypeError('Invalid runtime tool implementation.');
  }

  if (
    definition.failureSideEffects !== undefined &&
    definition.failureSideEffects !== 'none' &&
    definition.failureSideEffects !== 'possible'
  ) {
    throw new TypeError('Invalid failure side-effect classification');
  }

  if (
    definition.requiresRead !== undefined &&
    typeof definition.requiresRead !== 'boolean'
  ) {
    throw new TypeError('Invalid read requirement.');
  }

  if (
    definition.requiresPreparedContext !== undefined &&
    typeof definition.requiresPreparedContext !== 'boolean'
  ) {
    throw new TypeError('Invalid context requirement.');
  }

  const parameters = JSON.parse(
    JSON.stringify(definition.parameters),
  ) as ReturnType<typeof Type.Object>;

  const validator = Schema.Compile(parameters);

  const modelParameters = JSON.parse(
    JSON.stringify(parameters),
  ) as RegisteredRuntimeTool['modelDefinition']['parameters'];

  const modelDefinition: RegisteredRuntimeTool['modelDefinition'] = {
    name: definition.name,
    description: definition.description,
    parameters: modelParameters,
  };

  deepFreezeJson(modelDefinition);

  const target = definition.target;
  const execute = definition.execute;

  return Object.freeze({
    name: definition.name,
    action: definition.action,
    modelDefinition,
    failureSideEffects: definition.failureSideEffects ?? 'possible',
    requiresRead: definition.requiresRead ?? false,
    requiresPreparedContext: definition.requiresPreparedContext ?? false,

    validate(input: unknown) {
      const args = normalizeToolArguments(input);

      if (args === undefined || !validator.Check(args)) {
        return undefined;
      }

      return args;
    },

    target(arguments_: Readonly<Record<string, unknown>>) {
      return target(arguments_ as Readonly<TArguments>);
    },

    execute(
      arguments_: Readonly<Record<string, unknown>>,
      context: Parameters<typeof execute>[1],
    ) {
      return execute(arguments_ as Readonly<TArguments>, context);
    },
  });
}

export function createToolRegistry(
  tools: readonly RegisteredRuntimeTool[],
): RuntimeToolRegistry {
  const entries = new Map<string, RegisteredRuntimeTool>();

  for (const tool of tools) {
    if (entries.has(tool.name)) {
      throw new TypeError(`Duplicate runtime tool: ${tool.name}`);
    }

    entries.set(tool.name, tool);
  }

  return Object.freeze({
    get(name: string) {
      return entries.get(name);
    },

    list() {
      return [...entries.values()].map((tool) =>
        structuredClone(tool.modelDefinition),
      );
    },
  });
}
