import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createPortalRepository } = require('../../packages/aionui-portal/src/repository.js');

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

    repository.touchSession({
      userId: 'user-a',
      containerName: 'aionui-user-a',
      hostDataPath: '/data/users/user-a',
      now: 1000,
    });
    repository.close();

    const restoredRepository = createPortalRepository({ databasePath, defaultUsers: [] });
    expect(restoredRepository.authenticateUser('userA', 'password123')).toEqual({ id: 'user-a' });
    expect(restoredRepository.listActiveSessions()).toEqual([
      {
        userId: 'user-a',
        containerName: 'aionui-user-a',
        hostDataPath: '/data/users/user-a',
        lastActiveAt: 1000,
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
      now: 1000,
    });

    expect(repository.touchExistingSession('user-a', 2000)).toBe(true);
    expect(repository.listActiveSessions()[0]?.lastActiveAt).toBe(2000);
    repository.markSessionStopped('user-a');
    expect(repository.touchExistingSession('user-a', 3000)).toBe(false);
    repository.close();
  });
});
