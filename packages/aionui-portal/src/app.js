const Express = require('express');
const fs = require('node:fs');

function buildContainerName(userId) {
  return `aionui-${userId}`;
}

function buildTraefikLabels(containerName, userId, containerPort) {
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${containerName}.rule`]: `PathPrefix(\`/${userId}\`)`,
    [`traefik.http.routers.${containerName}.entrypoints`]: 'web',
    [`traefik.http.middlewares.${containerName}-strip.stripprefix.forceslash`]: 'true',
    [`traefik.http.middlewares.${containerName}-strip.stripprefix.prefixes`]: `/${userId}`,
    [`traefik.http.routers.${containerName}.middlewares`]: `${containerName}-strip`,
    [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(containerPort),
  };
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function ensureUserContainer({ docker, config, userId, logger }) {
  const containerName = buildContainerName(userId);
  const hostDataPath = config.userDataPathFor(userId);

  fs.mkdirSync(hostDataPath, { recursive: true });

  const existingContainer = docker.getContainer(containerName);
  try {
    const data = await existingContainer.inspect();

    if (!data.State.Running) {
      await existingContainer.start();
      logger.log(`[Portal] Resumed existing container: ${containerName}`);
    }

    return { containerName, hostDataPath };
  } catch {
    logger.log(`[Portal] Creating container for user ${userId}...`);

    const container = await docker.createContainer({
      Image: config.dockerImage,
      name: containerName,
      Env: [`AIONUI_DATA_DIR=${config.containerDataMountPath}`],
      HostConfig: {
        NetworkMode: config.dockerNetwork,
        Binds: [`${hostDataPath}:${config.containerDataMountPath}`],
        Memory: config.containerMemoryBytes,
        NanoCpus: config.containerNanoCpus,
      },
      Labels: buildTraefikLabels(containerName, userId, config.containerPort),
    });

    await container.start();
    logger.log(`[Portal] Created and started container: ${containerName}`);

    return { containerName, hostDataPath };
  }
}

/**
 * Creates the portal HTTP application.
 *
 * @param {object} dependencies Application dependencies.
 * @returns {import('express').Express} Express app.
 */
function createPortalApp({ repository, docker, config, logger = console, now = () => Date.now() }) {
  const app = Express();
  app.use(Express.json());

  app.post(
    '/api/login-and-resume',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      const user = repository.authenticateUser(username, password);

      if (!user) {
        return res.status(401).json({ success: false, message: '用户名或密码错误' });
      }

      try {
        const { containerName, hostDataPath } = await ensureUserContainer({
          docker,
          config,
          userId: user.id,
          logger,
        });

        repository.touchSession({
          userId: user.id,
          containerName,
          hostDataPath,
          now: now(),
        });

        return res.json({ success: true, redirectUrl: `/${user.id}/` });
      } catch (error) {
        logger.error('[Portal] Docker operation failed:', error);
        return res.status(500).json({ success: false, message: '沙箱环境拉起失败' });
      }
    })
  );

  app.post('/api/heartbeat', (req, res) => {
    const { userId } = req.body || {};

    if (userId && repository.touchExistingSession(userId, now())) {
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false });
  });

  return app;
}

/**
 * Stops containers that have exceeded the idle timeout.
 *
 * @param {object} dependencies Cleanup dependencies.
 * @returns {Promise<void>} Resolves when the cleanup pass completes.
 */
async function cleanupIdleContainers({ repository, docker, config, logger = console, now = () => Date.now() }) {
  const currentTime = now();
  const sessions = repository.listActiveSessions();
  logger.log(`[Cron] Inspecting idle containers. Tracked sessions: ${sessions.length}`);

  const staleSessions = sessions.filter((session) => currentTime - session.lastActiveAt > config.idleTimeoutMs);

  await Promise.all(
    staleSessions.map(async (session) => {
      const container = docker.getContainer(session.containerName);

      try {
        const data = await container.inspect();
        if (data.State.Running) {
          logger.log(`[Cron] User [${session.userId}] is idle. Stopping ${session.containerName}...`);
          await container.stop();
          logger.log(`[Cron] Container stopped: ${session.containerName}`);
        }
      } catch (error) {
        logger.warn(`[Cron] Failed to inspect or stop ${session.containerName}; marking it stopped.`, error);
      } finally {
        repository.markSessionStopped(session.userId);
      }
    })
  );
}

module.exports = { createPortalApp, cleanupIdleContainers };
