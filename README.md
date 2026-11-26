# pi-bridge

Let a remote MCP client — ChatGPT, in practice — drive a pi coding agent running
on your own machine.

```
      your laptop                        VPS                          cloud
┌──────────────────────┐      ┌───────────────────────┐      ┌────────────┐
│ pi (a normal session)│      │ pi-bridge relay       │      │  ChatGPT   │
│                      │      │                       │      │   web      │
│ /connect ────────────┼─────►│ /agent  held GET      │      │            │
│                      │◄─────┤ queue + task table    │◄─────┤ connector  │
│ extension: poll loop │ out  │                       │ HTTPS│            │
│ tool calls ⬄ gate    │ only │ /mcp   OAuth 2.1 ─────┼─────►│            │
└──────────────────────┘      └───────────────────────┘      └────────────┘
```

You are discussing something in ChatGPT and want it to look at the repository on
your laptop. Run `/connect` in pi; ChatGPT gets tools. Run `/disconnect`; it has
nothing.

Nothing listens on the laptop. The connection is outbound-only, so the machine
stays invisible, the laptop lid is a sufficient kill switch, and no port
forwarding is involved.

## Tools, and why they are ranked

`pi_ask` and `pi_task` are the intended path. They hand a whole task to the local
agent, which owns a shell, the files and its own toolchain, and can run several
commands, read what failed and adapt. A request like *"the test suite is failing,
work out why"* finishes in one call instead of fifteen.

| tool | purpose |
|---|---|
| `pi_ask` | **preferred.** Hand a task to the local agent; get a finished answer |
| `pi_task` | collect an `pi_ask`/`pi_exec` that outlived its wait window; `abort` stops it |
| `pi_status` | pwd, model, **context tokens used**, busy state, session file |
| `pi_compact` | summarise the session's context — `/compress` on the far side |
| `pi_tree` | list the current branch, or roll the session back to an entry |
| `pi_exec` | *not recommended* — one deterministic command, when you need exact output |
| `pi_read` | *not recommended* — verbatim text with line numbers, for exact bytes |
| `pi_write` | *not recommended* — whole-file replace, when you already hold the text |
| `pi_edit` | *not recommended* — exact-snippet replace, to fix something `pi_ask` nearly got right |

`pi_compact` and `pi_tree` exist because a session that is driven remotely fills
up and goes wrong in ways a chat window cannot see. `pi_status` reports the
context window so a nearly-full session is visible before it fails, `pi_compact`
compacts it on demand, and `pi_tree` rolls back to an entry id — with
`summarize: false` by default, since the point of rolling back is a smaller
context.

One asymmetry is worth knowing: rolling back to a **user** message removes that
message too (so it can be re-sent differently), while rolling back to an
**assistant** message keeps it. The reply says which happened and what the
context now ends with.

The last four exist because a summary is sometimes not good enough: you cannot
quote a line number out of a summary, and re-asking for the whole task because
one line was wrong is wasteful. Their descriptions say "prefer `pi_ask`" out
loud, because a model that reaches for `pi_exec` reflexively turns every task
into shell-quoting practice and loses the ability to recover from a mistake.

## Multiple machines

`/connect laptop` and `/connect desktop` register two agents. Every tool takes an
optional `agent`.

- one connected — `agent` may be omitted
- more than one — `agent` is **required**, and omitting it is an error that lists
  the choices

That last rule is the important one. A silent default would eventually send a
write to the wrong machine, and the error is self-correcting: the model reads the
list and retries with a name.

Agents hold a lease, refreshed by every poll. Close the laptop and the name frees
itself in 40 seconds; there is no stale-connection cleanup to forget.

## Transport: a held GET, not a socket

The agent issues an ordinary `GET /agent/poll`. The relay holds it open until
there is work (returning it immediately) or for 25 seconds (returning empty), and
the agent asks again. An idle session costs 2.4 requests a minute and still
receives work the instant it exists.

No WebSocket, no SSE, no reconnection state machine — a dropped connection is
just the next GET failing and retrying. `POLL_HOLD_SEC=0` degrades it to plain
short polling without touching any other code.

While a task runs the agent keeps polling with `busy=1`: the lease stays alive
and an abort can still arrive, but no new work is accepted. An MCP call is only
ever *sent* to an agent that is currently asking for work, which removes the
entire class of "message lost while the laptop slept".

## Security

Three layers, because the real risk here is not a leaked URL — it is ChatGPT
reading a web page, being told to run something, and having a shell.

1. **Confirmation gate (default).** Every remote-triggered `bash`, `write` or
   `edit` is shown in the terminal with its exact text and must be approved.
   `/connect --auto` turns this off for a session you have decided to trust.
   For `pi_ask` the gate is implemented on `tool_call`, so it also covers the
   commands the local agent decides to run on its own — one hook, both paths.
2. **Directory fence.** `--cwd` sets the root. Paths are checked against the real
   path of the nearest existing ancestor, so a symlink cannot walk out.
3. **Separate tokens.** MCP clients authenticate through OAuth 2.1 (Feishu as the
   identity provider, locked to one `open_id`). The agent presents a static
   bearer token, because a laptop reconnecting every few seconds must not
   involve a browser. That token buys the ability to *receive* work, not to call
   tools.

## Setup

Relay (on the VPS):

```
/opt/pi-bridge          # this repository
/etc/pi-bridge/pi-bridge.env   # 0600
  PUBLIC_URL=https://pi.example.com
  FEISHU_APP_ID=…  FEISHU_APP_SECRET=…  ALLOWED_OPEN_ID=ou_…
  AGENT_TOKEN=<40 random characters>
systemctl enable --now pi-bridge
```

Add `https://pi.example.com/callback` to the Feishu app's redirect whitelist.

Agent (on the laptop):

```
~/.pi/agent/pi-bridge.json     # 0600
{ "url": "https://pi.example.com", "token": "<AGENT_TOKEN>", "agent": "laptop" }
```

and load `extension/index.ts` — either list it in `~/.pi/agent/settings.json`
under `extensions`, or copy it to `~/.pi/agent/extensions/`.

Then, in pi:

```
/connect laptop                 # confirm every bash/write/edit
/connect laptop --auto          # no prompts
/connect laptop --cwd ~/work    # confine to a directory
/connect laptop --force         # take over a name left behind by a crash
/disconnect
```

## Tests

```
npm test     # 11 tests, no network
```

`test/e2e.test.mjs` is the honest one: it starts a real relay process, loads the
real extension, and talks to it as an MCP client would. It asserts that a write
lands on disk, that an ambiguous edit writes nothing, that a path escaping the
root is refused, that a denied confirmation leaves the file untouched, that the
`tool_call` gate fires for the agent's own commands, and that `/disconnect`
really does make the tools fail.
