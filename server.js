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
  console.log('\nIron Log running! Your workouts are saved on the device you open this on,');
  console.log('nothing is stored on this server.');
  console.log(`  Local:   http://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`  Network: http://${addr}:${PORT}  <-- open this on your phone (same WiFi)`));
  console.log('');
  console.log('Note: over plain http, browsers disable offline mode and the native share');
  console.log('sheet. Logging and history work fine; serve it over https to install it as');
  console.log('a full offline home-screen app.');
  console.log('');
});
