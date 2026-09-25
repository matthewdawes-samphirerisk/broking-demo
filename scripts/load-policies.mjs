// Load data/demo_broking_data_CLEANED.csv into the Supabase `policies` table.
//
//   node --env-file=.env scripts/load-policies.mjs
//
// Safe to re-run: rows are upserted on policy_id, so a second run updates the
// existing rows in place rather than adding copies. Needs SUPABASE_URL and
// SUPABASE_SERVICE_KEY (server-side secret key) in the environment.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const CSV = new URL('../data/demo_broking_data_CLEANED.csv', import.meta.url);
const BATCH = 500;

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (run with --env-file=.env).');
  process.exit(1);
}

// Minimal RFC 4180 parser: handles quoted fields, embedded commas, quotes and newlines.
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f !== ''));
}

// CSV header -> table column, with a converter for each.
const text = v => (v.trim() === '' ? null : v.trim());
const num = v => {
  if (v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: "${v}"`);
  return n;
};
const date = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new Error(`not an ISO date: "${v}"`);
  return v.trim();
};
const COLUMNS = {
  'Policy ID': ['policy_id', text],
  'Client': ['client', text],
  'Account Owner': ['account_owner', text],
  'Product Line': ['product_line', text],
  'Country': ['country', text],
  'Region': ['region', text],
  'Distribution': ['distribution', text],
  'Retail Broker': ['retail_broker', text],
  'Business Type': ['business_type', text],
  'Inception Date': ['inception_date', date],
  'Expiry Date': ['expiry_date', date],
  'Status': ['status', text],
  'Currency': ['currency', text],
  'FX Rate (per GBP)': ['fx_rate', num],
  'Premium (Local)': ['premium_local', num],
  'GWP (GBP)': ['gwp_gbp', num],
  'Brokerage %': ['brokerage_pct', num],   // stored as in the source: a fraction, e.g. 0.2683
  'Revenue (GBP)': ['revenue_gbp', num],
};

// ---------- Read and validate everything before touching the database ----------
const [header, ...lines] = parseCsv(readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
const missing = Object.keys(COLUMNS).filter(h => !header.includes(h));
const extra = header.filter(h => !(h in COLUMNS));
if (missing.length || extra.length) {
  console.error('CSV header mismatch.', { missing, extra });
  process.exit(1);
}

const loadedAt = new Date().toISOString();
const records = lines.map((cells, i) => {
  if (cells.length !== header.length) throw new Error(`line ${i + 2}: ${cells.length} fields, expected ${header.length}`);
  const rec = { loaded_at: loadedAt };
  header.forEach((h, j) => {
    const [col, conv] = COLUMNS[h];
    try { rec[col] = conv(cells[j]); } catch (e) { throw new Error(`line ${i + 2}, ${h}: ${e.message}`); }
  });
  if (!rec.policy_id) throw new Error(`line ${i + 2}: missing Policy ID`);
  return rec;
});

const seen = new Set(), dupes = new Set();
for (const r of records) (seen.has(r.policy_id) ? dupes : seen).add(r.policy_id);
if (dupes.size) {
  console.error(`Duplicate Policy IDs in the CSV, refusing to load: ${[...dupes].join(', ')}`);
  process.exit(1);
}

const total = (k) => records.reduce((s, r) => s + (r[k] || 0), 0);
console.log(`Read ${records.length} policies from CSV · GWP £${Math.round(total('gwp_gbp')).toLocaleString('en-GB')} · revenue £${Math.round(total('revenue_gbp')).toLocaleString('en-GB')}`);

// ---------- Upsert ----------
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const countRows = async () => {
  const { count, error } = await db.from('policies').select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count;
};

const before = await countRows();
console.log(`Rows in policies before load: ${before}`);

for (let i = 0; i < records.length; i += BATCH) {
  const batch = records.slice(i, i + BATCH);
  const { error } = await db.from('policies').upsert(batch, { onConflict: 'policy_id' });
  if (error) {
    if (error.code === '42P10') {
      console.error(
        'policies.policy_id has no unique constraint, so re-runs could not be made safe. Nothing was loaded.\n' +
        'Add one in the Supabase SQL editor, then run this again:\n' +
        '  alter table public.policies add constraint policies_policy_id_key unique (policy_id);');
    } else {
      console.error(`Upsert failed at rows ${i + 1}-${i + batch.length}:`, error.message);
    }
    process.exit(1);
  }
  console.log(`Upserted rows ${i + 1}-${i + batch.length}`);
}

const after = await countRows();
console.log(`Rows in policies after load: ${after} (${after - before >= 0 ? '+' : ''}${after - before})`);
if (after < records.length) {
  console.error('Fewer rows in the table than in the CSV - check for row level security or triggers.');
  process.exit(1);
}
