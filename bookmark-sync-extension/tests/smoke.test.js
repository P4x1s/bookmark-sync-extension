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
const DIST = path.join(ROOT, 'dist', 'extension');
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
      getManifest: () => ({ version: '1.0.0' }),
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
      getManifest: () => ({ version: '1.0.0' }),
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
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'dist', 'extension', rel), 'utf8'), context, { filename: rel });
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
    const m = JSON.parse(read('dist/extension/manifest.json'));
    assert.equal(m.manifest_version, 3);
    assert.ok(m.background.service_worker);
    assert.ok(Array.isArray(m.background.scripts) && m.background.scripts.length >= 7);
    assert.ok(m.action.default_popup);
  });

  check('manifest 引用的全部文件存在', () => {
    const m = JSON.parse(read('dist/extension/manifest.json'));
    const iconRefs = [
      ...Object.values(m.icons || {}),
      ...Object.values(m.action.default_icon || {}),
      ...(m.action.theme_icons || []).flatMap(item => [item.light, item.dark]),
    ];
    const refs = [m.background.service_worker, ...m.background.scripts, m.action.default_popup, ...iconRefs];
    refs.forEach(r => assert.ok(fs.existsSync(path.join(DIST, r)), '缺少文件 ' + r));
    const html = read('dist/extension/popup.html');
    [...html.matchAll(/(?:src|href)="([^"]+)"/g)].forEach(mm => {
      assert.ok(fs.existsSync(path.join(DIST, mm[1])), 'popup 引用缺少 ' + mm[1]);
    });
  });

  check('图标覆盖多尺寸并包含深浅主题变体', () => {
    const m = JSON.parse(read('dist/extension/manifest.json'));
    const sorted = values => values.map(Number).sort((a, b) => a - b);
    assert.deepEqual(sorted(Object.keys(m.icons || {})), [16, 32, 48, 64, 128]);
    assert.deepEqual(sorted(Object.keys(m.action.default_icon || {})), [16, 24, 32, 48, 64, 128]);

    const entries = [
      ...Object.entries(m.icons || {}),
      ...Object.entries(m.action.default_icon || {}),
    ];
    entries.forEach(([size, rel]) => {
      assert.equal(size, String(size), '尺寸键必须为字符串');
      const buf = fs.readFileSync(path.join(DIST, rel));
      assert.equal(buf.readUInt32BE(16), Number(size), rel + ' 宽度不符');
      assert.equal(buf.readUInt32BE(20), Number(size), rel + ' 高度不符');
    });

    const themes = m.action.theme_icons || [];
    assert.deepEqual(themes.map(t => t.size).sort((a, b) => a - b), [16, 32]);
    themes.forEach(t => {
      assert.match(t.dark, /icon-on-light-\d+\.png$/, 'dark 槽应使用浅色工具栏适配图');
      assert.match(t.light, /icon-on-dark-\d+\.png$/, 'light 槽应使用深色工具栏适配图');
      [t.light, t.dark].forEach(rel => {
        const buf = fs.readFileSync(path.join(DIST, rel));
        assert.equal(buf.readUInt32BE(16), t.size);
        assert.equal(buf.readUInt32BE(20), t.size);
      });
    });
  });

  check('dist 与 src 源码逐字节一致（manifest 除外）', () => {
    const files = ['background.js', 'popup.html', 'popup.css', 'popup.js',
      'lib/util.js', 'lib/api.js', 'lib/config.js', 'lib/github.js', 'lib/model.js', 'lib/sync.js'];
    files.forEach(f => assert.equal(read('dist/extension/' + f), read('src/' + f), '不一致：' + f));
    fs.readdirSync(path.join(SRC, 'icons')).forEach(f => {
      assert.equal(read('dist/extension/icons/' + f), read('src/icons/' + f), '不一致：icons/' + f);
    });
  });

  check('zip 内容与 dist 文件集合一致', () => {
    const zlib = require('node:zlib');
    const buf = fs.readFileSync(path.join(ROOT, 'bookmark-sync-extension.zip'));
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
        vm.runInContext(read('dist/extension/background.js'), env.context, { filename: 'background.js' });
      } else {
        const m = JSON.parse(read('dist/extension/manifest.json'));
        m.background.scripts.forEach(f => vm.runInContext(read('dist/extension/' + f), env.context, { filename: f }));
      }
      assert.ok(env.listeners.message.length >= 1, '未注册消息监听');
      assert.ok(env.listeners.alarm.length >= 1, '未注册闹钟监听');
      assert.ok(env.listeners.created.length >= 1, '未注册书签事件监听');
    });

    await checkAsync(style + ' PING / GET_STATUS 消息可用', async () => {
      const ping = await dispatch(env, { type: 'PING' });
      assert.equal(ping.ok, true);
      assert.equal(ping.version, '1.0.0');
      const status = await dispatch(env, { type: 'GET_STATUS' });
      assert.equal(status.ok, true);
      assert.ok(status.config.token === '' || status.config.token.includes('****'), 'token 未脱敏');
      assert.equal(status.state.localBackups, undefined, '状态不应含完整备份树');
    });

    await checkAsync(style + ' SAVE_CONFIG 与 TEST_CONNECTION 可用', async () => {
      const saved = await dispatch(env, {
        type: 'SAVE_CONFIG',
        config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: ('ghp_' + 'smoketest') },
      });
      assert.equal(saved.ok, true);
      const tested = await dispatch(env, {
        type: 'TEST_CONNECTION',
        config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: ('ghp_' + 'smoketest') },
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
        config: { token: ('ghp_' + 'invalid') },
      });
      env.sandbox.fetch = async () => jsonRes(401, { message: 'Bad credentials' });
      const result = await dispatch(env, { type: 'SYNC_NOW' });
      assert.equal(result.ok, false);
      assert.match(result.error, /401|Bad credentials/);
    });
  }

  console.log('\n安装默认零写入与授权诊断：');

  async function freshBackground(fetchImpl) {
    const env = createBrowserEnv('firefox');
    if (fetchImpl) env.sandbox.fetch = fetchImpl;
    const m = JSON.parse(read('dist/extension/manifest.json'));
    m.background.scripts.forEach(f => vm.runInContext(read('dist/extension/' + f), env.context, { filename: f }));
    return env;
  }

  await checkAsync('安装后未配置：不写配置、不建闹钟、不写状态', async () => {
    const env = await freshBackground();
    assert.equal(env.store['bookmarkSync.config'], undefined);
    assert.equal(env.store['bookmarkSync.state'], undefined);
    assert.equal(env.store['__alarm'], undefined);
    // 本地书签变化也不应触发任何存储写入。
    env.listeners.created.forEach(fn => fn({ id: 'x' }));
    await new Promise(r => setTimeout(r, 3200));
    assert.equal(env.store['bookmarkSync.state'], undefined);
    assert.equal(env.requests.filter(r => r.init && r.init.method === 'PUT').length, 0);
  });

  await checkAsync('debounceMs 配置项实际影响书签变化去抖时长', async () => {
    const env = await freshBackground();
    await dispatch(env, {
      type: 'SAVE_CONFIG',
      config: {
        owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json',
        token: 'ghp_x', debounceMs: 50, autoSync: false,
      },
    });
    env.listeners.created.forEach(fn => fn({ id: 'x' }));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(env.store['bookmarkSync.state'], '短去抖后应写入 dirty 状态');
    assert.equal(env.store['bookmarkSync.state'].lastStatus, 'dirty');
  });

  await checkAsync('未配置时手动同步被拒绝且不发请求', async () => {
    const env = await freshBackground();
    const r = await dispatch(env, { type: 'SYNC_NOW' });
    assert.equal(r.ok, false);
    assert.match(r.error, /配置无效/);
    assert.equal(env.requests.length, 0);
  });

  await checkAsync('显式开启自动同步才建立闹钟，且必须配置完整', async () => {
    const env = await freshBackground();
    const bad = await dispatch(env, {
      type: 'SAVE_CONFIG', config: { owner: 'example', repo: 'private-repo', token: '', autoSync: true },
    });
    assert.equal(bad.ok, false);
    assert.equal(env.store['__alarm'], undefined);
    const good = await dispatch(env, {
      type: 'SAVE_CONFIG', config: { owner: 'example', repo: 'private-repo', token: 'ghp_x', autoSync: true },
    });
    assert.equal(good.ok, true);
    assert.ok(env.store['__alarm'], '完整配置并开启后应建立闹钟');
  });

  await checkAsync('测试连接只发 GET，不写入仓库', async () => {
    const env = await freshBackground();
    const r = await dispatch(env, {
      type: 'TEST_CONNECTION',
      config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'ghp_x' },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(env.requests.filter(x => x.init && x.init.method === 'PUT').length, 0);
  });

  await checkAsync('无写权限返回可操作指引（fine-grained PAT）', async () => {
    const env = await freshBackground(async () => jsonRes(200, {
      private: true, default_branch: 'main', permissions: { push: false }, full_name: 'example/private-repo',
    }));
    const r = await dispatch(env, {
      type: 'TEST_CONNECTION',
      config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'github_pat_x' },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /Contents/);
    assert.match(r.error, /Read and write/);
  });

  await checkAsync('403 原始错误被翻译为按令牌类型区分的指引', async () => {
    const env = await freshBackground(async () => jsonRes(403, {
      message: 'Resource not accessible by personal access token',
    }));
    const r = await dispatch(env, {
      type: 'TEST_CONNECTION',
      config: { owner: 'example', repo: 'private-repo', branch: 'main', path: 'bookmarks.json', token: 'github_pat_x' },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /403/);
    assert.match(r.error, /Read and write/);
    assert.equal(env.requests.filter(x => x.init && x.init.method === 'PUT').length, 0);
  });

  console.log('\n弹窗入口：');
  check('popup.js 在 DOM 环境中可加载并绑定事件', () => {
    const elements = Object.create(null);
    function el(id) {
      if (!elements[id]) {
        elements[id] = {
          id, value: '', textContent: '', className: '', type: id === 'token' ? 'password' : 'text',
          checked: false, disabled: false, children: [], style: {},
          addEventListener() {}, appendChild(c) { this.children.push(c); },
        };
      }
      return elements[id];
    }
    const docListeners = {};
    const popupMessageListeners = [];
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
        onMessage: { addListener: fn => popupMessageListeners.push(fn) },
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
      vm.runInContext(read('dist/extension/' + f), sandbox, { filename: f });
    }
    assert.equal(typeof docListeners.DOMContentLoaded, 'function');
    docListeners.DOMContentLoaded();
    assert.ok(el('btnSync').disabled === false, '同步按钮应可用');
    assert.ok(popupMessageListeners.length >= 1, '弹窗应监听后台进度消息');
    popupMessageListeners.forEach(fn => fn({
      type: 'SYNC_PROGRESS', percent: 42, phase: 'write', detail: '写入中', state: 'running',
    }));
    assert.equal(el('progressBar').style.width, '42%');
    assert.equal(el('progressPercent').textContent, '42%');
    assert.equal(el('progressBox').className.indexOf('hidden'), -1);
  });

  console.log(`\n完成：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error(e.stack); process.exitCode = 1; });
