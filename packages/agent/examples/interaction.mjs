// oxlint-disable no-console
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { createAgent } from '@russet/agent';
import { createInferenceEngine } from '@russet/ai';

const models = {
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
const selectedModel = models[provider];

const options = Object.fromEntries(
  process.argv.slice(3).map((argument) => {
    const match = /^--(approval|followup)=(.+)$/.exec(argument);

    if (!match) {
      throw new Error(`Unrecognized option: ${argument}`);
    }

    return [match[1], match[2]];
  }),
);

const approvalMode = options.approval ?? 'allow';
const followupProvider = options.followup ?? provider;

if (!selectedModel) {
  throw new Error(`Unknown provider: ${provider}. Use ollama or groq.`);
}

if (!['allow', 'deny', 'prompt'].includes(approvalMode)) {
  throw new Error('Use --approval=allow, deny, or prompt.');
}

if (followupProvider !== 'none' && !models[followupProvider]) {
  throw new Error('Use --followup=ollama, groq, or none.');
}

for (const name of [provider, followupProvider]) {
  if (name === 'groq' && !process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required for Groq inference.');
  }
}

const engine = createInferenceEngine({
  ollama: {
    contextWindow: 8192,
    maxOutputTokens: 2048,
  },
});

const definitions = [
  {
    name: 'add_numbers',
    description: 'Add two finite numbers and return their sum.',
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

function isValidArguments(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'a') &&
    Object.hasOwn(value, 'b') &&
    Number.isFinite(value.a) &&
    Number.isFinite(value.b)
  );
}

async function askApproval(signal) {
  if (approvalMode === 'allow') {
    return true;
  }
  if (approvalMode === 'deny') {
    return false;
  }

  if (!process.stdin.isTTY) {
    return null;
  }

  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await input.question(
      'Allow add_numbers for this call? [y/N] ',
      { signal },
    );

    return /^(y|yes)$/i.test(answer.trim());
  } catch {
    return null;
  } finally {
    input.close();
  }
}

const executed = [];
let approvalRequests = 0;

const gateway = {
  async listModelTools({ signal }) {
    if (signal.aborted) {
      return [];
    }
    return definitions;
  },

  async execute(request, context) {
    const { toolCall, toolExecutionId } = request;

    if (context.signal.aborted) {
      return {
        status: 'cancelled',
        message: 'Cancelled before execution.',
        sideEffects: 'none',
      };
    }

    if (toolCall.name !== 'add_numbers') {
      return {
        status: 'rejected',
        code: 'unknown_tool',
        message: 'Tool is not registered.',
      };
    }

    if (!isValidArguments(toolCall.arguments)) {
      return {
        status: 'rejected',
        code: 'invalid_arguments',
        message: 'Expected finite numeric a and b.',
      };
    }

    approvalRequests++;
    const approvalRequestId = randomUUID();

    context.onUpdate({
      type: 'approval.requested',
      approvalRequestId,
      description: `Add ${toolCall.arguments.a} and ${toolCall.arguments.b}`,
    });

    const approved = await askApproval(context.signal);

    if (context.signal.aborted) {
      return {
        status: 'cancelled',
        message: 'Cancelled while awaiting approval.',
        sideEffects: 'none',
      };
    }

    if (approved === null) {
      return {
        status: 'rejected',
        code: 'approval_unavailable',
        message: 'No approval decision available.',
      };
    }

    context.onUpdate({
      type: 'approval.resolved',
      approvalRequestId,
      decision: approved ? 'allow' : 'deny',
    });

    if (!approved) {
      return {
        status: 'rejected',
        code: 'permission_denied',
        message: 'Arithmetic call denied by the example approval rule.',
      };
    }

    if (context.signal.aborted) {
      return {
        status: 'cancelled',
        message: 'Cancelled before handler start.',
        sideEffects: 'none',
      };
    }

    context.onUpdate({ type: 'execution.started' });

    const sum = toolCall.arguments.a + toolCall.arguments.b;

    if (!Number.isFinite(sum)) {
      return {
        status: 'failed',
        message: 'Arithmetic overflow.',
        sideEffects: 'none',
      };
    }

    executed.push({ toolExecutionId, sum });

    return {
      status: 'success',
      content: [
        {
          type: 'text',
          text: String(sum),
        },
      ],
    };
  },
};

