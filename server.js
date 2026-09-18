'use strict';

const express = require('express');
const path = require('path');

const app = express();

// public/ is the ONLY thing this process will ever serve. Every other file in
// the repo - server.js, scripts/, data/, .env - sits outside this root and is
// unreachable over HTTP by construction, not by rule.
const PUBLIC_DIR = path.join(__dirname, 'public');

// The host picks the port. PORT is set by the platform; 3000 is only a local
// convenience when nothing sets it.
const PORT = process.env.PORT || 3000;

// Don't advertise the stack.
app.disable('x-powered-by');

app.use((req, res, next) => {
  // Everything the page needs is same-origin. 'unsafe-inline' is required only
  // because the CSS and JS live inline in index.html; moving them into their
  // own files under public/ would let both of these drop to 'self'.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// A dashboard is read-only. Anything that isn't a read is refused outright.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('Method Not Allowed');
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  dotfiles: 'deny',   // no .env-alikes, even if one is ever dropped into public/
  redirect: false,
  setHeaders(res, filePath) {
    // Revalidate the page and its data every time so a redeploy is picked up;
    // ETags still make the repeat requests cheap.
    if (/\.(html|json)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Anything not found in public/ ends here. No path echoed back, no stack trace.
app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Request failed:', err && err.message);
  res.status(500).type('text/plain').send('Internal Server Error');
});

// 0.0.0.0 so the platform's router can reach the container.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${server.address().port}`);
});

// Platforms stop a container with SIGTERM; finish in-flight requests first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
