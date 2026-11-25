/* 弹窗 UI：配置、测试连接、手动同步、状态展示、冲突处理、快照恢复。
 * 状态更新由后台 STATUS 消息驱动，不使用定时轮询，避免持续唤醒后台。 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var FIELDS = ['owner', 'repo', 'branch', 'path', 'autoSync', 'lowMemoryMode',
    'syncIntervalMinutes', 'conflictStrategy', 'backupCount'];
  var tokenEdited = false;
  var toastTimer = null;

  function send(message) {
    return new Promise(function (resolve) {
      try {
        global.BS.api.sendMessage(message).then(resolve).catch(function (e) {
          resolve({ ok: false, error: e && e.message ? e.message : String(e) });
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  function toast(text, kind) {
    var box = $('toast');
    if (!text) { box.className = 'toast hidden'; return; }
    box.textContent = text;
    box.className = 'toast' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast hidden'; }, 7000);
  }

  var STATUS_VIEW = {
    idle: ['○', 'idle', '尚未同步'],
    noop: ['✓', 'ok', '无变化'],
    pushed: ['✓', 'ok', '已推送本地变更'],
    pulled: ['✓', 'ok', '已拉取远端变更'],
    'conflict-local-kept': ['!', 'warn', '冲突：已备份远端，保留本地'],
    'conflict-remote-kept': ['!', 'warn', '冲突：已备份本地，采用远端'],
    dirty: ['•', 'dirty', '本地已变化，等待同步'],
    error: ['!', 'error', '同步失败']
  };

  function renderStatus(state) {
    var status = (state && state.lastStatus) || 'idle';
    var view = STATUS_VIEW[status] || [status.charAt(0).toUpperCase(), '', status];
    var card = $('statusCard');
    card.className = 'status-card ' + view[1];
    $('statusGlyph').textContent = view[0];
    $('statusTitle').textContent = view[2];
    $('statusDetail').textContent = (state && state.lastMessage) || '';
    $('statusMeta').textContent = state && state.lastSyncAt
      ? '最近同步：' + new Date(state.lastSyncAt).toLocaleString() : '';
    $('conflictBox').className = status.indexOf('conflict') === 0 ? 'notice' : 'notice hidden';
  }

  function renderBackups(list) {
    var box = $('backupList');
    if (!list || !list.length) {
      box.innerHTML = '<div class="empty">暂无本地快照（冲突或拉取前会自动生成）</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'backup-item';
      var meta = document.createElement('div');
      meta.className = 'backup-meta';
      var reason = document.createElement('div');
      reason.className = 'backup-reason';
      reason.textContent = (b.reason || 'snapshot') + (b.nodeCount ? ' · ' + b.nodeCount + ' 项' : '');
      var time = document.createElement('div');
      time.className = 'backup-time';
      time.textContent = new Date(b.at).toLocaleString();
      meta.appendChild(reason);
      meta.appendChild(time);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'backup-restore';
      btn.textContent = '恢复';
      btn.addEventListener('click', function () {
        send({ type: 'RESTORE_BACKUP', index: b.index }).then(function (res) {
          toast(res.ok ? res.message : ('恢复失败：' + res.error), res.ok ? 'ok' : 'error');
          refresh();
        });
      });
      row.appendChild(meta);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function fillForm(cfg) {
    FIELDS.forEach(function (key) {
      var el = $(key);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!cfg[key];
      else el.value = cfg[key] == null ? '' : String(cfg[key]);
    });
    $('token').value = cfg.token || ''; // 后台返回脱敏串；未编辑则不覆盖真实 token
    tokenEdited = false;
    $('btnToggleToken').textContent = '显示';
  }

  function collectForm() {
    var cfg = {};
    FIELDS.forEach(function (key) {
      var el = $(key);
      if (el.type === 'checkbox') cfg[key] = el.checked;
      else if (el.type === 'number') cfg[key] = Number(el.value);
      else cfg[key] = el.value.trim();
    });
    if (tokenEdited) cfg.token = $('token').value.trim();
    return cfg;
  }

  function withBusy(btn, fn) {
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '处理中…';
    function restore() { btn.disabled = false; btn.textContent = label; }
    try {
      return Promise.resolve(fn()).then(restore, function (e) {
        restore();
        toast('操作失败：' + (e && e.message ? e.message : e), 'error');
      });
    } catch (e) {
      restore();
      toast('操作失败：' + (e && e.message ? e.message : e), 'error');
      return Promise.resolve();
    }
  }

  function refresh() {
    return send({ type: 'GET_STATUS' }).then(function (res) {
      if (!res.ok) { toast(res.error, 'error'); return; }
      fillForm(res.config);
      renderStatus(res.state);
      renderBackups(res.backups);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    refresh(); // 只在打开时读取一次

    // 后台同步完成后主动推送状态；不再每 5 秒轮询。
    if (global.BS.api.events && global.BS.api.events.message) {
      global.BS.api.events.message.addListener(function (message) {
        if (message && message.type === 'STATUS') {
          renderStatus({
            lastStatus: message.status,
            lastMessage: message.message,
            lastSyncAt: message.at
          });
          refresh();
        }
      });
    }

    $('btnToggleToken').addEventListener('click', function () {
      var input = $('token');
      input.type = input.type === 'password' ? 'text' : 'password';
      this.textContent = input.type === 'password' ? '显示' : '隐藏';
    });
    $('token').addEventListener('input', function () { tokenEdited = true; });

    $('btnSave').addEventListener('click', function () {
      var btn = this;
      withBusy(btn, function () {
        return send({ type: 'SAVE_CONFIG', config: collectForm() }).then(function (res) {
          toast(res.ok ? '配置已保存' : ('保存失败：' + res.error), res.ok ? 'ok' : 'error');
          return refresh();
        });
      });
    });

    $('btnTest').addEventListener('click', function () {
      var btn = this;
      withBusy(btn, function () {
        return send({
          type: 'TEST_CONNECTION',
          config: collectForm(),
          useStoredToken: !tokenEdited
        }).then(function (res) {
          if (!res.ok) { toast('连接失败：' + res.error, 'error'); return; }
          var info = res.info || {};
          var text = '连接成功：' + (info.fullName || '') +
            '（' + (info.private ? 'Private' : 'Public') + '）· 写权限：' +
            ((info.permissions && info.permissions.push) ? '有' : '无') +
            ' · 同步文件：' + (res.fileExists ? '已存在' : '不存在');
          if (res.warnings && res.warnings.length) text += '\n提示：' + res.warnings.join('；');
          toast(text, 'ok');
        });
      });
    });

    $('btnSync').addEventListener('click', function () {
      var btn = this;
      withBusy(btn, function () {
        return send({ type: 'SYNC_NOW' }).then(function (res) {
          toast(res.ok ? (res.status + '：' + res.message) : ('同步失败：' + res.error),
            res.ok ? 'ok' : 'error');
          return refresh();
        });
      });
    });

    $('btnUseLocal').addEventListener('click', function () {
      var btn = this;
      withBusy(btn, function () {
        return send({ type: 'SET_CONFLICT', strategy: 'backup-then-local' }).then(function (res) {
          toast(res.ok ? res.message : res.error, res.ok ? 'ok' : 'error');
          return refresh();
        });
      });
    });

    $('btnUseRemote').addEventListener('click', function () {
      var btn = this;
      withBusy(btn, function () {
        return send({ type: 'SET_CONFLICT', strategy: 'prefer-remote' }).then(function (res) {
          toast(res.ok ? res.message : res.error, res.ok ? 'ok' : 'error');
          return refresh();
        });
      });
    });

    $('btnOpenBackups').addEventListener('click', function () {
      var owner = ($('owner').value || '').trim();
      var repo = ($('repo').value || '').trim();
      var branch = ($('branch').value || 'main').trim();
      if (!owner || !repo) { toast('请先填写仓库信息', 'error'); return; }
      global.open('https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) +
        '/tree/' + encodeURIComponent(branch) + '/backups', '_blank');
    });
  });
})(globalThis);
