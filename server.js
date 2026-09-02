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

// ---- Exercises ----
app.get('/api/exercises', asyncRoute(async (req, res) => {
  res.json(await store.getExercises());
}));

app.post('/api/exercises', asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const exercise = await store.addExercise({
    name,
    category: (req.body.category || '').trim(),
    equipment: (req.body.equipment || '').trim()
  });
  res.status(201).json(exercise);
}));

app.get('/api/exercises/:id/last', asyncRoute(async (req, res) => {
  res.json(await store.getExerciseLast(req.params.id));
}));

app.get('/api/exercises/:id/history', asyncRoute(async (req, res) => {
  res.json(await store.getExerciseHistory(req.params.id));
}));

// ---- Workouts ----
app.get('/api/workouts', asyncRoute(async (req, res) => {
  res.json(await store.getWorkouts());
}));

app.get('/api/workouts/:id', asyncRoute(async (req, res) => {
  const workout = await store.getWorkout(req.params.id);
  if (!workout) return res.status(404).json({ error: 'Not found' });
  res.json(workout);
}));

app.post('/api/workouts', asyncRoute(async (req, res) => {
  const { name, startedAt, endedAt, date, exercises, notes } = req.body;
  if (!startedAt || !endedAt || !date || !Array.isArray(exercises)) {
    return res.status(400).json({ error: 'date, startedAt, endedAt, and exercises are required' });
  }
  const cleanExercises = exercises
    .map(e => ({
      exerciseId: e.exerciseId,
      name: e.name,
      sets: (e.sets || [])
        .filter(s => Number(s.reps) > 0 || Number(s.weight) > 0)
        .map(s => ({ reps: Number(s.reps) || 0, weight: Number(s.weight) || 0 }))
    }))
    .filter(e => e.sets.length > 0);
  if (cleanExercises.length === 0) {
    return res.status(400).json({ error: 'At least one exercise with a logged set is required' });
  }
  const workout = await store.addWorkout({ name, startedAt, endedAt, date, exercises: cleanExercises, notes });
  res.status(201).json(workout);
}));

app.delete('/api/workouts/:id', asyncRoute(async (req, res) => {
  const found = await store.deleteWorkout(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
}));

// ---- Routines ----
app.get('/api/routines', asyncRoute(async (req, res) => {
  res.json(await store.getRoutines());
}));

app.post('/api/routines', asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  const exercises = Array.isArray(req.body.exercises) ? req.body.exercises : [];
  if (!name || exercises.length === 0) {
    return res.status(400).json({ error: 'name and at least one exercise are required' });
  }
  res.status(201).json(await store.addRoutine({ name, exercises }));
}));

app.put('/api/routines/:id', asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  const exercises = Array.isArray(req.body.exercises) ? req.body.exercises : [];
  if (!name || exercises.length === 0) {
    return res.status(400).json({ error: 'name and at least one exercise are required' });
  }
  const routine = await store.updateRoutine(req.params.id, { name, exercises });
  if (!routine) return res.status(404).json({ error: 'Not found' });
  res.json(routine);
}));

app.delete('/api/routines/:id', asyncRoute(async (req, res) => {
  const found = await store.deleteRoutine(req.params.id);
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
    console.log(`\nIron Log running! (${process.env.DATABASE_URL ? 'Postgres' : 'local JSON'} storage)`);
    console.log(`  Local:   http://localhost:${PORT}`);
    addresses.forEach(addr => console.log(`  Network: http://${addr}:${PORT}  <-- use this on your phone (same WiFi)`));
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
