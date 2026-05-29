import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { cleanupIdleContainers, createPortalApp } = require('../../packages/aionui-portal/src/app.js');
const { getPortalConfig } = require('../../packages/aionui-portal/src/config.js');
const { createPortalRepository } = require('../../packages/aionui-portal/src/repository.js');

const tempDirs: string[] = [];

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aionui-portal-app-'));
  tempDirs.push(dir);
  return join(dir, 'portal.sqlite');
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aionui-portal-data-'));
  tempDirs.push(dir);
  return dir;
}

async function listen(app: {
  listen: (port: number, cb: () => void) => { address: () => unknown; close: (cb: () => void) => void };
}): Promise<TestServer> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const bound = app.listen(0, () => resolve(bound));
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createFakeDocker() {
  const createdContainers: Array<{
    Image: string;
    name: string;
    Env?: string[];
    User?: string;
    HostConfig: Record<string, unknown>;
    Labels: Record<string, string>;
  }> = [];
  const running = new Set<string>();

  return {
    createdContainers,
    getContainer(name: string) {
      return {
        async inspect() {
          if (!running.has(name)) {
            throw new Error('not found');
          }
          return { State: { Running: true } };
        },
        async start() {
          running.add(name);
        },
        async stop() {
          running.delete(name);
        },
      };
    },
    async createContainer(options: {
      Image: string;
      name: string;
      Env?: string[];
      User?: string;
      HostConfig: Record<string, unknown>;
      Labels: Record<string, string>;
    }) {
      createdContainers.push(options);
      return {
        async start() {
          running.add(options.name);
        },
      };
    },
  };
}

