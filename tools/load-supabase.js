/**
 * Load the broking extract into Supabase.
 *
 *   node tools/load-supabase.js
 *
 * Reads data/demo_broking_data_MESSY.csv and replaces the contents of the
 * `policies` table. Run tools/supabase-schema.sql first.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment. Put them in
 * a .env file at the repo root - it is gitignored and must stay that way.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('./load-env');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.example).');
  process.exit(1);
}

// CSV header -> database column
const COLUMNS = {
  'Policy ID': 'policy_id',
  'Client': 'client',
  'Account Owner': 'account_owner',
  'Product Line': 'product_line',
  'Country': 'country',
  'Region': 'region',
  'Distribution': 'distribution',
  'Retail Broker': 'retail_broker',
  'Business Type': 'business_type',
  'Inception Date': 'inception_date',
  'Expiry Date': 'expiry_date',
  'Status': 'status',
  'Currency': 'currency',
  'FX Rate (per GBP)': 'fx_rate',
  'Premium (Local)': 'premium_local',
  'GWP (GBP)': 'gwp_gbp',
  'Brokerage %': 'brokerage_pct',
  'Revenue (GBP)': 'revenue_gbp',
};

/** Minimal RFC4180 parser - the data contains quoted fields with commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const csvPath = path.join(__dirname, '..', 'data', 'demo_broking_data_MESSY.csv');
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).filter(r => r.some(c => c !== ''));
  const headers = rows[0].map(h => h.trim());

  const records = rows.slice(1).map(r => {
    const rec = {};
    headers.forEach((h, i) => {
      const col = COLUMNS[h];
      if (col) rec[col] = r[i] === '' ? null : r[i];
    });
    return rec;
  });

  const missing = Object.keys(COLUMNS).filter(h => !headers.includes(h));
  if (missing.length) {
    console.error('CSV is missing expected columns:', missing.join(', '));
    process.exit(1);
  }

  console.log(`read ${records.length} rows from ${path.basename(csvPath)}`);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // replace rather than append, so re-running is safe
  const { error: delError } = await db.from('policies').delete().neq('row_id', 0);
  if (delError) { console.error('clear failed:', delError.message); process.exit(1); }

  const BATCH = 200;
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const { error } = await db.from('policies').insert(chunk);
    if (error) { console.error(`insert failed at row ${i}:`, error.message); process.exit(1); }
    written += chunk.length;
    process.stdout.write(`\r  loaded ${written}/${records.length}`);
  }
  process.stdout.write('\n');

  const { count, error: countError } = await db
    .from('policies').select('row_id', { count: 'exact', head: true });
  if (countError) { console.error('count failed:', countError.message); process.exit(1); }

  console.log(`policies table now holds ${count} rows`);
  if (count !== records.length) {
    console.error(`MISMATCH: expected ${records.length}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
