# AionUi Server Runtime Mode PRD

## 1. 背景

当前 AionUi 已支持两类 WebUI 运行路径：

- Electron WebUI：通过桌面应用启动 `AionUi --webui`，在服务器场景通常需要 Xvfb。
- Standalone WebUI：通过 `aionui-web` / `@aionui/web-host` 启动，无 Electron 依赖。

现有 `docs/guides/deploy-server.md` 继续保留，作为 Electron + Xvfb 方式的部署指南。本文新增一种服务器运行模式：在无 Electron、无图形环境依赖的服务器上长期运行 AionUi，并允许外部系统通过 API 启动、恢复、停止或访问用户实例。

## 2. 目标

### 2.1 产品目标

- 提供正式的 Server Runtime Mode，支持 AionUi 在 Linux 服务器、容器、Kubernetes 等环境长期运行。
- 去除 Electron、Xvfb、Chromium GUI 对服务端部署的强依赖。
- 支持用户通过 HTTP API 启动或恢复自己的 AionUi WebUI 实例。
- 支持基于容器的 Serverless-like 架构：用户访问时按需启动，空闲后释放 CPU 和内存，数据通过持久卷保留。
- 保证核心前端对话能力在 Server Runtime Mode 下与 Electron + Xvfb 方式保持一致。
- 为多用户、按需拉起、空闲回收、容器隔离提供清晰架构。
- 支持基于 Kubernetes 的 Serverless 架构。
- 用户登录后自动启动或恢复独立 AionUi 实例容器。
- 管理员可以通过Portal API 统一管理所有用户实例，包括启动、恢复、停止、访问等。同时指出多机扩容配置。

### 2.2 非目标

- 不替换现有桌面应用。
- 不删除或修改 `docs/guides/deploy-server.md`。
- 不要求首期实现完整企业级多租户权限系统。
- 不要求首期支持所有 Electron 原生能力，例如托盘、窗口控制、系统通知、原生文件选择器。
- 不要求首期实现 Firecracker / CRIU 级别的内存快照恢复。AionUi 首期以“数据卷恢复”为主，避免把复杂度放在内存快照层。

## 3. 用户场景

### 3.1 单用户服务器长期运行

用户在一台 VPS 或内网服务器上部署 AionUi，希望它像常驻服务一样运行：

- 服务随系统启动。
- 浏览器访问 WebUI。
- 数据保存在固定目录。
- 通过反向代理暴露 HTTPS。

推荐形态：

```bash
aionui-web start --remote --port 25808 --data-dir /data/aionui
```

### 3.2 多用户按需启动

平台方部署一个 Portal 服务。用户登录后，Portal 为该用户启动或恢复独立 AionUi 实例，然后跳转到对应 WebUI 地址。

示例流程：

1. 用户访问 Portal。
2. Portal 调用 `POST /api/login-and-resume`。
3. Portal 校验用户身份。
4. Portal 启动或恢复用户实例。
5. Portal 返回实例访问地址。
6. 用户浏览器进入对应 AionUi WebUI。
7. 用户页面定期发送 heartbeat。
8. Portal 对空闲实例执行停止或回收。

### 3.3 外部系统通过 API 启动

企业内部系统或自动化平台希望通过 API 启动 AionUi 实例：

- 创建临时任务环境。
- 启动指定用户实例。
- 查询实例健康状态。
- 获取访问 URL。
- 任务结束后停止实例。

### 3.4 内网无域名访问

很多企业内网无法配置泛域名或外部 DNS，只能通过固定 IP 访问。该场景要求：

- 用户先访问统一 Portal，例如 `http://192.168.1.200`。
- Portal 登录后返回用户工作台路径或实例 URL。
- 若无域名，首期可以使用动态子路径，例如 `/users/user-a/`。
- 网关根据 PathPrefix 将请求转发到用户实例。
- 前端静态资源、API 和 WebSocket 必须适配子路径部署，不能假设所有资源都在域名根路径。

## 4. 现有能力评估

### 4.1 可复用模块

#### `@aionui/web-host`

`packages/web-host/src/index.ts` 已提供 WebUI 主编排能力：

- 启动 `aioncore` 子进程。
- 启动静态 Web 服务。
- 反向代理 `/api/*`、`/login`、`/logout` 到后端。
- 透传 `/ws` WebSocket 到后端。
- 返回 `localUrl`、`networkUrl`、`backendPort`、`stop()` 等运行句柄。

#### `@aionui/web-cli`

`packages/web-cli/src/index.ts` 已提供无 Electron 的 standalone CLI：

- `aionui-web start`
- `aionui-web resetpass`
- 支持 `--port`
- 支持 `--remote`
- 支持 `--data-dir`
- 支持 `--log-dir`
- 支持 `--static-dir`
- 支持 `--backend-bin`
- 支持 bundled `aioncore`

#### `aionui-portal`

`packages/aionui-portal` 已有轻量 Portal 原型：

- 用户登录。
- Docker 容器创建或恢复。
- 用户数据目录挂载。
- SQLite 持久化 session。
- heartbeat 保活。
- 空闲容器清理。
- Traefik path-based routing label。

### 4.2 已满足 Server Runtime Mode 的基础条件

