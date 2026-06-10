/**
 * API Runner - server.js
 * Express backend: handles bulk request execution with SSE streaming.
 * Each data row replaces {{variable}} placeholders in URL, headers, and body.
 */

require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Proxy config (controlled entirely from .env) ──────────────────────────────
const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_URL     = process.env.PROXY_URL || '';
const proxyAgent    = PROXY_ENABLED && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// ─── Runner defaults from .env ─────────────────────────────────────────────────
const DEFAULT_TIMEOUT  = parseInt(process.env.DEFAULT_TIMEOUT_MS,  10) || 30000;
const DEFAULT_DELAY    = parseInt(process.env.DEFAULT_DELAY_MS,     10) || 300;
const MAX_ITERATIONS   = parseInt(process.env.MAX_ITERATIONS,       10) || 500;
const JSON_BODY_LIMIT  = process.env.JSON_BODY_LIMIT  || '10mb';
const FILE_PARSE_LIMIT = process.env.FILE_PARSE_LIMIT || '5mb';

console.log(`\n⚙  Proxy: ${PROXY_ENABLED ? `ON → ${PROXY_URL}` : 'OFF'}`);
console.log(`⚙  Timeout: ${DEFAULT_TIMEOUT}ms | Max iterations: ${MAX_ITERATIONS}\n`);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Variable Interpolation Utility ───────────────────────────────────────────
/**
 * Replaces all {{key}} placeholders in a string with values from a data row.
 * Example: interpolate("Hello {{name}}", { name: "Alice" }) => "Hello Alice"
 */
function interpolate(template, rowData) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return rowData.hasOwnProperty(key) ? String(rowData[key]) : match;
  });
}

/**
 * Deep-interpolates an object: walks all string values and applies variable substitution.
 * Handles nested objects (e.g., headers, body fields).
 */
function deepInterpolate(obj, rowData) {
  if (typeof obj === 'string') return interpolate(obj, rowData);
  if (Array.isArray(obj)) return obj.map(item => deepInterpolate(item, rowData));
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[interpolate(k, rowData)] = deepInterpolate(v, rowData);
    }
    return result;
  }
  return obj;
}

// ─── CSV Parser ────────────────────────────────────────────────────────────────
/**
 * Parses a raw CSV string into an array of objects.
 * First row is treated as headers (keys). Handles quoted fields.
 */
function parseCSV(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

  const parseRow = (line) => {
    const cols = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] !== undefined ? vals[i] : ''; });
    return row;
  });
}

// ─── Safe JSON Parser ──────────────────────────────────────────────────────────
/**
 * Attempts to parse a JSON string safely. Returns { ok, data, error }.
 * Catches trailing commas, mismatched brackets, etc.
 */
