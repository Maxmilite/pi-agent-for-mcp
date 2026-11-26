import { randomBytes } from 'node:crypto';

/**
 * The relay's entire state, with no HTTP in sight.
 *
 * Two sides meet here:
 *
 *   1. a pi session, which connects, then repeatedly asks "anything for me?" and
 *      reports what happened (the agent side);
 *   2. an MCP client, which blocks on a tool call until the agent answers, or
 *      walks away with a task id and comes back later (the client side).
 *
 * The whole design rests on one rule: an MCP call is never *sent* to an agent
 * that is not currently asking for work. That removes the entire class of
 * "message lost while the laptop slept" bugs — there is no delivery, only
 * pickup.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export class HubError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}

const id = () => randomBytes(6).toString('hex');

export class Hub {
  constructor({ log = () => {}, ttlMs = 40_000, holdMs = 25_000, taskTtlMs = 3_600_000, now = Date.now } = {}) {
    this.log = log;
    this.ttlMs = ttlMs;
    this.holdMs = holdMs;
    this.taskTtlMs = taskTtlMs;
    this.now = now;
    this.agents = new Map();
    this.calls = new Map();
    this.tasks = new Map();
    this.seq = 0;
  }

  // -- agent side -----------------------------------------------------------

  hello({ name, cwd, model, pid, force = false } = {}) {
    if (!name || !NAME_RE.test(name)) {
      throw new HubError(`agent name must match ${NAME_RE} — got ${JSON.stringify(name)}`);
    }
    this.sweep();
    const existing = this.agents.get(name);
    if (existing && this.isLive(existing) && !force) {
      const since = new Date(existing.connectedAt).toISOString().slice(11, 16);
      throw new HubError(
        `agent "${name}" is already connected (since ${since}Z, cwd ${existing.cwd}). ` +
          `Run /connect ${name} --force to take over.`,
        { status: 409, code: 'name_taken' },
      );
    }
    if (existing) this.drop(name, 'replaced by a new connection');

    const agent = {
      name,
      cwd: cwd ?? '',
      model: model ?? '',
      pid: pid ?? null,
      connectedAt: this.now(),
      lastSeen: this.now(),
      queue: [],
      holders: [],
    };
    this.agents.set(name, agent);
    this.log(`agent "${name}" connected (cwd ${agent.cwd || '?'}, model ${agent.model || '?'})`);
    return { name, cwd: agent.cwd, model: agent.model, connectedAt: agent.connectedAt };
  }

  /**
   * Hand back pending calls, or hold the request open until there are some.
   *
   * `busy` matters: while an agent is running a task it still has to hold the
   * lease and still has to be reachable for an abort, so it keeps polling — but
   * it must not be given new work it cannot start. Only control calls pass.
   */
  poll(name, { busy = false, signal } = {}) {
    this.sweep();
    const agent = this.live(name);
    agent.lastSeen = this.now();

    const deliverable = busy ? (call) => call.kind === 'abort' || call.kind === 'status' : () => true;
    const calls = this.take(agent, deliverable);
    if (calls.length) return Promise.resolve({ calls });

    return new Promise((resolve) => {
      // A second poll for the same agent means the first one's connection died.
      // Release it rather than leaving two waiters racing for the same queue.
      this.release(agent);

      let done = false;
      const finish = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        const at = agent.holders.indexOf(holder);
        if (at >= 0) agent.holders.splice(at, 1);
        resolve(payload);
      };
      const onAbort = () => finish({ calls: [] });
      const timer = setTimeout(() => finish({ calls: [] }), this.holdMs);
      const holder = { deliverable, finish: () => finish({ calls: this.take(agent, deliverable) }) };

      if (signal) {
        if (signal.aborted) return finish({ calls: [] });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      agent.holders.push(holder);
    });
  }

  /** An agent reports the outcome of one call. */
  reply(name, callId, payload = {}) {
    this.sweep();
    const agent = this.agents.get(name);
    if (agent) agent.lastSeen = this.now();

    const call = this.calls.get(callId);
    if (!call) {
      // Late reply after the task already failed, or a duplicated POST. Not an
      // error worth breaking the agent's poll loop over.
      return { ok: true, ignored: true };
    }
    this.calls.delete(callId);

    if (call.taskId) this.settle(call.taskId, payload);
    call.resolve(payload);
    return { ok: true };
  }

  bye(name) {
    this.sweep();
    if (!this.agents.has(name)) return { ok: true, already_gone: true };
    this.drop(name, 'agent disconnected');
    return { ok: true };
  }

  // -- client side ----------------------------------------------------------

  /** Live agents, newest last. */
  list() {
    this.sweep();
    return [...this.agents.values()]
      .filter((a) => this.isLive(a))
      .map((a) => ({
        name: a.name,
        cwd: a.cwd,
        model: a.model,
        connectedAt: a.connectedAt,
        lastSeen: a.lastSeen,
        queued: a.queue.length,
        tasks: [...this.tasks.values()].filter((t) => t.agent === a.name && t.status === 'running').length,
      }));
  }

  /**
   * Turn an optional agent name into exactly one name.
   *
   * With more than one agent connected and no name given this throws instead of
   * guessing. A guess that is wrong sends a write to the wrong machine, and no
   * amount of convenience is worth that. The error lists the choices, so the
   * model can retry correctly without a second round trip.
   */
  pick(name) {
    const live = this.list();
    if (name) {
      const found = live.find((a) => a.name === name);
      if (!found) {
        throw new HubError(
          live.length
            ? `Agent "${name}" is not connected. Connected: ${live.map((a) => a.name).join(', ')}.`
            : `Agent "${name}" is not connected, and no pi session is currently connected.`,
          { status: 409, code: 'agent_not_connected' },
        );
      }
      return found.name;
    }
    if (!live.length) {
      throw new HubError(
        'No local pi is connected. Ask the user to run /connect in a pi session, then retry.',
        { status: 409, code: 'no_agent' },
      );
    }
    if (live.length === 1) return live[0].name;
    throw new HubError(
      `${live.length} agents are connected (${live.map((a) => `${a.name} in ${a.cwd || '?'}`).join('; ')}). ` +
        'Pass agent to choose one.',
      { status: 409, code: 'agent_required' },
    );
  }

  /**
   * Queue one call and return a promise for its outcome.
   *
   * The promise resolves with the agent's reply, or with `{timeout: true}` when
   * the caller's wait window runs out first. It is never rejected for being slow
   * — a slow task is not a failed one, and the reply still lands in the task.
   */
  issue({ agent, kind, args = {}, taskId = null, waitMs = 0 }) {
    const callId = `c_${id()}`;
    const call = { callId, agent, kind, args, taskId, queuedAt: this.now(), resolve: () => {} };
    const done = new Promise((resolve) => {
      call.resolve = resolve;
    });

    const target = this.agents.get(agent);
    if (!target) throw new HubError(`Agent "${agent}" is not connected.`, { status: 409, code: 'agent_not_connected' });
    target.queue.push(call);
    this.calls.set(callId, call);

    // Wake a held poll if this call is one it would accept.
    for (const holder of [...target.holders]) {
      if (holder.deliverable(call)) {
        holder.finish();
        break;
      }
    }

    if (!waitMs) return { callId, done };
    return {
      callId,
      done: Promise.race([
        done,
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), waitMs).unref?.()),
      ]),
    };
  }

  // -- tasks ----------------------------------------------------------------

  createTask({ agent, kind, summary }) {
    const taskId = `${agent}-${(++this.seq).toString(36)}`;
    const task = { id: taskId, agent, kind, summary, status: 'running', startedAt: this.now(), finishedAt: null, result: null, error: null };
    this.tasks.set(taskId, task);
    return task;
  }

  task(taskId) {
    this.sweep();
    const task = this.tasks.get(taskId);
    if (!task) throw new HubError(`Unknown task "${taskId}". Tasks live for ${Math.round(this.taskTtlMs / 60000)} minutes.`, { status: 404, code: 'unknown_task' });
    return { ...task };
  }

  settle(taskId, payload) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.finishedAt = this.now();
    if (payload?.aborted) {
      task.status = 'aborted';
      task.error = payload.error ?? 'aborted';
    } else if (payload?.ok === false) {
      task.status = 'failed';
      task.error = payload.error ?? 'agent reported failure';
    } else {
      task.status = 'done';
      task.result = payload?.result ?? null;
    }
  }

  // -- internals ------------------------------------------------------------

  isLive(agent) {
    return this.now() - agent.lastSeen <= this.ttlMs;
  }

  live(name) {
    const agent = this.agents.get(name);
    if (!agent) throw new HubError(`Agent "${name}" is not connected. Run /connect in pi first.`, { status: 409, code: 'agent_not_connected' });
    if (!this.isLive(agent)) {
      this.drop(name, 'lease expired (no poll within the timeout)');
      throw new HubError(`Agent "${name}" stopped responding and was disconnected. Run /connect again in pi.`, { status: 409, code: 'agent_expired' });
    }
    return agent;
  }

  take(agent, accept) {
    const picked = [];
    agent.queue = agent.queue.filter((call) => {
      if (!accept(call)) return true;
      picked.push({ callId: call.callId, kind: call.kind, args: call.args, taskId: call.taskId });
      return false;
    });
    return picked;
  }

  release(agent) {
    for (const holder of [...agent.holders]) holder.finish();
  }

  /** Fail everything an agent owns, so no caller waits on a machine that left. */
  drop(name, reason) {
    const agent = this.agents.get(name);
    if (!agent) return;
    this.release(agent);
    this.agents.delete(name);

    for (const [callId, call] of this.calls) {
      if (call.agent !== name) continue;
      this.calls.delete(callId);
      if (call.taskId) this.settle(call.taskId, { ok: false, error: reason });
      call.resolve({ ok: false, error: reason });
    }
    this.log(`agent "${name}" dropped: ${reason}`);
  }

  /** Forget dead agents and expired tasks before anyone reads state. */
  sweep() {
    for (const agent of [...this.agents.values()]) {
      if (!this.isLive(agent)) this.drop(agent.name, 'lease expired (no poll within the timeout)');
    }
    for (const [taskId, task] of this.tasks) {
      const ended = task.finishedAt ?? task.startedAt;
      if (this.now() - ended > this.taskTtlMs) this.tasks.delete(taskId);
    }
  }
}
