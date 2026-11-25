# Bookmark Sync via GitHub（低内存优化版 v0.3.2）

**一个插件包同时兼容 Chrome、Edge、Firefox**（并覆盖多数 Chromium 系浏览器）。通过用户授权的 GitHub 私人仓库保存书签树，实现新增、修改、删除、移动以及文件夹层级、名称和顺序的双向同步。

v0.3.2：全面复核后修复首次同步可能覆盖远端书签、消息层缺少配置校验、备份序号可误恢复三项风险，并新增 32 项冒烟与安全测试。v0.3.1：默认同步仓库改为**新建的**私有仓库 `P4x1s/bookmark-sync-vault`，不再使用原 `P4x1s/bookmarks`。v0.3.0 已实现：降低后台常驻内存与轮询开销、重做扩展界面、保护仓库中已有文件不被删除。

---

## 1. 单包兼容的实现方式

旧版按浏览器拆成三个包；v0.2.0 改为**一份 Manifest V3 + 一个目录 + 一个 zip**：

```json
"background": {
  "service_worker": "background.js",
  "scripts": ["lib/util.js", ..., "background.js"]
}
```

- Chromium 系（Chrome / Edge / Opera / Brave / Vivaldi）：使用 `service_worker`，Chrome 121+ 会忽略 MV3 中同时出现的 `scripts`。
- Firefox：使用 `scripts` 启动事件页；Firefox 121+ 即使 manifest 中存在 `service_worker` 也能正常启动后台页。
- Safari：同样读取 `scripts`；默认事件页，未在本版本做签名与真机验证。

所有脚本均为经典脚本（非 ES Module），后台入口通过 `if (!BS.api && importScripts)` 守卫：Chromium 走 `importScripts` 加载依赖，Firefox/Safari 由 `background.scripts` 按顺序加载，同一份 `background.js` 无需改动。

结论：**只需分发 `bookmark-sync-universal.zip` 或 `dist/universal/` 目录**。

### 1.1 v0.3.0 低内存与稳定性措施

| 措施 | 原实现 | 现实现 | 收益 |
|---|---|---|---|
| 本地快照存储 | 最多 5 份完整树内嵌在常规 state，每次读取 state 全部载入 | 快照独立 key，常规 state 只含必要字段；弹窗只取元信息，恢复时才读完整树 | 后台不再反复序列化/反序列化多份书签树 |
| 弹窗状态更新 | 每 5 秒轮询后台 | 后台同步完成后主动推送 `STATUS`，弹窗收到后读取一次 | 弹窗打开时不再持续唤醒后台 |
| 书签事件处理 | 每个事件都调用徽章 API | 事件只触发去抖计时器，3 秒后合并执行一次 | 大量书签操作时 API 调用量大幅下降 |
| 树拷贝 | 推送/拉取后深拷贝整棵树作为 base | 直接复用引用，用完即释放 | 少一份完整树常驻 |
| 序列化 | `JSON.stringify(..., null, 2)` | 同步文件无缩进；备份文件仍保留可读性 | 大书签库字符串与内存占用下降 |
| 低内存模式 | 无 | 默认开启：本地快照只留 1 份 | 进一步压缩长期存储与读取量 |

同步过程始终串行执行，且有 `syncing` 互斥与 `applying` 回环保护，避免并发写导致浏览器卡顿。

---

## 2. 项目结构

```
bookmark-sync-extension/
├─ build.py                   # 生成唯一通用产物并清理旧拆包
├─ README.md
├─ src/
│  ├─ manifest.base.json      # 唯一 MV3 清单模板（含 dual background）
│  ├─ background.js           # 后台：书签事件、闹钟、消息、徽章
│  ├─ popup.html / .css / .js # 配置与状态界面
│  └─ lib/
│     ├─ util.js              # UUID / UTF-8 Base64 / 深比较 / 防抖
│     ├─ api.js               # chrome.* 与 browser.* 的 Promise 适配层
│     ├─ config.js            # 配置与 token 存储（storage.local）
│     ├─ github.js            # GitHub Contents API 客户端（SHA / 备份）
│     ├─ model.js             # 书签树归一化、UUID 映射、结构校验
│     └─ sync.js              # 三方比较、增量、冲突、备份、回滚
├─ tests/
│  ├─ model.test.js           # Node 纯逻辑测试
│  ├─ sync.test.js            # 模拟 GitHub API 的同步引擎集成测试
│  ├─ smoke.test.js           # 安装/加载/消息/核心功能冒烟测试（双浏览器路径）
│  └─ security.test.js        # 输入校验、权限、敏感数据、危险逻辑安全测试
└─ dist/
   └─ universal/              # 唯一构建产物（一个插件）
```

