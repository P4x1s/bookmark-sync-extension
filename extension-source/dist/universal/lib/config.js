/*
 * 配置与凭据存储。
 * 安全说明：token 保存在 extension storage.local（按扩展隔离，不同步到浏览器账号）。
 * 它不是操作系统级密钥库；基础版本明确记录该边界，并把 Web Crypto / 原生密钥库列为后续项。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};

  var CONFIG_KEY = 'bookmarkSync.config';
  // 草稿键：用户输入尚未通过校验时仍立即落盘，避免关闭弹窗后丢失填写内容。
  var DRAFT_KEY = 'bookmarkSync.draft';

  var DEFAULT_CONFIG = {
    // 仓库信息由使用者自行填写；仅支持 classic PAT（repo 权限）授权。
    owner: '',
    repo: '',
    branch: 'main',
    path: 'bookmarks.json',
    token: '',
    // 安装后默认不自动写任何数据：只有用户保存完整配置并显式开启后才建立闹钟。
    autoSync: false,
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
  config.DRAFT_KEY = DRAFT_KEY;
  config.DEFAULT_CONFIG = DEFAULT_CONFIG;

  config.load = function load() {
    return BS.api.storageGet([CONFIG_KEY]).then(function (data) {
      return Object.assign({}, DEFAULT_CONFIG, (data && data[CONFIG_KEY]) || {});
    });
  };

  config.loadDraft = function loadDraft() {
    return BS.api.storageGet([DRAFT_KEY]).then(function (data) {
      var draft = data && data[DRAFT_KEY];
      return (draft && typeof draft === 'object' && !Array.isArray(draft)) ? draft : null;
    });
  };

  // 保存草稿：只持久化用户输入，不作为生效配置，不触发同步或闹钟。
  config.saveDraft = function saveDraft(patch) {
    var obj = {};
    obj[DRAFT_KEY] = patch || {};
    return BS.api.storageSet(obj).then(function () { return patch || {}; });
  };

  // 生效保存：一次存储写入同时更新配置并清除草稿，避免中途失败留下不一致状态。
  config.commit = function commit(patch) {
    return config.load().then(function (current) {
      var next = Object.assign({}, current, patch || {});
      var obj = {};
      obj[CONFIG_KEY] = next;
      obj[DRAFT_KEY] = null;
      return BS.api.storageSet(obj).then(function () { return next; });
    });
  };

  // 保留供内部/测试使用：不附带清草稿语义。
  config.save = function save(patch) {
    return config.commit(patch);
  };

  // 是否具备真正可同步的最小配置。用于决定是否允许建立闹钟或触发后台同步。
  config.isConfigured = function isConfigured(cfg) {
    var c = cfg || {};
    return !!(c.owner && c.repo && c.token);
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
      warnings.push('检测到 fine-grained PAT：需对目标仓库授予 Contents: Read and write，否则同步写入会返回 403。');
    } else if (!BS.util.isClassicToken(cfg.token)) {
      warnings.push('Token 格式未知；请使用 classic PAT（ghp_ 开头，repo scope）或 fine-grained PAT（Contents: Read and write）。');
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
