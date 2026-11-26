#!/usr/bin/env node
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { loadConfig } from './config.mjs';
import { Hub, HubError } from './hub.mjs';
import { registerTools } from './tools.mjs';
import { FeishuOAuthProvider } from './oauth.mjs';

/**
 * The relay.
 *
 * Two unrelated authentication schemes live on one host and never touch:
 *
 *   - MCP clients (ChatGPT) go through OAuth 2.1 with Feishu as the identity
 *     provider, exactly like the Overleaf server;
 *   - pi sessions present a static bearer token, because a laptop reconnecting
 *     every few seconds must not involve a browser.
 *
 * That token buys the ability to *receive work*, not to call tools, so a leaked
 * one cannot reach another agent's queue and cannot act without a live MCP call.
 */

const log = (msg) => console.error(`[pi-bridge] ${new Date().toISOString()} ${msg}`);

let config;
try {
  config = loadConfig();
} catch (err) {
  log(`FATAL: ${err.message}`);
  process.exit(1);
}

const hub = new Hub({ log, ttlMs: config.agentTtlMs, holdMs: config.pollHoldMs, taskTtlMs: config.taskTtlMs });
const { publicUrl, oauth } = config;

// Where the protected-resource metadata lives. RFC 9728 puts it under the
// well-known root with the resource path appended.
const PRM_PATH = '/.well-known/oauth-protected-resource/mcp';
const RESOURCE_URL = publicUrl ? `${publicUrl}/mcp` : `http://${config.host}:${config.port}/mcp`;
const PRM_URL = publicUrl ? `${new URL(publicUrl).origin}${PRM_PATH}` : `http://${config.host}:${config.port}${PRM_PATH}`;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

let provider = null;

if (oauth) {
  provider = new FeishuOAuthProvider({
    publicUrl,
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    allowedOpenIds: config.feishu.allowedOpenIds,
    stateDir: config.stateDir,
    log,
  });

  // The SDK's mcpAuthRouter builds every endpoint with `new URL('/authorize', …)`,
  // so mounting the handlers ourselves is the only way to control the base path.
  const metadata = {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/authorize`,
    token_endpoint: `${publicUrl}/token`,
    registration_endpoint: `${publicUrl}/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: [],
  };

  app.use('/authorize', authorizationHandler({ provider }));
  app.use('/token', tokenHandler({ provider }));
  app.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  app.get('/callback', (req, res) => provider.handleCallback(req, res));

  // Clients disagree about where authorization-server metadata lives: RFC 8414
  // inserts the issuer path after the well-known segment, others append it or
  // probe OpenID configuration. Serve every shape so discovery cannot dead-end.
  const asMetadata = metadataHandler(metadata);
  for (const p of new Set([
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ])) {
    app.use(p, asMetadata);
  }

  const prm = (_req, res) =>
    res.json({
      resource: RESOURCE_URL,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
      resource_name: 'Pi bridge',
    });
  app.get(PRM_PATH, prm);
  app.get('/.well-known/oauth-protected-resource', prm);
}

// -- agent authentication ---------------------------------------------------

const agentTokenOk = (req) => {
  if (!config.agentToken) return config.allowNoAuth;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const given = Buffer.from(match?.[1]?.trim() ?? '');
  const want = Buffer.from(config.agentToken);
  return given.length === want.length && timingSafeEqual(given, want);
};

const requireAgent = (req, res, next) => {
  if (!agentTokenOk(req)) return res.status(401).json({ error: 'unauthorized', code: 'bad_agent_token' });
  next();
};

// -- agent endpoints --------------------------------------------------------

app.use('/agent', express.json({ limit: '1mb' }), requireAgent);

const fail = (res, err) => {
  if (err instanceof HubError) return res.status(err.status).json({ error: err.message, code: err.code });
  log(`agent request failed: ${err.stack || err.message}`);
  return res.status(500).json({ error: err.message });
};

app.post('/agent/hello', (req, res) => {
  try {
    const { name, cwd, model, pid, force } = req.body ?? {};
    res.json(hub.hello({ name, cwd, model, pid, force: Boolean(force) }));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The heartbeat and the inbox at once.
 *
 * The request is held open until there is something to deliver or the hold
 * expires, so an idle agent costs one request every 25 seconds and still gets
 * work the instant it exists. Nothing is ever queued waiting for a connection
 * that is not asking for it.
 */
app.get('/agent/poll', async (req, res) => {
  const name = String(req.query.name ?? '');
  const busy = req.query.busy === '1';

  // An aborted poll is the normal way this ends when the laptop sleeps, so it
  // must free the holder rather than leaving a dangling waiter behind.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const { calls } = await hub.poll(name, { busy, signal: controller.signal });
    if (res.headersSent || res.writableEnded) return;
    res.json({ calls });
  } catch (err) {
    if (res.headersSent || res.writableEnded) return;
    fail(res, err);
  }
});

app.post('/agent/reply', (req, res) => {
  try {
    const { name, callId, ...payload } = req.body ?? {};
    res.json(hub.reply(name, callId, payload));
  } catch (err) {
    fail(res, err);
  }
});

app.post('/agent/bye', (req, res) => {
  try {
    res.json(hub.bye(String(req.body?.name ?? '')));
  } catch (err) {
    fail(res, err);
  }
});

// -- MCP --------------------------------------------------------------------

const unauthorized = (res) =>
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${PRM_URL}"`)
    .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });

const requireBearer = async (req, res, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return unauthorized(res);
  try {
    req.auth = await provider.verifyAccessToken(match[1].trim());
    next();
  } catch {
    unauthorized(res);
  }
};

const buildServer = () => {
  const server = new McpServer(
    { name: 'pi-bridge', version: '0.1.0' },
    {
      instructions:
        'Drives a pi coding agent running on the user\'s own machine. Prefer pi_ask for almost everything; ' +
        'the file and shell tools are escape hatches for when you need exact bytes or one deterministic command. ' +
        'pi_status reports the working directory and how full the context is; pi_compact summarises the history ' +
        'when it fills up, and pi_tree rolls the session back to an earlier point. ' +
        'If a call fails with "No local pi is connected", tell the user to run /connect in pi.',
    },
  );
  registerTools(server, { hub, config, log });
  return server;
};

app.get('/healthz', (_req, res) => {
  const agents = hub.list();
  res.json({
    ok: true,
    agents: agents.length,
    names: agents.map((a) => a.name),
    auth: oauth ? 'feishu-oauth' : 'none',
    hold: config.pollHoldMs / 1000,
  });
});

app.use('/mcp', express.json({ limit: '4mb' }), provider ? requireBearer : (_req, _res, next) => next());

const handleMcp = async (req, res) => {
  // Stateless: one server and transport per request, so a restart never leaves
  // a client holding a dead session id.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log(`mcp request failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  }
};

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const httpServer = app.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}/mcp`);
  log(`mcp auth ${oauth ? `Feishu OAuth via ${publicUrl}` : 'DISABLED (MCP_ALLOW_NO_AUTH=1)'}`);
  log(`agent auth ${config.agentToken ? 'bearer token' : 'DISABLED'} | poll hold ${config.pollHoldMs / 1000}s | lease ${config.agentTtlMs / 1000}s`);
});

// A held poll keeps an idle process alive for up to 25s after SIGTERM; exit
// anyway rather than leaving a unit that will not stop.
const shutdown = (signal) => {
  log(`${signal} received, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
