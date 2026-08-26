const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_EXERCISES = [
  'Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row',
  'Pull-ups', 'Push-ups', 'Lunges', 'Bicep Curl', 'Tricep Dips',
  'Shoulder Press', 'Leg Press', 'Lat Pulldown', 'Plank Hold', 'Sit-ups'
];

function seedDb() {
  return {
    profiles: [
      { id: 'p1', name: 'chaiky boy', color: '#3b82f6' },
      { id: 'p2', name: 'nosey girl', color: '#ec4899' }
    ],
    exercises: DEFAULT_EXERCISES,
    workouts: [],
    bets: []
  };
}

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (!db.profiles) db.profiles = seedDb().profiles;
  if (!db.exercises || db.exercises.length === 0) db.exercises = DEFAULT_EXERCISES;
  if (!db.workouts) db.workouts = [];
  if (!db.bets) db.bets = [];
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) writeDb(seedDb());
}

async function getProfiles() {
  return readDb().profiles;
}

async function renameProfile(profileId, name) {
  const db = readDb();
  const profile = db.profiles.find(p => p.id === profileId);
  if (!profile) return null;
  profile.name = name;
  writeDb(db);
  return profile;
}

async function getExercises() {
  return readDb().exercises;
}

async function addExercise(name) {
  const db = readDb();
  if (!db.exercises.includes(name)) {
    db.exercises.push(name);
    writeDb(db);
  }
  return db.exercises;
}

async function getWorkouts({ profileId, exercise, from, to } = {}) {
  const db = readDb();
  let results = db.workouts;
  if (profileId) results = results.filter(w => w.profileId === profileId);
  if (exercise) results = results.filter(w => w.exercise === exercise);
  if (from) results = results.filter(w => w.date >= from);
  if (to) results = results.filter(w => w.date <= to);
  return [...results].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

async function profileExists(profileId) {
  const db = readDb();
  return db.profiles.some(p => p.id === profileId);
}

async function addWorkout({ profileId, exercise, sets, date, notes }) {
  const db = readDb();
  const workout = {
    id: id(),
    profileId,
    exercise,
    sets,
    date,
    notes: notes || '',
    createdAt: Date.now()
  };
  db.workouts.push(workout);
  if (!db.exercises.includes(exercise)) db.exercises.push(exercise);
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

async function getBets() {
  const db = readDb();
  return [...db.bets].sort((a, b) => b.createdAt - a.createdAt);
}

async function addBet({ title, exercise, metric, stake, startDate, endDate }) {
  const db = readDb();
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
  db.bets.push(bet);
  writeDb(db);
  return bet;
}

async function deleteBet(betId) {
  const db = readDb();
  const before = db.bets.length;
  db.bets = db.bets.filter(b => b.id !== betId);
  if (db.bets.length === before) return false;
  writeDb(db);
  return true;
}

module.exports = {
  init, getProfiles, renameProfile, getExercises, addExercise,
  getWorkouts, profileExists, addWorkout, deleteWorkout,
  getBets, addBet, deleteBet
};
