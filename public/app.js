(() => {
  const state = {
    config: null,
    mode: null,
    handedness: null,
    strokes: [],
    redo: [],
    drawing: false,
    activeStroke: null,
    strokeWidth: 10,
    fontId: null,
    fontsLoaded: new Map(),
    submitting: false
  };

  const $ = (selector) => document.querySelector(selector);
  const canvas = $('#designCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const stage = $('#canvasStage');

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || '連線失敗');
    return body;
  }

  function currentFont() {
    return state.config.fonts.find((font) => font.id === state.fontId) || state.config.fonts[0];
  }

  async function loadFonts(fonts) {
    for (const font of fonts) {
      if (!font.data || state.fontsLoaded.has(font.id)) continue;
      try {
        const face = new FontFace(font.family, 'url(' + font.data + ')');
        await face.load();
        document.fonts.add(face);
        state.fontsLoaded.set(font.id, face);
      } catch (error) {
        console.warn('Font load failed:', font.name, error);
      }
    }
  }

  function activeCanvasRatio() {
    const ratio = Number(state.config?.canvasRatio || 5);
    return state.mode === 'handwriting' ? ratio / 1.3 : ratio;
  }

  function configureCanvas() {
    const ratio = activeCanvasRatio();
    stage.style.setProperty('--canvas-ratio', String(ratio));
    const box = stage.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function clearVisual(context, width, height) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.restore();
  }

  function strokePath(context, points, width, height, lineWidth) {
    if (!points || points.length === 0) return;
    context.beginPath();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#000';
    context.lineWidth = lineWidth;

    const first = points[0];
    context.moveTo(first.x * width, first.y * height);
    if (points.length === 1) {
      context.lineTo(first.x * width + .01, first.y * height + .01);
    } else if (points.length === 2) {
      context.lineTo(points[1].x * width, points[1].y * height);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const point = points[i];
        const next = points[i + 1];
        const midX = (point.x + next.x) * width / 2;
        const midY = (point.y + next.y) * height / 2;
        context.quadraticCurveTo(point.x * width, point.y * height, midX, midY);
      }
      const last = points[points.length - 1];
      context.lineTo(last.x * width, last.y * height);
    }
    context.stroke();
  }

  function drawTyping(context, width, height) {
    const text = $('#textInput').value.trim();
    if (!text) return;
    const font = currentFont();
    const family = font?.family || 'sans-serif';
    let size = height * .62;
    context.save();
    context.fillStyle = '#000';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    while (size > 10) {
      context.font = '700 ' + size + 'px ' + family;
      if (context.measureText(text).width <= width * .9) break;
      size -= Math.max(1, height * .015);
    }
    context.fillText(text, width / 2, height / 2 + height * .015);
    context.restore();
  }

  function redraw() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    clearVisual(ctx, canvas.width, canvas.height);

    if (state.mode === 'handwriting') {
      state.strokes.forEach((stroke) => strokePath(ctx, stroke.points, width, height, stroke.width));
      if (state.activeStroke) strokePath(ctx, state.activeStroke.points, width, height, state.activeStroke.width);
      $('#emptyHint').classList.toggle('hidden', state.strokes.length > 0 || Boolean(state.activeStroke));
    } else if (state.mode === 'typing') {
      drawTyping(ctx, width, height);
      $('#emptyHint').classList.toggle('hidden', Boolean($('#textInput').value.trim()));
    }
    updateButtons();
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: Number(event.pressure || .5),
      time: performance.now()
    };
  }

  function addPoint(event) {
    if (!state.activeStroke) return;
    const point = canvasPoint(event);
    const last = state.activeStroke.points.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > .0012) {
      state.activeStroke.points.push(point);
    }
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'handwriting' || state.submitting) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    state.drawing = true;
    state.redo = [];
    state.activeStroke = { width: state.strokeWidth, points: [] };
    addPoint(event);
    redraw();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!state.drawing || state.mode !== 'handwriting') return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    events.forEach(addPoint);
    redraw();
  });

  function finishStroke(event) {
    if (!state.drawing) return;
    event.preventDefault();
    if (state.activeStroke?.points.length) state.strokes.push(state.activeStroke);
    state.activeStroke = null;
    state.drawing = false;
    redraw();
  }

  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  function updateButtons() {
    $('#undoButton').disabled = state.strokes.length === 0;
    $('#redoButton').disabled = state.redo.length === 0;
    const hasContent = state.mode === 'handwriting'
      ? state.strokes.length > 0
      : Boolean($('#textInput').value.trim());
    $('#submitButton').disabled = !hasContent || state.submitting;
  }

  function renderHandednessChoices() {
    document.querySelectorAll('.handedness-button').forEach((button) => {
      const selected = button.dataset.handedness === state.handedness;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function renderModeChoices() {
    document.querySelectorAll('.mode-card').forEach((button) => {
      button.classList.toggle('hidden', !state.config.modes.includes(button.dataset.mode));
      button.disabled = !state.handedness;
    });
    if (state.handedness && state.config.modes.length === 1) selectMode(state.config.modes[0]);
  }

  function renderWidths() {
    const wrap = $('#widthChoices');
    wrap.innerHTML = '';
    const labels = [
      { zh: '細', en: 'Thin' },
      { zh: '中', en: 'Medium' },
      { zh: '粗', en: 'Thick' },
      { zh: '特粗', en: 'Extra' }
    ];
    state.config.handwritingWidths.forEach((width, index) => {
      const button = document.createElement('button');
      const label = labels[index] || { zh: String(width), en: '' };
      button.type = 'button';
      button.className = 'bilingual-button';
      const main = document.createElement('span');
      main.className = 'button-main';
      main.textContent = label.zh;
      button.appendChild(main);
      if (label.en) {
        const english = document.createElement('small');
        english.className = 'button-en';
        english.textContent = label.en;
        button.appendChild(english);
      }
      button.classList.toggle('active', Number(width) === Number(state.strokeWidth));
      button.addEventListener('click', () => {
        state.strokeWidth = Number(width);
        renderWidths();
      });
      wrap.appendChild(button);
    });
  }

  function renderFontChoices() {
    const wrap = $('#fontChoices');
    wrap.innerHTML = '';
    state.config.fonts.forEach((font) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'font-choice' + (font.id === state.fontId ? ' active' : '');
      button.style.fontFamily = font.family;
      const preview = document.createElement('b');
      preview.textContent = 'Aa 字體';
      const name = document.createElement('small');
      name.textContent = font.name;
      button.append(preview, name);
      button.addEventListener('click', () => {
        state.fontId = font.id;
        renderFontChoices();
        redraw();
      });
      wrap.appendChild(button);
    });
  }

  function selectMode(mode) {
    if (!state.handedness) return showToast('請先選擇左撇子或右撇子');
    state.mode = mode;
    state.strokes = [];
    state.redo = [];
    state.activeStroke = null;
    $('#textInput').value = '';
    $('#charCounter').textContent = '0 / ' + state.config.maxChars;
    $('#modeStep').classList.add('hidden');
    $('#editorStep').classList.remove('hidden');
    $('#handwritingTools').classList.toggle('hidden', mode !== 'handwriting');
    $('#typingTools').classList.toggle('hidden', mode !== 'typing');
    $('#editorTitle').textContent = mode === 'handwriting' ? '寫下簽名或圖案' : '輸入雷雕文字';
    $('#emptyHint').innerHTML = mode === 'handwriting'
      ? '<b>請在框內書寫</b><span>建議簽名盡量寫大、筆畫不要重疊</span>'
      : '<b>請先輸入文字</b><span>系統會自動置中並調整大小</span>';
    requestAnimationFrame(configureCanvas);
  }

  function resetToMode(clearHandedness = false) {
    state.mode = null;
    state.strokes = [];
    state.redo = [];
    if (clearHandedness) state.handedness = null;
    $('#editorStep').classList.add('hidden');
    $('#successStep').classList.add('hidden');
    $('#modeStep').classList.remove('hidden');
    renderHandednessChoices();
    renderModeChoices();
  }

  function createOutput(width) {
    const ratio = activeCanvasRatio();
    const output = document.createElement('canvas');
    output.width = Math.round(width);
    output.height = Math.max(1, Math.round(width / ratio));
    const out = output.getContext('2d', { alpha: true });
    out.clearRect(0, 0, output.width, output.height);
    if (state.mode === 'handwriting') {
      const visualWidth = Math.max(1, canvas.getBoundingClientRect().width);
      state.strokes.forEach((stroke) => {
        const scaledWidth = stroke.width * output.width / visualWidth;
        strokePath(out, stroke.points, output.width, output.height, scaledWidth);
      });
    } else {
      drawTyping(out, output.width, output.height);
    }
    return output.toDataURL('image/png');
  }

  function svgPath(points, width, height) {
    if (!points.length) return '';
    let value = 'M ' + (points[0].x * width).toFixed(2) + ' ' + (points[0].y * height).toFixed(2);
    if (points.length === 1) {
      return value + ' l .01 .01';
    }
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i];
      const next = points[i + 1];
      value += ' Q ' + (point.x * width).toFixed(2) + ' ' + (point.y * height).toFixed(2);
      value += ' ' + (((point.x + next.x) / 2) * width).toFixed(2) + ' ' + (((point.y + next.y) / 2) * height).toFixed(2);
    }
    const last = points.at(-1);
    return value + ' L ' + (last.x * width).toFixed(2) + ' ' + (last.y * height).toFixed(2);
  }

  function createSvg() {
    if (state.mode !== 'handwriting') return '';
    const width = Number(state.config.outputWidth || 2000);
    const height = Math.round(width / activeCanvasRatio());
    const visualWidth = Math.max(1, canvas.getBoundingClientRect().width);
    const paths = state.strokes.map((stroke) => {
      const lineWidth = (stroke.width * width / visualWidth).toFixed(2);
      return '<path d="' + svgPath(stroke.points, width, height) + '" fill="none" stroke="#000" stroke-width="' + lineWidth + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + paths + '</svg>';
  }

  async function submit() {
    if (state.submitting) return;
    const hasContent = state.mode === 'handwriting'
      ? state.strokes.length > 0
      : Boolean($('#textInput').value.trim());
    if (!hasContent) return showToast(state.mode === 'typing' ? '請先輸入文字' : '請先寫下簽名');

    state.submitting = true;
    updateButtons();
    $('#loadingOverlay').classList.remove('hidden');

    try {
      const body = {
        mode: state.mode,
        handedness: state.handedness,
        text: state.mode === 'typing' ? $('#textInput').value.trim() : '',
        fontId: state.fontId || '',
        strokeWidth: state.strokeWidth,
        png: createOutput(Number(state.config.outputWidth || 2000)),
        thumbnail: createOutput(600),
        svg: createSvg()
      };
      const result = await request('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      $('#editorStep').classList.add('hidden');
      $('#successStep').classList.remove('hidden');
      $('#ticketNumber').textContent = result.job.displayNumber;
      $('#printMessage').textContent = state.config.autoPrint
        ? '票券將由出票機自動印出，請妥善保留。'
        : '請記住此號碼，完成後依號碼取件。';
    } catch (error) {
      showToast(error.message);
    } finally {
      state.submitting = false;
      $('#loadingOverlay').classList.add('hidden');
      updateButtons();
    }
  }

  async function init() {
    try {
      const result = await request('/api/config');
      state.config = result.config;
      state.strokeWidth = Number(state.config.defaultHandwritingWidth || state.config.handwritingWidths[1] || 10);
      state.fontId = state.config.fonts[0]?.id || null;
      $('#eventName').textContent = state.config.eventName;
      $('#eventSubtitle').textContent = state.config.eventSubtitle;
      $('#textInput').maxLength = Number(state.config.maxChars);
      await loadFonts(state.config.fonts);
      renderHandednessChoices();
      renderModeChoices();
      renderWidths();
      renderFontChoices();
      configureCanvas();
    } catch (error) {
      showToast('系統載入失敗：' + error.message);
    }
  }

  document.querySelectorAll('.handedness-button').forEach((button) => {
    button.addEventListener('click', () => {
      state.handedness = button.dataset.handedness;
      renderHandednessChoices();
      renderModeChoices();
    });
  });
  document.querySelectorAll('.mode-card').forEach((button) => {
    button.addEventListener('click', () => selectMode(button.dataset.mode));
  });
  $('#backButton').addEventListener('click', () => resetToMode(false));
  $('#newOrderButton').addEventListener('click', () => resetToMode(true));
  $('#undoButton').addEventListener('click', () => {
    const stroke = state.strokes.pop();
    if (stroke) state.redo.push(stroke);
    redraw();
  });
  $('#redoButton').addEventListener('click', () => {
    const stroke = state.redo.pop();
    if (stroke) state.strokes.push(stroke);
    redraw();
  });
  $('#clearButton').addEventListener('click', () => {
    state.strokes = [];
    state.redo = [];
    redraw();
  });
  $('#textInput').addEventListener('input', () => {
    const max = Number(state.config.maxChars);
    if ($('#textInput').value.length > max) $('#textInput').value = $('#textInput').value.slice(0, max);
    $('#charCounter').textContent = $('#textInput').value.length + ' / ' + max;
    redraw();
  });
  $('#submitButton').addEventListener('click', submit);
  window.addEventListener('resize', () => {
    clearTimeout(configureCanvas.timer);
    configureCanvas.timer = setTimeout(configureCanvas, 120);
  });

  init();
})();