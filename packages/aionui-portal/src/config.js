const path = require('node:path');

const DEFAULT_USERS = [
  { username: 'userA', password: 'password123', id: 'user-a' },
  { username: 'userB', password: 'password456', id: 'user-b' },
];

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDefaultUsers(value) {
  if (!value) {
    return DEFAULT_USERS;
  }

  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('AIONUI_PORTAL_USERS_JSON must be a JSON array');
  }

  return parsed.map((user) => {
    if (!user.username || !user.password || !user.id) {
      throw new Error('Each portal user must include username, password, and id');
    }

    return {
      username: String(user.username),
      password: String(user.password),
      id: String(user.id),
    };
  });
}

/**
 * Builds runtime configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} env Environment values.
 * @returns {object} Portal runtime configuration.
 */
function getPortalConfig(env = process.env) {
  const usersDataRoot = env.AIONUI_USERS_DATA_ROOT || '/data/users';

  return {
    port: parseInteger(env.AIONUI_PORTAL_PORT, 8085),
    databasePath: env.AIONUI_PORTAL_DB_PATH || '/data/portal/portal.sqlite',
    defaultUsers: parseDefaultUsers(env.AIONUI_PORTAL_USERS_JSON),
    dockerImage: env.AIONUI_WEB_IMAGE || 'your-registry.local/aionui-web:v1.0',
    dockerNetwork: env.AIONUI_DOCKER_NETWORK || 'aionui-network',
    dockerSocketPath: env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    usersDataRoot,
    idleTimeoutMs: parseInteger(env.AIONUI_IDLE_TIMEOUT_MS, 30 * 60 * 1000),
    cleanupIntervalMs: parseInteger(env.AIONUI_CLEANUP_INTERVAL_MS, 60 * 1000),
    containerMemoryBytes: parseInteger(env.AIONUI_CONTAINER_MEMORY_BYTES, 512 * 1024 * 1024),
    containerNanoCpus: parseInteger(env.AIONUI_CONTAINER_NANO_CPUS, 1000000000),
    containerDataMountPath: env.AIONUI_CONTAINER_DATA_PATH || '/app/data',
    containerPort: parseInteger(env.AIONUI_CONTAINER_PORT, 3000),
    userDataPathFor(userId) {
      return path.join(usersDataRoot, userId);
    },
  };
}

module.exports = { getPortalConfig };