- 前端可在浏览器环境运行，不依赖 Electron preload。
- HTTP 调用在 WebUI 模式下使用同源请求，由 `web-host` 反代到后端。
- WebSocket 在 WebUI 模式下连接同源 `/ws`，由 `web-host` 透传到后端。
- 文件上传在 WebUI 模式下走 `/api/fs/upload` multipart。
- `aioncore` 已作为独立后端进程被 `web-host` 管理。

## 5. 推荐架构

### 5.1 单实例架构

```text
Browser
  |
  | HTTP / WebSocket
  v
aionui-web
  |
  | startWebHost()
  v
@aionui/web-host
  |-- Static SPA server
  |-- /api reverse proxy
  |-- /ws TCP splice
  |
  v
aioncore
  |
  v
data-dir / SQLite / workspace files
```

适合个人服务器、单租户部署、内网工具机。

### 5.2 多实例架构

```text
Browser
  |
  v
Portal / Control Plane
  |-- Auth
  |-- Instance API
  |-- Session registry
  |-- Idle cleanup
  |-- Routing metadata
  |
  v
Container Runtime / Process Runtime
  |
  |-- aionui-web instance A
  |-- aionui-web instance B
  |-- aionui-web instance C
  |
  v
Per-user data dirs
```

推荐首选容器隔离：

- 每个用户一个容器。
- 每个用户一个独立数据目录。
- 容器内固定端口。
- 外部通过 Traefik / Nginx / Ingress 路由到实例。

### 5.3 组件职责

| 组件 | 职责 |
| --- | --- |
| `aionui-web` | 单实例 WebUI runtime，负责启动 WebHost 和 aioncore |
| `@aionui/web-host` | 进程编排、静态服务、API/WS 代理 |
| `aioncore` | 业务后端、会话、Agent、文件、设置、鉴权 |
| Portal | 用户认证、实例生命周期、路由、空闲回收 |
| Reverse Proxy | HTTPS、路径或域名路由、WebSocket 转发 |
| Runtime | systemd、Docker、Kubernetes 等长期运行载体 |

### 5.4 容器 Serverless 架构定位

Server Runtime Mode 可以演进为基于容器的 Serverless-like 架构，但它不是传统 FaaS：

- AionUi 有 WebSocket 长连接。
- `aioncore` 是长期进程。
- Agent / CLI 任务可能长时间运行。
- SQLite、workspace、配置和聊天记录需要持久化。
- 用户浏览器必须稳定路由到同一个实例。

因此目标应定义为：按需启动、空闲回收、容器隔离、持久卷恢复，而不是每次请求都无状态执行。

推荐运行单元：

| 运行单元 | 适用场景 | 评价 |
| --- | --- | --- |
| 一用户一容器 | 企业多用户、内网协作平台 | 首选，隔离和数据模型清晰 |
| 一 workspace 一容器 | 临时任务、沙箱、教学环境 | 隔离更强，成本更高 |
| 预热池容器 | 追求更低冷启动 | 可作为优化，不作为首期必选 |

### 5.5 快照与恢复策略

不建议首期做内存级快照。原因：

- AionUi 的核心状态主要在 SQLite、配置文件和 workspace 文件中。
- 容器重启后只要挂载同一个数据目录，业务状态即可恢复。
- 内存快照会显著增加调度、兼容性和运维复杂度。
- Firecracker / Fly.io 类 MicroVM 快照适合极致冷启动和强隔离场景，但首期投入较高。

首期推荐：

```text
停止或删除容器
  |
  v
保留用户数据卷
  |
  v
下次访问时重新启动容器并挂载同一数据卷
  |
  v
aioncore 从 SQLite 和配置恢复状态
```

可选高级路线：

| 技术 | 适用阶段 | 优点 | 风险 |
| --- | --- | --- | --- |
| Docker stop/start + bind mount | PoC / 中小规模 | 简单、冷启动快、本地 IO 快 | 单机容量受限 |
| K8s + Longhorn / Ceph RBD | 企业内网规模化 | 调度标准、存储高可用 | 运维复杂，需要块存储经验 |
| Firecracker MicroVM snapshot | 极致冷启动 / 高安全隔离 | 恢复可达亚秒级 | 平台建设成本高，首期不推荐 |

## 6. Server Runtime Mode 产品能力

### 6.1 单实例能力

必须支持：

- 指定监听端口。
- 指定是否允许远程访问。
- 指定数据目录。
- 指定日志目录。
- 指定 backend binary。
- 启动后输出本地访问 URL。
- 首次启动生成或提示管理员账号密码。
- 支持优雅退出，停止静态服务和 `aioncore`。
- 支持健康检查。

建议支持：

- `--host` 显式绑定地址。
- `--base-path` 支持路径前缀部署。
- `--health-port` 或管理接口。
- JSON 格式日志。
- structured startup event，便于 Portal 读取实例 URL 和状态。

### 6.2 API 控制能力

Portal 或 Control Plane 应提供：

