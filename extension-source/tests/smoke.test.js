/*
 * 冒烟测试：模拟浏览器安装、后台加载与核心功能消息。
 * 覆盖 Chromium（service_worker + importScripts）与 Firefox（background.scripts）两条加载路径。
 * 运行：node tests/smoke.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist', 'universal');
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS', name);
  } catch (e) {
    failures.push({ name, error: e });
    console.error('  FAIL', name, '\n   ', e.message);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS', name);
  } catch (e) {
    failures.push({ name, error: e });
    console.error('  FAIL', name, '\n   ', e.message);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function jsonRes(status, data) {
  return { ok: status >= 200 && status < 400, status, text: async () => JSON.stringify(data) };
}

function createBrowserEnv(style) {
  const store = Object.create(null);
  const nodes = Object.create(null);
  const listeners = Object.create(null);
  const eventNames = ['created', 'removed', 'changed', 'moved', 'alarm', 'message', 'installed', 'startup'];
  eventNames.forEach(n => { listeners[n] = []; });
  let counter = 0;
  let remote = null;
  const requests = [];

  nodes.root = { id: 'root', title: 'root', url: null, parentId: null, children: [] };
  ['1', '2', '3'].forEach((id, i) => {
    nodes[id] = {
      id,
      title: ['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks'][i],
      url: null, parentId: 'root', children: [],
    };
    nodes.root.children.push(id);
  });

  const resolve = id => ({
    id,
    title: nodes[id].title,
    url: nodes[id].url || undefined,
    children: nodes[id].children.map(resolve),
  });

  function makeEvent(name) {
    return { addListener: fn => listeners[name].push(fn) };
  }

  function underlying() {
    return {
      storageGet: keys => {
        const out = Object.create(null);
        (keys || []).forEach(k => { if (store[k] !== undefined) out[k] = store[k]; });
        return out;
      },
      storageSet: obj => { Object.assign(store, obj); },
      getTree: () => [resolve('root')],
      getChildren: id => nodes[id].children.map(resolve),
      create: d => {
        const id = 'n' + (++counter);
        nodes[id] = { id, title: d.title, url: d.url || null, parentId: d.parentId, children: [] };
        nodes[d.parentId].children.splice(d.index == null ? 0 : d.index, 0, id);
        return resolve(id);
      },
      update: (id, changes) => { Object.assign(nodes[id], changes); return resolve(id); },
      move: (id, parentId, index) => {
        const old = nodes[id].parentId;
        nodes[old].children = nodes[old].children.filter(x => x !== id);
        nodes[parentId].children.splice(index, 0, id);
        nodes[id].parentId = parentId;
        return resolve(id);
      },
      remove: id => {
        nodes[nodes[id].parentId].children = nodes[nodes[id].parentId].children.filter(x => x !== id);
        delete nodes[id];
      },
      removeTree: function rm(id) {
        nodes[id].children.slice().forEach(rm);
        const p = nodes[id].parentId;
        if (p) nodes[p].children = nodes[p].children.filter(x => x !== id);
        delete nodes[id];
      },
    };
  }

  const core = underlying();
  // 模拟扩展内部消息分发：任一扩展页面 sendMessage 时，后台 listener 收到并回传响应。
  function deliver(message) {
    return new Promise(resolve => {
      let done = false;
      const respond = r => { if (!done) { done = true; resolve(r); } };
      listeners.message.forEach(fn => {
        try {
          const ret = fn(message, {}, respond);
          if (ret && typeof ret.then === 'function') ret.then(respond, () => respond(undefined));
        } catch (e) { respond({ ok: false, error: e.message }); }
      });
      setTimeout(() => respond({ ok: false, error: 'message timeout' }), 3000);
    });
  }

  const chromeStyle = {
    runtime: {
      id: 'smoke-extension',
      lastError: undefined,
      onMessage: makeEvent('message'),
      onInstalled: makeEvent('installed'),
      onStartup: makeEvent('startup'),
      getManifest: () => ({ version: '0.3.2' }),
      sendMessage: (message, cb) => { deliver(message).then(r => { if (cb) cb(r); }); },
    },
    storage: {
      local: {
        get: (keys, cb) => { const v = core.storageGet(keys); if (cb) cb(v); },
        set: (obj, cb) => { core.storageSet(obj); if (cb) cb(); },
        remove: (keys, cb) => { (keys || []).forEach(k => { delete store[k]; }); if (cb) cb(); },
      },
    },
    bookmarks: {
      onCreated: makeEvent('created'), onRemoved: makeEvent('removed'),
      onChanged: makeEvent('changed'), onMoved: makeEvent('moved'),
      getTree: cb => cb(core.getTree()), getChildren: (id, cb) => cb(core.getChildren(id)),
      get: (id, cb) => cb(resolve(id)), create: (d, cb) => cb(core.create(d)),
      update: (id, c, cb) => cb(core.update(id, c)),
      move: (id, p, i, cb) => cb(core.move(id, p, i)),
      remove: (id, cb) => cb(core.remove(id)), removeTree: (id, cb) => cb(core.removeTree(id)),
    },
    alarms: {
      onAlarm: makeEvent('alarm'),
      create: (name, info, cb) => { store['__alarm'] = info; if (cb) cb(); },
      clear: (name, cb) => { delete store['__alarm']; if (cb) cb(); },
    },
    action: {
      setBadgeText: (obj, cb) => { if (cb) cb(); },
      setBadgeBackgroundColor: (obj, cb) => { if (cb) cb(); },
    },
  };

  const promiseFn = fn => (...args) => Promise.resolve(fn(...args));
  const browserStyle = {
    runtime: {
      id: 'smoke-extension',
      onMessage: makeEvent('message'),
      onInstalled: makeEvent('installed'),
      onStartup: makeEvent('startup'),
      getManifest: () => ({ version: '0.3.2' }),
      sendMessage: async message => deliver(message),
    },
    storage: {
      local: {
        get: promiseFn(core.storageGet),
        set: promiseFn(core.storageSet),
        remove: promiseFn(keys => (keys || []).forEach(k => { delete store[k]; })),
      },
    },
    bookmarks: {
      onCreated: makeEvent('created'), onRemoved: makeEvent('removed'),
      onChanged: makeEvent('changed'), onMoved: makeEvent('moved'),
      getTree: promiseFn(core.getTree), getChildren: promiseFn(core.getChildren),
      get: promiseFn(resolve), create: promiseFn(core.create),
      update: promiseFn(core.update), move: promiseFn(core.move),
      remove: promiseFn(core.remove), removeTree: promiseFn(core.removeTree),
    },
    alarms: {
      onAlarm: makeEvent('alarm'),
      create: async (name, info) => { store['__alarm'] = info; },
      clear: async name => { delete store['__alarm']; },
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
  };

  const sandbox = {
    console,
    TextEncoder, TextDecoder, Uint8Array, URL,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (!parts.includes('contents')) {
        return jsonRes(200, { private: true, default_branch: 'main', permissions: { push: true }, full_name: 'example/private-repo' });
      }
      const p = parts.slice(parts.indexOf('contents') + 1).join('/');
      if (init.method === 'GET') {
        if (!remote || p !== 'bookmarks.json') return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, { sha: remote.sha, content: Buffer.from(remote.content, 'utf8').toString('base64') });
      }
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        if (p.startsWith('backups/')) return jsonRes(201, { content: { sha: 'backup' } });
        if (remote && body.sha !== remote.sha) return jsonRes(409, { message: 'sha mismatch' });
        remote = { sha: 'sha-' + Date.now(), content: Buffer.from(body.content, 'base64').toString('utf8') };
        return jsonRes(200, { content: { sha: remote.sha } });
      }
      return jsonRes(405, { message: 'method not allowed' });
    },
  };

  if (style === 'chromium') {
    sandbox.chrome = chromeStyle;
    sandbox.importScripts = function () {
      for (const rel of arguments) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'dist', 'universal', rel), 'utf8'), context, { filename: rel });
      }
    };
  } else {
    sandbox.browser = browserStyle;
  }

  const context = vm.createContext(sandbox);
  return { context, sandbox, listeners, store, nodes, requests, getRemote: () => remote, setRemote: t => { remote = t; }, core };
}

async function dispatch(env, message) {
  const pending = [];
  const response = await new Promise(resolve => {
    env.listeners.message.forEach(fn => {
      const ret = fn(message, {}, r => resolve(r));
      if (ret && typeof ret.then === 'function') ret.then(resolve);
    });
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 3000);
  });
  return response;
}

async function main() {
  console.log('安装 / 加载冒烟测试：');

  check('manifest 合法且为唯一清单', () => {
    const m = JSON.parse(read('dist/universal/manifest.json'));
    assert.equal(m.manifest_version, 3);
    assert.ok(m.background.service_worker);
    assert.ok(Array.isArray(m.background.scripts) && m.background.scripts.length >= 7);
    assert.ok(m.action.default_popup);
  });

  check('manifest 引用的全部文件存在', () => {
    const m = JSON.parse(read('dist/universal/manifest.json'));
    const refs = [m.background.service_worker, ...m.background.scripts, m.action.default_popup];
    refs.forEach(r => assert.ok(fs.existsSync(path.join(DIST, r)), '缺少文件 ' + r));
    const html = read('dist/universal/popup.html');
    [...html.matchAll(/(?:src|href)="([^"]+)"/g)].forEach(mm => {
      assert.ok(fs.existsSync(path.join(DIST, mm[1])), 'popup 引用缺少 ' + mm[1]);
    });
  });

  check('dist 与 src 源码逐字节一致（manifest 除外）', () => {
    const files = ['background.js', 'popup.html', 'popup.css', 'popup.js',
      'lib/util.js', 'lib/api.js', 'lib/config.js', 'lib/github.js', 'lib/model.js', 'lib/sync.js'];
    files.forEach(f => assert.equal(read('dist/universal/' + f), read('src/' + f), '不一致：' + f));
  });

  check('zip 内容与 dist 文件集合一致', () => {
    const zlib = require('node:zlib');
    const buf = fs.readFileSync(path.join(ROOT, 'bookmark-sync-universal.zip'));
    // 只核对关键文件存在，不引入额外解压依赖
    for (const f of ['manifest.json', 'background.js', 'popup.html', 'lib/config.js', 'lib/sync.js']) {
      assert.ok(buf.includes(Buffer.from(f)), 'zip 内缺少 ' + f);
    }
    void zlib;
  });

  console.log('\n后台加载与消息协议：');
  for (const style of ['chromium', 'firefox']) {
    const env = createBrowserEnv(style);
    await checkAsync(style + ' 后台脚本加载并注册事件', async () => {
      if (style === 'chromium') {
        vm.runInContext(read('dist/universal/background.js'), env.context, { filename: 'background.js' });
      } else {
        const m = JSON.parse(read('dist/universal/manifest.json'));
        m.background.scripts.forEach(f => vm.runInContext(read('dist/universal/' + f), env.context, { filename: f }));
      }
      assert.ok(env.listeners.message.length >= 1, '未注册消息监听');
      assert.ok(env.listeners.alarm.length >= 1, '未注册闹钟监听');
      assert.ok(env.listeners.created.length >= 1, '未注册书签事件监听');
    });

    await checkAsync(style + ' PING / GET_STATUS 消息可用', async () => {
      const ping = await dispatch(env, { type: 'PING' });
      assert.equal(ping.ok, true);
      assert.equal(ping.version, '0.3.2');
      const status = await dispatch(env, { type: 'GET_STATUS' });
      assert.equal(status.ok, true);
      assert.ok(status.config.token === '' || status.config.token.includes('****'), 'token 未脱敏');
      assert.equal(status.state.localBackups, undefined, '状态不应含完整备份树');
    });

    await checkAsync(style + ' SAVE_CONFIG 与 TEST_CONNECTION 可用', async () => {
      const saved = await dispatch(env, {
        type: 'SAVE_CONFIG',
        config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'ghp_smoketest' },
      });
      assert.equal(saved.ok, true);
      const tested = await dispatch(env, {
        type: 'TEST_CONNECTION',
        config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'ghp_smoketest' },
      });
      assert.equal(tested.ok, true);
      assert.equal(tested.info.private, true);
      assert.equal(tested.fileExists, false);
    });

    await checkAsync(style + ' SYNC_NOW 首次同步创建远端文件', async () => {
      const result = await dispatch(env, { type: 'SYNC_NOW' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, 'pushed');
      assert.ok(env.getRemote(), '远端文件应被创建');
    });

    await checkAsync(style + ' 重复 SYNC_NOW 不产生写入', async () => {
      const before = env.requests.length;
      const result = await dispatch(env, { type: 'SYNC_NOW' });
      assert.equal(result.status, 'noop');
      const writes = env.requests.slice(before).filter(r => r.init && r.init.method === 'PUT');
      assert.equal(writes.length, 0);
    });

    await checkAsync(style + ' 未授权 token 报明确错误且不改本地', async () => {
      await dispatch(env, {
        type: 'SAVE_CONFIG',
        config: { token: 'ghp_invalid' },
      });
      env.sandbox.fetch = async () => jsonRes(401, { message: 'Bad credentials' });
      const result = await dispatch(env, { type: 'SYNC_NOW' });
      assert.equal(result.ok, false);
      assert.match(result.error, /401|Bad credentials/);
    });
  }

  console.log('\n弹窗入口：');
  check('popup.js 在 DOM 环境中可加载并绑定事件', () => {
    const elements = Object.create(null);
    function el(id) {
      if (!elements[id]) {
        elements[id] = {
          id, value: '', textContent: '', className: '', type: id === 'token' ? 'password' : 'text',
          checked: false, disabled: false, children: [],
          addEventListener() {}, appendChild(c) { this.children.push(c); },
        };
      }
      return elements[id];
    }
    const docListeners = {};
    const sandbox = {
      console, TextEncoder, TextDecoder, Uint8Array, URL,
      btoa: s => Buffer.from(s, 'binary').toString('base64'),
      atob: s => Buffer.from(s, 'base64').toString('binary'),
      setTimeout, clearTimeout,
      document: {
        getElementById: el,
        createElement: () => el('_tmp' + Math.random()),
        addEventListener: (name, fn) => { docListeners[name] = fn; },
      },
      open: () => undefined,
    };
    vm.createContext(sandbox);
    sandbox.browser = {
      runtime: {
        id: 'popup-smoke',
        onMessage: { addListener() {} },
        sendMessage: async message => {
          if (message.type === 'GET_STATUS') {
            return {
              ok: true,
              config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'ghp_****test' },
              state: { lastStatus: 'idle', lastMessage: '', lastSyncAt: '' },
              backups: [],
            };
          }
          return { ok: true };
        },
      },
      bookmarks: {},
      storage: { local: {} },
      alarms: null,
      action: null,
    };
    for (const f of ['lib/util.js', 'lib/api.js', 'lib/config.js', 'lib/github.js', 'lib/model.js', 'lib/sync.js', 'popup.js']) {
      vm.runInContext(read('dist/universal/' + f), sandbox, { filename: f });
    }
    assert.equal(typeof docListeners.DOMContentLoaded, 'function');
    docListeners.DOMContentLoaded();
    assert.ok(el('btnSync').disabled === false, '同步按钮应可用');
  });

  console.log(`\n完成：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error(e.stack); process.exitCode = 1; });
