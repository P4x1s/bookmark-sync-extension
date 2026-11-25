/*
 * 同步引擎（低内存版）：
 * - 三方比较：base（上次同步快照）/ local（当前浏览器）/ remote（GitHub 文件）
 * - 增量：本地全量重读但只在有差异时写；远端用 SHA 参与提交，避免无条件覆盖
 * - 内存：常规状态只保存必要字段；完整备份快照存独立 key，按需读取；避免多余深拷贝
 * - 安全：覆盖远端或改写本地前留备份；远端已有非本插件格式文件时先备份原内容
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};
  var util = BS.util;

  var STATE_KEY = 'bookmarkSync.state';
  var BACKUP_KEY = 'bookmarkSync.backups';
  var sync = BS.sync = {};

  sync.STATE_KEY = STATE_KEY;
  sync.BACKUP_KEY = BACKUP_KEY;
  sync.applying = false; // applyTreeToLocal 期间忽略本地变更事件，防止回环触发。

  // 常规状态轻量：不再内嵌完整备份树（旧版最多 5 份树常驻，是内存主要来源）。
  sync.loadState = function loadState() {
    return BS.api.storageGet([STATE_KEY]).then(function (data) {
      var s = (data && data[STATE_KEY]) || {};
      return {
        baseTree: Array.isArray(s.baseTree) ? s.baseTree : [],
        remoteSha: s.remoteSha || null,
        lastSyncAt: s.lastSyncAt || null,
        lastStatus: s.lastStatus || 'idle',
        lastMessage: s.lastMessage || '',
        idToUuid: s.idToUuid || {},
        uuidToId: s.uuidToId || {},
        remoteBackupPath: s.remoteBackupPath || '',
        deviceId: s.deviceId || ''
      };
    });
  };

  sync.saveState = function saveState(state) {
    var obj = {};
    obj[STATE_KEY] = state;
    return BS.api.storageSet(obj);
  };

  // 弹窗只取元信息，完整树不会被读入内存或跨消息传递。
  sync.loadBackupMeta = function loadBackupMeta() {
    return BS.api.storageGet([BACKUP_KEY]).then(function (data) {
      var list = (data && data[BACKUP_KEY]) || [];
      return list.map(function (b, i) {
        return { index: i, at: b.at, reason: b.reason, nodeCount: b.nodeCount || 0 };
      });
    });
  };

  function countNodes(tree) {
    var n = 0;
    function walk(list) {
      (list || []).forEach(function (node) {
        n++;
        if (node && node.children) walk(node.children);
      });
    }
    walk(tree);
    return n;
  }

  // 备份写入独立 key，避免污染常规 state；keep 由低内存模式决定。
  function localBackup(tree, reason, keep) {
    return BS.api.storageGet([BACKUP_KEY]).then(function (data) {
      var list = (data && data[BACKUP_KEY]) || [];
      list.unshift({
        at: new Date().toISOString(),
        reason: reason,
        nodeCount: countNodes(tree),
        tree: tree
      });
      return list.slice(0, Math.max(1, keep || 1));
    }).then(function (list) {
      var obj = {};
      obj[BACKUP_KEY] = list;
      return BS.api.storageSet(obj);
    });
  }

  function backupPath(label) {
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    return 'backups/bookmarks-' + ts + '-' + label + '.json';
  }

  function remoteBackup(client, tree, label) {
    var path = backupPath(label);
    var content = JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), label: label, tree: tree });
    return client.writeFile(content, null, 'backup: ' + label, path).then(function () {
      return path;
    });
  }

  // 备份仓库中已有的非本插件文件原始内容，确保“现有东西不删除”。
  function remoteBackupRaw(client, rawContent, label) {
    var path = 'backups/initial-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + label + '.json';
    return client.writeFile(rawContent, null, 'backup: existing file before first sync', path).then(function () {
      return path;
    });
  }

  function safeUpdate(id, changes) {
    return BS.api.update(id, changes).catch(function (e) {
      return '更新失败(' + id + '): ' + e.message;
    });
  }

  function safeMove(id, parentId, index) {
    return BS.api.move(id, parentId, index).catch(function (e) {
      return '移动失败(' + id + '): ' + e.message;
    });
  }

  // 让本地书签结构与 desiredTree 一致。只做必要操作，不做全量删除重建。
  function syncChildren(desired, parentLocalId, state, warnings) {
    var working = null;
    return BS.api.getChildren(parentLocalId).then(function (children) {
      working = children.slice();

      function step(i) {
        if (i >= desired.length) {
          var desiredUuids = Object.create(null);
          desired.forEach(function (n) { if (n && n.uuid) desiredUuids[n.uuid] = true; });
          var extras = working.filter(function (w) {
            return !desiredUuids[state.idToUuid[w.id]];
          });
          var chain = Promise.resolve();
          extras.forEach(function (ex) {
            chain = chain.then(function () {
              var removePromise = ex.url ? BS.api.remove(ex.id) : BS.api.removeTree(ex.id);
              return removePromise.then(function () {
                var u = state.idToUuid[ex.id];
                if (u) delete state.uuidToId[u];
                delete state.idToUuid[ex.id];
                working = working.filter(function (w) { return w.id !== ex.id; });
              }).catch(function (e) {
                warnings.push('删除失败(' + ex.id + '): ' + e.message);
              });
            });
          });
          return chain;
        }

        var node = desired[i];
        if (!node || !node.uuid) {
          warnings.push('跳过非法节点（第 ' + (i + 1) + ' 项）');
          return step(i + 1);
        }

        var mappedId = state.uuidToId[node.uuid];
        var idx = mappedId ? working.findIndex(function (w) { return w.id === mappedId; }) : -1;
        if (idx >= 0 && !!working[idx].url !== (node.type === 'url')) idx = -1;

        if (idx >= 0) {
          var id = mappedId;
          var current = working[idx];
          var needUpdate = (current.title || '') !== (node.title || '') ||
            (node.type === 'url' && (current.url || '') !== (node.url || ''));
          var chainUpdate = Promise.resolve();
          if (needUpdate) {
            chainUpdate = safeUpdate(id, node.type === 'folder'
              ? { title: node.title || '' }
              : { title: node.title || '', url: node.url || '' }).then(function (r) {
                if (typeof r === 'string') warnings.push(r);
                else working[idx] = { id: id, title: node.title || '', url: node.url || '', children: current.children };
              });
          }
          return chainUpdate.then(function () {
            var nowIdx = working.findIndex(function (w) { return w.id === id; });
            if (nowIdx !== i) {
              return safeMove(id, parentLocalId, i).then(function (r) {
                if (typeof r === 'string') warnings.push(r);
                else {
                  var item = working.splice(nowIdx, 1)[0];
                  working.splice(i, 0, item);
                }
              });
            }
            return undefined;
          }).then(function () {
            return node.type === 'folder' && node.children
              ? syncChildren(node.children, id, state, warnings)
              : undefined;
          }).then(function () { return step(i + 1); });
        }

        var details = { parentId: parentLocalId, index: i, title: node.title || '' };
        if (node.type === 'url') details.url = node.url || '';
        return BS.api.create(details).then(function (created) {
          if (!created || !created.id) throw new Error('创建书签未返回 id');
          state.idToUuid[created.id] = node.uuid;
          state.uuidToId[node.uuid] = created.id;
          working.splice(i, 0, created);
          return node.type === 'folder' && node.children && node.children.length
            ? syncChildren(node.children, created.id, state, warnings)
            : undefined;
        }).then(function () { return step(i + 1); });
      }

      return step(0);
    });
  }

  sync.applyTreeToLocal = function applyTreeToLocal(desiredRoots, state) {
    sync.applying = true;
    var warnings = [];
    return BS.api.getTree().then(function (tree) {
      var actualRoots = BS.model.extractRoots(tree);
      var used = Object.create(null);
      var chain = Promise.resolve();

      desiredRoots.filter(function (r) { return r && r.type === 'folder'; }).forEach(function (desired) {
        chain = chain.then(function () {
          var match = actualRoots.find(function (r) {
            return !used[r.id] && state.uuidToId[desired.uuid] === r.id;
          });
          if (!match) {
            match = actualRoots.find(function (r) {
              return !used[r.id] && (r.title || '') === (desired.title || '');
            });
          }
          if (!match) match = actualRoots.find(function (r) { return !used[r.id]; });
          if (!match) {
            warnings.push('无法匹配根目录「' + (desired.title || '') + '」，已跳过');
            return undefined;
          }
          used[match.id] = true;
          if (!state.idToUuid[match.id]) {
            state.idToUuid[match.id] = desired.uuid;
            state.uuidToId[desired.uuid] = match.id;
          }
          var updateChain = Promise.resolve();
          if ((match.title || '') !== (desired.title || '')) {
            updateChain = safeUpdate(match.id, { title: desired.title || '' }).then(function (r) {
              if (typeof r === 'string') warnings.push(r);
            });
          }
          return updateChain.then(function () {
            return syncChildren(desired.children || [], match.id, state, warnings);
          });
        });
      });
      return chain;
    }).catch(function (e) {
      warnings.push('应用远端树失败：' + e.message);
      throw e;
    }).then(function () {
      sync.applying = false;
      return warnings;
    }, function (e) {
      sync.applying = false;
      throw e;
    });
  };

  function finish(state, status, message, warnings) {
    state.lastSyncAt = new Date().toISOString();
    state.lastStatus = status;
    state.lastMessage = message + (warnings && warnings.length ? '（提示：' + warnings.slice(0, 3).join('；') + '）' : '');
    return sync.saveState(state).then(function () {
      BS.api.sendMessage({
        type: 'STATUS',
        status: status,
        message: state.lastMessage,
        at: state.lastSyncAt,
        remoteBackupPath: state.remoteBackupPath
      }).catch(function () { /* 弹窗未打开时忽略 */ });
      return {
        ok: true,
        status: status,
        message: state.lastMessage,
        at: state.lastSyncAt,
        warnings: warnings || []
      };
    });
  }

  sync.runSync = function runSync() {
    var cfg = null;
    var state = null;
    var client = null;
    var localTree = null;
    var remoteFile = null;
    var remoteTree = null;
    var remoteIncompatible = false;
    var warnings = [];
    var keep = 1;

    return BS.config.load().then(function (loadedCfg) {
      cfg = loadedCfg;
      var check = BS.config.validate(cfg);
      if (!check.valid) throw new Error('配置无效：' + check.errors.join('；'));
      keep = cfg.lowMemoryMode ? 1 : Math.max(1, Number(cfg.backupCount) || 3);
      return sync.loadState();
    }).then(function (loadedState) {
      state = loadedState;
      if (!state.deviceId) state.deviceId = util.uuid();
      client = new BS.GitHubClient(cfg.token, cfg.owner, cfg.repo, cfg.branch, cfg.path);
      return BS.model.buildLocalTree(state);
    }).then(function (tree) {
      localTree = tree;
      var problems = BS.model.validateTree(localTree);
      if (problems.length) warnings = warnings.concat(problems);
      return client.readFile();
    }).then(function (file) {
      remoteFile = file;
      try {
        var payload = BS.model.parseRemotePayload(file.content);
        remoteTree = payload.tree;
        var problems = BS.model.validateTree(remoteTree);
        if (problems.length) warnings = warnings.concat(problems);
      } catch (e) {
        if (e && e.code === 'INVALID_FORMAT') {
          remoteIncompatible = true;
          warnings.push('远端同步文件不是本插件格式，原内容将先备份');
        } else {
          throw e;
        }
      }
    }).catch(function (e) {
      if (e && e.status === 404) {
        remoteFile = null;
        remoteTree = null;
        return undefined;
      }
      throw e;
    }).then(function () {
      function pushLocal(status, message) {
        // 无缩进序列化：减少大书签库的字符串与内存占用；备份文件仍保留可读性。
        var content = JSON.stringify({
          schema: 1,
          updatedAt: new Date().toISOString(),
          deviceId: state.deviceId,
          tree: localTree
        });
        var sha = remoteFile ? remoteFile.sha : null;
        return client.writeFile(content, sha, 'sync bookmarks from ' + state.deviceId, cfg.path).then(function (res) {
          state.baseTree = localTree; // 直接复用引用，不再深拷贝整棵树
          state.remoteSha = (res && res.content && res.content.sha) ? res.content.sha : sha;
          localTree = null;
          remoteTree = null;
          return finish(state, status, message, warnings);
        });
      }

      function pullRemote(status, message, backupReason, skipBackup) {
        var backupChain = skipBackup ? Promise.resolve() : localBackup(localTree, backupReason, keep);
        return backupChain.then(function () {
          return sync.applyTreeToLocal(remoteTree, state);
        }).then(function (w) {
          warnings = warnings.concat(w || []);
          return BS.model.buildLocalTree(state);
        }).then(function (actualTree) {
          state.baseTree = actualTree;
          state.remoteSha = remoteFile ? remoteFile.sha : null;
          localTree = null;
          remoteTree = null;
          return finish(state, status, message, warnings);
        });
      }

      // 仓库中已有同名文件但不是本插件格式：先原样备份，再写入，绝不删除现有内容。
      if (remoteIncompatible && remoteFile) {
        return remoteBackupRaw(client, remoteFile.content, 'existing-file').then(function (path) {
          state.remoteBackupPath = path;
          return pushLocal('pushed', '仓库原有文件已备份到 ' + path + '，随后写入同步文件');
        });
      }

      var firstSync = !state.lastSyncAt && state.baseTree.length === 0;
      var localChanged = !util.deepEqual(state.baseTree, localTree);
      var remoteChanged = remoteFile
        ? !util.deepEqual(state.baseTree, remoteTree)
        : (!firstSync && state.baseTree.length > 0);

      if (!localChanged && !remoteChanged) {
        localTree = null;
        remoteTree = null;
        return finish(state, 'noop', '本地与远端均无变化，无需写入', warnings);
      }

      // 首次同步且远端已有本插件格式书签：绝不直接覆盖。
      // 先留本地快照，再采用远端；远端为空树时没有数据需要保护，仍按本地增量推送。
      if (firstSync && remoteFile && remoteTree && remoteTree.length > 0) {
        return pullRemote('pulled', '首次同步：远端已有书签，已备份本地并采用远端', 'first-pull');
      }

      if (localChanged && remoteChanged && !firstSync) {
        if (cfg.conflictStrategy === 'prefer-remote') {
          return localBackup(localTree, 'conflict-before-remote', keep).then(function () {
            return remoteBackup(client, localTree, 'conflict-local');
          }).then(function (path) {
            state.remoteBackupPath = path;
            return pullRemote('conflict-remote-kept',
              '检测到双向冲突：已备份本地并采用远端，备份 ' + path, 'conflict-before-remote', true);
          });
        }
        return localBackup(remoteTree, 'conflict-remote-snapshot', keep).then(function () {
          return remoteBackup(client, remoteTree, 'conflict-remote');
        }).then(function (path) {
          state.remoteBackupPath = path;
          return pushLocal('conflict-local-kept', '检测到双向冲突：已备份远端并保留本地，备份 ' + path);
        });
      }

      if (localChanged) {
        return pushLocal('pushed', '已将本地变更推送到 GitHub');
      }

      if (remoteFile) {
        return pullRemote('pulled',
          firstSync ? '首次同步：已采用远端书签（本地已留快照）' : '已拉取远端变更到本地',
          firstSync ? 'first-pull' : 'remote-change');
      }

      localTree = null;
      return finish(state, 'noop', '远端文件不存在且本地无变更', warnings);
    }).catch(function (e) {
      if (state) {
        state.lastStatus = 'error';
        state.lastMessage = '同步失败：' + (e && e.message ? e.message : e);
        state.lastSyncAt = new Date().toISOString();
        return sync.saveState(state).then(function () {
          BS.api.sendMessage({ type: 'STATUS', status: 'error', message: state.lastMessage, at: state.lastSyncAt })
            .catch(function () { /* ignore */ });
          return { ok: false, error: state.lastMessage, status: 'error' };
        });
      }
      return { ok: false, error: e && e.message ? e.message : String(e), status: 'error' };
    });
  };

  // 从独立备份 key 按需读取完整树并恢复；恢复后推送，避免被下一次同步反向覆盖。
  sync.restoreBackup = function restoreBackup(index) {
    var cfg = null;
    var state = null;
    var backup = null;
    var client = null;
    var warnings = [];
    var currentLocal = null;
    var idx = Number(index);

    return Promise.resolve().then(function () {
      if (!Number.isInteger(idx) || idx < 0) throw new Error('备份序号无效：' + index);
      return BS.config.load();
    }).then(function (loadedCfg) {
      cfg = loadedCfg;
      // 恢复是写操作，同样要求配置有效，防止被篡改的配置把数据写到错误位置。
      var check = BS.config.validate(cfg);
      if (!check.valid) throw new Error('配置无效：' + check.errors.join('；'));
      return BS.api.storageGet([BACKUP_KEY]);
    }).then(function (data) {
      var list = (data && data[BACKUP_KEY]) || [];
      backup = list[idx];
      if (!backup || !Array.isArray(backup.tree)) throw new Error('备份不存在或格式无效');
      return sync.loadState();
    }).then(function (s) {
      state = s;
      client = new BS.GitHubClient(cfg.token, cfg.owner, cfg.repo, cfg.branch, cfg.path);
      return BS.model.buildLocalTree(state);
    }).then(function (tree) {
      currentLocal = tree;
      return sync.applyTreeToLocal(backup.tree, state);
    }).then(function (w) {
      warnings = warnings.concat(w || []);
      return BS.model.buildLocalTree(state);
    }).then(function (appliedTree) {
      return client.readFile().catch(function (e) {
        if (e && e.status === 404) return null;
        throw e;
      }).then(function (file) {
        var snapshot = file ? BS.model.parseRemotePayload(file.content).tree : currentLocal;
        return remoteBackup(client, snapshot, 'before-restore').then(function (path) {
          state.remoteBackupPath = path;
          var content = JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), deviceId: state.deviceId, tree: appliedTree });
          return client.writeFile(content, file ? file.sha : null, 'restore from local backup', cfg.path).then(function (res) {
            state.baseTree = appliedTree;
            state.remoteSha = (res && res.content && res.content.sha) ? res.content.sha : (file ? file.sha : null);
            return finish(state, 'pushed', '已从本地备份恢复并推送到远端，覆盖前备份：' + path, warnings);
          });
        });
      });
    });
  };
})(globalThis);
