/**
 * API Runner — app.js
 * Three modes: Single (one request), Bulk File (upload CSV/JSON), Bulk Paste (paste data)
 * SSE streaming, live logs, copy-button fix, bulk-row body isolation.
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────
const state = {
  dataRows:    [],
  isRunning:   false,
  abortFlag:   false,
  bodyType:    'none',
  mode:        'single',   // 'single' | 'bulk'
  dataSource:  'upload',   // 'upload' | 'paste'
  successCount: 0,
  failureCount: 0,
  total:       0,
};

// ─── DOM ───────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);

const urlInput      = $('url-input');
const methodSelect  = $('method-select');
const headersList   = $('headers-list');
const paramsList    = $('params-list');
const bodyFormList  = $('body-form-list');
const bodyRawInput  = $('body-raw-input');
const bodyJsonError = $('body-json-error');
const dropZone      = $('drop-zone');
const fileInput     = $('file-input');
const fileMeta      = $('file-meta');
const fileError     = $('file-error');
const dataPreview   = $('data-preview');
const delayInput    = $('delay-input');
const stopOnError   = $('stop-on-error');
const launchBtn     = $('launch-btn');
const abortBtn      = $('abort-btn');
const launchLabel   = $('launch-label');
const logContainer  = $('log-container');
const statTotal     = $('stat-total');
const statSuccess   = $('stat-success');
const statFail      = $('stat-fail');
const progressFill  = $('progress-bar-fill');
const progressLabel = $('progress-label');
const progressPct   = $('progress-pct');
const runStatus     = $('run-status');
const liveDot       = $('live-dot');

// ─── Left panel tabs ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn[data-group="left"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn[data-group="left"]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['hdr', 'params', 'body'].forEach(id => {
      const panel = $(`tab-${id}`);
      if (panel) panel.classList.toggle('active', id === btn.dataset.tab);
    });
  });
});

// ─── KV Row Factory ────────────────────────────────────────────────────────────
function addKVRow(container, keyPh = 'Key', valPh = 'Value {{var}}') {
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML = `
    <input class="kv-input kv-key"   type="text" placeholder="${keyPh}" />
    <input class="kv-input kv-value" type="text" placeholder="${valPh}" />
    <button class="btn-remove" title="Remove">✕</button>
  `;
  row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

addKVRow(headersList, 'Content-Type', 'application/json');
$('add-header').addEventListener('click',     () => addKVRow(headersList));
$('add-param').addEventListener('click',      () => addKVRow(paramsList));
$('add-form-field').addEventListener('click', () => addKVRow(bodyFormList, 'Field', 'Value'));

function collectKV(container) {
  const result = {};
  container.querySelectorAll('.kv-row').forEach(row => {
    const key = row.querySelector('.kv-key')?.value.trim();
    const val = row.querySelector('.kv-value')?.value.trim();
    if (key) result[key] = val || '';
  });
  return result;
}

// ─── Body Type Switcher ────────────────────────────────────────────────────────
document.querySelectorAll('.body-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.body-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.bodyType = btn.dataset.body;
    document.querySelectorAll('.body-section').forEach(s => s.style.display = 'none');
    $(`body-${state.bodyType}`).style.display = 'block';
  });
});

// ─── Live JSON Validation ──────────────────────────────────────────────────────
bodyRawInput.addEventListener('input', () => {
  const raw = bodyRawInput.value.trim();
  if (!raw) { bodyJsonError.style.display = 'none'; return; }
  const stripped = raw.replace(/\{\{[\w]+\}\}/g, '"__x__"');
  try {
    JSON.parse(stripped);
    bodyJsonError.style.display = 'none';
    bodyRawInput.classList.remove('field-error');
  } catch (e) {
    bodyJsonError.textContent = `⚠ JSON Error: ${e.message}`;
    bodyJsonError.style.display = 'block';
    bodyRawInput.classList.add('field-error');
  }
});

// ─── Mode Switcher (Single / Bulk) ────────────────────────────────────────────
const modeSingleBtn   = $('mode-single');
const modeBulkBtn     = $('mode-bulk');
const singleNotice    = $('single-mode-notice');
const bulkDataPanel   = $('bulk-data-panel');

function setMode(mode) {
  state.mode = mode;
  const isBulk = mode === 'bulk';
  modeSingleBtn.style.background = !isBulk ? 'var(--accent)' : 'transparent';
  modeSingleBtn.style.color      = !isBulk ? 'white' : 'var(--muted)';
  modeBulkBtn.style.background   =  isBulk ? 'var(--accent)' : 'transparent';
  modeBulkBtn.style.color        =  isBulk ? 'white' : 'var(--muted)';
  singleNotice.style.display  = isBulk ? 'none'  : 'block';
  bulkDataPanel.style.display = isBulk ? 'block' : 'none';
  updateLaunchState();
}

modeSingleBtn.addEventListener('click', () => setMode('single'));
modeBulkBtn.addEventListener('click',   () => setMode('bulk'));

// ─── Data Source Sub-Tabs (Upload / Paste) ────────────────────────────────────
const datasrcUploadBtn  = $('datasrc-upload-btn');
const datasrcPasteBtn   = $('datasrc-paste-btn');
const datasrcUploadPane = $('datasrc-upload');
const datasrcPastePane  = $('datasrc-paste');

function setDataSource(src) {
  state.dataSource = src;
  const isUpload = src === 'upload';
  datasrcUploadBtn.classList.toggle('active', isUpload);
  datasrcPasteBtn.classList.toggle('active',  !isUpload);
  datasrcUploadPane.style.display = isUpload ? 'block' : 'none';
  datasrcPastePane.style.display  = isUpload ? 'none'  : 'block';
}

datasrcUploadBtn.addEventListener('click', () => setDataSource('upload'));
datasrcPasteBtn.addEventListener('click',  () => setDataSource('paste'));

// ─── Paste-to-Parse ────────────────────────────────────────────────────────────
$('parse-paste-btn').addEventListener('click', async () => {
  const raw = $('paste-input').value.trim();
  if (!raw) return;
  const fileType = raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{') ? 'json' : 'csv';
  fileError.style.display = 'none';
  try {
    const res  = await fetch(`/api/parse-file?fileType=${fileType}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: raw,
    });
    const data = await res.json();
    if (!data.ok) { showFileError(`Parse error: ${data.error}`); return; }
    applyParsedData(data, `pasted ${fileType.toUpperCase()}`);
  } catch (err) {
    showFileError(`Parse error: ${err.message}`);
  }
});

// ─── File Upload + Drag & Drop ────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0]; if (file) handleFile(file);
});
fileInput.addEventListener('change', e => { const file = e.target.files[0]; if (file) handleFile(file); });

async function handleFile(file) {
  fileError.style.display = 'none';
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['json', 'csv'].includes(ext)) { showFileError('Only .json and .csv files are supported.'); return; }
  const raw = await file.text();
  try {
    const res  = await fetch(`/api/parse-file?fileType=${ext}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: raw,
    });
    const data = await res.json();
    if (!data.ok) { showFileError(`Parse error: ${data.error}`); return; }
    applyParsedData(data, file.name);
  } catch (err) {
    showFileError(`Network error: ${err.message}`);
  }
}

function applyParsedData(data, label) {
  state.dataRows = data.rows;
  $('file-name-badge').textContent = label;
  $('file-rows-badge').textContent = `${data.count} row${data.count !== 1 ? 's' : ''}`;
  $('file-keys-badge').textContent = `Keys: ${data.keys.join(', ')}`;
  fileMeta.style.display = 'block';
  renderVarHints(data.keys);
  renderPreviewTable(data.rows, data.keys);
  updateLaunchState();
}

function showFileError(msg) {
  fileError.textContent   = `⚠ ${msg}`;
  fileError.style.display = 'block';
  state.dataRows = [];
  updateLaunchState();
}

$('clear-file-btn').addEventListener('click', () => {
  state.dataRows = [];
  fileMeta.style.display  = 'none';
  fileError.style.display = 'none';
  dataPreview.innerHTML   = '';
  fileInput.value         = '';
  $('file-name-badge').textContent = '';
  $('file-rows-badge').textContent = '';
  $('file-keys-badge').textContent = '';
  const vh = $('var-hints'); if (vh) vh.remove();
  updateLaunchState();
});

// ─── Variable Hint Chips ───────────────────────────────────────────────────────
function renderVarHints(keys) {
  let hint = $('var-hints');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'var-hints';
    hint.style.cssText = 'margin-top:10px;padding:10px 12px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.2);border-radius:8px;';
    fileMeta.parentNode.insertBefore(hint, fileMeta.nextSibling);
  }
  hint.innerHTML = `
    <div style="font-size:10px;color:var(--accent);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:7px;">Available variables — click to copy</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${keys.map(k => `<span onclick="copyVar('{{${k}}}')" style="background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.3);color:#fdba74;font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer;user-select:none;" onmouseenter="this.style.background='rgba(249,115,22,0.25)'" onmouseleave="this.style.background='rgba(249,115,22,0.12)'">{{${k}}}</span>`).join('')}
    </div>`;
}

window.copyVar = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    urlInput.style.borderColor = 'var(--accent)';
    urlInput.style.boxShadow   = '0 0 0 2px rgba(249,115,22,0.3)';
    setTimeout(() => { urlInput.style.borderColor = ''; urlInput.style.boxShadow = ''; }, 800);
  } catch {}
};

// ─── Preview Table ─────────────────────────────────────────────────────────────
function renderPreviewTable(rows, keys) {
  const MAX = 50;
  const preview = rows.slice(0, MAX);
  const table = document.createElement('table');
  table.innerHTML =
    `<thead><tr>${keys.map(k => `<th>${escHtml(k)}</th>`).join('')}</tr></thead>` +
    `<tbody>${preview.map(row => `<tr>${keys.map(k => `<td title="${escHtml(String(row[k]??''))}">${escHtml(String(row[k]??''))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  dataPreview.innerHTML = '';
  dataPreview.appendChild(table);
  if (rows.length > MAX) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:11px;color:var(--muted);margin-top:6px;font-family:monospace;';
    note.textContent = `… and ${rows.length - MAX} more rows`;
    dataPreview.appendChild(note);
  }
}

// ─── Launch State Gate ─────────────────────────────────────────────────────────
function updateLaunchState() {
  const hasUrl  = urlInput.value.trim().length > 0;
  const hasBulk = state.dataRows.length > 0;
  const ready   = hasUrl && (state.mode === 'single' || hasBulk);
  launchBtn.disabled = !ready || state.isRunning;
  launchLabel.textContent = state.isRunning
    ? '⏳ RUNNING…'
    : state.mode === 'single' ? '⚡ LAUNCH' : '⚡ LAUNCH BULK RUN';
}

urlInput.addEventListener('input', updateLaunchState);

// ─── Launch ────────────────────────────────────────────────────────────────────
launchBtn.addEventListener('click', startRun);
abortBtn.addEventListener('click', () => {
  state.abortFlag = true;
  appendLog({ type: 'info', message: '⛔ Run aborted by user.' });
  setRunningState(false);
});

async function startRun() {
  if (state.isRunning) return;
  if (state.mode === 'bulk' && state.dataRows.length === 0) return;

  // Validate JSON body
  if (state.bodyType === 'json') {
    const raw      = bodyRawInput.value.trim();
    const stripped = raw.replace(/\{\{[\w]+\}\}/g, '"__x__"');
    try { if (raw) JSON.parse(stripped); }
    catch (e) {
      bodyJsonError.textContent   = `⚠ Fix JSON before running: ${e.message}`;
      bodyJsonError.style.display = 'block';
      return;
    }
  }

  state.successCount = 0;
  state.failureCount = 0;
  state.abortFlag    = false;
  logContainer.innerHTML = '';
  resetProgress();
  setRunningState(true);

  // ── Determine rows and body for the mode ──────────────────────────────────
  // Single mode: one synthetic empty row, use left-panel body as-is
  // Bulk mode:   each data row IS the body (bulk-row), left-panel body is ignored
  const rows = state.mode === 'single' ? [{}] : state.dataRows;

  let effectiveBodyType, effectiveBodyRaw, effectiveBodyForm;
  if (state.mode === 'bulk') {
    // Body comes from the data rows directly — ignore the left-panel body textarea
    effectiveBodyType = 'bulk-row';
    effectiveBodyRaw  = '';
    effectiveBodyForm = {};
  } else {
    effectiveBodyType = state.bodyType;
    effectiveBodyRaw  = state.bodyType === 'json' ? bodyRawInput.value.trim() : '';
    effectiveBodyForm = state.bodyType === 'form' ? collectKV(bodyFormList) : {};
  }

  state.total = rows.length;

  const payload = {
    url:         urlInput.value.trim(),
    method:      methodSelect.value,
    headers:     collectKV(headersList),
    params:      collectKV(paramsList),
    bodyType:    effectiveBodyType,
    bodyRaw:     effectiveBodyRaw,
    bodyForm:    effectiveBodyForm,
    dataRows:    rows,
    delay:       parseInt(delayInput.value, 10) || 0,
    stopOnError: stopOnError.checked,
  };

  try {
    const response = await fetch('/api/execute-runner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      appendLog({ type: 'info', message: `❌ Server rejected: ${response.statusText}` });
      setRunningState(false); return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      if (state.abortFlag) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try { handleSSEEvent(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  } catch (err) {
    if (!state.abortFlag) appendLog({ type: 'info', message: `❌ Connection error: ${err.message}` });
  } finally {
    setRunningState(false);
  }
}

// ─── SSE Event Dispatcher ──────────────────────────────────────────────────────
function handleSSEEvent(event) {
  switch (event.type) {
    case 'START':
      statTotal.textContent     = event.total;
      progressLabel.textContent = `Running ${event.total} request${event.total !== 1 ? 's' : ''}…`;
      break;
    case 'ROW_RESULT':
      state.successCount = event.successCount;
      state.failureCount = event.failureCount;
      updateStats(event.successCount, event.failureCount, event.total);
      updateProgress(event.index + 1, event.total);
      appendResultLog(event);
      break;
    case 'ROW_ERROR':
      state.failureCount = event.failureCount ?? (state.failureCount + 1);
      updateStats(event.successCount ?? state.successCount, event.failureCount, event.total);
      updateProgress((event.index ?? 0) + 1, event.total);
      appendErrorLog(event);
      break;
    case 'STOPPED':
      appendLog({ type: 'info', message: `⛔ Stopped: ${event.reason}` });
      break;
    case 'DONE':
      progressFill.style.width  = '100%';
      progressPct.textContent   = '100%';
      progressLabel.textContent = `Done — ${event.successCount} passed, ${event.failureCount} failed`;
      break;
  }
}

// ─── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width  = `${pct}%`;
  progressPct.textContent   = `${pct}%`;
  progressLabel.textContent = `${done} / ${total} completed`;
}

function resetProgress() {
  progressFill.style.width  = '0%';
  progressPct.textContent   = '0%';
  progressLabel.textContent = 'Starting…';
  statTotal.textContent     = state.total;
  statSuccess.textContent   = '0';
  statFail.textContent      = '0';
}

function updateStats(success, fail, total) {
  statTotal.textContent   = total;
  statSuccess.textContent = success;
  statFail.textContent    = fail;
}

// ─── Running State ─────────────────────────────────────────────────────────────
function setRunningState(running) {
  state.isRunning = running;
  launchBtn.disabled = running;
  launchBtn.classList.toggle('running', running);
  launchLabel.textContent = running ? '⏳ RUNNING…'
    : state.mode === 'single' ? '⚡ LAUNCH' : '⚡ LAUNCH BULK RUN';
  abortBtn.style.display = running ? 'block' : 'none';
  runStatus.textContent  = running ? 'RUNNING' : 'IDLE';
  runStatus.style.color  = running ? 'var(--green)' : 'var(--muted)';
  liveDot.style.display  = running ? 'inline' : 'none';
}

// ─── Log Renderers ─────────────────────────────────────────────────────────────
function ensureLogActive() {
  const empty = $('empty-state'); if (empty) empty.remove();
}

function appendResultLog(event) {
  ensureLogActive();
  const cls        = event.isSuccess ? 'success' : 'failure';
  const statusCls  = getStatusClass(event.status);
  const rowPreview = Object.keys(event.row).length
    ? Object.entries(event.row).map(([k,v]) => `${k}=${v}`).join(' · ')
    : 'single request';
  const responseStr = JSON.stringify(event.data, null, 2);
  const jsonId      = `json-${event.index}`;

  const errorBanner = !event.isSuccess ? `
    <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:7px 10px;margin-bottom:6px;font-size:11px;color:#f87171;">
      ⚠ API returned <b>${event.status}</b> — response body below
    </div>` : '';

  const entry = document.createElement('div');
  entry.className = `log-entry ${cls}`;
  entry.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span class="log-status-badge ${statusCls}">${event.status} ${event.statusText || ''}</span>
      <span style="color:var(--muted);font-size:10px;">#${event.index + 1}</span>
      <span style="color:var(--text-dim);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(rowPreview)}">${escHtml(rowPreview)}</span>
      <span style="color:var(--muted);font-size:10px;">${event.duration}ms</span>
      <button class="copy-btn copy-response-btn">copy</button>
    </div>
    ${errorBanner}
    <div id="${jsonId}" class="json-block collapsed" onclick="toggleCollapse('${jsonId}')">${escHtml(responseStr)}</div>`;

  // Attach copy handler directly — avoids JSON.stringify double-encoding in inline onclick
  entry.querySelector('.copy-response-btn').addEventListener('click', function () {
    copyToClipboard(responseStr, this);
  });

  logContainer.prepend(entry);
}

function appendErrorLog(event) {
  ensureLogActive();
  const rowPreview = event.row
    ? Object.entries(event.row).map(([k,v]) => `${k}=${v}`).join(' · ')
    : '';
  const entry = document.createElement('div');
  entry.className = 'log-entry failure';
  entry.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="log-status-badge badge-err">ERR</span>
      <span style="color:var(--muted);font-size:10px;">#${(event.index ?? 0) + 1}</span>
      <span style="color:var(--text-dim);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(rowPreview)}</span>
      ${event.duration != null ? `<span style="color:var(--muted);font-size:10px;">${event.duration}ms</span>` : ''}
    </div>
    <div style="color:var(--red);margin-top:6px;font-size:11px;">⚠ ${escHtml(event.error)}</div>`;
  logContainer.prepend(entry);
}

function appendLog({ type, message }) {
  ensureLogActive();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'info' ? 'info' : 'failure'}`;
  entry.innerHTML = `<span style="font-size:12px;">${escHtml(message)}</span>`;
  logContainer.prepend(entry);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getStatusClass(status) {
  if (status >= 200 && status < 300) return 'badge-2xx';
  if (status >= 400 && status < 500) return 'badge-4xx';
  if (status >= 500)                 return 'badge-5xx';
  return 'badge-err';
}

function toggleCollapse(id) {
  const el = $(id); if (el) el.classList.toggle('collapsed');
}
window.toggleCollapse = toggleCollapse;

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓ copied';
    btn.style.background = 'var(--green)';
    btn.style.color = 'black';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500);
  } catch { btn.textContent = 'failed'; }
}
window.copyToClipboard = copyToClipboard;

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Clear Log ─────────────────────────────────────────────────────────────────
$('clear-log-btn').addEventListener('click', () => {
  logContainer.innerHTML = `
    <div id="empty-state" style="text-align:center;padding:40px 20px;color:var(--muted);">
      <div style="font-size:28px;margin-bottom:10px;">📡</div>
      <div style="font-size:13px;font-weight:700;">No runs yet</div>
      <div style="font-size:11px;margin-top:4px;">Upload data or switch to Single mode to fire a request.</div>
    </div>`;
});

// ─── LocalStorage persistence ──────────────────────────────────────────────────
(function restoreState() {
  try {
    const cfg = JSON.parse(localStorage.getItem('api-runner-config') || '{}');
    if (cfg.url)     urlInput.value     = cfg.url;
    if (cfg.method)  methodSelect.value = cfg.method;
    if (cfg.delay)   delayInput.value   = cfg.delay;
    if (cfg.bodyRaw) bodyRawInput.value = cfg.bodyRaw;
  } catch {}
})();

function persistConfig() {
  localStorage.setItem('api-runner-config', JSON.stringify({
    url:    urlInput.value,
    method: methodSelect.value,
    delay:  delayInput.value,
    bodyRaw: bodyRawInput.value,
  }));
}
urlInput.addEventListener('input',    persistConfig);
methodSelect.addEventListener('change', persistConfig);
delayInput.addEventListener('input',   persistConfig);
bodyRawInput.addEventListener('input', persistConfig);

// ─── Init ──────────────────────────────────────────────────────────────────────
setMode('single');
setDataSource('upload');