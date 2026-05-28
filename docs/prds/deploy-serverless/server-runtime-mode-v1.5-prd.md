# AionUi Server Runtime Mode PRD（V1.5：多机 Docker 调度）

## 0. 文档范围

本文定义 V1 之后的下一阶段扩展：在不引入 Kubernetes 的前提下，支持多台 Docker 节点，由 Portal 根据节点健康与容量自动决定在哪台机器创建或恢复实例。

V1.5 的目标不是做完全自由迁移，而是在保持 SQLite 和本地数据目录可控的前提下，提供可用的多机调度能力。

本文依赖 V1 文档中的基础决策：

- Linux 服务器
- `aionui-web` 作为运行入口
- 一用户一容器
- 子域名路由
- bind mount 持久化
- Portal 负责生命周期管理
- Portal 统一身份 + 实例映射账号 + 一次性登录 ticket

## 1. V1.5 范围

V1.5 新增支持：

- 多台 Linux 机器安装 Docker 并接入 Portal
- Portal 维护节点注册表
- Portal 采集节点健康和容量快照
- Portal 首次创建用户实例时自动选择节点
- 已有用户实例恢复时优先回原节点
- Portal 返回实例所在节点与实例访问地址

V1.5 仍不支持：

- 任意跨节点自动漂移
- 自动数据迁移
- 共享块存储下的自由调度
- Kubernetes 编排

## 2. V1.5 锁定决策

| 维度 | V1.5 决策 | 原因 |
| --- | --- | --- |
| 节点模型 | Portal 管理多个 Docker 节点 | 保持与 V1 架构连续 |
| 调度策略 | 新用户按容量选择节点；老用户优先回原节点 | 兼顾自动分配与数据就近 |
| 数据策略 | 每用户数据目录固定在 home node 本地磁盘 | 避免一开始引入共享存储复杂度 |
| 故障策略 | 节点故障时实例进入 `failed` 或 `node_unavailable`，默认不自动迁移 | 避免隐式数据迁移风险 |
| 路由策略 | 仍使用子域名，反向代理按节点实例位置转发 | 保持前端根路径假设不变 |

## 3. 核心目标

- 支持新增一台或多台 Docker 机器接入现有运行体系。
- 新用户实例可由系统自动分配到容量更合适的节点。
- 已有用户实例恢复时不需要人工指定节点。
- 在不更改前端访问模型的前提下完成多机扩展。

## 4. 非目标

- 不做跨节点自动数据同步。
- 不承诺节点故障后的自动无损迁移。
- 不做全局最优调度器。
- 不引入共享存储依赖。
- 不引入 Kubernetes。

## 5. 多机运行拓扑

```text
Browser
  |
  v
Portal
  |-- auth
  |-- instance registry
  |-- runtime node registry
  |-- scheduler
  |-- idle cleanup
  |
  v
Reverse Proxy
  |-- portal.aionui.local -> Portal
  |-- user-a.aionui.local -> Node A container
  |-- user-b.aionui.local -> Node B container
  |
  +--> Docker Node A
  |     |-- aionui-user-a
  |     \-- /data/users/user-a
  |
  \--> Docker Node B
        |-- aionui-user-b
        \-- /data/users/user-b
```

## 6. 节点注册与健康模型

Portal 必须维护一个节点注册表，每个节点至少包含：

- `nodeId`
- `displayName`
- Docker API endpoint 或 node agent endpoint
- 节点状态
- 可调度标记
- 最近一次容量快照
- 节点标签，可选

建议节点状态：

| 状态 | 含义 |
| --- | --- |
| `healthy` | 可接受新实例，可恢复已有实例 |
| `degraded` | 仅允许恢复已有实例，不接收新实例 |
| `unschedulable` | 不接收新实例，也不自动恢复 |
| `offline` | 节点不可达 |

推荐节点对象：

```json
{
  "nodeId": "node-a",
  "displayName": "Docker Node A",
  "agentEndpoint": "https://node-a.internal:9443",
  "status": "healthy",
  "schedulable": true,
  "labels": {
    "zone": "office-a",
    "disk": "ssd"
  },
  "lastHeartbeatAt": "2026-05-28T10:00:00Z"
}
```

