import { z } from 'zod';

/**
 * Tool surface.
 *
 * Seven tools, and their ranking is the point. `pi_ask` and `pi_task` are the
 * intended path: they hand a whole task to a local agent that owns a shell, the
 * filesystem and its own toolchain, so a request like "the test suite is failing,
 * work out why" finishes in one call instead of fifteen.
 *
 * The other four exist for the cases where a summary is not good enough — you
 * need the exact bytes of a file before editing it, one deterministic command's
 * output, a value only a shell can produce. Their descriptions say so out loud,
 * because a model that reaches for `pi_exec` reflexively turns every task into
 * shell-quoting practice and loses the ability to recover from a failure.
 */

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errorText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const agentArg = z
  .string()
  .optional()
  .describe('Which connected agent to use, e.g. "laptop". Required when more than one is connected; call pi_status to list them.');

const waitArg = z
  .number()
  .int()
  .min(5)
  .max(240)
  .optional()
  .describe('Seconds to wait for a result before returning a task id. Defaults to 45. Raise it for a known-slow command rather than polling.');

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Render whatever the agent sent back into something readable in a chat window. */
function render(kind, result) {
  if (result == null) return '(no output)';
  if (kind === 'exec') {
    const parts = [];
    if (result.stdout?.trim()) parts.push(result.stdout.replace(/\s+$/, ''));
    if (result.stderr?.trim()) parts.push(`[stderr]\n${result.stderr.replace(/\s+$/, '')}`);
    parts.push(`[exit ${result.code}${result.signal ? `, ${result.signal}` : ''}${result.timedOut ? ', timed out' : ''}]`);
    return parts.join('\n\n');
  }
  if (typeof result === 'string') return result;
  if (result.text) return result.text;
  return JSON.stringify(result, null, 2);
}

