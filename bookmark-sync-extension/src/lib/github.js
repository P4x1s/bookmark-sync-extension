/*
 * GitHub Contents API 客户端。
 * 只使用 fetch，兼容 Chrome MV3 service worker 与 Firefox MV2 后台页。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};
  var util = BS.util;

  var API_ROOT = 'https://api.github.com';

  function GitHubClient(token, owner, repo, branch, path) {
    this.token = token || '';
    this.owner = owner || '';
    this.repo = repo || '';
    this.branch = branch || 'main';
    this.path = String(path || 'bookmarks.json').replace(/^\/+/, '');
  }

  GitHubClient.prototype._headers = function (extra) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + this.token,
      'X-GitHub-Api-Version': '2022-11-28',
      // 禁止中间层与浏览器缓存：Contents API 的 sha/content 必须每次都是最新值，
      // 否则本地删除会被过期缓存的远端内容重新拉回，并用陈旧 sha 触发 409。
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    }
    return headers;
  };

  GitHubClient.prototype._request = function (method, url, body) {
    var self = this;
    var init = {
      method: method,
      cache: 'no-store', // fetch 层再禁一次缓存，双重保险（GET 读取必须拿到真实 sha）。
      headers: self._headers(body ? { 'Content-Type': 'application/json' } : null)
    };
    if (body) init.body = JSON.stringify(body);

    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
        if (!res.ok) {
          var msg = (data && data.message) ? data.message : text.slice(0, 200);
          var hint = '';
          if (res.status === 403) hint = '；' + util.authHint(self.token, 403);
          else if (res.status === 401) hint = '；令牌无效或已过期，请重新生成后填入';
          var err = new Error('GitHub API ' + res.status + ': ' + msg + hint);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    }).catch(function (e) {
      if (e && typeof e.status === 'number') throw e;
      var netErr = new Error('无法连接 GitHub API：' + (e && e.message ? e.message : e));
      netErr.cause = e;
      throw netErr;
    });
  };

  GitHubClient.prototype._repoUrl = function () {
    return API_ROOT + '/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo);
  };

  GitHubClient.prototype._contentsUrl = function (path, ref) {
    var clean = String(path || this.path).replace(/^\/+/, '');
    var url = this._repoUrl() + '/contents/' + clean.split('/').map(encodeURIComponent).join('/');
    url += '?ref=' + encodeURIComponent(ref || this.branch);
    return url;
  };

  // 验证仓库存在、私有性与当前 token 的写权限。404 同时覆盖“不存在”和“无权访问私有仓库”。
  GitHubClient.prototype.checkAccess = function () {
    var self = this;
    return this._request('GET', this._repoUrl()).then(function (data) {
      return {
        private: !!data.private,
        defaultBranch: data.default_branch,
        permissions: data.permissions || {},
        fullName: data.full_name,
        tokenKind: util.tokenKind(self.token)
      };
    });
  };

  GitHubClient.prototype.readFile = function (path) {
    var self = this;
    return this._request('GET', this._contentsUrl(path)).then(function (data) {
      if (Array.isArray(data)) {
        throw new Error('同步路径指向目录而不是文件：' + self.path);
      }
      if (typeof data.content !== 'string') {
        throw new Error('GitHub 响应缺少 content 字段');
      }
      return {
        sha: data.sha,
        content: util.base64ToUtf8(data.content),
        htmlUrl: data.html_url
      };
    });
  };

  GitHubClient.prototype.writeFile = function (content, sha, message, path) {
    var targetPath = String(path || this.path).replace(/^\/+/, '');
    var body = {
      message: message || 'chore(bookmarks): sync',
      content: util.utf8ToBase64(content),
      branch: this.branch
    };
    if (sha) body.sha = sha; // 有 sha 才是更新，否则是新建；这是避免误覆盖的关键。
    var url = API_ROOT + '/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo) +
      '/contents/' + targetPath.split('/').map(encodeURIComponent).join('/');
    return this._request('PUT', url, body);
  };

  BS.GitHubClient = GitHubClient;
})(globalThis);