| API | 用途 |
| --- | --- |
| `POST /api/login-and-resume` | 登录并启动或恢复用户实例 |
| `POST /api/instances` | 创建实例 |
| `POST /api/instances/:id/start` | 启动实例 |
| `POST /api/instances/:id/stop` | 停止实例 |
| `POST /api/instances/:id/restart` | 重启实例 |
| `GET /api/instances/:id` | 查询实例状态 |
| `GET /api/instances/:id/health` | 查询实例健康 |
| `GET /api/instances/:id/logs` | 查询启动日志或错误 |
| `POST /api/heartbeat` | 浏览器保活 |
| `POST /api/instances/:id/reset-password` | 重置实例管理员密码 |

首期可以先实现 `login-and-resume`、`status`、`stop`、`heartbeat`。

### 6.3 实例状态模型

建议状态：

| 状态 | 含义 |
| --- | --- |
| `created` | 已创建记录，但未启动 |
| `starting` | 正在拉起容器或进程 |
| `running` | WebUI 和后端健康 |
| `degraded` | 静态 Web 可访问，但 backend 不健康 |
| `stopping` | 正在停止 |
| `stopped` | 已停止 |
| `failed` | 启动或运行失败 |

## 7. 与 Electron + Xvfb 方式的功能差异

### 7.1 核心对话能力

| 功能 | Electron + Xvfb | Server Runtime Mode | 差异风险 |
| --- | --- | --- | --- |
| 打开 WebUI | 支持 | 支持 | 无 |
| 登录认证 | 支持 | 支持 | 需确保 Cookie、反代路径、SameSite 配置正确 |
| 创建会话 | 支持 | 支持 | 无，走 `/api/conversations` |
| 发送消息 | 支持 | 支持 | 需验证 `/api/conversations/:id/messages` 与 WS 流事件 |
| 流式响应 | 支持 | 支持 | 关键风险点，依赖 `/ws` 透传稳定性 |
| Agent 事件推送 | 支持 | 支持 | 关键风险点，依赖 WebSocket reconnect 和鉴权 |
| 会话列表更新 | 支持 | 支持 | 依赖 `conversation.listChanged` WS 事件 |
| 文件上传 | 支持 | 支持 | WebUI 使用 multipart 上传，不依赖本地文件 path |
| 工作区文件读取 | 支持 | 支持 | 文件路径位于服务器/容器内，不是客户端本机 |
| Cron / scheduled tasks | 支持 | 支持 | 需确认实例常驻和时区配置 |
| Channel 消息接入 | 支持 | 支持 | Server Runtime 更适合长期接入 |

结论：核心前端对话链路理论上等价，前提是 HTTP 和 `/ws` 反代完整、Cookie 鉴权正确、实例不会被过早回收。

### 7.2 Electron 原生能力

| 功能 | Electron + Xvfb | Server Runtime Mode | 说明 |
| --- | --- | --- | --- |
| 托盘 | 支持 | 不支持 | 服务器模式无桌面托盘 |
| 窗口控制 | 支持 | 不支持 | 浏览器环境无 Electron 窗口 API |
| 系统通知 | 支持 Electron 通知 | 不支持或改为浏览器通知 | 需产品降级 |
| 原生文件选择器 | 支持 | 浏览器文件选择器 | 文件来自客户端，需要上传到服务器 |
| `shell.openExternal` | 在服务器/桌面打开 | 在客户端浏览器打开 | 行为不同但更符合 Web 直觉 |
| 打开本地文件 | 打开服务器文件或桌面文件 | 不能直接打开客户端文件路径 | 需转为下载/预览 |
| 自动更新桌面应用 | 支持 | 不适用 | 改为镜像或二进制升级 |
| GPU / Chromium 配置 | 相关 | 不适用 | Server Runtime 无 Chromium GUI |
| Xvfb | 必需或常见 | 不需要 | Server Runtime 的核心优势 |

### 7.3 文件语义差异

Electron + Xvfb 中，虽然跑在服务器上，但 Electron 仍是一个桌面进程，部分能力会按“本机桌面”理解。

Server Runtime Mode 中：

- 浏览器选择的文件属于客户端，需要上传到后端。
- Agent 看到的路径属于服务器或容器文件系统。
- 工作区应明确为服务器/容器内路径。
- 下载、预览、打开文件不能默认假设客户端存在同一路径。

该差异不会直接破坏对话，但会影响“把本机文件拖入对话”“打开文件位置”等体验。

## 8. 前端对话链路风险评估

### 8.1 当前 WebUI 适配情况

前端已有 WebUI 浏览器适配：

- `httpBridge.getBaseUrl()` 在浏览器 WebUI 模式返回空字符串，使用同源 `/api/*`。
- `httpBridge.getWsUrl()` 在浏览器 WebUI 模式使用当前 origin 的 `/ws`。
- `adapter/browser.ts` 在无 `window.electronAPI` 时使用 WebSocket bridge。
- WebSocket 支持重连、登录后 reconnect、`auth-expired` 跳登录页。
- `FileService.uploadFileViaHttp()` 支持浏览器文件 multipart 上传。

这些设计说明前端对话并不强依赖 Electron IPC。

### 8.2 关键风险

#### 风险 1：WebSocket 反代不完整导致流式对话中断

表现：

