/**
 * chain.js — Chain Runner frontend logic
 *
 * Manages:
 *  - Step cards (add / remove / reorder / expand)
 *  - Per-step config: method, url, headers, params, body, extractions, data rows
 *  - Global environment variables (seed values available to all steps)
 *  - Run orchestration: POST to /api/execute-chain, stream SSE events
 *  - Live context viewer showing extracted variables after each step
 *  - Log rendering: per-step results, iteration markers, error banners
 *  - Export: download full log as JSON
 *  - LocalStorage persistence of the chain config
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────
const S = {
  steps:      [],       // array of step config objects
  running:    false,
  abortFlag:  false,
  logEntries: [],       // raw SSE events for export
  passCount:  0,
  failCount:  0,
  liveCtx:    {},       // latest extracted context
};

let stepIdCounter = 0;

// ─── DOM ───────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const stepsContainer  = $('steps-container');
const addStepBtn      = $('add-step-btn');
const launchBtn       = $('launch-chain-btn');
const abortBtn        = $('abort-chain-btn');
const iterInput       = $('iterations-input');
const stepDelayInput  = $('step-delay-input');
const iterDelayInput  = $('iter-delay-input');
const logScroll       = $('log-scroll');
const progressFill    = $('progress-fill');
const progressLabel   = $('progress-label');
const progressPct     = $('progress-pct');
const iterBadge       = $('iter-badge');
const statSteps       = $('stat-steps');
const statPass        = $('stat-pass');
const statFail        = $('stat-fail');
const ctxDisplay      = $('ctx-display');
const envKvList       = $('env-kv-list');
const runStatusBadge  = $('run-status-badge');
const globalEnvList   = $('global-env-list');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * showConfirm — custom shadcn-style dialog replacing window.confirm()
 * @param {string} stepName  — shown in bold in the description
 * @param {function} onOk    — called only if user clicks "Remove"
 */
function showConfirm(stepName, onOk) {
  const overlay  = document.getElementById('confirm-overlay');
  const nameEl   = document.getElementById('confirm-step-name');
  const cancelBtn = document.getElementById('confirm-cancel');
  const okBtn    = document.getElementById('confirm-ok');

  nameEl.textContent = `"${stepName}"`;
  overlay.classList.add('visible');

  // Clone buttons to remove any stale listeners
  const freshCancel = cancelBtn.cloneNode(true);
  const freshOk     = okBtn.cloneNode(true);
  cancelBtn.replaceWith(freshCancel);
  okBtn.replaceWith(freshOk);

  function close() { overlay.classList.remove('visible'); }

  freshCancel.addEventListener('click', close);
  freshOk.addEventListener('click', () => { close(); onOk(); });
  // Click outside the box also cancels
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); }, { once: true });
  // Escape key cancels
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getStatusBadgeClass(status) {
  if (status >= 200 && status < 300) return 'b-2xx';
  if (status >= 400 && status < 500) return 'b-4xx';
  if (status >= 500)                 return 'b-5xx';
  return 'b-err';
}

function uid() { return `step-${++stepIdCounter}`; }

// ─── Step Data Model ───────────────────────────────────────────────────────────
function makeStep(overrides = {}) {
  return {
    id:          uid(),
    name:        `Step ${S.steps.length + 1}`,
    method:      'GET',
    url:         '',
    headers:     [],   // [{ k, v }]
    params:      [],
    bodyType:    'none',
    bodyRaw:     '',
    bodyForm:    [],
    dataRows:    [],   // for bulk-row bodyType
    pasteRaw:    '',   // raw pasted text (displayed in textarea)
    extractions: [],   // [{ varName, path }]
    enabled:     true,       // when false, step is skipped during chain run
    stopOnError: true,
    activeTab:   'request', // 'request' | 'body' | 'extract' | 'data'
    ...overrides,
  };
}

// ─── Render All Steps ──────────────────────────────────────────────────────────
function renderAll() {
  stepsContainer.innerHTML = '';
  S.steps.forEach((step, idx) => {
    if (idx > 0) stepsContainer.appendChild(makeConnector());
    stepsContainer.appendChild(makeStepCard(step, idx));
  });
  updateLaunchState();
  statSteps.textContent = S.steps.length;
  persistChain();
}

function makeConnector() {
  const d = document.createElement('div');
  d.className = 'step-connector';
  d.innerHTML = `<div class="step-connector-icon">↓</div>`;
  return d;
}

