// oxlint-disable no-console
import assert from 'node:assert/strict';

import { createAgent } from '@russet/agent';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const tool = {
  name: 'add_numbers',
  description: 'Add two numbers.',
  parameters: { type: 'object' },
};

function response(requestId, finishReason, toolIds = []) {
  return {
    requestId,
    messageId: `message-${requestId}`,
    model,
    finishReason,
    thinkingAvailability: 'unavailable',
    blocks:
      finishReason === 'tool_use'
        ? toolIds.map((toolCallId) => ({
            id: `block-${toolCallId}`,
            type: 'toolcall',
            toolCall: {
              toolCallId,
              name: 'add_numbers',
              arguments: { a: 125, b: 375 },
            },
          }))
        : [
            {
              id: 'text-final',
              type: 'text',
              text: 'Finished.',
            },
          ],
  };
}

function scriptedInference(responses) {
  const requests = [];

  const inference = {
    stream(_request) {
      const final = responses[requests.length];

      if (!final) {
        throw new Error('No scripted inference response remains.');
      }

      requests.push(_request);

      let consumed = false;
      let complete = false;

      return {
        async *[Symbol.asyncIterator]() {
          if (consumed) {
            throw new Error('Stream consumed more than once.');
          }

          consumed = true;

          yield {
            type: 'response.started',
            requestId: final.requestId,
            messageId: final.messageId,
          };

          for (const block of final.blocks) {
            if (block.type === 'toolcall') {
              yield {
                type: 'toolcall.completed',
                requestId: final.requestId,
                messageId: final.messageId,
                blockId: block.id,
                toolCall: block.toolCall,
              };
            }
          }

          complete = true;

          yield {
            type: final.failure ? 'response.failed' : 'response.completed',
            requestId: final.requestId,
            messageId: final.messageId,
            response: final,
          };
        },

        async result() {
          if (!complete) {
            throw new Error(
              'Final response requested before stream completion.',
            );
          }

          return final;
        },
      };
    },
  };

  return { inference, requests };
}

function gateway(execute) {
  return {
    async listModelTools({ signal }) {
      return signal.aborted ? [] : [tool];
    },

    execute,
  };
}

function request(limits, signal) {
  return {
    model,
    message: 'Use add_numbers with 125 and 375.',
    ...(limits === undefined ? {} : { limits }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function deferred() {
  let resolve;

  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function checkDeniedBatch() {
  const scripted = scriptedInference([
    response('request-1', 'tool_use', ['A', 'B']),
    response('request-2', 'stop'),
  ]);

  let dispatches = 0;

  const agent = createAgent({
    inference: scripted.inference,
    toolGateway: gateway(async (_request, context) => {
      dispatches++;

      context.onUpdate({
        type: 'approval.requested',
        approvalRequestId: 'approval-A',
        description: 'Add numbers',
      });

      context.onUpdate({
        type: 'approval.resolved',
        approvalRequestId: 'approval-A',
        decision: 'deny',
      });

      return {
        status: 'rejected',
        code: 'permission_denied',
        message: 'Denied.',
      };
    }),
  });

  try {
    const result = await agent.start(request()).result;

    assert.equal(result.status, 'completed');
    assert.equal(dispatches, 1);

    const results = agent
      .getConversation()
      .filter((entry) => entry.role === 'tool_result');

    assert.deepEqual(
      results.map((entry) => [entry.toolCallId, entry.isError]),
      [
        ['A', true],
        ['B', true],
      ],
    );

    assert.equal(scripted.requests.length, 2);

    console.log(
      '[PASS] Rejected operation; remaining call skipped; ' +
        'model continued.',
    );
  } finally {
    await agent.dispose();
  }
}

async function checkConfirmedCancellation() {
  const scripted = scriptedInference([
    response('request-1', 'tool_use', ['A', 'B']),
  ]);

  const controller = new AbortController();
  let dispatches = 0;

  const agent = createAgent({
    inference: scripted.inference,
    toolGateway: gateway(async () => {
      dispatches++;

      controller.abort(new Error('Cancelled during tool A.'));

      return {
        status: 'success',
        content: [{ type: 'text', text: '500' }],
      };
    }),
  });

  try {
    const result = await agent.start(request(undefined, controller.signal))
      .result;

    assert.equal(result.status, 'cancelled');
    assert.equal(dispatches, 1);

    const results = agent
      .getConversation()
      .filter((entry) => entry.role === 'tool_result');

    assert.deepEqual(
      results.map((entry) => entry.isError),
      [false, true],
    );

    console.log(
      '[PASS] Confirmed tool success preserved; ' +
        'subsequent call not executed.',
    );
  } finally {
    await agent.dispose();
  }
}

async function checkLimits() {
  const scripted = scriptedInference([
    response('request-1', 'tool_use', ['A', 'B']),
  ]);

  let dispatches = 0;

  const agent = createAgent({
    inference: scripted.inference,
    toolGateway: gateway(async () => {
      dispatches++;

      return {
        status: 'success',
        content: [{ type: 'text', text: '500' }],
      };
    }),
  });

  try {
    const result = await agent.start(request({ maxToolAttempts: 1 })).result;

    assert.equal(result.status, 'limit_reached');
    assert.equal(dispatches, 0);
    assert.deepEqual(agent.getConversation(), []);

    console.log(
      '[PASS] Whole-batch tool attempt limit prevents partial dispatch.',
    );
  } finally {
    await agent.dispose();
  }
}

async function checkUncertainCancellation() {
  const scripted = scriptedInference([
    response('request-1', 'tool_use', ['A']),
  ]);

  const started = deferred();
  const controller = new AbortController();

  const agent = createAgent({
    inference: scripted.inference,
    toolGateway: gateway((_request, context) => {
      context.onUpdate({
        type: 'execution.started',
      });

      started.resolve();

      // Deliberately never confirms the operation outcome.
      return new Promise(() => {});
    }),
  });

  try {
    const run = agent.start(
      request({ maxCancellationWaitMs: 10 }, controller.signal),
    );

    await started.promise;

    controller.abort(new Error('Cancel unresponsive operation.'));

    const result = await run.result;

    assert.equal(result.status, 'interrupted');

    assert.throws(() => agent.start(request()), /requires reconciliation/);

    console.log(
      '[PASS] Unconfirmed operation interrupts the run and blocks replay.',
    );
  } finally {
    await agent.dispose();
  }
}

await checkDeniedBatch();
await checkConfirmedCancellation();
await checkLimits();
await checkUncertainCancellation();

console.log('\n[All Agent safeguard scenarios passed]');
