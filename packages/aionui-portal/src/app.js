const crypto = require('node:crypto');
const Express = require('express');
const fs = require('node:fs');

const { buildSessionCookie, parseCookies, SESSION_COOKIE_NAME, signPortalTicket } = require('./auth');
const { applyPortalSettings, editableSettingDefaults, normalizePortalSettings } = require('./config');

const startFlights = new Map();

function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'user';
}

function buildContainerName(userId) {
  return `aionui-${slugify(userId)}`;
}

function buildInstanceUrl(config, subdomain) {
  return `${config.publicScheme}://${subdomain}.${config.baseDomain}`;
}

function buildTraefikLabels({ containerName, subdomain, instanceId, portalUserId, config }) {
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${containerName}.rule`]: `Host(\`${subdomain}.${config.baseDomain}\`)`,
    [`traefik.http.routers.${containerName}.entrypoints`]: 'websecure',
    [`traefik.http.routers.${containerName}.tls`]: 'true',
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(config.containerPort),
    'aionui.managed': 'true',
    'aionui.instance-id': instanceId,
    'aionui.portal-user-id': portalUserId,
    'aionui.subdomain': subdomain,
    'aionui.image-version': config.imageVersion,
  };
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function success(res, data) {
  return res.json({ success: true, data });
}

function failure(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function getPortalUser(req, repository, now) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  return repository.authenticatePortalSession(token, now);
}

function requestIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
}

function isAllowedOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins?.includes(origin)) return true;

  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch {
    return false;
  }
}

function resourceLimits(config) {
  return {
    cpu: config.containerNanoCpus / 1_000_000_000,
    memoryMiB: Math.round(config.containerMemoryBytes / 1024 / 1024),
  };
}

function withAdminInstanceMetadata(session, config) {
  if (!session) return null;
  return {
    ...session,
    dataPath: session.hostDataPath,
    resourceLimits: resourceLimits(config),
  };
}

function resolvePortalConfig(repository, config) {
  if (typeof repository.listPortalSettings !== 'function') {
    return config;
  }
  const settings = repository.listPortalSettings();
  if (Object.keys(settings).length === 0) {
    return config;
  }
  return applyPortalSettings(config, settings);
}

function listUsersWithAdminMetadata(repository, config) {
  const users = repository.listUsers();
  for (const user of users) {
    user.instance = withAdminInstanceMetadata(user.instance, config);
  }
  return users;
}

