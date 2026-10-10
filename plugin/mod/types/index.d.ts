// The Switchflow mod's state contract and the shapes its modules share.

/** One button the owner can press where the browser board would show it. */
export type SwitchflowAction = {
  /** Stable key for the drawing: `<initiative or session id>:<action>`. */
  key: string;
  label: string;
  /** `initiative` posts /initiatives/<id>/actions; `steer` posts /agents/<id>/steer. */
  target: 'initiative' | 'steer';
  /** The initiative action (`approve-scope`, `retry`, ...) or `confirm` for a steer. */
  action: string;
  initiativeId?: string;
  sessionId?: string;
  /** Sent as is, merged after `action` and `expectedRevision`. */
  payload?: Record<string, unknown>;
  /** Asks for a typed message first, sent under this payload key. */
  input?: { payloadKey: 'message' | 'feedback'; label: string };
  /** Asks the owner to confirm with this sentence first. */
  confirm?: string;
  primary?: boolean;
};

/** Something only the owner can move on, with the buttons that do it. */
export type SwitchflowNeed = {
  /** `<initiative or session id>:<kind>`, stable while the need stands. */
  key: string;
  kind: 'scope' | 'plan' | 'uat' | 'recovery' | 'held-workers' | 'environment' | 'approach' | 'questions';
  title: string;
  /** One line of context for the band. */
  context: string;
  actions: SwitchflowAction[];
};

export type SwitchflowInitiative = {
  id: string;
  title: string;
  stage: string;
  status: string;
  revision: number | null;
  isRunning: boolean;
};

export type SwitchflowWorker = {
  id: string;
  title: string;
  status: string;
  provider: string;
  kind: string;
  task: string | null;
  environment: string;
  environmentLabel: string;
  initiativeId: string | null;
  isLive: boolean;
  isHeld: boolean;
  awaitingApproach: boolean;
  canSteer: boolean;
  canInterrupt: boolean;
};

export type SwitchflowEnvironment = {
  id: string;
  label: string;
  kind: string;
  /** Not ready according to a delivery hold, with its reason. */
  holdReason: string | null;
};

export type SwitchflowCapacity = {
  running: number;
  queued: number;
  maxWorkers: number | null;
  freeGB: number | null;
  totalGB: number | null;
  isPaused: boolean;
  settingsRevision: number | null;
};

/** What the mod draws from: one poll of the service, normalised. */
export type SwitchflowSnapshot = {
  service: 'up' | 'down' | 'unregistered';
  reason: string | null;
  projectId: string | null;
  projectName: string | null;
  /** The stage the project is in: the active run's, else the newest open initiative's. */
  stage: string | null;
  initiatives: SwitchflowInitiative[];
  runStatus: string | null;
  workers: SwitchflowWorker[];
  environments: SwitchflowEnvironment[];
  capacity: SwitchflowCapacity | null;
  needs: SwitchflowNeed[];
};

export type SwitchflowEnvironmentTest = { ok: boolean | null; reason: string | null; checkedAt: string | null };

export type SwitchflowFeedEvent = { seq: number; kind: string; text: string; by: string | null };

export type SwitchflowFeed = { sessionId: string | null; after: number; events: SwitchflowFeedEvent[] };

/** The band's open form: a message being written, or a confirmation asked. */
export type SwitchflowForm = { actionKey: string; step: 'input' | 'confirm' } | null;

declare module 'claude-code' {
  interface PluginState {
    switchflow: {
      snapshot: SwitchflowSnapshot | null;
      selected: string | null;
      feed: SwitchflowFeed;
      tests: Record<string, SwitchflowEnvironmentTest>;
      form: SwitchflowForm;
      notice: string | null;
    };
  }
}
