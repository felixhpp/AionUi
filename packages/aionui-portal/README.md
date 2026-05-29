## AIonUI Portal

AIonUI Portal 是一个轻量级 Express 服务，用于对用户进行身份验证、启动或恢复用户的 AIonUI 容器、颁发短命实例登录票据 URL，并在浏览器发送心跳时保持容器活跃。

### 持久化

Portal 状态存储在 SQLite 中，而非进程内存：

- `users`：从 `AIONUI_PORTAL_USERS_JSON` 或开发环境默认值导入的登录用户。密码存储为 scrypt 哈希值。
- `portal_sessions`：Portal 会话 Cookie。用户 API 通过此会话解析当前用户，而非从请求体中获取。
- `user_sessions`：实例 ID、容器名称、挂载数据路径、子域名就绪状态、生命周期状态、镜像版本以及生命周期时间戳。
- `audit_logs`：管理和控制平面操作审计记录。
- `instance_events`：用于故障排查的实例生命周期事件。

默认数据库路径：

```bash
/data/portal/portal.sqlite
```

运行 Portal 容器时需挂载此路径：

```bash
-v /data/portal:/data/portal
-v /data/users:/data/users
-v /var/run/docker.sock:/var/run/docker.sock
```

### 环境变量

部分实例运行参数支持在 `/admin` 管理台保存为 SQLite 运行时设置，保存后会影响后续实例启动、停止和空闲清理，不需要重启 Portal 后端。启动密钥、管理员令牌、数据库路径和 Docker 连接参数仍只允许通过环境变量配置。

| 变量                                    | 默认值                                | 说明                                             |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `AIONUI_PORTAL_PORT`                    | `8085`                                | Portal HTTP 端口                                 |
| `AIONUI_PORTAL_DB_PATH`                 | `/data/portal/portal.sqlite`          | SQLite 数据库路径                                |
| `AIONUI_PORTAL_USERS_JSON`              | 开发环境用户                          | 包含 `username`、`password` 和 `id` 的 JSON 数组 |
| `AIONUI_USERS_DATA_ROOT`                | `/data/users`                         | 用户级 AIonUI 数据的主机目录                     |
| `AIONUI_WEB_IMAGE`                      | `your-registry.local/aionui-web:v1.0` | 用户容器镜像                                     |
| `AIONUI_WEB_IMAGE_VERSION`              | 镜像名称                              | 记录在每个实例上的版本号                         |
| `AIONUI_DOCKER_NETWORK`                 | `aionui-network`                      | 与 Traefik 共享的 Docker 网络                    |
| `AIONUI_DOCKER_HOST`                    | 空                                    | Docker socket proxy 主机；为空时使用本机 socket  |
| `AIONUI_DOCKER_PORT`                    | `2375`                                | Docker socket proxy 端口                         |
| `AIONUI_DOCKER_PROTOCOL`                | `http`                                | Docker socket proxy 协议                         |
| `AIONUI_BASE_DOMAIN`                    | `aionui.local`                        | 用户级子域名的基础域名                           |
| `AIONUI_PUBLIC_SCHEME`                  | `https`                               | 返回的实例 URL 所使用的公开协议                  |
| `AIONUI_PORTAL_TICKET_SECRET`           | 开发环境密钥                          | 与实例共享用于 Portal 登录票据的 HMAC 密钥       |
| `AIONUI_PORTAL_CONTROL_SECRET`          | 开发环境密钥                          | 实例内部 Portal API 的 Bearer 密钥               |
| `AIONUI_PORTAL_ADMIN_TOKEN`             | 开发环境令牌                          | Portal 管理 API 所需的 Bearer 令牌               |
| `AIONUI_PORTAL_ALLOWED_ORIGINS`         | 空                                    | 写接口允许的浏览器 Origin，多个值用逗号分隔      |
| `AIONUI_PORTAL_TICKET_TTL_SECONDS`      | `60`                                  | 登录票据 TTL                                     |
| `AIONUI_PORTAL_SESSION_TTL_MS`          | `28800000`                            | Portal 会话 Cookie TTL                           |
| `AIONUI_IDLE_TIMEOUT_MS`                | `1800000`                             | 停止用户容器前的空闲超时时间                     |
| `AIONUI_CLEANUP_INTERVAL_MS`            | `60000`                               | 空闲清理间隔                                     |
| `AIONUI_STOP_GRACE_PERIOD_MS`           | `300000`                              | 空闲清理策略预留的宽限期                         |
| `AIONUI_RESET_PASSWORD_TTL_MS`          | `600000`                              | break-glass 重置密码响应的展示有效期             |
| `AIONUI_CONTAINER_STOP_TIMEOUT_SECONDS` | `30`                                  | Docker 停止超时                                  |
| `AIONUI_CONTAINER_MEMORY_BYTES`         | `2147483648`                          | 每个用户的容器内存限制                           |
| `AIONUI_CONTAINER_NANO_CPUS`            | `1000000000`                          | 每个用户的容器 CPU 配额                          |
| `AIONUI_CONTAINER_PIDS_LIMIT`           | `512`                                 | 每个用户的容器 PID 限制                          |
| `AIONUI_CONTAINER_USER`                 | `1000:1000`                           | 用户容器内使用的非 root 用户                     |
| `AIONUI_CONTAINER_DATA_PATH`            | `/app/data`                           | 用户容器内数据挂载路径                           |

