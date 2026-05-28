# AionUi Server Runtime Mode PRD（V1）

## 0. 文档范围

本文只定义一个可执行的 V1 方案，不再同时承载 PoC、生产化、K8s、SSO 等多条路线。

V1 只回答这一条实现路径：

- Linux 服务器
- `aionui-web` 作为运行入口
- 一用户一容器
- 单机 Docker 部署
- 子域名路由
- bind mount 持久化
- Portal 负责生命周期管理

以下主题明确不属于 V1，应拆到后续 PRD 或扩展设计：

- Kubernetes
- Longhorn / Ceph RBD
- `/users/<id>/` 这类子路径部署
- SSO / token exchange
- warm pool
- Firecracker / MicroVM snapshot
- 企业级多租户 RBAC

多机 Docker 调度不属于 V1 首发范围，本文只保留后续扩展入口，不定义其 API、数据模型或调度细节。

## 1. 背景

当前 AionUi 已有两条 WebUI 运行路径：

- Electron WebUI：`AionUi --webui`
- Standalone WebUI：`aionui-web` / `@aionui/web-host`

对于服务器部署，standalone 路径是长期正确方向，因为它去掉了 Electron、Xvfb 和 GUI 运行时依赖。

现有代码已经具备核心基础能力：

- `@aionui/web-host` 负责启动 `aioncore`、提供静态资源、反代 `/api/*`、`/login`、`/logout`、`/ws`
- `aionui-web` 已提供 headless CLI 入口
- `aionui-portal` 已有基础原型，覆盖登录、容器恢复、heartbeat、空闲清理

## 2. V1 锁定决策

以下决策在 V1 中必须锁定，不能继续以“待确认”形式进入实现阶段。

| 维度 | V1 决策 | 原因 |
| --- | --- | --- |
| 操作系统 | 仅支持 Linux | 降低打包和运维差异 |
| 运行时 | 仅支持 Docker | 与现有 Portal 原型一致 |
| 部署范围 | 首期仅单机 | 最快拿到可用 PoC 和试点版本 |
| 隔离单元 | 一用户一容器 | 数据边界和故障边界清晰 |
| 路由方式 | 仅支持子域名 | 当前前端和 `web-host` 都假设根路径 `/api`、`/ws` |
| 持久化 | 每用户一个 bind mount | 最简单且适合 SQLite 的 V1 存储模型 |
| 鉴权模型 | Portal 统一身份 + 实例映射账号 + 一次性登录 ticket | 避免用户维护两套账号，同时不引入完整企业 SSO |
| 恢复策略 | `stop/start` 容器并复用数据目录 | 无需内存快照即可满足首期目标 |
| 沙箱策略 | V1 不增加额外嵌套沙箱，但必须做容器加固 | 容器是 V1 的租户隔离边界 |

## 3. 目标

### 3.1 产品目标

- 提供官方支持的 AionUi headless server runtime。
- 允许 Portal 或控制面启动、恢复、停止、查询用户实例。
- 保持浏览器模式下核心对话链路可用：
  - 登录
  - 创建会话
  - 发送消息
  - 流式响应
  - 文件上传
  - WebSocket 重连
  - 刷新后恢复历史
- 通过停止空闲用户容器释放 CPU 和内存，同时保留用户数据。

### 3.2 非目标

- 不替换桌面应用。
- 不删除 `docs/guides/deploy-server.md`。
- V1 不支持子路径部署。
- V1 不支持 Kubernetes。
- V1 不支持 SSO 或共享登录态。
- V1 不做内存快照或 MicroVM。
- V1 不承诺保留所有 Electron-only 能力。

## 4. 核心用户场景

### 4.1 单用户 Headless 部署

运维人员在一台 Linux 服务器上长期运行单实例 AionUi，并通过 HTTPS 暴露访问。

推荐形态：

```bash
aionui-web start --remote --port 25808 --data-dir /data/aionui
```

### 4.2 多用户按需恢复

Portal 先认证用户，再确保该用户对应的容器正在运行，最后把浏览器跳转到该用户独立的 AionUi 子域名。

示例：

