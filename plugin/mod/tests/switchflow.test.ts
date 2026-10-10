// Run with `claude plugin test <plugin folder>`: the mod on the desktop surface over a mocked service.
import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';

const BASE = 'http://127.0.0.1:4100';
const PROJECT = `${BASE}/api/projects/p1`;
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const;
const PANE = {
  component: 'Pane',
  requestId: 'switchflow',
  props: {
    title: 'Switchflow',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const;

type Post = { url: string; method: string; token: string | undefined; body: any };
type World = {
  cwd: string;
  hasInfo: boolean;
  isDown: boolean;
  state: any;
  agents: any;
  events: any[];
  posts: Post[];
  toasts: string[];
  statuses: (string | undefined)[];
  commands: string[];
  root: string;
  env: Record<string, string>;
  infoPath: string;
};

const agents = (sessions: any[] = [], extra: any = {}) => ({
  settings: { pauseLocalWorkers: false, revision: 7 },
  environments: [
    { id: 'local', kind: 'local', label: 'This PC' },
    { id: 'box', kind: 'ssh', label: 'WSL box' },
  ],
  capacity: { memory: { freeGB: 12, totalGB: 32 }, workers: { admitted: 2, queued: 1, maxWorkers: 4 } },
  sessions,
  ...extra,
});
const worker = (id: string, fields: any = {}) => ({
  id,
  kind: 'deliver',
  task: `T-${id}`,
  status: 'working',
  environment: 'local',
  provider: 'claude',
  ...fields,
});
const initiative = (fields: any) => ({ id: 'i1', title: 'Login', revision: 3, questions: [], ...fields });

/** Answers every call the mod makes beneath it: env, files, HTTP, the clock and the UI it raises. */
function world(on: On, seed: Partial<World> = {}) {
  const w: World = {
    cwd: '/work/app',
    hasInfo: true,
    isDown: false,
    state: { initiatives: [], activeRun: null },
    agents: agents(),
    events: [],
    posts: [],
    toasts: [],
    statuses: [],
    commands: [],
    root: '/work/app',
    env: { SWITCHFLOW_HOME: '/sf' },
    infoPath: '/sf/control-service/service-info.json',
    ...seed,
  };
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, w.env);
  on('session.cwd', () => ({ value: w.cwd }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => {
    w.commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on('ui.status', ($, e) => {
    w.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.log', () => ({ value: undefined }));
  on('fs.read', ($, e) => {
    // The engine resolves paths for its own platform: a Windows path arrives prefixed on Linux, and
    // a POSIX one arrives as C:\... on Windows.
    const slashes = (value: string) => value.replace(/\\/g, '/');
    if (w.hasInfo && slashes(e.path).endsWith(slashes(w.infoPath))) return { value: JSON.stringify({ url: BASE }) };
    throw new Error(`ENOENT: ${e.path}`);
  });
  on('http.fetch', ($, e) => {
    if (w.isDown) throw new Error('connect ECONNREFUSED 127.0.0.1:4100');
    const method = e.init?.method ?? 'GET';
    const reply = (data: unknown, status = 200) => ({
      value: { status, ok: status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(data) },
    });
    if (method !== 'GET') {
      w.posts.push({
        url: e.url,
        method,
        token: e.init?.headers?.['X-Switchflow-Token'],
        body: JSON.parse(e.init?.body ?? '{}'),
      });
      if (e.url.endsWith('/test')) return reply({ ok: false, reason: 'ssh: connection refused', checkedAt: 'now' });
      if (e.url.endsWith('/steer')) return reply({ ok: true, mode: 'steer' }, 202);
      return reply({ ok: true });
    }
    if (e.url === `${BASE}/api/projects`)
      return reply({ csrfToken: 'tok', projects: [{ id: 'p1', name: 'App', root: w.root, available: true }] });
    if (e.url === `${PROJECT}/state`) return reply(w.state);
    if (e.url === `${PROJECT}/agents`) return reply(w.agents);
    if (e.url.startsWith(`${PROJECT}/agents/`) && e.url.includes('/events?after=')) {
      const after = Number(e.url.split('after=')[1]);
      const page = w.events.filter(event => event.seq > after);
      return reply({ events: page, nextAfter: page.at(-1)?.seq ?? after });
    }
    return reply({ error: 'Not found.' }, 404);
  });
  return { w, clock };
}

async function start($: Engine, clock: { settle: () => Promise<void> }) {
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true });
  await clock.settle();
}

describe('status entry', () => {
  test('says the service is not running when it was never started', async ($, on) => {
    const { w, clock } = world(on, { hasInfo: false });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ service not running');
  });

  test('says the service is not running when it does not answer', async ($, on) => {
    const { w, clock } = world(on, { isDown: true });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ service not running');
  });

  test('says the folder is not a registered project', async ($, on) => {
    const { w, clock } = world(on, { cwd: '/elsewhere' });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ project not registered');
  });

  test('names the stage, live workers and what needs the owner', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [initiative({ stage: 'delivery', status: 'running' })],
        activeRun: { id: 'r1', initiativeId: 'i1', stage: 'delivery', status: 'running' },
      },
      agents: agents([
        worker('w1'),
        worker('w2', { kind: 'review', environment: 'box' }),
        worker('w3', { status: 'idle', approval: 'awaiting-confirmation', environment: 'box' }),
        worker('w4', { status: 'completed' }),
      ]),
    });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ Delivery · 3 workers · 1 needs you');
  });

  test('finds the service under %LOCALAPPDATA% and matches a Windows project from a subfolder', async ($, on) => {
    const { w, clock } = world(on, {
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' },
      infoPath: 'C:\\Users\\me\\AppData\\Local\\Switchflow\\control-service\\service-info.json',
      root: 'C:\\Work\\App',
      cwd: 'c:/work/app/src',
      state: { initiatives: [initiative({ stage: 'planning', status: 'running' })], activeRun: null },
    });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ Planning');
  });

  test('does not match a sibling folder that shares a prefix', async ($, on) => {
    const { w, clock } = world(on, { cwd: '/work/app-old' });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ project not registered');
  });

  test('is idle with nothing open', async ($, on) => {
    const { w, clock } = world(on);
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ Idle');
  });
});

