# 项目全面复核报告（v0.3.2，v0.3.3 与 v0.3.4 增补见文末）

> **v0.3.3 增补**：安装后默认零写入（`autoSync: false`、未配置不建闹钟、安装时不写 `deviceId`/状态、未配置时书签变化不写状态）；403 错误按 classic / fine-grained 令牌给出 `repo scope`、`Contents: Read and write` 与 SSO 指引；测试连接预检 `permissions.push` 且全程只读。新增 10 项测试（冒烟 17→23，安全 15→18），总计 55 项通过。
>
> **v0.3.4 增补**：保存立即落盘（有效配置一次写入生效并清草稿；无效输入写 `bookmarkSync.draft` 防丢失；存储失败返回 `saveFailed` 且保留表单）；首次同步缺 `bookmarks.json` 时无条件创建并完整推送本地树；同步阶段进度 5/15/30/50/60/80/100% 通过消息推送到弹窗进度条，失败显示终态。新增 7 项测试，总计 62 项通过。
>
> **图标增补（v0.3.4 后续）**：统一工具栏/管理页/弹窗品牌与状态图标为同一「云 + 上下双向箭头」语义，16–128px 多尺寸 PNG + SVG 源；Firefox 通过 `theme_icons` 提供深浅工具栏变体，Chromium 使用自带对比度的渐变图标。新增 1 项图标资源测试，总计 63 项通过。
>
> **二次复核增补（v0.3.4 后续）**：修复「首次同步失败后重试」被误判为双向冲突、反向覆盖远端的高危分支——`firstSync` 改以 `baseTree` 与 `remoteSha` 同时为空判定，不再受失败时写入的 `lastSyncAt` 污染；`debounceMs` 配置改为在启动与保存配置时刷新缓存并驱动去抖，不再硬编码；构建脚本图标校验补齐高度。新增 2 项回归测试（sync、smoke 各 1），总计 65 项通过。



复核日期：2026-11-24
复核范围：`bookmark-sync-extension/` 全部 27 个文件（源码 11、测试 4、README、构建脚本、dist 产物、zip），含代码、配置、资源、插件入口与依赖面。

---

## 1. 复核结论

- 文件结构、引用路径、脚本加载顺序、manifest 双后台声明、消息协议、同步流程均正确。
- 冒烟测试覆盖安装/加载与核心功能，46 项测试全部通过，0 项失败。
- 安全验证发现 5 个问题（1 高、3 中、1 低），全部修复并复测通过。
- 无第三方运行时依赖；权限为最小集；敏感数据未见泄漏路径。

---

## 2. 冒烟测试结果（17 项通过 / 0 项失败）

| 类别 | 通过项 |
|---|---|
| 安装结构 | manifest 合法且唯一；manifest 引用文件齐全；dist 与 src 逐字节一致；zip 文件集合一致 |
| Chromium 路径 | 后台脚本经 importScripts 加载并注册事件；PING/GET_STATUS/SAVE_CONFIG/TEST_CONNECTION/SYNC_NOW 可用；首次同步创建远端；重复同步零写入；无效令牌报错且不改本地 |
| Firefox 路径 | 后台 scripts 加载并注册事件；同一组消息协议与同步行为全部通过 |
| 弹窗入口 | popup.js 在 DOM 环境可加载、绑定事件并完成首次状态读取 |

命令：`node tests/smoke.test.js`。

---

## 3. 安全验证结果（15 项通过 / 0 项失败）

| 类别 | 通过项 |
|---|---|
| 依赖与权限 | 无 package.json / node_modules / 远程脚本；manifest 仅声明 bookmarks/storage/alarms 与 api.github.com |
| 输入校验 | 拒绝空令牌、非法 owner/repo、路径穿越 `..`、越界 interval/backupCount；Contents 路径逐段编码 |
| 敏感数据 | 令牌脱敏不泄露中段；同步文件不含令牌，仅 schema/updatedAt/deviceId/tree |
| 危险逻辑 | 高 schema 直接报错不覆盖；非法 JSON 先备份原内容；首次同步保留远端；非法备份序号不误恢复；网络异常明确报错且不改本地 |
| 消息边界 | SAVE_CONFIG 拒绝非法配置；SET_CONFLICT 拒绝非法策略；GET_STATUS 不泄露完整令牌与完整备份树 |

命令：`node tests/security.test.js`。

---

## 4. 问题清单与修复

### 4.1 首次同步可能覆盖远端已有书签（高，数据丢失）

