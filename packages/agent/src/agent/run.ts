import { AgentEventPublisher } from '../events/publisher.js';
import type {
  AgentEventListener,
  AgentEventPayload,
  AgentRunPhase,
} from '../events/types.js';
import type {
  AgentRun,
  AgentRunFailure,
  AgentRunResult,
  AgentRunState,
  AgentRunStatus,
} from './types.js';

interface RunState {
  settled: boolean;
  phase: AgentRunPhase;
  terminalResult: AgentRunResult | undefined;
  detachExternalSignal: (() => void) | undefined;
}

interface RunManagerState {
  activeRun: AgentRunController | undefined;
}

interface Completion<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createCompletion<T>(): Completion<T> {
  const settlement: {
    resolve: ((value: T) => void) | undefined;
  } = {
    resolve: undefined,
  };

  const promise = new Promise<T>((resolve) => {
    settlement.resolve = resolve;
  });

  if (settlement.resolve === undefined) {
    throw new Error('Failed to initialize agent run completion.');
  }

  return {
    promise,
    resolve: settlement.resolve,
  };
}

export class AgentRunController implements AgentRun {
  readonly id: string;
  readonly result: Promise<AgentRunResult>;
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly completion = createCompletion<AgentRunResult>();
  private readonly events: AgentEventPublisher;

  private readonly stateData: RunState = {
    settled: false,
    phase: 'preparing',
    terminalResult: undefined,
    detachExternalSignal: undefined,
  };

  private readonly onSettled: (() => void) | undefined;

  constructor(
    id: string,
    externalSignal?: AbortSignal,
    onSettled?: () => void,
    initialListener?: AgentEventListener,
  ) {
    if (id.trim().length === 0) {
      throw new Error('Agent run ID must not be empty.');
    }

    this.id = id;
    this.signal = this.controller.signal;
    this.result = this.completion.promise;
    this.onSettled = onSettled;
    this.events = new AgentEventPublisher(id, initialListener);

    if (externalSignal === undefined) {
      return;
    }

    if (externalSignal.aborted) {
      this.abort(externalSignal.reason);
      return;
    }

    const forwardAbort = () => {
      this.abort(externalSignal.reason);
    };

    externalSignal.addEventListener('abort', forwardAbort, {
      once: true,
    });

    this.stateData.detachExternalSignal = () => {
      externalSignal.removeEventListener('abort', forwardAbort);
    };
  }

  get state(): AgentRunState {
    if (this.stateData.terminalResult !== undefined) {
      return Object.freeze({
        kind: 'finished',
        result: this.stateData.terminalResult,
      });
    }

    return Object.freeze({
      kind: 'active',
      phase: this.stateData.phase,
    });
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.events.subscribe(listener);
  }

  publish(payload: AgentEventPayload): void {
    this.events.publish(payload);
  }

  setPhase(phase: AgentRunPhase): void {
    if (this.stateData.settled || this.stateData.phase === phase) {
      return;
    }

    this.stateData.phase = phase;

    this.publish({
      type: 'run.phase_changed',
      phase,
    });
  }

  cancel(reason?: string): void {
    this.abort(reason);
  }

  finish(status: AgentRunStatus, failure?: AgentRunFailure): boolean {
    if (this.stateData.settled) {
      return false;
    }

    if (this.signal.aborted && status === 'completed') {
      throw new Error('A cancelled run cannot complete successfully.');
    }

    const stableFailure: AgentRunFailure | undefined =
      failure === undefined
        ? undefined
        : failure.kind === 'inference'
          ? Object.freeze({
              kind: 'inference',
              failure: Object.freeze({ ...failure.failure }),
            })
          : Object.freeze({ ...failure });

    const result: AgentRunResult = Object.freeze({
      runId: this.id,
      status,
      ...(stableFailure === undefined ? {} : { failure: stableFailure }),
    });

    this.stateData.settled = true;
    this.stateData.terminalResult = result;

    this.stateData.detachExternalSignal?.();
    this.stateData.detachExternalSignal = undefined;

    this.onSettled?.();

    this.publish({
      type: 'run.finished',
      result,
    });

    this.completion.resolve(result);

    return true;
  }

  private abort(reason: unknown): void {
    if (this.stateData.settled || this.signal.aborted) {
      return;
    }

    this.controller.abort(reason);
  }
}

export class AgentRunManager {
  private readonly state: RunManagerState = {
    activeRun: undefined,
  };

  get activeRun(): AgentRunController | undefined {
    return this.state.activeRun;
  }

  createRun(
    id: string,
    signal?: AbortSignal,
    onEvent?: AgentEventListener,
  ): AgentRunController {
    if (this.state.activeRun !== undefined) {
      throw new Error('An agent run is already active.');
    }

    const run = new AgentRunController(
      id,
      signal,
      () => {
        if (this.state.activeRun === run) {
          this.state.activeRun = undefined;
        }
      },
      onEvent,
    );

    this.state.activeRun = run;

    return run;
  }
}