describe('approval band', () => {
  test('draws nothing when nothing needs the owner', async ($, on) => {
    const { clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'delivery', status: 'running' })], activeRun: null },
    });
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }));
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect(await ui.find({ type: 'Button' })).toBeUndefined();
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined();
  });

  test('approves the scope with the record revision and the board token', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'intake', status: 'awaiting-human', scope: 'Login page' })] },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect(await ui.find({ type: 'Text', text: 'Login: Scope ready for your approval' })).toBeDefined();
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([
      'i1:approve-scope',
      'i1:request-changes',
    ]);
    await ui.press({ key: 'i1:approve-scope' });
    expect(w.posts).toEqual([
      {
        url: `${PROJECT}/initiatives/i1/actions`,
        method: 'POST',
        token: 'tok',
        body: { action: 'approve-scope', expectedRevision: 3 },
      },
    ]);
  });

  test('requests changes to a scope with the typed message', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'intake', status: 'awaiting-human', scope: 'Login page' })] },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'i1:request-changes' });
    expect(w.posts).toHaveLength(0);
    await ui.input({ key: 'band-input', text: 'Add password reset' });
    expect(w.posts[0]?.body).toEqual({ action: 'request-changes', expectedRevision: 3, message: 'Add password reset' });
  });

  test('approves a plan', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'planning', status: 'awaiting-human', plan: [{ id: 'T1' }] })] },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect(await ui.find({ type: 'Text', text: /Plan ready.*Approving starts delivery/ })).toBeDefined();
    await ui.press({ key: 'i1:approve-plan' });
    expect(w.posts[0]?.body).toEqual({ action: 'approve-plan', expectedRevision: 3 });
  });

  test('accepts UAT only after the owner confirms every check passed', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [
          initiative({ stage: 'uat', status: 'awaiting-human', uat: [{ id: 'c1', title: 'Sign in' }, 'Sign out'] }),
        ],
      },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'i1:accept-uat' });
    expect(w.posts).toHaveLength(0);
    expect(await ui.find({ type: 'Text', text: 'I tried all 2 checks and they passed.' })).toBeDefined();
    await ui.press({ key: 'band-confirm' });
    expect(w.posts[0]?.body).toEqual({
      action: 'accept-uat',
      expectedRevision: 3,
      results: [
        { id: 'c1', status: 'passed', notes: '' },
        { id: 'uat-2', status: 'passed', notes: '' },
      ],
    });
  });

  test('requests UAT rework with feedback', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'uat', status: 'awaiting-human', uat: ['Sign in'] })] },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'i1:request-rework' });
    await ui.input({ key: 'band-input', text: 'The button is hidden' });
    expect(w.posts[0]?.body).toEqual({
      action: 'request-rework',
      expectedRevision: 3,
      feedback: 'The button is hidden',
    });
  });

  test('tests the environments again when delivery is held', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [
          initiative({
            stage: 'delivery',
            status: 'blocked',
            environmentHold: { environments: [{ id: 'box', label: 'WSL box', reason: 'Host unreachable.' }] },
          }),
        ],
      },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect((await ui.find({ key: 'i1:retry' }))?.text).toBe('Test again');
    await ui.press({ key: 'i1:retry' });
    expect(w.posts[0]?.body).toEqual({ action: 'retry', expectedRevision: 3 });
  });

  test('stops running held processes before the hold can be released', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [initiative({ stage: 'delivery', status: 'running' })],
        activeRun: {
          id: 'r1',
          initiativeId: 'i1',
          status: 'interrupted',
          held: [{ kind: 'stage', role: 'delivery', state: 'running', pid: 42 }],
        },
      },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect(await ui.find({ key: 'i1:recover-run' })).toBeUndefined();
    await ui.press({ key: 'i1:stop-processes' });
    expect(w.posts[0]?.body).toEqual({ action: 'stop-processes', expectedRevision: 3 });
  });

  test('releases the recovery hold with the browser confirmation', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [initiative({ stage: 'delivery', status: 'running' })],
        activeRun: {
          id: 'r1',
          initiativeId: 'i1',
          status: 'interrupted',
          held: [{ kind: 'stage', role: 'delivery', state: 'unknown', pid: null }],
        },
      },
    });
    await start($, clock);
    expect(w.statuses.at(-1)).toContain('run held');
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'i1:recover-run' });
    expect(
      await ui.find({ type: 'Text', text: 'I have checked that the unconfirmed processes have stopped.' }),
    ).toBeDefined();
    await ui.press({ key: 'band-confirm' });
    expect(w.posts[0]?.body).toEqual({ action: 'recover-run', expectedRevision: 3, confirmedStopped: true });
  });

  test('cancels a confirmation without posting', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [initiative({ stage: 'delivery', status: 'running' })],
        activeRun: { id: 'r1', initiativeId: 'i1', status: 'interrupted', held: [{ kind: 'stage', state: 'unknown' }] },
      },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'i1:recover-run' });
    await ui.press({ key: 'band-cancel' });
    expect(w.posts).toHaveLength(0);
    expect(await ui.find({ key: 'i1:recover-run' })).toBeDefined();
  });

  test('resumes held workers', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [
          initiative({
            stage: 'delivery',
            status: 'failed',
            heldWorkers: {
              workers: [
                { task: 'T1', kind: 'deliver' },
                { task: 'T2', kind: 'review' },
              ],
            },
          }),
        ],
      },
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    expect((await ui.find({ key: 'i1:resume-workers' }))?.text).toBe('Resume 2 held workers');
    await ui.press({ key: 'i1:resume-workers' });
    expect(w.posts[0]?.body).toEqual({ action: 'resume-workers', expectedRevision: 3 });
  });

  test('confirms a worker approach through steer with confirm: true', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'delivery', status: 'running' })] },
      agents: agents([worker('w3', { status: 'idle', approval: 'awaiting-confirmation' })]),
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...BAND });
    await ui.press({ key: 'w3:confirm' });
    expect(w.posts[0]).toEqual({
      url: `${PROJECT}/agents/w3/steer`,
      method: 'POST',
      token: 'tok',
      body: { message: 'Approach confirmed. Go ahead.', confirm: true },
    });
  });
});

