import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createPortalRepository } = require('../../packages/aionui-portal/src/repository.js');
const Database = require('better-sqlite3');

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aionui-portal-'));
  tempDirs.push(dir);
  return join(dir, 'portal.sqlite');
}

describe('aionui portal repository', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists seeded users and active sessions across repository instances', () => {
    const databasePath = createTempDbPath();
    const defaults = [{ username: 'userA', password: 'password123', id: 'user-a' }];

    const repository = createPortalRepository({ databasePath, defaultUsers: defaults });
    expect(repository.authenticateUser('userA', 'password123')).toEqual({ id: 'user-a' });
    expect(repository.authenticateUser('userA', 'wrong-password')).toBeNull();

    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });
    repository.close();

    const restoredRepository = createPortalRepository({ databasePath, defaultUsers: [] });
    expect(restoredRepository.authenticateUser('userA', 'password123')).toEqual({ id: 'user-a' });
    expect(restoredRepository.listActiveSessions()).toEqual([
      {
        userId: 'user-a',
        containerName: 'aionui-user-a',
        failureReason: null,
        hostDataPath: '/data/users/user-a',
        imageVersion: null,
        instanceId: 'inst_user_a',
        lastActiveAt: 1000,
        lastStartedAt: 1000,
        lastStoppedAt: null,
        readiness: {
          backendHealthy: true,
          containerStarted: true,
          webListening: true,
        },
        status: 'running',
        subdomain: 'user-a',
        url: 'https://user-a.aionui.local',
      },
    ]);
    restoredRepository.close();
  });

  it('refreshes only sessions that are already active', () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [],
    });

    expect(repository.touchExistingSession('missing-user', 2000)).toBe(false);

    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 1000,
    });

    expect(repository.touchExistingSession('user-a', 2000)).toBe(true);
    expect(repository.listActiveSessions()[0]?.lastActiveAt).toBe(2000);
    repository.markSessionStopped('user-a');
    expect(repository.touchExistingSession('user-a', 3000)).toBe(false);
    repository.close();
  });

  it('persists image version, lifecycle stop time, and audit logs', () => {
    const databasePath = createTempDbPath();
    const repository = createPortalRepository({
      databasePath,
      defaultUsers: [],
    });

    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      imageVersion: 'v1.2.3',
      now: 1000,
    });
    repository.markSessionStopped('user-a', 2000);
    repository.recordAuditLog({
      actorId: 'admin',
      action: 'admin.instances.stop',
      targetUserId: 'user-a',
      targetInstanceId: 'inst_user_a',
      sourceIp: '127.0.0.1',
      result: 'success',
      reason: 'maintenance',
      now: 2000,
    });
    repository.close();

    const restoredRepository = createPortalRepository({ databasePath, defaultUsers: [] });
    expect(restoredRepository.getSession('user-a')).toMatchObject({
      imageVersion: 'v1.2.3',
      lastStartedAt: 1000,
      lastStoppedAt: 2000,
      status: 'stopped',
    });
    expect(restoredRepository.listAuditLogs()).toEqual([
      expect.objectContaining({
        actorId: 'admin',
        action: 'admin.instances.stop',
        targetUserId: 'user-a',
        targetInstanceId: 'inst_user_a',
        sourceIp: '127.0.0.1',
        result: 'success',
        reason: 'maintenance',
        createdAt: 2000,
      }),
    ]);
    restoredRepository.close();
  });

  it('stores Portal sessions separately from request bodies', () => {
    const repository = createPortalRepository({
      databasePath: createTempDbPath(),
      defaultUsers: [{ username: 'userA', password: 'password123', id: 'user-a' }],
    });

    const sessionToken = repository.createPortalSession({
      userId: 'user-a',
      now: 1000,
      ttlMs: 60_000,
    });

    expect(typeof sessionToken).toBe('string');
    expect(repository.authenticatePortalSession(sessionToken, 2000)).toEqual({ id: 'user-a' });
    expect(repository.authenticatePortalSession(sessionToken, 62_000)).toBeNull();
    repository.close();
  });

  it('persists runtime settings independently from environment defaults', () => {
    const databasePath = createTempDbPath();
    const repository = createPortalRepository({
      databasePath,
      defaultUsers: [],
    });

    expect(repository.listPortalSettings()).toEqual({});

    repository.savePortalSettings(
      {
        dockerImage: 'registry.local/aionui-web:v2.0.0',
        idleTimeoutMs: 120000,
      },
      1000
    );
    repository.close();

    const restoredRepository = createPortalRepository({ databasePath, defaultUsers: [] });
    expect(restoredRepository.listPortalSettings()).toEqual({
      dockerImage: 'registry.local/aionui-web:v2.0.0',
      idleTimeoutMs: 120000,
    });
    restoredRepository.close();
  });

  it('migrates the prototype Portal schema to hashed users and V1 instance sessions', () => {
    const databasePath = createTempDbPath();
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        user_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE user_sessions (
        user_id TEXT PRIMARY KEY,
        container_name TEXT NOT NULL,
        host_data_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
        last_active_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO users (username, password, user_id, created_at, updated_at)
         VALUES ('userA', 'password123', 'user-a', 1, 1)`
      )
      .run();
    database
      .prepare(
        `INSERT INTO user_sessions (user_id, container_name, host_data_path, status, last_active_at, updated_at)
         VALUES ('user-a', 'aionui-user-a', '/data/users/user-a', 'active', 1000, 1000)`
      )
      .run();
    database.close();

    const repository = createPortalRepository({ databasePath, defaultUsers: [] });

    expect(repository.authenticateUser('userA', 'password123')).toEqual({ id: 'user-a' });
    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      subdomain: 'user-a',
      url: 'https://user-a.aionui.local',
      status: 'running',
      now: 2000,
    });
    expect(repository.getSession('user-a')).toMatchObject({
      instanceId: 'inst_user_a',
      status: 'running',
      subdomain: 'user-a',
    });
    repository.close();
  });
});