- Portal：`https://portal.aionui.local`
- 用户 A：`https://user-a.aionui.local`
- 用户 B：`https://user-b.aionui.local`

### 4.3 空闲后恢复

用户空闲后，Portal 停止其容器，但保留该用户的数据目录。用户下次访问时，Portal 启动同一容器或按同一数据目录重建容器，实例从 SQLite 和文件恢复状态。

## 5. 当前实现约束

这些约束是设计输入，不是可选项。

### 5.1 当前代码默认根路径

当前浏览器模式前端使用同源根路径：

- HTTP 请求走 `/api/*`
- WebSocket 连接 `/ws`

当前 `web-host` 也只代理：

- `/api/*`
- `/login`
- `/logout`
- `/ws`

因此 V1 必须采用子域名 + 根路径实例。子路径部署不进入 V1。

### 5.2 当前只有后端级健康信号

`aioncore` 已暴露 `/health`，`web-host` 启动时也会等待后端健康。

但 Portal 仍需要一个实例级的 readiness 约定，至少区分：

- container started
- `aionui-web` listening
- backend healthy

## 6. V1 架构

### 6.1 运行拓扑

```text
Browser
  |
  v
Portal
  |-- auth
  |-- instance registry
  |-- lifecycle API
  |-- idle cleanup
  |
  v
Reverse Proxy
  |-- portal.aionui.local -> Portal
  |-- user-a.aionui.local -> user-a container
  |-- user-b.aionui.local -> user-b container
  |
  v
Docker
  |-- aionui-user-a
  |-- aionui-user-b
  |
  v
/data/users/<userId>
```

### 6.2 组件职责

| 组件 | 职责 |
| --- | --- |
| `aionui-web` | 启动单实例 WebUI runtime |
| `@aionui/web-host` | 启动 `aioncore`，提供静态资源，反代 HTTP 和 WebSocket |
| `aioncore` | 业务后端、鉴权、会话、文件、Agent 运行时 |
| Portal | 用户认证、实例启停、状态跟踪、空闲清理 |
| Reverse proxy | TLS 终止和子域名路由 |
| Docker | 每用户运行时隔离边界 |

### 6.3 运行单元

V1 的运行单元是一用户一容器。

每个用户实例必须拥有：

- 一个容器
- 一个数据目录
- 一个 SQLite 数据库
- 一个工作目录
- 一组日志

不允许两个运行中的容器以读写方式挂载同一个用户数据目录。

## 7. 身份与访问模型

V1 不做完整企业 SSO，但必须避免用户维护两套账号。推荐采用“Portal 统一身份 + 实例本地映射账号 + 一次性登录 ticket”。

### 7.1 Portal 身份

Portal 是唯一用户身份源，负责用户登录、用户身份确认，以及判断用户是否有权访问和恢复自己的实例。

V1 不要求 Portal 实现完整企业级账号体系，但必须具备最小安全边界：

- Portal 用户密码必须使用安全哈希存储，禁止明文密码。
- Portal 登录成功后必须签发 Portal session cookie，后续用户侧 API 从 session 解析当前用户。
- `POST /api/heartbeat` 不允许从请求体信任 `userId`，必须使用 Portal session 中的用户身份。
- Portal 用户侧写操作必须具备 CSRF 或同等 Origin 校验策略。
- Portal 管理 API 必须独立鉴权，并记录操作者、目标用户、操作类型和结果。

### 7.2 实例身份

每个 AionUi 实例继续使用自身 backend session cookie，但实例内用户必须与 Portal 用户建立固定映射。

必须满足：

- `portalUserId` 是用户身份主键
- 实例内用户表必须保存 `portalUserId` 映射字段
- Portal 创建或恢复实例时，必须确保实例内存在与 `portalUserId` 绑定的用户
- 普通用户不直接使用实例密码登录
- 实例本地密码只作为 break-glass 管理能力

### 7.3 V1 登录流程

1. 用户登录 Portal。
2. Portal 检查或启动该用户容器。
3. Portal 等待实例 readiness 通过。
4. Portal 调用实例 backend 的受控内部 API，确保实例内存在与 `portalUserId` 绑定的用户。
5. Portal 生成一次性登录 ticket。
6. Portal 将浏览器跳转到用户实例的 ticket callback URL。
7. 实例 backend 校验 ticket。
8. 校验通过后，实例 backend 签发自身 session cookie。
9. 浏览器进入 AionUi WebUI。

