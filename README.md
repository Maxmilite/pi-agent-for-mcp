# Pi agent for MCP

Give ChatGPT your laptop's shell — but only while you say so.

You are discussing an idea in ChatGPT, and at some point you want it to look at
the thing that is actually on your machine: the failing test, the config file,
the draft in this repository. This project puts a [pi](https://github.com/earendil-works/pi)
coding agent behind an MCP endpoint, so the model can ask it, and the agent works
in a directory you picked.

Run `/connect` in pi and ChatGPT gets tools. Run `/disconnect` and it has
nothing. Nothing ever listens on your machine.

```
you  →  ChatGPT:  my test suite is failing in ~/work/api, can you look?
ChatGPT  →  pi_ask: "In ~/work/api, run the test suite, find the cause, fix it."
pi (your laptop):
             ├─ bash   npm test                ← shown in your terminal, you approve
             ├─ read   src/auth.test.ts
             ├─ edit   add the missing await
             └─ bash   npm test                (passes)
           →  "Missing await in auth.test.ts:42. Fixed; suite passes."
ChatGPT  →  It was a missing `await` at `src/auth.test.ts:42`. Fixed, tests green.
```

## How it works

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

Two pieces, one repository:

- **`server/`** — the relay. Runs on a small VPS with a public HTTPS name. It
  speaks MCP to the client and OAuth 2.1 (with Feishu as the identity provider)
  to protect it.
- **`extension/`** — the agent side. Loaded by pi, adds `/connect`,
  `/disconnect`, and the confirmation gate. Holds an outbound connection to the
  relay.

The connection is outbound-only, so the laptop stays invisible, closing the lid
is a sufficient kill switch, and no port forwarding is involved.

## Tools

`pi_ask` and `pi_task` are the intended path: they hand a whole task to the local
agent, which owns a shell, the files and its own toolchain, and can run several
commands, read what failed and adapt.

| tool | purpose |
|---|---|
| `pi_ask` | **preferred.** Hand a task to the local agent; get a finished answer |
| `pi_task` | collect a `pi_ask`/`pi_exec` that outlived its wait window; `abort` stops it |
| `pi_status` | pwd, model, context tokens used, busy state, session file |
| `pi_compact` | summarise the session's context — `/compress` on the far side |
| `pi_tree` | list the current branch, or roll the session back to an entry |
| `pi_exec` | *not recommended* — one deterministic command, when you need exact output |
| `pi_read` | *not recommended* — verbatim text with line numbers |
| `pi_write` | *not recommended* — whole-file replace |
| `pi_edit` | *not recommended* — exact-snippet replace |

The ranking is deliberate and is written into the tool descriptions. A model that
reaches for `pi_exec` reflexively turns every task into shell-quoting practice and
loses the ability to recover from a mistake, while `pi_ask` can run the command,
read the error and try something else. The four escape hatches still exist
because a summary is sometimes not good enough: you cannot quote a line number
out of a summary, and re-asking for a whole task because one line was wrong is
wasteful.

`pi_compact` and `pi_tree` exist because a session driven remotely fills up and
goes wrong in ways the chat window cannot see. `pi_status` shows how full the
context is before it becomes a problem; `pi_tree` rolls back with
`summarize: false` by default, since the point of rolling back is a smaller
context.

One asymmetry is worth knowing: rolling back to a **user** message removes that
message too, so it can be sent again differently, while rolling back to an
**assistant** message keeps it. The reply says which happened and what the
context now ends with.

## Security

The real risk is not a leaked URL. It is ChatGPT reading a web page, being told to
run something, and having a shell. Three layers:

1. **Confirmation gate (default).** Every remote-triggered `bash`, `write` or
   `edit` is shown in your terminal with its exact text and must be approved.
   `/connect --auto` turns this off for a session you have decided to trust. For
   `pi_ask` the gate is implemented on pi's `tool_call` event, so it also covers
   the commands the local agent decides to run on its own — one hook, both paths.
2. **Directory fence.** `--cwd` sets the root. Paths are checked against the real
   path of the nearest existing ancestor, so a symlink cannot walk out.
3. **Two independent credentials.** MCP clients authenticate through OAuth 2.1,
   locked to one identity. The agent presents a static bearer token, because a
   laptop reconnecting every few seconds must not involve a browser. That token
   only buys the ability to *receive* work, never to call a tool.

`MCP_ALLOW_NO_AUTH=1` exists for local experiments. With it, **anyone who learns
the URL can drive your machine whenever you are connected** — there is no
credential between the MCP endpoint and your shell. Do not run it that way on the
public internet.

## Quick start

You need a machine that is always on with a public HTTPS name (a €4 VPS is
enough), and a laptop with pi installed.

### 1. Relay

```bash
sudo useradd --system --home /var/lib/pi-bridge --shell /usr/sbin/nologin pi-bridge
sudo mkdir -p /opt/pi-bridge /etc/pi-bridge
sudo tar -xzf pi-bridge.tar.gz -C /opt/pi-bridge   # or: git clone … /opt/pi-bridge
cd /opt/pi-bridge && sudo npm install --omit=dev

sudo cp deploy/pi-bridge.env.example /etc/pi-bridge/pi-bridge.env
sudo chmod 600 /etc/pi-bridge/pi-bridge.env        # fill in the values
sudo chown root:pi-bridge /etc/pi-bridge/pi-bridge.env

sudo cp deploy/pi-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pi-bridge
curl https://pi.example.com/healthz                # {"ok":true,"agents":0,…}
```

`deploy/nginx.conf` is the vhost. The two settings that matter are
`proxy_buffering off` and a `proxy_read_timeout` comfortably above
`POLL_HOLD_SEC`; without them the held poll turns into a hang.

The identity provider is Feishu: create an app and add
`https://pi.example.com/callback` to its redirect URL whitelist. Swapping in
another provider means rewriting `server/oauth.mjs`, which is the only file that
knows who Feishu is.

### 2. Agent

Write `~/.pi/agent/pi-bridge.json` (mode 600):

```json
{ "url": "https://pi.example.com", "token": "<AGENT_TOKEN>", "agent": "laptop" }
```

Then make pi load `extension/index.ts`: list it in `~/.pi/agent/settings.json`
under `"extensions"`, or copy it to `~/.pi/agent/extensions/`.

```
/connect laptop                 # confirm every bash/write/edit
/connect laptop --auto          # no prompts
/connect laptop --cwd ~/work    # confine to a directory
/connect laptop --force         # take over a name left behind by a crash
/disconnect
```

### 3. ChatGPT

Settings → Connectors → Create. Server URL `https://pi.example.com/mcp`,
authentication OAuth, advanced OAuth settings empty (dynamic client registration
is automatic).

Ask it `pi_status` first: it should answer with the pwd and the context size of
the session you connected.

## Configuration

Relay, in `/etc/pi-bridge/pi-bridge.env`:

| variable | default | meaning |
|---|---|---|
| `PUBLIC_URL` | — | public origin; must be `https://` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | identity provider credentials |
| `ALLOWED_OPEN_ID` | empty | the only account allowed to authorize (**set it**) |
| `AGENT_TOKEN` | — | what a pi session presents to connect |
| `PORT` / `HOST` | `18810` / `127.0.0.1` | listen address; stays on loopback behind nginx |
| `STATE_DIR` | `/var/lib/pi-bridge` | OAuth client and token store |
| `POLL_HOLD_SEC` | `25` | how long a poll is held; `0` degrades to short polling |
| `AGENT_TTL_SEC` | `40` | lease length; an agent silent this long is gone |
| `DEFAULT_WAIT_SEC` / `MAX_WAIT_SEC` | `45` / `240` | how long a tool call blocks before returning a task id |
| `TASK_TTL_SEC` | `3600` | how long finished tasks stay fetchable |
| `READ_ONLY` | `0` | restrict the surface to `pi_status` and `pi_ask` |

Agent, in `~/.pi/agent/pi-bridge.json`: `url`, `token`, and an optional `agent`
name defaulting to the hostname. `PI_BRIDGE_URL` and `PI_BRIDGE_TOKEN` override it.

## Design notes

**Transport is a held GET, not a socket.** The agent issues an ordinary
`GET /agent/poll`; the relay holds it until there is work or for 25 seconds.
An idle session costs 2.4 requests a minute and still receives work the instant it
exists. No WebSocket, no SSE, no reconnection state machine — a dropped
connection is just the next GET failing and retrying.

**Calls are picked up, never pushed.** A tool call is only sent to an agent that
is currently asking for work, which removes the entire class of "message lost
while the laptop slept". The lease falls out of the same mechanism: no polls, no
agent, no stale cleanup to write.

**With two agents connected, `agent` is required.** Omitting it is an error that
lists the choices. A silent default would eventually send a write to the wrong
machine, and the error is self-correcting: the model reads the list and retries.

**Status is answered inline while busy.** A status call must not queue behind five
minutes of work, so it bypasses the work queue the same way an abort does.

## Limitations

- Identity is Feishu only, in one file (`server/oauth.mjs`).
- No streaming: a tool call returns when the work is done, and anything slower
  than its wait window becomes a task id to poll.
- pi has to be running. Close it and the name frees itself within `AGENT_TTL_SEC`.
- Tested against ChatGPT's connector; any MCP client with streamable HTTP and
  OAuth 2.1 should work, but the others are untested.
- The agent sees your whole machine within `--cwd`. That is the point, and it is
  also the reason the confirmation gate defaults to on.

## Development

```bash
npm install
npm test        # 11 tests
```

`test/e2e.test.mjs` is the honest one: it starts a real relay process, loads the
real extension, and talks to it as an MCP client would. It asserts that a write
lands on disk, that an ambiguous edit writes nothing, that a path escaping the
root is refused, that a denied confirmation leaves the file untouched, that the
`tool_call` gate fires for the agent's own commands, that compaction reports
before/after, and that `/disconnect` really does make the tools fail.

Node 20+ runs the relay; the test suite needs Node 23+, because it imports the
extension's TypeScript directly instead of keeping a second build artifact in
sync with the first.

Layout:

```
server/    index.mjs  HTTP, OAuth endpoints, MCP wiring
           hub.mjs    agents, leases, queues, tasks — no HTTP in sight
           tools.mjs  the nine tools and their descriptions
           oauth.mjs  OAuth 2.1 authorization server, Feishu as the IdP
extension/ index.ts   /connect, /disconnect, the gate, the poll loop
deploy/    systemd unit, nginx vhost, example config
```

## License

MIT
