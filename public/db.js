const DB_KEY = 'ironLogDb';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Cardio exercises track distance/calories instead of weight/reps. Installs
// that already existed before cardio support shipped have "Running" etc.
// saved without the isCardio flag, and won't have "Treadmill"/"Elliptical"
// at all - both are patched in here so every device catches up without
// needing a fresh install.
function migrateCardioExercises(store) {
  let changed = false;
  store.exercises.forEach(e => {
    if (e.category === 'Cardio' && !e.isCardio) {
      e.isCardio = true;
      changed = true;
    }
  });
  const names = new Set(store.exercises.map(e => e.name.toLowerCase()));
  const additions = [
    { name: 'Treadmill', category: 'Cardio', equipment: 'Machine', isCardio: true },
    { name: 'Elliptical', category: 'Cardio', equipment: 'Machine', isCardio: true }
  ];
  additions.forEach(a => {
    if (!names.has(a.name.toLowerCase())) {
      store.exercises.push({ id: uid(), ...a });
      changed = true;
    }
  });
  return changed;
}

function loadDb() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.exercises) parsed.exercises = [];
      if (!parsed.workouts) parsed.workouts = [];
      if (!parsed.routines) parsed.routines = [];
      if (migrateCardioExercises(parsed)) saveDb(parsed);
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

  async addExercise({ name, category, equipment, isCardio }) {
    const store = loadDb();
    const exercise = { id: uid(), name, category: category || 'Other', equipment: equipment || 'None', isCardio: !!isCardio };
    store.exercises.push(exercise);
    saveDb(store);
    return exercise;
  },

  async updateExercise(exerciseId, { name, category, equipment }) {
    const store = loadDb();
    const exercise = store.exercises.find(e => e.id === exerciseId);
    if (!exercise) return null;
    exercise.name = name;
    exercise.category = category || 'Other';
    exercise.equipment = equipment || 'None';
    // Workouts and templates keep their own copy of the name for display, so
    // update those too or old sessions keep showing the old label.
    store.workouts.forEach(w => w.exercises.forEach(e => {
      if (e.exerciseId === exerciseId) e.name = exercise.name;
    }));
    store.routines.forEach(r => r.exercises.forEach(e => {
      if (e.exerciseId === exerciseId) e.name = exercise.name;
    }));
    saveDb(store);
    return exercise;
  },

  async countSessions(exerciseId) {
    return loadDb().workouts
      .filter(w => w.exercises.some(e => e.exerciseId === exerciseId)).length;
  },

  async getExerciseLast(exerciseId) {
    const store = loadDb();
    for (const w of workoutsDesc(store)) {
      const entry = w.exercises.find(e => e.exerciseId === exerciseId);
      if (entry) return { sets: entry.sets, date: w.date, notes: entry.notes || '' };
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
    const store = loadDb();
    const cardioIds = new Set(store.exercises.filter(e => e.isCardio).map(e => e.id));
    const cleanExercises = exercises
      .map(e => {
        const cardio = cardioIds.has(e.exerciseId);
        return {
          exerciseId: e.exerciseId,
          name: e.name,
          notes: e.notes || '',
          linkedToPrev: !!e.linkedToPrev,
          sets: (e.sets || [])
            .filter(s => cardio ? (Number(s.km) > 0 || Number(s.calories) > 0) : (Number(s.reps) > 0 || Number(s.weight) > 0))
            .map(s => cardio
              ? { km: Number(s.km) || 0, calories: Number(s.calories) || 0 }
              : { reps: Number(s.reps) || 0, weight: Number(s.weight) || 0, warmup: !!s.warmup })
        };
      })
      .filter(e => e.sets.length > 0);
    if (cleanExercises.length === 0) {
      throw new Error('At least one exercise with a logged set is required');
    }
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
      throw new Error('That file is not a Coach Umer backup.');
    }
    const { exercises, workouts, routines } = payload;
    if (!Array.isArray(exercises) || !Array.isArray(workouts) || !Array.isArray(routines)) {
      throw new Error('That file is missing workout data, so it is not a Coach Umer backup.');
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