- 用户消息已发送，但助手流式内容不更新。
- 会话列表不自动刷新。
- Agent command / approval / file change 事件不出现。

原因：

- 反向代理未转发 WebSocket upgrade。
- `/ws` path 被 rewrite 错误。
- path-prefix 部署时 `/ws` 没有落到实例。
- 负载均衡未保持实例路由一致。

要求：

- Reverse proxy 必须支持 WebSocket。
- `/ws` 必须与当前 WebUI 实例保持同一路由。
- 多实例场景必须 sticky 到同一用户实例。

#### 风险 2：登录 Cookie 在子路径或跨域部署下失效

表现：

- 页面能打开，但 API 返回 401。
- WebSocket 连接 close code 1008。
- 登录后跳回登录页。

原因：

- Cookie Path 与部署 base path 不一致。
- SameSite / Secure 与 HTTPS 配置不匹配。
- Portal 和实例跨域但没有统一认证策略。

要求：

- 首期推荐同域同 path-prefix 访问。
- 反代层统一 HTTPS。
- 明确 Cookie Path 策略。
- 避免 Portal 登录态和 AionUi 实例登录态互相混淆。

#### 风险 3：实例空闲回收导致对话被中断

表现：

- 长任务执行中实例被停止。
- 页面还在但后端断开。
- Agent 任务状态丢失。

要求：

- heartbeat 不能只看页面在线，还要看后端是否有 running task。
- cleanup 前查询实例 active sessions / running jobs。
- 默认空闲超时不应短于常见长任务时长。
- stopping 前向前端广播即将回收事件。

#### 风险 4：容器资源限制导致 Agent 对话失败

表现：

- CLI Agent 启动超时。
- 大上下文任务失败。
- 文件索引或 diff 操作异常。

要求：

- 默认资源限制不能过低。
- 暴露 per-instance CPU、内存配置。
- 对 `aioncore` 和 Agent 子进程日志可观测。

#### 风险 5：服务器 PATH / CLI 环境与桌面不同

表现：

- Claude / Gemini / Codex 等 CLI Agent 在服务器模式下不可用。
- UI 报告 tool not found。

要求：

- Server Runtime 镜像内置或文档要求安装必要 CLI。
- 支持为实例注入 PATH 和 env。
- 健康检查覆盖 Agent 可用性。

#### 风险 6：前端仍存在 Electron-only 入口

表现：

- 点击某些设置或工具无响应。
- 浏览器控制台出现 IPC provider timeout。

已知需要降级或隐藏的能力：

- 窗口控制。
- 托盘设置。
- 桌面宠物。
- 原生系统通知。
- 原生文件夹选择。
- 桌面自动更新。

要求：

- WebUI 浏览器模式下隐藏或禁用 Electron-only 设置项。
- 对不可用功能显示明确替代行为。
- 不允许 Electron-only provider 阻塞核心对话页面渲染。

#### 风险 7：SQLite 放在错误存储上导致锁库或损坏

表现：

- 后端频繁出现 `database is locked`。
- 会话保存失败。
- 设置写入失败。
- 极端情况下 SQLite 文件损坏。

原因：

- 多用户共享同一个 SQLite。
- SQLite 数据目录挂载在 NFS 或不可靠的网络文件系统上。
- 多个容器同时以读写方式挂载同一用户数据目录。

要求：

- 每个用户实例独立 SQLite 和数据目录。
- 同一用户同一时间只能有一个写入实例。
- Docker PoC 优先使用本地 SSD/NVMe bind mount。
- K8s 生产环境使用 Longhorn 或 Ceph RBD 这类块存储。
- PVC 使用 `ReadWriteOnce`，不要使用 `ReadWriteMany` 存放 SQLite。
- 控制面必须有启动锁，避免并发拉起两个同用户容器。

#### 风险 8：冷启动体验不可控

表现：

- 用户点击进入工作台后长时间白屏。
- 容器启动完成但前端 API 仍 502。
- 首次登录时镜像拉取导致等待几十秒。

要求：

- 控制面提供初始化页，不让用户直接看到 502。
- 镜像预拉取。
- Portal 只在实例健康检查通过后返回工作台 URL。
- 区分 container running、Web server ready、backend ready 三个状态。
- 冷启动指标必须采集：镜像拉取时间、容器启动时间、aioncore ready 时间、WebUI 首屏时间。

#### 风险 9：子路径部署导致静态资源、API 或 WebSocket 路由错误

表现：

- 访问 `/users/user-a/` 白屏。
- 静态资源请求跑到 Portal 根路径。
- `/api/*` 请求没有进入用户容器。
- `/ws` 被网关路由到错误实例。

要求：

- 首期优先采用子域名方案，降低前端 base-path 改造。
- 如果必须纯 IP + 子路径访问，需要明确支持 base-path。
- API 和 WebSocket URL 不能硬编码为根路径。
- Cookie Path、登录跳转、登出路径必须和 base-path 一致。

## 9. 部署方案

### 9.0 部署路径决策