### 7.4 V1 取舍

V1 不做完整 SSO、组织权限同步或跨系统身份联邦，但必须做到普通用户只登录 Portal 一次。

Portal login ticket 只用于从 Portal 身份换取当前实例 session，不承担企业级 SSO 的全部职责。

### 7.5 Portal Login Ticket

ticket 推荐字段：

```json
{
  "sub": "portal-user-id",
  "instanceId": "inst_user_a",
  "aud": "aionui-instance-login",
  "exp": 1779943260,
  "jti": "single-use-nonce"
}
```

若 ticket 采用 JWT，`exp` 必须使用绝对 epoch seconds，不允许写成相对 TTL。若采用自定义签名 token，应使用 `ttlSeconds` 或等价字段表达相对有效期，避免与 JWT `exp` 语义混淆。

实例 backend 必须校验：

- ticket 签名有效
- ticket 未过期
- ticket `aud` 正确
- ticket `instanceId` 与当前实例匹配
- ticket `jti` 未使用过
- `portalUserId` 有权访问当前实例

ticket 必须一次性使用，推荐 TTL 不超过 60 秒。

### 7.6 实例用户映射

实例用户表必须通过数据库 migration 增加以下字段：

| 字段 | 说明 |
| --- | --- |
| `portal_user_id` | Portal 用户 ID |
| `portal_provider` | Portal 身份来源，例如 `aionui-portal` |
| `role` | 实例内角色 |
| `last_portal_login_at` | 最近一次通过 Portal 登录时间 |

Portal 创建实例或首次进入实例时，必须调用 backend API 完成用户创建或绑定。

### 7.7 初始密码与 break-glass

普通用户不使用实例初始密码。

V1 不允许在 Portal 流程中依赖解析 stdout 获取密码。

必须满足：

- 实例账号创建、绑定、session 签发由 backend API 负责
- Portal 负责认证用户并发放一次性登录 ticket
- 初始密码仅作为 emergency / break-glass 管理能力
- 管理员 reset-password 只用于运维兜底，不作为普通登录路径
- 普通用户不暴露初始密码或 reset-password 能力

## 8. 路由模型

### 8.1 V1 路由决策

V1 只支持子域名路由。

示例：

- `portal.aionui.local`
- `user-a.aionui.local`
- `user-b.aionui.local`

Traefik Docker label 必须使用 `Host(...)` 规则，不使用 `PathPrefix(...)` 或 strip-prefix 中间件。

示例：

```text
traefik.enable=true
traefik.http.routers.aionui-user-a.rule=Host(`user-a.aionui.local`)
traefik.http.routers.aionui-user-a.entrypoints=websecure
traefik.http.routers.aionui-user-a.tls=true
traefik.http.services.aionui-user-a.loadbalancer.server.port=25808
```

子域名生成必须满足：

- 从 `portalUserId` 或实例记录生成稳定 slug。
- slug 只能包含小写字母、数字和 `-`。
- slug 必须做唯一性校验，冲突时由 Portal 生成后缀或拒绝创建。
- slug 不得直接拼接未经清洗的用户输入到 Docker labels、容器名或路由规则。
- Portal 必须在实例记录中保存最终 `subdomain`，后续恢复复用同一个子域名。

### 8.2 明确延期

以下能力不属于 V1：

- `http://host/users/<id>/`
- 基于 `PathPrefix` 的实例路由
- 前端 `base-path` 支持
- `/users/<id>/ws`

任何实现、测试、验收中再次引入子路径方案，均视为范围外工作。

## 9. 生命周期与状态模型

### 9.1 实例状态

| 状态 | 含义 |
| --- | --- |
| `created` | 已有实例记录，但容器未运行 |
| `starting` | Portal 正在创建或启动容器 |
| `running` | WebUI 可达且 backend 健康 |
| `degraded` | 容器已启动，但 backend 不健康 |
| `stopping` | 正在停止 |
| `stopped` | 容器已停止，数据仍保留 |
| `failed` | 启动或运行失败，需要人工处理 |
| `starting_timeout` | 启动超时但容器未必已自动停止，等待运维或重试处理 |