describe('aionui portal app', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a user instance with subdomain routing, hardening, readiness, and a login ticket URL', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'User A' }],
    });
    const docker = createFakeDocker();
    const config = getPortalConfig({
      AIONUI_PORTAL_DB_PATH: createTempDbPath(),
      AIONUI_PORTAL_USERS_JSON: '[]',
      AIONUI_USERS_DATA_ROOT: createTempDir(),
      AIONUI_BASE_DOMAIN: 'aionui.local',
      AIONUI_PORTAL_TICKET_SECRET: 'test-secret',
      AIONUI_PORTAL_CONTROL_SECRET: 'control-secret',
      AIONUI_WEB_IMAGE: 'registry.local/aionui-web:v1.2.3',
      AIONUI_WEB_IMAGE_VERSION: 'v1.2.3',
    });
    const readinessProbe = {
      waitUntilReady: vi.fn(async () => ({
        containerStarted: true,
        webListening: true,
        backendHealthy: true,
      })),
    };
    const instanceClient = {
      ensureUser: vi.fn(async () => ({ localUserId: 'local-user-a', portalUserId: 'User A', created: true })),
    };
    const app = createPortalApp({
      repository,
      docker,
      config,
      readinessProbe,
      instanceClient,
      now: () => 1000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const response = await fetch(`${server.baseUrl}/api/login-and-resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'userA', password: 'password123' }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { userId: string; instanceId: string; status: string; url: string; loginUrl: string };
      };

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toMatch(/aionui_portal_session=/);
      expect(payload).toMatchObject({
        success: true,
        data: {
          userId: 'User A',
          instanceId: 'inst_user_a',
          status: 'running',
          url: 'https://user-a.aionui.local',
        },
      });
      expect(payload.data.loginUrl).toMatch(/^https:\/\/user-a\.aionui\.local\/auth\/portal\/callback\?ticket=/);
      expect(readinessProbe.waitUntilReady).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceUrl: 'http://aionui-user-a:25808',
        })
      );
      expect(instanceClient.ensureUser).toHaveBeenCalledWith(
        expect.objectContaining({
          portalUserId: 'User A',
          role: 'admin',
        })
      );

      const containerOptions = docker.createdContainers[0];
      expect(containerOptions.Labels).toMatchObject({
        'traefik.enable': 'true',
        'traefik.http.routers.aionui-user-a.rule': 'Host(`user-a.aionui.local`)',
        'aionui.managed': 'true',
        'aionui.instance-id': 'inst_user_a',
        'aionui.portal-user-id': 'User A',
        'aionui.subdomain': 'user-a',
        'aionui.image-version': 'v1.2.3',
      });
      expect(Object.values(containerOptions.Labels).join('\n')).not.toContain('PathPrefix');
      expect(Object.values(containerOptions.Labels).join('\n')).not.toContain('control-secret');
      expect(containerOptions).toMatchObject({
        Image: 'registry.local/aionui-web:v1.2.3',
      });
      expect(containerOptions.Env).toEqual(
        expect.arrayContaining([
          'AIONUI_SERVER_RUNTIME=1',
          'AIONUI_INSTANCE_ID=inst_user_a',
          'AIONUI_PORTAL_PROVIDER=aionui-portal',
          'AIONUI_PORTAL_CONTROL_SECRET=control-secret',
          'AIONUI_PORTAL_TICKET_SECRET=test-secret',
        ])
      );
      expect(containerOptions.HostConfig).toMatchObject({
        CapDrop: ['ALL'],
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
      });
      expect(containerOptions.User).toBe('1000:1000');
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('uses the Portal session identity for heartbeat instead of the request body userId', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a' }],
    });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    const sessionToken = repository.createPortalSession({ userId: 'user-a', now: 1000, ttlMs: 60_000 });
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: getPortalConfig({ AIONUI_PORTAL_USERS_JSON: '[]' }),
      now: () => 2000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const response = await fetch(`${server.baseUrl}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `aionui_portal_session=${sessionToken}`,
        },
        body: JSON.stringify({ userId: 'other-user' }),
      });
      const payload = (await response.json()) as { success: boolean; data: { lastActiveAt: string } };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(repository.getSession('user-a')?.lastActiveAt).toBe(2000);
      expect(repository.getSession('other-user')).toBeNull();
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('calls instance internal APIs with the configured control-plane secret', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const instanceServer = await listen({
      listen(port: number, cb: () => void) {
        const http = require('node:http');
        const server = http.createServer((req, res) => {
          calls.push({
            url: req.url || '',
            authorization: req.headers.authorization || null,
          });
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, data: { runningTaskCount: 0 } }));
        });
        return server.listen(port, cb);
      },
    });
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a' }],
    });
    const docker = createFakeDocker();
    const config = getPortalConfig({
      AIONUI_PORTAL_USERS_JSON: '[]',
      AIONUI_USERS_DATA_ROOT: createTempDir(),
      AIONUI_BASE_DOMAIN: 'aionui.local',
      AIONUI_PORTAL_CONTROL_SECRET: 'control-secret',
      AIONUI_PORTAL_TICKET_SECRET: 'ticket-secret',
      AIONUI_CONTAINER_PORT: '25808',
    });
    config.instanceInternalUrlFor = () => instanceServer.baseUrl;
    const app = createPortalApp({
      repository,
      docker,
      config,
      readinessProbe: {
        waitUntilReady: vi.fn(async () => ({
          containerStarted: true,
          webListening: true,
          backendHealthy: true,
        })),
      },
      now: () => 1000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const portalServer = await listen(app);

    try {
      const response = await fetch(`${portalServer.baseUrl}/api/login-and-resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'userA', password: 'password123' }),
      });

      expect(response.status).toBe(200);
      expect(calls).toEqual([
        {
          url: '/api/internal/portal/ensure-user',
          authorization: 'Bearer control-secret',
        },
      ]);
    } finally {
      await portalServer.close();
      await instanceServer.close();
      repository.close();
    }
  });

  it('requires admin authorization for management APIs and audits successful stops', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [],
    });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: getPortalConfig({
        AIONUI_PORTAL_USERS_JSON: '[]',
        AIONUI_PORTAL_ADMIN_TOKEN: 'admin-token',
      }),
      instanceClient: {
        getRuntimeStatus: vi.fn(async () => ({ runningTaskCount: 0 })),
        ensureUser: vi.fn(),
      },
      now: () => 2000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const unauthorized = await fetch(`${server.baseUrl}/api/admin/instances/user-a`);
      expect(unauthorized.status).toBe(401);

      const details = await fetch(`${server.baseUrl}/api/admin/instances/user-a`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const detailsPayload = (await details.json()) as {
        data: { resourceLimits: { cpu: number; memoryMiB: number }; dataPath: string };
      };
      expect(detailsPayload.data.resourceLimits).toEqual({ cpu: 1, memoryMiB: 2048 });
      expect(detailsPayload.data.dataPath).toBe('/data/users/user-a');

      const response = await fetch(`${server.baseUrl}/api/admin/instances/user-a/stop`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'maintenance' }),
      });
      const payload = (await response.json()) as { success: boolean; data: { status: string } };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ success: true, data: { status: 'stopped' } });
      expect(repository.getSession('user-a')?.status).toBe('stopped');
      expect(repository.listAuditLogs()).toEqual([
        expect.objectContaining({
          actorId: 'admin',
          action: 'admin.instances.stop',
          targetUserId: 'user-a',
          result: 'success',
          reason: 'maintenance',
        }),
      ]);
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('rejects browser write requests from foreign origins', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a' }],
    });
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: getPortalConfig({ AIONUI_PORTAL_USERS_JSON: '[]' }),
      now: () => 1000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const response = await fetch(`${server.baseUrl}/api/login-and-resume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ username: 'userA', password: 'password123' }),
      });
      const payload = (await response.json()) as { code: string };

      expect(response.status).toBe(403);
      expect(payload.code).toBe('FORBIDDEN');
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('resets an instance password through the backend and records break-glass audit', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [],
    });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    const instanceClient = {
      ensureUser: vi.fn(),
      getRuntimeStatus: vi.fn(async () => ({ runningTaskCount: 0 })),
      resetPassword: vi.fn(async () => ({ temporaryPassword: 'temp-secret' })),
    };
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: getPortalConfig({
        AIONUI_PORTAL_USERS_JSON: '[]',
        AIONUI_PORTAL_ADMIN_TOKEN: 'admin-token',
      }),
      instanceClient,
      now: () => 2000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const response = await fetch(`${server.baseUrl}/api/admin/instances/user-a/reset-password`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'break_glass' }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { userId: string; temporaryPassword: string; expiresAt: string };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        data: {
          userId: 'user-a',
          temporaryPassword: 'temp-secret',
        },
      });
      expect(payload.data.expiresAt).toBe(new Date(602000).toISOString());
      expect(instanceClient.resetPassword).toHaveBeenCalledWith({
        instanceUrl: 'http://aionui-user-a:25808',
      });
      expect(repository.listAuditLogs()).toEqual([
        expect.objectContaining({
          action: 'admin.instances.reset-password',
          targetUserId: 'user-a',
          result: 'success',
          reason: 'break_glass',
        }),
      ]);
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('lets admins manage Portal users and read audit logs', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a', displayName: 'User A' }],
    });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: getPortalConfig({
        AIONUI_PORTAL_USERS_JSON: '[]',
        AIONUI_PORTAL_ADMIN_TOKEN: 'admin-token',
      }),
      now: () => 3000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const usersResponse = await fetch(`${server.baseUrl}/api/admin/users`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const usersPayload = (await usersResponse.json()) as {
        success: boolean;
        data: Array<{ userId: string; username: string; displayName: string; instance: { status: string } }>;
      };

      expect(usersResponse.status).toBe(200);
      expect(usersPayload.data).toEqual([
        expect.objectContaining({
          userId: 'user-a',
          username: 'userA',
          displayName: 'User A',
          instance: expect.objectContaining({ status: 'running' }),
        }),
      ]);

      const createResponse = await fetch(`${server.baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          username: 'userB',
          password: 'password456',
          userId: 'user-b',
          displayName: 'User B',
        }),
      });
      expect(createResponse.status).toBe(200);
      expect(repository.authenticateUser('userB', 'password456')).toEqual({ id: 'user-b' });

      const logsResponse = await fetch(`${server.baseUrl}/api/admin/audit-logs`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const logsPayload = (await logsResponse.json()) as {
        success: boolean;
        data: Array<{ action: string; targetUserId: string; result: string }>;
      };
      expect(logsResponse.status).toBe(200);
      expect(logsPayload.data).toEqual([
        expect.objectContaining({
          action: 'admin.users.create',
          targetUserId: 'user-b',
          result: 'success',
        }),
      ]);
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('applies admin runtime settings to newly started containers without restarting the portal', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a', displayName: 'User A' }],
    });
    const docker = createFakeDocker();
    const config = getPortalConfig({
      AIONUI_PORTAL_USERS_JSON: '[]',
      AIONUI_PORTAL_ADMIN_TOKEN: 'admin-token',
      AIONUI_WEB_IMAGE: 'registry.local/aionui-web:v1.0.0',
      AIONUI_WEB_IMAGE_VERSION: 'v1.0.0',
      AIONUI_USERS_DATA_ROOT: createTempDir(),
      AIONUI_BASE_DOMAIN: 'old.example',
    });
    const app = createPortalApp({
      repository,
      docker,
      config,
      readinessProbe: {
        waitUntilReady: vi.fn(async () => ({
          containerStarted: true,
          webListening: true,
          backendHealthy: true,
        })),
      },
      instanceClient: {
        ensureUser: vi.fn(async () => ({ created: true })),
      },
      now: () => 1000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const defaultsResponse = await fetch(`${server.baseUrl}/api/admin/settings`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const defaultsPayload = (await defaultsResponse.json()) as {
        success: boolean;
        data: { values: Record<string, string | number> };
      };
      const nextValues = {
        ...defaultsPayload.data.values,
        dockerImage: 'registry.local/aionui-web:v2.0.0',
        imageVersion: 'v2.0.0',
        baseDomain: 'new.example',
        publicScheme: 'http',
        containerMemoryBytes: 536870912,
        containerNanoCpus: 500000000,
        containerPidsLimit: 256,
      };

      const updateResponse = await fetch(`${server.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ values: nextValues }),
      });
      expect(updateResponse.status).toBe(200);

      const startResponse = await fetch(`${server.baseUrl}/api/admin/instances/user-a/start`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'settings_update' }),
      });
      const startPayload = (await startResponse.json()) as { data: { url: string } };

      expect(startResponse.status).toBe(200);
      expect(startPayload.data.url).toBe('http://user-a.new.example');
      expect(docker.createdContainers[0]).toMatchObject({
        Image: 'registry.local/aionui-web:v2.0.0',
        HostConfig: {
          Memory: 536870912,
          NanoCpus: 500000000,
          PidsLimit: 256,
        },
        Labels: {
          'aionui.image-version': 'v2.0.0',
          'traefik.http.routers.aionui-user-a.rule': 'Host(`user-a.new.example`)',
        },
      });

      const usersResponse = await fetch(`${server.baseUrl}/api/admin/users`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const usersPayload = (await usersResponse.json()) as {
        data: Array<{ instance: { resourceLimits: { cpu: number; memoryMiB: number } } }>;
      };
      expect(usersPayload.data[0]?.instance.resourceLimits).toEqual({ cpu: 0.5, memoryMiB: 512 });
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('serves the Portal SPA under / and /admin', async () => {
    const adminStaticDir = createTempDir();
    writeFileSync(join(adminStaticDir, 'index.html'), '<!doctype html><title>AionUi Portal Admin</title>');
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [],
    });
    const app = createPortalApp({
      repository,
      docker: createFakeDocker(),
      config: {
        ...getPortalConfig({ AIONUI_PORTAL_USERS_JSON: '[]' }),
        adminStaticDir,
      },
      now: () => 1000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const server = await listen(app);

    try {
      const userResponse = await fetch(`${server.baseUrl}/`);
      const userHtml = await userResponse.text();
      const adminResponse = await fetch(`${server.baseUrl}/admin/users`);
      const adminHtml = await adminResponse.text();

      expect(userResponse.status).toBe(200);
      expect(userResponse.headers.get('content-type')).toContain('text/html');
      expect(userHtml).toContain('AionUi Portal Admin');
      expect(adminResponse.status).toBe(200);
      expect(adminResponse.headers.get('content-type')).toContain('text/html');
      expect(adminHtml).toContain('AionUi Portal Admin');
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('waits through the idle grace period before stopping inactive containers', async () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [],
    });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    const docker = createFakeDocker();
    await docker
      .createContainer({
        Image: 'image',
        name: 'aionui-user-a',
        HostConfig: {},
        Labels: {},
      })
      .then((container) => container.start());
    const instanceClient = {
      getRuntimeStatus: vi.fn(async () => ({ runningTaskCount: 0 })),
    };
    const config = getPortalConfig({
      AIONUI_PORTAL_USERS_JSON: '[]',
      AIONUI_IDLE_TIMEOUT_MS: '1000',
      AIONUI_STOP_GRACE_PERIOD_MS: '500',
    });

    await cleanupIdleContainers({
      repository,
      docker,
      config,
      instanceClient,
      now: () => 2400,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(repository.getSession('user-a')?.status).toBe('running');

    await cleanupIdleContainers({
      repository,
      docker,
      config,
      instanceClient,
      now: () => 2600,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(repository.getSession('user-a')?.status).toBe('stopped');
    repository.close();
  });
});