| 阶段 / 规模 | 推荐方案 | 说明 |
| --- | --- | --- |
| PoC / 内网试点 / 1 台服务器 | 单机 Docker + Traefik + 本地目录挂载 | 最快验证冷启动、WebSocket、SQLite 和文件语义 |
| 中小规模 / 多台服务器但无 K8s | 多机 Docker + 控制面调度 | 控制面按用户把容器分配到固定节点，数据目录需要跟随节点 |
| 企业规模 / 已有 K8s | K8s + Longhorn 或 Ceph RBD + Ingress | 标准云原生路线，支持动态调度和块存储 |
| 极致冷启动 / 强隔离 | Firecracker / MicroVM snapshot | 后续高级路线，不作为首期目标 |

首期推荐先做单机 Docker PoC。只有当用户规模、容灾和调度需求明确后，再上 K8s + Longhorn / Ceph RBD。

### 9.1 单机 systemd

适合单用户部署。

```ini
[Unit]
Description=AionUi Server Runtime
After=network.target

[Service]
Type=simple
User=aionui
Environment=AIONUI_DATA_DIR=/var/lib/aionui
Environment=AIONUI_LOG_DIR=/var/log/aionui
ExecStart=/opt/aionui-web/aionui-web start --remote --port 25808
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 9.2 Docker 单实例

适合单用户或小规模部署。

```bash
docker run -d \
  --name aionui-web \
  -p 25808:25808 \
  -v /data/aionui:/app/data \
  -e AIONUI_DATA_DIR=/app/data \
  aionui-web:latest \
  aionui-web start --remote --port 25808
```

### 9.3 Portal + Docker 多实例

适合多用户按需启动。

```text
Portal
  |
  | Docker API
  v
aionui-web:<version>
  - /data/users/user-a -> /app/data
  - /data/users/user-b -> /app/data
```

每个实例：

- 独立容器。
- 独立数据卷。
- 独立 AionUi 用户表和会话。
- 通过 path 或 subdomain 暴露。

推荐基础拓扑：

```text
Browser
  |
  v
Traefik
  |-- Docker provider watches docker.sock
  |
  v
Portal
  |-- Docker API
  |-- /data/users/<userId>
  |
  v
aionui-web container
  |-- /app/data -> /data/users/<userId>
```

Docker runtime 推荐策略：

- 用户容器不存在：`docker run` 创建容器，挂载 `/data/users/<userId>`。
- 用户容器已停止：`docker start` 恢复容器，冷启动通常明显快于重新创建容器。
- 用户短期空闲：只执行 `container.stop()`，释放内存但保留容器实体。
- 用户长期不用：可执行 `container.remove()`，数据仍保留在 `/data/users/<userId>`。
- 镜像提前拉取到本机，避免首次登录时下载镜像。
- 容器内必须设置 `AIONUI_DATA_DIR=/app/data`。

Traefik 是推荐网关之一，原因：

- 开源，可免费商用。
- Go 单二进制，运行轻量。
- 支持 Docker provider，能通过容器 labels 自动发现服务。
- 新用户容器启动后无需 reload 网关，不会打断现有 WebSocket。

### 9.4 纯 IP + 子路径访问

适合没有内网 DNS、只能使用固定 IP 的环境。

示例：

```text
Portal: http://192.168.1.200/
User A: http://192.168.1.200/users/user-a/
User B: http://192.168.1.200/users/user-b/
```

访问流程：

1. 用户访问 `http://192.168.1.200/`。
2. Portal 完成登录。
3. 用户点击进入工作台。
4. Portal 检查用户容器状态。
5. 如果容器停止，Portal 调 Docker API 启动容器。
6. Portal 返回 `/users/<userId>/`。
7. 浏览器跳转到用户专属路径。
8. Traefik 根据 PathPrefix 转发到对应容器。

Traefik label 示例：

```text
traefik.enable=true
traefik.http.routers.aionui-user-a.rule=PathPrefix(`/users/user-a`)
traefik.http.routers.aionui-user-a.entrypoints=web
traefik.http.middlewares.aionui-user-a-strip.stripprefix.prefixes=/users/user-a
traefik.http.middlewares.aionui-user-a-strip.stripprefix.forceslash=true
traefik.http.routers.aionui-user-a.middlewares=aionui-user-a-strip
traefik.http.services.aionui-user-a.loadbalancer.server.port=25808
```

注意：该方案不是完全零改造。当前 renderer 构建已使用 `base: './'`，并且路由使用 HashRouter，这有利于子路径部署；但前端 HTTP 和 WebSocket 仍默认使用同源根路径 `/api/*` 和 `/ws`。如果网关在转发前 strip 掉 `/users/user-a`，浏览器发起的 `/api/*` 仍可能打到 Portal 根路径，而不是用户实例。

因此二选一：

- 推荐方案 A：每个用户使用独立子域名，例如 `user-a.aionui.local`，实例仍运行在根路径 `/`，前端无需 base-path 改造。
- 方案 B：支持子路径部署，需要为前端和 `web-host` 增加 base-path 能力，使 API、WebSocket、静态资源和登录跳转都以 `/users/<userId>/` 为前缀。

子路径部署必须验收：

- `/users/<id>/assets/*` 能加载静态资源。
- `/users/<id>/api/*` 能转发到对应实例。
- `/users/<id>/ws` 能升级 WebSocket。
- 登录、登出、Cookie Path 都在用户路径下有效。
- 刷新页面不会回到 Portal 或白屏。

