/*
 * 通用工具：UUID、UTF-8/Base64、深比较、防抖、克隆。
 * 经典脚本（非 ES Module），挂载到 globalThis.BS.util。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};
  var util = BS.util = {};

  util.uuid = function uuid() {
    var cryptoObj = global.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    // 理论上扩展环境不会走到这里；仅作兜底，避免完全不可用。
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  // GitHub Contents API 需要标准 Base64，且必须按 UTF-8 编码（中文标题不能乱码）。
  util.utf8ToBase64 = function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str == null ? '' : String(str));
    var binary = '';
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  };

  util.base64ToUtf8 = function base64ToUtf8(b64) {
    var binary = atob(String(b64 || '').replace(/\s/g, ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  };

  util.deepEqual = function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      var k = ka[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  };

  util.clone = function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  };

  // wait 支持函数形式，便于后台按最新配置动态取去抖时长。
  util.debounce = function debounce(fn, wait) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      if (timer) clearTimeout(timer);
      var ms = typeof wait === 'function' ? wait() : wait;
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, ms);
    };
  };

  util.maskToken = function maskToken(token) {
    if (!token) return '';
    if (token.length <= 8) return token.slice(0, 2) + '****';
    return token.slice(0, 4) + '****' + token.slice(-4);
  };

  util.tokenKind = function tokenKind(token) {
    var t = String(token || '');
    if (/^github_pat_/.test(t)) return 'fine-grained';
    if (/^(ghp_|gho_)/.test(t)) return 'classic';
    return 'unknown';
  };

  util.isClassicToken = function isClassicToken(token) {
    return util.tokenKind(token) === 'classic';
  };

  util.isFineGrainedToken = function isFineGrainedToken(token) {
    return util.tokenKind(token) === 'fine-grained';
  };

  // 403 的可操作指引。区分令牌类型，避免只报原始英文错误。
  util.authHint = function authHint(token, status) {
    if (Number(status) !== 403) return '';
    var kind = util.tokenKind(token);
    if (kind === 'fine-grained') {
      return 'fine-grained PAT 需在令牌设置中把 Repository access 勾选此私有仓库，并将 Repository permissions → Contents 设为 Read and write（仅 Read 会在写入时返回 403）；若仓库属于启用 SSO 的组织，还需在令牌页面授权 SSO';
    }
    if (kind === 'classic') {
      return 'classic PAT 需勾选完整 repo scope（仅 public_repo 无法读写私有仓库）；若仓库属于启用 SSO 的组织，还需在令牌页面点击 Authorize SSO';
    }
    return '请确认令牌已授予此私有仓库的读写权限，或改用 classic PAT（勾选 repo scope）';
  };
})(globalThis);
