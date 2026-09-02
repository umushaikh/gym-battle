const DB_KEY = 'ironLogDb';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function loadDb() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.exercises) parsed.exercises = [];
      if (!parsed.workouts) parsed.workouts = [];
      if (!parsed.routines) parsed.routines = [];
      return parsed;
    } catch {
      // fall through and reseed a fresh db below
    }
  }
  const seeded = {
    exercises: DEFAULT_EXERCISES.map(e => ({ id: uid(), ...e })),
    workouts: [],
    routines: []
  };
  saveDb(seeded);
  return seeded;
}

function saveDb(store) {
  localStorage.setItem(DB_KEY, JSON.stringify(store));
}

function workoutsDesc(store) {
  return [...store.workouts].sort((a, b) => b.endedAt - a.endedAt);
}

const db = {
  async getExercises() {
    return loadDb().exercises;
  },

  async addExercise({ name, category, equipment }) {
    const store = loadDb();
    const exercise = { id: uid(), name, category: category || 'Other', equipment: equipment || 'None' };
    store.exercises.push(exercise);
    saveDb(store);
    return exercise;
  },

  async getExerciseLast(exerciseId) {
    const store = loadDb();
    for (const w of workoutsDesc(store)) {
      const entry = w.exercises.find(e => e.exerciseId === exerciseId);
      if (entry) return { sets: entry.sets, date: w.date };
    }
    return null;
  },

  async getExerciseHistory(exerciseId) {
    const store = loadDb();
    const sessions = [];
    workoutsDesc(store).forEach(w => {
      const entry = w.exercises.find(e => e.exerciseId === exerciseId);
      if (entry) sessions.push({ workoutId: w.id, date: w.date, sets: entry.sets });
    });
    return sessions;
  },

  async getWorkouts() {
    return workoutsDesc(loadDb());
  },

  async addWorkout({ name, startedAt, endedAt, date, exercises, notes }) {
    const cleanExercises = exercises
      .map(e => ({
        exerciseId: e.exerciseId,
        name: e.name,
        sets: (e.sets || [])
          .filter(s => Number(s.reps) > 0 || Number(s.weight) > 0)
          .map(s => ({ reps: Number(s.reps) || 0, weight: Number(s.weight) || 0, warmup: !!s.warmup }))
      }))
      .filter(e => e.sets.length > 0);
    if (cleanExercises.length === 0) {
      throw new Error('At least one exercise with a logged set is required');
    }
    const store = loadDb();
    const workout = {
      id: uid(),
      name: (name || '').trim() || 'Workout',
      startedAt,
      endedAt,
      date,
      exercises: cleanExercises,
      notes: notes || ''
    };
    store.workouts.push(workout);
    saveDb(store);
    return workout;
  },

  async deleteWorkout(workoutId) {
    const store = loadDb();
    const before = store.workouts.length;
    store.workouts = store.workouts.filter(w => w.id !== workoutId);
    if (store.workouts.length === before) return false;
    saveDb(store);
    return true;
  },

  async exportData() {
    const store = loadDb();
    return {
      app: 'iron-log',
      version: 1,
      exportedAt: new Date().toISOString(),
      exercises: store.exercises,
      workouts: store.workouts,
      routines: store.routines
    };
  },

  // Replaces everything. The ids inside a backup are self-consistent, so
  // restoring wholesale keeps workout history pointing at the right exercises.
  async importData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('That file is not an Iron Log backup.');
    }
    const { exercises, workouts, routines } = payload;
    if (!Array.isArray(exercises) || !Array.isArray(workouts) || !Array.isArray(routines)) {
      throw new Error('That file is missing workout data, so it is not an Iron Log backup.');
    }
    saveDb({ exercises, workouts, routines });
    return { exercises: exercises.length, workouts: workouts.length, routines: routines.length };
  },

  async getRoutines() {
    return loadDb().routines;
  },

  async addRoutine({ name, exercises }) {
    const store = loadDb();
    const routine = { id: uid(), name, exercises };
    store.routines.push(routine);
    saveDb(store);
    return routine;
  },

  async updateRoutine(routineId, { name, exercises }) {
    const store = loadDb();
    const routine = store.routines.find(r => r.id === routineId);
    if (!routine) return null;
    routine.name = name;
    routine.exercises = exercises;
    saveDb(store);
    return routine;
  },

  async deleteRoutine(routineId) {
    const store = loadDb();
    const before = store.routines.length;
    store.routines = store.routines.filter(r => r.id !== routineId);
    if (store.routines.length === before) return false;
    saveDb(store);
    return true;
  }
};
