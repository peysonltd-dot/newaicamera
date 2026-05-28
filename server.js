require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const Replicate = require('replicate');

const app = express();
const PORT = process.env.PORT || 10000;
const MODEL_VERSION = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-schnell';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN || '' });

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(__dirname));

const tasks = new Map();
let ticketCounter = 1;

function nextId() {
  return String(ticketCounter++).padStart(3, '0');
}

function nowText() {
  return new Date().toLocaleString('zh-TW', { hour12: false });
}

function buildPrompt(styleName = 'A') {
  const base = 'minimal Korean doodle sticker portrait, cute chibi avatar, big head small body, bean dot eyes, tiny nose, tiny mouth, soft pink blush, thick slightly rough black crayon outline, simple flat pastel colors, clean white background, upper body portrait, warm healing stationery sticker aesthetic, keep hairstyle glasses clothing color and overall face impression from the reference photo, not realistic, no 3d, no cinematic light, no detailed skin texture, no complex background';
  if (styleName === 'B') {
    return base + ', extra rounded shapes, softer kawaii expression, simpler facial features, hand drawn children book doodle feeling';
  }
  return base + ', balanced cute expression, clean marker line art, minimalist flat illustration';
}

async function generateOneImage(sourceImage, styleName) {
  const prompt = buildPrompt(styleName);
  const output = await replicate.run(MODEL_VERSION, {
    input: {
      prompt,
      image: sourceImage,
      prompt_strength: 0.72,
      num_outputs: 1,
      aspect_ratio: '1:1',
      output_format: 'png',
      output_quality: 90,
      num_inference_steps: 4,
      go_fast: true
    }
  });

  if (Array.isArray(output)) return String(output[0]);
  if (typeof output === 'string') return output;
  if (output && output.url) return String(output.url());
  return String(output);
}

async function processTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;

  try {
    if (!process.env.REPLICATE_API_TOKEN) {
      task.status = 'failed';
      task.error = 'Missing REPLICATE_API_TOKEN environment variable.';
      return;
    }

    task.status = 'generating';
    task.progress = 'AI 正在生成 A 款';
    const imageA = await generateOneImage(task.sourceImage, 'A');
    task.resultImageA = imageA;

    task.progress = 'AI 正在生成 B 款';
    const imageB = await generateOneImage(task.sourceImage, 'B');
    task.resultImageB = imageB;

    task.status = 'completed';
    task.progress = '完成，等待客戶選擇';
    task.completedAt = nowText();
  } catch (err) {
    console.error('Generate failed:', err);
    task.status = 'failed';
    task.error = err.message || String(err);
    task.progress = 'AI 生成失敗';
  }
}

app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/health', (req, res) => res.json({ ok: true, service: 'newaicamera', time: nowText() }));

app.post('/api/upload', async (req, res) => {
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ success: false, error: '未提供圖片資料' });

  const id = nextId();
  tasks.set(id, {
    id,
    sourceImage: image,
    resultImageA: null,
    resultImageB: null,
    chosenDesign: null,
    status: 'queued',
    progress: '已收到照片，等待 AI 生成',
    error: null,
    remark: '',
    createdAt: nowText()
  });

  res.json({ success: true, taskId: id });
  processTask(id);
});

app.get('/api/status/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '找不到任務' });
  res.json({
    success: true,
    id: task.id,
    status: task.status,
    progress: task.progress,
    error: task.error,
    resultImageA: task.resultImageA,
    resultImageB: task.resultImageB,
    chosenDesign: task.chosenDesign
  });
});

app.post('/api/choice/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '找不到任務' });
  const choice = req.body.choice === 'B' ? 'B' : 'A';
  task.chosenDesign = choice;
  task.progress = `客戶已選擇 ${choice} 款`;
  res.json({ success: true });
});

app.post('/api/admin/regenerate/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '找不到任務' });
  task.status = 'queued';
  task.resultImageA = null;
  task.resultImageB = null;
  task.chosenDesign = null;
  task.error = null;
  task.progress = '已重新加入生成佇列';
  res.json({ success: true });
  processTask(task.id);
});

app.post('/api/admin/update-meta/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '找不到任務' });
  if (typeof req.body.remark === 'string') task.remark = req.body.remark;
  if (typeof req.body.processStatus === 'string') task.processStatus = req.body.processStatus;
  res.json({ success: true });
});

app.get('/api/admin/all-tasks', (req, res) => {
  const all = Array.from(tasks.values()).sort((a, b) => b.id.localeCompare(a.id));
  res.json({ success: true, tasks: all });
});

app.listen(PORT, () => console.log(`newaicamera running on ${PORT}`));
