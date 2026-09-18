#!/usr/bin/env node
/**
 * Load the cleaned broking CSV into the Supabase `policies` table.
 *
 *   node scripts/load-supabase.js [--dry-run] [--file <path>]
 *
 * Safe to run repeatedly. `policies.policy_id` carries a unique constraint, so
 * rows are UPSERTed against it: a second run updates the 952 existing rows in
 * place rather than inserting a second copy. Nothing is deleted, so rows that
 * are not in the CSV are left alone.
 *
 * Credentials come from .env (SUPABASE_URL, SUPABASE_SERVICE_KEY) and are never
 * logged. .env is gitignored - keep it that way.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const CSV_PATH = fileArg !== -1 && args[fileArg + 1]
  ? path.resolve(args[fileArg + 1])
  : path.join(ROOT, 'data', 'demo_broking_data_CLEANED.csv');

const BATCH = 500;

/* ---------- env ---------- */
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

/* ---------- CSV (RFC 4180: quoted fields, embedded commas, "" escapes) ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
}

// CSV header -> table column. Every data column in `policies` is text, so the
// values go across as strings exactly as the CSV holds them.
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

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

(async () => {
  const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;
  if (!url || !key) fail('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (.env or environment).');
  if (!fs.existsSync(CSV_PATH)) fail(`CSV not found: ${CSV_PATH}`);

  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows.shift().map(h => h.trim());

  const missing = Object.keys(COLUMNS).filter(h => !header.includes(h));
  if (missing.length) fail(`CSV is missing expected column(s): ${missing.join(', ')}`);

  const loadedAt = new Date().toISOString();
  const records = rows.map((r, i) => {
    if (r.length !== header.length) fail(`Row ${i + 2} has ${r.length} fields, expected ${header.length}.`);
    const rec = { loaded_at: loadedAt };
    for (const [csvCol, dbCol] of Object.entries(COLUMNS)) {
      const v = (r[header.indexOf(csvCol)] ?? '').trim();
      rec[dbCol] = v === '' ? null : v;   // blank retail broker is absent, not ""
    }
    if (!rec.policy_id) fail(`Row ${i + 2} has no Policy ID.`);
    return rec;
  });

  // ON CONFLICT cannot touch the same row twice in one statement, so a
  // duplicate id inside the file would fail the batch. Catch it here instead.
  const seen = new Set(), dupes = new Set();
  for (const r of records) (seen.has(r.policy_id) ? dupes : seen).add(r.policy_id);
  if (dupes.size) fail(`CSV contains duplicate Policy IDs: ${[...dupes].slice(0, 5).join(', ')}`);

  console.log(`CSV        ${path.relative(ROOT, CSV_PATH)}`);
  console.log(`Parsed     ${records.length} rows, ${seen.size} distinct policy ids`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing sent. First record:');
    console.log(records[0]);
    return;
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  const before = await db.from('policies').select('*', { count: 'exact', head: true });
  if (before.error) fail(`Could not read policies: ${before.error.message}`);
  console.log(`Before     ${before.count} rows in policies`);

  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const { error } = await db.from('policies').upsert(chunk, { onConflict: 'policy_id' });
    if (error) fail(`Upsert failed at row ${i + 1}: ${error.message}`);
    written += chunk.length;
    console.log(`  upserted ${String(written).padStart(4)} / ${records.length}`);
  }

  const after = await db.from('policies').select('*', { count: 'exact', head: true });
  if (after.error) fail(`Could not verify: ${after.error.message}`);
  console.log(`After      ${after.count} rows in policies`);

  if (after.count !== seen.size) {
    console.log(`\nNote: table holds ${after.count} rows against ${seen.size} in the CSV - ` +
                `the difference is rows already in the table that the CSV does not cover.`);
  } else {
    console.log('\nTable matches the CSV exactly.');
  }
})().catch(e => fail(e && e.message ? e.message : String(e)));
