/**
 * Read a .env file at the repo root into process.env, if one exists.
 *
 * Local convenience only. On Railway the variables are set in the platform,
 * so there is no .env file there and this quietly does nothing - which is the
 * whole point: the same code runs in both places and the secret never travels
 * with it.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Supabase's dashboard shows the REST endpoint (https://ref.supabase.co/rest/v1/)
// but the client wants the project root and appends the path itself. Copying the
// displayed value is the obvious thing to do, so accept it and trim.
if (process.env.SUPABASE_URL) {
  const original = process.env.SUPABASE_URL.trim();
  const cleaned = original.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  if (cleaned !== original) {
    console.warn(`note: trimmed SUPABASE_URL to ${cleaned}`);
  }
  process.env.SUPABASE_URL = cleaned;
}
