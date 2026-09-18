# Broking demo dashboard

A small dashboard built live from a spreadsheet, deployed on Railway.

**The data in `data/` is entirely fictitious.** No real client, broker, market or financial
information appears in it. Any resemblance to a real organisation is coincidental.

```bash
npm install && npm start
```

## Where the data comes from

Supabase is the single source of truth. The chain is:

```
data/Demo Broking Data (CLEANED).xlsx
  -> data/demo_broking_data_CLEANED.csv
  -> scripts/load-supabase.js   -> Supabase `policies` table
  -> GET /api/policies          -> the dashboard
```

Reload the table from the CSV at any time. It upserts on `policy_id`, so running it
twice updates the existing rows rather than inserting a second copy:

```bash
node scripts/load-supabase.js
```

`--dry-run` parses and validates without sending anything; `--file <path>` loads a
different CSV.

## Hosting

The server binds to `0.0.0.0` and takes its port from `PORT`, so the host chooses it.
Locally it falls back to 3000 when `PORT` is unset.

It needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the environment. Locally those
come from `.env`, which is gitignored; on the host, set them as environment variables.
**The service key stays server-side** — the browser only ever talks to `/api/policies`,
which returns the fourteen display fields and nothing else.

`public/` is the only directory served. Everything else in the repo — `server.js`,
`scripts/`, `data/`, `.env` — sits outside that root and is not reachable over HTTP.
The single non-static route is `GET /api/policies`. Only `GET` and `HEAD` are accepted
anywhere; anything else returns 405.
