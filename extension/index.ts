/**
 * pi-bridge — let a remote MCP client drive this pi session.
 *
 *   /connect laptop            attach to the relay under a name
 *   /connect laptop --auto     attach without asking for each tool call
 *   /connect laptop --cwd DIR  confine the session to DIR
 *   /disconnect                detach, abort anything running
 *
 * The session is not put in a box: a remote `pi_ask` arrives as a normal message
 * and the agent answers with its normal tools. What is added is a gate — before a
 * remote task runs bash, write or edit, the call is shown to the person sitting
 * in front of the terminal, who can refuse it.
 *
 * The rule that makes this safe to leave on: a remote request can only ever be
 * *picked up*. Nothing is delivered to a session that is not asking for work, so
 * a closed laptop is a closed door, not a queue of surprises.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "pi-bridge.json");
const STATUS_KEY = "pi-bridge";
const EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const ASK_TIMEOUT_MS = 30 * 60 * 1000;

type Mode = "confirm" | "auto";

interface Config {
	url: string;
	token: string;
	agent?: string;
}

interface Call {
	callId: string;
	kind: "ask" | "exec" | "read" | "write" | "edit" | "abort" | "status" | "compact" | "tree";
	args: Record<string, any>;
	taskId?: string | null;
}

export default function (pi: ExtensionAPI) {
	const state = {
		active: false,
		url: "",
		token: "",
		name: "",
		root: "",
		mode: "confirm" as Mode,
		busy: false,
		working: false,
		queue: [] as Call[],
		controller: null as AbortController | null,
		wake: null as AbortController | null,
		currentAsk: "" as string,
		failures: 0,
		ctx: null as ExtensionContext | null,
	};

	// -- helpers --------------------------------------------------------------

	const fail = (msg: string) => {
		throw new Error(msg);
	};

	const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const textOf = (message: any): string => {
		const content = message?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((b: any) => b?.type === "text")
			.map((b: any) => b.text)
			.join("\n");
	};

	const authorised = () => ({ authorization: `Bearer ${state.token}`, "content-type": "application/json" });

	const api = async (route: string, body: unknown) => {
		const res = await fetch(`${state.url}${route}`, { method: "POST", headers: authorised(), body: JSON.stringify(body) });
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error((json as any).error ?? `${res.status} ${res.statusText}`);
		return json;
	};

	const loadConfig = async (): Promise<Config> => {
		const fromEnv = { url: process.env.PI_BRIDGE_URL ?? "", token: process.env.PI_BRIDGE_TOKEN ?? "" };
		let fromFile: Partial<Config> = {};
		try {
			fromFile = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		} catch {
			// No file is normal during setup; the error below explains what to write.
		}
		const url = (fromEnv.url || fromFile.url || "").replace(/\/$/, "");
		const token = fromEnv.token || fromFile.token || "";
		if (!url || !token) {
			fail(`No relay configured. Write ${CONFIG_PATH} as {"url":"https://…","token":"…"} or set PI_BRIDGE_URL and PI_BRIDGE_TOKEN.`);
		}
		return { url, token, agent: fromFile.agent };
	};

	const defaultName = () => hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);

	/**
	 * Resolve a path the caller gave us, and refuse anything that leaves the root.
	 *
	 * The check runs against the real path of the nearest existing ancestor, so a
	 * symlink cannot be used to walk out of the directory the user scoped us to.
	 */
	const resolveInside = async (rel: string): Promise<string> => {
		const abs = path.resolve(state.root, rel);
		if (abs !== state.root && !abs.startsWith(state.root + path.sep)) fail(`${rel} is outside ${state.root}`);

		let probe = abs;
		for (let depth = 0; depth < 64; depth++) {
			try {
				const real = await realpath(probe);
				if (real !== state.root && !real.startsWith(state.root + path.sep)) {
					fail(`${rel} resolves to ${real}, which is outside ${state.root}`);
				}
				return abs;
			} catch (err: any) {
				if (err?.code !== "ENOENT") throw err;
				const parent = path.dirname(probe);
				if (parent === probe) break;
				probe = parent;
			}
		}
		return abs;
	};

	/** Show the person in the terminal exactly what was asked for, before it happens. */
	const gate = async (ctx: ExtensionContext | null, what: string, detail: string): Promise<boolean> => {
		if (state.mode === "auto") return true;
		const ui = (ctx ?? state.ctx) as any;
		if (!ui?.hasUI || !ui?.ui?.confirm) return false;
		return Boolean(await ui.ui.confirm(`ChatGPT → ${state.name}: ${what}`, detail.slice(0, 1500)));
	};

	// -- the work ------------------------------------------------------------

	const runExec = async (args: Record<string, any>) => {
		const cwd = args.cwd ? await resolveInside(String(args.cwd)) : state.root;
		const started = Date.now();
		return await new Promise((resolve) => {
			execFile(
				"bash",
				["-lc", String(args.command ?? "")],
				{ cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
				(err: any, stdout, stderr) => {
					resolve({
						stdout,
						stderr,
						code: typeof err?.code === "number" ? err.code : 0,
						signal: err?.signal ?? null,
						timedOut: Boolean(err?.killed) && Date.now() - started >= EXEC_TIMEOUT_MS,
					});
				},
			);
		});
	};

	const runRead = async (args: Record<string, any>) => {
		const full = await resolveInside(String(args.path));
		let content: string;
		try {
			content = await readFile(full, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") fail(`File not found: ${args.path}`);
			if (err?.code === "EISDIR") fail(`${args.path} is a directory; pi_exec with ls is the way to list one.`);
			throw err;
		}
		const lines = content.split("\n");
		const offset = Math.max(1, Number(args.offset ?? 1));
		const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 400)));
		const slice = lines.slice(offset - 1, offset - 1 + limit);
		const numbered = slice.map((line, i) => `${String(offset + i).padStart(5)}  ${line}`).join("\n");
		const more = offset - 1 + slice.length < lines.length ? `\n… ${lines.length} lines total; pass offset to read further.` : "";
		return numbered + more;
	};

	const runWrite = async (args: Record<string, any>) => {
		const full = await resolveInside(String(args.path));
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, String(args.content ?? ""), "utf8");
		return `wrote ${args.path} (${Buffer.byteLength(String(args.content ?? ""))} bytes)`;
	};

	const runEdit = async (args: Record<string, any>) => {
		const full = await resolveInside(String(args.path));
		const before = await readFile(full, "utf8");
		const oldText = String(args.oldText ?? "");
		const newText = String(args.newText ?? "");
		if (!oldText) fail("oldText must not be empty.");

		const count = before.split(oldText).length - 1;
		if (count === 0) fail(`oldText was not found in ${args.path}. Read the file and copy the exact characters, including indentation.`);
		if (count > 1 && !args.replaceAll) {
			fail(`oldText matches ${count} times in ${args.path}. Extend it with surrounding lines so it is unique, or set replaceAll. Nothing was written.`);
		}
		const after = args.replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
		await writeFile(full, after, "utf8");
		return `edited ${args.path}: ${count} replacement(s)`;
	};

	/** Wait for the agent to stop working, including retries and queued continuations. */
	const waitForSettled = (): Promise<boolean> =>
		new Promise((resolve) => {
			const off = (pi as any).on("agent_settled", (event: any) => {
				off?.();
				resolve(Boolean(event?.aborted));
			});
		});

	const runAsk = async (call: Call, ctx: ExtensionContext | null): Promise<string> => {
		if (!ctx?.isIdle()) {
			fail("The pi session is busy with the user's own work right now. Ask again in a moment.");
		}

		const collected: string[] = [];
		const off = (pi as any).on("message_end", (event: any) => {
			if (event?.message?.role !== "assistant") return;
			const t = textOf(event.message);
			if (t.trim()) collected.push(t);
		});

		const settled = waitForSettled();
		state.currentAsk = call.callId;

		try {
			pi.sendMessage(
				{
					customType: "pi-bridge",
					content:
						`${call.args.prompt}\n\n` +
						`[from ChatGPT over pi-bridge. That conversation cannot see this one, so do not assume shared context; ` +
						`answer self-containedly, with the paths and values spelled out.]`,
					display: true,
				},
				{ triggerTurn: true },
			);

			const aborted = await Promise.race([settled, sleep(ASK_TIMEOUT_MS).then(() => "timeout" as const)]);
			if (aborted === "timeout") fail("The agent did not settle within 30 minutes.");
			if (aborted === true) fail("The user interrupted this task in pi.");
			return collected.at(-1) ?? "(the agent produced no text)";
		} finally {
			state.currentAsk = "";
			off?.();
		}
	};

	/**
	 * Live facts the relay cannot know: where pi actually is, and how full the
	 * context is. Answered even while a task is running, so a status request
	 * never queues behind five minutes of work.
	 */
	const runStatus = (ctx: ExtensionContext | null) => {
		if (!ctx) fail("Not connected to a pi session.");
		const usage = (ctx as any).getContextUsage?.() ?? null;
		const sm = (ctx as any).sessionManager;
		const model = (ctx as any).model;
		return {
			pwd: process.cwd(),
			root: state.root,
			mode: state.mode,
			model: model ? `${model.provider}/${model.id}` : null,
			sessionName: pi.getSessionName?.() ?? null,
			sessionFile: sm?.getSessionFile?.() ?? null,
			entries: sm?.getEntryCount?.() ?? null,
			busy: !ctx.isIdle(),
			context: usage
				? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent }
				: null,
			remote: { running: Boolean(state.currentAsk), queued: state.queue.length },
		};
	};

	/** Compact the context and wait for the summary, since "did it work" is the whole question. */
	const runCompact = (ctx: ExtensionContext | null, instructions?: string) => {
		if (!ctx) fail("Not connected to a pi session.");
		if (!ctx.isIdle()) fail("pi is busy; compaction can only run when the session is idle.");
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error("compaction did not finish within 10 minutes"));
			}, 10 * 60 * 1000);

			(ctx as any).compact({
				customInstructions: instructions || undefined,
				onComplete: (result: any) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({
						tokensBefore: result?.tokensBefore ?? null,
						tokensAfter: result?.estimatedTokensAfter ?? null,
						firstKeptEntryId: result?.firstKeptEntryId ?? null,
						summary: String(result?.summary ?? "").slice(0, 2000),
					});
				},
				onError: (err: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err instanceof Error ? err : new Error(String(err)));
				},
			});
		});
	};

	/**
	 * List the current branch, or roll back to one entry on it.
	 *
	 * The list is the branch the session is actually on, because an entry from an
	 * abandoned branch is not a rollback target — it is a different conversation.
	 */
	const runTree = async (ctx: ExtensionContext | null, args: Record<string, any>) => {
		if (!ctx) fail("Not connected to a pi session.");
		const sm = (ctx as any).sessionManager;
		if (!sm) fail("This pi session has no session manager.");

		if (args.entryId) {
			if (!ctx.isIdle()) fail("pi is busy; roll back only when the session is idle.");
			const result = await (ctx as any).navigateTree(String(args.entryId), {
				summarize: Boolean(args.summarize),
			});
			if (result?.cancelled) fail("The rollback was cancelled in pi.");

			// Report what the context actually ends with now, because the leaf is
			// not always the entry that was named: rolling back to a user message
			// puts the leaf on its parent, so that message leaves the context too.
			const after: any[] = sm.getBranch?.() ?? [];
			const kept = [...after]
				.reverse()
				.find(
					(e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
				);
			const dropped = !after.some((e) => e.id === args.entryId);

			return {
				text:
					`rolled back to ${args.entryId}` +
					(args.summarize ? " with a summary of what was discarded" : ", no summary") +
					".\n" +
					(kept
						? `The context now ends at ${kept.id} (${kept.message.role}): "${textOf(kept.message).replace(/\s+/g, " ").trim().slice(0, 120)}"\n`
						: "The context holds no messages now.\n") +
					(dropped
						? `${args.entryId} was a user message, so it left the context as well — the next turn starts a new branch from here.\n`
						: "") +
					"Everything after it is gone from the context but still in the session file.\n" +
					"Call pi_status for the new context size.",
			};
		}

		const leaf = sm.getLeafId?.() ?? null;
		const branch: any[] = sm.getBranch?.() ?? [];
		const childCount = new Map<string, number>();
		const walk = (nodes: any[]) => {
			for (const node of nodes ?? []) {
				childCount.set(node.entry.id, node.children?.length ?? 0);
				walk(node.children ?? []);
			}
		};
		walk(sm.getTree?.() ?? []);

		const limit = Math.min(200, Math.max(1, Number(args.limit ?? 25)));
		const rows: string[] = [];
		let shown = 0;
		for (const entry of [...branch].reverse()) {
			if (shown >= limit) break;
			const kids = childCount.get(entry.id) ?? 0;
			const branchNote = kids > 1 ? `   (+${kids - 1} other branch)` : "";
			const current = entry.id === leaf ? "   ← current" : "";
			if (entry.type === "message") {
				const role = entry.message?.role;
				if (role !== "user" && role !== "assistant") continue;
				const text = textOf(entry.message).replace(/\s+/g, " ").trim().slice(0, 110);
				rows.push(`${entry.id}  ${role.padEnd(9)} ${text}${branchNote}${current}`);
				shown++;
			} else if (entry.type === "compaction") {
				rows.push(`${entry.id}  compaction [context was summarised here]${branchNote}${current}`);
				shown++;
			}
		}

		if (!rows.length) {
			return {
				text:
					`session ${sm.getSessionFile?.() ?? "(in memory)"}\n` +
					`current leaf: ${leaf ?? "(none)"}, ${branch.length} entries\n\n` +
					"No user or assistant messages on this branch: the session is at its beginning, or a rollback left only setup entries.",
			};
		}

		return {
			text:
				`session ${sm.getSessionFile?.() ?? "(in memory)"}\n` +
				`current leaf: ${leaf ?? "(none)"}\n` +
				`${branch.length} entries on this branch; showing the newest ${rows.length}, newest last\n\n` +
				`${rows.reverse().join("\n")}\n\n` +
				"To roll back, call pi_tree with entryId set to one of the ids above. " +
				"Everything after it leaves the context; summarize defaults to false, which keeps the context small.",
		};
	};

	const execute = async (call: Call): Promise<unknown> => {
		const ctx = state.ctx;
		switch (call.kind) {
			case "ask":
				return await runAsk(call, ctx);

			case "exec": {
				const command = String(call.args.command ?? "");
				if (!(await gate(ctx, "run a command", command))) fail("The user denied this command in pi.");
				return await runExec(call.args);
			}

			case "status":
				return await runStatus(ctx);

			case "compact":
				return await runCompact(ctx, call.args.instructions);

			case "tree":
				return await runTree(ctx, call.args);

			case "read":
				return await runRead(call.args);

			case "write": {
				const size = Buffer.byteLength(String(call.args.content ?? ""));
				if (!(await gate(ctx, "write a file", `${call.args.path} (${size} bytes)`))) fail("The user denied this write in pi.");
				return await runWrite(call.args);
			}

			case "edit": {
				if (!(await gate(ctx, "edit a file", `${call.args.path}\n\n${call.args.oldText}`))) fail("The user denied this edit in pi.");
				return await runEdit(call.args);
			}

			default:
				fail(`Unsupported call kind: ${call.kind}`);
		}
	};

	const reply = async (callId: string, payload: Record<string, unknown>) => {
		try {
			await api("/agent/reply", { name: state.name, callId, ...payload });
		} catch (err) {
			// The relay is gone; the poll loop already reports that. Losing one
			// reply is better than crashing the queue.
			state.failures++;
		}
	};

	const drain = async () => {
		if (state.working) return;
		state.working = true;
		state.busy = true;
		try {
			while (state.queue.length && state.active) {
				const call = state.queue.shift()!;
				try {
					const result = await execute(call);
					await reply(call.callId, { ok: true, result });
				} catch (err) {
					await reply(call.callId, { ok: false, error: msg(err) });
				}
			}
		} finally {
			state.working = false;
			state.busy = false;
			// The held poll was issued as busy=1 and will not accept work, so
			// reissue it immediately instead of leaving the next task queued
			// behind a 25 second wait.
			state.wake?.abort();
		}
	};

	const answerNow = async (call: Call) => {
		try {
			await reply(call.callId, { ok: true, result: await runStatus(state.ctx) });
		} catch (err) {
			await reply(call.callId, { ok: false, error: msg(err) });
		}
	};

	const handleAbort = async (call: Call) => {
		if (state.currentAsk) {
			state.ctx?.abort();
			await reply(call.callId, { ok: true, result: { aborted: true } });
			return;
		}
		// Leave the queued item alone if it is the one being aborted; the relay
		// tracks task state, we just stop whatever is running.
		state.ctx?.abort();
		await reply(call.callId, { ok: true, result: { aborted: false, note: "nothing was running" } });
	};

	// -- the poll loop --------------------------------------------------------

	/**
	 * One ordinary GET at a time. The relay holds it until there is work, so an
	 * idle session costs one request every 25 seconds and still starts instantly.
	 *
	 * While a task runs we keep polling with busy=1: the lease stays alive and a
	 * pi_task abort can still arrive, but no new work is taken on.
	 */
	const loop = async () => {
		while (state.active) {
			// A per-request controller so the loop can be woken on demand (busy
			// flips) without tearing down the session-wide one used by /disconnect.
			state.wake = new AbortController();
			const signal = state.controller
				? AbortSignal.any([state.controller.signal, state.wake.signal])
				: state.wake.signal;
			try {
				const res = await fetch(
					`${state.url}/agent/poll?name=${encodeURIComponent(state.name)}&busy=${state.busy ? 1 : 0}`,
					{ headers: { authorization: `Bearer ${state.token}` }, signal },
				);

				if (!res.ok) {
					const body: any = await res.json().catch(() => ({}));
					if (res.status === 401) return stop("the relay rejected this agent token");
					if (res.status === 409) return stop(body.error ?? "this agent name was taken over elsewhere");
					throw new Error(body.error ?? `${res.status} ${res.statusText}`);
				}

				const { calls } = (await res.json()) as { calls: Call[] };
				state.failures = 0;
				for (const call of calls ?? []) {
					// Control calls must not queue behind a running task: an abort or
					// a status request is only useful now.
					if (call.kind === "abort") void handleAbort(call);
					else if (call.kind === "status") void answerNow(call);
					else {
						state.queue.push(call);
						void drain();
					}
				}
			} catch (err) {
				if (!state.active) return;
				// Our own wake() aborts the held request; that is not a failure.
				if (err instanceof Error && err.name === "AbortError") continue;
				state.failures++;
				const wait = Math.min(500 * state.failures, 10_000);
				state.ctx?.ui.notify(`pi-bridge: ${msg(err)} — retrying in ${Math.round(wait / 1000)}s`, "warning");
				await sleep(wait);
			}
		}
	};

	const stop = async (reason?: string) => {
		if (!state.active) return;
		state.active = false;
		state.controller?.abort();
		state.queue.length = 0;
		state.ctx?.ui.setStatus(STATUS_KEY, undefined);
		if (reason) state.ctx?.ui.notify(`pi-bridge disconnected: ${reason}`, "warning");
		try {
			await api("/agent/bye", { name: state.name });
		} catch {
			// Best effort: the lease expiring covers a relay that is already gone.
		}
	};

	// -- commands -------------------------------------------------------------

	pi.registerCommand("connect", {
		description: "Expose this pi session to a remote MCP client (ChatGPT). /connect <name> [--auto] [--cwd DIR] [--force]",
		handler: async (args, ctx) => {
			if (state.active) {
				ctx.ui.notify(`Already connected as "${state.name}" (${state.mode}). /disconnect first.`, "warning");
				return;
			}

			const words = args.trim().split(/\s+/).filter(Boolean);
			const flags = new Set(words.filter((w) => w.startsWith("--")));
			const positional = words.filter((w) => !w.startsWith("--"));
			const cwdAt = words.indexOf("--cwd");
			const cwdValue = cwdAt >= 0 ? words[cwdAt + 1] : undefined;
			const name = (cwdValue ? positional.filter((w) => w !== cwdValue) : positional)[0];

			let config: Config;
			try {
				config = await loadConfig();
			} catch (err) {
				ctx.ui.notify(msg(err), "error");
				return;
			}

			state.url = config.url;
			state.token = config.token;
			state.name = (name ?? config.agent ?? defaultName()).toLowerCase();
			state.mode = flags.has("--auto") ? "auto" : "confirm";
			state.ctx = ctx;

			try {
				state.root = await realpath(path.resolve(cwdValue ?? process.cwd()));
				if (!(await stat(state.root)).isDirectory()) throw new Error("not a directory");
			} catch (err) {
				ctx.ui.notify(`Cannot use ${cwdValue ?? process.cwd()} as root: ${msg(err)}`, "error");
				return;
			}

			const model = (ctx as any).model ? `${(ctx as any).model.provider}/${(ctx as any).model.id}` : "";
			try {
				const hello = await api("/agent/hello", {
					name: state.name,
					cwd: state.root,
					model,
					pid: process.pid,
					force: flags.has("--force"),
				});
				state.active = true;
				state.controller = new AbortController();
				state.failures = 0;
				ctx.ui.setStatus(STATUS_KEY, `🔗 ${(hello as any).name}${state.mode === "auto" ? " ⚡" : ""}`);
				ctx.ui.notify(
					`Connected as "${(hello as any).name}" → ${state.url}\n` +
						`root: ${state.root}\nmode: ${state.mode === "auto" ? "auto (no prompts)" : "confirm (each bash/write/edit asks first)"}`,
					"info",
				);
				void loop();
			} catch (err) {
				ctx.ui.notify(`Connect failed: ${msg(err)}`, "error");
			}
		},
	});

	pi.registerCommand("disconnect", {
		description: "Stop exposing this pi session to the remote MCP client",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("Not connected.", "info");
				return;
			}
			const name = state.name;
			state.ctx = ctx;
			await stop();
			ctx.ui.notify(`Disconnected "${name}".`, "info");
		},
	});

	// -- the gate -------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		// Only calls made *because of* a remote task are interesting here. The
		// user's own work in this session keeps whatever permissions they set.
		if (!state.currentAsk) return undefined;
		if (state.mode === "auto") return undefined;
		if (!["bash", "powershell", "write", "edit"].includes(event.toolName)) return undefined;

		const input = event.input as any;
		const detail =
			event.toolName === "bash" || event.toolName === "powershell"
				? String(input?.command ?? "")
				: `${input?.path ?? input?.file_path ?? "?"}${input?.oldText ? `\n\n${input.oldText}` : ""}`;

		if (!ctx.hasUI) {
			return { block: true, reason: "A remote task wanted to run this, but there is no UI here to ask for confirmation." };
		}
		const ok = await ctx.ui.confirm(`ChatGPT → ${state.name}: ${event.toolName}`, detail.slice(0, 1500));
		if (!ok) return { block: true, reason: "The user denied this in pi. Do not retry the same command; ask them what to do instead." };
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		if (state.active) await stop();
	});
}
