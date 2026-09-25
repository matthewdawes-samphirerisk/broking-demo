const express = require('express');
const path = require('path');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Only the public folder is ever served. Dotfiles are refused and nothing
// outside public/ (server.js, package.json, data/, node_modules/) is reachable.
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// The host sets PORT; 3000 is only a fallback for running locally.
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}`));
