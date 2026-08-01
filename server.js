const express = require('express');
const path = require('path');

const app = express();

// serve only the public folder - never the repo root
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Broking dashboard listening on port ${PORT}`);
});
