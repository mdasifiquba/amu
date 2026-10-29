const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const MAX_BODY_BYTES = 1_000_000;

if (!ADMIN_PASSWORD || !SESSION_SECRET || !DATABASE_URL) {
  throw new Error('ADMIN_PASSWORD, SESSION_SECRET, and DATABASE_URL must be configured.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isAdminRequest(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).expiresAt > Date.now();
  } catch {
    return false;
  }
}

function validRecord(record) {
  return record && typeof record === 'object' &&
    typeof record.id === 'string' && record.id.length <= 100 &&
    typeof record.username === 'string' && record.username.trim().length > 0 && record.username.length <= 120 &&
    Array.isArray(record.details) && record.details.length === 85;
}

async function storeRecord(record, keepId = false) {
  const saved = { ...record, id: keepId ? record.id : crypto.randomUUID() };
  await pool.query(
    'INSERT INTO submissions (id, record, created_at) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW())) ON CONFLICT (id) DO NOTHING',
    [saved.id, JSON.stringify(saved), keepId && record.submittedAt ? new Date(record.submittedAt).toISOString() : null],
  );
  return saved;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    await pool.query('SELECT 1');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readJson(req);
    if (!constantTimeEqual(body.password || '', ADMIN_PASSWORD)) {
      return sendJson(res, 401, { error: 'Incorrect admin passcode.' });
    }
    return sendJson(res, 200, { token: createAdminToken() });
  }

  if (url.pathname.startsWith('/api/admin/') && !isAdminRequest(req)) {
    return sendJson(res, 401, { error: 'Admin login required.' });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/submissions') {
    const result = await pool.query('SELECT record FROM submissions ORDER BY created_at DESC');
    return sendJson(res, 200, { submissions: result.rows.map(row => row.record) });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/migrate') {
    const body = await readJson(req);
    const records = Array.isArray(body.submissions) ? body.submissions.slice(0, 500) : [];
    let imported = 0;
    for (const record of records) {
      if (validRecord(record)) {
        const result = await pool.query(
          'INSERT INTO submissions (id, record, created_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO NOTHING',
          [record.id, JSON.stringify(record)],
        );
        imported += result.rowCount;
      }
    }
    return sendJson(res, 200, { imported });
  }

  const deleteMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    await pool.query('DELETE FROM submissions WHERE id = $1', [decodeURIComponent(deleteMatch[1])]);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/submissions') {
    const record = await readJson(req);
    if (!validRecord(record)) {
      return sendJson(res, 400, { error: 'Submission data is incomplete.' });
    }
    const saved = await storeRecord(record);
    return sendJson(res, 201, { submission: saved });
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }

    const filePath = path.join(__dirname, 'index.html');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    console.error('Request failed:', error);
    sendJson(res, error.status || 500, { error: error.status ? error.message : 'Server error.' });
  }
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      record JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  server.listen(PORT, '0.0.0.0', () => console.log(`Portal listening on port ${PORT}`));
}

start().catch(error => {
  console.error('Unable to start portal:', error);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => pool.end()));