function createLoginTicket({ userId, instanceId, config, now }) {
  const exp = Math.floor(now / 1000) + config.portalTicketTtlSeconds;
  return signPortalTicket(
    {
      sub: userId,
      instanceId,
      aud: 'aionui-instance-login',
      exp,
      jti: crypto.randomUUID(),
    },
    config.portalTicketSecret
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDefaultReadinessProbe() {
  return {
    async waitUntilReady({ instanceUrl, timeoutMs = 120_000 }) {
      const deadline = Date.now() + timeoutMs;
      const readiness = {
        containerStarted: true,
        webListening: false,
        backendHealthy: false,
      };

      async function poll() {
        if (Date.now() >= deadline) return readiness;

        try {
          const webResponse = await fetchWithTimeout(instanceUrl, {}, 2000);
          readiness.webListening = webResponse.status < 500;
        } catch {
          readiness.webListening = false;
        }

        if (readiness.webListening) {
          try {
            const healthResponse = await fetchWithTimeout(`${instanceUrl}/health`, {}, 2000);
            readiness.backendHealthy = healthResponse.ok;
          } catch {
            readiness.backendHealthy = false;
          }
        }

        if (readiness.backendHealthy) return readiness;
        await sleep(1000);
        return poll();
      }

      return poll();
    },
  };
}

function buildControlPlaneHeaders(config, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (config.portalControlSecret) {
    headers.authorization = `Bearer ${config.portalControlSecret}`;
  }
  return headers;
}

function createDefaultInstanceClient(config) {
  return {
    async ensureUser({ instanceUrl, portalUserId, portalProvider, displayName, role }) {
      const response = await fetchWithTimeout(
        `${instanceUrl}/api/internal/portal/ensure-user`,
        {
          method: 'POST',
          headers: buildControlPlaneHeaders(config, { 'content-type': 'application/json' }),
          body: JSON.stringify({ portalUserId, portalProvider, displayName, role }),
        },
        5000
      );
      if (!response.ok) {
        throw new Error(`ensure-user failed with ${response.status}`);
      }
      return response.json();
    },
    async getRuntimeStatus({ instanceUrl }) {
      const response = await fetchWithTimeout(
        `${instanceUrl}/api/internal/portal/runtime-status`,
        { headers: buildControlPlaneHeaders(config) },
        3000
      );
      if (!response.ok) {
        throw new Error(`runtime-status failed with ${response.status}`);
      }
      const payload = await response.json();
      return payload.data || payload;
    },
    async resetPassword({ instanceUrl }) {
      const response = await fetchWithTimeout(
        `${instanceUrl}/api/webui/reset-password`,
        {
          method: 'POST',
          headers: buildControlPlaneHeaders(config, { 'content-type': 'application/json' }),
        },
        5000
      );
      if (!response.ok) {
        throw new Error(`reset-password failed with ${response.status}`);
      }
      const payload = await response.json();
      const data = payload.data || payload;
      return {
        temporaryPassword: data.temporaryPassword || data.temporary_password || data.new_password,
      };
    },
  };
}

async function ensureUserContainer({ docker, config, userId, logger }) {
  const subdomain = slugify(userId);
  const containerName = buildContainerName(userId);
  const hostDataPath = config.userDataPathFor(subdomain);
  const instanceId = `inst_${subdomain.replaceAll('-', '_')}`;

  fs.mkdirSync(hostDataPath, { recursive: true });

  const existingContainer = docker.getContainer(containerName);
  try {
    const data = await existingContainer.inspect();

    if (!data.State.Running) {
      await existingContainer.start();
      logger.log(`[Portal] Resumed existing container: ${containerName}`);
    }

    return { containerName, hostDataPath, instanceId, subdomain };
  } catch {
    logger.log(`[Portal] Creating container for user ${userId}...`);

    const container = await docker.createContainer({
      Image: config.dockerImage,
      name: containerName,
      User: config.containerUser,
      Env: [
        'AIONUI_SERVER_RUNTIME=1',
        `AIONUI_DATA_DIR=${config.containerDataMountPath}`,
        `AIONUI_INSTANCE_ID=${instanceId}`,
        'AIONUI_PORTAL_PROVIDER=aionui-portal',
        `AIONUI_PORTAL_CONTROL_SECRET=${config.portalControlSecret}`,
        `AIONUI_PORTAL_TICKET_SECRET=${config.portalTicketSecret}`,
      ],
      HostConfig: {
        NetworkMode: config.dockerNetwork,
        Binds: [`${hostDataPath}:${config.containerDataMountPath}`],
        Memory: config.containerMemoryBytes,
        NanoCpus: config.containerNanoCpus,
        PidsLimit: config.containerPidsLimit,
        CapDrop: ['ALL'],
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: buildTraefikLabels({
        containerName,
        subdomain,
        instanceId,
        portalUserId: userId,
        config,
      }),
    });

    await container.start();
    logger.log(`[Portal] Created and started container: ${containerName}`);

    return { containerName, hostDataPath, instanceId, subdomain };
  }
}

async function startUserInstance({ repository, docker, config, logger, readinessProbe, instanceClient, user, now }) {
  const key = user.id;
  const existingFlight = startFlights.get(key);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    const { containerName, hostDataPath, instanceId, subdomain } = await ensureUserContainer({
      docker,
      config,
      userId: user.id,
      logger,
    });
    const instanceUrl = config.instanceInternalUrlFor(containerName);
    const readiness = await readinessProbe.waitUntilReady({ instanceUrl });
    const publicUrl = buildInstanceUrl(config, subdomain);

    if (!readiness.backendHealthy) {
      repository.touchSession({
        userId: user.id,
        containerName,
        hostDataPath,
        subdomain,
        url: publicUrl,
        status: 'starting_timeout',
        readiness,
        imageVersion: config.imageVersion,
        failureReason: 'backend_health_timeout',
        now,
      });
      return { containerName, hostDataPath, instanceId, subdomain, publicUrl, readiness, status: 'starting_timeout' };
    }

    await instanceClient.ensureUser({
      instanceUrl,
      portalUserId: user.id,
      portalProvider: 'aionui-portal',
      displayName: user.id,
      role: 'admin',
    });

    repository.touchSession({
      userId: user.id,
      containerName,
      hostDataPath,
      subdomain,
      url: publicUrl,
      status: 'running',
      readiness,
      imageVersion: config.imageVersion,
      now,
    });

    return { containerName, hostDataPath, instanceId, subdomain, publicUrl, readiness, status: 'running' };
  })();

  startFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    startFlights.delete(key);
  }
}

