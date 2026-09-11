# Broking demo dashboard

A small dashboard built live from a spreadsheet, deployed on Railway.

**The data in `data/` is entirely fictitious.** No real client, broker, market or financial
information appears in it. Any resemblance to a real organisation is coincidental.

```bash
npm install && npm start
```

## Hosting

`server.js` serves the `public/` folder and nothing else — `index.html` is the landing page
and `data.json` sits beside it. Everything outside `public/` (source, dependencies, the
spreadsheets in `data/`, `.env`) is unreachable over HTTP.

The port comes from the `PORT` environment variable, which is what Railway and most other
hosts set. It falls back to 3000 when that variable is absent, for running locally.

Regenerating `public/data.json` from a new version of the cleaned workbook is a manual step —
the server never reads the spreadsheets.
