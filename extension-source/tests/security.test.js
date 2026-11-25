/*
 * 安全验证：输入校验、权限边界、敏感数据、异常处理与危险逻辑。
 * 运行：node tests/security.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { failures.push({ name, error: e }); console.error('  FAIL', name, '\n   ', e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  PASS', name); }
  catch (e) { failures.push({ name, error: e }); console.error('  FAIL', name, '\n   ', e.message); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const jsonRes = (status, data) => ({ ok: status >= 200 && status < 400, status, text: async () => JSON.stringify(data) });

function createEnv() {
  const storage = Object.create(null);
  const nodes = Object.create(null);
  let counter = 0;
  let remote = null;
  const backups = [];
  const requests = [];
  const add = (id, title, parentId, url) => {
    nodes[id] = { id, title, parentId: parentId || null, url: url || null, children: [] };
    if (parentId) nodes[parentId].children.push(id);
    return nodes[id];
  };
  add('root', 'root', null);
  ['1', '2', '3'].forEach((id, i) => add(id, ['Bar', 'Other', 'Mobile'][i], 'root'));
  const resolve = id => ({ id, title: nodes[id].title, url: nodes[id].url || undefined, children: nodes[id].children.map(resolve) });
  const api = {
    getTree: async () => [resolve('root')],
    getChildren: async id => nodes[id].children.map(resolve),
    create: async d => {
      const id = 'n' + (++counter);
      nodes[id] = { id, title: d.title, parentId: d.parentId, url: d.url || null, children: [] };
      nodes[d.parentId].children.splice(d.index == null ? 0 : d.index, 0, id);
      return resolve(id);
    },
    update: async (id, changes) => { Object.assign(nodes[id], changes); return resolve(id); },
    move: async (id, p, i) => {
      const old = nodes[id].parentId;
      nodes[old].children = nodes[old].children.filter(x => x !== id);
      nodes[p].children.splice(i, 0, id);
      nodes[id].parentId = p;
      return resolve(id);
    },
    remove: async id => { nodes[nodes[id].parentId].children = nodes[nodes[id].parentId].children.filter(x => x !== id); delete nodes[id]; },
    removeTree: function rm(id) {
      nodes[id].children.slice().forEach(rm);
      const p = nodes[id].parentId;
      if (p) nodes[p].children = nodes[p].children.filter(x => x !== id);
      delete nodes[id];
    },
    storageGet: async keys => { const o = Object.create(null); (keys || []).forEach(k => { if (storage[k] !== undefined) o[k] = storage[k]; }); return o; },
    storageSet: async obj => { Object.assign(storage, obj); },
    sendMessage: async () => undefined,
  };
  globalThis.BS.api = api;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (!parts.includes('contents')) return jsonRes(200, { private: true, default_branch: 'main', permissions: { push: true }, full_name: 'example/private-repo' });
    const p = parts.slice(parts.indexOf('contents') + 1).join('/');
    if (init.method === 'GET') {
      if (!remote || p !== 'bookmarks.json') return jsonRes(404, { message: 'Not Found' });
      return jsonRes(200, { sha: remote.sha, content: Buffer.from(remote.content, 'utf8').toString('base64') });
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (p.startsWith('backups/')) { backups.push({ path: p, body }); return jsonRes(201, { content: { sha: 'bak' } }); }
      if (remote && body.sha !== remote.sha) return jsonRes(409, { message: 'sha mismatch' });
      remote = { sha: 'sha-' + Date.now() + Math.random(), content: Buffer.from(body.content, 'base64').toString('utf8') };
      return jsonRes(200, { content: { sha: remote.sha } });
    }
    return jsonRes(405, { message: 'method not allowed' });
  };
  return {
    storage, nodes, backups, requests,
    getRemote: () => remote,
    setRemote: r => { remote = r; },
    setRemoteTree: t => { remote = { sha: 'sha-' + Math.random(), content: JSON.stringify({ schema: 1, tree: t }) }; },
    addBookmark: (parent, title, url) => add('local-' + (++counter), title, parent, url),
  };
}

require(path.join(ROOT, 'src/lib/util.js'));
require(path.join(ROOT, 'src/lib/config.js'));
require(path.join(ROOT, 'src/lib/github.js'));
require(path.join(ROOT, 'src/lib/model.js'));
require(path.join(ROOT, 'src/lib/sync.js'));
const BS = globalThis.BS;

async function main() {
// ---------- 依赖与权限面 ----------
console.log('依赖与权限面：');

check('无第三方运行时依赖（无 package.json / node_modules）', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'node_modules')), false);
  const html = read('src/popup.html');
  assert.ok(!/<script[^>]+src="https?:/.test(html), '不得加载远程脚本');
});

check('manifest 权限最小化（仅 bookmarks/storage/alarms + GitHub API）', () => {
  const m = JSON.parse(read('src/manifest.base.json'));
  assert.deepEqual(m.permissions.slice().sort(), ['alarms', 'bookmarks', 'storage']);
  assert.deepEqual(m.host_permissions, ['https://api.github.com/*']);
  assert.equal(m.content_security_policy === undefined || /script-src 'self'/.test(JSON.stringify(m.content_security_policy)), true);
});

// ---------- 输入校验 ----------
console.log('\n输入校验：');

function validCfg(patch) {
  return Object.assign({
    owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
    token: 'ghp_testtoken', autoSync: false, syncIntervalMinutes: 15,
    conflictStrategy: 'backup-then-local', lowMemoryMode: true, backupCount: 1,
  }, patch || {});
}

check('config.validate 拒绝空 token 与非法仓库名', () => {
  assert.equal(BS.config.validate(validCfg({ token: '' })).valid, false);
  assert.equal(BS.config.validate(validCfg({ owner: 'bad owner!' })).valid, false);
  assert.equal(BS.config.validate(validCfg({ repo: '../evil' })).valid, false);
});

check('config.validate 拒绝路径穿越与非法区间', () => {
  assert.equal(BS.config.validate(validCfg({ path: '../../etc/passwd' })).valid, false);
  assert.equal(BS.config.validate(validCfg({ syncIntervalMinutes: 0 })).valid, false);
  assert.equal(BS.config.validate(validCfg({ backupCount: 99 })).valid, false);
  assert.equal(BS.config.validate(validCfg()).valid, true);
});

check('GitHub 客户端对每段路径做编码，避免 URL 注入', () => {
  const c = new BS.GitHubClient('ghp_x', 'own', 'repo', 'main', 'a/b c.json');
  const url = c._contentsUrl('a/b c.json');
  assert.ok(url.includes('a/b%20c.json'), url);
  assert.ok(!url.includes('..'));
});

check('默认配置不自动同步且未填写仓库', () => {
  const d = BS.config.DEFAULT_CONFIG;
  assert.equal(d.autoSync, false, '安装后默认不得自动同步');
  assert.equal(d.owner, '');
  assert.equal(d.repo, '');
  assert.equal(d.token, '');
  assert.equal(BS.config.isConfigured(d), false);
  assert.equal(BS.config.isConfigured({ owner: 'a', repo: 'b', token: 't' }), true);
});

check('403 指引按令牌类型区分且不含令牌明文', () => {
  const fine = BS.util.authHint('github_pat_abcdef', 403);
  const classic = BS.util.authHint('ghp_abcdef', 403);
  assert.match(fine, /Contents/);
  assert.match(fine, /Read and write/);
  assert.match(classic, /repo scope/);
  assert.ok(!fine.includes('abcdef') && !classic.includes('abcdef'));
  assert.equal(BS.util.authHint('ghp_x', 401), '');
});

await checkAsync('403 响应被转换成可操作错误且保留状态码', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes(403, { message: 'Resource not accessible by personal access token' });
  try {
    const client = new BS.GitHubClient('github_pat_test', 'own', 'repo', 'main', 'bookmarks.json');
    let error = null;
    try { await client.checkAccess(); } catch (e) { error = e; }
    assert.ok(error, '403 必须抛错');
    assert.equal(error.status, 403);
    assert.match(error.message, /Read and write/);
    assert.ok(!error.message.includes('github_pat_test'));
  } finally { globalThis.fetch = originalFetch; }
});

// ---------- 敏感数据 ----------
console.log('\n敏感数据处理：');

check('token 脱敏显示不泄露中段', () => {
  assert.equal(BS.util.maskToken('ghp_1234567890abcdef'), 'ghp_****cdef');
  assert.ok(!BS.util.maskToken('ghp_1234567890abcdef').includes('1234567890'));
});

await checkAsync('同步文件不含 token，仅含必要字段', async () => {
  const env = createEnv();
  await BS.config.save(validCfg({ token: 'ghp_SUPERSECRET_TOKEN' }));
  env.addBookmark('1', '敏感测试', 'https://example.com');
  await BS.sync.runSync();
  const raw = env.getRemote().content;
  assert.ok(!raw.includes('SUPERSECRET'), '同步文件不得包含 token');
  const payload = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload).sort(), ['deviceId', 'schema', 'tree', 'updatedAt']);
});

// ---------- 同步危险逻辑 ----------
console.log('\n同步危险逻辑：');

await checkAsync('远端高版本 schema 直接报错且不覆盖', async () => {
  const env = createEnv();
  await BS.config.save(validCfg());
  env.setRemote({ sha: 's1', content: JSON.stringify({ schema: 2, tree: [] }) });
  const r = await BS.sync.runSync();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /版本/);
  assert.equal(JSON.parse(env.getRemote().content).schema, 2, '远端文件不应被改写');
});

await checkAsync('远端非法 JSON：先备份原内容再写入', async () => {
  const env = createEnv();
  await BS.config.save(validCfg());
  const original = '{ not json';
  env.setRemote({ sha: 's2', content: original });
  const r = await BS.sync.runSync();
  assert.equal(r.status, 'pushed');
  const initial = env.backups.find(b => b.path.includes('initial-'));
  assert.ok(initial, '应备份原始内容');
  assert.equal(Buffer.from(initial.body.content, 'base64').toString('utf8'), original);
});

await checkAsync('首次同步远端已有书签：必须保留远端数据（当前实现风险点）', async () => {
  const env = createEnv();
  await BS.config.save(validCfg());
  const remoteTree = [{
    uuid: 'remote-root', type: 'folder', title: '远端已有文件夹',
    children: [{ uuid: 'remote-item', type: 'url', title: '远端重要书签', url: 'https://important.example' }],
  }];
  env.setRemoteTree(remoteTree);
  env.addBookmark('1', '本地新书签', 'https://local.example');
  const beforeBackups = env.backups.length;

  const r = await BS.sync.runSync();
  const pushed = JSON.parse(env.getRemote().content).tree;
  const flattened = JSON.stringify(pushed);
  const remotePreserved = flattened.includes('远端重要书签');
  const remoteBackedUp = env.backups.length > beforeBackups;
  assert.ok(remotePreserved || remoteBackedUp,
    '首次同步覆盖了远端已有书签且未生成备份：status=' + r.status + '，tree=' + flattened.slice(0, 300));
});

await checkAsync('非法备份序号不得误恢复其他快照', async () => {
  const env = createEnv();
  await BS.config.save(validCfg());
  // 制造两份不同的本地快照
  const list = [
    { at: '2026-01-01T00:00:00.000Z', reason: 'first', nodeCount: 1, tree: [{ uuid: 'a', type: 'folder', title: '第一份', children: [] }] },
    { at: '2026-01-02T00:00:00.000Z', reason: 'second', nodeCount: 1, tree: [{ uuid: 'b', type: 'folder', title: '第二份', children: [] }] },
  ];
  env.storage['bookmarkSync.backups'] = list;
  const before = JSON.stringify(env.nodes);
  let error = null;
  try { await BS.sync.restoreBackup('not-a-number'); } catch (e) { error = e; }
  const after = JSON.stringify(env.nodes);
  assert.ok(error, '非法序号应明确报错，而不是静默恢复第 0 份');
  assert.equal(after, before, '非法序号不应修改本地书签');
});

await checkAsync('网络异常返回明确错误且不破坏本地书签', async () => {
  const env = createEnv();
  await BS.config.save(validCfg());
  env.addBookmark('1', '应保持', 'https://keep.example');
  const before = JSON.stringify(env.nodes);
  globalThis.fetch = async () => { throw new Error('network down'); };
  const r = await BS.sync.runSync();
  assert.equal(r.ok, false);
  assert.match(r.error, /network down/);
  assert.equal(JSON.stringify(env.nodes), before);
});

// ---------- 后台消息边界 ----------
console.log('\n后台消息边界：');

async function loadBackground() {
  const storage = Object.create(null);
  const listeners = [];
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, URL,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout,
    fetch: globalThis.fetch,
    browser: {
      runtime: {
        id: 'sec-smoke',
        onMessage: { addListener: fn => listeners.push(fn) },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        getManifest: () => ({}), sendMessage: async () => undefined,
      },
      bookmarks: {
        onCreated: { addListener() {} }, onRemoved: { addListener() {} },
        onChanged: { addListener() {} }, onMoved: { addListener() {} },
        getTree: async () => [], getChildren: async () => [],
      },
      storage: { local: {
        get: async keys => { const o = Object.create(null); (keys || []).forEach(k => { if (storage[k] !== undefined) o[k] = storage[k]; }); return o; },
        set: async obj => { Object.assign(storage, obj); }, remove: async () => {},
      } },
      alarms: { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => {} },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    },
  };
  vm.createContext(sandbox);
  const m = JSON.parse(read('src/manifest.base.json'));
  for (const f of m.background.scripts) vm.runInContext(read('src/' + f), sandbox, { filename: f });
  return {
    storage,
    async send(message) {
      return new Promise(resolve => {
        let done = false;
        const respond = r => { if (!done) { done = true; resolve(r); } };
        listeners.forEach(fn => fn(message, {}, respond));
        setTimeout(() => respond({ ok: false, error: 'timeout' }), 2000);
      });
    },
  };
}

await checkAsync('SAVE_CONFIG 拒绝路径穿越与非法令牌类型', async () => {
  const bg = await loadBackground();
  const r = await bg.send({ type: 'SAVE_CONFIG', config: { path: '../../evil', token: 12345, syncIntervalMinutes: -1 } });
  assert.equal(r.ok, false, '非法配置不应被保存：' + JSON.stringify(r));
  assert.equal(bg.storage['bookmarkSync.config'], undefined);
});

await checkAsync('SET_CONFLICT 仅接受预定义策略', async () => {
  const bg = await loadBackground();
  const r = await bg.send({ type: 'SET_CONFLICT', strategy: 'delete-everything' });
  assert.equal(r.ok, false, '非法冲突策略不应被接受');
  const cfg = bg.storage['bookmarkSync.config'];
  assert.ok(!cfg || cfg.conflictStrategy !== 'delete-everything');
});

await checkAsync('GET_STATUS 不泄露完整 token 与完整备份树', async () => {
  const bg = await loadBackground();
  bg.storage['bookmarkSync.config'] = { token: 'ghp_SUPERSECRET_TOKEN' };
  bg.storage['bookmarkSync.backups'] = [{ at: 'x', reason: 'r', tree: [{ uuid: 's', type: 'folder', title: '秘密结构', children: [] }] }];
  const r = await bg.send({ type: 'GET_STATUS' });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes('SUPERSECRET_TOKEN'), '响应含完整 token');
  assert.ok(!JSON.stringify(r).includes('秘密结构'), '响应含完整备份树');
});

console.log(`\n完成：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error(e.stack); process.exitCode = 1; });