function safeParseJSON(str) {
  try {
    return { ok: true, data: JSON.parse(str) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── SSE Helper ────────────────────────────────────────────────────────────────
/**
 * Sends a Server-Sent Event chunk to the client.
 * Each event is a JSON object with a 'type' discriminator.
 */
function sendSSE(res, type, payload) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

// ─── Main Runner Endpoint ──────────────────────────────────────────────────────
/**
 * POST /api/execute-runner
 * Accepts the full run config, streams progress events back via SSE.
 *
 * Body shape:
 * {
 *   url: string,            // e.g. "https://api.example.com/users/{{id}}"
 *   method: string,         // GET | POST | PUT | DELETE | PATCH
 *   headers: { key: val },  // may contain {{variables}}
 *   params: { key: val },   // query params
 *   bodyType: string,       // 'none' | 'json' | 'form'
 *   bodyRaw: string,        // raw JSON string (if bodyType === 'json')
 *   bodyForm: { key: val }, // form-data fields (if bodyType === 'form')
 *   dataRows: [ {...} ],    // parsed data rows from uploaded file
 *   delay: number,          // ms between requests
 *   stopOnError: boolean,   // halt loop on first non-2xx
 *   concurrency: number,    // NOT used for sequential; reserved for future parallel mode
 * }
 */
app.post('/api/execute-runner', async (req, res) => {
  // Set SSE headers — keeps the connection alive for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind proxy
  res.flushHeaders();

  const {
    url,
    method = 'GET',
    headers: rawHeaders = {},
    params: rawParams = {},
    bodyType = 'none',
    bodyRaw = '',
    bodyForm = {},
    dataRows = [],
    delay = 0,
    stopOnError = false,
  } = req.body;

  const total = dataRows.length;
  let successCount = 0;
  let failureCount = 0;

  // Signal run start
  sendSSE(res, 'START', { total });

  // ── Sequential loop: one request per data row ────────────────────────────
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];

    // 1. Interpolate URL with current row's variable values
    const resolvedURL = interpolate(url, row);

    // 2. Interpolate headers
    const resolvedHeaders = deepInterpolate(rawHeaders, row);

    // 3. Interpolate query params
    const resolvedParams = deepInterpolate(rawParams, row);

    // 4. Build request body based on type
    let requestData = undefined;
    if (bodyType === 'json' && bodyRaw) {
      const interpolatedBody = interpolate(bodyRaw, row);
      const parsed = safeParseJSON(interpolatedBody);
      if (!parsed.ok) {
        sendSSE(res, 'ROW_ERROR', {
          index: i,
          row,
          error: `JSON parse error at row ${i + 1}: ${parsed.error}`,
        });
        failureCount++;
        if (stopOnError) break;
        continue;
      }
      requestData = parsed.data;
    } else if (bodyType === 'form') {
      requestData = deepInterpolate(bodyForm, row);
    } else if (bodyType === 'bulk-row') {
      // In bulk mode the row object itself is the request body.
      // row already contains the parsed data (e.g. { title, body, userId })
      requestData = row;
    }

    // 5. Execute the request via Axios
    // validateStatus: () => true ensures 4xx/5xx don't throw — we handle them ourselves
    const startTime = Date.now();
    try {
      const axiosConfig = {
        method: method.toLowerCase(),
        url: resolvedURL,
        headers: resolvedHeaders,
        params: resolvedParams,
        validateStatus: () => true,
        timeout: DEFAULT_TIMEOUT,
        ...(proxyAgent && { httpsAgent: proxyAgent, httpAgent: proxyAgent }),
      };

      // Only attach body for non-GET methods
      if (requestData !== undefined && method !== 'GET') {
        axiosConfig.data = requestData;
      }

      const response = await axios(axiosConfig);
      const duration = Date.now() - startTime;
      const isSuccess = response.status >= 200 && response.status < 300;

      if (isSuccess) successCount++;
      else failureCount++;

      // Stream the result back immediately — no waiting for the full loop
      sendSSE(res, 'ROW_RESULT', {
        index: i,
        row,
        status: response.status,
        statusText: response.statusText,
        duration,
        data: response.data,
        isSuccess,
        successCount,
        failureCount,
        total,
      });

      // Halt execution if stopOnError is set and request failed
      if (!isSuccess && stopOnError) {
        sendSSE(res, 'STOPPED', { reason: `Row ${i + 1} returned ${response.status}`, successCount, failureCount });
        break;
      }

    } catch (err) {
      // Network-level failures (timeout, DNS, etc.)
      const duration = Date.now() - startTime;
      failureCount++;
      sendSSE(res, 'ROW_ERROR', {
        index: i,
        row,
        error: err.message,
        duration,
        successCount,
        failureCount,
        total,
      });

      if (stopOnError) {
        sendSSE(res, 'STOPPED', { reason: err.message, successCount, failureCount });
        break;
      }
    }

    // Delay between iterations (if configured)
    if (delay > 0 && i < dataRows.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Signal run complete
  sendSSE(res, 'DONE', { successCount, failureCount, total });
  res.end();
});

// ─── CSV/JSON Parse Endpoint (validation before run) ─────────────────────────
app.post('/api/parse-file', express.text({ limit: FILE_PARSE_LIMIT, type: '*/*' }), (req, res) => {
  const { fileType } = req.query; // 'csv' or 'json'
  const raw = req.body;

  try {
    let rows;
    if (fileType === 'csv') {
      rows = parseCSV(raw);
    } else {
      const parsed = safeParseJSON(raw);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    }
    res.json({ ok: true, rows, count: rows.length, keys: Object.keys(rows[0] || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Deep-get a value from an object using dot-notation path ─────────────────
/**
 * Resolves a dot-notation path inside a nested object.
 * Example: deepGet({ a: { b: { c: 42 } } }, "a.b.c") => 42
 * Also handles array indexes: "data.0.id" => first element's id
 */
function deepGet(obj, path) {
  if (!path || obj === undefined || obj === null) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

// ─── Chain Runner Endpoint ────────────────────────────────────────────────────
/**
 * POST /api/execute-chain
 *
 * Runs a sequence of API steps in order. Each step can:
 *  - Extract values from its own response via dot-notation "extractions"
 *  - Inject those extracted values (plus any prior ones) into later steps
 *    via {{varName}} placeholders in URL, headers, params, and body
 *  - Use pasted/uploaded row data as its body (bodyType: 'bulk-row')
 *
 * Supports repeating the entire chain N times (iterations).
 * Each iteration gets a fresh context but starts with the global env.
 *
 * Payload shape:
 * {
 *   steps: [
 *     {
 *       id: string,              // unique step id (e.g. "step-0")
 *       name: string,            // display label
 *       method: string,
 *       url: string,             // may contain {{vars}}
 *       headers: { k: v },       // may contain {{vars}}
 *       params:  { k: v },       // may contain {{vars}}
 *       bodyType: 'none'|'json'|'form'|'bulk-row',
 *       bodyRaw: string,         // JSON template string
 *       bodyForm: { k: v },
 *       dataRows: [ {...} ],     // for bodyType 'bulk-row'
 *       extractions: [
 *         { varName: string, path: string }  // e.g. { varName:"token", path:"token" }
 *       ],
 *       stopOnError: boolean,
 *     }
 *   ],
 *   iterations: number,    // how many times to repeat the full chain
 *   globalEnv: { k: v },  // seed variables available to all steps from the start
 *   delayBetweenSteps: number,   // ms pause between steps
 *   delayBetweenIterations: number,
 * }
 */
app.post('/api/execute-chain', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const {
    steps = [],
    iterations = 1,
    globalEnv = {},
    delayBetweenSteps = 0,
    delayBetweenIterations = 0,
  } = req.body;

  const totalIterations = Math.max(1, Math.min(iterations, MAX_ITERATIONS));
  let chainAborted = false;

  sendSSE(res, 'CHAIN_START', {
    totalSteps: steps.length,
    totalIterations,
  });

  // ── Outer loop: repeat chain N times ──────────────────────────────────────
  for (let iter = 0; iter < totalIterations; iter++) {
    if (chainAborted) break;

    // Context = globalEnv + values extracted from responses this iteration
    // Each iteration starts fresh from globalEnv only (no bleed between iterations)
    const ctx = { ...globalEnv };

    sendSSE(res, 'ITERATION_START', { iter, totalIterations });

    // ── Inner loop: each step in sequence ───────────────────────────────────
    for (let si = 0; si < steps.length; si++) {
      if (chainAborted) break;

      const step = steps[si];

      // Resolve the data row for this step (bulk-row mode uses dataRows[iter] or [0])
      let rowData = { ...ctx }; // start with current context
      if (step.bodyType === 'bulk-row' && Array.isArray(step.dataRows) && step.dataRows.length > 0) {
        // If iterating, cycle through rows; otherwise always row 0
        const rowIndex = iter % step.dataRows.length;
        rowData = { ...ctx, ...step.dataRows[rowIndex] };
      }

      // Resolve all fields using current context
      const resolvedURL     = interpolate(step.url || '', rowData);
      const resolvedHeaders = deepInterpolate(step.headers || {}, rowData);
      const resolvedParams  = deepInterpolate(step.params  || {}, rowData);

      // Build body
      let requestData = undefined;
      if (step.bodyType === 'json' && step.bodyRaw) {
        const interpolatedBody = interpolate(step.bodyRaw, rowData);
        const parsed = safeParseJSON(interpolatedBody);
        if (!parsed.ok) {
          sendSSE(res, 'STEP_ERROR', {
            iter, stepIndex: si, stepName: step.name,
            error: `Body JSON parse error: ${parsed.error}`,
          });
          if (step.stopOnError) { chainAborted = true; break; }
          continue;
        }
        requestData = parsed.data;
      } else if (step.bodyType === 'form') {
        requestData = deepInterpolate(step.bodyForm || {}, rowData);
      } else if (step.bodyType === 'bulk-row') {
        // Send the merged rowData (ctx + dataRow) — strip internal ctx keys if desired
        // For simplicity we send the raw data row only (not the entire ctx)
        const rowIndex = iter % (step.dataRows?.length || 1);
        requestData = step.dataRows?.[rowIndex] ?? {};
      }

      const startTime = Date.now();
      sendSSE(res, 'STEP_START', {
        iter, stepIndex: si, stepName: step.name,
        method: step.method, url: resolvedURL,
      });

      try {
        const axiosConfig = {
          method: (step.method || 'GET').toLowerCase(),
          url: resolvedURL,
          headers: resolvedHeaders,
          params: resolvedParams,
          validateStatus: () => true,
          timeout: DEFAULT_TIMEOUT,
          ...(proxyAgent && { httpsAgent: proxyAgent, httpAgent: proxyAgent }),
        };
        if (requestData !== undefined && step.method !== 'GET') {
          axiosConfig.data = requestData;
        }

        const response = await axios(axiosConfig);
        const duration  = Date.now() - startTime;
        const isSuccess = response.status >= 200 && response.status < 300;

        // ── Extract variables from response ──────────────────────────────
        const extracted = {};
        if (Array.isArray(step.extractions)) {
          for (const ex of step.extractions) {
            if (!ex.varName || !ex.path) continue;
            const val = deepGet(response.data, ex.path);
            if (val !== undefined) {
              ctx[ex.varName] = String(val); // store in context for next steps
              extracted[ex.varName] = String(val);
            }
          }
        }

        sendSSE(res, 'STEP_RESULT', {
          iter, stepIndex: si, stepName: step.name,
          status: response.status, statusText: response.statusText,
          duration, data: response.data, isSuccess,
          extracted, // which vars were pulled out
          resolvedURL, // show the actual URL used (post-interpolation)
        });

        if (!isSuccess && step.stopOnError) {
          sendSSE(res, 'CHAIN_STOPPED', {
            reason: `Step "${step.name}" returned ${response.status}`,
            iter, stepIndex: si,
          });
          chainAborted = true;
          break;
        }

      } catch (err) {
        const duration = Date.now() - startTime;
        sendSSE(res, 'STEP_ERROR', {
          iter, stepIndex: si, stepName: step.name,
          error: err.message, duration,
        });
        if (step.stopOnError) {
          sendSSE(res, 'CHAIN_STOPPED', { reason: err.message, iter, stepIndex: si });
          chainAborted = true;
          break;
        }
      }

      // Pause between steps
      if (delayBetweenSteps > 0 && si < steps.length - 1) {
        await new Promise(r => setTimeout(r, delayBetweenSteps));
      }
    }

    sendSSE(res, 'ITERATION_DONE', { iter, totalIterations, ctx });

    // Pause between iterations
    if (delayBetweenIterations > 0 && iter < totalIterations - 1) {
      await new Promise(r => setTimeout(r, delayBetweenIterations));
    }
  }

  sendSSE(res, 'CHAIN_DONE', { totalIterations, aborted: chainAborted });
  res.end();
});

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 API Runner live at http://localhost:${PORT}\n`);
});