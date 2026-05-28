const Docker = require('dockerode');

const { createPortalApp, cleanupIdleContainers } = require('./src/app');
const { getPortalConfig } = require('./src/config');
const { createPortalRepository } = require('./src/repository');

const config = getPortalConfig();
const docker = new Docker({ socketPath: config.dockerSocketPath });
const repository = createPortalRepository({
  databasePath: config.databasePath,
  defaultUsers: config.defaultUsers,
});
const app = createPortalApp({ repository, docker, config });

const cleanupTimer = setInterval(() => {
  cleanupIdleContainers({ repository, docker, config }).catch((error) => {
    console.error('[Cron] Idle cleanup failed:', error);
  });
}, config.cleanupIntervalMs);

const server = app.listen(config.port, () => {
  console.log(`[Portal] AIonUI portal is listening on port ${config.port}.`);
  console.log(`[Portal] SQLite database: ${config.databasePath}`);
});

function shutdown() {
  clearInterval(cleanupTimer);
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
