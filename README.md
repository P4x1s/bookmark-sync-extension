# bookmark-sync-extension（v1.0.0 · 低内存优化）

> **当前状态**：v1.0.0 为当前发布版本，包含缓存导致删除回滚与二次同步 409 的数据一致性修复。当前唯一分发物为 `bookmark-sync-universal.zip`，对应 GitHub Release `v1.0.0`（Latest）。

一个插件包同时兼容 **Chrome、Edge、Firefox** 及多数 Chromium 系浏览器。它通过使用者自己授权的 **GitHub 私有仓库**保存浏览器的**书签/收藏夹树**，实现新增、修改、删除、移动、重命名、层级与顺序的双向同步。

> 术语说明：本扩展同步的是**书签（bookmarks）**，不是当前打开的标签页（tabs）。清单只申请 `bookmarks`、`storage`、`alarms` 权限，不读取浏览历史或当前标签页。

v1.0.0 核心能力：**保存即持久化**（有效配置立即生效、无效输入写草稿防丢失、写失败明确提示）、**首次同步缺文件自动创建并完整推送本地书签**、**同步全过程百分比与阶段进度**；同时保留 v0.3.3 的**安装后默认零写入**与 403 授权指引，以及 v0.3.2 的首次同步防覆盖、消息校验与备份序号修复。

---

## 目录