### 9.5 Kubernetes + Longhorn / Ceph RBD

适合企业部署。

推荐模型：

- Portal 作为 Deployment。
- 用户实例作为 Deployment 或 StatefulSet。
- 每个用户一个 PVC。
- Ingress 根据用户 path 或 subdomain 路由。
- 使用 TTL controller 或 Portal cleanup 回收空闲实例。

内网没有公有云块存储时，推荐：

| 存储 | 适用场景 | 说明 |
| --- | --- | --- |
| Longhorn | 中小型内网 K8s | 运维较轻，Rancher 生态，适合 PoC 到中等规模 |
| Ceph RBD | 大型内网 / 高可用要求高 | 行业标准，性能和扩展性强，运维复杂 |

关键要求：

- SQLite 数据目录必须使用块存储，不要使用 NFS 或普通共享文件系统。
- PVC 使用 `ReadWriteOnce`。
- StorageClass 设置 `reclaimPolicy: Retain`，删除 Pod 或 Deployment 不删除数据。
- Pod 销毁只释放 CPU / 内存，不删除 PVC。

Longhorn StorageClass 示例：

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: longhorn-user-data
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "30"
```

用户实例资源建议：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-user-001
  namespace: aionui-tenant
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-user-data
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deploy-user-001
  namespace: aionui-tenant
spec:
  replicas: 1
  selector:
    matchLabels:
      app: aionui-user-001
  template:
    metadata:
      labels:
        app: aionui-user-001
    spec:
      containers:
        - name: aionui
          image: your-registry.local/aionui-web:v1.0
          env:
            - name: AIONUI_DATA_DIR
              value: /app/data
          ports:
            - containerPort: 25808
          resources:
            requests:
              cpu: "200m"
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: data-volume
              mountPath: /app/data
      volumes:
        - name: data-volume
          persistentVolumeClaim:
            claimName: pvc-user-001
```

K8s 冷启动优化：

- 使用 DaemonSet 在所有节点预拉取 `aionui-web` 镜像。
- 控制面优先把用户调度到其 PVC 所在或最优节点。
- 对常用用户或高频用户保留 warm pod。
- 前端提供“环境初始化中”页面，覆盖 1 到 4 秒冷启动窗口。

## 10. 安全要求

### 10.1 网络暴露

- 默认只监听 `127.0.0.1`。
- 只有显式 `--remote` 或配置允许时监听 `0.0.0.0`。
- 公网部署必须使用 HTTPS。
- 管理 API 不应直接公网裸露。

### 10.2 认证

- AionUi 实例继续使用后端认证。
- Portal 认证与实例认证需要明确边界。
- 首期可以采用 Portal 登录后跳转实例登录。
- 后续可设计 SSO token exchange，但不能绕过实例鉴权。

### 10.3 数据隔离

- 多用户模式必须一用户一数据目录。
- 容器运行用户不应是 root。
- 数据目录权限最小化。
- 不同用户实例不能共享 SQLite。
- K8s 模式下 SQLite 所在 PVC 必须是 `ReadWriteOnce` 块存储。
- 不允许两个运行中的容器同时挂载同一个用户数据卷进行写入。
- 删除实例时只删除运行时资源，不删除用户数据卷。

### 10.4 API 权限

- 启动、停止、重置密码等 API 必须鉴权。
- 用户只能操作自己的实例。
- 管理员 API 与用户 API 分离。
- 所有生命周期操作记录审计日志。

### 10.5 Docker Socket 风险

单机 Docker 方案中，Portal 通常需要访问 `/var/run/docker.sock`。这等价于给 Portal 近似宿主机 root 权限，必须额外约束：

- Portal 不对公网暴露管理 API。
- Portal 容器最小权限运行。
- Docker API 操作必须做 allowlist，只能创建和管理 AionUi 用户容器。
- 用户输入不能直接拼进容器名、volume 路径、labels 或镜像名。
- 生产环境优先考虑 Docker socket proxy，限制可调用 API。
- 审计所有容器创建、启动、停止、删除操作。

## 11. 配置项

### 11.1 `aionui-web` 配置

| 配置 | 来源 | 默认值 | 说明 |
| --- | --- | --- | --- |
| port | CLI / env | `25808` | WebUI 监听端口 |
| remote | CLI / env | `false` | 是否允许远程访问 |
| dataDir | CLI / env | `~/.aionui-web` | 实例数据目录 |
| logDir | CLI / env | `<dataDir>/logs` | 日志目录 |
| staticDir | CLI / env | packaged static | 前端静态资源目录 |
| backendBin | CLI / env | bundled aioncore | 后端二进制路径 |

### 11.2 Portal 配置

| 配置 | 说明 |
| --- | --- |
| portal port | Portal API 监听端口 |
| users data root | 所有用户数据目录根路径 |
| runtime type | Docker / process / Kubernetes |
| image version | `aionui-web` 镜像版本 |
| idle timeout | 空闲回收时间 |
| cleanup interval | 回收扫描间隔 |
| default memory | 实例内存限制 |
| default CPU | 实例 CPU 限制 |
| reverse proxy mode | path / subdomain |
| container stop mode | `stop` / `remove` / K8s delete Deployment |
| storage class | K8s 模式下的用户数据 StorageClass |
| base path mode | 是否启用 `/users/<id>/` 子路径部署 |
| warm pool size | 预热实例数量，可选 |
| image pre-pull | 是否启用节点预拉取镜像 |
| max active instances | 最大同时运行实例数 |