## 7. 节点容量采集

Portal 应定期采集每个节点的容量快照，至少包括：

- 总 CPU
- 可分配 CPU
- 总内存
- 可分配内存
- 当前运行实例数
- 当前停止实例数
- 数据目录剩余磁盘空间
- 节点最后心跳时间

V1.5 不要求做复杂预测调度，但必须基于这些快照进行基本容量筛选。

推荐容量快照对象：

```json
{
  "nodeId": "node-a",
  "capturedAt": "2026-05-28T10:00:00Z",
  "cpuTotal": 16,
  "cpuAllocatable": 12,
  "cpuAllocated": 1,
  "cpuAvailable": 11,
  "memoryTotalMiB": 65536,
  "memoryAllocatableMiB": 57344,
  "memoryAllocatedMiB": 14336,
  "memoryAvailableMiB": 43008,
  "diskTotalGiB": 1024,
  "diskAvailableGiB": 620,
  "runningInstances": 8,
  "stoppedInstances": 30
}
```

## 8. 调度策略

### 8.1 新用户首次创建

当用户第一次创建实例时：

1. 过滤掉 `offline` 和 `unschedulable` 节点。
2. 过滤掉资源不足的节点。
3. 按调度权重选择节点。
4. 为该用户写入 `homeNode`。
5. 在该节点创建容器与本地数据目录。

最低资源门槛：

- `cpuAvailable >= instanceCpuLimit`
- `memoryAvailableMiB >= instanceMemoryLimitMiB`
- `diskAvailableGiB >= minimumUserDataReserveGiB`

### 8.2 已有用户恢复

当用户已经存在实例绑定关系时：

1. 优先检查 `homeNode`。
2. 若 `homeNode` 健康，则直接在该节点启动或恢复。
3. 若 `homeNode` 不可用，则实例进入异常状态。
4. 不自动切换到其他节点，除非存在显式迁移流程。

## 9. 推荐调度权重

V1.5 推荐采用简单可解释的加权打分，而不是复杂调度器。

可选输入：

- CPU 剩余比例
- 内存剩余比例
- 当前活跃实例数
- 磁盘剩余空间
- 节点标签匹配

推荐原则：

- 优先保证资源够用。
- 再在资源足够的节点中选择负载更低者。
- 对已有用户实例，节点亲和优先级高于全局均衡。

推荐初始打分公式：

```text
score =
  cpuAvailableRatio * 0.35 +
  memoryAvailableRatio * 0.35 +
  diskAvailableRatio * 0.20 +
  instanceLoadScore * 0.10
```

其中：

- `cpuAvailableRatio = cpuAvailable / cpuTotal`
- `memoryAvailableRatio = memoryAvailableMiB / memoryTotalMiB`
- `diskAvailableRatio = diskAvailableGiB / diskTotalGiB`
- `instanceLoadScore = 1 - min(runningInstances / maxActiveInstancesPerNode, 1)`

调度选择分数最高的节点。若分数相同，优先选择运行实例数更少的节点。

推荐说明：

- `cpuAvailable` 和 `memoryAvailableMiB` 以调度账本为准，不直接用瞬时 CPU idle 作为唯一依据。
- 宿主机实时利用率可以作为参考，但不作为调度主值。

## 10. 数据位置与节点绑定

V1.5 采用“用户绑定 home node”的数据策略。

必须满足：

- 每个用户数据目录位于固定节点本地磁盘。
- Portal 记录 `userId -> homeNode`。
- 默认所有恢复操作都回到 `homeNode`。
- 只有显式迁移任务才能改变 `homeNode`。

这样做的目的，是避免在多机早期阶段同时引入：

- SQLite 跨节点一致性问题
- 共享存储复杂度
- 自动数据迁移失败风险

## 11. 路由要求

V1.5 仍沿用子域名模型，但反向代理或路由元数据需要知道：

- 该用户实例当前在哪个节点。
- 对应节点的入口地址。
- 实例容器是否健康。

因此 Portal 或路由层至少需要维护：

- `userSubdomain -> node`
- `node -> upstream endpoint`

