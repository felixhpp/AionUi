const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createSessionToken, hashPassword, hashSessionToken, verifyPassword } = require('./auth');

const ACTIVE_INSTANCE_STATUSES = new Set(['starting', 'running', 'degraded']);
const DEFAULT_READINESS = {
  containerStarted: true,
  webListening: true,
  backendHealthy: true,
};
const USER_SESSION_COLUMNS = [
  ['image_version', 'TEXT'],
  ['last_started_at', 'INTEGER'],
  ['last_stopped_at', 'INTEGER'],
  ['failure_reason', 'TEXT'],
];

function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'user';
}

function getTableColumns(database, tableName) {
  try {
    return new Set(
      database
        .prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .map((row) => row.name)
    );
  } catch {
    return new Set();
  }
}

function migrateLegacyUsers(database) {
  const columns = getTableColumns(database, 'users');
  if (columns.size === 0) return;

  if (!columns.has('password_hash')) {
    database.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    const users = database.prepare('SELECT username, password FROM users WHERE password_hash IS NULL').all();
    const update = database.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
    const updateUsers = database.transaction((rows) => {
      for (const user of rows) {
        update.run(hashPassword(user.password), user.username);
      }
    });
    updateUsers(users);
  }

  if (!columns.has('display_name')) {
    database.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    database.exec('UPDATE users SET display_name = username WHERE display_name IS NULL');
  }
}

function migrateLegacyUserSessions(database) {
  const columns = getTableColumns(database, 'user_sessions');
  if (columns.size === 0 || columns.has('instance_id')) return [];

  const legacyRows = database
    .prepare(
      `SELECT
        user_id AS userId,
        container_name AS containerName,
        host_data_path AS hostDataPath,
        status,
        last_active_at AS lastActiveAt,
        updated_at AS updatedAt
      FROM user_sessions`
    )
    .all();
  database.exec('ALTER TABLE user_sessions RENAME TO user_sessions_legacy');
  return legacyRows;
}

function ensureColumns(database, tableName, columns) {
  const existingColumns = getTableColumns(database, tableName);
  if (existingColumns.size === 0) return;

  for (const [columnName, columnType] of columns) {
    if (!existingColumns.has(columnName)) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }
}

function insertLegacyUserSessions(database, rows) {
  if (rows.length === 0) return;

  const insert = database.prepare(`
        INSERT INTO user_sessions (
            user_id,
            instance_id,
            container_name,
            host_data_path,
            subdomain,
            url,
            status,
            container_started,
            web_listening,
            backend_healthy,
            last_active_at,
            updated_at
        )
        VALUES (
            @userId,
            @instanceId,
            @containerName,
            @hostDataPath,
            @subdomain,
            @url,
            @status,
            @containerStarted,
            @webListening,
            @backendHealthy,
            @lastActiveAt,
            @updatedAt
        )
        ON CONFLICT(user_id) DO NOTHING
    `);
  const insertRows = database.transaction((legacyRows) => {
    for (const row of legacyRows) {
      const subdomain = slugify(row.userId);
      const status = row.status === 'active' ? 'running' : 'stopped';
      const isRunning = status === 'running';
      insert.run({
        userId: row.userId,
        instanceId: `inst_${subdomain.replaceAll('-', '_')}`,
        containerName: row.containerName,
        hostDataPath: row.hostDataPath,
        subdomain,
        url: `https://${subdomain}.aionui.local`,
        status,
        containerStarted: isRunning ? 1 : 0,
        webListening: isRunning ? 1 : 0,
        backendHealthy: isRunning ? 1 : 0,
        lastActiveAt: row.lastActiveAt,
        updatedAt: row.updatedAt,
      });
    }
  });
  insertRows(rows);
  database.exec('DROP TABLE IF EXISTS user_sessions_legacy');
}

