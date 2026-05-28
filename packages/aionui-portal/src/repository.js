const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function initializeSchema(database) {
  database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            user_id TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            user_id TEXT PRIMARY KEY,
            container_name TEXT NOT NULL,
            host_data_path TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
            last_active_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_sessions_status_last_active
            ON user_sessions(status, last_active_at);
    `);
}

function seedDefaultUsers(database, defaultUsers, now) {
  const insertUser = database.prepare(`
        INSERT INTO users (username, password, user_id, created_at, updated_at)
        VALUES (@username, @password, @id, @now, @now)
        ON CONFLICT(username) DO NOTHING
    `);

  const insertUsers = database.transaction((users) => {
    for (const user of users) {
      insertUser.run({ ...user, now });
    }
  });

  insertUsers(defaultUsers);
}

/**
 * Creates the SQLite-backed portal repository.
 *
 * @param {object} options Repository options.
 * @param {string} options.databasePath SQLite database path.
 * @param {Array<{ username: string, password: string, id: string }>} options.defaultUsers Users seeded when missing.
 * @returns {object} Repository API.
 */
function createPortalRepository({ databasePath, defaultUsers = [] }) {
  if (!databasePath) {
    throw new Error('databasePath is required');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  initializeSchema(database);
  seedDefaultUsers(database, defaultUsers, Date.now());

  const authenticateUserStatement = database.prepare(`
        SELECT user_id AS id
        FROM users
        WHERE username = ? AND password = ?
    `);
  const upsertSessionStatement = database.prepare(`
        INSERT INTO user_sessions (
            user_id,
            container_name,
            host_data_path,
            status,
            last_active_at,
            updated_at
        )
        VALUES (@userId, @containerName, @hostDataPath, 'active', @now, @now)
        ON CONFLICT(user_id) DO UPDATE SET
            container_name = excluded.container_name,
            host_data_path = excluded.host_data_path,
            status = 'active',
            last_active_at = excluded.last_active_at,
            updated_at = excluded.updated_at
    `);
  const touchExistingSessionStatement = database.prepare(`
        UPDATE user_sessions
        SET last_active_at = ?, updated_at = ?
        WHERE user_id = ? AND status = 'active'
    `);
  const listActiveSessionsStatement = database.prepare(`
        SELECT
            user_id AS userId,
            container_name AS containerName,
            host_data_path AS hostDataPath,
            last_active_at AS lastActiveAt
        FROM user_sessions
        WHERE status = 'active'
        ORDER BY user_id
    `);
  const markSessionStoppedStatement = database.prepare(`
        UPDATE user_sessions
        SET status = 'stopped', updated_at = ?
        WHERE user_id = ?
    `);

  return {
    authenticateUser(username, password) {
      return authenticateUserStatement.get(username, password) || null;
    },
    touchSession({ userId, containerName, hostDataPath, now }) {
      upsertSessionStatement.run({ userId, containerName, hostDataPath, now });
    },
    touchExistingSession(userId, now) {
      const result = touchExistingSessionStatement.run(now, now, userId);
      return result.changes > 0;
    },
    listActiveSessions() {
      return listActiveSessionsStatement.all();
    },
    markSessionStopped(userId) {
      markSessionStoppedStatement.run(Date.now(), userId);
    },
    close() {
      database.close();
    },
  };
}

module.exports = { createPortalRepository };
