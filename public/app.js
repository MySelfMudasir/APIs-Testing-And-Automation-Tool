/**
 * API Runner — app.js
 * Handles all frontend logic:
 * - KV row management (headers, params, form-data)
 * - File upload + server-side parsing (CSV/JSON)
 * - Body type switching + JSON validation
 * - SSE consumer for live streaming results
 * - Progress tracking + log rendering
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────
const state = {
  dataRows: [],       // Parsed rows from uploaded file
  isRunning: false,    // Current run in progress
  abortFlag: false,    // Set to true to signal abort
  eventSource: null,     // Active SSE connection
  bodyType: 'none',   // 'none' | 'json' | 'form'
  mode: 'single', // 'single' | 'bulk'
  dataSource: 'upload', // 'upload' | 'paste'
  successCount: 0,
  failureCount: 0,
  total: 0,
};

// ─── DOM Refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const urlInput = $('url-input');
const methodSelect = $('method-select');
const headersList = $('headers-list');
const paramsList = $('params-list');
const bodyFormList = $('body-form-list');
const bodyRawInput = $('body-raw-input');
const bodyJsonError = $('body-json-error');
const dropZone = $('drop-zone');
const fileInput = $('file-input');
const fileMeta = $('file-meta');
const fileError = $('file-error');
const dataPreview = $('data-preview');
const delayInput = $('delay-input');
const stopOnError = $('stop-on-error');
const launchBtn = $('launch-btn');
const abortBtn = $('abort-btn');
const launchLabel = $('launch-label');
const logContainer = $('log-container');
const statTotal = $('stat-total');
const statSuccess = $('stat-success');
const statFail = $('stat-fail');
const progressFill = $('progress-bar-fill');
const progressLabel = $('progress-label');
const progressPct = $('progress-pct');
const runStatus = $('run-status');
const liveDot = $('live-dot');

// ─── Tabs ───────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn[data-group="left"]').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.dataset.group;
    document.querySelectorAll(`.tab-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Show matching panel
    ['hdr', 'params', 'body'].forEach(id => {
      const panel = $(`tab-${id}`);
      if (panel) panel.classList.toggle('active', id === btn.dataset.tab);
    });
  });
});

// ─── KV Row Factory ─────────────────────────────────────────────────────────────
/**
 * Creates a key-value row DOM element and appends it to a container.
 * Used for headers, query params, and form-data fields.
 */
function addKVRow(container, keyPlaceholder = 'Key', valPlaceholder = 'Value {{var}}') {
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML = `
    <input class="kv-input kv-key"   type="text" placeholder="${keyPlaceholder}" />
    <input class="kv-input kv-value" type="text" placeholder="${valPlaceholder}" />
    <button class="btn-remove" title="Remove">✕</button>
  `;
  row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// Pre-populate one empty row in headers
addKVRow(headersList, 'Content-Type', 'application/json');

$('add-header').addEventListener('click', () => addKVRow(headersList));
$('add-param').addEventListener('click', () => addKVRow(paramsList));
$('add-form-field').addEventListener('click', () => addKVRow(bodyFormList, 'Field', 'Value'));

// ─── KV Collector ───────────────────────────────────────────────────────────────
/**
 * Reads all key-value rows from a container into a plain object.
 * Skips rows with empty keys.
 */
function collectKV(container) {
  const result = {};
  container.querySelectorAll('.kv-row').forEach(row => {
    const key = row.querySelector('.kv-key')?.value.trim();
    const val = row.querySelector('.kv-value')?.value.trim();
    if (key) result[key] = val || '';
  });
  return result;
}

// ─── Body Type Switcher ─────────────────────────────────────────────────────────
document.querySelectorAll('.body-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.body-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.bodyType = btn.dataset.body;
    // Toggle sections
    document.querySelectorAll('.body-section').forEach(s => s.style.display = 'none');
    $(`body-${state.bodyType}`).style.display = 'block';
  });
});

// ─── JSON Body Validation (live) ────────────────────────────────────────────────
/**
 * Validates the raw JSON body as the user types.
 * Highlights malformed JSON before the run even starts.
 */