function initializeSchema(database) {
  migrateLegacyUsers(database);
  const legacyUserSessions = migrateLegacyUserSessions(database);

  database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            user_id TEXT NOT NULL UNIQUE,
            display_name TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            user_id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL,
            container_name TEXT NOT NULL,
            host_data_path TEXT NOT NULL,
            subdomain TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'created',
                    'starting',
                    'running',
                    'degraded',
                    'stopping',
                    'stopped',
                    'failed',
                    'starting_timeout'
                )
            ),
            container_started INTEGER NOT NULL DEFAULT 0,
            web_listening INTEGER NOT NULL DEFAULT 0,
            backend_healthy INTEGER NOT NULL DEFAULT 0,
            image_version TEXT,
            last_started_at INTEGER,
            last_stopped_at INTEGER,
            failure_reason TEXT,
            last_active_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS portal_sessions (
            session_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            target_user_id TEXT,
            target_instance_id TEXT,
            source_ip TEXT,
            result TEXT NOT NULL,
            reason TEXT,
            error_code TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS instance_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            status TEXT,
            reason TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS portal_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_sessions_status_last_active
            ON user_sessions(status, last_active_at);

        CREATE INDEX IF NOT EXISTS idx_portal_sessions_user_expires
            ON portal_sessions(user_id, expires_at);
    `);

  ensureColumns(database, 'user_sessions', USER_SESSION_COLUMNS);
  insertLegacyUserSessions(database, legacyUserSessions);
}

function seedDefaultUsers(database, defaultUsers, now) {
  const insertUser = database.prepare(`
        INSERT INTO users (username, password_hash, user_id, display_name, created_at, updated_at)
        VALUES (@username, @passwordHash, @id, @displayName, @now, @now)
        ON CONFLICT(username) DO NOTHING
    `);

  const insertUsers = database.transaction((users) => {
    for (const user of users) {
      insertUser.run({
        username: user.username,
        passwordHash: hashPassword(user.password),
        id: user.id,
        displayName: user.displayName || user.username,
        now,
      });
    }
  });

  insertUsers(defaultUsers);
}

function mapSession(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    instanceId: row.instanceId,
    containerName: row.containerName,
    hostDataPath: row.hostDataPath,
    subdomain: row.subdomain,
    url: row.url,
    status: row.status,
    imageVersion: row.imageVersion || null,
    lastStartedAt: row.lastStartedAt || null,
    lastStoppedAt: row.lastStoppedAt || null,
    failureReason: row.failureReason || null,
    lastActiveAt: row.lastActiveAt,
    readiness: {
      containerStarted: row.containerStarted === 1,
      webListening: row.webListening === 1,
      backendHealthy: row.backendHealthy === 1,
    },
  };
}

/**
 * Creates the SQLite-backed portal repository.
 *
 * @param {object} options Repository options.
 * @param {string} options.databasePath SQLite database path.
 * @param {Array<{ username: string, password: string, id: string, displayName?: string }>} options.defaultUsers Users seeded when missing.
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
        SELECT user_id AS id, username, password_hash AS passwordHash, display_name AS displayName
        FROM users
        WHERE username = ?
    `);
  const insertUserStatement = database.prepare(`
        INSERT INTO users (username, password_hash, user_id, display_name, created_at, updated_at)
        VALUES (@username, @passwordHash, @userId, @displayName, @now, @now)
    `);
  const listUsersStatement = database.prepare(`
        SELECT
            user_id AS userId,
            username,
            display_name AS displayName,
            created_at AS createdAt,
            updated_at AS updatedAt
        FROM users
        ORDER BY username
    `);
  const upsertSessionStatement = database.prepare(`
        INSERT INTO user_sessions (
            user_id,
            instance_id,
            container_name,
            host_data_path,
            subdomain,
            url,
            status,
            container_started,
            web_listening,
            backend_healthy,
            image_version,
            last_started_at,
            last_stopped_at,
            failure_reason,
            last_active_at,
            updated_at
        )
        VALUES (
            @userId,
            @instanceId,
            @containerName,
            @hostDataPath,
            @subdomain,
            @url,
            @status,
            @containerStarted,
            @webListening,
            @backendHealthy,
            @imageVersion,
            @lastStartedAt,
            @lastStoppedAt,
            @failureReason,
            @now,
            @now
        )
        ON CONFLICT(user_id) DO UPDATE SET
            instance_id = excluded.instance_id,
            container_name = excluded.container_name,
            host_data_path = excluded.host_data_path,
            subdomain = excluded.subdomain,
            url = excluded.url,
            status = excluded.status,
            container_started = excluded.container_started,
            web_listening = excluded.web_listening,
            backend_healthy = excluded.backend_healthy,
            image_version = excluded.image_version,
            last_started_at = excluded.last_started_at,
            last_stopped_at = excluded.last_stopped_at,
            failure_reason = excluded.failure_reason,
            last_active_at = excluded.last_active_at,
            updated_at = excluded.updated_at
    `);
  const touchExistingSessionStatement = database.prepare(`
        UPDATE user_sessions
        SET last_active_at = ?, updated_at = ?
        WHERE user_id = ? AND status IN ('starting', 'running', 'degraded')
    `);
  const listActiveSessionsStatement = database.prepare(`
        SELECT
            user_id AS userId,
            instance_id AS instanceId,
            container_name AS containerName,
            host_data_path AS hostDataPath,
            subdomain,
            url,
            status,
            container_started AS containerStarted,
            web_listening AS webListening,
            backend_healthy AS backendHealthy,
            image_version AS imageVersion,
            last_started_at AS lastStartedAt,
            last_stopped_at AS lastStoppedAt,
            failure_reason AS failureReason,
            last_active_at AS lastActiveAt
        FROM user_sessions
        WHERE status IN ('starting', 'running', 'degraded')
        ORDER BY user_id
    `);
  const getSessionStatement = database.prepare(`
        SELECT
            user_id AS userId,
            instance_id AS instanceId,
            container_name AS containerName,
            host_data_path AS hostDataPath,
            subdomain,
            url,
            status,
            container_started AS containerStarted,
            web_listening AS webListening,
            backend_healthy AS backendHealthy,
            image_version AS imageVersion,
            last_started_at AS lastStartedAt,
            last_stopped_at AS lastStoppedAt,
            failure_reason AS failureReason,
            last_active_at AS lastActiveAt
        FROM user_sessions
        WHERE user_id = ?
    `);
  const markSessionStoppedStatement = database.prepare(`
        UPDATE user_sessions
        SET status = 'stopped', last_stopped_at = ?, updated_at = ?
        WHERE user_id = ?
    `);
  const insertAuditLogStatement = database.prepare(`
        INSERT INTO audit_logs (
            actor_id,
            action,
            target_user_id,
            target_instance_id,
            source_ip,
            result,
            reason,
            error_code,
            created_at
        )
        VALUES (
            @actorId,
            @action,
            @targetUserId,
            @targetInstanceId,
            @sourceIp,
            @result,
            @reason,
            @errorCode,
            @createdAt
        )
    `);
  const listAuditLogsStatement = database.prepare(`
        SELECT
            actor_id AS actorId,
            action,
            target_user_id AS targetUserId,
            target_instance_id AS targetInstanceId,
            source_ip AS sourceIp,
            result,
            reason,
            error_code AS errorCode,
            created_at AS createdAt
        FROM audit_logs
        ORDER BY id
    `);
  const insertInstanceEventStatement = database.prepare(`
        INSERT INTO instance_events (user_id, instance_id, event_type, status, reason, created_at)
        VALUES (@userId, @instanceId, @eventType, @status, @reason, @createdAt)
    `);
  const createPortalSessionStatement = database.prepare(`
        INSERT INTO portal_sessions (session_hash, user_id, expires_at, created_at)
        VALUES (@sessionHash, @userId, @expiresAt, @now)
    `);
  const authenticatePortalSessionStatement = database.prepare(`
        SELECT user_id AS id
        FROM portal_sessions
        WHERE session_hash = ? AND expires_at > ?
    `);
  const listPortalSettingsStatement = database.prepare(`
        SELECT key, value_json AS valueJson
        FROM portal_settings
        ORDER BY key
    `);
  const upsertPortalSettingStatement = database.prepare(`
        INSERT INTO portal_settings (key, value_json, updated_at)
        VALUES (@key, @valueJson, @now)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
    `);
  const upsertPortalSettings = database.transaction((settings, now) => {
    for (const [key, value] of Object.entries(settings)) {
      upsertPortalSettingStatement.run({
        key,
        valueJson: JSON.stringify(value),
        now,
      });
    }
  });

  return {
    authenticateUser(username, password) {
      const user = authenticateUserStatement.get(username);
      if (!user || !verifyPassword(password, user.passwordHash)) return null;
      return { id: user.id };
    },
    createUser({ username, password, userId, displayName, now = Date.now() }) {
      insertUserStatement.run({
        username,
        passwordHash: hashPassword(password),
        userId,
        displayName: displayName || username,
        now,
      });
      return {
        userId,
        username,
        displayName: displayName || username,
        createdAt: now,
        updatedAt: now,
      };
    },
    listUsers() {
      return listUsersStatement.all().map((user) => {
        user.instance = mapSession(getSessionStatement.get(user.userId));
        return user;
      });
    },
    createPortalSession({ userId, now, ttlMs }) {
      const token = createSessionToken();
      createPortalSessionStatement.run({
        sessionHash: hashSessionToken(token),
        userId,
        expiresAt: now + ttlMs,
        now,
      });
      return token;
    },
    authenticatePortalSession(token, now) {
      if (!token) return null;
      return authenticatePortalSessionStatement.get(hashSessionToken(token), now) || null;
    },
    touchSession({
      userId,
      containerName,
      hostDataPath,
      subdomain,
      url,
      status = 'running',
      readiness = DEFAULT_READINESS,
      imageVersion = null,
      failureReason = null,
      now,
    }) {
      upsertSessionStatement.run({
        userId,
        instanceId: `inst_${subdomain.replaceAll('-', '_')}`,
        containerName,
        hostDataPath,
        subdomain,
        url,
        status,
        containerStarted: readiness.containerStarted ? 1 : 0,
        webListening: readiness.webListening ? 1 : 0,
        backendHealthy: readiness.backendHealthy ? 1 : 0,
        imageVersion,
        lastStartedAt: status === 'running' ? now : null,
        lastStoppedAt: status === 'stopped' ? now : null,
        failureReason,
        now,
      });
      insertInstanceEventStatement.run({
        userId,
        instanceId: `inst_${subdomain.replaceAll('-', '_')}`,
        eventType: 'status_changed',
        status,
        reason: failureReason,
        createdAt: now,
      });
    },
    touchExistingSession(userId, now) {
      const result = touchExistingSessionStatement.run(now, now, userId);
      return result.changes > 0;
    },
    listActiveSessions() {
      return listActiveSessionsStatement.all().map(mapSession);
    },
    getSession(userId) {
      return mapSession(getSessionStatement.get(userId));
    },
    markSessionStopped(userId, now = Date.now()) {
      const session = mapSession(getSessionStatement.get(userId));
      markSessionStoppedStatement.run(now, now, userId);
      if (session) {
        insertInstanceEventStatement.run({
          userId,
          instanceId: session.instanceId,
          eventType: 'stopped',
          status: 'stopped',
          reason: null,
          createdAt: now,
        });
      }
    },
    recordAuditLog({
      actorId,
      action,
      targetUserId = null,
      targetInstanceId = null,
      sourceIp = null,
      result,
      reason = null,
      errorCode = null,
      now = Date.now(),
    }) {
      insertAuditLogStatement.run({
        actorId,
        action,
        targetUserId,
        targetInstanceId,
        sourceIp,
        result,
        reason,
        errorCode,
        createdAt: now,
      });
    },
    listAuditLogs() {
      return listAuditLogsStatement.all();
    },
    listPortalSettings() {
      return Object.fromEntries(
        listPortalSettingsStatement.all().map((row) => {
          let value = null;
          try {
            value = JSON.parse(row.valueJson);
          } catch {
            value = row.valueJson;
          }
          return [row.key, value];
        })
      );
    },
    savePortalSettings(settings, now = Date.now()) {
      upsertPortalSettings(settings, now);
      return this.listPortalSettings();
    },
    isActiveStatus(status) {
      return ACTIVE_INSTANCE_STATUSES.has(status);
    },
    close() {
      database.close();
    },
  };
}

module.exports = { createPortalRepository };