describe('command', () => {
  test('falls back to /switchflow-board where the engine refuses the colon', async ($, on) => {
    const { w, clock } = world(on);
    await start($, clock);
    // Claude Code 2.1.296 refuses `switchflow:board` itself, before any hook beneath sees it.
    expect(w.commands).toEqual(['switchflow-board']);
    expect((await $.command.run({ command: 'switchflow-board', args: '' } as any)).text).toBe(
      'Switchflow board opened.',
    );
  });
});

describe('board pane', () => {
  const busy = () => ({
    state: {
      initiatives: [initiative({ stage: 'delivery', status: 'running' })],
      activeRun: { id: 'r1', initiativeId: 'i1', stage: 'delivery', status: 'running' },
    },
    agents: agents([
      worker('w1'),
      worker('w2', { kind: 'review', environment: 'box' }),
      worker('w5', { environment: 'box', status: 'failed' }),
    ]),
  });

  test('opens from /switchflow:board and lists workers by environment', async ($, on) => {
    const { clock } = world(on, busy());
    await start($, clock);
    expect((await $.command.run({ command: 'switchflow:board', args: '' } as any)).text).toBe(
      'Switchflow board opened.',
    );
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    const texts = (await ui.findAll({ type: 'Text' })).map(node => node.text);
    expect(texts).toContain('Intake ✓ › Planning ✓ › [Delivery] › UAT › Complete');
    const order = (await ui.findAll({}))
      .map(node => node.key ?? node.text)
      .filter(key => ['This PC', 'WSL box', 'worker:w1', 'worker:w2', 'worker:w5'].includes(key as string));
    expect(order).toEqual(['This PC', 'worker:w1', 'WSL box', 'worker:w2', 'worker:w5']);
    expect((await ui.find({ key: 'worker:w5' }))?.text).toContain('failed');
    expect(
      await ui.find({ type: 'Text', text: '2 running · 1 queued · at most 4 · 12.0 GB free of 32.0 GB' }),
    ).toBeDefined();
  });

  test('shows held workers', async ($, on) => {
    const seed = busy();
    seed.state.initiatives[0].heldWorkers = { workers: [{ task: 'T-w1', kind: 'deliver' }] };
    const { clock } = world(on, seed);
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    expect((await ui.find({ key: 'worker:w1' }))?.text).toContain('held');
    expect((await ui.find({ key: 'worker:w2' }))?.text).not.toContain('held');
  });

  test('steers the selected worker from the Input and shows its feed', async ($, on) => {
    const { w, clock } = world(on, {
      ...busy(),
      events: [
        { seq: 1, kind: 'message', by: 'agent', text: 'Starting on the login form.' },
        { seq: 2, kind: 'command', command: 'npm test' },
      ],
    });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    await ui.press({ key: 'worker:w1' });
    expect((await ui.find({ key: 'feed' }))?.text).toContain('Starting on the login form.');
    expect((await ui.find({ key: 'feed' }))?.text).toContain('$ npm test');
    await ui.input({ key: 'steer', text: 'Use the existing session cookie' });
    expect(w.posts[0]).toEqual({
      url: `${PROJECT}/agents/w1/steer`,
      method: 'POST',
      token: 'tok',
      body: { message: 'Use the existing session cookie', mode: 'steer' },
    });
  });

  test('stops the selected worker after a confirmation', async ($, on) => {
    const { w, clock } = world(on, busy());
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    await ui.press({ key: 'worker:w1' });
    await ui.press({ key: 'stop' });
    expect(w.posts).toHaveLength(0);
    await ui.press({ key: 'stop-confirm' });
    expect(w.posts[0]?.url).toBe(`${PROJECT}/agents/w1/interrupt`);
  });

  test('toggles Pause local workers with the settings revision', async ($, on) => {
    const { w, clock } = world(on, busy());
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    expect((await ui.find({ key: 'pause' }))?.text).toBe('Pause local workers');
    await ui.press({ key: 'pause' });
    expect(w.posts[0]).toMatchObject({
      url: `${PROJECT}/agents/settings`,
      method: 'PUT',
      body: { pauseLocalWorkers: true, expectedRevision: 7 },
    });
  });

  test('tests every environment and reports the unhealthy one', async ($, on) => {
    const { w, clock } = world(on, busy());
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    await ui.press({ key: 'test-all' });
    expect(w.posts.map(post => post.url)).toEqual([
      `${PROJECT}/agents/environments/local/test`,
      `${PROJECT}/agents/environments/box/test`,
    ]);
    expect(await ui.find({ type: 'Text', text: 'not ready: ssh: connection refused' })).toBeDefined();
    expect(w.toasts).toContain('Switchflow: WSL box is not ready. ssh: connection refused');
  });

  test('offers Try again while the service is down', async ($, on) => {
    const { clock } = world(on, { isDown: true });
    await start($, clock);
    const ui = await $.ui.mount({ plugin: 'switchflow', surface: 'desktop', ...PANE });
    expect(await ui.find({ type: 'Text', text: 'SF ▸ service not running' })).toBeDefined();
    expect(await ui.find({ key: 'retry-connect' })).toBeDefined();
  });
});