// ─── Step Card DOM Builder ─────────────────────────────────────────────────────
function makeStepCard(step, idx) {
  const card = document.createElement('div');
  card.className = 'step-card' + (step.expanded ? ' expanded' : '');
  card.id = `card-${step.id}`;

  card.innerHTML = `
    <!-- Header -->
    <div class="step-header" id="hdr-${step.id}">
      <div class="step-num">${idx + 1}</div>
      <div class="step-status-dot pending" id="dot-${step.id}"></div>
      <input class="step-name-input" id="name-${step.id}" value="${escHtml(step.name)}" placeholder="Step name" />
      <span class="step-method-badge m-${step.method}" id="mbadge-${step.id}">${step.method}</span>
      <!-- Enable/disable toggle -->
      <div class="toggle-wrap" onclick="event.stopPropagation()" style="gap:5px;flex-shrink:0;">
        <label class="toggle" title="${step.enabled ? 'Step included — click to disable' : 'Step disabled — click to enable'}">
          <input type="checkbox" id="enabled-${step.id}" ${step.enabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <span id="enabled-text-${step.id}" style="font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:0.06em;color:${step.enabled ? '#86efac' : 'var(--muted)'};">${step.enabled ? 'ON' : 'OFF'}</span>
      </div>
      <button class="btn-rm" id="del-${step.id}" title="Remove step" style="flex-shrink:0;">✕</button>
    </div>

    <!-- Body -->
    <div class="step-body" id="body-${step.id}">

      <!-- URL + Method row -->
      <div style="display:grid;grid-template-columns:100px 1fr;gap:6px;margin-bottom:12px;">
        <select class="field-input" id="method-${step.id}">
          ${['GET','POST','PUT','DELETE','PATCH'].map(m =>
            `<option ${m === step.method ? 'selected' : ''}>${m}</option>`
          ).join('')}
        </select>
        <input class="field-input" id="url-${step.id}" value="${escHtml(step.url)}" placeholder="https://{{base_url}}/api/endpoint" />
      </div>

      <!-- Sub-tabs -->
      <div class="step-tab-bar">
        <div class="step-tab ${step.activeTab==='request'?'active':''}" data-stab="request" data-sid="${step.id}">Request</div>
        <div class="step-tab ${step.activeTab==='body'   ?'active':''}" data-stab="body"    data-sid="${step.id}">Body</div>
        <div class="step-tab ${step.activeTab==='extract'?'active':''}" data-stab="extract" data-sid="${step.id}">Extract</div>
        <div class="step-tab ${step.activeTab==='data'   ?'active':''}" data-stab="data"    data-sid="${step.id}">Row Data</div>
      </div>

      <!-- REQUEST tab: headers + params -->
      <div id="stab-request-${step.id}" style="display:${step.activeTab==='request'?'block':'none'}">
        <div class="section-divider">Headers</div>
        <div id="hdr-list-${step.id}"></div>
        <button class="btn-add-kv" data-add-hdr="${step.id}">+ Header</button>

        <div class="section-divider" style="margin-top:10px;">Query Params</div>
        <div id="prm-list-${step.id}"></div>
        <button class="btn-add-kv" data-add-prm="${step.id}">+ Param</button>

        <div class="section-divider" style="margin-top:10px;">Options</div>
        <div class="toggle-wrap">
          <label class="toggle">
            <input type="checkbox" id="stop-${step.id}" ${step.stopOnError?'checked':''} />
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:11px;color:var(--text-dim);">Stop chain on error</span>
        </div>
      </div>

      <!-- BODY tab -->
      <div id="stab-body-${step.id}" style="display:${step.activeTab==='body'?'block':'none'}">
        <div style="display:flex;gap:5px;margin-bottom:10px;">
          ${['none','json','form'].map(bt =>
            `<button class="body-btn ${step.bodyType===bt?'active':''}" data-btype="${bt}" data-sid="${step.id}">${bt.toUpperCase()}</button>`
          ).join('')}
        </div>
        <div id="bsec-none-${step.id}"  style="display:${step.bodyType==='none' ?'block':'none'}">
          <p style="color:var(--muted);font-size:12px;text-align:center;padding:8px 0;">No body.</p>
        </div>
        <div id="bsec-json-${step.id}"  style="display:${step.bodyType==='json' ?'block':'none'}">
          <textarea class="code-area" id="braw-${step.id}" placeholder='{"key": "{{var}}"}'>${escHtml(step.bodyRaw)}</textarea>
          <div id="berr-${step.id}" class="error-msg" style="display:none;"></div>
        </div>
        <div id="bsec-form-${step.id}"  style="display:${step.bodyType==='form' ?'block':'none'}">
          <div id="form-list-${step.id}"></div>
          <button class="btn-add-kv" data-add-form="${step.id}">+ Field</button>
        </div>
      </div>

      <!-- EXTRACT tab -->
      <div id="stab-extract-${step.id}" style="display:${step.activeTab==='extract'?'block':'none'}">
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5;">
          Define variables to extract from this step's response. Use dot-notation path.<br/>
          <span style="color:var(--accent2);font-family:monospace;">token → token</span> &nbsp;|&nbsp;
          <span style="color:var(--accent2);font-family:monospace;">userId → data.0.id</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto 1fr 24px;gap:5px;margin-bottom:5px;">
          <span class="label" style="margin:0;">Save As</span>
          <span></span>
          <span class="label" style="margin:0;">Response Path</span>
          <span></span>
        </div>
        <div id="ext-list-${step.id}"></div>
        <button class="btn-add-kv" data-add-ext="${step.id}">+ Extraction Rule</button>
      </div>

      <!-- ROW DATA tab -->
      <div id="stab-data-${step.id}" style="display:${step.activeTab==='data'?'block':'none'}">
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5;">
          Paste JSON array or CSV. In bulk mode, each iteration uses the next row.<br/>
          When active, this step's body is the row object — Body tab is ignored.
        </div>
        <textarea class="code-area" id="dpaste-${step.id}" placeholder='[{"userId":33},{"userId":44}]' style="min-height:80px;">${escHtml(step.pasteRaw)}</textarea>
        <button style="margin-top:6px;background:var(--accent2);border:none;color:white;font-family:Syne,sans-serif;font-weight:700;font-size:11px;padding:6px 14px;border-radius:5px;cursor:pointer;width:100%;letter-spacing:0.04em;" data-parse-data="${step.id}">PARSE ROW DATA</button>
        <div id="dstat-${step.id}" style="font-size:10px;color:var(--muted);margin-top:5px;font-family:monospace;"></div>
        <div id="derr-${step.id}"  class="error-msg" style="display:none;"></div>
      </div>

    </div><!-- /step-body -->
  `;

  // ── Wire events on this card ───────────────────────────────────────────────

  // Toggle expand/collapse on header click
  const hdr = card.querySelector(`#hdr-${step.id}`);
  hdr.addEventListener('click', e => {
    if (e.target.classList.contains('step-name-input') ||
        e.target.classList.contains('btn-rm')           ||
        e.target.closest('.toggle-wrap')) return;
    step.expanded = !step.expanded;
    card.classList.toggle('expanded', step.expanded);
    persistChain();
  });

  // Delete — with custom confirm dialog
  card.querySelector(`#del-${step.id}`).addEventListener('click', e => {
    e.stopPropagation();
    showConfirm(step.name, () => {
      S.steps = S.steps.filter(s => s.id !== step.id);
      renderAll();
    });
  });

  // Enable / disable toggle
  card.querySelector(`#enabled-${step.id}`).addEventListener('change', e => {
    e.stopPropagation();
    step.enabled = e.target.checked;
    // Update ON / OFF label colour
    const txt = card.querySelector(`#enabled-text-${step.id}`);
    if (txt) { txt.textContent = step.enabled ? 'ON' : 'OFF'; txt.style.color = step.enabled ? '#86efac' : 'var(--muted)'; }
    // Dim card when disabled — keep header readable
    card.querySelector(`#body-${step.id}`).style.opacity = step.enabled ? '1' : '0.35';
    card.style.opacity = step.enabled ? '1' : '0.6';
    card.style.filter  = step.enabled ? '' : 'grayscale(0.5)';
    persistChain();
  });
  // Apply initial visual state on render
  if (!step.enabled) {
    card.style.opacity = '0.6';
    card.style.filter  = 'grayscale(0.5)';
    const body = card.querySelector(`#body-${step.id}`);
    if (body) body.style.opacity = '0.35';
  }

  // Name
  card.querySelector(`#name-${step.id}`).addEventListener('input', e => {
    step.name = e.target.value;
    persistChain();
  });

  // Method
  card.querySelector(`#method-${step.id}`).addEventListener('change', e => {
    step.method = e.target.value;
    card.querySelector(`#mbadge-${step.id}`).textContent  = step.method;
    card.querySelector(`#mbadge-${step.id}`).className    = `step-method-badge m-${step.method}`;
    persistChain();
  });

  // URL
  card.querySelector(`#url-${step.id}`).addEventListener('input', e => {
    step.url = e.target.value;
    updateLaunchState();
    persistChain();
  });

  // Stop on error toggle
  card.querySelector(`#stop-${step.id}`).addEventListener('change', e => {
    step.stopOnError = e.target.checked;
    persistChain();
  });

  // Sub-tabs
  card.querySelectorAll('.step-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      step.activeTab = tab.dataset.stab;
      card.querySelectorAll('.step-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['request','body','extract','data'].forEach(t => {
        const panel = card.querySelector(`#stab-${t}-${step.id}`);
        if (panel) panel.style.display = t === step.activeTab ? 'block' : 'none';
      });
      persistChain();
    });
  });

  // Body type buttons
  card.querySelectorAll('.body-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      step.bodyType = btn.dataset.btype;
      card.querySelectorAll('.body-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['none','json','form'].forEach(t => {
        const sec = card.querySelector(`#bsec-${t}-${step.id}`);
        if (sec) sec.style.display = t === step.bodyType ? 'block' : 'none';
      });
      persistChain();
    });
  });

  // Body raw input + live JSON validation
  const brawEl = card.querySelector(`#braw-${step.id}`);
  if (brawEl) {
    brawEl.addEventListener('input', e => {
      step.bodyRaw = e.target.value;
      const berr = card.querySelector(`#berr-${step.id}`);
      const stripped = step.bodyRaw.replace(/\{\{[\w]+\}\}/g, '"x"');
      try {
        if (stripped.trim()) JSON.parse(stripped);
        berr.style.display = 'none';
        brawEl.style.borderColor = '';
      } catch(err) {
        berr.textContent = `⚠ ${err.message}`;
        berr.style.display = 'block';
        brawEl.style.borderColor = 'var(--red)';
      }
      persistChain();
    });
  }

  // Row data parse button
  const parseDataBtn = card.querySelector(`[data-parse-data="${step.id}"]`);
  if (parseDataBtn) {
    parseDataBtn.addEventListener('click', async () => {
      const raw  = card.querySelector(`#dpaste-${step.id}`).value.trim();
      const dstat = card.querySelector(`#dstat-${step.id}`);
      const derr  = card.querySelector(`#derr-${step.id}`);
      step.pasteRaw = raw;
      derr.style.display = 'none';

      if (!raw) {
        step.dataRows = [];
        step.bodyType = 'none';
        // Reset body buttons
        card.querySelectorAll('.body-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.btype === 'none');
        });
        dstat.textContent = 'Cleared.';
        persistChain();
        return;
      }

      const fileType = raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{') ? 'json' : 'csv';
      try {
        const res  = await fetch(`/api/parse-file?fileType=${fileType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: raw,
        });
        const data = await res.json();
        if (!data.ok) { derr.textContent = `⚠ ${data.error}`; derr.style.display = 'block'; return; }

        step.dataRows = data.rows;
        step.bodyType = 'bulk-row';
        // Highlight bulk-row mode (none of the normal body buttons cover it; just show status)
        card.querySelectorAll('.body-btn').forEach(b => b.classList.remove('active'));
        dstat.textContent = `✓ ${data.count} row${data.count!==1?'s':''} loaded · Keys: ${data.keys.join(', ')} · Body set to Row Data`;
        persistChain();
      } catch(err) {
        derr.textContent = `⚠ ${err.message}`;
        derr.style.display = 'block';
      }
    });
  }

  // ── Populate dynamic KV lists ──────────────────────────────────────────────
  populateKVList(card.querySelector(`#hdr-list-${step.id}`),  step.headers,  'hdr',  step.id, card);
  populateKVList(card.querySelector(`#prm-list-${step.id}`),  step.params,   'prm',  step.id, card);
  populateKVList(card.querySelector(`#form-list-${step.id}`), step.bodyForm, 'form', step.id, card);
  populateExtList(card.querySelector(`#ext-list-${step.id}`), step.extractions, step.id, card);

  // Add KV row buttons
  card.querySelector(`[data-add-hdr="${step.id}"]`)?.addEventListener('click', () =>
    addKVRow(card.querySelector(`#hdr-list-${step.id}`), step.headers, card, step));
  card.querySelector(`[data-add-prm="${step.id}"]`)?.addEventListener('click', () =>
    addKVRow(card.querySelector(`#prm-list-${step.id}`), step.params, card, step));
  card.querySelector(`[data-add-form="${step.id}"]`)?.addEventListener('click', () =>
    addKVRow(card.querySelector(`#form-list-${step.id}`), step.bodyForm, card, step));
  card.querySelector(`[data-add-ext="${step.id}"]`)?.addEventListener('click', () =>
    addExtRow(card.querySelector(`#ext-list-${step.id}`), step.extractions, card, step));

  return card;
}

// ─── KV List Population ────────────────────────────────────────────────────────
function populateKVList(container, arr, type, sid, card) {
  if (!container) return;
  container.innerHTML = '';
  arr.forEach((item, i) => {
    const row = makeKVRowEl(item.k, item.v, () => {
      arr.splice(i, 1);
      const step = S.steps.find(s => s.id === sid);
      if (step) { populateKVList(container, arr, type, sid, card); persistChain(); }
    });
    row.querySelector('.kv-in:nth-child(1)').addEventListener('input', e => { item.k = e.target.value; persistChain(); });
    row.querySelector('.kv-in:nth-child(2)').addEventListener('input', e => { item.v = e.target.value; persistChain(); });
    container.appendChild(row);
  });
}

function makeKVRowEl(k='', v='', onRemove) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML = `
    <input class="kv-in" type="text" placeholder="Key" value="${escHtml(k)}" />
    <input class="kv-in" type="text" placeholder="Value / {{var}}" value="${escHtml(v)}" />
    <button class="btn-rm">✕</button>
  `;
  row.querySelector('.btn-rm').addEventListener('click', onRemove);
  return row;
}

function addKVRow(container, arr, card, step) {
  const item = { k: '', v: '' };
  arr.push(item);
  const row = makeKVRowEl('', '', () => {
    arr.splice(arr.indexOf(item), 1);
    row.remove();
    persistChain();
  });
  row.querySelector('.kv-in:nth-child(1)').addEventListener('input', e => { item.k = e.target.value; persistChain(); });
  row.querySelector('.kv-in:nth-child(2)').addEventListener('input', e => { item.v = e.target.value; persistChain(); });
  container.appendChild(row);
}

// ─── Extraction Row List ───────────────────────────────────────────────────────
function populateExtList(container, arr, sid, card) {
  if (!container) return;
  container.innerHTML = '';
  arr.forEach((item, i) => {
    const row = makeExtRowEl(item.varName, item.path, () => {
      arr.splice(i, 1);
      populateExtList(container, arr, sid, card);
      persistChain();
    });
    row.querySelector('.ext-var').addEventListener('input', e => { item.varName = e.target.value; persistChain(); });
    row.querySelector('.ext-path').addEventListener('input', e => { item.path    = e.target.value; persistChain(); });
    container.appendChild(row);
  });
}

function makeExtRowEl(varName='', path='', onRemove) {
  const row = document.createElement('div');
  row.className = 'extract-row';
  row.innerHTML = `
    <input class="kv-in ext-var"  type="text" placeholder="tokenName" value="${escHtml(varName)}" />
    <div class="extract-arrow">←</div>
    <input class="kv-in ext-path" type="text" placeholder="response.path.key" value="${escHtml(path)}" />
    <button class="btn-rm">✕</button>
  `;
  row.querySelector('.btn-rm').addEventListener('click', onRemove);
  return row;
}

function addExtRow(container, arr, card, step) {
  const item = { varName: '', path: '' };
  arr.push(item);
  const row = makeExtRowEl('', '', () => {
    arr.splice(arr.indexOf(item), 1);
    row.remove();
    persistChain();
  });
  row.querySelector('.ext-var') .addEventListener('input', e => { item.varName = e.target.value; persistChain(); });
  row.querySelector('.ext-path').addEventListener('input', e => { item.path    = e.target.value; persistChain(); });
  container.appendChild(row);
}

// ─── Add Step Button ───────────────────────────────────────────────────────────
addStepBtn.addEventListener('click', () => {
  const step = makeStep();
  step.expanded = true;
  S.steps.push(step);
  renderAll();
  // Scroll to new card
  setTimeout(() => {
    const card = $(`card-${step.id}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
});

// ─── Global Env ────────────────────────────────────────────────────────────────
const envVars = []; // [{k, v}]

$('add-env-btn').addEventListener('click', () => {
  $('env-panel').style.display = 'block';
  addEnvRow();
});

$('add-env-kv-btn').addEventListener('click', addEnvRow);

function addEnvRow(k='', v='') {
  const item = { k, v };
  envVars.push(item);
  const row = makeKVRowEl(k, v, () => {
    envVars.splice(envVars.indexOf(item), 1);
    row.remove();
    refreshEnvBadges();
    persistChain();
  });
  row.querySelector('.kv-in:nth-child(1)').addEventListener('input', e => {
    item.k = e.target.value; refreshEnvBadges(); persistChain();
  });
  row.querySelector('.kv-in:nth-child(2)').addEventListener('input', e => {
    item.v = e.target.value; refreshEnvBadges(); persistChain();
  });
  envKvList.appendChild(row);
  refreshEnvBadges();
}

function getGlobalEnv() {
  const env = {};
  envVars.forEach(item => { if (item.k.trim()) env[item.k.trim()] = item.v; });
  return env;
}

function refreshEnvBadges() {
  globalEnvList.innerHTML = '';
  envVars.filter(e => e.k.trim()).forEach(e => {
    const badge = document.createElement('span');
    badge.style.cssText = 'background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#a5b4fc;font-family:JetBrains Mono,monospace;font-size:10px;padding:2px 8px;border-radius:4px;';
    badge.textContent = `${e.k}=${e.v || '…'}`;
    globalEnvList.appendChild(badge);
  });
  persistChain();
}

// ─── Launch State ──────────────────────────────────────────────────────────────
function updateLaunchState() {
  const hasSteps = S.steps.length > 0;
  const allHaveUrls = S.steps.every(s => s.url.trim().length > 0);
  launchBtn.disabled = !hasSteps || !allHaveUrls || S.running;
}

// ─── Run ───────────────────────────────────────────────────────────────────────
launchBtn.addEventListener('click', startChain);
abortBtn.addEventListener('click', () => { S.abortFlag = true; });

async function startChain() {
  if (S.running) return;

  // Reset
  S.running    = true;
  S.abortFlag  = false;
  S.passCount  = 0;
  S.failCount  = 0;
  S.liveCtx    = {};
  S.logEntries = [];
  logScroll.innerHTML = '';
  resetProgress();
  setRunning(true);

  // Reset all step status dots (only enabled ones participate)
  S.steps.forEach(step => setStepDot(step.id, step.enabled ? 'pending' : 'pending'));

  // Build payload
  const payload = {
    steps: S.steps.filter(s => s.enabled).map(s => ({
      id:          s.id,
      name:        s.name,
      method:      s.method,
      url:         s.url,
      headers:     kvArrToObj(s.headers),
      params:      kvArrToObj(s.params),
      bodyType:    s.bodyType,
      bodyRaw:     s.bodyRaw,
      bodyForm:    kvArrToObj(s.bodyForm),
      dataRows:    s.dataRows,
      extractions: s.extractions.filter(e => e.varName && e.path),
      stopOnError: s.stopOnError,
    })),
    iterations:            parseInt(iterInput.value, 10)     || 1,
    globalEnv:             getGlobalEnv(),
    delayBetweenSteps:     parseInt(stepDelayInput.value, 10) || 0,
    delayBetweenIterations:parseInt(iterDelayInput.value, 10) || 0,
  };

  try {
    const response = await fetch('/api/execute-chain', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      appendInfoLog(`❌ Server rejected: ${response.statusText}`);
      setRunning(false);
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      if (S.abortFlag) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          handleChainEvent(ev);
          S.logEntries.push(ev);
        } catch { /* skip malformed */ }
      }
    }

  } catch (err) {
    if (!S.abortFlag) appendInfoLog(`❌ Connection error: ${err.message}`);
  } finally {
    setRunning(false);
  }
}

// ─── SSE Event Handler ─────────────────────────────────────────────────────────
function handleChainEvent(ev) {
  switch (ev.type) {

    case 'CHAIN_START':
      progressLabel.textContent = `Running ${ev.totalSteps} steps × ${ev.totalIterations} iteration(s)…`;
      break;

    case 'ITERATION_START':
      iterBadge.textContent = `Iter ${ev.iter + 1} / ${ev.totalIterations}`;
      appendIterLog(ev.iter + 1, ev.totalIterations);
      break;

    case 'STEP_START':
      setStepDot(getStepIdByIndex(ev.stepIndex), 'running');
      setStepCardClass(getStepIdByIndex(ev.stepIndex), 'step-running');
      break;

    case 'STEP_RESULT': {
      const sid = getStepIdByIndex(ev.stepIndex);
      setStepDot(sid, ev.isSuccess ? 'success' : 'error');
      setStepCardClass(sid, ev.isSuccess ? 'step-success' : 'step-error');

      if (ev.isSuccess) S.passCount++;
      else              S.failCount++;

      // Merge extracted vars into live context
      if (ev.extracted) Object.assign(S.liveCtx, ev.extracted);
      renderCtx(S.liveCtx);
      updateStats();
      updateProgress(ev.stepIndex + 1, S.steps.length, ev.iter, parseInt(iterInput.value,10)||1);
      appendStepLog(ev);
      break;
    }

    case 'STEP_ERROR': {
      const sid = getStepIdByIndex(ev.stepIndex);
      setStepDot(sid, 'error');
      setStepCardClass(sid, 'step-error');
      S.failCount++;
      updateStats();
      appendStepErrorLog(ev);
      break;
    }

    case 'ITERATION_DONE':
      // Context snapshot per iteration
      if (ev.ctx) renderCtx(ev.ctx);
      break;

    case 'CHAIN_STOPPED':
      appendInfoLog(`⛔ Chain stopped: ${ev.reason}`);
      break;

    case 'CHAIN_DONE':
      progressFill.style.width = '100%';
      progressPct.textContent  = '100%';
      progressLabel.textContent = `Done — ${S.passCount} passed, ${S.failCount} failed` +
        (ev.aborted ? ' (aborted)' : '');
      break;
  }
}

// ─── Step Status Helpers ───────────────────────────────────────────────────────
function getStepIdByIndex(idx) {
  return S.steps[idx]?.id ?? '';
}

function setStepDot(sid, state) {
  const dot = $(`dot-${sid}`);
  if (dot) { dot.className = `step-status-dot ${state}`; }
}

function setStepCardClass(sid, cls) {
  const card = $(`card-${sid}`);
  if (!card) return;
  card.classList.remove('step-running','step-success','step-error');
  card.classList.add(cls);
}

// ─── Progress ─────────────────────────────────────────────────────────────────
function updateProgress(stepDone, totalSteps, iter, totalIter) {
  const iterProgress = (iter / totalIter);
  const stepProgress = (stepDone / totalSteps) / totalIter;
  const pct = Math.round((iterProgress + stepProgress) * 100);
  progressFill.style.width = `${Math.min(pct, 99)}%`;
  progressPct.textContent  = `${Math.min(pct, 99)}%`;
  progressLabel.textContent = `Iter ${iter+1}/${totalIter} · Step ${stepDone}/${totalSteps}`;
}

function resetProgress() {
  progressFill.style.width = '0%';
  progressPct.textContent  = '0%';
  progressLabel.textContent = 'Starting…';
  statPass.textContent = '0';
  statFail.textContent = '0';
  iterBadge.textContent = 'Iter 0 / 0';
}

function updateStats() {
  statPass.textContent = S.passCount;
  statFail.textContent = S.failCount;
}

// ─── Running State ─────────────────────────────────────────────────────────────
function setRunning(running) {
  S.running = running;
  launchBtn.disabled = running;
  launchBtn.textContent = running ? '⏳ RUNNING…' : '🔗 RUN CHAIN';
  launchBtn.classList.toggle('running', running);
  abortBtn.style.display = running ? 'block' : 'none';
  runStatusBadge.textContent = running ? 'RUNNING' : 'IDLE';
  runStatusBadge.style.color = running ? 'var(--green)' : 'var(--muted)';
  runStatusBadge.style.borderColor = running ? 'var(--green)' : 'var(--border)';
}

// ─── Context Viewer ────────────────────────────────────────────────────────────
function renderCtx(ctx) {
  const keys = Object.keys(ctx);
  if (!keys.length) return;
  ctxDisplay.innerHTML = keys.map(k =>
    `<div class="ctx-kv">
      <span class="ctx-key">{{${escHtml(k)}}}</span>
      <span class="ctx-val">${escHtml(String(ctx[k]).slice(0, 120))}</span>
    </div>`
  ).join('');
}

// ─── Log Renderers ─────────────────────────────────────────────────────────────
function ensureLogActive() {
  const empty = $('empty-state');
  if (empty) empty.remove();
}

function appendIterLog(iter, total) {
  ensureLogActive();
  const el = document.createElement('div');
  el.className = 'chain-log log-iter';
  el.innerHTML = `
    <div class="chain-log-header" style="cursor:default;">
      <span class="status-badge b-inf">ITER</span>
      <span style="color:var(--accent);font-weight:700;">Iteration ${iter} of ${total}</span>
    </div>`;
  logScroll.appendChild(el);
  logScroll.scrollTop = logScroll.scrollHeight;
}

function appendStepLog(ev) {
  ensureLogActive();
  const badgeCls  = getStatusBadgeClass(ev.status);
  const extractedKeys = ev.extracted ? Object.keys(ev.extracted) : [];
  const jsonId = `jv-${ev.stepIndex}-${ev.iter}`;

  const el = document.createElement('div');
  el.className = `chain-log ${ev.isSuccess ? 'log-success' : 'log-error'}`;

  el.innerHTML = `
    <div class="chain-log-header">
      <span class="status-badge ${badgeCls}">${ev.status}</span>
      <span style="color:var(--muted);font-size:10px;">Step ${ev.stepIndex+1}</span>
      <span style="font-weight:700;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(ev.resolvedURL)}">${escHtml(ev.stepName)}</span>
      <span style="color:var(--muted);font-size:10px;">${ev.duration}ms</span>
      <button class="copy-btn copy-resp-btn">copy</button>
      <span style="color:var(--muted);font-size:10px;">▸</span>
    </div>
    <div class="chain-log-body">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px;font-family:monospace;word-break:break-all;">${escHtml(ev.resolvedURL)}</div>
      ${!ev.isSuccess ? `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:5px;padding:6px 8px;font-size:10px;color:#f87171;margin-bottom:6px;">⚠ ${ev.status} response — check body below</div>` : ''}
      ${extractedKeys.length ? `
        <div style="margin-bottom:6px;display:flex;flex-wrap:wrap;gap:4px;">
          <span style="font-size:10px;color:var(--accent2);margin-right:3px;">Extracted:</span>
          ${extractedKeys.map(k => `<span class="extract-badge">{{${escHtml(k)}}} = ${escHtml(String(ev.extracted[k]).slice(0,60))}</span>`).join('')}
        </div>` : ''}
      <div class="json-viewer" id="${jsonId}">${escHtml(JSON.stringify(ev.data, null, 2))}</div>
    </div>`;

  // Expand/collapse toggle
  el.querySelector('.chain-log-header').addEventListener('click', () => el.classList.toggle('expanded'));

  // Copy button — store response text directly in closure, no inline onclick needed
  const responseText = JSON.stringify(ev.data, null, 2);
  el.querySelector('.copy-resp-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(responseText, e.target);
  });

  logScroll.appendChild(el);
  logScroll.scrollTop = logScroll.scrollHeight;
}

function appendStepErrorLog(ev) {
  ensureLogActive();
  const el = document.createElement('div');
  el.className = 'chain-log log-error';
  el.innerHTML = `
    <div class="chain-log-header" style="cursor:default;">
      <span class="status-badge b-err">ERR</span>
      <span style="color:var(--muted);font-size:10px;">Step ${ev.stepIndex+1}</span>
      <span style="font-weight:700;">${escHtml(ev.stepName)}</span>
      <span style="color:var(--red);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:6px;">${escHtml(ev.error)}</span>
      ${ev.duration != null ? `<span style="color:var(--muted);font-size:10px;">${ev.duration}ms</span>` : ''}
    </div>`;
  logScroll.appendChild(el);
  logScroll.scrollTop = logScroll.scrollHeight;
}

function appendInfoLog(msg) {
  ensureLogActive();
  const el = document.createElement('div');
  el.className = 'chain-log log-info';
  el.innerHTML = `<div class="chain-log-header" style="cursor:default;"><span class="status-badge b-inf">INFO</span><span>${escHtml(msg)}</span></div>`;
  logScroll.appendChild(el);
  logScroll.scrollTop = logScroll.scrollHeight;
}

// ─── Clear / Export / Import ──────────────────────────────────────────────────
$('clear-log-btn').addEventListener('click', () => {
  logScroll.innerHTML = `
    <div class="empty-msg" id="empty-state">
      <div style="font-size:28px;margin-bottom:10px;">🔗</div>
      <div style="font-size:13px;font-weight:700;">No chain runs yet</div>
      <div style="font-size:11px;margin-top:4px;">Build your steps, then hit Run Chain.</div>
    </div>`;
  S.logEntries = [];
  S.passCount = 0; S.failCount = 0;
  updateStats();
  resetProgress();
  S.steps.forEach(step => { setStepDot(step.id, 'pending'); setStepCardClass(step.id, ''); });
  ctxDisplay.innerHTML = '<span style="color:var(--muted);font-size:11px;font-family:monospace;">No variables yet.</span>';
});

// Export run log (existing behaviour, button now labelled "↓ Log")
$('export-log-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(S.logEntries, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `chain-run-log-${Date.now()}.json`;
  a.click(); URL.revokeObjectURL(url);
});

// ── Export full chain config ───────────────────────────────────────────────────
// Serialises every step field + global env + run settings into one portable JSON.
// The file is self-contained — importing it restores the complete chain exactly.
$('export-chain-btn').addEventListener('click', () => {
  const chainExport = {
    _meta: {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      stepCount: S.steps.length,
    },
    settings: {
      iterations:             parseInt(iterInput.value, 10)      || 1,
      delayBetweenSteps:      parseInt(stepDelayInput.value, 10) || 0,
      delayBetweenIterations: parseInt(iterDelayInput.value, 10) || 0,
    },
    globalEnv: envVars.filter(e => e.k.trim()).map(e => ({ k: e.k, v: e.v })),
    steps: S.steps.map(s => ({
      name:        s.name,
      enabled:     s.enabled,
      method:      s.method,
      url:         s.url,
      headers:     s.headers,       // [{ k, v }]
      params:      s.params,        // [{ k, v }]
      bodyType:    s.bodyType,
      bodyRaw:     s.bodyRaw,
      bodyForm:    s.bodyForm,      // [{ k, v }]
      dataRows:    s.dataRows,      // bulk-row data if any
      pasteRaw:    s.pasteRaw,
      extractions: s.extractions,   // [{ varName, path }]
      stopOnError: s.stopOnError,
      // UI state — preserved so the chain opens exactly as left
      expanded:    s.expanded,
      activeTab:   s.activeTab,
    })),
  };

  const blob = new Blob([JSON.stringify(chainExport, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  // Use a readable filename based on first step name or fallback
  const label = S.steps[0]?.name?.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'chain';
  a.href = url; a.download = `chain-${label}-${Date.now()}.json`;
  a.click(); URL.revokeObjectURL(url);
});

// ── Import full chain config ───────────────────────────────────────────────────
// Reads the exported JSON, validates the shape, wipes current state,
// and fully restores steps + env + settings. Plug and play.
$('import-chain-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-imported

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Basic shape validation
    if (!Array.isArray(data.steps)) {
      appendInfoLog('❌ Import failed — invalid chain file (missing steps array).');
      return;
    }

    // ── Restore settings ──
    if (data.settings) {
      if (data.settings.iterations)             iterInput.value      = data.settings.iterations;
      if (data.settings.delayBetweenSteps != null) stepDelayInput.value = data.settings.delayBetweenSteps;
      if (data.settings.delayBetweenIterations != null) iterDelayInput.value = data.settings.delayBetweenIterations;
    }

    // ── Restore global env ──
    // Clear existing rows from DOM and array
    envVars.length = 0;
    envKvList.innerHTML = '';
    if (Array.isArray(data.globalEnv) && data.globalEnv.length) {
      $('env-panel').style.display = 'block';
      data.globalEnv.forEach(e => addEnvRow(e.k, e.v));
    }
    refreshEnvBadges();

    // ── Restore steps ──
    // Reset counter so IDs stay clean, then rebuild from exported step objects
    stepIdCounter = 0;
    S.steps = data.steps.map(s => makeStep({
      name:        s.name        ?? 'Step',
      enabled:     s.enabled     ?? true,
      method:      s.method      ?? 'GET',
      url:         s.url         ?? '',
      headers:     Array.isArray(s.headers)     ? s.headers     : [],
      params:      Array.isArray(s.params)      ? s.params      : [],
      bodyType:    s.bodyType    ?? 'none',
      bodyRaw:     s.bodyRaw     ?? '',
      bodyForm:    Array.isArray(s.bodyForm)    ? s.bodyForm    : [],
      dataRows:    Array.isArray(s.dataRows)    ? s.dataRows    : [],
      pasteRaw:    s.pasteRaw    ?? '',
      extractions: Array.isArray(s.extractions) ? s.extractions : [],
      stopOnError: s.stopOnError ?? true,
      expanded:    s.expanded    ?? false,
      activeTab:   s.activeTab   ?? 'request',
    }));

    renderAll();
    persistChain();
    appendInfoLog(`✓ Imported "${file.name}" — ${S.steps.length} step${S.steps.length !== 1 ? 's' : ''} loaded.`);

  } catch (err) {
    appendInfoLog(`❌ Import failed — ${err.message}`);
  }
});

// ─── Clipboard ────────────────────────────────────────────────────────────────
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.style.background = 'var(--green)';
    btn.style.color = 'black';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1400);
  } catch { btn.textContent = 'fail'; }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function kvArrToObj(arr) {
  const obj = {};
  (arr || []).forEach(item => { if (item.k?.trim()) obj[item.k.trim()] = item.v || ''; });
  return obj;
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function persistChain() {
  try {
    localStorage.setItem('chain-runner-steps', JSON.stringify(S.steps));
    localStorage.setItem('chain-runner-env',   JSON.stringify(envVars));
    localStorage.setItem('chain-runner-cfg', JSON.stringify({
      iterations: iterInput.value,
      stepDelay:  stepDelayInput.value,
      iterDelay:  iterDelayInput.value,
    }));
  } catch { /* quota issues — ignore */ }
}

function restoreChain() {
  try {
    const raw = localStorage.getItem('chain-runner-steps');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        // Restore stepIdCounter so new steps don't clash
        parsed.forEach(s => {
          const n = parseInt(s.id.split('-')[1], 10);
          if (n > stepIdCounter) stepIdCounter = n;
        });
        S.steps = parsed;
        renderAll();
      }
    }

    const envRaw = localStorage.getItem('chain-runner-env');
    if (envRaw) {
      const evs = JSON.parse(envRaw);
      if (Array.isArray(evs) && evs.length) {
        $('env-panel').style.display = 'block';
        evs.forEach(e => addEnvRow(e.k, e.v));
      }
    }

    const cfgRaw = localStorage.getItem('chain-runner-cfg');
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      if (cfg.iterations) iterInput.value     = cfg.iterations;
      if (cfg.stepDelay)  stepDelayInput.value = cfg.stepDelay;
      if (cfg.iterDelay)  iterDelayInput.value = cfg.iterDelay;
    }
  } catch { /* corrupted — start fresh */ }
}


// ─── Bootstrap ────────────────────────────────────────────────────────────────
restoreChain();

// If no saved steps, seed with a default example pair so the user sees the pattern immediately
if (S.steps.length === 0) {
  const s1 = makeStep({
    name: 'Get Token',
    method: 'POST',
    url: '{{base_url}}/api/auth/login',
    headers: [{ k: 'Content-Type', v: 'application/json' }, { k: 'Accept', v: 'application/json' }],
    bodyType: 'json',
    bodyRaw: '{\n  "username": "admin",\n  "password": "admin123"\n}',
    extractions: [{ varName: 'token', path: 'token' }],
    expanded: true,
    activeTab: 'body',
  });
  const s2 = makeStep({
    name: 'Fetch Data',
    method: 'GET',
    url: '{{base_url}}/api/data',
    headers: [{ k: 'Authorization', v: 'Bearer {{token}}' }, { k: 'Content-Type', v: 'application/json' }, { k: 'Accept', v: 'application/json' }],
    expanded: false,
    activeTab: 'request',
  });
  S.steps.push(s1, s2);

  // Seed base_url into global env
  addEnvRow('base_url', 'https://your-api.com');
  addEnvRow('token', 'https://your-api.com');
  $('env-panel').style.display = 'block';

  renderAll();
}

updateLaunchState();