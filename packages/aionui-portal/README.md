## AIonUI Portal

AIonUI Portal is a lightweight Express service that authenticates a user, starts or resumes the user's AIonUI container, and keeps the container alive while the browser sends heartbeats.

### Persistence

Portal state is stored in SQLite instead of process memory:

- `users`: login users seeded from `AIONUI_PORTAL_USERS_JSON` or the development defaults.
- `user_sessions`: active container name, mounted data path, status, and last active timestamp.

Default database path:

```bash
/data/portal/portal.sqlite
```

Mount this path when running the Portal container:

```bash
-v /data/portal:/data/portal
-v /data/users:/data/users
-v /var/run/docker.sock:/var/run/docker.sock
```

### Environment

| Variable | Default | Description |
| --- | --- | --- |
| `AIONUI_PORTAL_PORT` | `8085` | Portal HTTP port |
| `AIONUI_PORTAL_DB_PATH` | `/data/portal/portal.sqlite` | SQLite database path |
| `AIONUI_PORTAL_USERS_JSON` | development users | JSON array with `username`, `password`, and `id` |
| `AIONUI_USERS_DATA_ROOT` | `/data/users` | Host directory for per-user AIonUI data |
| `AIONUI_WEB_IMAGE` | `your-registry.local/aionui-web:v1.0` | User container image |
| `AIONUI_DOCKER_NETWORK` | `aionui-network` | Docker network shared with Traefik |
| `AIONUI_IDLE_TIMEOUT_MS` | `1800000` | Idle timeout before stopping a user container |
| `AIONUI_CLEANUP_INTERVAL_MS` | `60000` | Idle cleanup interval |

Example users:

```bash
export AIONUI_PORTAL_USERS_JSON='[
  { "username": "userA", "password": "password123", "id": "user-a" },
  { "username": "userB", "password": "password456", "id": "user-b" }
]'
```

### API Flow

1. User opens the Portal login page.
2. Frontend calls `POST /api/login-and-resume`.
3. Portal authenticates against SQLite, creates the host data directory, starts or resumes `aionui-<userId>`, then returns `{ "success": true, "redirectUrl": "/<userId>/" }`.
4. Frontend redirects to the returned Traefik subpath.
5. Frontend calls `POST /api/heartbeat` every 5 minutes while the page is active.
6. Portal's cleanup task stops containers whose persisted `last_active_at` exceeds the idle timeout.
