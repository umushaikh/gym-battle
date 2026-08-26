const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_EXERCISES = [
  'Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row',
  'Pull-ups', 'Push-ups', 'Lunges', 'Bicep Curl', 'Tricep Dips',
  'Shoulder Press', 'Leg Press', 'Lat Pulldown', 'Plank Hold', 'Sit-ups'
];

function id() {
  return crypto.randomBytes(8).toString('hex');
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exercises (
      name TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS workouts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      exercise TEXT NOT NULL,
      sets JSONB NOT NULL,
      date TEXT NOT NULL,
      notes TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      exercise TEXT,
      metric TEXT NOT NULL,
      stake TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  const { rows: profileRows } = await pool.query('SELECT COUNT(*) FROM profiles');
  if (Number(profileRows[0].count) === 0) {
    await pool.query(
      'INSERT INTO profiles (id, name, color) VALUES ($1,$2,$3), ($4,$5,$6)',
      ['p1', 'chaiky boy', '#3b82f6', 'p2', 'nosey girl', '#ec4899']
    );
  }

  const { rows: exerciseRows } = await pool.query('SELECT COUNT(*) FROM exercises');
  if (Number(exerciseRows[0].count) === 0) {
    for (const name of DEFAULT_EXERCISES) {
      await pool.query('INSERT INTO exercises (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
  }
}

async function getProfiles() {
  const { rows } = await pool.query('SELECT id, name, color FROM profiles ORDER BY id');
  return rows;
}

async function renameProfile(profileId, name) {
  const { rows } = await pool.query(
    'UPDATE profiles SET name = $1 WHERE id = $2 RETURNING id, name, color',
    [name, profileId]
  );
  return rows[0] || null;
}

async function getExercises() {
  const { rows } = await pool.query('SELECT name FROM exercises ORDER BY name');
  return rows.map(r => r.name);
}

async function addExercise(name) {
  await pool.query('INSERT INTO exercises (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  return getExercises();
}

function rowToWorkout(r) {
  return {
    id: r.id,
    profileId: r.profile_id,
    exercise: r.exercise,
    sets: r.sets,
    date: r.date,
    notes: r.notes || '',
    createdAt: Number(r.created_at)
  };
}

async function getWorkouts({ profileId, exercise, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (profileId) { params.push(profileId); clauses.push(`profile_id = $${params.length}`); }
  if (exercise) { params.push(exercise); clauses.push(`exercise = $${params.length}`); }
  if (from) { params.push(from); clauses.push(`date >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`date <= $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM workouts ${where} ORDER BY date DESC, created_at DESC`,
    params
  );
  return rows.map(rowToWorkout);
}

async function profileExists(profileId) {
  const { rows } = await pool.query('SELECT 1 FROM profiles WHERE id = $1', [profileId]);
  return rows.length > 0;
}

async function addWorkout({ profileId, exercise, sets, date, notes }) {
  const workout = {
    id: id(),
    profileId,
    exercise,
    sets,
    date,
    notes: notes || '',
    createdAt: Date.now()
  };
  await pool.query(
    'INSERT INTO workouts (id, profile_id, exercise, sets, date, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [workout.id, workout.profileId, workout.exercise, JSON.stringify(workout.sets), workout.date, workout.notes, workout.createdAt]
  );
  await addExercise(exercise);
  return workout;
}

async function deleteWorkout(workoutId) {
  const { rowCount } = await pool.query('DELETE FROM workouts WHERE id = $1', [workoutId]);
  return rowCount > 0;
}

function rowToBet(r) {
  return {
    id: r.id,
    title: r.title,
    exercise: r.exercise,
    metric: r.metric,
    stake: r.stake || '',
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: Number(r.created_at)
  };
}

async function getBets() {
  const { rows } = await pool.query('SELECT * FROM bets ORDER BY created_at DESC');
  return rows.map(rowToBet);
}

async function addBet({ title, exercise, metric, stake, startDate, endDate }) {
  const bet = {
    id: id(),
    title,
    exercise: exercise || null,
    metric,
    stake: stake || '',
    startDate,
    endDate,
    createdAt: Date.now()
  };
  await pool.query(
    'INSERT INTO bets (id, title, exercise, metric, stake, start_date, end_date, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [bet.id, bet.title, bet.exercise, bet.metric, bet.stake, bet.startDate, bet.endDate, bet.createdAt]
  );
  return bet;
}

async function deleteBet(betId) {
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1', [betId]);
  return rowCount > 0;
}

module.exports = {
  init, getProfiles, renameProfile, getExercises, addExercise,
  getWorkouts, profileExists, addWorkout, deleteWorkout,
  getBets, addBet, deleteBet
};
