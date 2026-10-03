import { readState } from '../../operations/storage.mjs';
import { createClaudeCloudEnvironment, openCloudSession } from './claude-cloud.mjs';

/**
 * Where a worker runs. Every environment declares
 * { id, kind, label, capabilities: { stream, steer, interrupt, followUp, result }, health() }.
 * Local and SSH kinds spawn agent processes; cloud kinds add submit / poll / collect / cancel /
 * cleanup and an openSession() that gives orchestration the usual session handle.
 *
 * Minimal registry; the full one (local and SSH kinds, owner settings, placement) replaces it.
 */
export const LOCAL = Object.freeze({
  id: 'local',
  kind: 'local',
  label: 'This PC',
  remote: false,
  capabilities: Object.freeze({ stream: true, steer: true, interrupt: true, followUp: true, result: 'local-worktree' }),
  async health() {
    return { ok: true, checks: [] };
  },
});

/** Cloud kinds by name: a factory from the owner's stored configuration to an adapter. */
export const CLOUD_KINDS = Object.freeze({
  'claude-cloud': ({ config, projectRoot, ...rest }) => {
    const adapter = createClaudeCloudEnvironment({ config, projectRoot, ...rest });
    adapter.openSession = options => openCloudSession({ adapter, ...options });
    return adapter;
  },
});

export class EnvironmentRegistry {
  constructor(entries = []) {
    this.entries = new Map([[LOCAL.id, LOCAL]]);
    for (const entry of entries) this.register(entry);
  }
  register(entry) {
    if (!entry?.id || !entry.kind || !entry.capabilities || typeof entry.health !== 'function')
      throw new Error('An environment needs id, kind, capabilities and health().');
    this.entries.set(entry.id, entry);
    return entry;
  }
  get(id) {
    return this.entries.get(id) ?? null;
  }
  list() {
    return [...this.entries.values()].map(({ id, kind, label, capabilities, remote }) => ({
      id,
      kind,
      label,
      capabilities,
      remote: Boolean(remote),
    }));
  }
}

/**
 * The registry from the owner's environment settings, kept in the service's state directory
 * (never the agent-writable checkout): { environments: { "<id>": { kind, ...config } } }.
 */
export async function defaultEnvironmentRegistry(context) {
  const settings = await readState(context, 'environments', {});
  return createEnvironmentRegistry({ settings, projectRoot: context.governanceRoot });
}

/** Builds the registry from owner settings: { environments: { "<id>": { kind, ...config } } }. */
export function createEnvironmentRegistry({ settings = {}, projectRoot, factories = CLOUD_KINDS, ...rest } = {}) {
  const registry = new EnvironmentRegistry();
  for (const [id, entry] of Object.entries(settings.environments ?? {})) {
    const factory = factories[entry?.kind];
    if (!factory) continue;
    const adapter = factory({ config: entry, projectRoot, ...rest });
    registry.register(Object.assign(adapter, { id }));
  }
  return registry;
}