1. [项目概述](#1-项目概述)
2. [主要功能](#2-主要功能)
3. [目录结构](#3-目录结构)
4. [核心约定](#4-核心约定)
5. [环境依赖](#5-环境依赖)
6. [安装步骤](#6-安装步骤)
7. [配置说明](#7-配置说明)
8. [使用方法](#8-使用方法)
9. [同步流程](#9-同步流程)
10. [常见问题](#10-常见问题)
11. [注意事项](#11-注意事项)
12. [验证与复核](#12-验证与复核)
13. [浏览器兼容差异](#13-浏览器兼容差异)
14. [后续可配置项](#14-后续可配置项)

---

## 1. 项目概述

### 1.1 它做什么

- 把浏览器书签树序列化为一份 `bookmarks.json`，存放在使用者自己指定的 GitHub 仓库中（建议 Private）。
- 在多台浏览器 / 多台设备间保持书签一致：新增、改名、改网址、删除、移动、调整顺序与文件夹层级都能同步。
- 用稳定 `uuid` 标识节点，解决 Chrome 与 Firefox 本地书签 ID 不一致的问题。
- 三方比较（上次基准 / 当前本地 / 当前远端）+ SHA 乐观锁，避免多端并发时静默覆盖。
- 覆盖性写操作前自动备份，可回滚。

### 1.2 它不做什么

| 不做的事 | 说明 |
|---|---|
| 不同步当前打开的标签页 | 需要 `tabs` 权限，本扩展未申请 |
| 不上传令牌到仓库文件 | 令牌只存在于扩展本地存储与 API 请求头 |
| 不收集统计 / 遥测 | 无第三方脚本、无外部依赖、无请求到非 GitHub 域名 |
| 不删除仓库里的其他文件 | 只读写配置中指定的 `bookmarks.json`，并在 `backups/` 追加快照 |
| 不在安装后写入任何数据 | 见 [6.5 安装后的默认状态](#65-安装后的默认状态) |

### 1.3 适用范围

- 有多台电脑 / 多个浏览器，希望书签保持一致。
- 希望数据存放在自己可控的私有仓库，而不是第三方同步服务。
- 能自行创建 GitHub 令牌并完成一次初始配置（面向新手的步骤见第 6、7、8 章）。

---

## 2. 主要功能

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 单包多浏览器 | 一份 MV3 清单同时兼容 Chromium 与 Firefox；无需分别打包 | `src/manifest.base.json`、`src/background.js` |
| 书签树双向同步 | 新增 / 修改 / 删除 / 移动 / 重命名 / 层级 / 顺序全量覆盖 | `src/lib/sync.js` |
| 稳定节点身份 | 本地 `bookmarkId ↔ uuid` 双向映射，跨浏览器保持一致 | `src/lib/model.js` |
| 三方比较与增量写入 | 以基准树判断变更，无差异时零写入 | `src/lib/sync.js` |
| 冲突处理 | 备份远端保留本地 / 备份本地采用远端，两种策略可选 | `src/lib/sync.js`、`src/background.js` |
| 乐观锁防覆盖 | `PUT` 携带远端 `sha`，并发修改返回 409 而不是静默覆盖 | `src/lib/github.js` |
| 首次同步保护 | 远端非空时先拉；远端缺文件时创建并完整推送；失败重试不翻转方向 | `src/lib/sync.js` |
| 备份与回滚 | 远端快照写入 `backups/`，本地快照写入独立存储键，可恢复 | `src/lib/sync.js` |
| 保存即持久化 | 有效配置一次写入生效；无效输入写草稿；写失败保留表单 | `src/lib/config.js`、`src/background.js`、`src/popup.js` |
| 进度反馈 | 分阶段百分比推送到弹窗进度条，失败显示终态 | `src/lib/sync.js`、`src/popup.js` |
| 默认零写入 | 安装不写状态、不生成设备 ID、不建闹钟、不访问 GitHub | `src/lib/config.js`、`src/background.js` |
| 授权诊断 | 按 classic / fine-grained 令牌给出 403 修复指引；连接测试只读 | `src/lib/util.js`、`src/lib/github.js` |
| 低内存设计 | 快照分离、无轮询、去抖合并、复用树引用、无缩进序列化 | `src/lib/sync.js`、`src/background.js` |
| 统一图标 | 16–128px 多尺寸，Firefox 深浅工具栏主题变体 | `src/icons/`、`tools/generate_icons.py` |

---

## 3. 目录结构

```text
bookmark-sync-extension/
├─ build.py                    # 生成唯一通用产物并清理旧拆包
├─ README.md                   # 本文档（概述 / 规则 / 安装 / 使用）
├─ REVIEW.md                   # 全面复核与修复记录
├─ icon-preview.html           # 图标多尺寸 / 深浅背景预览（不进入分发 zip）
├─ src/
│  ├─ manifest.base.json       # 唯一 MV3 清单模板（含 dual background）
│  ├─ background.js            # 后台：书签事件、闹钟、消息、徽章
│  ├─ popup.html / .css / .js  # 配置与状态界面
│  ├─ icons/                   # 统一图标资源
│  │  ├─ icon.svg              # 可随系统深浅色变化的主 SVG
│  │  ├─ brand-mark.svg        # 弹窗内纯图形标记
│  │  └─ icon-*.png            # 16/24/32/48/64/128 多尺寸与深浅主题变体
│  └─ lib/
│     ├─ util.js               # UUID / UTF-8 Base64 / 深比较 / 防抖 / 授权指引
│     ├─ api.js                # chrome.* 与 browser.* 的 Promise 适配层
│     ├─ config.js             # 配置、草稿与令牌存储（storage.local）
│     ├─ github.js             # GitHub Contents API 客户端（SHA / 备份）
│     ├─ model.js              # 书签树归一化、UUID 映射、结构校验
│     └─ sync.js               # 三方比较、增量、冲突、备份、回滚、进度上报
├─ tools/
│  └─ generate_icons.py        # 纯标准库图标生成器（无第三方依赖）
├─ tests/
│  ├─ model.test.js            # Node 纯逻辑测试
│  ├─ sync.test.js             # 模拟 GitHub API 的同步引擎集成测试
│  ├─ smoke.test.js            # 安装/加载/消息/核心功能冒烟测试（双浏览器路径）
│  └─ security.test.js         # 输入校验、权限、敏感数据、危险逻辑安全测试
├─ dist/
│  └─ universal/               # 唯一构建产物（一个插件）
└─ bookmark-sync-universal.zip # 分发压缩包
```

生成产物：`bookmark-sync-universal.zip`。图标统一复用「云 + 上下双向箭头」语义；Chromium 系使用自带对比度的渐变图标，Firefox 通过 `theme_icons` 提供浅色 / 深色工具栏变体（该键仅 Firefox 使用，Chromium 会忽略）。需要重绘时执行：

```bash
python tools/generate_icons.py
python build.py
```

---

## 4. 核心约定

以下约定是理解同步行为的前提，代码实现与本文档均以此为准。

| 约定 | 内容 |
|---|---|
| 同步对象 | 书签树（bookmarks tree），不含当前打开标签页、历史、密码 |
| 节点身份 | 以稳定 `uuid` 为准，不以标题或网址判断「同一个书签」 |
| 首次同步定义 | `baseTree` 为空且 `remoteSha` 为空；同步失败写入的 `lastSyncAt` 不参与判定 |
| 首次同步方向 | 远端有非空本格式树 → 远端优先（本地留快照）；远端无文件 → 本地优先（创建并推送全树） |
| 非首次同步方向 | 以基准树为参照做三方比较：仅本地变则推送，仅远端变则拉取，双方变走冲突策略 |
| 拉取语义 | 以远端为目标的**镜像对齐**：同 UUID 覆盖、远端独有新建、本地多余删除，不是并集合并 |
| 推送语义 | 整棵本地树序列化后覆盖同步文件，不是逐节点合并 |
| 覆盖前备份 | 任何覆盖远端或改写本地的操作，先提交远端快照和/或本地快照 |
| 并发保护 | `PUT` 携带读取到的 `sha`；期间远端被改动返回 409，不静默覆盖 |
| 安装默认态 | 不写任何数据；只有完整配置并显式同步 / 开启自动同步后才开始读写 |
| 草稿语义 | 无效输入立即写入 `bookmarkSync.draft`，不生效、不参与同步；存在草稿时拒绝同步 |
| 配置保存 | 保存配置不会自动触发同步；仅写入配置、清草稿、按需重建闹钟 |
| 串行执行 | 同步任务互斥（`syncing`），本地写入期间忽略书签事件（`applying`），防止回环 |

---

## 5. 环境依赖

| 场景 | 要求 | 说明 |
|---|---|---|
| 运行插件 | Chrome / Edge 121+，Firefox 121+ | 单包双后台字段要求；Opera / Brave / Vivaldi 可直接用同一包 |
| GitHub 账号 | 可创建 Private 仓库与个人访问令牌 | 详见 [6.1](#61-准备-github-私有仓库) 与 [6.2](#62-生成访问令牌pat) |
| 构建产物 | Python 3（仅标准库） | 执行 `python build.py`，无需 pip 安装依赖 |
| 重绘图标 | Python 3（仅标准库） | 执行 `python tools/generate_icons.py`，无第三方库 |
| 运行测试 | Node.js 22 | `node tests/*.test.js`；测试为纯 Node 环境，无网络、无浏览器依赖 |
| 持续加载（可选） | `web-ext` | Firefox 开发期用 `web-ext run --source-dir dist/universal` |
| 运行时依赖 | **无** | 扩展不含 `package.json` / `node_modules` / 远程脚本 / 遥测 |

---

## 6. 安装步骤

### 6.1 准备 GitHub 私有仓库

1. 新建一个 **Private** 仓库，建议默认分支为 `main`，仓库可以为空。
2. 插件不预置任何账户名或仓库名，安装后需自行填写。
3. 仓库里已有的其他文件不会被删除或改动；若同步路径 `bookmarks.json` 撞上已有文件，首次同步会先把原文件原样备份到 `backups/initial-<时间>-existing-file.json`，再写入书签数据。
4. 若同步文件是本插件不支持的更高 `schema` 版本，同步会直接报错停止，不会覆盖。

### 6.2 生成访问令牌（PAT）

二选一即可：

| 类型 | 创建路径 | 必须授予的权限 |
|---|---|---|
| **classic PAT（推荐新手）** | GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) | 勾选完整 `repo` scope。只勾 `public_repo` 无法读写私有仓库，会报 403 |
| **fine-grained PAT** | 同上 → Fine-grained tokens | Repository access 选中目标仓库；Repository permissions 中 **Contents 设为 `Read and write`**。只给 `Read` 时读取正常但写入必然 403 |

若仓库属于启用了 SSO 的组织，还需在令牌页面点击 **Authorize SSO**。

> 令牌只在扩展本地与 `api.github.com` 请求头中出现，不会写入仓库文件，也不会在界面上明文显示。请勿把令牌写入任何源码、文档、配置文件或提交信息。

### 6.3 下载插件

下载 `bookmark-sync-universal.zip` 并解压；所有浏览器都使用**同一个解压目录**。

### 6.4 加载到浏览器

| 浏览器 | 操作步骤 | 选择的目标 |
|---|---|---|
| Chrome | 地址栏输入 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」 | 解压后的 `dist/universal` 目录 |
| Edge | 地址栏输入 `edge://extensions` → 打开「开发者模式」→「加载解压缩的扩展」 | 解压后的 `dist/universal` 目录 |
| Firefox | 地址栏输入 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」 | `dist/universal/manifest.json` |
| Opera / Brave / Vivaldi | 扩展管理页 →「加载已解压的扩展」 | 解压后的 `dist/universal` 目录 |

> Firefox 的「临时载入」在浏览器重启后失效；开发期可用 `web-ext run --source-dir dist/universal` 持续加载。

### 6.5 安装后的默认状态

安装或重新载入插件后，**默认不写入任何数据**：

- `autoSync` 默认关闭，不建立自动同步闹钟；
- 不生成 `deviceId`，不写扩展状态，不访问 GitHub；
- 本地书签变化在未完成配置前不会产生任何状态写入；
- 只有填写完整 owner / repo / token 并点击 **立即同步**（或显式开启自动同步并保存配置）后，才会开始读写。

如需停止自动写入，关闭「自动同步」并保存配置即可，闹钟会被立即清除。

### 6.6 从源码自行构建（可选）

```bash
python tools/generate_icons.py   # 可选：仅在需要重绘图标时执行
python build.py                  # 生成 dist/universal/ 与 bookmark-sync-universal.zip
```

构建脚本会校验 manifest 合法性、双后台字段、图标存在性与 PNG 实际宽高。

---

## 7. 配置说明

### 7.1 配置项

在弹窗中填写；所有字段都经过白名单与合法性校验。

| 字段 | 默认值 | 说明与约束 |
|---|---|---|
| `owner` | 空 | GitHub 用户名 / 组织名，仅允许字母、数字、`_`、`.`、`-` |
| `repo` | 空 | 仓库名，字符集同上 |
| `branch` | `main` | 分支名，仅允许字母、数字、`_`、`/`、`.`、`-` |
| `path` | `bookmarks.json` | 同步文件路径；不能为 `/`，不能含 `..` |
| `token` | 空 | 个人访问令牌；界面脱敏显示，只在本地存储与 API 请求头出现 |
| `autoSync` | `false` | 自动同步总开关；开启且配置合法才建立闹钟 |
| `syncIntervalMinutes` | `15` | 定时同步间隔，范围 1–1440 分钟 |
| `debounceMs` | `3000` | 书签变化去抖毫秒数，范围 0–60000；在启动与保存配置时刷新缓存 |
| `conflictStrategy` | `backup-then-local` | 可选 `backup-then-local` / `prefer-remote` |
| `lowMemoryMode` | `true` | 开启时本地快照只留 1 份 |
| `backupCount` | `1` | 本地快照份数，范围 1–5；仅在关闭低内存模式时生效 |
| `deviceId` | 空 | 首次真实同步时按需生成，安装时不写入 |

### 7.2 保存与草稿

- 点击 **保存配置**：有效配置一次存储写入后立即生效，并清除草稿。
- 输入不完整或不合法：内容立即写入草稿 `bookmarkSync.draft`，弹窗提示；修正后再次保存即可生效。
- 存在草稿时同步被拒绝，避免用旧配置误操作。
- 存储写入失败时返回 `saveFailed`，弹窗保留当前输入，可直接重试。

### 7.3 本地存储键

| 键 | 内容 |
|---|---|
| `bookmarkSync.config` | 当前生效配置（含令牌，仅扩展可读） |
| `bookmarkSync.draft` | 未通过校验的暂存输入，不生效、不参与同步 |
| `bookmarkSync.state` | 轻量状态：`baseTree`、`remoteSha`、时间、状态、UUID 映射等 |
| `bookmarkSync.backups` | 本地完整树快照列表，按需读取，弹窗只取元信息 |

### 7.4 远端同步文件格式

```json
{
  "schema": 1,
  "updatedAt": "2026-11-24T03:00:00.000Z",
  "deviceId": "<稳定设备ID>",
  "tree": [
    {
      "uuid": "…",
      "type": "folder",
      "title": "Bookmarks bar",
      "children": [
        { "uuid": "…", "type": "url", "title": "示例", "url": "https://example.com" }
      ]
    }
  ]
}
```

---

## 8. 使用方法

### 8.1 首次配置与同步

1. 点击工具栏图标打开弹窗。
2. 依次填写 `owner`、`repo`、`branch`、`path`、`token`（见 [7.1](#71-配置项)）。
3. 点击 **保存配置**。若有提示，按提示修正后再次保存。
4. 点击 **测试连接**：应显示仓库可访问、有写权限，并报告同步文件是否存在。此步骤**只发只读请求**，不会写入仓库。
   - 若令牌无写权限，会按令牌类型给出具体修复步骤（`repo scope` / `Contents: Read and write` / SSO）。
5. 点击 **立即同步**：
   - 仓库没有 `bookmarks.json` 时，自动创建该文件并把本地书签树完整推送上去；
   - 同步期间弹窗显示百分比进度条与阶段说明，直到成功或失败。

### 8.2 接入第二台浏览器

在另一台浏览器加载同一个包，配置后点击「立即同步」。首次同步时若远端已有本插件格式的书签树，插件会**先留本地快照，再采用远端**，避免覆盖已有数据。

### 8.3 日常同步方式

| 方式 | 触发条件 | 说明 |
|---|---|---|
| 手动 | 弹窗点击「立即同步」 | 任何状态下都可用 |
| 书签变化 | 新增 / 删除 / 修改 / 移动后，去抖 `debounceMs`（默认 3000ms） | 开启自动同步时直接同步；关闭时只标记「本地已变化」 |
| 定时 | 开启自动同步后按 `syncIntervalMinutes`（默认 15 分钟） | 仅在配置完整且合法时建立闹钟 |
| 冲突处理 | 点击弹窗中的任一冲突策略 | 保存策略后立即触发一次同步 |
| 备份恢复 | 选择本地快照恢复 | 恢复后立即推送远端，避免被下一次同步反向覆盖 |

### 8.4 查看状态与进度

弹窗状态卡显示：

- 状态：尚未同步 / 无变化 / 已推送 / 已拉取 / 冲突 / 本地已变化 / 同步失败；
- 进度：`5% → 15% → 30% → 50% → 60% → 80% → 100%` 与阶段文字；
- 失败：显示 100% 失败终态与具体错误，按钮自动恢复可用。

进度阶段含义见 [9.3 数据流向与进度](#93-数据流向与进度)。

### 8.5 冲突处理与回滚

两端在两次同步之间都发生修改时，弹窗出现两个按钮：

- **备份远端，保留本地**（默认策略）：把远端快照提交到 `backups/`，然后把本地树推送上去；
- **备份本地，采用远端**：把本地快照提交到 `backups/` 和扩展本地存储，然后用远端树重建本地结构。

也可在「冲突策略」中预设，自动同步时按预设执行；本地快照可在弹窗备份列表中选择恢复。

---

## 9. 同步流程

### 9.1 四个核心概念

| 概念 | 字段 | 说明 |
|---|---|---|
| 基准树 | `baseTree` | 上次**成功**同步后保存的树快照；判断「谁改了」的参照物 |
| 本地树 | `localTree` | 当前浏览器中的真实书签树，每次同步时重新读取 |
| 远端树 | `remoteTree` | 同步文件中的 `tree` 字段 |
| 远端 SHA | `remoteSha` | GitHub 文件当前版本的哈希，写入时携带以防并发覆盖 |

### 9.2 触发时机

| 触发源 | 实现位置 | 行为 |
|---|---|---|
| 手动点击「立即同步」 | `background.js` 的 `SYNC_NOW` | 立即调用 `sync.runSync()` |
| 本地书签事件 | `background.js` 的 `bookmarkCreated/Removed/Changed/Moved` | 去抖后：`autoSync=true` 则同步；否则仅标记 `dirty` 与徽章 |
| 定时闹钟 | `background.js` 的 `alarm` 事件 | 仅当 `autoSync=true` 且配置合法时触发 |
| 切换冲突策略 | `background.js` 的 `SET_CONFLICT` | 保存策略后立即同步一次 |
| 恢复本地备份 | `sync.js` 的 `restoreBackup` | 恢复后立即推送远端 |
| **保存配置** | `SAVE_CONFIG` | **不会自动同步**；只写入配置、清除草稿、按需重建闹钟 |
| **安装扩展** | `installed` 事件 | **不触发同步、不写任何数据** |

### 9.3 数据流向与进度

**推送方向（本地 → 远端）**

```text
浏览器书签 API
  → buildLocalTree（生成/复用稳定 uuid）
  → 与 baseTree 比较是否有变化
  → JSON.stringify({schema, updatedAt, deviceId, tree})
  → PUT /repos/{owner}/{repo}/contents/{path}（携带读取到的 sha）
  → 成功后更新 baseTree 与 remoteSha
```

**拉取方向（远端 → 本地）**

```text
GET /contents
  → parseRemotePayload（校验 schema 与结构）
  → 与 baseTree 比较是否有变化
  → 先写本地快照
  → applyTreeToLocal（按 uuid 做 create / update / move / remove）
  → 重建 baseTree 与 remoteSha
```

**进度阶段**

| 百分比 | 阶段 | 含义 |
|---|---|---|
| 5% | `config` | 检查草稿与配置合法性 |
| 15% | `local` | 读取浏览器书签 |
| 30% | `remote` | 读取 GitHub 同步文件 |
| 50% | `compare` | 比较三方差异（文件不存在时进入创建分支） |
| 60% | `backup` | 备份将被覆盖的一方（无覆盖则跳过） |
| 70% | `create` | 首次且文件不存在时创建同步文件 |
| 80% | `write` / `apply` | 写入远端或应用本地差异 |
| 100% | `done` / `failed` | 完成或失败终态 |

### 9.4 覆盖优先级与决策表

| 场景 | 结果 | 优先级 |
|---|---|---|
| 首次 + 远端文件存在且为非空本格式树 | **远端优先**：本地先留快照，然后采用远端 | 远端 |
| 首次 + 远端无文件 | **本地优先**：创建文件，完整推送本地树（即使本地为空树也创建） | 本地 |
| 首次 + 远端 tree 为空 | 按本地变化推送；空树无数据需要保护 | 本地 |
| 首次 + 远端文件存在但不是本插件格式 / JSON 损坏 | **本地优先**：先把原内容备份到 `backups/initial-*.json`，再写入 | 本地 |
| 首次 + 远端 `schema > 1` | 报错停止，**不覆盖** | 不写入 |
| 非首次 + 仅本地变化 | 推送本地树 | 本地 |
| 非首次 + 仅远端变化 | 本地先留快照，更新远端变更到本地 | 远端 |
| 非首次 + 双方都变化 | 默认：**备份远端，保留本地**；`prefer-remote`：**备份本地，采用远端** | 按策略 |
| 双方均无变化 | `noop`，零写入 | 不写入 |
| 首次同步失败后重试 | 仍按首次规则处理，不受 `lastSyncAt` 污染 | 远端（若远端非空） |

### 9.5 节点级对齐规则

拉取是对本地书签树的**镜像对齐**，不是并集合并：

| 情况 | 动作 | 判定依据 |
|---|---|---|
| 远端节点在本地映射表中命中 | 覆盖标题与网址，移动到远端指定的顺序；文件夹递归处理子级 | **稳定 `uuid`**，不是标题文字 |
| 远端有、本地没有 | 在同一父文件夹下按远端顺序新建 | `uuid` 未命中 |
| 本地有、远端没有 | 删除本地多余节点 | 对齐结束时清理 |

标题相同但 `uuid` 不同的两条书签会被当作两条不同记录：远端那条新建、本地那条删除。根文件夹有特殊兜底：先按 `uuid` 匹配，再按标题匹配，最后取任意未使用的根目录。

**推送方向不是逐节点合并**：整棵本地树序列化后覆盖同步文件，远端独有节点随之消失；覆盖前若走冲突分支会先提交远端快照。

### 9.6 边界情况

| 边界 | 处理 |
|---|---|
| 空仓库 / 无同步文件 | 404 视为「远端暂无文件」；首次同步创建文件并推送完整本地树；其他 GitHub 错误直接失败 |
| 远端 tree 为空 | 不进入首拉分支，按本地变化处理 |
| 同名文件非本插件格式 | 原样备份后写入，绝不删除原内容 |
| 更高 `schema` 版本 | 报错停止，不覆盖，等待插件升级 |
| 多端同时修改 | 三方比较 + `PUT` 携带 `sha`；期间远端被改动返回 409，同步失败，不会静默覆盖 |
| 同一扩展重复触发 | `syncing` 互斥，后一次直接跳过 |
| 远端文件被删除且非首次同步 | 本地无变化判为 `noop`；本地有变化走冲突分支（默认重建远端文件，`prefer-remote` 因无远端树可应用会失败） |
| 配置草稿存在 | 同步被拒绝，提示先修正并保存配置 |
| 存储写入失败 | 返回 `saveFailed`，表单保留输入，可直接重试 |
| 网络异常 / 令牌失效 | 显示明确错误与终态，本地书签不受影响；修正后可继续同步 |
| 浏览器内置特殊根节点被重命名 | 记录 warning 并跳过，不影响其他节点 |

### 9.7 备份与回滚

- **远端快照**：写入 `backups/bookmarks-<时间>-<原因>.json`，原因包括 `conflict-remote`、`conflict-local`、`existing-file`。
- **本地快照**：写入 `bookmarkSync.backups`。低内存模式默认只保留 **1 份**；关闭后按 `backupCount`（1–5）保留。
- 弹窗只读取备份元信息（时间、原因、节点数），选中恢复时才读取完整树。

---

## 10. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `403 Resource not accessible by personal access token` | 令牌对该仓库缺少写权限，不是仓库不存在或路径错误 | classic PAT 勾完整 `repo`；fine-grained PAT 把 Contents 设为 `Read and write`；组织仓库再点 Authorize SSO。先用「测试连接」查看提示 |
| 测试连接显示无写权限 | GitHub 返回 `permissions.push=false` | 按上一条调整令牌权限后重试；测试连接不会产生写入 |
| 首次同步后本地书签被远端替换 | 远端已有本插件格式的书签，且本地也非空 | 这是设计行为：首次同步远端优先，本地已留快照。可在弹窗备份列表中恢复 |
| 同步一直显示进行中 | 进度消息未被弹窗接收（例如后台被浏览器休眠） | 关闭再打开弹窗查看状态；刷新扩展后重试；不要连续点击同步 |
| 弹窗提示「存在尚未生效的暂存配置」 | 上次输入未通过校验，已保存为草稿 | 补全 / 修正配置并再次「保存配置」 |
| 保存失败但输入还在 | 存储写入异常，表单被刻意保留 | 直接点击「保存配置」重试，输入未丢失 |
| Firefox 重启后插件消失 | 使用「临时载入附加组件」 | 开发期用 `web-ext run --source-dir dist/universal`；正式使用需签名安装 |
| 本地删除的书签在下一次同步后又出现 | 旧版本浏览器缓存了 GitHub 的 GET 响应（含过期 sha/content），把已删项当作远端变更拉回；已在本版修复 | 更新到当前版本（所有请求已禁用 HTTP 缓存）；删除后立即同步一次即可，删除会正常推送到远端 |
| 远端被他人改动后同步失败（409） | 多端并发，SHA 不匹配；或旧版缓存返回过期 sha | 等待对方完成后重新同步；本版已消除缓存导致的伪 409，改动不会静默覆盖 |
| 状态显示「本地已变化，等待手动同步」 | 自动同步关闭时书签发生变化 | 点击「立即同步」，或开启自动同步并保存配置 |
| 图标在深色工具栏看不清 | 浏览器未使用主题变体 | Chromium 使用自带对比度的渐变图标；Firefox 通过 `theme_icons` 自动切换 |
| 构建报图标尺寸不符 | PNG 实际宽高与清单声明不一致 | 重新执行 `python tools/generate_icons.py && python build.py` |

---

## 11. 注意事项

- 令牌只在浏览器扩展本地存储与 `api.github.com` 请求头中出现；不会写入仓库文件、不会出现在日志或 UI 明文（UI 脱敏显示）。
- 同步文件可能包含完整书签标题与 URL，请使用 **Private** 仓库并仅授予必要权限。
- classic PAT 的 `repo` scope 权限较宽；建议使用专用账户或专用令牌，并定期轮换。
- 请勿把令牌、密钥、账号信息写入源码、配置、文档、提交信息或日志；它们不属于本项目交付内容。
- 所有覆盖性写操作前都会生成备份；发现异常时优先从 `backups/` 或扩展本地快照回滚，再排查配置。
- 无第三方运行时依赖、无遥测、无远程脚本；权限为最小集 `bookmarks` / `storage` / `alarms` + `https://api.github.com/*`。
- 未做多设备高频并发写入的服务端事务；依赖 GitHub Contents 的 SHA 冲突检测（409）。
- 未实现 Web Crypto 加密 token；token 存于 `storage.local`（扩展隔离但非系统密钥库）。
- Safari 需要不同的签名与打包流程，且 `bookmarks` API 行为未实测，本版本未验证。
- 浏览器内置特殊根节点被重命名时会记录 warning 并跳过，不处理该极端情况。

---

## 12. 验证与复核

### 12.1 静态验证（已执行）

12 个脚本语法检查通过；`model.test.js` 5 项、`sync.test.js` 15 项、`smoke.test.js` 25 项、`security.test.js` 22 项，共 **67 项测试全部通过**；唯一 manifest 为合法 JSON 且版本为 1.0.0，同时包含 `service_worker` 与 `scripts`；通用 zip 含 23 个文件（含 12 个图标资源）。

覆盖：无效输入草稿落盘、有效保存清草稿、存储失败返回、草稿阻止同步、缺文件首次同步完整推送、进度按阶段递增与失败终态、弹窗进度渲染、图标尺寸 / 主题变体与清单引用完整性、首次同步失败后重试仍按首次规则、`debounceMs` 实际生效、本地删除不被缓存回滚且不产生 409、所有 GitHub 请求禁用 HTTP 缓存。

复核中修复并复测确认的问题：

| 问题 | 位置 | 严重程度 | 修复 |
|---|---|---|---|
| 首次同步且远端已有书签时直接推送本地，覆盖远端且无备份 | `lib/sync.js` `runSync` | 高（数据丢失） | 增加 firstSync 分支：远端非空树时先留本地快照，采用远端 |
| `SAVE_CONFIG` 直接写入任意消息内容 | `background.js` 消息处理 | 中（配置注入） | 白名单过滤键 + `config.validate` + 拒绝脱敏串回写 |
| `SET_CONFLICT` 接受任意策略字符串 | `background.js` 消息处理 | 中（状态污染） | 仅接受 `backup-then-local` / `prefer-remote` |
| `RESTORE_BACKUP` 非法序号回退为 0 | `background.js`、`sync.js` | 中（误恢复） | 校验非负整数；恢复前校验配置有效性 |
| 弹窗按钮在异常时保持禁用 | `popup.js` `withBusy` | 低（可用性） | 增加 `finally` 语义，异常时恢复按钮并提示 |
| 安装后自动同步默认开启，可能意外写入 | `config.js`、`background.js` | 中（意外写入） | 默认 `autoSync: false`；未配置或配置非法不建闹钟；安装时不写 `deviceId` 或状态 |
| 403 仅显示原始英文错误，无法判断授权项 | `github.js`、`background.js` | 中（可诊断性） | 按 classic / fine-grained 令牌给出 `repo scope` / `Contents: Read and write` / SSO 指引；连接时预检 `permissions.push` |
| 配置未通过校验时输入不落盘，关闭弹窗即丢失 | `config.js`、`background.js`、`popup.js` | 中（数据丢失） | 无效输入立即写草稿、有效保存原子清草稿、存储失败明确提示且保留表单 |
| 首次同步远端无文件且本地无书签变更时不创建文件 | `lib/sync.js` `runSync` | 中（功能缺失） | 首次同步缺文件直接创建并推送完整本地树 |
| 同步期间无进度反馈 | `lib/sync.js`、`background.js`、`popup.js` | 中（体验） | 分阶段百分比消息推送、进度条与失败终态展示 |
| 首次同步失败后重试被误判为双向冲突，反向覆盖远端 | `lib/sync.js` `runSync` | 高（数据丢失） | `firstSync` 改以 `baseTree` 与 `remoteSha` 同时为空判定 |
| `debounceMs` 配置项未生效 | `background.js`、`lib/util.js` | 低（配置无效） | 启动与保存配置时刷新缓存，去抖延迟读取缓存值 |
| 构建脚本只校验图标宽度未校验高度 | `build.py` | 低（校验缺口） | PNG 尺寸校验改为宽高元组比对 |

在 Windows / Node 22 环境下可复现：

```bash
node --check src/lib/util.js
node --check src/lib/api.js
node --check src/lib/config.js
node --check src/lib/github.js
node --check src/lib/model.js
node --check src/lib/sync.js
node --check src/background.js
node --check src/popup.js
node tests/model.test.js
node tests/sync.test.js
node tests/smoke.test.js
node tests/security.test.js
python build.py
python -c "import json; m=json.load(open('dist/universal/manifest.json',encoding='utf-8')); assert m['manifest_version']==3 and m['background']['service_worker'] and m['background']['scripts']; print('unified manifest OK')"
```

### 12.2 人工端到端验证清单

> 必须在真实浏览器与真实私有仓库中完成；以下项目无法仅靠静态检查替代。

1. **同包加载**：同一个 `dist/universal` 目录分别在 Chrome 与 Firefox 加载成功。
2. **连接验证**：填入自己的仓库与 classic PAT 后，测试连接应显示可访问、有写权限、同步文件不存在。
3. **原有文件保护**：若同步文件已有非本插件内容，首次同步后确认 `backups/initial-*.json` 中存在原内容。
4. **首次推送**：浏览器 A 添加 2 个书签 + 1 个文件夹并调整顺序 → 立即同步 → 仓库中核对层级、标题、URL、顺序。
5. **跨浏览器拉取**：浏览器 B 立即同步 → 书签树与 A 一致。
6. **新增 / 修改**：B 新增书签、重命名文件夹、修改 URL → 同步 → A 同步后一致。
7. **移动与排序**：A 跨文件夹移动书签、调整文件夹顺序 → 同步 → B 一致。
8. **删除**：B 删除一个文件夹（含子项）→ 同步 → A 对应节点消失。
9. **冲突**：A、B 同时改动后各自同步，第二方应出现冲突提示；执行两种策略各一次，确认 `backups/` 产生快照。
10. **回滚**：使用备份恢复，确认本地书签树恢复到快照状态。
11. **自动同步**：开启自动同步，修改书签后等待（默认 3 秒防抖 + 15 分钟闹钟轮询），确认徽章与状态更新。
12. **错误处理**：把令牌改为无效值 → 同步显示明确错误且不删除本地书签；恢复后可继续同步。

---

## 13. 浏览器兼容差异

| 项目 | Chrome / Edge | Firefox | Safari（未验证） |
|---|---|---|---|
| Manifest | MV3 | MV3 | MV3 |
| 后台上下文 | service worker | event page（`scripts`） | event page（默认） |
| 后台声明来源 | `background.service_worker` | `background.scripts` | `background.scripts` |
| API 命名空间 | `chrome.*`（新版本亦支持 `browser.*`） | `browser.*` Promise | `browser.*` Promise |
| 适配方式 | `lib/api.js` 统一为 Promise，无需 polyfill | 同左 | 同左 |
| 工具栏 | `action`（多尺寸渐变图标） | `action` + `theme_icons` 深浅主题变体 | `action`（未验证主题变体） |
| host 权限 | `host_permissions` | `host_permissions` | `host_permissions` |
| 书签根 ID | `1/2/3` | 字符串 ID（如 `toolbar_____`） | 与 Firefox 类似 |
| 根 ID 处理 | 不硬编码，按 UUID 映射 + 标题匹配 | 同左 | 同左 |
| 最低版本 | 121+ | 121+ | 16.4+（未验证） |
| 加载方式 | 加载已解压扩展 | 临时附加组件（`web-ext run` 可持久） | 需 Xcode 转换与签名 |

其他 Chromium 系（Opera / Brave / Vivaldi）直接使用同一个 zip。

---

## 14. 后续可配置项

1. **凭据安全**：Web Crypto + 用户口令派生密钥加密 token；或用原生 messaging 接入系统钥匙串。
2. **OAuth**：接入 GitHub OAuth App + 后端 token 交换，替代 PAT。
3. **冲突策略**：基于 `updatedAt` 的 last-write-wins、按文件夹粒度的三方合并、用户逐项选择。
4. **同步范围**：只同步指定根目录、排除某些文件夹、同步标签 / 阅读列表。
5. **调度**：可调防抖时间、仅在 Wi-Fi 同步、低电量暂停。
6. **存储后端**：Git 原生提交（GitHub Git Data API）替代 Contents API，支持更细粒度 diff 与更完整的提交历史。
7. **可观测性**：同步日志面板、失败重试次数与退避、导入 / 导出本地快照。
8. **Safari 正式支持**：使用 `web-ext convert` / Xcode 签名，并实测 `bookmarks` 权限行为。
