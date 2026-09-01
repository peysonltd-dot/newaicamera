(() => {
  const state = {
    password: sessionStorage.getItem('peysonLaserAdmin') || '',
    jobs: [],
    config: null,
    counter: 0,
    filter: 'all',
    tab: 'jobs',
    poller: null,
    fontFaces: new Map()
  };
  const $ = (selector) => document.querySelector(selector);

  function toast(message) {
    const el = $('#adminToast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function api(url, options = {}) {
    const headers = Object.assign({}, options.headers || {}, { 'x-admin-password': state.password });
    const response = await fetch(url, Object.assign({}, options, { headers }));
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : await response.blob();
    if (!response.ok || body.success === false) throw new Error(body.error || '連線失敗');
    return body;
  }

  async function login(password) {
    state.password = password;
    await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    sessionStorage.setItem('peysonLaserAdmin', password);
    $('#loginOverlay').classList.add('hidden');
    await Promise.all([loadJobs(), loadConfig()]);
    startPolling();
  }

  function statusName(status) {
    return { waiting: '等待製作', processing: '製作中', completed: '已完成', cancelled: '已取消' }[status] || status;
  }

  function printName(job) {
    if (job.printStatus === 'printed') return '票券已印';
    if (job.printStatus === 'failed') return '出票失敗：' + (job.printError || '');
    if (job.printStatus === 'printing' || job.printStatus === 'queued') return '出票中';
    return '未自動出票';
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleString('zh-TW', { hour12: false });
  }

  function filteredJobs() {
    const keyword = $('#jobSearch').value.trim().toLowerCase();
    return state.jobs.filter((job) => {
      const passFilter = state.filter === 'all' || job.status === state.filter;
      const passSearch = !keyword || job.id.toLowerCase().includes(keyword) || String(job.text || '').toLowerCase().includes(keyword);
      return passFilter && passSearch;
    });
  }

  function renderSummary() {
    $('#totalCount').textContent = state.jobs.filter((job) => job.status !== 'cancelled').length;
    $('#waitingCount').textContent = state.jobs.filter((job) => job.status === 'waiting').length;
    $('#processingCount').textContent = state.jobs.filter((job) => job.status === 'processing').length;
    $('#completedCount').textContent = state.jobs.filter((job) => job.status === 'completed').length;
  }

  function button(label, className, handler) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className || 'mini-button';
    el.textContent = label;
    el.addEventListener('click', handler);
    return el;
  }

  function renderJobs() {
    renderSummary();
    const list = $('#jobList');
    const jobs = filteredJobs();
    list.innerHTML = '';
    $('#emptyJobs').classList.toggle('hidden', jobs.length > 0);

    jobs.forEach((job) => {
      const card = document.createElement('article');
      card.className = 'job-card';

      const number = document.createElement('div');
      number.className = 'job-number';
      number.textContent = '#' + job.id;

      const meta = document.createElement('div');
      meta.className = 'job-meta';
      const title = document.createElement('strong');
      title.textContent = job.mode === 'handwriting' ? '手寫簽名' : (job.text || '文字雷雕');
      if (job.mode === 'typing' && job.fontId) title.title = '字體：' + job.fontId;
      const line1 = document.createElement('small');
      const handedness = job.handedness === 'left' ? '左撇子' : (job.handedness === 'right' ? '右撇子' : '未標示');
      line1.textContent = handedness + '・' + statusName(job.status) + '・' + formatTime(job.createdAt);
      const line2 = document.createElement('small');
      line2.textContent = printName(job);
      if (job.printStatus === 'failed') line2.className = 'print-failed';
      meta.append(title, line1, line2);

      if (job.thumbnail) {
        const image = document.createElement('img');
        image.src = job.thumbnail;
        image.alt = job.id + ' 預覽';
        image.style.cssText = 'width:100%;max-width:300px;height:58px;object-fit:contain;object-position:left center;margin-top:8px;border:1px solid #eee;border-radius:7px;background:#fafafa';
        meta.appendChild(image);
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      actions.appendChild(button('下載 PNG', 'mini-button dark', () => downloadPng(job)));
      if (job.status === 'processing') {
        actions.appendChild(button('標記完成', 'mini-button dark', () => updateJob(job.id, 'completed')));
      } else if (job.status === 'completed') {
        actions.appendChild(button('改回製作中', 'mini-button', () => updateJob(job.id, 'processing')));
      } else if (job.status === 'cancelled') {
        actions.appendChild(button('恢復等待', 'mini-button', () => updateJob(job.id, 'waiting')));
      }
      if (job.status !== 'cancelled') {
        actions.appendChild(button('補印票券', 'mini-button', () => reprint(job.id)));
        actions.appendChild(button('取消訂單', 'mini-button danger-text', () => cancelJob(job.id)));
      }

      card.append(number, meta, actions);
      list.appendChild(card);
    });
  }

  async function loadJobs(silent = false) {
    try {
      const result = await api('/api/admin/jobs');
      state.jobs = result.jobs;
      state.counter = result.counter;
      $('#counterInput').value = state.counter;
      renderJobs();
    } catch (error) {
      if (!silent) toast(error.message);
      if (/密碼|401/.test(error.message)) logout();
    }
  }

  async function updateJob(id, status) {
    try {
      await api('/api/admin/jobs/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status })
      });
      await loadJobs(true);
    } catch (error) { toast(error.message); }
  }

  async function reprint(id) {
    try {
      await api('/api/admin/jobs/' + id + '/reprint', { method: 'POST' });
      toast('已送出補印指令');
      setTimeout(() => loadJobs(true), 1200);
    } catch (error) { toast(error.message); }
  }

  async function cancelJob(id) {
    if (!window.confirm('確定要取消訂單 #' + id + '？取消後資料仍會保留於後台。')) return;
    try {
      await api('/api/admin/jobs/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' })
      });
      toast('訂單 #' + id + ' 已取消');
      await loadJobs(true);
    } catch (error) { toast(error.message); }
  }

  async function downloadPng(job) {
    try {
      const blob = await api('/api/admin/jobs/' + job.id + '/file/png');
      if (job.status === 'waiting') {
        await api('/api/admin/jobs/' + job.id, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'processing' })
        });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = job.id + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (job.status === 'waiting') toast('PNG 已下載，狀態已改為製作中');
      await loadJobs(true);
    } catch (error) { toast(error.message); }
  }

  async function registerFonts(fonts) {
    for (const font of fonts) {
      if (!font.data || state.fontFaces.has(font.id)) continue;
      try {
        const face = new FontFace(font.family, 'url(' + font.data + ')');
        await face.load();
        document.fonts.add(face);
        state.fontFaces.set(font.id, face);
      } catch (error) { console.warn(error); }
    }
  }

  function fillSettings() {
    const form = $('#settingsForm');
    const c = state.config;
    form.eventName.value = c.eventName;
    form.eventSubtitle.value = c.eventSubtitle;
    form.modeHandwriting.checked = c.modes.includes('handwriting');
    form.modeTyping.checked = c.modes.includes('typing');
    form.maxChars.value = c.maxChars;
    form.canvasRatio.value = c.canvasRatio;
    form.outputWidth.value = c.outputWidth;
    form.ticketPrefix.value = c.ticketPrefix || '';
    form.ticketMessage.value = c.ticketMessage || '';
    form.autoPrint.checked = Boolean(c.autoPrint);
    $('#counterInput').value = state.counter;
  }

  function renderAdminFonts() {
    const wrap = $('#adminFontList');
    wrap.innerHTML = '';
    state.config.fonts.forEach((font) => {
      const row = document.createElement('div');
      row.className = 'admin-font-item';
      const preview = document.createElement('div');
      preview.className = 'admin-font-preview';
      preview.style.fontFamily = font.family;
      preview.textContent = font.name + '｜現場雷雕 Aa';
      row.appendChild(preview);
      if (!font.builtIn) {
        row.appendChild(button('刪除', 'mini-button danger-text', () => deleteFont(font.id)));
      } else {
        const tag = document.createElement('small');
        tag.textContent = '內建';
        row.appendChild(tag);
      }
      wrap.appendChild(row);
    });
  }

  async function loadConfig() {
    try {
      const result = await api('/api/admin/config');
      state.config = result.config;
      $('#printerStatusText').textContent = result.printerConfigured ? '已完成環境設定' : '尚未設定出票機';
      await registerFonts(state.config.fonts);
      fillSettings();
      renderAdminFonts();
    } catch (error) { toast(error.message); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const modes = [];
    if (form.modeHandwriting.checked) modes.push('handwriting');
    if (form.modeTyping.checked) modes.push('typing');
    if (!modes.length) return toast('至少需要開啟一種功能');

    try {
      const result = await api('/api/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventName: form.eventName.value,
          eventSubtitle: form.eventSubtitle.value,
          modes,
          maxChars: Number(form.maxChars.value),
          canvasRatio: Number(form.canvasRatio.value),
          outputWidth: Number(form.outputWidth.value),
          ticketPrefix: form.ticketPrefix.value,
          ticketMessage: form.ticketMessage.value,
          autoPrint: form.autoPrint.checked
        })
      });
      state.config = result.config;
      fillSettings();
      toast('場次設定已儲存');
    } catch (error) { toast(error.message); }
  }

  async function resetCounter() {
    const value = Number($('#counterInput').value || 0);
    if (!confirm('確定將目前流水號改為 ' + value + '？下一筆會從 ' + String(value + 1).padStart(3, '0') + ' 開始。')) return;
    try {
      const result = await api('/api/admin/reset-counter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value })
      });
      state.counter = result.counter;
      toast('流水號已更新');
    } catch (error) { toast(error.message); }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('檔案讀取失敗'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadFont(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = $('#fontFileInput').files[0];
    const name = $('#fontNameInput').value.trim();
    if (!file || !name) return;
    try {
      const data = await fileToDataUrl(file);
      await api('/api/admin/fonts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, data, mime: file.type })
      });
      form.reset();
      await loadConfig();
      toast('字體已上傳');
    } catch (error) { toast(error.message); }
  }

  async function deleteFont(id) {
    if (!confirm('確定刪除這個字體？')) return;
    try {
      await api('/api/admin/fonts/' + id, { method: 'DELETE' });
      await loadConfig();
      toast('字體已刪除');
    } catch (error) { toast(error.message); }
  }

  async function printerStatus() {
    $('#printerStatusText').textContent = '檢查中…';
    try {
      const result = await api('/api/admin/printer-status');
      $('#printerStatusText').textContent = '出票機狀態：' + String(result.data);
    } catch (error) {
      $('#printerStatusText').textContent = error.message;
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.admin-tab').forEach((section) => section.classList.add('hidden'));
    $('#' + tab + 'Tab').classList.remove('hidden');
  }

  function startPolling() {
    clearInterval(state.poller);
    state.poller = setInterval(() => {
      if (state.tab === 'jobs' && !document.hidden) loadJobs(true);
    }, 3000);
  }

  function logout() {
    clearInterval(state.poller);
    sessionStorage.removeItem('peysonLaserAdmin');
    state.password = '';
    $('#passwordInput').value = '';
    $('#loginOverlay').classList.remove('hidden');
  }

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#loginError').textContent = '';
    try { await login($('#passwordInput').value); }
    catch (error) { $('#loginError').textContent = error.message; }
  });
  $('#logoutButton').addEventListener('click', logout);
  $('#refreshButton').addEventListener('click', () => Promise.all([loadJobs(), loadConfig()]));
  document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  document.querySelectorAll('.filter-button').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter-button').forEach((item) => item.classList.toggle('active', item === button));
    renderJobs();
  }));
  $('#jobSearch').addEventListener('input', renderJobs);
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#resetCounterButton').addEventListener('click', resetCounter);
  $('#fontUploadForm').addEventListener('submit', uploadFont);
  $('#printerStatusButton').addEventListener('click', printerStatus);

  if (state.password) {
    login(state.password).catch(() => logout());
  }
})();