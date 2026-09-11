const path = require('path');
const express = require('express');

const app = express();

// The host decides the port; 3000 is only a fallback for running it locally.
const port = process.env.PORT || 3000;

// public/ is the entire public surface of this app. Nothing outside it is
// routed, so server.js, package.json, .env and data/ are all unreachable.
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',   // index.html is the page people land on
  dotfiles: 'deny',      // no serving anything beginning with a dot
  redirect: false,
}));

// Anything not found in public/ ends here rather than falling through.
app.use((req, res) => res.status(404).type('text').send('Not found'));

// 0.0.0.0 rather than localhost, so the container's proxy can reach it.
app.listen(port, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${port}`);
});
