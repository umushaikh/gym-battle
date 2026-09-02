const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3500;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log('\nIron Log running! All your data stays on your phone, nothing is stored on this server.');
  console.log(`  Local:   http://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`  Network: http://${addr}:${PORT}  <-- open this on your phone once, then "Add to Home Screen" so it works offline`));
  console.log('');
});