生成产物：`bookmark-sync-universal.zip`。

---

## 3. 快速开始

### 3.1 准备 GitHub 私人仓库与令牌

1. **同步仓库已创建：`P4x1s/bookmark-sync-vault`**（Private，默认分支 `main`，当前仅含一个说明用的 `README.md`）。地址：<https://github.com/P4x1s/bookmark-sync-vault>。插件默认已预置 owner / repo，无需手填；原 `P4x1s/bookmarks` 不再被插件引用，也未被改动。
2. 生成 **classic PAT**：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)。
   - 勾选 `repo`（私人仓库读写必需；已有 token 若具备 `repo` scope 可直接用）。
   - **不要使用 fine-grained PAT**：实测写 Contents 会返回 `403 Resource not accessible by personal access token`，即使能读能登录。
3. 分支默认 `main`，同步文件默认 `bookmarks.json`（新仓库中尚不存在，首次同步会创建）。仓库内已有文件不会被删除或覆盖；如同步路径撞上已有文件，会先提交 `backups/initial-*.json` 快照。

### 3.2 加载同一个插件

解压 `bookmark-sync-universal.zip`，所有浏览器都选择**同一个目录**：

| 浏览器 | 步骤 | 选择目录 |
|---|---|---|
| Chrome | `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 | `dist/universal` |
| Edge | `edge://extensions` → 开发者模式 → 加载解压缩的扩展 | `dist/universal` |
| Firefox | `about:debugging#/runtime/this-firefox` → 临时载入附加组件 | `dist/universal/manifest.json` |
| Opera / Brave / Vivaldi | 扩展管理页 → 加载已解压的扩展 | `dist/universal` |

> 最低版本：Chrome / Edge 121+，Firefox 121+（dual background 字段要求）。
> Firefox 的「临时载入」在浏览器重启后失效；开发期可用 `web-ext run --source-dir dist/universal` 持续加载。

### 3.3 配置与首次同步

1. 点击工具栏图标，只需填写 token；owner / repo 已预置为 `P4x1s` / `bookmarks`。
2. 点击 **测试连接**：应显示仓库为 Private、有写权限，并报告同步文件是否存在。
3. 点击 **保存配置**，再点击 **立即同步**。
4. 在第二个浏览器中加载同一个包，配置后「立即同步」拉取远端树（首次拉取会先留本地快照）。

---

## 4. 同步模型与关键行为

### 4.1 数据格式

远端文件 `bookmarks.json`：

```json
{
  "schema": 1,
  "updatedAt": "2026-11-24T03:00:00.000Z",
  "deviceId": "<稳定设备ID>",
  "tree": [
    { "uuid": "...", "type": "folder", "title": "Bookmarks bar",
      "children": [
        { "uuid": "...", "type": "url", "title": "示例", "url": "https://example.com" }
      ] }
  ]
}
```

稳定 `uuid` 保存在扩展存储中并映射到浏览器本地 bookmark id，解决 Chrome/Firefox 本地 ID 不一致的问题。

### 4.2 三方比较与决策

| 本地相对 base | 远端相对 base | 行为 |
|---|---|---|
| 无变化 | 无变化 | 不写入 |
| 有变化 | 无变化 | 推送本地（增量，仅在 SHA 匹配时更新远端） |
| 无变化 | 有变化 | 先留本地快照，再应用远端 |
| 有变化 | 有变化 | 冲突：按配置备份后二选一 |
| 无 base（首次） | 远端存在 | 先留本地快照，采用远端（本地书签被覆盖前可回滚） |
| 无 base（首次） | 远端不存在 | 推送本地，创建远端文件 |

### 4.3 避免误覆盖的措施

