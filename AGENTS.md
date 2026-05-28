# AionUi - 项目指南

所有贡献者（包括人类和 AI）在提交 PR 前必须遵循 [CONTRIBUTING.md](CONTRIBUTING.md)。（[中文版](CONTRIBUTING.zh.md)）

## 代码规范

### 文件与目录结构

- **目录大小限制**：单个目录的直接子项（文件+子目录）不得超过 **10** 个。接近此限制时需按职责拆分。

详见 [docs/contributing/file-structure.md](docs/contributing/file-structure.md)。创建文件或模块时，AI 代理也必须遵循 `architecture` 技能（`.claude/skills/architecture/SKILL.md`）中的规范。

### 命名规范

- **组件**：PascalCase（`Button.tsx`、`Modal.tsx`）
- **工具函数**：camelCase（`formatDate.ts`）
- **Hooks**：camelCase，以 `use` 开头（`useTheme.ts`）
- **常量文件**：camelCase（`constants.ts`）—— 内部常量使用 UPPER_SNAKE_CASE
- **类型文件**：camelCase（`types.ts`）
- **样式文件**：kebab-case 或 `组件名.module.css`
- **未使用的参数**：添加 `_` 前缀

### UI 组件库与图标

- **组件库**：`@arco-design/web-react` — 禁止使用原生交互式 HTML（`<button>`、`<input>`、`<select>` 等）
- **图标库**：`@icon-park/react`

### CSS

- 优先使用 **UnoCSS 工具类**；复杂样式使用 **CSS Modules**（`组件名.module.css`）
- 颜色必须使用 `uno.config.ts` 或 CSS 变量中定义的**语义化 token** — 禁止硬编码颜色值
- Arco 主题覆盖统一放在 `packages/desktop/src/renderer/styles/arco-override.css`；组件级别的 Arco 样式覆盖使用 CSS Module 配合 `:global()`
- 全局样式只能放在 `packages/desktop/src/renderer/styles/`

### 格式化规则（Oxfmt，兼容 Prettier）

- 单元素数组若能在一行内放下 → 保持一行：`[{ id: 'a', value: 'b' }]`
- 多行数组/对象必须添加尾随逗号
- 字符串使用单引号

### TypeScript

- 启用了严格模式 — 禁止使用 `any`，禁止隐式返回
- 使用路径别名：`@/*`、`@process/*`、`@renderer/*`
- 优先使用 `type` 而非 `interface`（根据 Oxlint 配置）
- 代码注释使用英文；公共函数需要 JSDoc 注释

### 国际化（i18n）

所有面向用户的文本必须使用 i18n 键名 — 禁止硬编码字符串。语言和模块定义在 `packages/desktop/src/common/config/i18n-config.json` 中。

完整工作流程、键名命名规则和验证步骤请参考 `i18n` 技能（`.claude/skills/i18n/SKILL.md`）。

## 架构

存在两种进程类型 — 切勿混用它们的 API：

| 进程       | 路径                                 | 限制               |
| ---------- | ------------------------------------ | ------------------ |
| Main 进程  | `packages/desktop/src/process/`      | 禁止使用 DOM API   |
| Renderer 进程 | `packages/desktop/src/renderer/`   | 禁止使用 Node.js API |

跨进程通信必须通过 IPC 桥接层（`packages/desktop/src/preload/`）进行。
详见 [docs/architecture/overview.md](docs/architecture/overview.md)。

## 测试

**测试框架**：Vitest 4（`vitest.config.ts`）。覆盖率目标 ≥ 80%。

```bash
bun run test              # 运行所有测试
bun run test:coverage     # 生成覆盖率报告
```

完整工作流程和质量规则请参考 `testing` 技能（`.claude/skills/testing/SKILL.md`）。

## 工作流程

### 开发期间

边编辑边自动修复：

```bash
bun run lint:fix       # 自动修复 lint 问题（oxlint）
bun run format         # 自动格式化所有文件（oxfmt）
bunx tsc --noEmit      # 验证无类型错误
```

如果你的改动涉及 `packages/desktop/src/renderer/`、`locales/` 或 `packages/desktop/src/common/config/i18n`，还需运行：

```bash
bun run i18n:types
node scripts/check-i18n.js
```

### 推送前

始终使用 `just push` 代替 `git push`：

```bash
just push                          # lint → format-check → typecheck → test → git push
just push -u origin feat/branch    # 执行相同检查，并附带额外 git push 参数
```

任何步骤失败都会中止推送。修复问题后提交，然后重试。

> **AI 代理注意**：`just push` 对 lint 使用 `--quiet` — 只有错误会导致失败。项目中存在大量已存在的 lint _警告_，这些**不会**导致失败。通过退出码判断成功与否，而非根据输出量判断。

### PR 前（可选的更严格检查）

`prek` 模拟**完整的 CI 流程**（包括对所有文件类型的文件末尾换行、行尾空格检查）：

```bash
# 一次性安装
npm install -g @j178/prek

# 运行
prek run --from-ref origin/main --to-ref HEAD
```

> `prek` 是只读的 — 它会报告问题但不会自动修复。如果发现问题，运行上述自动修复命令，提交，然后重新运行。

`oss-pr` 技能会在创建 PR 时自动运行此检查。

### 提交与 PR 格式

提交格式：`<type>(<scope>): <subject>`，使用中文。类型包括：feat、fix、refactor、chore、docs、test、style、perf。

**绝对不要添加 AI 签名**（如 Co-Authored-By、Generated with 等）。

关于拉取请求的创建，请参考 `oss-pr` 技能（`.claude/skills/oss-pr/SKILL.md`）。

## 技能索引

| 技能               | 用途                                                           | 触发条件                                                       |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| **architecture**   | 所有进程类型的文件与目录结构规范                               | 创建文件、添加模块、架构决策                                   |
| **i18n**           | 国际化工作流程与标准                                           | 添加面向用户的文本、修改 `locales/` 或 `packages/desktop/src/common/config/i18n` |
| **testing**        | 测试工作流程与质量标准                                         | 编写测试、添加功能、声称完成之前                               |
| **oss-pr**         | 完整的提交 + PR 工作流程：分支管理、质量检查、issue 关联、PR 创建 | 创建拉取请求、提交之后、`/oss-pr`                              |
| **bump-version**   | 版本升级工作流程：更新 package.json、检查、分支、PR、发布标签  | 升级版本、`/bump-version`                                      |
| **pr-review**      | 在本地进行 PR 代码审查，包含完整项目上下文，无截断限制         | 审查 PR、用户说"review PR"、`/pr-review`                       |
| **pr-fix**         | 修复 pr-review 报告中的所有问题，创建后续 PR，并逐条验证修复   | 执行 pr-review 后，用户说"fix all issues"、`/pr-fix`           |
| **pr-verify**      | 验证并合并标记为 bot:ready-to-merge 的 PR，包含影响分析和测试补充 | 验证 PR、合并就绪的 PR、`/pr-verify`                           |
| **pr-ship**        | 端到端 PR 生命周期：创建、等待 CI、审查、修复、合并，一次调用完成 | `/pr-ship`、开发完成后、恢复引导 PR                            |
| **pr-automation**  | PR 自动化编排器：通过标签状态机轮询 PR、审查、修复和合并       | 由守护脚本调用（`pr-automation.sh`）、`/pr-automation`         |

> 技能位于 `.claude/skills/` 目录下，包含适用于**所有**代理和贡献者的项目约定。