function createEventPrinter() {
  let activeBlock = null;

  function flush() {
    if (activeBlock !== null) {
      process.stdout.write('\n');
    }

    activeBlock = null;
  }

  function write(blockId, label, delta) {
    if (activeBlock !== blockId) {
      flush();
      console.log(`\n[${label}]`);
      activeBlock = blockId;
    }

    process.stdout.write(delta);
  }

  return (event) => {
    switch (event.type) {
      case 'run.started':
        console.log(
          `\n[Run ${event.runId}] ` +
            `${event.model.providerId}/${event.model.modelId}`,
        );
        break;

      case 'run.phase_changed':
        flush();
        console.log(`[Phase] ${event.phase}`);
        break;

      case 'model.request.started':
        flush();
        console.log(`\n[Model request ${event.ordinal}]`);
        break;

      case 'model.event': {
        const modelEvent = event.event;

        switch (modelEvent.type) {
          case 'text.delta':
            write(modelEvent.blockId, 'Text', modelEvent.delta);
            break;

          case 'thinking.delta':
            write(modelEvent.blockId, 'Thinking', modelEvent.delta);
            break;

          case 'toolcall.arguments.delta':
            write(
              modelEvent.blockId,
              'Tool arguments preview',
              modelEvent.delta,
            );
            break;

          case 'text.completed':
          case 'thinking.completed':
          case 'toolcall.completed':
            flush();

            if (modelEvent.type === 'thinking.completed') {
              console.log(`[Thinking visibility] ${modelEvent.visibility}`);
            }

            if (modelEvent.type === 'toolcall.completed') {
              console.log(
                `[Tool proposal streamed] ` +
                  `${modelEvent.toolCall.name}; ` +
                  'not executed yet',
              );
            }
            break;
        }

        break;
      }

      case 'model.request.finished':
        flush();
        console.log(
          `[Model finished] ${event.finishReason}` +
            (event.failure ? ` (${event.failure.code})` : ''),
        );
        break;

      case 'model.request.failed':
        flush();
        console.log(`[Model stream failure] ${event.reason}`);
        break;

      case 'tool.proposed':
        console.log(
          `[Completed tool proposal] ${event.name} (${event.toolCallId})`,
        );
        break;

      case 'tool.dispatch.started':
        console.log(`[Gateway dispatch] ${event.toolExecutionId}`);
        break;

      case 'tool.approval.requested':
        console.log(`[Approval requested] ${event.description}`);
        break;

      case 'tool.approval.resolved':
        console.log(`[Approval decision] ${event.decision}`);
        break;

      case 'tool.execution.started':
        console.log(`[Handler started] ${event.toolExecutionId}`);
        break;

      case 'tool.dispatch.finished':
        console.log(`[Tool outcome] ${event.status}`);
        break;

      case 'tool.skipped':
        console.log(`[Tool skipped] ${event.toolCallId}: ` + event.reason);
        break;

      case 'run.finished':
        flush();
        console.log(`[Run finished] ${event.result.status}`);
        break;
    }
  };
}

const controller = new AbortController();

const signal = AbortSignal.any([
  controller.signal,
  AbortSignal.timeout(180_000),
]);

const onInterrupt = () => {
  controller.abort(new Error('Interrupted by SIGINT.'));
};

process.once('SIGINT', onInterrupt);

const agent = createAgent({
  inference: engine,
  toolGateway: gateway,
});

async function runTurn(message, model) {
  const run = agent.start(
    {
      message,
      model,
      signal,
      systemPrompt:
        'You are a precise assistant. ' +
        'Use add_numbers when requested. ' +
        'Use the tool result in the final answer. ' +
        'If a tool is denied, explain that briefly ' +
        'without retrying.',
      ...(model.providerId === 'groq'
        ? { thinking: { effort: 'medium' } }
        : {}),
      limits: {
        maxModelRequests: 6,
        maxToolAttempts: 8,
        maxCancellationWaitMs: 2_000,
      },
    },
    createEventPrinter(),
  );

  const result = await run.result;

  if (result.status !== 'completed') {
    throw new Error(
      `Agent run ${result.status}: ` + JSON.stringify(result.failure ?? null),
    );
  }

  return result;
}

function summarizeConversation() {
  const conversation = agent.getConversation();

  console.log(
    '\n[Conversation roles]',
    conversation.map((message) => message.role).join(' → '),
  );

  const responses = conversation
    .filter((message) => message.role === 'assistant')
    .map((message) => message.response);

  const reports = responses.flatMap((response) =>
    response.usage ? [response.usage] : [],
  );

  console.log(`[Model requests in conversation] ${responses.length}`);
  console.log(`[Usage reports] ${reports.length}/${responses.length}`);

  if (reports.length > 0) {
    console.log(
      '[Reported tokens]',
      reports.reduce((sum, usage) => sum + usage.totalTokens, 0),
    );
  }
}

async function main() {
  console.log(`[Provider] ${provider}`);
  console.log(`[Approval mode] ${approvalMode} (example gateway only)`);

  try {
    await runTurn(
      'Call add_numbers with a=125 and b=375. ' +
        'Use the tool result to give the sum.',
      selectedModel,
    );

    if (approvalRequests === 0) {
      throw new Error('The model did not request the example tool.');
    }

    if (approvalMode === 'allow') {
      if (!executed.some((entry) => entry.sum === 500)) {
        throw new Error(
          'Expected an authorized add_numbers execution with result 500.',
        );
      }
    } else if (approvalMode === 'deny' && executed.length !== 0) {
      throw new Error('Denied mode unexpectedly executed a tool.');
    }

    if (followupProvider !== 'none') {
      console.log('\n========== Follow-up turn ==========');

      await runTurn(
        'What calculation was requested in the previous ' +
          'turn, and what was its outcome? ' +
          'Answer from conversation context; ' +
          'do not call a tool.',
        models[followupProvider],
      );
    }

    summarizeConversation();

    console.log('\n[Agent interaction completed]');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await agent.dispose();
  }
}

main().catch((error) => {
  console.error(
    '\n[Example failed]',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
