const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---------- Configuration (server-side only) ----------
// The secret key bypasses row level security. It is read from the environment
// here and used only in this process: it is never sent to the browser, never
// logged, and never included in a response.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const configured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
if (!configured) console.warn('SUPABASE_URL / SUPABASE_SERVICE_KEY not set: sign-in and data are unavailable.');

// Comma-separated, case-insensitive. Unset means any confirmed Supabase user may sign in.
const ALLOWED = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (configured && ALLOWED.length === 0) console.warn('ALLOWED_EMAILS not set: any confirmed Supabase user can sign in.');
const isAllowed = email => ALLOWED.length === 0 || ALLOWED.includes(String(email || '').toLowerCase());

// Clients never keep a session: a signed-in user's token must never replace the
// secret key on the shared data client, so auth calls get a fresh client each time.
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const db = configured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, CLIENT_OPTS) : null;
const authClient = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, CLIENT_OPTS);

// ---------- Session cookies ----------
const ACCESS = 'bd_access', REFRESH = 'bd_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 3600; // sign in again after a week

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOpts(req, maxAgeSec) {
  // HttpOnly: page scripts can't read the tokens. Secure whenever served over HTTPS.
  return { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge: maxAgeSec * 1000 };
}

function setSession(req, res, session) {
  res.cookie(ACCESS, session.access_token, cookieOpts(req, session.expires_in || 3600));
  res.cookie(REFRESH, session.refresh_token, cookieOpts(req, REFRESH_MAX_AGE));
}

function clearSession(req, res) {
  for (const name of [ACCESS, REFRESH]) res.clearCookie(name, { ...cookieOpts(req, 0), maxAge: undefined });
}

// Verified tokens are remembered briefly so each page asset doesn't cost a round trip to Supabase.
const verified = new Map(); // sha256(token) -> { email, until }
const VERIFY_CACHE_MS = 30 * 1000;
const tokenKey = t => crypto.createHash('sha256').update(t).digest('hex');

async function userForToken(token) {
  const key = tokenKey(token);
  const hit = verified.get(key);
  if (hit && hit.until > Date.now()) return hit.email;
  const { data, error } = await authClient().auth.getUser(token);
  if (error || !data?.user) return null;
  const email = data.user.email;
  if (!data.user.email_confirmed_at || !isAllowed(email)) return null;
  if (verified.size > 1000) verified.clear();
  verified.set(key, { email, until: Date.now() + VERIFY_CACHE_MS });
  return email;
}

// Resolves the signed-in user, refreshing an expired access token from the refresh token.
async function currentUser(req, res) {
  if (!configured) return null;
  const cookies = readCookies(req);
  if (cookies[ACCESS]) {
    const email = await userForToken(cookies[ACCESS]);
    if (email) return email;
  }
  if (cookies[REFRESH]) {
    const { data, error } = await authClient().auth.refreshSession({ refresh_token: cookies[REFRESH] });
    if (!error && data?.session && data.user && isAllowed(data.user.email)) {
      setSession(req, res, data.session);
      return data.user.email;
    }
  }
  return null;
}

// ---------- Login throttling ----------
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10, WINDOW_MS = 15 * 60 * 1000;
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  a.count += 1;
  return a.count > MAX_ATTEMPTS;
}

// Form posts must come from this site (defence in depth on top of SameSite cookies).
// Modern browsers say so directly in Sec-Fetch-Site, even when they hide the origin
// (Origin: null); older ones fall back to comparing the Origin or Referer host.
function sameOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

// ---------- Data ----------
// Only the fields the dashboard draws, so nothing else in the table leaves the server.
const FIELDS = 'policy_id, inception_date, account_owner, product_line, gwp_gbp, revenue_gbp';
const PAGE = 1000;           // Supabase caps a single response at 1,000 rows
const CACHE_MS = 60 * 1000;  // serve repeat page views from memory for a minute
let cache = { at: 0, body: null };

async function loadPolicies() {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('policies')
      .select(FIELDS).order('policy_id').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return {
    policies: rows.map(r => ({
      id: r.policy_id,
      inception: r.inception_date,
      owner: r.account_owner,
      product: r.product_line,
      gwp: Number(r.gwp_gbp),
      revenue: Number(r.revenue_gbp),
    })),
  };
}

// ---------- App ----------
const PUBLIC = path.join(__dirname, 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates HTTPS in front of us; lets req.secure see it

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    // Our own pages get the referrer (so form posts carry a real Origin); other sites get nothing.
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// --- Open routes: the sign-in page and the one stylesheet it uses ---
app.get('/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (await currentUser(req, res)) return res.redirect(303, '/');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});
app.get('/style.css', (req, res) => res.sendFile(path.join(PUBLIC, 'style.css')));

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!configured) return res.redirect(303, '/login?error=config');
  if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Forbidden');
  if (throttled(req.ip)) return res.redirect(303, '/login?error=rate');

  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.redirect(303, '/login?error=invalid');

  const client = authClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data?.session) return res.redirect(303, '/login?error=invalid');
  if (!isAllowed(data.user.email)) {
    // Valid Supabase user, but not on the list: end that session and give the same generic answer.
    await client.auth.admin.signOut(data.session.access_token).catch(() => {});
    return res.redirect(303, '/login?error=invalid');
  }
  attempts.delete(req.ip);
  setSession(req, res, data.session);
  res.redirect(303, '/');
});

app.post('/logout', async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Forbidden');
  const token = readCookies(req)[ACCESS];
  if (configured && token) {
    verified.delete(tokenKey(token));
    await authClient().auth.admin.signOut(token).catch(() => {}); // revokes the refresh token too
  }
  clearSession(req, res);
  res.redirect(303, '/login?signed_out=1');
});

// --- Everything below requires a signed-in, allowed user ---
app.use(async (req, res, next) => {
  try {
    const email = await currentUser(req, res);
    if (email) { req.userEmail = email; res.set('Cache-Control', 'no-store'); return next(); }
  } catch (err) {
    console.error('Session check failed:', err.message || err);
  }
  clearSession(req, res);
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
  res.redirect(303, '/login');
});

app.get('/api/me', (req, res) => res.json({ email: req.userEmail }));

app.get('/api/policies', async (req, res) => {
  try {
    if (!cache.body || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), body: await loadPolicies() };
    }
    res.json(cache.body);
  } catch (err) {
    // Log the detail server-side; the browser only ever gets a generic message.
    console.error('Loading policies failed:', err.message || err);
    res.status(502).json({ error: 'Could not load policies' });
  }
});

// Only the public folder is ever served. Dotfiles are refused and nothing
// outside public/ (server.js, package.json, .env, data/, node_modules/) is reachable.
app.use(express.static(PUBLIC, { dotfiles: 'deny', index: 'index.html' }));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// The host sets PORT; 3000 is only a fallback for running locally.
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}`));
