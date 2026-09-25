const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------- Database (server-side only) ----------
// The secret key bypasses row level security. It is read from the environment
// here and used only in this process: it is never sent to the browser, never
// logged, and never included in an API response.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const db = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
if (!db) console.warn('SUPABASE_URL / SUPABASE_SERVICE_KEY not set: /api/policies will return 503.');

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
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

app.get('/api/policies', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!db) return res.status(503).json({ error: 'Data source not configured' });
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
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// The host sets PORT; 3000 is only a fallback for running locally.
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}`));
