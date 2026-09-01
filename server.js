require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const FEIE_API_URL = process.env.FEIE_API_URL || 'https://api.jp.feieyun.com/Api/Open/';
const FEIE_USER = process.env.FEIE_USER || '';
const FEIE_UKEY = process.env.FEIE_UKEY || '';
const FEIE_SN = process.env.FEIE_SN || '';

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function defaultStore() {
  return {
    config: {
      eventName: '現場雷雕體驗',
      eventSubtitle: '手寫簽名・專屬文字',
      modes: ['handwriting', 'typing'],
      maxChars: 20,
      canvasRatio: 5,
      outputWidth: 2000,
      handwritingWidths: [6, 10, 14],
      defaultHandwritingWidth: 10,
      ticketPrefix: '',
      autoPrint: true,
      ticketMessage: '請保留票券，憑號取件',
      fonts: [
        { id: 'system-sans', name: '經典黑體', family: 'Arial, "Noto Sans TC", sans-serif', builtIn: true },
        { id: 'system-serif', name: '典雅明體', family: '"Times New Roman", "Noto Serif TC", serif', builtIn: true }
      ]
    },
    counter: 0,
    jobs: []
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(defaultStore(), null, 2));
  }
}

function loadStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const defaults = defaultStore();
    return {
      config: Object.assign({}, defaults.config, parsed.config || {}),
      counter: Number(parsed.counter || 0),
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    console.error('Store read failed:', error);
    return defaultStore();
  }
}

let store = loadStore();

function saveStore() {
  ensureStore();
  const temp = STORE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, STORE_FILE);
}

function publicConfig() {
  return store.config;
}

function nowIso() {
  return new Date().toISOString();
}

function formatNumber(value) {
  return String(value).padStart(3, '0');
}

function safeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const supplied = String(req.get('x-admin-password') || req.body?.password || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(ADMIN_PASSWORD);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: '尚未設定 ADMIN_PASSWORD' });
  }
  if (!isAdmin(req)) return res.status(401).json({ success: false, error: '後台密碼錯誤' });
  next();
}

function validateDataUrl(value) {
  return typeof value === 'string' &&
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) &&
    value.length < 25 * 1024 * 1024;
}

function findJob(id) {
  return store.jobs.find((job) => job.id === String(id));
}

function ticketContent(job) {
  const config = store.config;
  const number = safeText(config.ticketPrefix, 8) + job.id;
  return [
    '<CB>' + safeText(config.eventName, 40) + '</CB><BR>',
    '<CB>------------------------</CB><BR>',
    '<CB><BOLD>' + number + '</BOLD></CB><BR>',
    '<CB>------------------------</CB><BR>',
    '<C>' + safeText(config.ticketMessage, 60) + '</C><BR>',
    '<C>' + (job.mode === 'handwriting' ? '手寫簽名' : '文字雷雕') + '</C><BR>',
    '<C>' + new Date(job.createdAt).toLocaleString('zh-TW', { hour12: false }) + '</C><BR><BR>'
  ].join('');
}

async function feieRequest(privateParams) {
  if (!FEIE_USER || !FEIE_UKEY || !FEIE_SN) {
    throw new Error('尚未完成飛鵝出票機環境變數設定');
  }
  const stime = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHash('sha1').update(FEIE_USER + FEIE_UKEY + stime).digest('hex');
  const params = new URLSearchParams({
    user: FEIE_USER,
    stime,
    sig,
    ...privateParams
  });
  const response = await fetch(FEIE_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: params
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { ret: -1, msg: raw }; }
  if (!response.ok || body.ret !== 0) {
    throw new Error(body.msg || '出票機 API 呼叫失敗');
  }
  return body;
}

async function printJob(job) {
  job.printStatus = 'printing';
  job.printError = '';
  saveStore();
  try {
    const result = await feieRequest({
      apiname: 'Open_printMsg',
      sn: FEIE_SN,
      content: ticketContent(job),
      times: '1'
    });
    job.printStatus = 'printed';
    job.printOrderId = result.data || '';
  } catch (error) {
    job.printStatus = 'failed';
    job.printError = error.message || String(error);
  }
  saveStore();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'peyson-laser-liveprint',
    storage: STORE_FILE,
    printerConfigured: Boolean(FEIE_USER && FEIE_UKEY && FEIE_SN),
    time: nowIso()
  });
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, config: publicConfig() });
});

app.post('/api/jobs', (req, res) => {
  const mode = req.body?.mode === 'typing' ? 'typing' : 'handwriting';
  if (!store.config.modes.includes(mode)) {
    return res.status(400).json({ success: false, error: '此輸入模式目前未開放' });
  }
  const handedness = ['left', 'right'].includes(req.body?.handedness) ? req.body.handedness : '';
  if (!handedness) {
    return res.status(400).json({ success: false, error: '請選擇左撇子或右撇子' });
  }
  if (!validateDataUrl(req.body?.png)) {
    return res.status(400).json({ success: false, error: '圖檔格式錯誤或檔案過大' });
  }

  const text = mode === 'typing' ? safeText(req.body?.text, store.config.maxChars) : '';
  if (mode === 'typing' && !text) {
    return res.status(400).json({ success: false, error: '請輸入雷雕文字' });
  }

  store.counter += 1;
  const id = formatNumber(store.counter);
  const job = {
    id,
    mode,
    handedness,
    text,
    fontId: safeText(req.body?.fontId, 60),
    strokeWidth: Number(req.body?.strokeWidth || 0),
    png: req.body.png,
    thumbnail: validateDataUrl(req.body?.thumbnail) ? req.body.thumbnail : '',
    svg: typeof req.body?.svg === 'string' && req.body.svg.length < 5 * 1024 * 1024 ? req.body.svg : '',
    status: 'waiting',
    printStatus: store.config.autoPrint ? 'queued' : 'not_requested',
    printError: '',
    remark: '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  store.jobs.unshift(job);
  saveStore();

  res.json({
    success: true,
    job: {
      id: job.id,
      displayNumber: safeText(store.config.ticketPrefix, 8) + job.id,
      status: job.status,
      printStatus: job.printStatus
    }
  });

  if (store.config.autoPrint) setImmediate(() => printJob(job));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: '找不到這個號碼' });
  res.json({
    success: true,
    job: {
      id: job.id,
      displayNumber: safeText(store.config.ticketPrefix, 8) + job.id,
      mode: job.mode,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, error: '請先在 Render 設定 ADMIN_PASSWORD' });
  }
  if (!isAdmin(req)) return res.status(401).json({ success: false, error: '密碼錯誤' });
  res.json({ success: true });
});