- **位置**：`src/lib/sync.js` `runSync` 决策段（原第 374–405 行）。
- **依据**：安全测试「首次同步远端已有书签」修复前失败——`status=pushed`，远端树被本地树覆盖且 `backups/` 无快照。
- **根因**：`firstSync` 为真时跳过冲突分支，随后 `localChanged` 为真直接走 `pushLocal`，未处理「远端已有本插件格式书签」这一分支。
- **修复**：在 `noop` 判断之后增加分支——`firstSync && remoteFile && remoteTree && remoteTree.length > 0` 时调用 `pullRemote`，先留本地快照再采用远端。远端为空树时仍按本地增量推送（无数据需要保护）。
- **复测**：安全测试通过；`sync.test.js` 9 项无回归。

### 4.2 SAVE_CONFIG 无输入校验（中，配置注入）

- **位置**：`src/background.js` 消息处理 `SAVE_CONFIG` 分支。
- **依据**：修复前发送 `{path:'../../evil', token:12345, syncIntervalMinutes:-1}` 被原样写入 storage。
- **修复**：新增 `CONFIG_KEYS` 白名单过滤未知键；合并后用 `config.validate` 校验；含 `*` 的脱敏令牌不写回；响应带回 warnings。
- **复测**：安全测试断言非法配置被拒绝且 storage 未写入，通过。

### 4.3 SET_CONFLICT 接受任意策略（中，状态污染）

- **位置**：`src/background.js` 消息处理 `SET_CONFLICT` 分支。
- **依据**：修复前 `strategy:'delete-everything'` 被写入配置。
- **修复**：仅接受 `backup-then-local` 与 `prefer-remote`。
- **复测**：安全测试通过。

### 4.4 RESTORE_BACKUP 非法序号回退为 0（中，误恢复）

- **位置**：`src/background.js`（`Number(message.index) || 0`）与 `src/lib/sync.js` `restoreBackup`。
- **依据**：`'not-a-number'` 经 `Number() || 0` 变成 0，会静默恢复第 0 份快照。
- **修复**：后台与引擎双层校验非负整数；`restoreBackup` 在执行前校验配置有效性、备份 tree 是否为数组。
- **复测**：安全测试「非法备份序号不得误恢复其他快照」通过。

### 4.5 弹窗按钮异常时保持禁用（低，可用性）

- **位置**：`src/popup.js` `withBusy`。
- **依据**：`fn()` 同步或异步抛错时没有恢复按钮状态。
- **修复**：用 `Promise.resolve(fn()).then(restore, ...)` 并加同步 try/catch，异常时恢复按钮并 toast 提示。
- **复测**：冒烟测试弹窗入口用例通过。

---

## 5. 按文件/模块汇总

| 文件/模块 | 检查结论 | 问题与处理 |
|---|---|---|
| `src/manifest.base.json` | 合法 MV3；双后台字段齐全；权限最小集 | 无问题 |
| `src/lib/util.js` | UUID/Base64/深比较/防抖/脱敏均正确 | 无问题 |
| `src/lib/api.js` | chrome 回调与 browser Promise 双路径适配正确 | 无问题 |
| `src/lib/config.js` | 默认值、校验、存储隔离正确 | 无问题 |
| `src/lib/github.js` | URL 编码、SHA、错误处理正确 | 无问题 |
| `src/lib/model.js` | 根提取、UUID 映射、结构校验正确 | 无问题 |
| `src/lib/sync.js` | 三方比较、增量、备份、回滚流程正确 | 修复 4.1、4.4 |
| `src/background.js` | 事件去抖、闹钟、消息协议正确 | 修复 4.2、4.3、4.4 |
| `src/popup.html` / `popup.css` | 引用路径齐全、资源本地化 | 无问题 |
| `src/popup.js` | 表单、状态、冲突处理、备份恢复正确 | 修复 4.5 |
| `build.py` | 单一通用产物生成、旧产物清理正确 | 无问题 |
| `tests/*` | 46 项覆盖结构、加载、核心功能与安全 | 新增 smoke/security 两套 |
| `dist/universal/` / `bookmark-sync-universal.zip` | 11 文件，与 src 一致，含全部修复 | 无问题 |

---

## 6. 未覆盖范围

- 真实浏览器（Chrome/Edge/Firefox）图形界面的加载与人工点击，由用户按 README 端到端清单执行；本次为模拟浏览器环境的自动化验证。
- Safari 签名与 `bookmarks` API 行为未在基础版范围内。
- token 仍存于扩展隔离存储，非系统密钥库加密（README 已标注为后续项）。