### 9.2 状态规则

- `start` 必须幂等。
- `stop` 必须幂等。
- 同一用户的并发恢复必须 single-flight，不能拉起两个活跃实例。
- `running` 必须同时满足 HTTP 可达和 backend 健康。
- `stopped` 必须保留用户数据。
- 启动失败可以先进入 `degraded` 或 `starting_timeout`，随后由 Portal 按策略标记为 `failed` 或自动 stop 容器。

### 9.3 Readiness 约定

Portal 至少要区分三个内部阶段：

1. container started
2. `aionui-web` listening
3. backend healthy

只有达到第 3 阶段，Portal 才能向浏览器返回实例访问地址。

### 9.4 启动超时与失败策略

推荐启动时序上限：

- 容器创建 / 启动总超时：`120s`
- `aionui-web` 听端口超时：`30s`
- backend 健康超时：`90s`

建议失败行为：

- backend 健康超时后，Portal 先将实例标记为 `starting_timeout`
- 若容器仍然运行且可继续重试，可允许一次有限重试
- 若重试仍失败，Portal 将实例标记为 `failed`
- 是否自动 stop 容器由部署配置决定，V1 默认建议自动 stop，保留数据目录

建议前端轮询间隔：

- 启动轮询：`2s`
- 失败或超时重试轮询：`5s`
- 已就绪后不需要高频轮询，只保留 heartbeat

## 10. V1 控制面 API

V1 只定义首条可用链路所需的最小 API。

### 10.1 用户侧 API

| API | 用途 |
| --- | --- |
| `POST /api/login-and-resume` | 在 Portal 侧认证用户并确保实例运行 |
| `GET /api/instances/me` | 返回当前用户实例状态和 URL |
| `POST /api/instances/me/stop` | 停止当前用户实例 |
| `POST /api/heartbeat` | 上报浏览器活跃状态 |

### 10.2 管理侧 API

| API | 用途 |
| --- | --- |
| `GET /api/admin/instances/:userId` | 查询实例状态 |
| `POST /api/admin/instances/:userId/start` | 启动实例 |
| `POST /api/admin/instances/:userId/stop` | 停止实例 |
| `POST /api/admin/instances/:userId/reset-password` | break-glass 场景下重置实例密码 |

### 10.3 API 契约要求

- 生命周期 API 必须鉴权。
- 用户侧 API 只能操作调用者自己的实例。
- 管理 API 必须与用户 API 分离。
- 所有生命周期操作都必须记录审计日志。

### 10.4 通用响应格式

V1 控制面 API 推荐统一响应格式：

```json
{
  "success": true,
  "data": {}
}
```

错误响应：

```json
{
  "success": false,
  "code": "INSTANCE_NOT_READY",
  "message": "Instance is not ready"
}
```

推荐错误码：

| 错误码 | 含义 |
| --- | --- |
| `UNAUTHORIZED` | 未登录或登录已过期 |
| `FORBIDDEN` | 无权访问该实例或管理 API |
| `INSTANCE_NOT_FOUND` | 实例不存在 |
| `INSTANCE_NOT_READY` | 实例尚未 ready |
| `INSTANCE_STARTING` | 实例正在启动 |
| `INSTANCE_FAILED` | 实例处于失败状态 |
| `NO_CAPACITY` | 没有足够运行资源 |
| `RUNTIME_UNAVAILABLE` | Docker 或节点不可用 |

### 10.5 用户侧 API 契约

#### `POST /api/login-and-resume`

用途：Portal 侧登录，并确保当前用户实例进入可访问状态。

请求：

```json
{
  "username": "user-a",
  "password": "******"
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-a",
    "instanceId": "inst_user_a",
    "status": "running",
    "url": "https://user-a.aionui.local",
    "loginUrl": "https://user-a.aionui.local/auth/portal/callback?ticket=******",
    "readiness": {
      "containerStarted": true,
      "webListening": true,
      "backendHealthy": true
    }
  }
}
```

