import type { WorkspaceContext } from './provider.js';
import type { InstructionTarget } from './types.js';

const MAX_RELEVANT_TARGETS = 8;

export function createContextRelevanceTracker(
  context: WorkspaceContext,
): (target: InstructionTarget) => void {
  let active: readonly InstructionTarget[] = [];

  return (target) => {
    const updated = [
      ...active.filter(
        (item) => item.path !== target.path || item.kind !== target.kind,
      ),
      target,
    ].slice(-MAX_RELEVANT_TARGETS);

    context.setRelevantTargets(updated);
    active = updated;
  };
}