app.get('/api/admin/jobs', requireAdmin, (req, res) => {
  const jobs = store.jobs.map(({ png, svg, ...job }) => ({
    ...job,
    hasPng: Boolean(png),
    hasSvg: Boolean(svg)
  }));
  res.json({ success: true, jobs, counter: store.counter });
});

app.get('/api/admin/jobs/:id/file/:type', requireAdmin, (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: '找不到任務' });
  if (req.params.type === 'svg') {
    if (!job.svg) return res.status(404).json({ success: false, error: '此任務沒有 SVG' });
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="' + job.id + '.svg"');
    return res.send(job.svg);
  }
  const match = /^data:image\/png;base64,(.+)$/.exec(job.png || '');
  if (!match) return res.status(404).json({ success: false, error: '此任務沒有 PNG' });
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-disposition', 'attachment; filename="' + job.id + '.png"');
  res.send(Buffer.from(match[1], 'base64'));
});

app.patch('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: '找不到任務' });
  const statuses = ['waiting', 'processing', 'completed', 'cancelled'];
  if (statuses.includes(req.body?.status)) job.status = req.body.status;
  if (typeof req.body?.remark === 'string') job.remark = safeText(req.body.remark, 120);
  job.updatedAt = nowIso();
  saveStore();
  res.json({ success: true });
});

app.post('/api/admin/jobs/:id/reprint', requireAdmin, (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: '找不到任務' });
  res.json({ success: true });
  setImmediate(() => printJob(job));
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    success: true,
    config: store.config,
    printerConfigured: Boolean(FEIE_USER && FEIE_UKEY && FEIE_SN)
  });
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  const input = req.body || {};
  const allowedModes = Array.isArray(input.modes)
    ? input.modes.filter((mode) => ['handwriting', 'typing'].includes(mode))
    : store.config.modes;

  store.config = {
    ...store.config,
    eventName: safeText(input.eventName ?? store.config.eventName, 50),
    eventSubtitle: safeText(input.eventSubtitle ?? store.config.eventSubtitle, 80),
    modes: allowedModes.length ? allowedModes : ['handwriting'],
    maxChars: Math.min(50, Math.max(1, Number(input.maxChars || store.config.maxChars))),
    canvasRatio: Math.min(10, Math.max(1, Number(input.canvasRatio || store.config.canvasRatio))),
    outputWidth: Math.min(4000, Math.max(800, Number(input.outputWidth || store.config.outputWidth))),
    ticketPrefix: safeText(input.ticketPrefix ?? store.config.ticketPrefix, 8),
    autoPrint: Boolean(input.autoPrint),
    ticketMessage: safeText(input.ticketMessage ?? store.config.ticketMessage, 60)
  };
  saveStore();
  res.json({ success: true, config: store.config });
});

app.post('/api/admin/fonts', requireAdmin, (req, res) => {
  const name = safeText(req.body?.name, 40);
  const data = String(req.body?.data || '');
  const mime = safeText(req.body?.mime, 80);
  if (!name || !/^data:(font\/|application\/(font|octet-stream|x-font-|vnd\.ms-fontobject)).*;base64,/i.test(data)) {
    return res.status(400).json({ success: false, error: '字體名稱或檔案格式不正確' });
  }
  if (data.length > 12 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: '字體檔案不可超過 9MB' });
  }
  const id = 'font-' + crypto.randomBytes(6).toString('hex');
  store.config.fonts.push({ id, name, family: 'Peyson_' + id.replace(/-/g, '_'), data, mime, builtIn: false });
  saveStore();
  res.json({ success: true, font: store.config.fonts.at(-1) });
});

app.delete('/api/admin/fonts/:id', requireAdmin, (req, res) => {
  const font = store.config.fonts.find((item) => item.id === req.params.id);
  if (!font) return res.status(404).json({ success: false, error: '找不到字體' });
  if (font.builtIn) return res.status(400).json({ success: false, error: '內建字體不可刪除' });
  store.config.fonts = store.config.fonts.filter((item) => item.id !== req.params.id);
  saveStore();
  res.json({ success: true });
});

app.post('/api/admin/reset-counter', requireAdmin, (req, res) => {
  const next = Math.max(0, Math.min(999999, Number(req.body?.value || 0)));
  store.counter = next;
  saveStore();
  res.json({ success: true, counter: store.counter });
});

app.get('/api/admin/printer-status', requireAdmin, async (req, res) => {
  try {
    const result = await feieRequest({
      apiname: 'Open_queryPrinterStatus',
      sn: FEIE_SN
    });
    res.json({ success: true, data: result.data });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message || String(error) });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ success: false, error: '系統發生錯誤，請稍後再試' });
});

ensureStore();
app.listen(PORT, () => {
  console.log('PEYSON Laser Live Print running on port ' + PORT);
});