约束：

- 只有实例达到 `backendHealthy == true` 后才允许返回可进入 URL。
- 返回给浏览器的常规进入地址应为 `loginUrl`，由实例使用 ticket 换取自身 session cookie。
- 若实例还在启动，Portal 可以同步等待到超时，也可以返回 `INSTANCE_STARTING` 让前端轮询。
- 同一用户并发调用必须复用同一个启动流程。

#### `GET /api/instances/me`

用途：查询当前用户实例状态。

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-a",
    "instanceId": "inst_user_a",
    "status": "running",
    "url": "https://user-a.aionui.local",
    "loginUrl": "https://user-a.aionui.local/auth/portal/callback?ticket=******",
    "lastActiveAt": "2026-05-28T10:00:00Z",
    "readiness": {
      "containerStarted": true,
      "webListening": true,
      "backendHealthy": true
    }
  }
}
```

约束：

- `loginUrl` 中的 ticket 必须短期有效且一次性使用。
- 若调用方只需要展示状态，不应生成新的 ticket。
- 只有用户明确进入实例时，Portal 才应生成新的 `loginUrl`。

#### `POST /api/instances/me/stop`

用途：停止当前用户实例。

请求：

```json
{
  "reason": "user_requested"
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "instanceId": "inst_user_a",
    "status": "stopped"
  }
}
```

约束：

- API 必须幂等。
- 若实例已停止，仍返回成功。
- 若存在 running task，默认拒绝停止，除非后续定义 force 参数。

#### `POST /api/heartbeat`

用途：上报浏览器活跃状态。

请求：

```json
{}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "lastActiveAt": "2026-05-28T10:00:00Z"
  }
}
```

### 10.6 管理侧 API 契约

#### `GET /api/admin/instances/:userId`

用途：管理员查询指定用户实例。

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-a",
    "instanceId": "inst_user_a",
    "status": "running",
    "url": "https://user-a.aionui.local",
    "containerName": "aionui-user-a",
    "dataPath": "/data/users/user-a",
    "readiness": {
      "containerStarted": true,
      "webListening": true,
      "backendHealthy": true
    },
    "resourceLimits": {
      "cpu": 1,
      "memoryMiB": 2048
    }
  }
}
```

#### `POST /api/admin/instances/:userId/start`

用途：管理员启动或恢复指定用户实例。

请求：

```json
{
  "waitUntilReady": true
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-a",
    "instanceId": "inst_user_a",
    "status": "running",
    "url": "https://user-a.aionui.local"
  }
}
```

#### `POST /api/admin/instances/:userId/stop`

用途：管理员停止指定用户实例。

请求：

```json
{
  "reason": "admin_requested",
  "force": false
}
```

约束：

- `force=false` 时必须检查 running task。
- `force=true` 属于高风险操作，必须记录审计日志。

#### `POST /api/admin/instances/:userId/reset-password`

