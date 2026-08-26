const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('./tools/load-env');

const app = express();
app.set('trust proxy', 1);          // Railway terminates TLS in front of us
app.use(express.json());

// Signing key for the session cookie. Set SESSION_SECRET in production, or
// every restart silently logs everybody out.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set - using a random one. Sessions will not survive a restart.');
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                                        // JavaScript cannot read it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',         // Railway sets this
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// serve only the public folder - never the repo root
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- Supabase
// The key lives in the environment, never in the code and never in the repo.
// Locally that means a gitignored .env file; on Railway it is a variable set
// in the platform. Same code, no secret in transit.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const configured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const db = configured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// database column -> the header the dashboard expects
const FIELDS = {
  policy_id: 'Policy ID',
  client: 'Client',
  account_owner: 'Account Owner',
  product_line: 'Product Line',
  country: 'Country',
  region: 'Region',
  distribution: 'Distribution',
  retail_broker: 'Retail Broker',
  business_type: 'Business Type',
  inception_date: 'Inception Date',
  expiry_date: 'Expiry Date',
  status: 'Status',
  currency: 'Currency',
  fx_rate: 'FX Rate (per GBP)',
  premium_local: 'Premium (Local)',
  gwp_gbp: 'GWP (GBP)',
  brokerage_pct: 'Brokerage %',
  revenue_gbp: 'Revenue (GBP)',
};

// ---------------------------------------------------------------- sign-in
// Supabase checks the credentials; we keep the result in an httpOnly cookie.
// The browser never holds a token it could leak, and the swap to Microsoft
// sign-in later is one call - signInWithPassword becomes an OAuth redirect.
const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false';

app.post('/api/login', async (req, res) => {
  if (!configured) return res.status(503).json({ error: 'Not configured' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // A FRESH client, never the one used for data.
  // signInWithPassword stores the session on whichever client makes the call,
  // so reusing `db` would leave every later query authenticating as this user
  // instead of as the service role - and with RLS on and no policies attached,
  // that user can read nothing. Isolating the call keeps the two apart.
  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) {
    // Deliberately vague: never reveal whether the address exists.
    return res.status(401).json({ error: 'Those details were not recognised' });
  }
  req.session.user = { email: data.user.email, id: data.user.id };
  res.json({ email: data.user.email });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authRequired: AUTH_REQUIRED, user: req.session.user || null });
});

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED || req.session.user) return next();
  res.status(401).json({ error: 'Sign in required' });
}

app.get('/api/policies', requireAuth, async (req, res) => {
  if (!configured) {
    // Deliberately explicit. An app that fails silently in production is worse
    // than one that says exactly which setting is missing.
    return res.status(503).json({
      error: 'Not configured',
      detail: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are not set on this server. '
            + 'Locally, put them in a .env file. On Railway, set them under Variables.',
    });
  }

  try {
    // Supabase caps a single request at 1000 rows, so page through.
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('policies')
        .select(Object.keys(FIELDS).join(','))
        .order('row_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    res.json(rows.map(r => {
      const out = {};
      for (const [col, header] of Object.entries(FIELDS)) out[header] = r[col];
      return out;
    }));
  } catch (e) {
    console.error('/api/policies failed:', e.message);
    res.status(502).json({ error: 'Query failed', detail: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, supabaseConfigured: configured });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${PORT}`);
  console.log(configured
    ? 'Supabase: configured'
    : 'Supabase: NOT configured - /api/policies will return 503');
  console.log(AUTH_REQUIRED
    ? 'Sign-in: required'
    : 'Sign-in: DISABLED (AUTH_REQUIRED=false) - anyone with the URL can read everything');
});