/**
 * Creates the portal HTTP application.
 *
 * @param {object} dependencies Application dependencies.
 * @returns {import('express').Express} Express app.
 */
function createPortalApp({
  repository,
  docker,
  config,
  logger = console,
  now = () => Date.now(),
  readinessProbe = createDefaultReadinessProbe(),
  instanceClient,
}) {
  const app = Express();
  app.use(Express.json());
  const runtimeInstanceClient = instanceClient || createDefaultInstanceClient(config);
  const runtimeConfig = () => resolvePortalConfig(repository, config);

  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }
    if (!isAllowedOrigin(req, config)) {
      return failure(res, 403, 'FORBIDDEN', 'Origin is not allowed');
    }
    return next();
  });

  function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${config.adminToken}`) {
      return failure(res, 401, 'UNAUTHORIZED', 'Admin authorization required');
    }
    return next();
  }

  app.post(
    '/api/login-and-resume',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      const user = repository.authenticateUser(username, password);

      if (!user) {
        return failure(res, 401, 'UNAUTHORIZED', 'Invalid username or password');
      }

      try {
        const currentTime = now();
        const sessionToken = repository.createPortalSession({
          userId: user.id,
          now: currentTime,
          ttlMs: config.portalSessionTtlMs,
        });
        const activeConfig = runtimeConfig();
        const instance = await startUserInstance({
          repository,
          docker,
          config: activeConfig,
          logger,
          readinessProbe,
          instanceClient: runtimeInstanceClient,
          user,
          now: currentTime,
        });

        if (instance.status !== 'running') {
          return failure(res, 503, 'INSTANCE_NOT_READY', 'Instance is not ready');
        }

        const ticket = createLoginTicket({
          userId: user.id,
          instanceId: instance.instanceId,
          config: activeConfig,
          now: currentTime,
        });
        const loginUrl = `${instance.publicUrl}/auth/portal/callback?ticket=${encodeURIComponent(ticket)}`;
        res.setHeader('set-cookie', buildSessionCookie(sessionToken, config.portalSessionTtlMs / 1000));
        return success(res, {
          userId: user.id,
          instanceId: instance.instanceId,
          status: instance.status,
          url: instance.publicUrl,
          loginUrl,
          readiness: instance.readiness,
        });
      } catch (error) {
        logger.error('[Portal] Docker operation failed:', error);
        return failure(res, 500, 'RUNTIME_UNAVAILABLE', 'Instance start failed');
      }
    })
  );

  app.get('/api/instances/me', (req, res) => {
    const user = getPortalUser(req, repository, now());
    if (!user) return failure(res, 401, 'UNAUTHORIZED', 'Login required');

    const session = repository.getSession(user.id);
    if (!session) return failure(res, 404, 'INSTANCE_NOT_FOUND', 'Instance not found');

    const data = { ...session };
    if (req.query.enter === 'true' && session.status === 'running') {
      const activeConfig = runtimeConfig();
      const ticket = createLoginTicket({
        userId: user.id,
        instanceId: session.instanceId,
        config: activeConfig,
        now: now(),
      });
      data.loginUrl = `${session.url}/auth/portal/callback?ticket=${encodeURIComponent(ticket)}`;
    }
    return success(res, data);
  });

  app.get('/api/admin/instances/:userId', requireAdmin, (req, res) => {
    const session = repository.getSession(req.params.userId);
    if (!session) return failure(res, 404, 'INSTANCE_NOT_FOUND', 'Instance not found');
    return success(res, withAdminInstanceMetadata(session, runtimeConfig()));
  });

  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    return success(res, listUsersWithAdminMetadata(repository, runtimeConfig()));
  });

  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const { username, password, userId, displayName } = req.body || {};
    const currentTime = now();
    if (!username || !password || !userId) {
      repository.recordAuditLog({
        actorId: 'admin',
        action: 'admin.users.create',
        targetUserId: userId || null,
        sourceIp: requestIp(req),
        result: 'failed',
        reason: 'missing_required_fields',
        errorCode: 'BAD_REQUEST',
        now: currentTime,
      });
      return failure(res, 400, 'BAD_REQUEST', 'username, password and userId are required');
    }

    try {
      const user = repository.createUser({
        username: String(username),
        password: String(password),
        userId: String(userId),
        displayName: displayName ? String(displayName) : String(username),
        now: currentTime,
      });
      repository.recordAuditLog({
        actorId: 'admin',
        action: 'admin.users.create',
        targetUserId: user.userId,
        sourceIp: requestIp(req),
        result: 'success',
        now: currentTime,
      });
      return success(res, user);
    } catch (error) {
      repository.recordAuditLog({
        actorId: 'admin',
        action: 'admin.users.create',
        targetUserId: String(userId),
        sourceIp: requestIp(req),
        result: 'failed',
        reason: error.message,
        errorCode: 'USER_CREATE_FAILED',
        now: currentTime,
      });
      return failure(res, 409, 'USER_CREATE_FAILED', 'User could not be created');
    }
  });

  app.get('/api/admin/audit-logs', requireAdmin, (_req, res) => {
    return success(res, repository.listAuditLogs());
  });

  app.get('/api/admin/settings', requireAdmin, (_req, res) => {
    return success(res, {
      defaults: editableSettingDefaults(config),
      values: editableSettingDefaults(runtimeConfig()),
    });
  });

  app.put('/api/admin/settings', requireAdmin, (req, res) => {
    try {
      const currentTime = now();
      const settings = normalizePortalSettings(req.body?.values || req.body || {});
      repository.savePortalSettings(settings, currentTime);
      repository.recordAuditLog({
        actorId: 'admin',
        action: 'admin.settings.update',
        sourceIp: requestIp(req),
        result: 'success',
        reason: Object.keys(settings).toSorted().join(','),
        now: currentTime,
      });
      return success(res, {
        defaults: editableSettingDefaults(config),
        values: editableSettingDefaults(runtimeConfig()),
      });
    } catch (error) {
      return failure(res, 400, 'BAD_REQUEST', error.message);
    }
  });

  app.post(
    '/api/admin/instances/:userId/start',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const currentTime = now();
      const userId = req.params.userId;
      const user = { id: userId };
      try {
        const activeConfig = runtimeConfig();
        const instance = await startUserInstance({
          repository,
          docker,
          config: activeConfig,
          logger,
          readinessProbe,
          instanceClient: runtimeInstanceClient,
          user,
          now: currentTime,
        });
        const result = instance.status === 'running' ? 'success' : 'failed';
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.start',
          targetUserId: userId,
          targetInstanceId: instance.instanceId,
          sourceIp: requestIp(req),
          result,
          reason: req.body?.reason || null,
          errorCode: result === 'success' ? null : 'INSTANCE_NOT_READY',
          now: currentTime,
        });
        if (instance.status !== 'running') {
          return failure(res, 503, 'INSTANCE_NOT_READY', 'Instance is not ready');
        }
        return success(res, {
          userId,
          instanceId: instance.instanceId,
          status: instance.status,
          url: instance.publicUrl,
        });
      } catch (error) {
        logger.error('[Portal] Admin start failed:', error);
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.start',
          targetUserId: userId,
          sourceIp: requestIp(req),
          result: 'failed',
          reason: req.body?.reason || null,
          errorCode: 'RUNTIME_UNAVAILABLE',
          now: currentTime,
        });
        return failure(res, 500, 'RUNTIME_UNAVAILABLE', 'Instance start failed');
      }
    })
  );

  app.post(
    '/api/admin/instances/:userId/stop',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const currentTime = now();
      const userId = req.params.userId;
      const session = repository.getSession(userId);
      if (!session || session.status === 'stopped') {
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.stop',
          targetUserId: userId,
          targetInstanceId: session?.instanceId || null,
          sourceIp: requestIp(req),
          result: 'success',
          reason: req.body?.reason || null,
          now: currentTime,
        });
        return success(res, { instanceId: session?.instanceId || null, status: 'stopped' });
      }

      const force = req.body?.force === true;
      const activeConfig = runtimeConfig();
      if (!force) {
        const runtimeStatus = await runtimeInstanceClient.getRuntimeStatus({
          instanceUrl: activeConfig.instanceInternalUrlFor(session.containerName),
        });
        if ((runtimeStatus.runningTaskCount || 0) > 0) {
          repository.recordAuditLog({
            actorId: 'admin',
            action: 'admin.instances.stop',
            targetUserId: userId,
            targetInstanceId: session.instanceId,
            sourceIp: requestIp(req),
            result: 'failed',
            reason: req.body?.reason || null,
            errorCode: 'INSTANCE_NOT_READY',
            now: currentTime,
          });
          return failure(res, 409, 'INSTANCE_NOT_READY', 'Instance has running tasks');
        }
      }

      const container = docker.getContainer(session.containerName);
      await container.stop({ t: activeConfig.containerStopTimeoutSeconds });
      repository.markSessionStopped(userId, currentTime);
      repository.recordAuditLog({
        actorId: 'admin',
        action: 'admin.instances.stop',
        targetUserId: userId,
        targetInstanceId: session.instanceId,
        sourceIp: requestIp(req),
        result: 'success',
        reason: req.body?.reason || null,
        now: currentTime,
      });
      return success(res, { instanceId: session.instanceId, status: 'stopped' });
    })
  );

  app.post(
    '/api/admin/instances/:userId/reset-password',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const currentTime = now();
      const userId = req.params.userId;
      const session = repository.getSession(userId);
      if (!session || session.status !== 'running') {
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.reset-password',
          targetUserId: userId,
          targetInstanceId: session?.instanceId || null,
          sourceIp: requestIp(req),
          result: 'failed',
          reason: req.body?.reason || null,
          errorCode: 'INSTANCE_NOT_READY',
          now: currentTime,
        });
        return failure(res, 409, 'INSTANCE_NOT_READY', 'Instance must be running to reset password');
      }

      try {
        const activeConfig = runtimeConfig();
        const reset = await runtimeInstanceClient.resetPassword({
          instanceUrl: activeConfig.instanceInternalUrlFor(session.containerName),
        });
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.reset-password',
          targetUserId: userId,
          targetInstanceId: session.instanceId,
          sourceIp: requestIp(req),
          result: 'success',
          reason: req.body?.reason || null,
          now: currentTime,
        });
        return success(res, {
          userId,
          temporaryPassword: reset.temporaryPassword,
          expiresAt: new Date(currentTime + activeConfig.resetPasswordTtlMs).toISOString(),
        });
      } catch (error) {
        repository.recordAuditLog({
          actorId: 'admin',
          action: 'admin.instances.reset-password',
          targetUserId: userId,
          targetInstanceId: session.instanceId,
          sourceIp: requestIp(req),
          result: 'failed',
          reason: req.body?.reason || error.message,
          errorCode: 'RESET_PASSWORD_FAILED',
          now: currentTime,
        });
        return failure(res, 500, 'RESET_PASSWORD_FAILED', 'Password reset failed');
      }
    })
  );

  app.post(
    '/api/instances/me/stop',
    asyncHandler(async (req, res) => {
      const user = getPortalUser(req, repository, now());
      if (!user) return failure(res, 401, 'UNAUTHORIZED', 'Login required');

      const session = repository.getSession(user.id);
      if (!session || session.status === 'stopped') {
        return success(res, { instanceId: session?.instanceId || null, status: 'stopped' });
      }

      const activeConfig = runtimeConfig();
      const runtimeStatus = await runtimeInstanceClient.getRuntimeStatus({
        instanceUrl: activeConfig.instanceInternalUrlFor(session.containerName),
      });
      if ((runtimeStatus.runningTaskCount || 0) > 0) {
        return failure(res, 409, 'INSTANCE_NOT_READY', 'Instance has running tasks');
      }

      const container = docker.getContainer(session.containerName);
      await container.stop({ t: activeConfig.containerStopTimeoutSeconds });
      repository.markSessionStopped(user.id, now());
      return success(res, { instanceId: session.instanceId, status: 'stopped' });
    })
  );

  app.post('/api/heartbeat', (req, res) => {
    const user = getPortalUser(req, repository, now());
    if (!user) return failure(res, 401, 'UNAUTHORIZED', 'Login required');

    const currentTime = now();
    if (repository.touchExistingSession(user.id, currentTime)) {
      return success(res, { lastActiveAt: new Date(currentTime).toISOString() });
    }

    return failure(res, 404, 'INSTANCE_NOT_FOUND', 'Instance not found');
  });

  if (config.adminStaticDir && fs.existsSync(config.adminStaticDir)) {
    app.use(Express.static(config.adminStaticDir));
    app.get(['/', /^\/admin(?:\/.*)?$/], (_req, res) => {
      res.sendFile(`${config.adminStaticDir}/index.html`);
    });
  }

  return app;
}

/**
 * Stops containers that have exceeded the idle timeout.
 *
 * @param {object} dependencies Cleanup dependencies.
 * @returns {Promise<void>} Resolves when the cleanup pass completes.
 */
async function cleanupIdleContainers({
  repository,
  docker,
  config,
  logger = console,
  now = () => Date.now(),
  instanceClient,
}) {
  const currentTime = now();
  const activeConfig = resolvePortalConfig(repository, config);
  const runtimeInstanceClient = instanceClient || createDefaultInstanceClient(config);
  const sessions = repository.listActiveSessions();
  logger.log(`[Cron] Inspecting idle containers. Tracked sessions: ${sessions.length}`);

  const staleSessions = sessions.filter(
    (session) => currentTime - session.lastActiveAt > activeConfig.idleTimeoutMs + activeConfig.stopGracePeriodMs
  );

  await Promise.all(
    staleSessions.map(async (session) => {
      const container = docker.getContainer(session.containerName);
      let stopped = false;

      try {
        const runtimeStatus = await runtimeInstanceClient.getRuntimeStatus({
          instanceUrl: activeConfig.instanceInternalUrlFor(session.containerName),
        });
        if ((runtimeStatus.runningTaskCount || 0) > 0) {
          logger.log(`[Cron] User [${session.userId}] has running tasks. Skipping idle stop.`);
          return;
        }

        const data = await container.inspect();
        if (data.State.Running) {
          logger.log(`[Cron] User [${session.userId}] is idle. Stopping ${session.containerName}...`);
          await container.stop({ t: activeConfig.containerStopTimeoutSeconds });
          stopped = true;
          logger.log(`[Cron] Container stopped: ${session.containerName}`);
        } else {
          stopped = true;
        }
      } catch (error) {
        logger.warn(`[Cron] Failed to inspect or stop ${session.containerName}; marking it stopped.`, error);
        stopped = true;
      } finally {
        if (stopped) repository.markSessionStopped(session.userId, currentTime);
      }
    })
  );
}

module.exports = {
  buildContainerName,
  buildTraefikLabels,
  cleanupIdleContainers,
  createPortalApp,
  slugify,
};
