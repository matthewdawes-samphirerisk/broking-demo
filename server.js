const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('./tools/load-env');

const app = express();

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

app.get('/api/policies', async (req, res) => {
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
});