describe('toasts', () => {
  test('announce finished workers, ready reviews, held runs, unready environments and approaches', async ($, on) => {
    const { w, clock } = world(on, {
      state: {
        initiatives: [initiative({ stage: 'delivery', status: 'running' })],
        activeRun: { id: 'r1', initiativeId: 'i1', stage: 'delivery', status: 'running' },
      },
      agents: agents([worker('w1'), worker('w2', { status: 'working' })]),
    });
    await start($, clock);
    expect(w.toasts).toEqual([]);

    w.agents = agents([
      worker('w1', { status: 'completed' }),
      worker('w2', { status: 'idle', approval: 'awaiting-confirmation' }),
    ]);
    await clock.advance(3000);
    expect(w.toasts).toEqual([
      'Switchflow: Deliver T-w1 finished.',
      'Switchflow: needs you. Deliver T-w2: Approach ready. Confirming lets the worker edit.',
    ]);

    w.toasts.length = 0;
    w.state = {
      initiatives: [
        initiative({
          stage: 'delivery',
          status: 'blocked',
          environmentHold: { environments: [{ id: 'box', label: 'WSL box', reason: 'Host unreachable.' }] },
        }),
        initiative({ id: 'i2', title: 'Search', stage: 'intake', status: 'awaiting-human', scope: 'Search box' }),
      ],
      activeRun: { id: 'r1', initiativeId: 'i1', status: 'interrupted', held: [] },
    };
    await clock.advance(3000);
    expect(w.toasts).toContain('Switchflow: the run is held. Release the recovery hold to continue.');
    expect(w.toasts).toContain('Switchflow: WSL box is not ready. Host unreachable.');
    expect(w.toasts).toContain(
      'Switchflow: review ready. Search: Scope ready for your approval. Approving prepares a plan.',
    );

    w.toasts.length = 0;
    await clock.advance(3000);
    expect(w.toasts).toEqual([]);
  });

  test('say when the service stops responding, and the status follows', async ($, on) => {
    const { w, clock } = world(on, {
      state: { initiatives: [initiative({ stage: 'intake', status: 'idle' })], activeRun: null },
    });
    await start($, clock);
    expect(w.statuses.at(-1)).toBe('SF ▸ Intake');
    w.isDown = true;
    await clock.advance(3000);
    expect(w.toasts).toEqual(['Switchflow: the service stopped responding.']);
    expect(w.statuses.at(-1)).toBe('SF ▸ service not running');
    w.isDown = false;
    await clock.advance(3000);
    expect(w.statuses.at(-1)).toBe('SF ▸ Intake');
  });
});