bodyRawInput.addEventListener('input', () => {
  const raw = bodyRawInput.value.trim();
  if (!raw) { bodyJsonError.style.display = 'none'; return; }
  // Strip {{variables}} so parser doesn't choke on them
  const stripped = raw.replace(/\{\{[\w]+\}\}/g, '"__placeholder__"');
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

// ─── File Upload + Drag & Drop ──────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

$('clear-file-btn').addEventListener('click', clearFile);

function clearFile() {
  state.dataRows = [];
  fileMeta.style.display = 'none';
  fileError.style.display = 'none';
  dataPreview.innerHTML = '';
  fileInput.value = '';
  $('file-name-badge').textContent = '';
  $('file-rows-badge').textContent = '';
  $('file-keys-badge').textContent = '';
  updateLaunchState();
}

/**
 * Sends the raw file to the backend /api/parse-file endpoint.
 * Backend handles CSV column detection and JSON validation.
 */
async function handleFile(file) {
  fileError.style.display = 'none';
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['json', 'csv'].includes(ext)) {
    showFileError('Only .json and .csv files are supported.');
    return;
  }

  const raw = await file.text();
  try {
    const res = await fetch(`/api/parse-file?fileType=${ext}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw,
    });
    const data = await res.json();

    if (!data.ok) {
      showFileError(`Parse error: ${data.error}`);
      return;
    }

    state.dataRows = data.rows;

    // Update metadata badges
    $('file-name-badge').textContent = file.name;
    $('file-rows-badge').textContent = `${data.count} row${data.count !== 1 ? 's' : ''}`;
    $('file-keys-badge').textContent = `Keys: ${data.keys.join(', ')}`;
    fileMeta.style.display = 'block';

    // Show available {{variables}} hint
    renderVarHints(data.keys);

    // Render preview table
    renderPreviewTable(data.rows, data.keys);
    updateLaunchState();

  } catch (err) {
    showFileError(`Network error during parse: ${err.message}`);
  }
}

function showFileError(msg) {
  fileError.textContent = `⚠ ${msg}`;
  fileError.style.display = 'block';
  state.dataRows = [];
  updateLaunchState();
}

/**
 * Renders a compact scrollable preview table from the parsed rows.
 * Shows max 50 rows so we don't lock up the DOM with huge datasets.
 */
/**
 * Shows clickable {{variable}} chips under the bulk data panel
 * so the user knows exactly what placeholders to use in URL / body / headers.
 * Clicking a chip copies it to clipboard.
 */
function renderVarHints(keys) {
  let hint = document.getElementById('var-hints');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'var-hints';
    hint.style.cssText = 'margin-top:10px;padding:10px 12px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.2);border-radius:8px;';
    fileMeta.parentNode.insertBefore(hint, fileMeta.nextSibling);
  }
  hint.innerHTML = `
    <div style="font-size:10px;color:var(--accent);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:7px;">
      Available variables — click to copy
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${keys.map(k => `
        <span onclick="copyVar('{{${k}}}')" title="Click to copy" style="
          background:rgba(249,115,22,0.12);
          border:1px solid rgba(249,115,22,0.3);
          color:#fdba74;
          font-family:'JetBrains Mono',monospace;
          font-size:11px;
          padding:3px 8px;
          border-radius:4px;
          cursor:pointer;
          transition:all 0.15s;
          user-select:none;
        " onmouseenter="this.style.background='rgba(249,115,22,0.25)'" onmouseleave="this.style.background='rgba(249,115,22,0.12)'">
          {{${k}}}
        </span>`).join('')}
    </div>
  `;
}

window.copyVar = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    // Flash the URL input to hint where to paste
    urlInput.style.borderColor = 'var(--accent)';
    urlInput.style.boxShadow = '0 0 0 2px rgba(249,115,22,0.3)';
    setTimeout(() => {
      urlInput.style.borderColor = '';
      urlInput.style.boxShadow = '';
    }, 800);
  } catch { }
};

function renderPreviewTable(rows, keys) {
  const MAX_PREVIEW = 50;
  const preview = rows.slice(0, MAX_PREVIEW);
  const table = document.createElement('table');

  const thead = `<thead><tr>${keys.map(k => `<th>${escHtml(k)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${preview.map(row =>
    `<tr>${keys.map(k => `<td title="${escHtml(String(row[k] ?? ''))}">${escHtml(String(row[k] ?? ''))}</td>`).join('')}</tr>`
  ).join('')}</tbody>`;

  table.innerHTML = thead + tbody;
  dataPreview.innerHTML = '';
  dataPreview.appendChild(table);

  if (rows.length > MAX_PREVIEW) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:11px;color:var(--muted);margin-top:6px;font-family:monospace;';
    note.textContent = `… and ${rows.length - MAX_PREVIEW} more rows (not shown in preview)`;
    dataPreview.appendChild(note);
  }
}

// ─── Launch State Gate ──────────────────────────────────────────────────────────
/**
 * Launch is enabled only when we have a URL and loaded data rows.
 */
function updateLaunchState() {
  const hasUrl = urlInput.value.trim().length > 0;
  const hasBulk = state.dataRows.length > 0;
  const ready = hasUrl && (state.mode === 'single' || hasBulk);
  launchBtn.disabled = !ready || state.isRunning;
  launchLabel.textContent = state.isRunning
    ? '⏳ RUNNING…'
    : state.mode === 'single' ? '⚡ LAUNCH' : '⚡ LAUNCH BULK RUN';
}

urlInput.addEventListener('input', updateLaunchState);

// ─── Launch Handler ─────────────────────────────────────────────────────────────
launchBtn.addEventListener('click', startRun);
abortBtn.addEventListener('click', abortRun);

function abortRun() {
  state.abortFlag = true;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  appendLog({ type: 'info', message: '⛔ Run aborted by user.' });
  setRunningState(false);
}

/**
 * Collects all config from the UI, POSTs to /api/execute-runner,
 * then opens an SSE stream to receive live results.
 */
async function startRun() {
  if (state.isRunning) return;
  if (state.mode === 'bulk' && state.dataRows.length === 0) return;

  // Validate JSON body before submitting
  if (state.bodyType === 'json') {
    const raw = bodyRawInput.value.trim();
    const stripped = raw.replace(/\{\{[\w]+\}\}/g, '"__placeholder__"');
    try { if (raw) JSON.parse(stripped); }
    catch (e) {
      bodyJsonError.textContent = `⚠ Fix JSON before running: ${e.message}`;
      bodyJsonError.style.display = 'block';
      return;
    }
  }

  // Reset counters and log
  state.successCount = 0;
  state.failureCount = 0;
  state.total = state.dataRows.length;
  state.abortFlag = false;
  logContainer.innerHTML = '';
  resetProgress();
  setRunningState(true);

  // Build the payload — single mode uses one synthetic row so the same backend loop works
  const rows = state.mode === 'single' ? [{}] : state.dataRows;

  // In bulk mode: each data row IS the body — ignore the left-panel body textarea.
  // The left-panel body only applies in single mode (or when bodyType is 'form').
  let effectiveBodyType = state.bodyType;
  let effectiveBodyRaw = '';
  let effectiveBodyForm = {};

  if (state.mode === 'bulk') {
    // Bulk rows are sent as individual bodies directly — body panel is ignored
    effectiveBodyType = 'bulk-row';
    effectiveBodyRaw = '';
    effectiveBodyForm = {};
  } else {
    effectiveBodyRaw = state.bodyType === 'json' ? bodyRawInput.value.trim() : '';
    effectiveBodyForm = state.bodyType === 'form' ? collectKV(bodyFormList) : {};
  }

  const payload = {
    url: urlInput.value.trim(),
    method: methodSelect.value,
    headers: collectKV(headersList),
    params: collectKV(paramsList),
    bodyType: effectiveBodyType,
    bodyRaw: effectiveBodyRaw,
    bodyForm: effectiveBodyForm,
    dataRows: rows,
    delay: parseInt(delayInput.value, 10) || 0,
    stopOnError: stopOnError.checked,
  };

  // ── POST the config, then switch to SSE streaming ─────────────────────────
  try {
    // We POST first so the server can accept the full config,
    // then consume the SSE response body directly.
    const response = await fetch('/api/execute-runner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      appendLog({ type: 'info', message: `❌ Server rejected run: ${response.statusText}` });
      setRunningState(false);
      return;
    }

    // Read the SSE stream manually using a reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // ── Streaming read loop ────────────────────────────────────────────────
    while (true) {
      if (state.abortFlag) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE events from buffer (each ends with \n\n)
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // Keep any incomplete chunk

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        try {
          const event = JSON.parse(jsonStr);
          handleSSEEvent(event);
        } catch { /* ignore malformed frames */ }
      }
    }

  } catch (err) {
    if (!state.abortFlag) {
      appendLog({ type: 'info', message: `❌ Connection error: ${err.message}` });
    }
  } finally {
    setRunningState(false);
  }
}

// ─── SSE Event Dispatcher ───────────────────────────────────────────────────────
/**
 * Routes incoming SSE events to the correct UI handler.
 * Event types: START | ROW_RESULT | ROW_ERROR | STOPPED | DONE
 */
function handleSSEEvent(event) {
  switch (event.type) {
    case 'START':
      statTotal.textContent = event.total;
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
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      progressLabel.textContent = `Done — ${event.successCount} passed, ${event.failureCount} failed`;
      break;
  }
}

// ─── Progress Updater ───────────────────────────────────────────────────────────
function updateProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
  progressLabel.textContent = `${done} / ${total} completed`;
}

function resetProgress() {
  progressFill.style.width = '0%';
  progressPct.textContent = '0%';
  progressLabel.textContent = 'Starting…';
  statTotal.textContent = state.total;
  statSuccess.textContent = '0';
  statFail.textContent = '0';
}

function updateStats(success, fail, total) {
  statTotal.textContent = total;
  statSuccess.textContent = success;
  statFail.textContent = fail;
}

// ─── Running State Toggle ───────────────────────────────────────────────────────
function setRunningState(running) {
  state.isRunning = running;
  launchBtn.disabled = running;
  launchBtn.classList.toggle('running', running);
  launchLabel.textContent = running ? '⏳ RUNNING…' : '⚡ LAUNCH BULK RUN';
  abortBtn.style.display = running ? 'block' : 'none';
  runStatus.textContent = running ? 'RUNNING' : 'IDLE';
  runStatus.style.color = running ? 'var(--green)' : 'var(--muted)';
  liveDot.style.display = running ? 'inline' : 'none';
}

// ─── Log Renderers ──────────────────────────────────────────────────────────────
/**
 * Removes the empty state placeholder on first log.
 */
function ensureLogActive() {
  const empty = $('empty-state');
  if (empty) empty.remove();
}

/**
 * Renders a successful or failed HTTP response log entry with:
 * - Status badge (color-coded)
 * - Request row data
 * - Collapsible JSON response viewer
 * - Copy button
 */
function appendResultLog(event) {
  ensureLogActive();
  const cls = event.isSuccess ? 'success' : 'failure';
  const statusCls = getStatusClass(event.status);
  const rowPreview = Object.keys(event.row).length
    ? Object.entries(event.row).map(([k, v]) => `${k}=${v}`).join(' · ')
    : 'single request';
  const responseStr = JSON.stringify(event.data, null, 2);
  const jsonId = `json-${event.index}`;

  // Show a prominent error banner for non-2xx responses
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
    <div id="${jsonId}" class="json-block collapsed" onclick="toggleCollapse('${jsonId}')">${escHtml(responseStr)}</div>
  `;

  // Attach copy handler directly — avoids JSON.stringify double-encoding in inline onclick
  entry.querySelector('.copy-response-btn').addEventListener('click', function () {
    copyToClipboard(responseStr, this);
  });

  logContainer.prepend(entry);
}

/**
 * Renders a network-level or parse error log entry.
 */
function appendErrorLog(event) {
  ensureLogActive();
  const rowPreview = event.row ? Object.entries(event.row).map(([k, v]) => `${k}=${v}`).join(' · ') : '';

  const entry = document.createElement('div');
  entry.className = 'log-entry failure';
  entry.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="log-status-badge badge-err">ERR</span>
      <span style="color:var(--muted);font-size:10px;">#${(event.index ?? 0) + 1}</span>
      <span style="color:var(--text-dim);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(rowPreview)}</span>
      ${event.duration != null ? `<span style="color:var(--muted);font-size:10px;">${event.duration}ms</span>` : ''}
    </div>
    <div style="color:var(--red);margin-top:6px;font-size:11px;">⚠ ${escHtml(event.error)}</div>
  `;
  logContainer.prepend(entry);
}

function appendLog({ type, message }) {
  ensureLogActive();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'info' ? 'info' : 'failure'}`;
  entry.innerHTML = `<span style="font-size:12px;">${escHtml(message)}</span>`;
  logContainer.prepend(entry);
}

// ─── Helpers ────────────────────────────────────────────────────────────────────
function getStatusClass(status) {
  if (status >= 200 && status < 300) return 'badge-2xx';
  if (status >= 400 && status < 500) return 'badge-4xx';
  if (status >= 500) return 'badge-5xx';
  return 'badge-err';
}

/**
 * Toggles the collapsed/expanded state of a JSON block.
 */
function toggleCollapse(id) {
  const el = $(id);
  if (el) el.classList.toggle('collapsed');
}
window.toggleCollapse = toggleCollapse; // exposed for inline onclick

/**
 * Copies a string to clipboard and gives a visual flash on the button.
 */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓ copied';
    btn.style.background = 'var(--green)';
    btn.style.color = 'black';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = '';
      btn.style.color = '';
    }, 1500);
  } catch {
    btn.textContent = 'failed';
  }
}
window.copyToClipboard = copyToClipboard;

/** Prevents XSS when injecting user/response data into innerHTML. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Clear Log ──────────────────────────────────────────────────────────────────
$('clear-log-btn').addEventListener('click', () => {
  logContainer.innerHTML = `
    <div id="empty-state" style="text-align:center;padding:40px 20px;color:var(--muted);">
      <div style="font-size:28px;margin-bottom:10px;">📡</div>
      <div style="font-size:13px;font-weight:700;">No runs yet</div>
      <div style="font-size:11px;margin-top:4px;">Upload data and launch a run to see live logs here.</div>
    </div>`;
});

// ─── Restore from LocalStorage (optional config persistence) ────────────────────
(function restoreState() {
  const saved = localStorage.getItem('api-runner-config');
  if (!saved) return;
  try {
    const cfg = JSON.parse(saved);
    if (cfg.url) urlInput.value = cfg.url;
    if (cfg.method) methodSelect.value = cfg.method;
    if (cfg.delay) delayInput.value = cfg.delay;
    if (cfg.bodyRaw) bodyRawInput.value = cfg.bodyRaw;
  } catch { }
})();

// Persist config changes
function persistConfig() {
  localStorage.setItem('api-runner-config', JSON.stringify({
    url: urlInput.value,
    method: methodSelect.value,
    delay: delayInput.value,
    bodyRaw: bodyRawInput.value,
  }));
}
urlInput.addEventListener('input', persistConfig);
methodSelect.addEventListener('change', persistConfig);
delayInput.addEventListener('input', persistConfig);
bodyRawInput.addEventListener('input', persistConfig);

// ─── Mode Switcher ──────────────────────────────────────────────────────────────
const singleNotice = $('single-mode-notice');
const bulkPanel = $('bulk-data-panel');
const modeSingleBtn = $('mode-single');
const modeBulkBtn = $('mode-bulk');

function setMode(mode) {
  state.mode = mode;
  const isBulk = mode === 'bulk';

  modeSingleBtn.style.background = !isBulk ? 'var(--accent)' : 'transparent';
  modeSingleBtn.style.color = !isBulk ? 'white' : 'var(--muted)';
  modeBulkBtn.style.background = isBulk ? 'var(--accent)' : 'transparent';
  modeBulkBtn.style.color = isBulk ? 'white' : 'var(--muted)';

  singleNotice.style.display = isBulk ? 'none' : 'block';
  bulkPanel.style.display = isBulk ? 'block' : 'none';

  updateLaunchState();
}

modeSingleBtn.addEventListener('click', () => setMode('single'));
modeBulkBtn.addEventListener('click', () => setMode('bulk'));

// Initialize
setMode('single');

// ─── Bulk Data Source Sub-Tabs ──────────────────────────────────────────────────
const datasrcUploadBtn = $('datasrc-upload-btn');
const datasrcPasteBtn = $('datasrc-paste-btn');
const datasrcUploadPane = $('datasrc-upload');
const datasrcPastePane = $('datasrc-paste');

function setDataSource(src) {
  state.dataSource = src;
  const isUpload = src === 'upload';

  datasrcUploadBtn.classList.toggle('active', isUpload);
  datasrcPasteBtn.classList.toggle('active', !isUpload);
  datasrcUploadPane.style.display = isUpload ? 'block' : 'none';
  datasrcPastePane.style.display = isUpload ? 'none' : 'block';
}

datasrcUploadBtn.addEventListener('click', () => setDataSource('upload'));
datasrcPasteBtn.addEventListener('click', () => setDataSource('paste'));

// ─── Paste-to-parse handler ─────────────────────────────────────────────────────
$('parse-paste-btn').addEventListener('click', async () => {
  const raw = $('paste-input').value.trim();
  if (!raw) return;

  // Detect CSV vs JSON
  const fileType = raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{') ? 'json' : 'csv';

  fileError.style.display = 'none';
  try {
    const res = await fetch(`/api/parse-file?fileType=${fileType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw,
    });
    const data = await res.json();
    if (!data.ok) { showFileError(`Parse error: ${data.error}`); return; }

    state.dataRows = data.rows;
    $('file-name-badge').textContent = `pasted ${fileType.toUpperCase()}`;
    $('file-rows-badge').textContent = `${data.count} row${data.count !== 1 ? 's' : ''}`;
    $('file-keys-badge').textContent = `Keys: ${data.keys.join(', ')}`;
    fileMeta.style.display = 'block';
    renderVarHints(data.keys);
    renderPreviewTable(data.rows, data.keys);
    updateLaunchState();
  } catch (err) {
    showFileError(`Parse error: ${err.message}`);
  }
});