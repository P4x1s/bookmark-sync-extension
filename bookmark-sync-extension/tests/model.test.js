/*
 * 纯逻辑测试（Node 22）：不依赖浏览器，验证工具函数、树模型与本地树调和算法。
 * 运行：node tests/model.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// 加载经典脚本（IIFE 挂到 globalThis.BS）
require(path.join(__dirname, '..', 'src', 'lib', 'util.js'));
require(path.join(__dirname, '..', 'src', 'lib', 'model.js'));

const BS = globalThis.BS;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { console.error('  FAIL', name, '\n', e.stack); process.exitCode = 1; }
}

console.log('util / model:');

test('UTF-8 Base64 往返（中文）', () => {
  const s = '收藏夹标题 / 中文测试 🚀';
  assert.equal(BS.util.base64ToUtf8(BS.util.utf8ToBase64(s)), s);
});

test('deepEqual 忽略键顺序', () => {
  assert.equal(BS.util.deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(BS.util.deepEqual([1, 2], [2, 1]), false);
});

test('extractRoots 兼容 Chrome 与 Firefox 形态', () => {
  const chromeTree = [{ id: '0', children: [{ id: '1' }, { id: '2' }, { id: '3' }] }];
  const firefoxTree = [{ id: 'root________', children: [{ id: 'toolbar_____' }, { id: 'unfiled_____' }] }];
  assert.deepEqual(BS.model.extractRoots(chromeTree).map(r => r.id), ['1', '2', '3']);
  assert.deepEqual(BS.model.extractRoots(firefoxTree).map(r => r.id), ['toolbar_____', 'unfiled_____']);
});

test('validateTree 检测重复 uuid 与非法 type', () => {
  const problems = BS.model.validateTree([
    { uuid: 'a', type: 'folder', title: 'x', children: [{ uuid: 'a', type: 'url', title: 'y', url: '' }] },
    { uuid: 'b', type: 'unknown', title: 'z' },
  ]);
  assert.ok(problems.some(p => p.includes('重复')));
  assert.ok(problems.some(p => p.includes('未知 type')));
});

// ---------------- 带内存书签存储的调和测试 ----------------
function createFakeStore() {
  const nodes = Object.create(null);
  const add = (id, title, parentId, url) => {
    nodes[id] = { id, title, parentId: parentId || null, url: url || null, children: [] };
    if (parentId) nodes[parentId].children.push(id);
    return nodes[id];
  };
  add('root', 'root', null);
  add('1', 'Bookmarks bar', 'root');
  add('2', 'Other bookmarks', 'root');
  add('3', 'Mobile bookmarks', 'root');
  add('b1', '旧标题', '1', 'https://old.example');

  let counter = 0;
  const resolve = id => {
    const n = nodes[id];
    return {
      id: n.id,
      title: n.title,
      url: n.url || undefined,
      children: n.children.map(resolve),
    };
  };

  return {
    nodes,
    api: {
      getTree: async () => [resolve('root')],
      getChildren: async id => nodes[id].children.map(cid => resolve(cid)),
      create: async d => {
        const id = 'new-' + (++counter);
        const node = { id, title: d.title, parentId: d.parentId, url: d.url || null, children: [] };
        nodes[id] = node;
        nodes[d.parentId].children.splice(d.index == null ? 0 : d.index, 0, id);
        return resolve(id);
      },
      update: async (id, changes) => {
        Object.assign(nodes[id], changes);
        return resolve(id);
      },
      move: async (id, parentId, index) => {
        const old = nodes[id].parentId;
        nodes[old].children = nodes[old].children.filter(x => x !== id);
        nodes[parentId].children.splice(index, 0, id);
        nodes[id].parentId = parentId;
        return resolve(id);
      },
      remove: async id => {
        const p = nodes[id].parentId;
        nodes[p].children = nodes[p].children.filter(x => x !== id);
        delete nodes[id];
      },
      removeTree: async function rm(id) {
        (nodes[id].children || []).slice().forEach(cid => rm(cid));
        const p = nodes[id].parentId;
        if (p) nodes[p].children = nodes[p].children.filter(x => x !== id);
        delete nodes[id];
      },
      storageGet: async () => ({}),
      storageSet: async () => undefined,
      sendMessage: async () => undefined,
    },
  };
}

(async () => {
  console.log('sync.applyTreeToLocal:');
  const store = createFakeStore();
  globalThis.BS.api = store.api;
  require(path.join(__dirname, '..', 'src', 'lib', 'sync.js'));

  const state = {
    idToUuid: { '1': 'u-bar', '2': 'u-other', '3': 'u-mobile', b1: 'u-b1' },
    uuidToId: { 'u-bar': '1', 'u-other': '2', 'u-mobile': '3', 'u-b1': 'b1' },
  };

  const desired = [
    {
      uuid: 'u-bar', type: 'folder', title: 'Bar-renamed',
      children: [
        { uuid: 'u-new', type: 'url', title: '新书签', url: 'https://new.example' },
        { uuid: 'u-b1', type: 'url', title: '改过的标题', url: 'https://changed.example' },
      ],
    },
    { uuid: 'u-other', type: 'folder', title: 'Other bookmarks', children: [] },
  ];

  try {
    const warnings = await BS.sync.applyTreeToLocal(desired, state);
    assert.deepEqual(warnings, []);
    assert.equal(store.nodes['1'].title, 'Bar-renamed');
    assert.deepEqual(store.nodes['1'].children, ['new-1', 'b1']);
    assert.equal(store.nodes['b1'].title, '改过的标题');
    assert.equal(store.nodes['b1'].url, 'https://changed.example');
    assert.equal(store.nodes['new-1'].url, 'https://new.example');
    assert.ok(state.uuidToId['u-new'] === 'new-1');
    passed++;
    console.log('  PASS 根目录重命名 / 新增 / 修改 / 排序 / 映射更新');
  } catch (e) {
    console.error('  FAIL 调和测试\n', e.stack);
    process.exitCode = 1;
  }

  console.log(`\n完成：${passed} 项通过`);
})();
