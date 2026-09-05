const express = require('express');
const path = require('path');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');

// public/ is the entire HTTP surface. Nothing else in the repo - not the
// spreadsheets in data/, not server.js, not .env - is reachable, because
// static() will not serve outside its root and there are no other routes.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  dotfiles: 'ignore',   // no .env-style files even if one lands in public/
  redirect: false,      // no directory redirects
}));

// Anything not matched above is a flat 404: no directory listings, no
// fallthrough to the filesystem, no framework error pages leaking paths.
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// The host chooses the port; 3000 is only a local fallback.
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dashboard listening on port ${port}`));