### 11.3 空闲回收策略

空闲回收不能只看“30 分钟没有 HTTP 请求”。AionUi 存在 WebSocket、长任务、Cron、Agent 子进程和 Channel 接入，需要组合判断。

建议实例活跃信号：

| 信号 | 来源 | 用途 |
| --- | --- | --- |
| HTTP request time | Gateway / Portal | 判断页面近期访问 |
| WebSocket connection count | Gateway / instance | 判断浏览器是否仍在线 |
| heartbeat | Browser -> Portal | 判断前端是否活跃 |
| running task count | aioncore API | 防止长任务被杀 |
| Agent process count | instance telemetry | 防止 CLI Agent 被杀 |
| channel connector status | aioncore API | 防止消息通道常驻场景被回收 |

建议策略：

- 没有运行任务、没有 WebSocket、没有 heartbeat 且超过 idle timeout，才允许停止。
- stop 前进入 `stopping` 状态，并广播即将休眠。
- 对正在流式输出的会话禁止回收。
- 对 Cron / Channel 用户允许配置更长 idle timeout 或常驻。
- 首期可以先用 Portal heartbeat + running task API；后续再接网关指标。

## 12. 兼容性策略

### 12.1 保留 Electron + Xvfb 文档

`docs/guides/deploy-server.md` 保留，定位为 legacy / compatibility server deployment。

适用场景：

- 用户已经依赖 Electron 打包产物。
- 用户需要尽可能复用桌面路径。
- 旧部署流程不希望短期迁移。

### 12.2 新增 Server Runtime Mode 文档

新增独立文档，定位为 recommended headless server deployment。

适用场景：

- 新服务器部署。
- 容器部署。
- 多用户按需启动。
- 不希望安装 Electron 依赖。
- 不希望使用 Xvfb。

### 12.3 功能降级原则

- 对话、Agent、文件、设置等核心能力必须保持。
- Electron-only 功能允许隐藏、禁用或替换。
- 不允许 Electron-only 功能失败影响核心会话页面。

## 13. 验收标准

### 13.1 单实例验收

- 在无 Xvfb、无 Electron 的 Linux 环境启动成功。
- 浏览器可以访问 WebUI。
- 首次启动可以完成登录或获取初始密码。
- 可以创建会话。
- 可以发送消息并收到流式响应。
- 刷新页面后会话历史存在。
- 可以上传文件并在对话中使用。
- WebSocket 断开后可以自动重连。
- `SIGTERM` 后 `aioncore` 子进程被清理。

### 13.2 多实例验收

- 不同用户启动不同实例。
- 不同用户数据目录隔离。
- 用户只能访问自己的实例。
- 空闲实例会被停止。
- 活跃对话或运行任务不会被错误回收。
- 实例重启后历史数据仍存在。
- Portal 可以查询实例状态和访问 URL。
- 同一用户并发点击进入工作台，只会启动一个实例。
- 用户容器停止后，内存释放，数据目录仍保留。
- 用户容器重新启动后，历史会话、设置、文件和登录状态按预期恢复。

### 13.3 前端对话验收

必须覆盖以下场景：

- 创建普通会话。
- 创建 ACP / CLI Agent 会话。
- 发送普通文本消息。
- 发送带文件消息。
- 长时间流式输出。
- 页面刷新后恢复当前会话。
- WebSocket 重连后继续接收事件。
- Agent 写文件后前端收到文件变更事件。
- 会话列表自动刷新。
- 登录过期后跳转登录页。

### 13.4 反向代理验收

- HTTP API 正常。
- `/ws` WebSocket 正常。
- 大文件上传正常。
- HTTPS 下 Cookie 正常。
- path-prefix 或 subdomain 路由不会串实例。

### 13.5 容器 Serverless 验收

- 镜像已预拉取时，Docker stop/start 恢复目标小于 1 秒。
- Docker run 新建实例目标小于 4 秒。
- K8s + Longhorn 创建 Pod 并挂载 PVC 目标小于 5 秒。
- Portal 初始化页能覆盖冷启动窗口，不出现裸 502。
- 容器停止后，CPU 和内存占用释放。
- PVC / bind mount 数据不丢失。
- 删除 Deployment / stop container 不删除用户数据。
- 空闲回收不会中断正在流式输出的会话。
- 网关动态路由更新不影响其他用户 WebSocket。
- 单机 Docker PoC 至少验证 20 个停止实例、5 个并发活跃实例。

## 14. 测试计划

### 14.1 单元测试

- `@aionui/web-host` backend launcher。
- static server API proxy。
- static server WebSocket splice。
- CLI 参数解析。
- Portal session repository。
- Portal instance state transition。

### 14.2 集成测试

