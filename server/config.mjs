/**
 * Everything the relay needs, read once at startup and then never again.
 *
 * The defaults are chosen so that `node server/index.mjs` with no environment at
 * all starts in the only mode that is safe for a laptop: loopback, no auth, and
 * loud about it.
 */

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/$/, '');
  const oauth = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && publicUrl);
  const allowNoAuth = env.MCP_ALLOW_NO_AUTH === '1';

  const config = {
    host: env.HOST ?? '127.0.0.1',
    port: int(env.PORT, 18810),
    stateDir: env.STATE_DIR ?? new URL('../state', import.meta.url).pathname,
    publicUrl,
    oauth,
    allowNoAuth,
    feishu: {
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
      allowedOpenIds: (env.ALLOWED_OPEN_ID ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    // The token a pi session presents when it connects. Separate from OAuth on
    // purpose: rotating a laptop is a file edit, not a re-authorization.
    agentToken: env.AGENT_TOKEN ?? '',
    // How long a held poll waits before returning empty, and how stale lastSeen
    // may get before an agent is considered gone. The hold must stay well under
    // nginx's proxy_read_timeout (60s by default).
    pollHoldMs: int(env.POLL_HOLD_SEC, 25) * 1000,
    agentTtlMs: int(env.AGENT_TTL_SEC, 40) * 1000,
    // How long an MCP call blocks before handing back a task id instead.
    defaultWaitMs: int(env.DEFAULT_WAIT_SEC, 45) * 1000,
    maxWaitMs: int(env.MAX_WAIT_SEC, 240) * 1000,
    taskTtlMs: int(env.TASK_TTL_SEC, 3600) * 1000,
    readOnly: env.READ_ONLY === '1',
  };

  if (!config.oauth && !config.allowNoAuth) {
    throw new Error(
      'OAuth is not configured. Set PUBLIC_URL, FEISHU_APP_ID and FEISHU_APP_SECRET. ' +
        'For a local experiment only, set MCP_ALLOW_NO_AUTH=1.',
    );
  }
  if (config.oauth && !config.publicUrl.startsWith('https://') && env.ALLOW_INSECURE_PUBLIC_URL !== '1') {
    throw new Error('PUBLIC_URL must be an https:// URL — OAuth clients will not follow a plaintext redirect.');
  }
  if (!config.agentToken && !config.allowNoAuth) {
    throw new Error('AGENT_TOKEN is required: it is what proves a pi session may attach to this relay.');
  }

  return config;
}
