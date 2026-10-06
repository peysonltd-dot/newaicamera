const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('font visibility preserves the catalog, jobs, settings and backup state', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peyson-font-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = 'local-test-only';
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: password, FEIE_USER: '', FEIE_UKEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited early')); });
      child.stdout.on('data', (data) => {
        if (String(data).includes('running on port')) { clearTimeout(timer); resolve(); }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  t.after(stop);
  async function api(route, method = 'GET', body, status = 200, auth = true) {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { 'x-admin-password': password } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const backup = async () => (await api('/api/admin/backup')).backup;
  const publicFonts = async () => (await api('/api/config')).config.fonts;
  const toggle = (id, enabled) => api('/api/admin/fonts/' + id, 'PATCH', { enabled });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

  await start();
  const originalConfig = (await backup()).config;
  assert.equal(originalConfig.fonts.length, 10);
  assert.ok(originalConfig.fonts.every((font) => font.enabled && !font.builtIn));
  await api('/api/admin/config', 'PUT', { ...originalConfig, autoPrint: false });
  await api('/api/jobs', 'POST', { text: 'Previous order', fontId: 'system-serif', png });
  const before = await backup();
  await toggle('system-serif', false);
  assert.equal((await publicFonts()).length, 9);
  const after = await backup();
  assert.deepEqual(after.jobs, before.jobs);
  assert.equal(after.counter, before.counter);
  assert.deepEqual({ ...after.config, fonts: [] }, { ...before.config, fonts: [] });
  assert.equal(after.config.fonts.length, 10);
  await api('/api/admin/fonts/system-serif', 'PATCH', { enabled: true }, 401, false);
  await api('/api/admin/fonts/system-serif', 'PATCH', { enabled: 'true' }, 400);
  await api('/api/jobs', 'POST', { text: 'Stale font', fontId: 'system-serif', png }, 409);
  await api('/api/jobs', 'POST', { text: 'Stale combined', hasHandwriting: true, fontId: 'system-serif', png }, 409);
  assert.equal((await backup()).counter, before.counter);

  const uploaded = (await api('/api/admin/fonts', 'POST', { name: 'Test upload', data: 'data:font/ttf;base64,dGVzdA==', mime: 'font/ttf' })).font;
  assert.equal(uploaded.enabled, false);
  assert.ok(!(await publicFonts()).some((font) => font.id === uploaded.id));
  await toggle(uploaded.id, true);
  assert.ok((await publicFonts()).some((font) => font.id === uploaded.id && !font.data));
  await toggle(uploaded.id, false);
  const persisted = await backup();
  await stop();
  await start();
  assert.deepEqual(await backup(), persisted);
  await toggle('system-serif', true);
  await api('/api/admin/restore-backup', 'POST', { confirmation: '還原活動資料', backup: persisted });
  assert.deepEqual(await backup(), persisted);

  for (const font of persisted.config.fonts) await toggle(font.id, false);
  assert.deepEqual(await publicFonts(), []);
  await api('/api/jobs', 'POST', { hasHandwriting: true, png });
  await api('/api/jobs', 'POST', { text: 'No fonts', png }, 409);
  const hiddenCatalog = (await backup()).config.fonts;
  await api('/api/admin/reset-event', 'POST', { confirmation: '重製' });
  assert.deepEqual((await backup()).config.fonts, hiddenCatalog);
  assert.equal((await backup()).counter, 0);

  // Empty and partial catalogs must not be repopulated on restore/restart.
  const empty = await backup();
  empty.config.fonts = [];
  await api('/api/admin/restore-backup', 'POST', { confirmation: '還原活動資料', backup: empty });
  await stop();
  await start();
  assert.deepEqual((await backup()).config.fonts, []);
  const legacy = structuredClone(before);
  legacy.config.fonts = legacy.config.fonts.slice(0, 2).map(({ enabled, ...font }) => ({ ...font, builtIn: true }));
  await api('/api/admin/restore-backup', 'POST', { confirmation: '還原活動資料', backup: legacy });
  assert.equal((await publicFonts()).length, 2);
  assert.deepEqual((await backup()).jobs, before.jobs);
  await toggle('system-serif', false);
  const mixed = await backup();
  mixed.config.fonts[0].builtIn = true;
  await api('/api/admin/restore-backup', 'POST', { confirmation: '還原活動資料', backup: mixed });
  assert.equal((await publicFonts()).length, 1);
  const finalState = await backup();
  const invalid = structuredClone(finalState);
  invalid.config.fonts.push({ id: 'invalid', name: 'Invalid' });
  await api('/api/admin/restore-backup', 'POST', { confirmation: '還原活動資料', backup: invalid }, 400);
  assert.deepEqual(await backup(), finalState);
});
