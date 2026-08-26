const express = require('express');
const path = require('path');

const store = process.env.DATABASE_URL
  ? require('./lib/store.pg')
  : require('./lib/store.local');

const PORT = process.env.PORT || 3500;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- Profiles ----
app.get('/api/profiles', asyncRoute(async (req, res) => {
  res.json(await store.getProfiles());
}));

app.patch('/api/profiles/:id', asyncRoute(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name required' });
  const profile = await store.renameProfile(req.params.id, name);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
}));

// ---- Exercises ----
app.get('/api/exercises', asyncRoute(async (req, res) => {
  res.json(await store.getExercises());
}));

app.post('/api/exercises', asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json(await store.addExercise(name));
}));

// ---- Workouts ----
app.get('/api/workouts', asyncRoute(async (req, res) => {
  const { profileId, exercise, from, to } = req.query;
  res.json(await store.getWorkouts({ profileId, exercise, from, to }));
}));

app.post('/api/workouts', asyncRoute(async (req, res) => {
  const { profileId, exercise, sets, date, notes } = req.body;
  if (!profileId || !exercise || !Array.isArray(sets) || sets.length === 0 || !date) {
    return res.status(400).json({ error: 'profileId, exercise, sets, and date are required' });
  }
  if (!(await store.profileExists(profileId))) {
    return res.status(400).json({ error: 'Unknown profile' });
  }
  const cleanSets = sets.map(s => ({
    reps: Number(s.reps) || 0,
    weight: Number(s.weight) || 0
  }));
  const workout = await store.addWorkout({ profileId, exercise, sets: cleanSets, date, notes });
  res.status(201).json(workout);
}));

app.delete('/api/workouts/:id', asyncRoute(async (req, res) => {
  const found = await store.deleteWorkout(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
}));

// ---- Bets ----
function computeMetric(workouts, metric) {
  switch (metric) {
    case 'volume':
      return workouts.reduce((sum, w) => sum + w.sets.reduce((s, set) => s + set.reps * set.weight, 0), 0);
    case 'reps':
      return workouts.reduce((sum, w) => sum + w.sets.reduce((s, set) => s + set.reps, 0), 0);
    case 'sets':
      return workouts.reduce((sum, w) => sum + w.sets.length, 0);
    case 'max_weight':
      return workouts.reduce((max, w) => Math.max(max, ...w.sets.map(s => s.weight), 0), 0);
    case 'workouts':
      return workouts.length;
    default:
      return 0;
  }
}

async function enrichBet(bet, profiles, allWorkouts) {
  const standings = profiles.map(profile => {
    let workouts = allWorkouts.filter(w => w.profileId === profile.id);
    if (bet.exercise) workouts = workouts.filter(w => w.exercise === bet.exercise);
    workouts = workouts.filter(w => w.date >= bet.startDate && w.date <= bet.endDate);
    return {
      profileId: profile.id,
      name: profile.name,
      value: computeMetric(workouts, bet.metric)
    };
  });
  const today = new Date().toISOString().slice(0, 10);
  const isOver = today > bet.endDate;
  let winner = null;
  if (isOver && standings.length) {
    const top = Math.max(...standings.map(s => s.value));
    const leaders = standings.filter(s => s.value === top);
    winner = top === 0 ? null : (leaders.length > 1 ? 'tie' : leaders[0].profileId);
  }
  return {
    ...bet,
    standings,
    status: isOver ? 'finished' : 'active',
    winner
  };
}

app.get('/api/bets', asyncRoute(async (req, res) => {
  const [bets, profiles, workouts] = await Promise.all([
    store.getBets(), store.getProfiles(), store.getWorkouts()
  ]);
  const enriched = await Promise.all(bets.map(b => enrichBet(b, profiles, workouts)));
  res.json(enriched);
}));

app.post('/api/bets', asyncRoute(async (req, res) => {
  const { title, exercise, metric, stake, startDate, endDate } = req.body;
  if (!title || !metric || !startDate || !endDate) {
    return res.status(400).json({ error: 'title, metric, startDate, and endDate are required' });
  }
  const bet = await store.addBet({ title, exercise, metric, stake, startDate, endDate });
  const [profiles, workouts] = await Promise.all([store.getProfiles(), store.getWorkouts()]);
  res.status(201).json(await enrichBet(bet, profiles, workouts));
}));

app.delete('/api/bets/:id', asyncRoute(async (req, res) => {
  const found = await store.deleteBet(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

store.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
      }
    }
    console.log(`\nGym Battle running! (${process.env.DATABASE_URL ? 'Postgres' : 'local JSON'} storage)`);
    console.log(`  Local:   http://localhost:${PORT}`);
    addresses.forEach(addr => console.log(`  Network: http://${addr}:${PORT}  <-- use this on your phone (same WiFi)`));
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