推荐路由同步路线：

- 单节点阶段可直接由 Portal 输出路由数据给反向代理。
- 多节点阶段推荐使用 Traefik file provider 或 Portal 动态配置 API。
- 不建议长期依赖单节点 Docker provider 去发现全局节点。

## 12. 新增状态与错误

在 V1 状态基础上，V1.5 建议补充以下节点相关状态：

| 状态 | 含义 |
| --- | --- |
| `assigned` | 已分配 `homeNode`，但实例尚未启动 |
| `node_unavailable` | 实例所属节点不可达 |
| `relocating` | 正在执行人工或显式迁移 |

新增错误场景：

- 没有可调度节点
- 目标节点容量不足
- `homeNode` 离线
- 路由元数据未同步

## 13. 控制面新增数据模型

至少需要新增以下数据模型：

| 模型 | 用途 |
| --- | --- |
| `runtime_nodes` | 节点注册表 |
| `node_capacity_snapshots` | 节点容量快照 |
| `user_instance_bindings` | 用户与 `homeNode` 绑定关系 |

### 13.1 `runtime_nodes`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `node_id` | string | 节点唯一 ID |
| `display_name` | string | 展示名 |
| `endpoint` | string | node agent 或 Docker endpoint |
| `status` | string | `healthy` / `degraded` / `unschedulable` / `offline` |
| `schedulable` | boolean | 是否允许调度新实例 |
| `labels_json` | JSON | 节点标签 |
| `last_heartbeat_at` | datetime | 最近心跳时间 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

### 13.2 `node_capacity_snapshots`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 快照 ID |
| `node_id` | string | 所属节点 |
| `cpu_total` | number | 总 CPU |
| `cpu_available` | number | 可分配 CPU |
| `memory_total_mib` | number | 总内存 |
| `memory_available_mib` | number | 可分配内存 |
| `disk_total_gib` | number | 数据盘总容量 |
| `disk_available_gib` | number | 数据盘可用容量 |
| `running_instances` | number | 当前运行实例数 |
| `stopped_instances` | number | 当前停止实例数 |
| `captured_at` | datetime | 采集时间 |

### 13.3 `user_instance_bindings`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 用户 ID |
| `instance_id` | string | 实例 ID |
| `home_node_id` | string | 用户数据所在节点 |
| `container_name` | string | 容器名 |
| `subdomain` | string | 用户实例子域名 |
| `status` | string | 实例状态 |
| `data_path` | string | 节点上的数据目录 |
| `image_version` | string | 实例当前镜像版本 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

## 14. 控制面新增 API

| API | 用途 |
| --- | --- |
| `GET /api/admin/runtime-nodes` | 查看所有节点状态 |
| `POST /api/admin/runtime-nodes` | 注册新节点 |
| `POST /api/admin/runtime-nodes/:nodeId/disable` | 将节点设为不可调度 |
| `POST /api/admin/runtime-nodes/:nodeId/enable` | 恢复节点调度 |
| `GET /api/admin/runtime-nodes/:nodeId/capacity` | 查询节点容量快照 |
| `POST /api/admin/runtime-nodes/:nodeId/capacity-sync` | node agent 上报容量快照 |
| `POST /api/admin/instances/:userId/reassign` | 显式迁移或改绑 `homeNode` |

### 14.1 `POST /api/admin/runtime-nodes`

请求：

```json
{
  "nodeId": "node-a",
  "displayName": "Docker Node A",
  "endpoint": "https://node-a.internal:9443",
  "schedulable": true,
  "labels": {
    "zone": "office-a",
    "disk": "ssd"
  }
}
```

### 14.2 `GET /api/admin/runtime-nodes`

成功响应：

```json
{
  "success": true,
  "data": [
    {
      "nodeId": "node-a",
      "status": "healthy",
      "schedulable": true,
      "capacity": {
        "cpuAvailable": 10.5,
        "memoryAvailableMiB": 40960,
        "diskAvailableGiB": 620,
        "runningInstances": 8
      }
    }
  ]
}
```

### 14.3 `POST /api/admin/runtime-nodes/:nodeId/capacity-sync`

用途：节点 agent 上报容量快照。

