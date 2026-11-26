import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HubError } from '../server/hub.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A hub on a hand-cranked clock, with a short hold so tests stay fast. */
const make = (opts = {}) => {
  const clock = { t: 1_000_000 };
  const hub = new Hub({ holdMs: 30, ttlMs: 5_000, now: () => clock.t, ...opts });
  return { hub, clock };
};

test('a name that is already connected is refused, and --force takes over', () => {
  const { hub, clock } = make();
  hub.hello({ name: 'laptop', cwd: '/home/you' });
  assert.throws(() => hub.hello({ name: 'laptop' }), /already connected.*--force/s);

  clock.t += 1;
  hub.hello({ name: 'laptop', cwd: '/elsewhere', force: true });
  assert.equal(hub.list().length, 1);
  assert.equal(hub.list()[0].cwd, '/elsewhere');
});

test('names are constrained, because they end up in task ids and error text', () => {
  const { hub } = make();
  assert.throws(() => hub.hello({ name: '' }), HubError);
  assert.throws(() => hub.hello({ name: 'my laptop' }), /must match/);
  assert.throws(() => hub.hello({ name: 'a/b' }), /must match/);
  hub.hello({ name: 'laptop-2' });
});

test('picking an agent never guesses when two are connected', () => {
  const { hub } = make();
  assert.throws(() => hub.pick(), /No local pi is connected/);

  hub.hello({ name: 'laptop', cwd: '/home/you' });
  assert.equal(hub.pick(), 'laptop', 'one agent is unambiguous');

  hub.hello({ name: 'desktop', cwd: '/home/feiyu' });
  assert.throws(() => hub.pick(), /2 agents are connected.*Pass agent/s);
  assert.equal(hub.pick('desktop'), 'desktop');
  assert.throws(() => hub.pick('nope'), /not connected\. Connected: laptop, desktop/);
});

test('a call waits for a poll, and a held poll is released by a call', async () => {
  const { hub } = make();
  hub.hello({ name: 'laptop' });

  const waiting = hub.poll('laptop');
  const task = hub.createTask({ agent: 'laptop', kind: 'exec', summary: 'ls' });
  const { done } = hub.issue({ agent: 'laptop', kind: 'exec', args: { command: 'ls' }, taskId: task.id });

  const delivered = await waiting;
  assert.equal(delivered.calls.length, 1);
  assert.equal(delivered.calls[0].kind, 'exec');
  assert.equal(delivered.calls[0].args.command, 'ls');

  hub.reply('laptop', delivered.calls[0].callId, { ok: true, result: { stdout: 'a\n' } });
  assert.deepEqual(await done, { ok: true, result: { stdout: 'a\n' } });
  assert.equal(hub.task(task.id).status, 'done');
  assert.deepEqual(hub.task(task.id).result, { stdout: 'a\n' });
});

test('a busy agent still receives aborts but not new work', async () => {
  const { hub } = make();
  hub.hello({ name: 'laptop' });

  const work = hub.issue({ agent: 'laptop', kind: 'exec', args: { command: 'sleep 60' } });
  const holding = hub.poll('laptop', { busy: true });

  const abort = hub.issue({ agent: 'laptop', kind: 'abort', args: { taskId: 'laptop-1' } });
  const delivered = await holding;
  assert.deepEqual(delivered.calls.map((c) => c.kind), ['abort'], 'only the abort is handed over');

  // The work is still queued, not lost.
  hub.reply('laptop', delivered.calls[0].callId, { ok: true, result: { aborted: true } });
  await abort.done;

  const idle = await hub.poll('laptop');
  assert.deepEqual(idle.calls.map((c) => c.kind), ['exec']);
  hub.reply('laptop', idle.calls[0].callId, { ok: true, result: {} });
  await work.done;
});

test('a slow call gives back a timeout, and the task still fills in later', async () => {
  const { hub } = make();
  hub.hello({ name: 'laptop' });
  const task = hub.createTask({ agent: 'laptop', kind: 'ask', summary: 'fix the test' });

  const pending = hub.issue({ agent: 'laptop', kind: 'ask', args: { prompt: 'fix it' }, taskId: task.id, waitMs: 20 });
  const delivered = await hub.poll('laptop');

  assert.deepEqual(await pending.done, { timeout: true });
  assert.equal(hub.task(task.id).status, 'running', 'timing out of the wait is not failure');

  hub.reply('laptop', delivered.calls[0].callId, { ok: true, result: { text: 'done' } });
  assert.equal(hub.task(task.id).status, 'done');
  assert.equal(hub.task(task.id).result.text, 'done');
});

test('an agent that leaves fails every call and task it owned', async () => {
  const { hub } = make();
  hub.hello({ name: 'laptop' });
  const task = hub.createTask({ agent: 'laptop', kind: 'exec', summary: 'build' });
  const pending = hub.issue({ agent: 'laptop', kind: 'exec', args: {}, taskId: task.id });
  await hub.poll('laptop');

  hub.bye('laptop');
  assert.deepEqual(await pending.done, { ok: false, error: 'agent disconnected' });
  assert.equal(hub.task(task.id).status, 'failed');
  assert.equal(hub.list().length, 0);
});

test('a stale lease frees the name without anyone having to say goodbye', () => {
  const { hub, clock } = make();
  hub.hello({ name: 'laptop' });
  assert.equal(hub.list().length, 1);

  clock.t += 5_001; // past ttlMs, e.g. the laptop lid closed
  assert.equal(hub.list().length, 0);
  hub.hello({ name: 'laptop', cwd: '/again' });
  assert.equal(hub.list()[0].cwd, '/again');
});

test('a held poll ends empty rather than hanging forever', async () => {
  const { hub } = make();
  hub.hello({ name: 'laptop' });
  const started = Date.now();
  const result = await hub.poll('laptop');
  assert.deepEqual(result.calls, []);
  assert.ok(Date.now() - started >= 25, 'the hold lasted about as long as holdMs');
});

test('unknown task ids say so instead of returning nothing', () => {
  const { hub } = make();
  assert.throws(() => hub.task('laptop-99'), /Unknown task/);
});
