const path = require('node:path');

const DEFAULT_USERS = [
  { username: 'userA', password: 'password123', id: 'user-a' },
  { username: 'userB', password: 'password456', id: 'user-b' },
];

const EDITABLE_PORTAL_SETTING_DEFINITIONS = [
  { key: 'dockerImage', type: 'string' },
  { key: 'imageVersion', type: 'string' },
  { key: 'usersDataRoot', type: 'string' },
  { key: 'baseDomain', type: 'string' },
  { key: 'publicScheme', type: 'string', allowedValues: ['http', 'https'] },
  { key: 'idleTimeoutMs', type: 'integer', min: 1000 },
  { key: 'stopGracePeriodMs', type: 'integer', min: 0 },
  { key: 'resetPasswordTtlMs', type: 'integer', min: 1000 },
  { key: 'containerStopTimeoutSeconds', type: 'integer', min: 1 },
  { key: 'containerMemoryBytes', type: 'integer', min: 16 * 1024 * 1024 },
  { key: 'containerNanoCpus', type: 'integer', min: 1 },
  { key: 'containerPidsLimit', type: 'integer', min: 1 },
  { key: 'containerUser', type: 'string' },
  { key: 'containerDataMountPath', type: 'string' },
];

const EDITABLE_PORTAL_SETTING_KEYS = new Set(EDITABLE_PORTAL_SETTING_DEFINITIONS.map((definition) => definition.key));

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

function editableSettingDefaults(config) {
  return Object.fromEntries(
    EDITABLE_PORTAL_SETTING_DEFINITIONS.map((definition) => [definition.key, config[definition.key]])
  );
}

function normalizePortalSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('Portal settings must be an object');
  }

  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    if (!EDITABLE_PORTAL_SETTING_KEYS.has(key)) {
      throw new Error(`Unknown portal setting: ${key}`);
    }

    const definition = EDITABLE_PORTAL_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (definition.type === 'string') {
      const stringValue = String(value || '').trim();
      if (!stringValue) {
        throw new Error(`Portal setting ${key} must not be empty`);
      }
      if (definition.allowedValues && !definition.allowedValues.includes(stringValue)) {
        throw new Error(`Portal setting ${key} must be one of: ${definition.allowedValues.join(', ')}`);
      }
      normalized[key] = stringValue;
      continue;
    }

    const integerValue = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isSafeInteger(integerValue) || integerValue < definition.min) {
      throw new Error(`Portal setting ${key} must be an integer greater than or equal to ${definition.min}`);
    }
    normalized[key] = integerValue;
  }

  return normalized;
}

function applyPortalSettings(config, settings = {}) {
  const normalizedSettings = normalizePortalSettings(settings);
  const runtimeConfig = {
    ...config,
    ...normalizedSettings,
  };

  runtimeConfig.userDataPathFor = (userId) => path.join(runtimeConfig.usersDataRoot, userId);
  runtimeConfig.instanceInternalUrlFor = (containerName) => `http://${containerName}:${runtimeConfig.containerPort}`;

  return runtimeConfig;
}

/**
 * Builds runtime configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} env Environment values.
 * @returns {object} Portal runtime configuration.
 */
function getPortalConfig(env = process.env) {
  const usersDataRoot = env.AIONUI_USERS_DATA_ROOT || '/data/users';
  const baseDomain = env.AIONUI_BASE_DOMAIN || 'aionui.local';
  const containerPort = parseInteger(env.AIONUI_CONTAINER_PORT, 25808);
  const dockerImage = env.AIONUI_WEB_IMAGE || 'your-registry.local/aionui-web:v1.0';
  const portalTicketSecret = env.AIONUI_PORTAL_TICKET_SECRET || 'development-only-ticket-secret';

  return {
    port: parseInteger(env.AIONUI_PORTAL_PORT, 8085),
    databasePath: env.AIONUI_PORTAL_DB_PATH || '/data/portal/portal.sqlite',
    adminStaticDir: env.AIONUI_PORTAL_ADMIN_STATIC_DIR || path.join(__dirname, '../dist/admin'),
    defaultUsers: parseDefaultUsers(env.AIONUI_PORTAL_USERS_JSON),
    dockerImage,
    imageVersion: env.AIONUI_WEB_IMAGE_VERSION || dockerImage,
    dockerNetwork: env.AIONUI_DOCKER_NETWORK || 'aionui-network',
    dockerSocketPath: env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    dockerHost: env.AIONUI_DOCKER_HOST || '',
    dockerPort: parseInteger(env.AIONUI_DOCKER_PORT, 2375),
    dockerProtocol: env.AIONUI_DOCKER_PROTOCOL || 'http',
    usersDataRoot,
    baseDomain,
    publicScheme: env.AIONUI_PUBLIC_SCHEME || 'https',
    portalSessionTtlMs: parseInteger(env.AIONUI_PORTAL_SESSION_TTL_MS, 8 * 60 * 60 * 1000),
    portalTicketTtlSeconds: parseInteger(env.AIONUI_PORTAL_TICKET_TTL_SECONDS, 60),
    portalTicketSecret,
    portalControlSecret: env.AIONUI_PORTAL_CONTROL_SECRET || 'development-only-control-secret',
    adminToken: env.AIONUI_PORTAL_ADMIN_TOKEN || 'development-only-admin-token',
    allowedOrigins: parseList(env.AIONUI_PORTAL_ALLOWED_ORIGINS),
    idleTimeoutMs: parseInteger(env.AIONUI_IDLE_TIMEOUT_MS, 30 * 60 * 1000),
    cleanupIntervalMs: parseInteger(env.AIONUI_CLEANUP_INTERVAL_MS, 60 * 1000),
    stopGracePeriodMs: parseInteger(env.AIONUI_STOP_GRACE_PERIOD_MS, 5 * 60 * 1000),
    resetPasswordTtlMs: parseInteger(env.AIONUI_RESET_PASSWORD_TTL_MS, 10 * 60 * 1000),
    containerStopTimeoutSeconds: parseInteger(env.AIONUI_CONTAINER_STOP_TIMEOUT_SECONDS, 30),
    containerMemoryBytes: parseInteger(env.AIONUI_CONTAINER_MEMORY_BYTES, 2 * 1024 * 1024 * 1024),
    containerNanoCpus: parseInteger(env.AIONUI_CONTAINER_NANO_CPUS, 1000000000),
    containerPidsLimit: parseInteger(env.AIONUI_CONTAINER_PIDS_LIMIT, 512),
    containerUser: env.AIONUI_CONTAINER_USER || '1000:1000',
    containerDataMountPath: env.AIONUI_CONTAINER_DATA_PATH || '/app/data',
    containerPort,
    userDataPathFor(userId) {
      return path.join(usersDataRoot, userId);
    },
    instanceInternalUrlFor(containerName) {
      return `http://${containerName}:${containerPort}`;
    },
  };
}

module.exports = {
  EDITABLE_PORTAL_SETTING_DEFINITIONS,
  applyPortalSettings,
  editableSettingDefaults,
  getPortalConfig,
  normalizePortalSettings,
};