约束：

- 该接口是 node agent 的上报接口，不是浏览器用户接口。
- Portal 以该接口数据更新节点容量快照和调度账本。

## 15. 显式迁移 / reassign

V1.5 推荐将 `reassign` 定义为“改绑定关系”的管理动作，不包含自动数据复制。

### 15.1 `POST /api/admin/instances/:userId/reassign`

请求：

```json
{
  "targetNodeId": "node-b",
  "migrationConfirmed": true,
  "reason": "manual_data_migration_completed"
}
```

约束：

- `reassign` 不执行数据复制。
- `reassign` 只适用于新用户尚未产生有效数据、空实例，或管理员已经完成离线人工迁移并确认切换的实例。
- 对已有真实数据的实例，V1.5 不提供自动迁移，后续单独定义 `migrate` 流程。
- 操作必须记录原 `homeNode`、新 `homeNode`、操作者和原因。

推荐理由：

- 这与 V1.5 不做自动数据迁移的范围约束一致。
- 如果只改 `homeNode` 而不迁数据，实例恢复时会直接丢失历史。
- 如果把自动复制也放进 V1.5，会显著增加实现与运维复杂度。

## 16. 升级与镜像版本策略

多机和单机都必须记录镜像版本，避免实例生命周期与镜像演进脱节。

要求：

- 实例绑定记录必须保存 `imageVersion`。
- Portal 创建实例时必须明确使用某个镜像版本。
- 升级前必须停止实例。
- 升级失败时可以回滚到原 `imageVersion`。
- 数据目录在升级过程中必须保持不变。

建议实例记录新增字段：

| 字段 | 说明 |
| --- | --- |
| `image_version` | 实例当前镜像版本 |
| `last_upgraded_at` | 最近一次升级时间 |
| `upgrade_status` | `idle` / `upgrading` / `failed` / `rolled_back` |

## 17. 节点容量采集推荐决策

V1.5 推荐以轻量 node agent 作为正式方案；若只做临时 PoC，可短期允许 Portal 直接读取 Docker host 指标。

推荐方案：

- 正式方案：
  - 每个节点部署轻量 node agent。
  - agent 上报 CPU / 内存可用量、磁盘剩余空间、节点心跳和可调度标记。
- 临时 PoC 可允许 Portal 直接读取 Docker host 指标，但不作为长期架构。

推荐理由：

- Docker API 更适合容器操作，不适合作为完整节点容量真相源。
- 直接暴露多个 Docker 管理入口的安全性更差。
- 后续需要更多宿主机指标时，node agent 更易扩展。

## 18. 验收标准

- Portal 能管理至少两台 Docker 节点。
- 新用户首次创建时，系统能自动选择健康且容量足够的节点。
- 已有用户恢复时，优先回原节点。
- 当某节点被标记为 `unschedulable` 时，不再分配新用户。
- 节点离线时，归属该节点的实例能被标记为 `node_unavailable`。
- 多机模式下，子域名路由仍不串实例。
- `reassign` 不复制数据，只改绑定关系，并要求管理员确认迁移已完成。

## 19. 测试计划骨架

### 19.1 单元测试

- 节点容量打分逻辑
- 新用户节点选择逻辑
- 已有用户 `homeNode` 亲和逻辑
- 节点状态过滤逻辑
- `reassign` 前置条件校验

### 19.2 集成测试

- 两台节点下的新用户自动分配
- 既有用户恢复回原节点
- 节点容量不足时跳过该节点
- 节点不可调度时不接收新实例
- 节点离线时实例进入 `node_unavailable`

### 19.3 E2E 测试

- Portal 登录后首次进入，实例被自动创建到某节点。
- 再次进入时恢复到同一节点。
- 标记节点不可调度后，新用户落到其他节点。
- 多机路由元数据更新后，用户子域名仍指向正确节点。

## 20. 交付阶段

### Phase 4：多机 Docker 调度

- 引入节点注册表。
- 引入节点健康与容量采集。
- 引入新用户自动选点。
- 引入 `homeNode` 绑定。
- 引入节点不可调度与离线状态处理。
- 完成多机路由元数据联动。