用途：管理员在 break-glass 场景下重置指定用户实例密码。

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-a",
    "temporaryPassword": "******",
    "expiresAt": "2026-05-28T10:10:00Z"
  }
}
```

约束：

- 密码生成和重置由 backend API 执行。
- Portal 只负责管理员鉴权、调用 backend、展示一次性结果、记录审计。
- 普通用户常规进入实例必须使用 Portal login ticket，不使用该密码。

### 10.7 实例内部 API 契约

以下 API 是 Portal 调用用户实例 backend 的受控内部接口，不直接暴露给普通浏览器调用。

#### `POST /api/internal/portal/ensure-user`

用途：确保实例内存在与 Portal 用户绑定的本地账号。

请求：

```json
{
  "portalUserId": "user-a",
  "portalProvider": "aionui-portal",
  "displayName": "User A",
  "role": "admin"
}
```

成功响应：

```json
{
  "success": true,
  "data": {
    "localUserId": "local_user_a",
    "portalUserId": "user-a",
    "created": false
  }
}
```

约束：

- 该接口必须只允许 Portal 或受信控制面调用。
- 若用户不存在，backend 创建并绑定。
- 若用户已存在，backend 返回已有绑定。
- 不允许普通用户通过该接口修改角色。

#### `GET /api/internal/portal/runtime-status`

用途：供 Portal 在 readiness、停止实例和空闲回收前查询实例运行状态。

成功响应：

```json
{
  "success": true,
  "data": {
    "backendHealthy": true,
    "runningTaskCount": 0,
    "webSocketConnectionCount": 1
  }
}
```

约束：

- 该接口必须只允许 Portal 或受信控制面调用。
- `runningTaskCount` 是 V1 停止实例和 idle cleanup 的硬门槛。
- `webSocketConnectionCount` 在 V1 只作为 telemetry，不作为停止硬门槛。
- 若该接口不可用，Portal 不得执行非 force stop。

#### `GET /auth/portal/callback?ticket=...`

用途：实例 backend 校验 Portal login ticket，并签发实例自身 session cookie。

成功行为：

- 校验 ticket
- 标记 ticket 已使用
- 设置实例 session cookie
- 跳转到 WebUI 根路径

失败行为：

- ticket 无效、过期、实例不匹配或已使用时，返回 401 或跳转到错误页

## 11. 存储模型

### 11.1 每用户目录模型

示例：

```text
/data/users/<userId>/
  ├── db/
  ├── workspace/
  ├── logs/
  └── config/
