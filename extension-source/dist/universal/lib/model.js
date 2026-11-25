/*
 * 书签树模型。
 * 浏览器本地 ID 在各浏览器/配置间不一致，因此为节点分配稳定 UUID，
 * 并在扩展 storage 中维护 localId <-> uuid 双向映射。
 */
(function (global) {
  'use strict';
  var BS = global.BS = global.BS || {};
  var util = BS.util;

  var model = BS.model = {};

  // getTree() 在 Chrome/Firefox 都返回“一个虚拟根节点 + 若干真实根文件夹”。
  model.extractRoots = function extractRoots(tree) {
    if (!Array.isArray(tree) || tree.length === 0) return [];
    if (tree.length === 1 && tree[0] && Array.isArray(tree[0].children) && tree[0].children.length >= 2) {
      return tree[0].children;
    }
    return tree;
  };

  function ensureUuid(node, state) {
    var localId = node.id;
    if (state.idToUuid[localId]) return state.idToUuid[localId];
    var u = util.uuid();
    state.idToUuid[localId] = u;
    state.uuidToId[u] = localId;
    return u;
  }

  function normalizeNode(node, state) {
    var base = {
      uuid: ensureUuid(node, state),
      type: node.url ? 'url' : 'folder',
      title: node.title || ''
    };
    if (base.type === 'url') {
      base.url = node.url || '';
      return base;
    }
    base.children = (node.children || []).map(function (child) {
      return normalizeNode(child, state);
    });
    return base;
  }

  model.buildLocalTree = function buildLocalTree(state) {
    return BS.api.getTree().then(function (tree) {
      return model.extractRoots(tree).map(function (root) {
        return normalizeNode(root, state);
      });
    });
  };

  // 从远端 payload 中提取 tree，并做基本结构校验。
  model.parseRemotePayload = function parseRemotePayload(text) {
    var payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      var parseError = new Error('远端 JSON 解析失败：' + e.message);
      parseError.code = 'INVALID_FORMAT';
      throw parseError;
    }
    if (!payload || !Array.isArray(payload.tree)) {
      var formatError = new Error('远端文件缺少 tree 数组，可能是其他工具写入的内容');
      formatError.code = 'INVALID_FORMAT';
      throw formatError;
    }
    if (payload.schema && payload.schema > 1) {
      var versionError = new Error('远端文件版本（schema=' + payload.schema + '）高于当前扩展支持的版本');
      versionError.code = 'UNSUPPORTED_VERSION';
      throw versionError;
    }
    return payload;
  };

  // 校验树的 UUID 唯一性，避免映射污染。
  model.validateTree = function validateTree(nodes) {
    var seen = Object.create(null);
    var problems = [];
    function walk(list, path) {
      (list || []).forEach(function (n) {
        if (!n || typeof n !== 'object') { problems.push(path + ': 节点不是对象'); return; }
        if (!n.uuid) problems.push(path + ': 缺少 uuid');
        else if (seen[n.uuid]) problems.push(path + ': uuid 重复 ' + n.uuid);
        else seen[n.uuid] = true;
        if (n.type === 'folder') walk(n.children, path + '/' + (n.title || '?'));
        else if (n.type !== 'url') problems.push(path + ': 未知 type ' + n.type);
      });
    }
    walk(nodes, '');
    return problems;
  };
})(globalThis);