export function registerTools(server, { hub, config, log = () => {} }) {
  /**
   * One path for every call: resolve the agent, register a task, hand it over,
   * and translate the three possible endings (answer, failure, still-running)
   * into something the model can act on.
   */
  const dispatch = async ({ agent, kind, args, summary, waitSec }) => {
    const name = hub.pick(agent);
    if (config.readOnly && kind !== 'status' && kind !== 'ask') {
      return errorText('This relay is running read-only; only pi_status and pi_ask are available.');
    }

    const waitMs = Math.min((waitSec ?? config.defaultWaitMs / 1000) * 1000, config.maxWaitMs);
    const task = hub.createTask({ agent: name, kind, summary });
    const { done } = hub.issue({ agent: name, kind, args, taskId: task.id, waitMs: 0 });
    const outcome = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), waitMs).unref?.()),
    ]);

    if (outcome.timeout) {
      log(`task ${task.id} still running after ${Math.round(waitMs / 1000)}s`);
      return text(
        `${name} is still working on this after ${Math.round(waitMs / 1000)}s.\n\n` +
          `task id: ${task.id}\n\n` +
          `Call pi_task with {"taskId": "${task.id}"} to collect the result. Do not repeat the original call — ` +
          'that would start the work a second time.',
      );
    }
    if (outcome.ok === false) return errorText(`${name}: ${outcome.error}`);
    return text(render(kind, outcome.result));
  };

  server.registerTool(
    'pi_ask',
    {
      title: 'Ask the local pi agent',
      description:
        'Hand a task to a local pi agent that has the user\'s shell, files and its own toolchain (read, write, grep, tests). ' +
        'This is the preferred way to do almost anything: prefer it over pi_exec, pi_read, pi_write and pi_edit. ' +
        'The agent runs the whole task itself, recovers from its own failures, and returns a finished answer rather than a transcript. ' +
        'If it outlives your wait window you get a task id back instead of text; collect it with pi_task.',
      inputSchema: {
        prompt: z
          .string()
          .describe(
            'What to do, in plain language. The agent shares no context with this conversation, so state the goal and the acceptance criteria, and name the paths involved.',
          ),
        agent: agentArg,
        waitSec: waitArg,
      },
    },
    ({ prompt, agent, waitSec }) =>
      dispatch({ agent, kind: 'ask', args: { prompt }, summary: prompt.slice(0, 80), waitSec }),
  );

  server.registerTool(
    'pi_task',
    {
      title: 'Collect a long-running task',
      description:
        'Collect the result of a pi_ask or pi_exec that outlived its wait window. Set abort to stop it locally. ' +
        'Polling a task that is still running is safe and cheap.',
      inputSchema: {
        taskId: z.string().describe('The task id returned by pi_ask or pi_exec'),
        abort: z.boolean().optional().describe('Ask the agent to stop working on this task'),
      },
    },
    async ({ taskId, abort }) => {
      const task = hub.task(taskId);
      if (abort) {
        if (task.status !== 'running') return text(`Task ${taskId} already finished as ${task.status}; nothing to abort.`);
        hub.issue({ agent: task.agent, kind: 'abort', args: { taskId } });
        return text(`Asked ${task.agent} to stop task ${taskId}. Check again with pi_task to see how it ended.`);
      }
      const current = hub.task(taskId);
      if (current.status === 'running') {
        const secs = Math.round((Date.now() - current.startedAt) / 1000);
        return text(`${current.agent} is still working on ${current.kind} (${current.summary}) — ${secs}s so far.`);
      }
      if (current.status === 'failed') return errorText(`${current.agent}: ${current.error}`);
      if (current.status === 'aborted') return text(`Task ${taskId} was aborted: ${current.error ?? 'stopped by the user'}`);
      return text(render(current.kind, current.result));
    },
  );

  server.registerTool(
    'pi_status',
    {
      title: 'Which local agents are connected',
      description:
        'List the connected local pi agents, their working directory, and what they are busy with. ' +
        'Call this first whenever you are unsure which agent to address, or when a call failed because none was connected.',
      inputSchema: {
        agent: agentArg,
      },
    },
    ({ agent }) => {
      const agents = hub.list();
      if (!agents.length) {
        return text('No local pi is connected right now. Ask the user to run /connect in a pi session.');
      }
      if (agent) {
        const one = hub.pick(agent);
        const info = agents.find((a) => a.name === one);
        return text(
          [
            `agent ${info.name}`,
            `  cwd      ${info.cwd || '?'}`,
            `  model    ${info.model || '?'}`,
            `  up       ${Math.round((Date.now() - info.connectedAt) / 1000)}s`,
            `  queued   ${info.queued}`,
            `  running  ${info.tasks}`,
          ].join('\n'),
        );
      }
      return text(
        agents
          .map(
            (a) =>
              `${a.name}  ${a.cwd || '?'}  [${a.model || '?'}]` +
              `${a.tasks ? `  ${a.tasks} task(s) running` : ''}${a.queued ? `  ${a.queued} queued` : ''}`,
          )
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'pi_exec',
    {
      title: 'Run one shell command',
      description:
        'Run a single shell command on the local machine and return its stdout, stderr and exit status.\n\n' +
        'NOT RECOMMENDED for general use — prefer pi_ask, which can run several commands, read the failures and adapt. ' +
        'Use this only when you need one deterministic command and its exact output (a version, a git SHA, a single grep, a file count). ' +
        'It cannot recover from a mistake, and a long or interactive command will just time out.',
      inputSchema: {
        command: z.string().describe('The command line, run with bash -lc in the agent\'s working directory'),
        cwd: z.string().optional().describe('Subdirectory to run in, relative to the agent root'),
        agent: agentArg,
        waitSec: waitArg,
      },
    },
    ({ command, cwd, agent, waitSec }) => dispatch({ agent, kind: 'exec', args: { command, cwd }, summary: command.slice(0, 80), waitSec }),
  );

  server.registerTool(
    'pi_read',
    {
      title: 'Read a file verbatim',
      description:
        'Read a text file with line numbers, paged with offset and limit.\n\n' +
        'NOT RECOMMENDED unless you need the exact text — pi_ask can read the file and tell you what matters. ' +
        'Reach for this when you are about to quote something, need precise line numbers, or need a value you will copy exactly.',
      inputSchema: {
        path: z.string().describe('Path relative to the agent root'),
        offset: z.number().int().min(1).optional().describe('First line to return, 1-based. Defaults to 1.'),
        limit: z.number().int().min(1).max(2000).optional().describe('How many lines. Defaults to 400.'),
        agent: agentArg,
        waitSec: waitArg,
      },
    },
    ({ path, offset, limit, agent, waitSec }) =>
      dispatch({ agent, kind: 'read', args: { path, offset, limit }, summary: `read ${path}`, waitSec }),
  );

  server.registerTool(
    'pi_write',
    {
      title: 'Replace a whole file',
      description:
        'Write a file, replacing it entirely, creating parent directories as needed.\n\n' +
        'PREFER pi_ask: it can write the file and then check that it parses, compiles or passes a test. ' +
        'Use this only when you already hold the complete new content and do not need anyone to verify it.',
      inputSchema: {
        path: z.string().describe('Path relative to the agent root'),
        content: z.string().describe('The complete new file content'),
        agent: agentArg,
        waitSec: waitArg,
      },
    },
    ({ path, content, agent, waitSec }) =>
      dispatch({ agent, kind: 'write', args: { path, content }, summary: `write ${path} (${bytes(Buffer.byteLength(content))})`, waitSec }),
  );

  server.registerTool(
    'pi_edit',
    {
      title: 'Replace one exact snippet',
      description:
        'Replace one exact string in a file. oldText must appear exactly once unless replaceAll is set; an ambiguous match is an error, never a guess.\n\n' +
        'PREFER pi_ask when the change needs checking afterwards. Use this for a one-line correction you can already spell exactly, ' +
        'or to fix something pi_ask got slightly wrong — which is cheaper than asking for the whole task again.',
      inputSchema: {
        path: z.string().describe('Path relative to the agent root'),
        oldText: z.string().describe('The exact text to find, including indentation. Must be unique unless replaceAll is set.'),
        newText: z.string().describe('What to put in its place. Empty string deletes the match.'),
        replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match'),
        agent: agentArg,
        waitSec: waitArg,
      },
    },
    ({ path, oldText, newText, replaceAll, agent, waitSec }) =>
      dispatch({
        agent,
        kind: 'edit',
        args: { path, oldText, newText, replaceAll },
        summary: `edit ${path}`,
        waitSec,
      }),
  );
}
