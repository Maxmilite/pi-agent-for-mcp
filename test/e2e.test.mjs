import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * End to end: a real relay process, the real extension, an MCP client on the far
 * side, and files on disk that either change or do not.
 *
 * The only fake is pi itself — a stub that records what was registered and plays
 * back a turn. Everything between the HTTP call and the filesystem is real.
 */

const PORT = 18991;
const TOKEN = 'test-agent-token-0123456789';
const ROOT = path.resolve(import.meta.dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10_000, interval = 50 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep waiting
    }
    if (Date.now() - started > timeout) throw new Error('timed out waiting');
    await sleep(interval);
  }
}

async function mcp(name, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const json = body.startsWith('event:') || body.startsWith('data:')
    ? JSON.parse(body.split('\n').find((l) => l.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return json.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(json.error) }] };
}

const textOf = (result) => (result.content ?? []).map((b) => b.text ?? '').join('\n');

/** A stand-in for the pi runtime: records registrations, plays back a canned turn. */
function fakePi({ reply = 'the answer is 42', delayMs = 0, toolCalls = [] } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];

  const emit = async (event, payload) => {
    for (const fn of [...(handlers.get(event) ?? [])]) await fn(payload, ctx);
  };

  const ctx = {
    hasUI: true,
    model: { provider: 'fake', id: 'fake-model' },
    isIdle: () => true,
    abort: () => {},
    ui: {
      notes: [],
      confirms: [],
      confirmAnswer: true,
      notify(message) {
        this.notes.push(message);
      },
      async confirm(title, detail) {
        this.confirms.push({ title, detail });
        return this.confirmAnswer;
      },
      setStatus() {},
    },
  };

  const pi = {
    sent,
    ctx,
    commands,
    handlers,
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
      if (!options?.triggerTurn) return;
      setTimeout(async () => {
        for (const call of toolCalls) await emit('tool_call', call);
        await emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
        await emit('agent_settled', { aborted: false });
      }, delayMs);
    },
  };
  return pi;
}

