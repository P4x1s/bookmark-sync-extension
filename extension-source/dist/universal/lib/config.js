/*
 * 配置与凭据存储。
 * 安全说明：token 保存在 extension storage.local（按扩展隔离，不同步到浏览器账号）。
 * 它不是操作系统级密钥库；基础版本明确记录该边界，并把 Web Crypto / 原生密钥库列为后续项。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};

  var CONFIG_KEY = 'bookmarkSync.config';

  var DEFAULT_CONFIG = {
    // 默认指向专用的私有同步仓库；该仓库匿名访问返回 404，需 classic PAT（repo 权限）授权。
    owner: 'P4x1s',
    repo: 'bookmark-sync-vault',
    branch: 'main',
    path: 'bookmarks.json',
    token: '',
    autoSync: true,
    syncIntervalMinutes: 15,
    debounceMs: 3000,
    // backup-then-local：冲突时备份远端后保留本地；prefer-remote：备份本地后采用远端。
    conflictStrategy: 'backup-then-local',
    // 低内存模式：本地快照只保留 1 份，快照与常规状态分离，常规运行不载入完整树。
    lowMemoryMode: true,
    backupCount: 1,
    deviceId: ''
  };

  var config = BS.config = {};

  config.CONFIG_KEY = CONFIG_KEY;
  config.DEFAULT_CONFIG = DEFAULT_CONFIG;

  config.load = function load() {
    return BS.api.storageGet([CONFIG_KEY]).then(function (data) {
      return Object.assign({}, DEFAULT_CONFIG, (data && data[CONFIG_KEY]) || {});
    });
  };

  config.save = function save(patch) {
    return config.load().then(function (current) {
      var next = Object.assign({}, current, patch || {});
      var obj = {};
      obj[CONFIG_KEY] = next;
      return BS.api.storageSet(obj).then(function () { return next; });
    });
  };

  config.validate = function validate(cfg) {
    var errors = [];
    var warnings = [];
    if (!cfg.owner || !/^[A-Za-z0-9_.-]+$/.test(cfg.owner)) {
      errors.push('GitHub 用户名/组织名不合法');
    }
    if (!cfg.repo || !/^[A-Za-z0-9_.-]+$/.test(cfg.repo)) {
      errors.push('仓库名不合法');
    }
    if (!cfg.branch || !/^[\w./-]+$/.test(cfg.branch)) {
      errors.push('分支名不合法');
    }
    if (!cfg.path || /^\/$/.test(cfg.path) || /\.\./.test(cfg.path)) {
      errors.push('同步文件路径不合法');
    }
    if (!cfg.token) {
      errors.push('未填写 GitHub Personal Access Token');
    } else if (BS.util.isFineGrainedToken(cfg.token)) {
      warnings.push('检测到 fine-grained PAT。GitHub Contents 写入可能返回 403，建议使用 classic PAT（ghp_ 开头，repo 权限）。');
    } else if (!BS.util.isClassicToken(cfg.token)) {
      warnings.push('Token 格式未知；请使用 classic PAT（ghp_/gho_ 开头，repo scope）。');
    }
    var minutes = Number(cfg.syncIntervalMinutes);
    if (!isFinite(minutes) || minutes < 1 || minutes > 1440) {
      errors.push('自动同步间隔需在 1~1440 分钟之间');
    }
    var backupCount = Number(cfg.backupCount);
    if (!isFinite(backupCount) || backupCount < 1 || backupCount > 5) {
      errors.push('本地备份份数需在 1~5 之间');
    }
    return { errors: errors, warnings: warnings, valid: errors.length === 0 };
  };
})(globalThis);
