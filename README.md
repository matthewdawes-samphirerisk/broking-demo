# Broking demo dashboard

A small dashboard built live from a spreadsheet, deployed on Railway.

**The data in `data/` is entirely fictitious.** No real client, broker, market or financial
information appears in it. Any resemblance to a real organisation is coincidental.

```bash
npm install && npm start
```

Everything served over HTTP lives in `public/` — the page, its stylesheet and
script are all in `index.html`, and the figures come from `data.json`, exported
from the spreadsheet in `data/`. Nothing outside `public/` is reachable.

The server listens on `$PORT` when the host sets one, falling back to 3000
locally.
