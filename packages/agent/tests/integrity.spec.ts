import { describe, expect, it } from 'vitest';

import type {
  ConversationMessage,
  ModelToolCall,
  ToolResultConversationMessage,
} from '@russet/ai';

import { assertToolBatchIntegrity } from '../src/tools/integrity.js';

const calls: readonly ModelToolCall[] = [
  {
    toolCallId: 'call-A',
    name: 'fs.read',
    arguments: { path: 'A.txt' },
  },
  {
    toolCallId: 'call-B',
    name: 'fs.read',
    arguments: { path: 'B.txt' },
  },
];

function toolResult(
  toolCallId: string,
  isError: boolean,
): ToolResultConversationMessage {
  return {
    role: 'tool_result',
    toolCallId,
    toolName: 'fs.read',
    content: [{ type: 'text', text: 'Result.' }],
    isError,
  };
}

describe('Tool batch integrity', () => {
  it('accepts complete ordered results', () => {
    const conversation: ConversationMessage[] = [
      { role: 'user', text: 'Read two files.' },
      toolResult('call-A', false),
      toolResult('call-B', true),
    ];

    expect(() =>
      assertToolBatchIntegrity(calls, conversation, 1),
    ).not.toThrow();
  });

  it('rejects missing results', () => {
    const conversation: ConversationMessage[] = [toolResult('call-A', false)];

    expect(() => assertToolBatchIntegrity(calls, conversation, 0)).toThrow(
      'Tool batch result count',
    );
  });

  it('rejects results in the wrong order', () => {
    const conversation: ConversationMessage[] = [
      toolResult('call-B', false),
      toolResult('call-A', false),
    ];

    expect(() => assertToolBatchIntegrity(calls, conversation, 0)).toThrow(
      'completed proposal 1',
    );
  });

  it('rejects incorrect tool names', () => {
    const conversation: ConversationMessage[] = [
      toolResult('call-A', false),
      {
        ...toolResult('call-B', false),
        toolName: 'fs.write',
      },
    ];

    expect(() => assertToolBatchIntegrity(calls, conversation, 0)).toThrow(
      'completed proposal 2',
    );
  });

  it('rejects unexpected conversation messages', () => {
    const conversation: ConversationMessage[] = [
      toolResult('call-A', false),
      { role: 'user', text: 'Unexpected message.' },
    ];

    expect(() => assertToolBatchIntegrity(calls, conversation, 0)).toThrow(
      'completed proposal 2',
    );
  });

  it('accepts explicitly skipped calls as error results', () => {
    const conversation: ConversationMessage[] = [
      toolResult('call-A', false),
      {
        role: 'tool_result',
        toolCallId: 'call-B',
        toolName: 'fs.read',
        content: [
          {
            type: 'text',
            text: 'Not executed: previous operation failed.',
          },
        ],
        isError: true,
      },
    ];

    expect(() =>
      assertToolBatchIntegrity(calls, conversation, 0),
    ).not.toThrow();
  });
});
