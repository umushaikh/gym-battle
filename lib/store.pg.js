const { Pool } = require('pg');
const crypto = require('crypto');
const DEFAULT_EXERCISES = require('./exercises-seed');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function id() {
  return crypto.randomBytes(8).toString('hex');
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      equipment TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workouts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT NOT NULL,
      exercises JSONB NOT NULL,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exercises JSONB NOT NULL
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) FROM exercises');
  if (Number(rows[0].count) === 0) {
    for (const e of DEFAULT_EXERCISES) {
      await pool.query(
        'INSERT INTO exercises (id, name, category, equipment) VALUES ($1,$2,$3,$4)',
        [id(), e.name, e.category, e.equipment]
      );
    }
  }
}

async function getExercises() {
  const { rows } = await pool.query('SELECT id, name, category, equipment FROM exercises ORDER BY category, name');
  return rows;
}

async function addExercise({ name, category, equipment }) {
  const exercise = { id: id(), name, category: category || 'Other', equipment: equipment || 'None' };
  await pool.query(
    'INSERT INTO exercises (id, name, category, equipment) VALUES ($1,$2,$3,$4)',
    [exercise.id, exercise.name, exercise.category, exercise.equipment]
  );
  return exercise;
}

function rowToWorkout(r) {
  return {
    id: r.id,
    name: r.name,
    date: r.date,
    startedAt: Number(r.started_at),
    endedAt: Number(r.ended_at),
    exercises: r.exercises,
    notes: r.notes || ''
  };
}

async function getAllWorkoutsDesc() {
  const { rows } = await pool.query('SELECT * FROM workouts ORDER BY ended_at DESC');
  return rows.map(rowToWorkout);
}

async function getExerciseLast(exerciseId) {
  const workouts = await getAllWorkoutsDesc();
  for (const w of workouts) {
    const entry = w.exercises.find(e => e.exerciseId === exerciseId);
    if (entry) return { sets: entry.sets, date: w.date };
  }
  return null;
}

async function getExerciseHistory(exerciseId) {
  const workouts = await getAllWorkoutsDesc();
  const sessions = [];
  workouts.forEach(w => {
    const entry = w.exercises.find(e => e.exerciseId === exerciseId);
    if (entry) sessions.push({ workoutId: w.id, date: w.date, sets: entry.sets });
  });
  return sessions;
}

async function getWorkouts() {
  return getAllWorkoutsDesc();
}

async function getWorkout(workoutId) {
  const { rows } = await pool.query('SELECT * FROM workouts WHERE id = $1', [workoutId]);
  return rows[0] ? rowToWorkout(rows[0]) : null;
}

async function addWorkout({ name, startedAt, endedAt, date, exercises, notes }) {
  const workout = {
    id: id(),
    name: name || 'Workout',
    startedAt,
    endedAt,
    date,
    exercises,
    notes: notes || ''
  };
  await pool.query(
    'INSERT INTO workouts (id, name, date, started_at, ended_at, exercises, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [workout.id, workout.name, workout.date, workout.startedAt, workout.endedAt, JSON.stringify(workout.exercises), workout.notes]
  );
  return workout;
}

async function deleteWorkout(workoutId) {
  const { rowCount } = await pool.query('DELETE FROM workouts WHERE id = $1', [workoutId]);
  return rowCount > 0;
}

function rowToRoutine(r) {
  return { id: r.id, name: r.name, exercises: r.exercises };
}

async function getRoutines() {
  const { rows } = await pool.query('SELECT * FROM routines ORDER BY name');
  return rows.map(rowToRoutine);
}

async function addRoutine({ name, exercises }) {
  const routine = { id: id(), name, exercises };
  await pool.query(
    'INSERT INTO routines (id, name, exercises) VALUES ($1,$2,$3)',
    [routine.id, routine.name, JSON.stringify(routine.exercises)]
  );
  return routine;
}

async function updateRoutine(routineId, { name, exercises }) {
  const { rows } = await pool.query(
    'UPDATE routines SET name = $1, exercises = $2 WHERE id = $3 RETURNING *',
    [name, JSON.stringify(exercises), routineId]
  );
  return rows[0] ? rowToRoutine(rows[0]) : null;
}

async function deleteRoutine(routineId) {
  const { rowCount } = await pool.query('DELETE FROM routines WHERE id = $1', [routineId]);
  return rowCount > 0;
}

module.exports = {
  init, getExercises, addExercise, getExerciseLast, getExerciseHistory,
  getWorkouts, getWorkout, addWorkout, deleteWorkout,
  getRoutines, addRoutine, updateRoutine, deleteRoutine
};