1. `PUT /contents` 携带上次读取的 `sha`；若期间远端被他人修改，GitHub 返回 `409` 而不是静默覆盖。
2. 任何覆盖远端前，先将**远端快照**提交到 `backups/bookmarks-<时间>-conflict-remote.json`。
3. 任何改写本地书签树前，先将**本地快照**存入 `storage.local.localBackups`（保留最近 5 份）。
4. 冲突默认策略是「备份远端 + 保留本地」，不会自动丢弃用户当前浏览器数据。
5. 同步过程中写入本地书签时设置 `applying` 标志，避免 `onChanged` 事件回环触发同步。

### 4.4 仓库现有内容保护

- 插件只读写配置中指定的 `bookmarks.json`，不会遍历、修改或删除仓库中的其他文件。
- 若该路径已存在**非本插件格式**的文件（例如用户自己的数据），首次同步会先把原始内容原样提交到 `backups/initial-<时间>-existing-file.json`，再写入书签数据。原内容始终保留在仓库中。
- 若文件是本插件不支持的更高 schema 版本，同步直接报错并停止，不会覆盖。
- 所有冲突与恢复操作同样先写 `backups/`，并在本地 `bookmarkSync.backups` 留快照。

### 4.5 冲突处理

冲突时弹窗出现两个按钮：

- **备份远端，保留本地**：把远端快照提交到 `backups/`，然后把本地树推送上去。
- **备份本地，采用远端**：把本地快照提交到 `backups/` 和 `storage.local`，然后用远端树重建本地结构。

也可在「冲突策略」中预设，自动同步时按预设执行。

### 4.6 增量语义

- 本地：每次同步重新读取完整树做结构比较；只有真正有差异时才发写请求。
- 远端：读取 SHA 并参与 PUT；无差异时零写入。
- 对本地执行的是**差异化的 create/update/move/remove**，不是删除后全量重建，最大限度保留浏览器自身元数据。

---

## 5. 运行验证说明

### 5.1 静态验证（已执行）

实际结果：12 个脚本语法检查通过；`model.test.js` 5 项、`sync.test.js` 9 项、`smoke.test.js` 17 项、`security.test.js` 15 项，共 **46 项测试全部通过**；唯一 manifest 为合法 JSON 且版本为 0.3.2，同时包含 `service_worker` 与 `scripts`；通用 zip 含 11 个文件。新建仓库与写权限已通过 GitHub API 实测确认。

复核中修复并复测确认的问题：

| 问题 | 位置 | 严重程度 | 修复 |
|---|---|---|---|
| 首次同步且远端已有书签时直接推送本地，覆盖远端且无备份 | `lib/sync.js` `runSync` | 高（数据丢失） | 增加 firstSync 分支：远端非空树时先留本地快照，采用远端 |
| `SAVE_CONFIG` 直接写入任意消息内容 | `background.js` 消息处理 | 中（配置注入） | 白名单过滤键 + `config.validate` + 拒绝脱敏串回写 |
| `SET_CONFLICT` 接受任意策略字符串 | `background.js` 消息处理 | 中（状态污染） | 仅接受 `backup-then-local` / `prefer-remote` |
| `RESTORE_BACKUP` 非法序号回退为 0 | `background.js`、`sync.js` | 中（误恢复） | 校验非负整数；恢复前校验配置有效性 |
| 弹窗按钮在异常时保持禁用 | `popup.js` `withBusy` | 低（可用性） | 增加 `finally` 语义，异常时恢复按钮并提示 |

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

### 5.2 人工端到端验证清单

> 必须在真实浏览器与真实私人仓库中完成；以下项目无法仅靠静态检查替代。

