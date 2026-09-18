'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// public/ is the only directory this process serves. Every other file in the
// repo - server.js, scripts/, data/, .env - sits outside this root and is
// unreachable over HTTP by construction, not by rule.
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

/* ---------- config ---------- */
// Platform environment wins; .env is a local-development fallback and is
// gitignored. The service key is read here and never sent to the browser.
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY;

// Being a valid Supabase user is not enough - the address must also be on this
// list. Supabase signups are open on this project, so without it anyone who
// registered could read the book.
const ALLOWED_EMAILS = new Set(
  (env.ALLOWED_EMAILS || '').split(/[,;\s]+/).filter(Boolean).map(e => e.toLowerCase())
);

const SESSION_COOKIE = 'bd_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours

app.disable('x-powered-by');
app.set('trust proxy', 1);                     // Railway terminates TLS upstream

/* ---------- sessions ---------- */
// Stateless signed cookie: {email, exp} plus an HMAC. Derived from the service
// key so it survives a restart and works across instances without a store.
// Nothing secret rides in the cookie - it names the user, it does not grant
// Supabase access.
const SESSION_KEY = SUPABASE_KEY
  ? crypto.createHmac('sha256', SUPABASE_KEY).update('broking-dashboard-session-v1').digest()
  : null;
const b64 = b => Buffer.from(b).toString('base64url');

function issueSession(email) {
  const payload = b64(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS }));
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readSession(req) {
  if (!SESSION_KEY) return null;
  const raw = (req.headers.cookie || '')
    .split(';').map(s => s.trim()).find(c => c.startsWith(SESSION_COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(SESSION_COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
  // Constant-time compare, and only on equal lengths - timingSafeEqual throws otherwise.
  if (sig.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!data || !data.email || !data.exp || Date.now() > data.exp) return null;
  // The allowlist can change under a live session; re-check it every request.
  if (!ALLOWED_EMAILS.has(String(data.email).toLowerCase())) return null;
  return data;
}

function setSessionCookie(req, res, value, maxAgeMs) {
  const bits = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (req.secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/* ---------- headers ---------- */
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Reads everywhere; POST only on the two auth endpoints.
const POST_ALLOWED = new Set(['/auth/login', '/auth/logout']);
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.method === 'POST' && POST_ALLOWED.has(req.path)) return next();
  res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('Method Not Allowed');
});

/* ---------- auth routes (must sit before the gate) ---------- */
// Crude per-IP throttle. Supabase rate-limits too, but the login page is public.
const attempts = new Map();
const MAX_ATTEMPTS = 10, WINDOW_MS = 15 * 60 * 1000;
function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= MAX_ATTEMPTS;
}
function noteAttempt(ip, ok) {
  if (ok) return attempts.delete(ip);
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else rec.count++;
}

app.post('/auth/login', express.json({ limit: '4kb' }), async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: 'Sign-in is not configured.' });
  const ip = req.ip || 'unknown';
  if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  // One message for every failure, so this never reveals which emails exist.
  const DENY = { error: 'Those details were not recognised.' };
  if (!email || !password) { noteAttempt(ip, false); return res.status(400).json(DENY); }
  if (!ALLOWED_EMAILS.has(email)) { noteAttempt(ip, false); return res.status(401).json(DENY); }

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) { noteAttempt(ip, false); return res.status(401).json(DENY); }
    const body = await r.json();
    // Trust the address Supabase confirms, not the one that was typed.
    const confirmed = String((body.user && body.user.email) || email).toLowerCase();
    if (!ALLOWED_EMAILS.has(confirmed)) { noteAttempt(ip, false); return res.status(401).json(DENY); }

    noteAttempt(ip, true);
    setSessionCookie(req, res, issueSession(confirmed), SESSION_TTL_MS);
    res.json({ ok: true, email: confirmed });
  } catch (err) {
    console.error('Sign-in failed:', err && err.message);
    res.status(502).json({ error: 'Could not reach the sign-in service.' });
  }
});

app.post('/auth/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect(302, '/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

/* ---------- the gate: default deny ---------- */
const OPEN_PATHS = new Set(['/login', '/login.html']);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path) || req.path.startsWith('/auth/')) return next();
  const session = readSession(req);
  if (session) { req.session = session; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
  res.set('Cache-Control', 'no-store').redirect(302, '/login');
});

/* ---------- everything below requires a session ---------- */
app.get('/api/me', (req, res) => res.set('Cache-Control', 'no-store').json({ email: req.session.email }));

const SELECT = [
  'policy_id', 'client', 'account_owner', 'product_line', 'country', 'region',
  'distribution', 'business_type', 'status', 'currency',
  'inception_date', 'expiry_date', 'gwp_gbp', 'revenue_gbp',
].join(',');

const shape = r => ({
  policyId: r.policy_id, client: r.client, owner: r.account_owner,
  product: r.product_line, country: r.country, region: r.region,
  distribution: r.distribution, businessType: r.business_type,
  status: r.status, currency: r.currency,
  inception: r.inception_date, expiry: r.expiry_date,
  gwp: Number(r.gwp_gbp), revenue: Number(r.revenue_gbp),
});

// PostgREST caps a response at 1000 rows, so page through rather than
// silently truncating once the book outgrows that.
async function fetchAllPolicies() {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/policies?select=${SELECT}&order=policy_id.asc`, {
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`Supabase responded ${res.status}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

const TTL_MS = 60_000;
let cache = { at: 0, body: null, inflight: null };

app.get('/api/policies', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured');
    return res.status(503).json({ error: 'Data source is not configured.' });
  }
  try {
    const fresh = cache.body && Date.now() - cache.at < TTL_MS;
    if (!fresh) {
      cache.inflight = cache.inflight || fetchAllPolicies()
        .then(rows => { cache = { at: Date.now(), body: { policies: rows.map(shape) }, inflight: null }; })
        .catch(err => { cache.inflight = null; throw err; });
      await cache.inflight;
    }
    res.set('Cache-Control', 'no-store').json(cache.body);
  } catch (err) {
    console.error('Failed to load policies:', err && err.message);
    if (cache.body) return res.set('Cache-Control', 'no-store').json(cache.body);
    res.status(502).json({ error: 'Could not reach the data source.' });
  }
});

// The dashboard itself. index:false below stops express.static serving it at /.
app.get(['/', '/index.html'], (req, res) =>
  res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use(express.static(PUBLIC_DIR, {
  index: false,
  dotfiles: 'deny',
  redirect: false,
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Request failed:', err && err.message);
  res.status(500).type('text/plain').send('Internal Server Error');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${server.address().port}`);
  if (!SUPABASE_URL || !SUPABASE_KEY) console.warn('WARNING: Supabase is not configured; the app will not serve data or sign anyone in.');
  if (!ALLOWED_EMAILS.size) console.warn('WARNING: ALLOWED_EMAILS is empty; nobody can sign in.');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
