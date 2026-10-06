// Import a user-supplied font pack through the admin API; never replace activity data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function importFontPack({ baseUrl, manifestPath, password, apply = false, backupDirectory }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost only.');
  }
  if (!password) throw new Error('ADMIN_PASSWORD is required.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.fonts) || !manifest.fonts.length) throw new Error('Empty font pack.');
  const root = path.dirname(path.resolve(manifestPath));
  const entries = manifest.fonts.map((font) => {
    if (typeof font.name !== 'string' || !font.name.trim() || font.name.length > 40) throw new Error('Invalid font name.');
    if (!['font/ttf', 'font/otf', 'font/woff', 'font/woff2'].includes(font.mime)) throw new Error('Invalid font MIME type.');
    const file = path.resolve(root, font.file);
    if (!file.startsWith(root + path.sep)) throw new Error('Font file must be inside the pack.');
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== font.sha256) throw new Error('Font checksum mismatch: ' + font.name);
    const data = `data:${font.mime};base64,${bytes.toString('base64')}`;
    if (data.length > 12 * 1024 * 1024) throw new Error('Font exceeds the upload limit: ' + font.name);
    return { name: font.name, mime: font.mime, data };
  });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error('Duplicate font names.');
  async function api(route, method = 'GET', body) {
    const response = await fetch(new URL(route, base), {
      method, redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-admin-password': password },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  const initial = (await api('/api/admin/config')).config;
  if (initial.fonts.some((font) => typeof font.enabled !== 'boolean' || font.builtIn !== undefined)) {
    throw new Error('Deploy the font visibility feature before importing this pack.');
  }
  if (!apply) return { applied: false, enable: entries.map((entry) => entry.name), existingFontCount: initial.fonts.length };
  if (!backupDirectory) throw new Error('A backup directory is required.');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const backup = await api('/api/admin/backup');
  const backupPath = path.join(backupDirectory, `before-font-import-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup), { mode: 0o600, flag: 'wx' });
  const catalog = [...initial.fonts];
  const selected = [];
  // Upload disabled first. No previous choices are hidden if a file fails to upload.
  for (const entry of entries) {
    let font = catalog.find((existing) => existing.name === entry.name && existing.data === entry.data);
    if (!font) {
      font = (await api('/api/admin/fonts', 'POST', { ...entry, enabled: false })).font;
      catalog.push(font);
    }
    selected.push(font.id);
  }
  for (const id of selected) await api('/api/admin/fonts/' + encodeURIComponent(id), 'PATCH', { enabled: true });
  for (const font of catalog) {
    if (!selected.includes(font.id) && font.enabled !== false) {
      await api('/api/admin/fonts/' + encodeURIComponent(font.id), 'PATCH', { enabled: false });
    }
  }
  const final = (await api('/api/admin/config')).config;
  for (const old of initial.fonts) {
    const kept = final.fonts.find((font) => font.id === old.id);
    assert.ok(kept, 'An existing font is missing.');
    assert.deepEqual({ ...kept, enabled: false }, { ...old, enabled: false });
  }
  const visible = (await api('/api/config')).config.fonts;
  assert.deepEqual(visible.map((font) => font.id).sort(), [...selected].sort());
  return { applied: true, visibleFonts: visible.map((font) => font.name), totalFonts: final.fonts.length, backupPath };
}

module.exports = { importFontPack };
if (require.main === module) {
  const [baseUrl, manifestPath, backupDirectory, action] = process.argv.slice(2);
  importFontPack({ baseUrl, manifestPath, backupDirectory, apply: action === '--apply', password: process.env.ADMIN_PASSWORD })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
