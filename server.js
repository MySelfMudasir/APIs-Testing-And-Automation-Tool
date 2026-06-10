/**
 * API Runner - server.js
 * Express backend: handles bulk request execution with SSE streaming.
 * Each data row replaces {{variable}} placeholders in URL, headers, and body.
 */

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────

// ── CORS — allows browser at localhost to call external HTTPS APIs ──
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Request logger ──
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        console.log(`\n→ ${req.method} ${req.path}`);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
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
        if (bodyType === 'bulk-row') {
            // Bulk mode: the row itself IS the request body — no template, no interpolation needed
            requestData = row;
        } else if (bodyType === 'json' && bodyRaw) {
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
                validateStatus: () => true, // Never throw on any HTTP status
                timeout: 30000,             // 30s hard cap per request
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

            // ── Terminal log ──
            const statusIcon = isSuccess ? '✅' : '❌';
            console.log(`  ${statusIcon} [${i + 1}/${total}] ${method} ${resolvedURL} → ${response.status} ${response.statusText} (${duration}ms)`);
            if (!isSuccess) {
                console.log(`     ↳ Error body: ${JSON.stringify(response.data).slice(0, 300)}`);
            }

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
            console.log(`  💥 [${i + 1}/${total}] ${method} ${resolvedURL} → NETWORK ERROR: ${err.message} (${duration}ms)`);
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
    console.log(`\n✔ Run complete — ${successCount} success, ${failureCount} failed out of ${total} total\n`);
    sendSSE(res, 'DONE', { successCount, failureCount, total });
    res.end();
});

// ─── CSV/JSON Parse Endpoint (validation before run) ─────────────────────────
app.post('/api/parse-file', express.text({ limit: '5mb', type: '*/*' }), (req, res) => {
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

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 API Runner live at http://localhost:${PORT}\n`);
});