test('pi-bridge end to end: connect, work, gate, disconnect', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'pi-bridge-state-'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'pi-bridge-work-'));
  await writeFile(path.join(workDir, 'notes.txt'), 'alpha\nbeta\ngamma\n');

  const relay = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      STATE_DIR: stateDir,
      MCP_ALLOW_NO_AUTH: '1',
      AGENT_TOKEN: TOKEN,
      POLL_HOLD_SEC: '5',
      AGENT_TTL_SEC: '12',
    },
  });
  let relayLog = '';
  relay.stderr.on('data', (b) => {
    relayLog += b;
  });

  process.env.PI_BRIDGE_URL = `http://127.0.0.1:${PORT}`;
  process.env.PI_BRIDGE_TOKEN = TOKEN;

  const { default: extension } = await import('../extension/index.ts');

  t.after(async () => {
    relay.kill('SIGKILL');
    await rm(stateDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok), { timeout: 15_000 }).catch(() => {
    throw new Error(`relay did not start:\n${relayLog}`);
  });

  // Nothing connected yet: the model must get advice it can pass on, not a timeout.
  const cold = await mcp('pi_status', {});
  assert.match(textOf(cold), /No local pi is connected/);

  const pi = fakePi();
  extension(pi);
  assert.ok(pi.commands.has('connect'), '/connect is registered');
  assert.ok(pi.commands.has('disconnect'), '/disconnect is registered');

  await pi.commands.get('connect').handler(`laptop --cwd ${workDir}`, pi.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 1));
  assert.match(pi.ctx.ui.notes.join('\n'), /Connected as "laptop"/);

  // -- a direct write reaches the disk --------------------------------------
  const written = await mcp('pi_write', { path: 'sub/dir/new.txt', content: 'hello from chatgpt' });
  assert.equal(textOf(written).startsWith('wrote sub/dir/new.txt'), true, textOf(written));
  assert.equal(await readFile(path.join(workDir, 'sub/dir/new.txt'), 'utf8'), 'hello from chatgpt');

  assert.equal(pi.ctx.ui.confirms.at(-1).title.includes('write'), true, 'the write asked first');
  assert.match(pi.ctx.ui.confirms.at(-1).detail, /sub\/dir\/new\.txt/);

  // -- a read comes back numbered, and reading is never gated ----------------
  const confirmsBeforeRead = pi.ctx.ui.confirms.length;
  const read = await mcp('pi_read', { path: 'notes.txt', offset: 2, limit: 2 });
  assert.match(textOf(read), /^\s+2\s+beta\n\s+3\s+gamma/m, textOf(read));
  assert.equal(pi.ctx.ui.confirms.length, confirmsBeforeRead, 'reads do not interrupt the user');

  // -- an edit is exact ------------------------------------------------------
  const edited = await mcp('pi_edit', { path: 'notes.txt', oldText: 'beta', newText: 'BETA' });
  assert.match(textOf(edited), /1 replacement/);
  assert.equal(await readFile(path.join(workDir, 'notes.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');

  // -- an ambiguous edit refuses rather than guessing -------------------------
  const ambiguous = await mcp('pi_edit', { path: 'notes.txt', oldText: 'a', newText: 'A' });
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /matches \d+ times/);
  assert.equal(await readFile(path.join(workDir, 'notes.txt'), 'utf8'), 'alpha\nBETA\ngamma\n', 'nothing was written');

  // -- a shell command runs in the root --------------------------------------
  const exec = await mcp('pi_exec', { command: 'pwd && ls' });
  assert.match(textOf(exec), new RegExp(workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(textOf(exec), /notes\.txt/);

  // -- pi_ask delegates a turn and returns the agent's last words -------------
  const asked = await mcp('pi_ask', { prompt: 'what is the answer?' });
  assert.match(textOf(asked), /the answer is 42/);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, 'pi-bridge');
  assert.match(pi.sent[0].message.content, /shares no context|cannot see this one/);

  // -- the root fence holds ---------------------------------------------------
  const escaped = await mcp('pi_read', { path: '../../etc/hostname' });
  assert.equal(escaped.isError, true);
  assert.match(textOf(escaped), /outside/);

  // -- a second agent makes the choice mandatory ------------------------------
  const second = fakePi();
  extension(second);
  await second.commands.get('connect').handler(`desktop --auto --cwd ${workDir}`, second.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 2));

  const ambiguousAgent = await mcp('pi_read', { path: 'notes.txt' });
  assert.equal(ambiguousAgent.isError, true);
  assert.match(textOf(ambiguousAgent), /2 agents are connected.*Pass agent/s);

  const targeted = await mcp('pi_read', { path: 'notes.txt', agent: 'laptop' });
  assert.match(textOf(targeted), /BETA/);

  await second.commands.get('disconnect').handler('', second.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 1));

  // -- confirmation gate: a denied write must not touch the file --------------
  pi.ctx.ui.confirmAnswer = false;
  const denied = await mcp('pi_write', { path: 'notes.txt', content: 'clobbered' });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /denied/);
  assert.equal(await readFile(path.join(workDir, 'notes.txt'), 'utf8'), 'alpha\nBETA\ngamma\n', 'the denied write changed nothing');
  pi.ctx.ui.confirmAnswer = true;

  // -- auto mode really does stop asking -------------------------------------
  await pi.commands.get('disconnect').handler('', pi.ctx);
  await pi.commands.get('connect').handler(`laptop --auto --cwd ${workDir}`, pi.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 1));
  const confirmsBeforeAuto = pi.ctx.ui.confirms.length;
  const autoWrite = await mcp('pi_write', { path: 'auto.txt', content: 'unattended' });
  assert.match(textOf(autoWrite), /wrote auto\.txt/);
  assert.equal(pi.ctx.ui.confirms.length, confirmsBeforeAuto, 'auto mode runs without a prompt');

  // -- the tool_call gate covers the agent's own hands ------------------------
  const gated = fakePi({ toolCalls: [{ toolName: 'bash', input: { command: 'rm -rf build' }, toolCallId: 't1' }] });
  extension(gated);
  gated.ctx.ui.confirmAnswer = false;
  await pi.commands.get('disconnect').handler('', pi.ctx);
  await gated.commands.get('connect').handler(`gated --cwd ${workDir}`, gated.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 1));

  await mcp('pi_ask', { prompt: 'clean the build directory' });
  assert.equal(gated.ctx.ui.confirms.length, 1, 'the remote turn asked before running bash');
  assert.match(gated.ctx.ui.confirms[0].detail, /rm -rf build/);
  assert.match(gated.ctx.ui.confirms[0].title, /ChatGPT/);

  await gated.commands.get('disconnect').handler('', gated.ctx);
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).then((h) => h.agents === 0));

  const gone = await mcp('pi_status', {});
  assert.match(textOf(gone), /No local pi is connected/);
});
