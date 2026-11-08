import type {
  AgentEvent,
  AgentEventListener,
  AgentEventPayload,
} from './types.js';

interface PublisherState {
  sequence: number;
  closed: boolean;
  readonly listeners: Set<AgentEventListener>;
}

export class AgentEventPublisher {
  private readonly runId: string;

  private readonly state: PublisherState = {
    sequence: 0,
    closed: false,
    listeners: new Set<AgentEventListener>(),
  };

  constructor(runId: string, initialListener?: AgentEventListener) {
    this.runId = runId;

    if (initialListener !== undefined) {
      this.state.listeners.add(initialListener);
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    if (this.state.closed) {
      return () => {};
    }

    this.state.listeners.add(listener);

    return () => {
      this.state.listeners.delete(listener);
    };
  }

  publish(payload: AgentEventPayload): void {
    if (this.state.closed) {
      return;
    }

    const event: AgentEvent = Object.freeze({
      ...payload,
      runId: this.runId,
      sequence: ++this.state.sequence,
      timestamp: Date.now(),
    });

    if (event.type === 'run.finished') {
      this.state.closed = true;
    }

    for (const listener of this.state.listeners) {
      try {
        const observation = listener(event);

        if (observation !== undefined) {
          void Promise.resolve(observation).catch(() => {});
        }
      } catch {
        // Observers must not affect execution or its terminal outcome.
      }
    }

    if (this.state.closed) {
      this.state.listeners.clear();
    }
  }
}
