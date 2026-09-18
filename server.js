'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

// public/ is the only directory this process serves. Every other file in the
// repo - server.js, scripts/, data/, .env - sits outside this root and is
// unreachable over HTTP by construction, not by rule.
const PUBLIC_DIR = path.join(__dirname, 'public');

// The host picks the port. PORT is set by the platform; 3000 is only a local
// convenience when nothing sets it.
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

app.disable('x-powered-by');

app.use((req, res, next) => {
  // Everything the page needs is same-origin, including /api/policies, so
  // connect-src stays 'self'. 'unsafe-inline' is required only because the CSS
  // and JS live inline in index.html.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// A dashboard is read-only. Anything that isn't a read is refused outright.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('Method Not Allowed');
});

/* ---------- /api/policies ---------- */
// Only these columns leave the database, renamed to what the page expects.
const SELECT = [
  'policy_id', 'client', 'account_owner', 'product_line', 'country', 'region',
  'distribution', 'business_type', 'status', 'currency',
  'inception_date', 'expiry_date', 'gwp_gbp', 'revenue_gbp',
].join(',');

const shape = r => ({
  policyId: r.policy_id,
  client: r.client,
  owner: r.account_owner,
  product: r.product_line,
  country: r.country,
  region: r.region,
  distribution: r.distribution,
  businessType: r.business_type,
  status: r.status,
  currency: r.currency,
  inception: r.inception_date,
  expiry: r.expiry_date,
  gwp: Number(r.gwp_gbp),
  revenue: Number(r.revenue_gbp),
});

// PostgREST caps a response at 1000 rows, so page through rather than
// silently truncating once the book outgrows that.
async function fetchAllPolicies() {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/policies?select=${SELECT}&order=policy_id.asc`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + PAGE - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`Supabase responded ${res.status}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

// A small cache keeps a page refresh from hitting Supabase every time.
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
      // Collapse concurrent misses into one upstream request.
      cache.inflight = cache.inflight || fetchAllPolicies()
        .then(rows => {
          cache = { at: Date.now(), body: { policies: rows.map(shape) }, inflight: null };
        })
        .catch(err => { cache.inflight = null; throw err; });
      await cache.inflight;
    }
    res.set('Cache-Control', 'no-cache').json(cache.body);
  } catch (err) {
    // Log the detail, return none of it.
    console.error('Failed to load policies:', err && err.message);
    if (cache.body) return res.set('Cache-Control', 'no-cache').json(cache.body);  // serve stale over nothing
    res.status(502).json({ error: 'Could not reach the data source.' });
  }
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  dotfiles: 'deny',   // no .env-alikes, even if one is ever dropped into public/
  redirect: false,
  setHeaders(res, filePath) {
    if (/\.(html|json)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Anything not found in public/ ends here. No path echoed back, no stack trace.
app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Request failed:', err && err.message);
  res.status(500).type('text/plain').send('Internal Server Error');
});

// 0.0.0.0 so the platform's router can reach the container.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${server.address().port}`);
  if (!SUPABASE_URL || !SUPABASE_KEY) console.warn('WARNING: Supabase is not configured; /api/policies will return 503.');
});

// Platforms stop a container with SIGTERM; finish in-flight requests first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
