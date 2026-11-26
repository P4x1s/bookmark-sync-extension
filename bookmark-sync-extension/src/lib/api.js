/*
 * 跨浏览器 API 适配层。
 * 统一以 Promise 暴露 bookmarks / storage / alarms / runtime / action 接口。
 * Firefox 原生 browser.* 返回 Promise；Chromium 的 chrome.* 使用回调，这里统一包装。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};

  var hasBrowserNamespace = !!(global.browser && global.browser.runtime && global.browser.bookmarks);
  var browserStyle = hasBrowserNamespace; // Firefox：Promise 风格
  var ns = browserStyle ? global.browser : global.chrome;

  if (!ns) {
    throw new Error('未检测到 WebExtensions API 命名空间（chrome/browser）');
  }

  function invoke(scope, method, args) {
    var fn = scope && scope[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error('当前浏览器不支持 API: ' + method));
    }
    if (browserStyle) {
      try {
        return Promise.resolve(fn.apply(scope, args || []));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return new Promise(function (resolve, reject) {
      try {
        fn.apply(scope, (args || []).concat([function (result) {
          var lastError = null;
          try {
            lastError = global.chrome && global.chrome.runtime ? global.chrome.runtime.lastError : null;
          } catch (e) { /* ignore */ }
          if (lastError && lastError.message) {
            reject(new Error(lastError.message));
          } else {
            resolve(result);
          }
        }]));
      } catch (e) {
        reject(e);
      }
    });
  }

  function bm() { return ns.bookmarks; }
  function local() { return ns.storage && ns.storage.local; }

  BS.api = {
    browserStyle: browserStyle,
    namespace: ns,

    // ---- bookmarks ----
    getTree: function () { return invoke(bm(), 'getTree'); },
    getChildren: function (id) { return invoke(bm(), 'getChildren', [id]); },
    get: function (id) { return invoke(bm(), 'get', [id]); },
    create: function (details) { return invoke(bm(), 'create', [details]); },
    update: function (id, changes) { return invoke(bm(), 'update', [id, changes]); },
    move: function (id, parentId, index) {
      return invoke(bm(), 'move', [id, { parentId: parentId, index: index }]);
    },
    remove: function (id) { return invoke(bm(), 'remove', [id]); },
    removeTree: function (id) { return invoke(bm(), 'removeTree', [id]); },

    // ---- storage.local ----
    storageGet: function (keys) { return invoke(local(), 'get', [keys]); },
    storageSet: function (obj) { return invoke(local(), 'set', [obj]); },
    storageRemove: function (keys) { return invoke(local(), 'remove', [keys]); },

    // ---- alarms ----
    alarms: ns.alarms || null,
    createAlarm: function (name, info) {
      return invoke(ns.alarms, 'create', [name, info]);
    },
    clearAlarm: function (name) { return invoke(ns.alarms, 'clear', [name]); },

    // ---- runtime ----
    runtimeId: ns.runtime && ns.runtime.id ? ns.runtime.id : 'unknown',
    getManifest: function () { return ns.runtime && ns.runtime.getManifest ? ns.runtime.getManifest() : {}; },
    sendMessage: function (message) { return invoke(ns.runtime, 'sendMessage', [message]); },
    openOptionsPage: function () {
      if (ns.runtime && ns.runtime.openOptionsPage) return invoke(ns.runtime, 'openOptionsPage');
      return Promise.resolve();
    },

    // 徽章 API：Chrome MV3 为 action，Firefox MV2 为 browserAction。
    actionApi: ns.action || ns.browserAction || null,
    setBadge: function (text, color) {
      var action = ns.action || ns.browserAction;
      if (!action || !action.setBadgeText) return Promise.resolve();
      return invoke(action, 'setBadgeText', [text || ''])
        .then(function () {
          if (!color || !action.setBadgeBackgroundColor) return undefined;
          return invoke(action, 'setBadgeBackgroundColor', [{ color: color }]);
        })
        .catch(function () { /* 徽章失败不影响同步 */ });
    },

    // 事件对象直接暴露，避免包装导致 this 丢失。
    events: {
      bookmarkCreated: bm() && bm().onCreated,
      bookmarkRemoved: bm() && bm().onRemoved,
      bookmarkChanged: bm() && bm().onChanged,
      bookmarkMoved: bm() && bm().onMoved,
      alarm: ns.alarms && ns.alarms.onAlarm,
      message: ns.runtime && ns.runtime.onMessage,
      installed: ns.runtime && ns.runtime.onInstalled,
      startup: ns.runtime && ns.runtime.onStartup
    }
  };
})(globalThis);