- 启动 `aionui-web`，访问 `/login`、`/api/auth/status`、`/ws`。
- 模拟 backend crash，验证状态和日志。
- 模拟 WebSocket 断开，验证前端 reconnect。
- 模拟文件上传，验证返回服务器路径。
- 模拟空闲回收，验证 running task 不被杀。
- 模拟同用户并发启动，验证启动锁。
- 模拟容器 stop/start，验证 SQLite 数据恢复。
- 模拟容器 remove 后重建，验证 bind mount / PVC 数据恢复。
- 模拟 Traefik 动态路由，验证无需 reload 网关。

### 14.3 E2E 测试

- 浏览器登录。
- 创建会话。
- 发送消息。
- 等待流式输出完成。
- 上传文件并发送。
- 刷新页面继续会话。
- 多用户实例隔离。
- 通过 Portal 登录并唤醒用户容器。
- 容器被停止后，再次进入工作台能恢复。
- 无域名子路径方案下，静态资源、API、WebSocket 均可用。

### 14.4 性能与容量测试

- 冷启动 P50 / P95 / P99。
- WebSocket 并发连接数。
- 单实例 idle 内存。
- 单实例对话中内存峰值。
- 单机活跃实例上限。
- 单用户数据目录增长速度。
- SQLite 在本地 SSD、Longhorn、Ceph RBD 下的读写延迟。
- 空闲回收释放内存效果。

## 15. 分阶段计划

### Phase 1：正式化单实例 Server Runtime

- 明确 `aionui-web` 为推荐服务器运行入口。
- 补充 standalone 部署文档。
- 增加健康检查说明。
- 增加 systemd / Docker 示例。
- 验证核心对话链路。

### Phase 2：单机 Docker Serverless PoC

- 使用 Traefik Docker provider。
- 使用本地目录 `/data/users/<userId>` 持久化。
- Portal 调 Docker API 创建、启动、停止用户容器。
- 支持通过 Portal 登录后进入工作台。
- 支持容器 stop 后再次 start 恢复。
- 记录冷启动耗时和内存释放收益。
- 验证 SQLite 在本地 bind mount 下稳定运行。

### Phase 3：Portal API 最小可用

- 完善 `aionui-portal` 的实例状态模型。
- 增加 status / stop / logs API。
- 增加启动并发锁。
- 增加健康检查。
- 增加安全鉴权。
- 增加 last active、running task、WebSocket 状态。

### Phase 4：多用户生产化

- 完善容器隔离。
- 支持 Traefik / Nginx / Kubernetes Ingress。
- 支持实例资源配额。
- 支持版本升级策略。
- 支持审计日志和管理控制台。
- 支持子域名部署。
- 如必须支持纯 IP，完成 base-path 改造和子路径验收。

### Phase 5：K8s + Longhorn / Ceph RBD

- Portal 调用 K8s API 创建 Deployment、Service、Ingress、PVC。
- Longhorn / Ceph RBD 提供 RWO 块存储。
- 支持节点镜像预拉取。
- 支持 Deployment 删除但 PVC 保留。
- 支持容量监控和 PVC 扩容。

### Phase 6：SSO 与企业能力

- Portal 与实例认证打通。
- 支持组织、角色、权限。
- 支持实例模板。
- 支持集中配置 Agent 环境变量和 CLI 工具。

## 16. 待确认问题

- Server Runtime Mode 首期是否只支持 Linux。
- Portal 首期采用 Docker runtime 还是同时支持本机 process runtime。建议先 Docker runtime。
- 多用户访问采用 path-prefix 还是 subdomain。
- 是否需要为 `aionui-web` 增加 `--base-path`。
- 是否需要将 initial admin password 改为只通过 Portal 安全通道展示。
- 是否需要引入统一健康检查端点，避免 Portal 解析日志。
- 空闲回收是否需要读取 `aioncore` running task 状态。
- 单机 Docker PoC 目标并发是多少，例如 50、200 或 500 活跃用户。
- 内网是否有 DNS 能力；如果没有，是否接受 `/users/<id>/` 子路径方案带来的 base-path 改造。
- K8s 生产环境优先 Longhorn 还是 Ceph RBD。
- 每个用户默认分配多大数据卷，例如 1Gi、5Gi 或 10Gi。
- 是否需要支持预热池，以降低首屏等待。
- 是否需要支持离线内网大模型和 CLI 工具镜像内置。

## 17. 推荐决策

推荐将 Server Runtime Mode 定位为新的服务器部署主路径：

- 新部署优先使用 `aionui-web`。
- 旧的 Electron + Xvfb 方式保留为兼容路径。
- 多用户和 API 启动由 Portal / Control Plane 负责。
- 不把服务器生命周期管理塞回 Electron 主进程。
- 首期验收重点放在前端对话链路：HTTP API、WebSocket、文件上传、流式响应和会话持久化。
- 容器 Serverless 首期采用“数据卷恢复”，不做内存快照。
- 第一阶段优先单机 Docker + Traefik + 本地目录挂载，验证成本收益和冷启动体验。
- 企业规模化再推进 K8s + Longhorn / Ceph RBD。
- 有内网 DNS 时优先子域名；无 DNS 时才做纯 IP 子路径，并将 base-path 作为明确开发项。
