const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_EXERCISES = require('./exercises-seed');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function seedDb() {
  return {
    exercises: DEFAULT_EXERCISES.map(e => ({ id: id(), ...e })),
    workouts: [],
    routines: []
  };
}

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (!db.exercises || db.exercises.length === 0) db.exercises = seedDb().exercises;
  if (!db.workouts) db.workouts = [];
  if (!db.routines) db.routines = [];
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) writeDb(seedDb());
}

async function getExercises() {
  return readDb().exercises;
}

async function addExercise({ name, category, equipment }) {
  const db = readDb();
  const exercise = { id: id(), name, category: category || 'Other', equipment: equipment || 'None' };
  db.exercises.push(exercise);
  writeDb(db);
  return exercise;
}

function workoutsDesc(db) {
  return [...db.workouts].sort((a, b) => b.endedAt - a.endedAt);
}

async function getExerciseLast(exerciseId) {
  const db = readDb();
  for (const w of workoutsDesc(db)) {
    const entry = w.exercises.find(e => e.exerciseId === exerciseId);
    if (entry) return { sets: entry.sets, date: w.date };
  }
  return null;
}

async function getExerciseHistory(exerciseId) {
  const db = readDb();
  const sessions = [];
  workoutsDesc(db).forEach(w => {
    const entry = w.exercises.find(e => e.exerciseId === exerciseId);
    if (entry) sessions.push({ workoutId: w.id, date: w.date, sets: entry.sets });
  });
  return sessions;
}

async function getWorkouts() {
  return workoutsDesc(readDb());
}

async function getWorkout(workoutId) {
  const db = readDb();
  return db.workouts.find(w => w.id === workoutId) || null;
}

async function addWorkout({ name, startedAt, endedAt, date, exercises, notes }) {
  const db = readDb();
  const workout = {
    id: id(),
    name: name || 'Workout',
    startedAt,
    endedAt,
    date,
    exercises,
    notes: notes || ''
  };
  db.workouts.push(workout);
  writeDb(db);
  return workout;
}

async function deleteWorkout(workoutId) {
  const db = readDb();
  const before = db.workouts.length;
  db.workouts = db.workouts.filter(w => w.id !== workoutId);
  if (db.workouts.length === before) return false;
  writeDb(db);
  return true;
}

async function getRoutines() {
  return readDb().routines;
}

async function addRoutine({ name, exercises }) {
  const db = readDb();
  const routine = { id: id(), name, exercises };
  db.routines.push(routine);
  writeDb(db);
  return routine;
}

async function updateRoutine(routineId, { name, exercises }) {
  const db = readDb();
  const routine = db.routines.find(r => r.id === routineId);
  if (!routine) return null;
  routine.name = name;
  routine.exercises = exercises;
  writeDb(db);
  return routine;
}

async function deleteRoutine(routineId) {
  const db = readDb();
  const before = db.routines.length;
  db.routines = db.routines.filter(r => r.id !== routineId);
  if (db.routines.length === before) return false;
  writeDb(db);
  return true;
}

module.exports = {
  init, getExercises, addExercise, getExerciseLast, getExerciseHistory,
  getWorkouts, getWorkout, addWorkout, deleteWorkout,
  getRoutines, addRoutine, updateRoutine, deleteRoutine
};
