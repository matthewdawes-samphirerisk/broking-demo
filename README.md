# Broking demo dashboard

A small dashboard built live from a spreadsheet, deployed on Railway.

**The data in `data/` is entirely fictitious.** No real client, broker, market or financial
information appears in it. Any resemblance to a real organisation is coincidental.

```bash
npm install && npm start
```

## Hosting

The server binds to `0.0.0.0` and takes its port from `PORT`, so the host chooses it.
Locally it falls back to 3000 when `PORT` is unset.

`public/` is the only directory served. Everything else in the repo — `server.js`,
`scripts/`, `data/`, `.env` — sits outside that root and is not reachable over HTTP.
Only `GET` and `HEAD` are accepted; anything else returns 405.

## Regenerating the dashboard data

`public/data.json` is built from the cleaned workbook:

```bash
python scripts/build-data.py
```
