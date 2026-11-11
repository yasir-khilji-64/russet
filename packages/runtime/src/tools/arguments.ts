const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function normalizeToolArguments(
  input: unknown,
): Readonly<Record<string, unknown>> | undefined {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  function copy(value: unknown, depth: number): unknown {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new TypeError('Argument structure exceeds limits.');
    }

    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError('Non-finite number.');
      }

      return value;
    }

    if (typeof value !== 'object') {
      throw new TypeError('Non-JSON argument value.');
    }

    if (ancestors.has(value)) {
      throw new TypeError('Cyclic arguments.');
    }

    ancestors.add(value);

    try {
      if (Array.isArray(value)) {
        if (
          value.length > MAX_JSON_NODES ||
          Reflect.ownKeys(value).length !== value.length + 1
        ) {
          throw new TypeError('Invalid JSON array.');
        }

        const result: unknown[] = [];

        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );

          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Invalid JSON array element.');
          }

          result.push(copy(descriptor.value, depth + 1));
        }

        return Object.freeze(result);
      }

      const prototype = Object.getPrototypeOf(value);

      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Non-plain argument object.');
      }

      const result: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;

      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
          throw new TypeError('Unsafe argument property.');
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('Accessor properties are not allowed.');
        }

        result[key] = copy(descriptor.value, depth + 1);
      }

      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  }

  try {
    const result = copy(input, 0);

    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      return undefined;
    }

    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

    if (bytes > MAX_ARGUMENT_BYTES) {
      return undefined;
    }

    return result as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}
