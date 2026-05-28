# PRD：商业化产品多语言精简

## 1. 概述与目标

### 背景

AionUi 当前支持 8 种语言（`zh-CN`、`en-US`、`ja-JP`、`zh-TW`、`ko-KR`、`tr-TR`、`ru-RU`、`uk-UA`），分布在桌面端和移动端。过多的语言包增加了维护成本和安装包体积，不利于商业化产品聚焦。

### 目标

在商业化改造第一阶段，**仅保留中文（zh-CN）和英文（en-US）**，移除其余 6 种语言的相关资源。

### 范围

| 端 | 模块 | 操作 |
| -- | ---- | ---- |
| desktop | `packages/desktop/src/common/config/i18n-config.json` | 删除 `ja-JP`、`zh-TW`、`ko-KR`、`tr-TR`、`ru-RU`、`uk-UA` |
| desktop | `packages/desktop/src/renderer/services/i18n/locales/` | 删除 `ja-JP`、`ko-KR`、`ru-RU`、`tr-TR`、`uk-UA`、`zh-TW` 目录 |
| mobile | `mobile/src/i18n/locales/` | 删除 `ru-RU`、`uk-UA` 目录，保留 `en-US`、`zh-CN` |

---

## 2. 详细改动

### 2.1 i18n-config.json

**文件**：`packages/desktop/src/common/config/i18n-config.json`

**改动**：`supportedLanguages` 从 8 种缩减为 2 种

```json
// 修改前
"supportedLanguages": ["zh-CN", "en-US", "ja-JP", "zh-TW", "ko-KR", "tr-TR", "ru-RU", "uk-UA"]

// 修改后
"supportedLanguages": ["zh-CN", "en-US"]
```

### 2.2 桌面端语言包目录

**路径**：`packages/desktop/src/renderer/services/i18n/locales/`

| 操作 | 目录 |
| ---- | ---- |
| 保留 | `en-US/` |
| 保留 | `zh-CN/` |
| 删除 | `ja-JP/` |
| 删除 | `ko-KR/` |
| 删除 | `ru-RU/` |
| 删除 | `tr-TR/` |
| 删除 | `uk-UA/` |
| 删除 | `zh-TW/` |

### 2.3 移动端语言包目录

**路径**：`mobile/src/i18n/locales/`

| 操作 | 目录 |
| ---- | ---- |
| 保留 | `en-US/` |
| 保留 | `zh-CN/` |
| 删除 | `ru-RU/` |
| 删除 | `uk-UA/` |

---

## 3. 验证清单

- [ ] `i18n-config.json` 中 `supportedLanguages` 仅包含 `zh-CN` 和 `en-US`
- [ ] 桌面端 `locales/` 目录下仅存在 `en-US/` 和 `zh-CN/`
- [ ] 移动端 `locales/` 目录下仅存在 `en-US/` 和 `zh-CN/`
- [ ] `bun run i18n:types` 运行成功，无类型错误
- [ ] `bun run lint` 通过
- [ ] `bun run build` 构建成功
- [ ] 应用启动后语言切换正常（中文/英文）

---

## 4. 风险与注意事项

1. **语言检测逻辑**：浏览器自动语言检测（`navigator.language`）可能返回 `ja-JP` 等已移除语言，需确认 fallback 逻辑正确指向 `zh-CN` 或 `en-US`
2. **第三方依赖**：部分 Arco Design 组件内部有多语言文案，本次改动不涉及，需确认其语言与配置一致
3. **移动端同步**：移动端与桌面端语言配置需保持一致，避免用户切换时体验割裂
4. **未来扩展**：移除语言后若需再次添加，可从 git 历史恢复对应语言包目录

---

## 5. 后续计划（商业化 V2）

- 日语（ja-JP）、韩语（ko-KR）等高优先级语言可按需重新引入
- 考虑引入语言热加载机制，无需发布新版本即可添加语言支持