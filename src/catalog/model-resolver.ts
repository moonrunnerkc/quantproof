/**
 * Candidate resolution: merges the local backend store with the run
 * config's explicit candidate list into one deduplicated candidate
 * set. Explicit candidates are pulled on demand; remote (cloud) models
 * are excluded because nothing about them can be measured locally.
 */

import type { BackendAdapter, ModelDescriptor } from '../backends/backend-adapter.js';
import type { RunConfig } from './run-config.js';

/** The resolved candidate set plus what was excluded and why. */
export interface ResolvedCandidates {
  /** Local, measurable candidates in resolution order. */
  readonly candidates: readonly ModelDescriptor[];
  /** Models left out of the sweep, each with its reason. */
  readonly excluded: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Builds the candidate list for a sweep.
 *
 * Explicit config candidates come first (pulling any that are not in
 * the local store yet); local-store models follow when
 * use_local_models is set. Duplicates collapse onto their first
 * appearance. Remote cloud models are excluded with a reason.
 *
 * @param adapter - Backend used to list and pull models.
 * @param config - The run config.
 * @returns Candidates plus exclusions. Throws only when the backend is
 *   unreachable or an explicit candidate cannot be pulled; that is a
 *   config error the user must fix, not a skippable condition.
 */
export async function resolveCandidates(
  adapter: BackendAdapter,
  config: RunConfig,
): Promise<ResolvedCandidates> {
  const candidates: ModelDescriptor[] = [];
  const excluded: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  const add = (descriptor: ModelDescriptor, origin: string): void => {
    if (seen.has(descriptor.name)) {
      return;
    }
    seen.add(descriptor.name);
    if (descriptor.remote) {
      excluded.push({
        name: descriptor.name,
        reason: `remote (${origin}); cloud models cannot be measured locally`,
      });
      return;
    }
    candidates.push(descriptor);
  };

  for (const name of config.candidates) {
    add(await adapter.ensureModelAvailable(name), 'from run config');
  }
  if (config.useLocalModels) {
    for (const descriptor of await adapter.listModels()) {
      add(descriptor, 'from local store');
    }
  }
  return { candidates, excluded };
}
