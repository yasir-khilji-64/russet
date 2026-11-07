// oxlint-disable no-console
import { createInferenceEngine, getCompletedToolCalls } from '@russet/ai';

const providers = {
  ollama: {
    providerId: 'ollama',
    modelId: 'gpt-oss:20b',
  },
  groq: {
    providerId: 'groq',
    modelId: 'openai/gpt-oss-20b',
  },
};

const provider = process.argv[2] ?? 'ollama';
const model = providers[provider];

if (!model) {
  throw new Error(`Unknown provider "${provider}". Use ollama or groq.`);
}

if (provider === 'groq' && !process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not configured.');
}

const engine = createInferenceEngine({
  ollama: {
    contextWindow: 8192,
    maxOutputTokens: 2048,
  },
});

const tools = [
  {
    name: 'add_numbers',
    description: 'Add two numbers and return their sum.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
];

const messages = [
  {
    role: 'user',
    text:
      'Call add_numbers with a=125 and b=375. ' +
      'Use the tool result to provide the final answer.',
  },
];

const controller = new AbortController();

process.once('SIGINT', () => {
  controller.abort();
});

function printStreamEvent(event, output) {
  switch (event.type) {
    case 'response.started':
      console.log('\n[Response started]');
      break;

    case 'text.started':
      output.start(event.blockId, 'Text');
      break;

    case 'text.delta':
      output.delta(event.blockId, 'Text', event.delta);
      break;

    case 'text.completed':
      output.end(event.blockId);
      break;

    case 'thinking.started':
      output.start(event.blockId, 'Thinking');
      break;

    case 'thinking.delta':
      output.delta(event.blockId, 'Thinking', event.delta);
      break;

    case 'thinking.completed':
      output.end(event.blockId);
      console.log(`[Thinking: ${event.visibility}]`);
      break;

    case 'toolcall.started':
      output.start(event.blockId, 'Tool arguments (preview only)');
      break;

    case 'toolcall.arguments.delta':
      output.delta(event.blockId, 'Tool arguments (preview only)', event.delta);
      break;

    case 'toolcall.completed':
      output.end(event.blockId);
      console.log(`[Tool call completed] ${event.toolCall.name}`);
      break;

    case 'response.completed':
    case 'response.failed':
      output.flush();
      break;
  }
}

function createOutput() {
  let activeBlock = null;

  return {
    start(blockId, label) {
      if (activeBlock !== null) {
        process.stdout.write('\n');
      }

      console.log(`\n[${label}]`);
      activeBlock = blockId;
    },

    delta(blockId, label, value) {
      if (activeBlock !== blockId) {
        this.start(blockId, label);
      }

      process.stdout.write(value);
    },

    end(blockId) {
      if (activeBlock === blockId) {
        process.stdout.write('\n');
        activeBlock = null;
      }
    },

    flush() {
      if (activeBlock !== null) {
        process.stdout.write('\n');
        activeBlock = null;
      }
    },
  };
}

async function infer() {
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(180_000),
  ]);

  const stream = engine.stream(
    {
      model,
      messages,
      tools,
      systemPrompt:
        'You are a helpful assistant. ' +
        'Use the provided tool when requested.',
    },
    {
      signal,
      ...(provider === 'groq' ? { thinking: { effort: 'medium' } } : {}),
    },
  );

  const output = createOutput();

  for await (const event of stream) {
    printStreamEvent(event, output);
  }

  const response = await stream.result();

  if (response.failure) {
    throw new Error(
      `Inference failed (${response.failure.code}): ` +
        response.failure.message,
    );
  }

  console.log(`\n[Finish reason] ${response.finishReason}`);

  if (response.usage) {
    console.log('[Usage]', response.usage);
  }

  return response;
}

function executeExampleTool(call) {
  if (call.name !== 'add_numbers') {
    return {
      isError: true,
      text: `Unknown tool: ${call.name}`,
    };
  }

  const args = call.arguments;

  if (
    args === null ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => key !== 'a' && key !== 'b') ||
    typeof args.a !== 'number' ||
    typeof args.b !== 'number' ||
    !Number.isFinite(args.a) ||
    !Number.isFinite(args.b)
  ) {
    return {
      isError: true,
      text: 'Invalid add_numbers arguments.',
    };
  }

  const sum = args.a + args.b;

  if (!Number.isFinite(sum)) {
    return {
      isError: true,
      text: 'Arithmetic result is not finite.',
    };
  }

  return {
    isError: false,
    text: String(sum),
  };
}

async function main() {
  console.log(`Provider: ${model.providerId}`);
  console.log(`Model: ${model.modelId}`);

  let executedTools = 0;
  const maxRequests = 5;

  for (let requestNumber = 1; requestNumber <= maxRequests; requestNumber++) {
    console.log(`\n========== Request ${requestNumber} ==========`);

    const response = await infer();

    if (response.finishReason === 'stop') {
      if (executedTools === 0) {
        throw new Error(
          'The model finished without requesting the example tool.',
        );
      }

      console.log('\n[Interaction completed]');
      return;
    }

    if (response.finishReason !== 'tool_use') {
      throw new Error(`Cannot continue after ${response.finishReason}.`);
    }

    const calls = getCompletedToolCalls(response);

    messages.push({
      role: 'assistant',
      response,
    });

    for (const call of calls) {
      console.log(`\n[Executing tool] ${call.name}`);

      const result = executeExampleTool(call);

      console.log(
        `[Tool ${result.isError ? 'failed' : 'result'}] ` + result.text,
      );

      messages.push({
        role: 'tool_result',
        toolCallId: call.toolCallId,
        toolName: call.name,
        content: [
          {
            type: 'text',
            text: result.text,
          },
        ],
        isError: result.isError,
      });

      executedTools++;
    }
  }

  throw new Error('Maximum model requests exceeded.');
}

main().catch((error) => {
  console.error('\n[Example failed]', error.message);
  process.exitCode = 1;
});