支持管理台覆盖的运行参数包括：`AIONUI_WEB_IMAGE`、`AIONUI_WEB_IMAGE_VERSION`、`AIONUI_USERS_DATA_ROOT`、`AIONUI_BASE_DOMAIN`、`AIONUI_PUBLIC_SCHEME`、`AIONUI_IDLE_TIMEOUT_MS`、`AIONUI_STOP_GRACE_PERIOD_MS`、`AIONUI_RESET_PASSWORD_TTL_MS`、`AIONUI_CONTAINER_STOP_TIMEOUT_SECONDS`、`AIONUI_CONTAINER_MEMORY_BYTES`、`AIONUI_CONTAINER_NANO_CPUS`、`AIONUI_CONTAINER_PIDS_LIMIT`、`AIONUI_CONTAINER_USER`、`AIONUI_CONTAINER_DATA_PATH`。

用户配置示例：

```bash
export AIONUI_PORTAL_USERS_JSON='[
  { "username": "userA", "password": "password123", "id": "user-a" },
  { "username": "userB", "password": "password456", "id": "user-b" }
]'
```

### API 流程

1. 用户打开 Portal 登录页面。
2. 前端调用 `POST /api/login-and-resume`。
3. Portal 对 SQLite 中的用户进行身份验证，设置 Portal 会话 Cookie，创建主机数据目录，启动或恢复 `aionui-<slug>`，等待就绪，并调用实例内部 ensure-user API。
4. Portal 返回 `{ "success": true, "data": { "url": "https://<slug>.<domain>", "loginUrl": "https://<slug>.<domain>/auth/portal/callback?ticket=..." } }`。
5. 前端重定向到 `loginUrl`；实例后端验证票据并创建自己的会话。
6. 页面活跃期间前端调用 `POST /api/heartbeat`。Portal 使用会话 Cookie 身份，忽略请求体中的 `userId`。
7. Portal 的清理任务检查运行时状态，停止已超过空闲超时且没有运行中任务的容器的 `last_active_at` 记录。

### 普通用户入口

Portal 根路径 `/` 提供普通用户登录入口：

```text
https://portal.<baseDomain>/
```

用户登录成功后，Portal 会确保该用户实例运行、生成一次性 login ticket，并把浏览器跳转到用户实例的 `loginUrl`。

### 管理 API

管理 API 需要以下请求头：

```text
Authorization: Bearer <AIONUI_PORTAL_ADMIN_TOKEN>
```

已实现的管理端点：

| API                                                | 说明                                                 |
| -------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/admin/instances/:userId`                 | 查询用户的实例记录                                   |
| `GET /api/admin/settings`                          | 查询 Portal 运行时参数                               |
| `PUT /api/admin/settings`                          | 保存 Portal 运行时参数                               |
| `POST /api/admin/instances/:userId/start`          | 启动或恢复用户的实例                                 |
| `POST /api/admin/instances/:userId/stop`           | 在检查运行中任务后停止用户实例，除非 `force` 为 true |
| `POST /api/admin/instances/:userId/reset-password` | 通过实例后端执行 break-glass 密码重置                |

成功的和失败的管理生命周期操作都会记录在 `audit_logs` 中。

### 管理控制台

Portal 在 `/admin` 下包含一个 React + Arco 管理控制台。

本地开发：

```bash
npm run dev:web
```

生产构建：

```bash
npm run build:web
```

构建产物输出到：

```text
packages/aionui-portal/dist/admin
```

运行时，当 `AIONUI_PORTAL_ADMIN_STATIC_DIR` 存在时，Express 会在 `/admin` 提供该目录服务。默认值为 `packages/aionui-portal/dist/admin`。

控制台当前涵盖：

- 仪表盘指标
- Portal 用户列表和用户创建
- 实例状态、资源配额、启动/停止操作和 break-glass 密码重置
- 运行参数管理，支持保存后影响后续实例生命周期操作
- 审计日志浏览
- 运行时节点和全局技能市场的预留导航入口

### 单机 Docker 试点

试点 compose 位于：

```text
packages/aionui-portal/deploy/docker-compose.yml
```

使用示例：

```bash
cd packages/aionui-portal/deploy
cp .env.example .env
docker compose up --build
```

该 compose 包含：

- Portal
- Traefik
- Docker socket proxy
- `portal-data` 持久化卷
- `users-data` 用户实例数据卷
- `aionui-control` 控制面网络
- `aionui-runtime` 用户实例网络

Portal 在 compose 中通过 `AIONUI_DOCKER_HOST=docker-socket-proxy` 访问 Docker API，避免直接把 Docker socket 挂入 Portal 容器。

### 路由

V1 版本仅使用子域名路由。Traefik 标签通过 `Host(...)` 规则生成，例如：

```text
traefik.http.routers.aionui-user-a.rule=Host(`user-a.aionui.local`)
```

有意不使用 `PathPrefix(...)` 和 strip-prefix 中间件。

Portal 还会添加 `aionui.*`治理标签，包括实例 ID、Portal 用户 ID、子域名、镜像版本和 `aionui.managed=true`。密钥仅作为容器环境变量传递，绝不会作为 Docker 标签传递。