```

实际内部布局可以沿用当前 `aionui-web` 与 `aioncore` 约定，但所有权必须按用户隔离。

### 11.2 V1 存储规则

- 一用户一个可写数据根目录
- SQLite 必须位于本地磁盘或等效 bind mount
- 不允许使用 NFS 或通用 RWX 共享存储承载 SQLite
- 不允许两个运行中的容器挂载同一可写数据目录

## 12. 安全模型

### 12.1 网络暴露

- `aionui-web` 默认监听 loopback，只有显式配置时才允许远程访问
- 公网或内网正式访问必须在反向代理处统一 HTTPS
- Portal 管理 API 不得裸露

### 12.2 容器加固

V1 不在每个用户容器内再套一层执行沙箱。容器本身就是 V1 的租户边界。

但容器本身必须加固：

- 非 root 用户运行
- `cap-drop=ALL`
- `no-new-privileges=true`
- `privileged=false`
- `pids-limit` 有上限
- CPU / 内存资源限制
- 最小化可写挂载
- 只挂载用户数据目录
- 除必要工作目录外，不挂载宿主机其他路径
- 默认禁止额外宿主机网络访问策略，若需要外联则显式配置 egress policy

### 12.3 Docker Socket 风险

如果 Portal 直接访问 Docker，这本身就是高风险控制面权限。

V1 必须满足：

- Portal 管理面仅内网或受控暴露
- 优先通过 Docker socket proxy 或同等 allowlist 层访问 Docker
- 只允许操作 AionUi 托管容器
- 镜像名、挂载路径、labels 不能直接拼接未经清洗的用户输入

### 12.4 沙箱定位

对于“每个用户已经是独立容器，还要不要沙箱”，V1 的结论是：

- V1 不要求再引入额外嵌套沙箱来做租户隔离
- 但必须完成容器加固
- 若后续面向不可信代码执行场景，可再增加更强执行沙箱

## 13. 空闲回收策略

空闲回收不能只看“最近有没有 HTTP 请求”。

### 13.1 V1 活跃信号

| 信号 | 来源 | V1 要求 |
| --- | --- | --- |
| heartbeat | Browser -> Portal | 必需 |
| instance health | Portal -> instance | 必需 |
| running task count | `aioncore` API | 停止前必须检查 |
| WebSocket connection count | Proxy 或 instance | V1 可选，下一阶段建议补齐 |

### 13.2 停止规则

Portal 只有在以下条件同时满足时才允许停止实例：

- heartbeat 已过期
- backend 健康状态不再表明用户活跃
- 未报告 running task

### 13.3 用户体验要求

当用户在实例被空闲回收后再次进入：

- 若容器仍存在，则直接启动同一容器
- 若容器已被删除，则按同一数据目录重建
- 历史会话、设置、上传文件必须保留

## 14. Electron 能力兼容

浏览器模式下，核心对话能力必须保持可用。

以下能力在 V1 允许隐藏、禁用或替代：

- tray
- 原生窗口控制
- 桌面自动更新
- Electron-only 通知
- 假设桌面主机存在的原生文件或文件夹选择能力

这些降级不允许阻塞核心会话页渲染和使用。

## 15. 验收标准

### 15.1 单实例 Runtime

- 在无 Electron、无 Xvfb 的 Linux 环境启动成功
- 浏览器可以访问 WebUI
- Portal login ticket 可换取实例 session
- 可以创建会话
- 可以发送消息并收到流式响应
- 可以上传文件
- 刷新后可恢复历史
- WebSocket 断开后可重连
- `SIGTERM` 后 `aioncore` 被正确清理

### 15.2 Portal + 每用户实例

- 不同用户恢复到不同容器
- 每用户数据目录隔离
- 同一用户不会产生两个活跃可写实例
- 停止实例后释放 CPU 和内存
- 重启实例后历史会话和文件仍存在
- Portal 能查询实例状态和访问 URL
- 启动失败会进入 `failed`

### 15.3 反向代理与路由

- Portal 和用户实例的子域名路由可用
- HTTP API 可经代理访问
- `/ws` 可经代理访问
- 大文件上传可经代理访问
- HTTPS 下 Cookie 正常
- 任一用户子域名请求都不会串到其他用户实例

### 15.4 空闲恢复

- 空闲实例可停止且不丢数据
- 正在运行的任务不会被空闲清理中断
- 用户再次进入时可恢复到健康实例

### 15.5 V1 试点容量目标

V1 试点目标：

- 至少保留 20 个 stopped 实例
- 单机至少支持 5 个并发 active 实例

这里是首期验证目标，不代表长期容量承诺。

## 16. 测试计划骨架

### 16.1 单元测试

- `web-host` 启动与 backend 健康等待
- static server HTTP 代理
- static server WebSocket 代理
- Portal 状态迁移逻辑
- Portal single-flight 启动锁
- 空闲回收决策逻辑

### 16.2 集成测试

- 启动 `aionui-web` 并验证 `/login`、`/api/auth/status`、`/ws`
- `stop/start` 已存在用户容器并验证数据复用
- 模拟同用户并发恢复，验证只会有一个活跃启动流程
- 验证 Portal 只有在 backend 健康后才返回实例地址
- 验证 cleanup 会跳过存在 running task 的实例

### 16.3 E2E 测试

- Portal 登录
- 用户实例恢复
- Portal login ticket 自动进入实例
- 创建会话
- 发送消息并等待流式响应
- 上传文件
- 刷新并恢复会话
- 空闲停止后重新进入

## 17. 交付阶段

### Phase 0：Runtime / Backend 契约补齐

- 明确 `aionui-web` 实例级 readiness 聚合口径：container started、Web listening、backend `/health` healthy。
- 新增实例内部 API：`POST /api/internal/portal/ensure-user`。
- 新增 Portal login callback：`GET /auth/portal/callback?ticket=...`。
- 新增 running task count 查询能力，供 Portal stop 和 idle cleanup 使用。
- 为实例用户表增加 Portal 映射字段，并提供数据库 migration。
- 明确 ticket 签发、验签、一次性 `jti` 存储与过期清理策略。

### Phase 1：正式化单实例 Runtime

- 将 `aionui-web` 明确为推荐的 headless runtime
- 补充 Linux / Docker 部署文档
- 定义健康检查和 readiness 约定
- 验证浏览器模式下核心对话链路

### Phase 2：Portal 最小控制面

- 实现实例状态注册
- 实现 `login-and-resume`
- 实现每用户 single-flight 启动锁
- 实现实例停止和 heartbeat
- 实现基于 backend health 的 redirect gating

### Phase 3：单机 Docker 试点

- 完成每用户子域名路由
- 完成每用户 bind mount 持久化
- 完成资源限制与基础容器加固
- 验证空闲停止与恢复行为
- 验证首期容量目标

## 18. 后续扩展入口

V1 之后可以单独定义多机 Docker 调度能力，但该能力不属于本文实现范围。V1.5 设计已拆分到 [server-runtime-mode-v1.5-prd.md](server-runtime-mode-v1.5-prd.md)。

后续扩展只保留以下方向性原则：

- 仍保持子域名 + 根路径实例模型。
- 新用户可以按节点健康与容量选择 Docker 节点。
- 已有用户优先回到其数据所在节点。
- SQLite 数据目录默认绑定固定节点本地磁盘。
- 不默认做跨节点自动迁移、自动数据复制或共享存储自由调度。
- 多机节点注册、容量采集、调度权重、迁移流程、路由同步 API 必须拆到独立 PRD。

## 19. 明确延期主题

以下主题明确延期，不允许在 V1 实现过程中重新膨胀 scope：

- 子路径路由
- `--base-path`
- Kubernetes runtime
- PVC 与块存储方案
- SSO 与 token exchange
- warm pool
- MicroVM snapshot
- 企业级 RBAC

## 20. 推荐决策

以下问题在当前阶段给出推荐方案，后续实现与拆分任务默认按此执行，除非出现新的明确约束。

### 20.1 Readiness 策略

V1 推荐新增 Portal 侧聚合 readiness，而不是只依赖单一 backend health 信号。

推荐方案：

- 保留现有 `aioncore /health`
- Portal 内部聚合以下三层状态：
  - container started
  - `aionui-web` listening
  - backend `/health` 正常
- Portal 对外通过实例状态查询接口暴露 readiness 结果，而不是要求前端直接判断 backend 是否健康

推荐理由：

- 用户能否进入实例，取决于整条链路是否可用，而不只是 backend 单点健康
- 不需要首期大改 runtime 代码
- 后续扩展到多机调度时，Portal 聚合状态模型可以直接复用

### 20.2 身份映射与 break-glass 密码

V1 推荐采用 Portal 统一身份、实例映射账号、一次性 login ticket。实例密码只保留为 break-glass 管理能力。

推荐方案：

- Portal 是唯一用户身份源
- 实例 backend 保存 `portalUserId` 到本地用户的映射
- Portal 启动或恢复实例后，调用 backend API 确保映射用户存在
- Portal 生成一次性 login ticket
- 实例 backend 校验 ticket 后签发自身 session cookie
- 普通用户不使用实例密码
- break-glass 密码生成和重置由 backend API 执行
- Portal 管理员接口只负责鉴权包装、调用 backend、展示一次性结果、记录审计

推荐理由：

- 用户不需要维护两套账号和密码
- Portal 用户生命周期与实例用户映射关系固定
- 实例仍保留本地 session 和业务权限边界
- login ticket 比同步密码更安全，且比完整企业 SSO 更轻量
- 后续如果接入企业 SSO，可替换 Portal 的上游身份源，而不必重做实例映射模型

### 20.3 V1 cleanup 信号

V1 推荐先使用 `heartbeat + running task + grace period`，不强依赖 WebSocket connection count。

推荐方案：

- 停止实例前必须满足：
  - heartbeat 已过期
  - `running task count == 0`
  - 已经过固定 grace period
- WebSocket connection count 在 V1 中只作为 telemetry 采集，不作为硬门槛

推荐理由：

- WebSocket 连接数通常需要联动网关、代理和实例，首期实现成本偏高
- 首期最需要避免的是误杀仍有任务运行的实例
- heartbeat 足以表达页面仍在活跃使用

### 20.4 默认资源配额

V1 推荐默认每用户容器配额为 `1 vCPU + 2 GiB memory`，并允许按部署配置覆盖。

推荐方案：

- 默认 hard limit：
  - CPU：`1`
  - Memory：`2Gi`
- 可选轻量档：
  - CPU：`0.5`
  - Memory：`1Gi`
- 默认配置不应低于 `0.5 vCPU + 1 GiB memory`

推荐理由：

- `aioncore + web-host + Agent / CLI` 的运行峰值并不低
- 过低配额会让长对话、索引、diff、CLI 启动等场景变脆
- 对 V1 的首期容量目标而言，`1 vCPU + 2 GiB` 是更稳妥的起点
