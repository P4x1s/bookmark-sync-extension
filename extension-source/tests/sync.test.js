/*
 * 同步引擎集成测试（Node 22）：用内存书签存储 + 模拟 GitHub Contents API。
 * 覆盖：首次推送、无变化、本地增量推送、远端拉取、冲突备份与策略。
 * 运行：node tests/sync.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'src', 'lib', 'util.js'));
const BS = globalThis.BS;

function jsonRes(status, data) {
  return { ok: status >= 200 && status < 400, status, text: async () => JSON.stringify(data) };
}

function createEnv() {
  const storage = Object.create(null);
  const nodes = Object.create(null);
  let counter = 0;
  let remote = null;
  let shaCounter = 0;
  const backups = [];

  const add = (id, title, parentId, url) => {
    nodes[id] = { id, title, parentId: parentId || null, url: url || null, children: [] };
    if (parentId) nodes[parentId].children.push(id);
    return nodes[id];
  };
  add('root', 'root', null);
  add('1', 'Bookmarks bar', 'root');
  add('2', 'Other bookmarks', 'root');
  add('3', 'Mobile bookmarks', 'root');

  const resolve = id => ({
    id,
    title: nodes[id].title,
    url: nodes[id].url || undefined,
    children: nodes[id].children.map(resolve),
  });

  const api = {
    getTree: async () => [resolve('root')],
    getChildren: async id => nodes[id].children.map(cid => resolve(cid)),
    create: async d => {
      const id = 'n' + (++counter);
      nodes[id] = { id, title: d.title, parentId: d.parentId, url: d.url || null, children: [] };
      nodes[d.parentId].children.splice(d.index == null ? 0 : d.index, 0, id);
      return resolve(id);
    },
    update: async (id, changes) => { Object.assign(nodes[id], changes); return resolve(id); },
    move: async (id, parentId, index) => {
      const old = nodes[id].parentId;
      nodes[old].children = nodes[old].children.filter(x => x !== id);
      nodes[parentId].children.splice(index, 0, id);
      nodes[id].parentId = parentId;
      return resolve(id);
    },
    remove: async id => {
      nodes[nodes[id].parentId].children = nodes[nodes[id].parentId].children.filter(x => x !== id);
      delete nodes[id];
    },
    removeTree: async function rm(id) {
      nodes[id].children.slice().forEach(rm);
      const p = nodes[id].parentId;
      if (p) nodes[p].children = nodes[p].children.filter(x => x !== id);
      delete nodes[id];
    },
    storageGet: async keys => {
      const out = Object.create(null);
      (keys || []).forEach(k => { if (storage[k] !== undefined) out[k] = storage[k]; });
      return out;
    },
    storageSet: async obj => { Object.assign(storage, obj); },
    sendMessage: async () => undefined,
  };

  globalThis.BS.api = api;

  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const isContents = parts.includes('contents');
    if (!isContents) {
      return jsonRes(200, {
        private: true,
        default_branch: 'main',
        permissions: { push: true },
        full_name: 'owner/repo',
      });
    }
    const filePath = parts.slice(parts.indexOf('contents') + 1).join('/');
    if (init.method === 'GET') {
      if (!remote || filePath !== 'bookmarks.json') return jsonRes(404, { message: 'Not Found' });
      return jsonRes(200, { sha: remote.sha, content: Buffer.from(remote.content, 'utf8').toString('base64') });
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (filePath.startsWith('backups/')) {
        backups.push({ path: filePath, body });
        return jsonRes(201, { content: { sha: 'backup-' + (++shaCounter) } });
      }
      if (remote && body.sha !== remote.sha) return jsonRes(409, { message: 'sha mismatch' });
      remote = {
        sha: 'sha-' + (++shaCounter),
        content: Buffer.from(body.content, 'base64').toString('utf8'),
      };
      return jsonRes(200, { content: { sha: remote.sha } });
    }
    return jsonRes(405, { message: 'method not allowed' });
  };

  return {
    api,
    storage,
    nodes,
    get remote() { return remote; },
    setRemoteTree(tree) {
      remote = {
        sha: 'sha-' + (++shaCounter),
        content: JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), tree }),
      };
    },
    setRemoteRaw(content) {
      remote = { sha: 'sha-' + (++shaCounter), content };
    },
    backups,
    addBookmark(parentId, title, url) { return add('local-' + (++counter), title, parentId, url); },
  };
}

// 加载依赖模块（在设置 BS.api 之后加载不影响，因为模块在调用时才读取 api）
require(path.join(__dirname, '..', 'src', 'lib', 'config.js'));
require(path.join(__dirname, '..', 'src', 'lib', 'github.js'));
require(path.join(__dirname, '..', 'src', 'lib', 'model.js'));
require(path.join(__dirname, '..', 'src', 'lib', 'sync.js'));

async function main() {
  let passed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log('  PASS', name); }
    catch (e) { console.error('  FAIL', name, '\n', e.stack); process.exitCode = 1; }
  }

  console.log('sync.runSync (mocked GitHub):');
  const env = createEnv();
  await BS.config.save({
    owner: 'owner', repo: 'repo', branch: 'main', path: 'bookmarks.json',
    token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
    conflictStrategy: 'backup-then-local',
  });

  await test('首次同步创建远端文件', async () => {
    env.addBookmark('1', '首页', 'https://example.com');
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'pushed');
    assert.ok(env.remote, '远端文件应被创建');
    const tree = JSON.parse(env.remote.content).tree;
    assert.equal(tree.length, 3);
    assert.equal(tree[0].children[0].title, '首页');
  });

  await test('无变化时不写入', async () => {
    const shaBefore = env.remote.sha;
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'noop');
    assert.equal(env.remote.sha, shaBefore);
  });

  await test('本地新增 => 增量推送且保留 sha 语义', async () => {
    env.addBookmark('2', '其他站点', 'https://other.example');
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'pushed');
    const tree = JSON.parse(env.remote.content).tree;
    assert.ok(tree[1].children.some(n => n.title === '其他站点'));
  });

  await test('远端变更 => 拉取到本地', async () => {
    const tree = JSON.parse(env.remote.content).tree;
    tree[0].children.push({
      uuid: 'remote-added', type: 'url', title: '来自远端', url: 'https://remote.example',
    });
    env.setRemoteTree(tree);
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'pulled');
    assert.ok(Object.values(env.nodes).some(n => n.title === '来自远端'));
  });

  await test('双向冲突 => 备份远端并保留本地', async () => {
    env.addBookmark('1', '本地冲突项', 'https://local-conflict.example');
    const tree = JSON.parse(env.remote.content).tree;
    tree[0].children.push({
      uuid: 'remote-conflict', type: 'url', title: '远端冲突项', url: 'https://remote-conflict.example',
    });
    env.setRemoteTree(tree);
    const backupsBefore = env.backups.length;
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'conflict-local-kept');
    assert.ok(env.backups.length > backupsBefore, '应生成远端备份');
    const pushed = JSON.parse(env.remote.content).tree;
    assert.ok(pushed[0].children.some(n => n.title === '本地冲突项'));
  });

  await test('常规状态不内嵌备份树，备份元信息单独读取', async () => {
    const state = await BS.sync.loadState();
    assert.equal(state.localBackups, undefined, 'state 不应含 localBackups');
    const meta = await BS.sync.loadBackupMeta();
    assert.ok(Array.isArray(meta));
    assert.ok(meta.every(b => b.tree === undefined), '元信息不应包含完整树');
  });

  await test('低内存模式只保留 1 份本地快照', async () => {
    const list = env.storage['bookmarkSync.backups'] || [];
    assert.equal(list.length, 1, '低内存模式应只保留 1 份快照');
  });

  await test('默认仓库为空、由使用者填写且低内存开启', async () => {
    assert.equal(BS.config.DEFAULT_CONFIG.owner, '');
    assert.equal(BS.config.DEFAULT_CONFIG.repo, '');
    assert.equal(BS.config.DEFAULT_CONFIG.lowMemoryMode, true);
  });

  await test('远端已有非本格式文件 => 原内容先备份再写入', async () => {
    const e2 = createEnv();
    await BS.config.save({
      owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
      token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
      conflictStrategy: 'backup-then-local', lowMemoryMode: true, backupCount: 1,
    });
    const original = '仓库原有内容：请勿删除';
    e2.setRemoteRaw(original);
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'pushed');
    const initial = e2.backups.find(b => b.path.indexOf('initial-') >= 0);
    assert.ok(initial, '应生成 initial 备份');
    assert.equal(initial.body.content, Buffer.from(original, 'utf8').toString('base64'));
    assert.ok(Array.isArray(JSON.parse(e2.remote.content).tree), '同步文件应写入本插件格式');
    globalThis.BS.api = env.api;
  });

  await test('首次同步远端无文件且本地为空仍创建 bookmarks.json', async () => {
    const e3 = createEnv();
    await BS.config.save({
      owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
      token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
      conflictStrategy: 'backup-then-local', lowMemoryMode: true, backupCount: 1,
    });
    const r = await BS.sync.runSync();
    assert.equal(r.status, 'pushed');
    assert.ok(e3.remote, '远端文件必须被创建');
    const payload = JSON.parse(e3.remote.content);
    assert.equal(payload.tree.length, 3, '应完整写入浏览器的三个根文件夹');
    assert.deepEqual(payload.tree.map(n => n.title), ['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks']);
    assert.ok(payload.tree.every(n => n.type === 'folder' && Array.isArray(n.children)));
    assert.match(r.message, /创建 bookmarks\.json/);
  });

  await test('同步进度按阶段上报到 100% 完成', async () => {
    const e4 = createEnv();
    await BS.config.save({
      owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
      token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
      conflictStrategy: 'backup-then-local', lowMemoryMode: true, backupCount: 1,
    });
    e4.addBookmark('1', '进度测试书签', 'https://progress.example');
    const events = [];
    BS.sync.setProgressHandler(p => { events.push(p); return Promise.resolve(); });
    const r = await BS.sync.runSync();
    BS.sync.setProgressHandler(null);
    assert.equal(r.ok, true);
    assert.ok(events.some(p => p.percent === 5 && p.phase === 'config'));
    assert.ok(events.some(p => p.percent === 30 && p.phase === 'remote'));
    assert.ok(events.some(p => p.percent === 80 && p.phase === 'write'));
    assert.ok(events.some(p => p.percent === 100 && p.state === 'success'));
    const percents = events.map(p => p.percent);
    assert.deepEqual(percents, percents.slice().sort((a, b) => a - b), '进度百分比不得回退');
  });

  await test('同步失败上报失败终态进度', async () => {
    const e5 = createEnv();
    await BS.config.save({
      owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
      token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
      conflictStrategy: 'backup-then-local', lowMemoryMode: true, backupCount: 1,
    });
    const events = [];
    BS.sync.setProgressHandler(p => { events.push(p); return Promise.resolve(); });
    globalThis.fetch = async () => { throw new Error('offline'); };
    const r = await BS.sync.runSync();
    BS.sync.setProgressHandler(null);
    assert.equal(r.ok, false);
    const last = events[events.length - 1];
    assert.equal(last.percent, 100);
    assert.equal(last.state, 'failed');
    assert.match(last.detail, /offline/);
  });

  console.log(`\n完成：${passed} 项通过`);
}

main().catch(e => { console.error(e.stack); process.exitCode = 1; });
