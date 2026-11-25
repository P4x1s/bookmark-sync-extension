/*
 * 后台入口（单包兼容）。
 * Chromium MV3：service worker 通过 importScripts 加载依赖。
 * Firefox/Safari MV3：manifest.background.scripts 已按顺序加载依赖，这里不再 import。
 * 低内存策略：不轮询状态、不常驻完整备份树、事件去抖后才触发同步。
 */
(function (global) {
  'use strict';

  if (!global.BS || !global.BS.api) {
    if (typeof importScripts === 'function') {
      importScripts(
        'lib/util.js',
        'lib/api.js',
        'lib/config.js',
        'lib/github.js',
        'lib/model.js',
        'lib/sync.js'
      );
    } else {
      throw new Error('扩展依赖脚本未加载，请检查 manifest.background.scripts 配置');
    }
  }

  var BS = global.BS;
  var api = BS.api;
  var config = BS.config;
  var sync = BS.sync;
  var util = BS.util;

  var ALARM_NAME = 'bookmark-sync-alarm';
  var syncing = false;
  // 仅接受这些配置键，忽略未知字段，避免消息注入配置项。
  var CONFIG_KEYS = ['owner', 'repo', 'branch', 'path', 'token', 'autoSync',
    'syncIntervalMinutes', 'debounceMs', 'conflictStrategy', 'lowMemoryMode', 'backupCount'];
  var CONFLICT_STRATEGIES = ['backup-then-local', 'prefer-remote'];

  function pickConfig(patch) {
    var out = {};
    var src = patch || {};
    CONFIG_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    });
    return out;
  }

  function badgeFor(status) {
    switch (status) {
      case 'pushed':
      case 'pulled': return ['✓', '#2e7d32'];
      case 'conflict-local-kept':
      case 'conflict-remote-kept': return ['!', '#ed6c02'];
      case 'error': return ['!', '#c62828'];
      default: return ['', '#455a64'];
    }
  }

  function refreshBadge(result) {
    // 优先使用同步结果，避免每次额外读取 storage。
    if (result && result.status) {
      var b = badgeFor(result.status);
      return api.setBadge(b[0], b[1]).catch(function () { /* ignore */ });
    }
    return sync.loadState().then(function (state) {
      var badge = badgeFor(state.lastStatus);
      return api.setBadge(badge[0], badge[1]);
    }).catch(function () { /* ignore */ });
  }

  function doSync(reason) {
    if (syncing) return Promise.resolve({ ok: true, status: 'noop', message: '已有同步任务在执行', skipped: true });
    syncing = true;
    return sync.runSync({ reason: reason })
      .then(function (result) {
        return refreshBadge(result).then(function () { return result; });
      })
      .catch(function (e) {
        return refreshBadge({ status: 'error' }).then(function () {
          return { ok: false, status: 'error', message: e && e.message ? e.message : String(e) };
        });
      })
      .then(function (r) {
        syncing = false;
        return r;
      });
  }

  function setupAlarm(cfg) {
    if (!api.alarms) return Promise.resolve();
    return api.clearAlarm(ALARM_NAME).then(function () {
      // 默认零写入：未显式开启、配置不完整或配置非法时，绝不建立自动同步闹钟。
      if (!cfg || cfg.autoSync !== true || !config.isConfigured(cfg)) return undefined;
      if (!config.validate(cfg).valid) return undefined;
      var minutes = Math.max(1, Math.min(1440, Number(cfg.syncIntervalMinutes) || 15));
      return api.createAlarm(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: minutes });
    }).catch(function () { /* ignore */ });
  }

  var debouncedLocalChange = util.debounce(function () {
    if (sync.applying) return; // 同步引擎写入本地书签时不回环触发。
    config.load().then(function (cfg) {
      // 未完成配置前，本地书签变化也不写任何状态。
      if (!config.isConfigured(cfg)) return undefined;
      if (cfg.autoSync) return doSync('bookmark-change');
      // 自动同步关闭时只写轻量状态，不加载/解析完整书签树。
      return sync.loadState().then(function (state) {
        state.lastStatus = 'dirty';
        state.lastMessage = '本地书签已变化，等待手动同步';
        return sync.saveState(state);
      }).then(function () {
        return api.setBadge('•', '#455a64');
      });
    }).catch(function () { /* ignore */ });
  }, 3000);

  function onLocalBookmarkChange() {
    if (sync.applying) return;
    debouncedLocalChange(); // 事件本身不做任何 API 调用，只在去抖后执行一次。
  }

  var events = api.events;
  if (events.bookmarkCreated) events.bookmarkCreated.addListener(onLocalBookmarkChange);
  if (events.bookmarkRemoved) events.bookmarkRemoved.addListener(onLocalBookmarkChange);
  if (events.bookmarkChanged) events.bookmarkChanged.addListener(onLocalBookmarkChange);
  if (events.bookmarkMoved) events.bookmarkMoved.addListener(onLocalBookmarkChange);

  if (events.alarm) {
    events.alarm.addListener(function (alarm) {
      if (!alarm || alarm.name !== ALARM_NAME) return;
      config.load().then(function (cfg) {
        if (cfg.autoSync && config.isConfigured(cfg)) return doSync('alarm');
        return undefined;
      }).catch(function () { /* ignore */ });
    });
  }

  if (events.installed) {
    events.installed.addListener(function () {
      // 安装后不写任何数据：不生成 deviceId、不创建闹钟、不触发同步。
      // deviceId 在首次真实同步时按需生成，避免安装即产生存储写入。
      return refreshBadge();
    });
  }

  if (events.startup) {
    events.startup.addListener(function () {
      config.load().then(setupAlarm).then(refreshBadge).catch(function () { /* ignore */ });
    });
  }

  if (events.message) {
    events.message.addListener(function (message, sender, sendResponse) {
      (async function () {
        var type = message && message.type;
        try {
          if (type === 'PING') {
            sendResponse({ ok: true, version: '0.3.3' });
            return;
          }
          if (type === 'GET_STATUS') {
            var cfg = await config.load();
            var state = await sync.loadState();
            var backupMeta = await sync.loadBackupMeta();
            sendResponse({
              ok: true,
              config: Object.assign({}, cfg, { token: util.maskToken(cfg.token) }),
              state: state,
              backups: backupMeta
            });
            return;
          }
          if (type === 'SAVE_CONFIG') {
            var patch = pickConfig(message.config);
            // 弹窗中的脱敏串不得写回，避免把掩码当作真实令牌保存。
            if (typeof patch.token === 'string' && patch.token.indexOf('*') >= 0) delete patch.token;
            var candidate = Object.assign(await config.load(), patch);
            var cfgCheck = config.validate(candidate);
            if (!cfgCheck.valid) {
              sendResponse({ ok: false, error: '配置无效：' + cfgCheck.errors.join('；') });
              return;
            }
            var nextConfig = await config.save(patch);
            await setupAlarm(nextConfig);
            sendResponse({
              ok: true,
              config: Object.assign({}, nextConfig, { token: util.maskToken(nextConfig.token) }),
              warnings: cfgCheck.warnings
            });
            return;
          }
          if (type === 'TEST_CONNECTION') {
            var patch = pickConfig(message.config);
            if (message.useStoredToken && patch.token && patch.token.indexOf('*') >= 0) {
              delete patch.token; // 弹窗中显示的是脱敏串，未编辑时沿用已保存的真实 token
            }
            var testCfg = Object.assign(await config.load(), patch);
            var check = config.validate(testCfg);
            if (!check.valid) {
              sendResponse({ ok: false, error: check.errors.join('；') });
              return;
            }
            var client = new BS.GitHubClient(testCfg.token, testCfg.owner, testCfg.repo, testCfg.branch, testCfg.path);
            // 只读预检：不写入任何仓库数据。先核对仓库可访问性与写权限，再尝试读取同步文件。
            var info = await client.checkAccess();
            if (info.permissions && info.permissions.push === false) {
              sendResponse({
                ok: false,
                info: info,
                error: '令牌对此仓库没有写权限（GitHub 返回 permissions.push=false）。' + util.authHint(testCfg.token, 403),
                warnings: check.warnings
              });
              return;
            }
            var fileInfo = null;
            try { fileInfo = await client.readFile(); }
            catch (e) { if (!e || e.status !== 404) throw e; }
            sendResponse({
              ok: true,
              info: info,
              fileExists: !!fileInfo,
              warnings: check.warnings
            });
            return;
          }
          if (type === 'SYNC_NOW') {
            var result = await doSync('manual');
            sendResponse(result);
            return;
          }
          if (type === 'SET_CONFLICT') {
            if (CONFLICT_STRATEGIES.indexOf(message.strategy) < 0) {
              sendResponse({ ok: false, error: '未知冲突策略：' + message.strategy });
              return;
            }
            await config.save({ conflictStrategy: message.strategy });
            var conflictResult = await doSync('conflict-resolution');
            sendResponse(conflictResult);
            return;
          }
          if (type === 'RESTORE_BACKUP') {
            var idx = Number(message.index);
            if (!Number.isInteger(idx) || idx < 0) {
              sendResponse({ ok: false, error: '备份序号无效：' + message.index });
              return;
            }
            var restoreResult = await sync.restoreBackup(idx);
            sendResponse(restoreResult);
            return;
          }
          sendResponse({ ok: false, error: '未知消息类型: ' + type });
        } catch (e) {
          sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      })();
      return true; // 保持异步 sendResponse 通道（Chrome/Firefox 均适用）。
    });
  }

  // service worker 首次启动时也要建立闹钟。
  config.load().then(setupAlarm).then(refreshBadge).catch(function () { /* ignore */ });
})(globalThis);