1. **同包加载**：同一个 `dist/universal` 目录分别在 Chrome 与 Firefox 加载成功，后台页均正常启动。
2. **连接验证**：预置仓库为 `P4x1s/bookmark-sync-vault`；填入 classic PAT 后测试连接应显示 Private、push 权限、`bookmarks.json` 不存在（首次同步会创建）。
3. **原有文件保护**：若 `bookmarks.json` 已有非本插件内容，首次同步后确认 `backups/initial-*.json` 中存在原内容。
4. **首次推送**：浏览器 A 添加 2 个书签 + 1 个文件夹并调整顺序 → 立即同步 → GitHub 上打开 `bookmarks.json` 核对层级、标题、URL、顺序。
5. **跨浏览器拉取**：浏览器 B 立即同步 → 书签树与 A 一致。
6. **新增/修改**：B 新增书签、重命名文件夹、修改 URL → 同步 → A 同步后一致。
7. **移动与排序**：A 把书签跨文件夹移动、调整文件夹顺序 → 同步 → B 一致。
8. **删除**：B 删除一个文件夹（含子项）→ 同步 → A 对应节点消失。
9. **冲突**：A、B 同时改动后各自同步，第二方应出现冲突提示；执行两种冲突策略各一次，确认 `backups/` 中产生快照文件。
10. **回滚**：使用备份恢复，确认本地书签树恢复到快照状态。
11. **自动同步**：开启自动同步，修改书签后等待（默认 3 秒防抖 + 15 分钟闹钟轮询），确认徽章与状态更新。
12. **错误处理**：把 token 改为无效值 → 同步应显示明确错误且不删除本地书签；恢复 token 后可继续同步。

### 5.3 未验证边界（基础版本）

- 未在 Safari 验证：Safari 需要不同的签名与打包流程，且 `bookmarks` API 行为未实测。
- 未实现真正的 Web Crypto 加密 token；token 存于 `storage.local`（扩展隔离但非系统密钥库）。
- 未做多设备高频并发写入的服务端事务；依赖 GitHub Contents 的 SHA 冲突检测（409）。
- 未处理浏览器内置特殊根节点被重命名的极端情况（会记录 warning 并跳过）。

---

## 6. 浏览器兼容差异

| 项目 | Chrome / Edge | Firefox | Safari（未验证） |
|---|---|---|---|
| Manifest | MV3 | MV3 | MV3 |
| 后台上下文 | service worker | event page（`scripts`） | event page（默认） |
| 后台声明来源 | `background.service_worker` | `background.scripts` | `background.scripts` |
| API 命名空间 | `chrome.*`（新版本亦支持 `browser.*`） | `browser.*` Promise | `browser.*` Promise |
| 适配方式 | `lib/api.js` 统一为 Promise，无需 polyfill | 同左 | 同左 |
| 工具栏 | `action` | `action` | `action` |
| host 权限 | `host_permissions` | `host_permissions` | `host_permissions` |
| 书签根 ID | `1/2/3` | 字符串 ID（如 `toolbar_____`） | 与 Firefox 类似 |
| 根 ID 处理 | 不硬编码，按 UUID 映射 + 标题匹配 | 同左 | 同左 |
| 最低版本 | 121+ | 121+ | 16.4+（未验证） |
| 加载方式 | 加载已解压扩展 | 临时附加组件（`web-ext run` 可持久） | 需 Xcode 转换与签名 |

其他 Chromium 系（Opera / Brave / Vivaldi）直接使用同一个 zip。

---

## 7. 后续可配置项

1. **凭据安全**：Web Crypto + 用户口令派生密钥加密 token；或用原生 messaging 接入系统钥匙串。
2. **OAuth**：接入 GitHub OAuth App + 后端 token 交换，替代 PAT。
3. **冲突策略**：基于 `updatedAt` 的 last-write-wins、按文件夹粒度的三方合并、用户逐项选择。
4. **同步范围**：只同步指定根目录、排除某些文件夹、同步标签/阅读列表。
5. **调度**：可调防抖时间、仅在 Wi-Fi 同步、低电量暂停。
6. **存储后端**：Git 原生提交（GitHub Git Data API）替代 Contents API，支持更细粒度 diff 与更完整的提交历史。
7. **可观测性**：同步日志面板、失败重试次数与退避、导入/导出本地快照。
8. **Safari 正式支持**：使用 `web-ext convert` / Xcode 签名，并实测 `bookmarks` 权限行为。

---

## 8. 安全与隐私说明

- Token 只在浏览器扩展本地存储与 `api.github.com` 请求头中出现；不会写入仓库文件、不会出现在日志或 UI 明文（UI 脱敏显示）。
- 同步文件可能包含完整书签标题与 URL，请使用 **Private** 仓库并仅授权必要 token。
- classic PAT 的 `repo` scope 权限较宽；建议使用专用 GitHub 账号或专用 token，并定期轮换。
- 所有覆盖性写操作前都会生成备份；如发现异常，优先从 `backups/` 或扩展本地快照回滚，再排查配置。
