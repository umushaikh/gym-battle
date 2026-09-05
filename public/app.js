const ACTIVE_WORKOUT_KEY = 'ironLogActiveWorkout';
const WARMUP_HINT_KEY = 'ironLogWarmupHintSeen';

// The hint explains a control that isn't self-evident, but repeating it under
// every exercise pads the page more with each one added. Show it under the
// first exercise only, and retire it for good the first time a warm-up is
// actually marked.
function warmupHintNeeded() {
  return localStorage.getItem(WARMUP_HINT_KEY) !== '1';
}

const state = {
  exercises: [],
  activeWorkout: null,   // { name, startedAt, notes, exercises: [{exerciseId, name, sets:[{reps,weight,warmup,completed}]}] }
  lastCache: {},          // exerciseId -> { sets, date } | null
  pickerTarget: null,     // 'workout' | 'routine'
  pickerSelection: [],    // exercise ids ticked in the picker
  pickerCategoryFilter: '',
  routineEditing: null,   // { id?, name, exercises: [{exerciseId, name, sets:[{reps,weight}]}] }
  timerInterval: null,
  rest: null,              // { endsAt } while resting between sets
  restInterval: null,
  categoryFilter: ''
};

if ('serviceWorker' in navigator) {
  // Whether a worker was already in charge when this page loaded. If one was,
  // a later handover means a new version has been deployed, so reload to show
  // it - but only once nothing would be lost by doing so. An open modal (an
  // exercise search mid-keystroke, an unsaved template being built, an
  // in-progress exercise edit) holds state that lives only in memory; an
  // immediate reload silently wiped it out from under whoever was typing,
  // which looked exactly like their input vanishing and the app dropping
  // back to its home screen mid-sentence.
  // Tracks whether a controller has existed at any point this session, not
  // just at load time. A fresh install has none yet, so its first
  // controllerchange is that worker claiming control for the very first
  // time - nothing to update from, so it must not trigger a reload. But that
  // flag has to flip to true right after, or every real update for the rest
  // of the tab's life would be mistaken for the same first-time claim and
  // silently ignored forever - which is worse than reloading too eagerly.
  let controllerSeen = !!navigator.serviceWorker.controller;
  let updateReady = false;
  let reloaded = false;

  function anyModalOpen() {
    return !!document.querySelector('.modal:not(.hidden)');
  }

  function reloadWhenSafe() {
    if (!updateReady || reloaded || anyModalOpen()) return;
    reloaded = true;
    window.location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controllerSeen && !reloaded) {
      updateReady = true;
      reloadWhenSafe();
    }
    controllerSeen = true;
  });

  // A modal can be closed well before any other page interaction happens, so
  // poll rather than only reacting to specific close buttons - there are
  // several, and missing one would mean the deferred reload never fires.
  setInterval(reloadWhenSafe, 2000);

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// escapeHtml escapes & < > but not quotes, which is fine for text nodes and
// unsafe inside an attribute. Use this for anything interpolated into one.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A weight/reps field showing "0" (a fresh set, or one copied from a set
// that was legitimately zero) made every entry start with deleting that zero
// by hand. Selecting its content on focus means the first keystroke just
// replaces it, the way tapping into a pre-filled amount field normally works.
function selectContentsOnFocus(input) {
  input.addEventListener('focus', () => input.select());
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function e1rm(reps, weight) {
  if (!weight || !reps) return 0;
  return weight * (1 + reps / 30);
}

function isCardioExercise(exerciseId) {
  const ex = state.exercises.find(e => e.id === exerciseId);
  return !!(ex && ex.isCardio);
}

function formatSets(sets, isCardio) {
  const groups = [];
  sets.forEach(s => {
    const last = groups[groups.length - 1];
    if (isCardio) {
      if (last && last.km === s.km && last.calories === s.calories) {
        last.count++;
      } else {
        groups.push({ km: s.km, calories: s.calories, count: 1 });
      }
      return;
    }
    const warmup = !!s.warmup;
    if (last && last.reps === s.reps && last.weight === s.weight && last.warmup === warmup) {
      last.count++;
    } else {
      groups.push({ reps: s.reps, weight: s.weight, warmup, count: 1 });
    }
  });
  if (isCardio) {
    return groups.map(g => `${g.count > 1 ? `${g.count}× ` : ''}${g.km || 0}km${g.calories ? ` · ${g.calories} cal` : ''}`).join(', ');
  }
  return groups.map(g => `${g.warmup ? 'Warmup ' : ''}${g.count}×${g.reps}${g.weight ? ` @ ${g.weight}kg` : ''}`).join(', ');
}

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

// A superset is a run of adjacent exercises, each linked to the one above it.
// Returns a group number per exercise, or null when it stands alone.
function computeSupersets(exercises) {
  const groupOf = new Array(exercises.length).fill(null);
  let group = -1;
  exercises.forEach((ex, i) => {
    if (i > 0 && ex.linkedToPrev) {
      if (groupOf[i - 1] === null) {
        group++;
        groupOf[i - 1] = group;
      }
      groupOf[i] = groupOf[i - 1];
    }
  });
  return groupOf;
}

// Cardio sets carry km/calories instead of weight/reps, so they naturally
// contribute 0 here (Number(undefined) is NaN, guarded back to 0) rather
// than needing to be filtered out exercise-by-exercise.
function workoutVolume(workout) {
  return workout.exercises.reduce((sum, e) =>
    sum + e.sets.filter(set => !set.warmup).reduce((s, set) => s + (Number(set.reps) || 0) * (Number(set.weight) || 0), 0), 0);
}

function buildShareText(workout) {
  const lines = [
    `${workout.name} — ${workout.date}`,
    `${formatDuration(workout.endedAt - workout.startedAt)} · Volume ${Math.round(workoutVolume(workout)).toLocaleString()}kg`,
    ''
  ];
  workout.exercises.forEach(e => {
    lines.push(`${e.name}: ${formatSets(e.sets, isCardioExercise(e.exerciseId))}`);
    if (e.notes) lines.push(`  (${e.notes})`);
  });
  if (workout.notes) lines.push('', `Notes: ${workout.notes}`);
  lines.push('', 'Logged with Coach Umer');
  return lines.join('\n');
}

async function shareWorkout(workout) {
  const text = buildShareText(workout);
  if (navigator.share) {
    try {
      await navigator.share({ title: workout.name, text });
      return;
    } catch {
      // user dismissed the share sheet
      return;
    }
  }
  // No native share sheet (e.g. served over plain http): show the text so it
  // can be copied out by hand.
  openCopySheet('Share Workout', text);
}

function openCopySheet(title, text) {
  document.getElementById('share-modal-title').textContent = title;
  document.getElementById('share-text').value = text;
  document.getElementById('copy-share-btn').textContent = 'Copy to clipboard';
  document.getElementById('share-modal').classList.remove('hidden');
}

async function copyShareText() {
  const area = document.getElementById('share-text');
  const btn = document.getElementById('copy-share-btn');
  let copied = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(area.value);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    area.removeAttribute('readonly');
    area.focus();
    area.setSelectionRange(0, area.value.length);
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.setAttribute('readonly', '');
  }
  btn.textContent = copied ? 'Copied!' : 'Press and hold the text to copy';
}

// ---------- Rest timer ----------
const REST_KEY = 'ironLogRestTimer';
const REST_DEFAULT_KEY = 'ironLogRestSeconds';

function getDefaultRest() {
  // Number(null) is 0, so an absent key must be handled before converting,
  // or a fresh install would silently start with the timer switched off.
  const raw = localStorage.getItem(REST_DEFAULT_KEY);
  if (raw === null) return 90;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= 0 ? stored : 90;
}

// Web Audio needs to be opened during a real tap, so this is called from the
// same gesture that starts the timer rather than when it finishes.
let audioCtx = null;
function primeBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep() {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.6);
  } catch {
    // a missing beep should never break the timer
  }
}

function startRest(seconds) {
  const secs = seconds == null ? getDefaultRest() : seconds;
  if (!secs || secs <= 0) return;
  // Stored as an end time, so a throttled or suspended tab still shows the
  // right number when it wakes up instead of drifting behind.
  state.rest = { endsAt: Date.now() + secs * 1000 };
  localStorage.setItem(REST_KEY, JSON.stringify(state.rest));
  primeBeep();
  renderRest();
  if (!state.restInterval) state.restInterval = setInterval(tickRest, 250);
}

function stopRest() {
  state.rest = null;
  localStorage.removeItem(REST_KEY);
  if (state.restInterval) {
    clearInterval(state.restInterval);
    state.restInterval = null;
  }
  document.getElementById('rest-bar').classList.add('hidden');
}

function adjustRest(deltaSeconds) {
  if (!state.rest) return;
  state.rest.endsAt += deltaSeconds * 1000;
  if (state.rest.endsAt <= Date.now()) {
    stopRest();
    return;
  }
  localStorage.setItem(REST_KEY, JSON.stringify(state.rest));
  renderRest();
}

function tickRest() {
  if (!state.rest) {
    stopRest();
    return;
  }
  if (state.rest.endsAt - Date.now() <= 0) {
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    stopRest();
    return;
  }
  renderRest();
}

function renderRest() {
  const bar = document.getElementById('rest-bar');
  if (!state.rest) {
    bar.classList.add('hidden');
    return;
  }
  const total = Math.ceil(Math.max(0, state.rest.endsAt - Date.now()) / 1000);
  document.getElementById('rest-time').textContent =
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  bar.classList.remove('hidden');
}

function restoreRest() {
  const raw = localStorage.getItem(REST_KEY);
  if (!raw) return;
  try {
    const rest = JSON.parse(raw);
    if (rest && rest.endsAt > Date.now()) {
      state.rest = rest;
      state.restInterval = setInterval(tickRest, 250);
      renderRest();
    } else {
      localStorage.removeItem(REST_KEY);
    }
  } catch {
    localStorage.removeItem(REST_KEY);
  }
}

// Mobile browsers throttle or fully suspend setInterval while the tab or app
// is backgrounded, so the countdown can sit stale for the seconds/minutes
// the phone was locked or another app was in front. Force an immediate
// catch-up the moment the page is visible again instead of waiting for the
// interval to resume on its own - otherwise a finished rest can sit
// silently expired, with no beep and no ticking to zero shown.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.rest) tickRest();
});

// ---------- Backup & restore ----------
async function openDataModal() {
  document.getElementById('rest-default-input').value = getDefaultRest();
  const profile = await db.getProfile();
  document.getElementById('profile-bodyweight-input').value = profile.bodyweightKg || '';
  document.getElementById('profile-sex-input').value = profile.sex || '';
  const data = await db.exportData();
  document.getElementById('data-summary').innerHTML = `
    <div class="pr-row"><span>Workouts saved</span><strong>${data.workouts.length}</strong></div>
    <div class="pr-row"><span>Routines</span><strong>${data.routines.length}</strong></div>
    <div class="pr-row"><span>Exercises</span><strong>${data.exercises.length}</strong></div>
  `;
  document.getElementById('version-line').textContent = versionLabel(true);
  document.getElementById('data-modal').classList.remove('hidden');
}

// version.js is stamped by the deploy workflow with the real commit and
// build time; running locally (node server.js with no deploy) leaves the
// placeholders in place, so that case is shown plainly rather than as a
// nonsense hash.
function versionLabel(withDate) {
  if (typeof APP_VERSION === 'undefined' || APP_VERSION.sha.startsWith('__')) return 'dev build';
  const short = APP_VERSION.sha.slice(0, 7);
  if (!withDate) return short;
  return `Build ${short} · ${APP_VERSION.builtAt}`;
}

async function exportBackupFile() {
  const data = await db.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `iron-log-backup-${todayStr()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportBackupText() {
  const data = await db.exportData();
  openCopySheet('Backup', JSON.stringify(data));
}

async function handleImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  if (state.activeWorkout) {
    alert('Finish or cancel the workout you have in progress before restoring a backup.');
    input.value = '';
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    alert('That file could not be read. Pick the .json backup file this app saved.');
    input.value = '';
    return;
  }

  // Check the file is a backup before showing the "this replaces everything"
  // prompt, so a wrong file is turned away instead of looking like an empty
  // restore about to wipe the app.
  const looksLikeBackup = payload && typeof payload === 'object' && !Array.isArray(payload)
    && Array.isArray(payload.workouts) && Array.isArray(payload.routines) && Array.isArray(payload.exercises);
  if (!looksLikeBackup) {
    alert('That file is not a Coach Umer backup. Pick the .json file the Download backup button saved.');
    input.value = '';
    return;
  }

  const workoutCount = payload.workouts.length;
  const routineCount = payload.routines.length;
  const ok = confirm(
    `Restore ${workoutCount} workout${workoutCount !== 1 ? 's' : ''} and ${routineCount} routine${routineCount !== 1 ? 's' : ''}?\n\n` +
    'This replaces everything currently in the app.'
  );
  if (!ok) {
    input.value = '';
    return;
  }

  try {
    const restored = await db.importData(payload);
    state.exercises = await db.getExercises();
    state.lastCache = {};
    input.value = '';
    document.getElementById('data-modal').classList.add('hidden');
    renderWorkoutTab();
    alert(`Restored ${restored.workouts} workouts and ${restored.routines} routines.`);
  } catch (err) {
    input.value = '';
    alert(err.message);
  }
}

// ---------- Init ----------
async function init() {
  document.getElementById('version-tag').textContent = versionLabel(false);
  state.exercises = await db.getExercises();
  restoreActiveWorkout();
  bindEvents();
  restoreRest();
  renderWorkoutTab();
}

function bindEvents() {
  document.querySelectorAll('.tabbar-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('start-empty-btn').addEventListener('click', startEmptyWorkout);
  document.getElementById('add-exercise-btn').addEventListener('click', () => openPicker('workout'));
  document.getElementById('cancel-workout-btn').addEventListener('click', cancelWorkout);
  document.getElementById('finish-workout-btn').addEventListener('click', finishWorkout);
  document.getElementById('pause-workout-btn').addEventListener('click', togglePauseWorkout);
  document.getElementById('active-workout-name').addEventListener('input', e => {
    if (state.activeWorkout) {
      state.activeWorkout.name = e.target.value;
      persistActiveWorkout();
    }
  });
  document.getElementById('workout-notes-input').addEventListener('input', e => {
    if (state.activeWorkout) {
      state.activeWorkout.notes = e.target.value;
      persistActiveWorkout();
    }
  });

  document.getElementById('close-picker-btn').addEventListener('click', closePicker);
  document.getElementById('picker-search').addEventListener('input', renderPickerList);
  document.getElementById('picker-new-btn').addEventListener('click', togglePickerNewForm);
  document.getElementById('picker-add-btn').addEventListener('click', () => addPickedExercises(false));
  document.getElementById('picker-superset-btn').addEventListener('click', () => addPickedExercises(true));
  document.getElementById('picker-new-save').addEventListener('click', createExerciseFromPicker);

  document.getElementById('close-detail-btn').addEventListener('click', closeDetail);
  document.getElementById('celebrate-close-btn').addEventListener('click', () => {
    document.getElementById('celebrate-modal').classList.add('hidden');
  });

  document.getElementById('close-share-btn').addEventListener('click', () => {
    document.getElementById('share-modal').classList.add('hidden');
  });
  document.getElementById('copy-share-btn').addEventListener('click', copyShareText);

  document.getElementById('data-btn').addEventListener('click', openDataModal);
  document.getElementById('close-data-btn').addEventListener('click', () => {
    document.getElementById('data-modal').classList.add('hidden');
  });
  document.getElementById('rest-minus').addEventListener('click', () => adjustRest(-15));
  document.getElementById('rest-plus').addEventListener('click', () => adjustRest(15));
  document.getElementById('rest-skip').addEventListener('click', stopRest);
  // Saved on every keystroke rather than waiting for the field to blur: a
  // quick tap on Close right after typing doesn't reliably fire 'change'
  // first on mobile, which could silently drop the new value.
  document.getElementById('rest-default-input').addEventListener('input', e => {
    const secs = Math.max(0, Math.min(900, Number(e.target.value) || 0));
    localStorage.setItem(REST_DEFAULT_KEY, String(secs));
  });
  document.getElementById('rest-default-input').addEventListener('change', e => {
    e.target.value = getDefaultRest();
  });
  document.getElementById('profile-bodyweight-input').addEventListener('input', e => {
    const kg = Number(e.target.value);
    db.updateProfile({ bodyweightKg: kg > 0 ? kg : null });
  });
  document.getElementById('profile-sex-input').addEventListener('change', e => {
    db.updateProfile({ sex: e.target.value || null });
  });

  document.getElementById('export-btn').addEventListener('click', exportBackupFile);
  document.getElementById('export-text-btn').addEventListener('click', exportBackupText);
  document.getElementById('import-file').addEventListener('change', handleImportFile);

  document.getElementById('new-routine-btn').addEventListener('click', () => openRoutineEditor(null));
  document.getElementById('close-routine-btn').addEventListener('click', closeRoutineEditor);
  document.getElementById('routine-add-exercise-btn').addEventListener('click', () => openPicker('routine'));
  document.getElementById('save-routine-btn').addEventListener('click', saveRoutine);
  document.getElementById('routine-name-input').addEventListener('input', e => {
    if (state.routineEditing) state.routineEditing.name = e.target.value;
  });

  document.getElementById('exercise-search').addEventListener('input', renderLibraryList);
  document.getElementById('new-exercise-btn').addEventListener('click', () => {
    document.getElementById('new-exercise-form').classList.toggle('hidden');
  });
  document.getElementById('save-new-exercise-btn').addEventListener('click', createExerciseFromLibrary);
  document.getElementById('close-edit-exercise-btn').addEventListener('click', closeExerciseEditor);
  document.getElementById('save-edit-exercise-btn').addEventListener('click', saveExerciseEdit);
}

function switchTab(tab) {
  document.querySelectorAll('.tabbar-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'workout') renderWorkoutTab();
  if (tab === 'history') loadHistory();
  if (tab === 'analytics') renderAnalyticsTab();
  if (tab === 'exercises') renderLibraryTab();
}

// ---------- Active workout persistence ----------
function persistActiveWorkout() {
  if (state.activeWorkout) {
    localStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify(state.activeWorkout));
  } else {
    localStorage.removeItem(ACTIVE_WORKOUT_KEY);
  }
}

function restoreActiveWorkout() {
  const raw = localStorage.getItem(ACTIVE_WORKOUT_KEY);
  if (!raw) return;
  try {
    state.activeWorkout = JSON.parse(raw);
    state.activeWorkout.exercises.forEach(e => warmLastCache(e.exerciseId));
  } catch {
    localStorage.removeItem(ACTIVE_WORKOUT_KEY);
  }
}

async function warmLastCache(exerciseId) {
  if (exerciseId in state.lastCache) return;
  state.lastCache[exerciseId] = await db.getExerciseLast(exerciseId);
}

// ---------- Workout tab: start screen ----------
function renderWorkoutTab() {
  if (state.activeWorkout) {
    document.getElementById('workout-start').classList.add('hidden');
    document.getElementById('workout-active').classList.remove('hidden');
    renderActiveWorkout();
    startTimer();
  } else {
    document.getElementById('workout-start').classList.remove('hidden');
    document.getElementById('workout-active').classList.add('hidden');
    stopTimer();
    loadRoutines();
  }
}

async function loadRoutines() {
  const routines = await db.getRoutines();
  const container = document.getElementById('routines-list');
  if (routines.length === 0) {
    container.innerHTML = `<div class="empty-state">No templates yet. Build one for a workout you plan to do, then start it with one tap whenever you repeat it.</div>`;
    return;
  }
  container.innerHTML = routines.map(r => `
    <div class="routine-card">
      <div class="routine-main">
        <div class="entry-title">${escapeHtml(r.name)}</div>
        <div class="entry-sub">${r.exercises.length} exercise${r.exercises.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="routine-actions">
        <button class="secondary-btn small start-routine-btn" data-id="${r.id}">Start</button>
        <button class="icon-btn edit-routine-btn" data-id="${r.id}" title="edit">✎</button>
        <button class="icon-btn del-btn" data-id="${r.id}" title="delete">🗑</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.start-routine-btn').forEach(btn => {
    btn.addEventListener('click', () => startFromRoutine(routines.find(r => r.id === btn.dataset.id)));
  });
  container.querySelectorAll('.edit-routine-btn').forEach(btn => {
    btn.addEventListener('click', () => openRoutineEditor(routines.find(r => r.id === btn.dataset.id)));
  });
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this template?')) return;
      await db.deleteRoutine(btn.dataset.id);
      loadRoutines();
    });
  });
}

function startEmptyWorkout() {
  state.activeWorkout = { name: '', startedAt: Date.now(), pausedAt: null, pausedMs: 0, notes: '', exercises: [] };
  persistActiveWorkout();
  renderWorkoutTab();
}

function startFromRoutine(routine) {
  state.activeWorkout = {
    name: routine.name,
    startedAt: Date.now(),
    pausedAt: null,
    pausedMs: 0,
    notes: '',
    exercises: routine.exercises.map(e => {
      const cardio = isCardioExercise(e.exerciseId);
      return {
        exerciseId: e.exerciseId,
        name: e.name,
        notes: '',
        linkedToPrev: !!e.linkedToPrev,
        sets: e.sets.map(s => cardio
          ? { km: s.km ?? '', calories: s.calories ?? '', completed: false }
          : { reps: s.reps ?? '', weight: s.weight ?? '', warmup: false, completed: false })
      };
    })
  };
  // Templates don't carry their own notes, so once each exercise's history
  // loads, backfill whatever note was left on it last time.
  state.activeWorkout.exercises.forEach(e => warmLastCache(e.exerciseId).then(() => {
    const last = state.lastCache[e.exerciseId];
    if (last && last.notes && !e.notes) e.notes = last.notes;
    persistActiveWorkout();
    renderActiveWorkout();
  }));
  persistActiveWorkout();
  renderWorkoutTab();
}

function cancelWorkout() {
  if (!confirm('Discard this workout? This cannot be undone.')) return;
  stopRest();
  state.activeWorkout = null;
  persistActiveWorkout();
  renderWorkoutTab();
}

// ---------- Active workout ----------
function startTimer() {
  stopTimer();
  updateTimerDisplay();
  renderPauseButton();
  state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

function updateTimerDisplay() {
  if (!state.activeWorkout) return;
  // While paused, "now" is frozen at the moment pausing happened, so the
  // display stops advancing without needing to stop the interval itself.
  const now = state.activeWorkout.pausedAt || Date.now();
  const elapsed = now - state.activeWorkout.startedAt - (state.activeWorkout.pausedMs || 0);
  const totalSec = Math.max(0, Math.floor(elapsed / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  document.getElementById('active-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function togglePauseWorkout() {
  if (!state.activeWorkout) return;
  if (state.activeWorkout.pausedAt) {
    state.activeWorkout.pausedMs = (state.activeWorkout.pausedMs || 0) + (Date.now() - state.activeWorkout.pausedAt);
    state.activeWorkout.pausedAt = null;
  } else {
    state.activeWorkout.pausedAt = Date.now();
  }
  persistActiveWorkout();
  updateTimerDisplay();
  renderPauseButton();
}

function renderPauseButton() {
  const btn = document.getElementById('pause-workout-btn');
  const timer = document.getElementById('active-timer');
  const paused = !!(state.activeWorkout && state.activeWorkout.pausedAt);
  btn.textContent = paused ? '▶' : '⏸';
  btn.title = paused ? 'Resume workout' : 'Pause workout';
  btn.classList.toggle('resume', paused);
  timer.classList.toggle('paused', paused);
}

// The total paused time so far, folding in whatever segment is currently
// in progress if the workout is still paused right now.
function totalPausedMs(workout) {
  const running = workout.pausedAt ? Date.now() - workout.pausedAt : 0;
  return (workout.pausedMs || 0) + running;
}

function renderActiveWorkout() {
  document.getElementById('active-workout-name').value = state.activeWorkout.name;
  document.getElementById('workout-notes-input').value = state.activeWorkout.notes || '';
  const container = document.getElementById('active-exercises');

  if (state.activeWorkout.exercises.length === 0) {
    container.innerHTML = `<div class="empty-state">Add an exercise to get started.</div>`;
    return;
  }

  const ssGroups = computeSupersets(state.activeWorkout.exercises);
  container.innerHTML = state.activeWorkout.exercises.map((ex, exIdx) => {
    const ss = ssGroups[exIdx];
    const last = state.lastCache[ex.exerciseId];
    const cardio = isCardioExercise(ex.exerciseId);
    let workingCount = 0;
    const rows = ex.sets.map((set, setIdx) => {
      if (cardio) {
        const prevSet = last && last.sets[setIdx];
        const prev = prevSet ? `${prevSet.km || 0}km · ${prevSet.calories || 0}c` : '—';
        return `
          <div class="set-row-table" data-ex="${exIdx}" data-set="${setIdx}">
            <span class="set-num">${setIdx + 1}</span>
            <span class="set-prev">${prev}</span>
            <input type="number" min="0" step="0.01" class="set-km-input" placeholder="km" value="${set.km}" />
            <input type="number" min="0" class="set-cal-input" placeholder="cal" value="${set.calories}" />
            <button class="set-check ${set.completed ? 'done' : ''}" title="mark done">✓</button>
            <button class="set-remove" title="remove set">✕</button>
          </div>
        `;
      }
      const prev = last && last.sets[setIdx]
        ? `${last.sets[setIdx].weight || 0}×${last.sets[setIdx].reps || 0}`
        : '—';
      const label = set.warmup ? 'W' : String(++workingCount);
      return `
        <div class="set-row-table" data-ex="${exIdx}" data-set="${setIdx}">
          <button class="set-num ${set.warmup ? 'warmup' : ''}" title="${set.warmup ? 'Warm-up set. Tap for a working set' : 'Tap to mark as a warm-up set'}">${label}</button>
          <span class="set-prev">${prev}</span>
          <input type="number" min="0" step="0.5" class="set-weight-input" placeholder="kg" value="${set.weight}" />
          <input type="number" min="0" class="set-reps-input" placeholder="reps" value="${set.reps}" />
          <button class="set-check ${set.completed ? 'done' : ''}" title="mark done">✓</button>
          <button class="set-remove" title="remove set">✕</button>
        </div>
      `;
    }).join('');

    return `
      <div class="exercise-block ${ss !== null ? 'in-superset' : ''}" data-ex="${exIdx}" data-ss="${ss === null ? '' : ss % 4}">
        <div class="exercise-block-header">
          <button class="drag-handle" title="Drag to reorder" aria-label="Reorder ${escapeAttr(ex.name)}">≡</button>
          <strong>${escapeHtml(ex.name)}</strong>
          ${exIdx > 0 ? `<button class="ss-btn ${ex.linkedToPrev ? 'on' : ''}" data-ex="${exIdx}" title="${ex.linkedToPrev ? 'Break the superset' : 'Superset with the exercise above'}">⇄</button>` : ''}
          <button class="icon-btn edit-ex-btn" data-ex="${exIdx}" title="Edit this exercise's name/category/equipment">✎</button>
          <button class="icon-btn remove-exercise-btn" data-ex="${exIdx}" title="remove exercise">🗑</button>
        </div>
        ${ss !== null ? '<div class="ss-tag">Superset</div>' : ''}
        <div class="set-table">
          <div class="set-table-head">${cardio
            ? '<span>Set</span><span>Previous</span><span>Km</span><span>Cal</span><span></span><span></span>'
            : '<span>Set</span><span>Previous</span><span>Weight</span><span>Reps</span><span></span><span></span>'}</div>
          ${rows}
        </div>
        ${!cardio && exIdx === 0 && warmupHintNeeded() ? `<div class="warmup-hint">Tap a set number to make it a warm-up (W). Warm-ups don't count toward volume or records.</div>` : ''}
        <button class="secondary-btn small add-set-row-btn" data-ex="${exIdx}">+ Add set</button>
        <input type="text" class="exercise-note-input" data-ex="${exIdx}"
               placeholder="Add a note for ${escapeAttr(ex.name)}..." value="${escapeAttr(ex.notes || '')}" />
      </div>
    `;
  }).join('');

  bindActiveExerciseEvents();
}

// Reordering by dragging the whole card would fight with scrolling the page,
// so only the grip handle starts a drag. The blocks shuffle under the finger
// as it moves; on release the new DOM order is read back and applied to the
// underlying list. Each block still carries its original index in data-ex,
// which is what makes that read-back possible.
function enableExerciseReorder(container, commitOrder) {
  container.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      const block = handle.closest('.exercise-block');
      if (!block) return;
      event.preventDefault();
      block.classList.add('dragging');

      const onMove = moveEvent => {
        const others = [...container.querySelectorAll('.exercise-block')].filter(b => b !== block);
        const landedBefore = others.find(other => {
          const rect = other.getBoundingClientRect();
          return moveEvent.clientY < rect.top + rect.height / 2;
        });
        if (landedBefore) {
          if (landedBefore !== block.nextElementSibling) container.insertBefore(block, landedBefore);
        } else if (container.lastElementChild !== block) {
          container.appendChild(block);
        }
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        block.classList.remove('dragging');
        const order = [...container.querySelectorAll('.exercise-block')]
          .map(el => Number(el.dataset.ex));
        commitOrder(order);
      };

      // Listeners go on the document rather than the handle: the handle rides
      // inside the block being moved, and moving a node drops any pointer
      // capture on it, which would end the drag after the first swap and lose
      // the drop entirely.
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  });
}

function bindActiveExerciseEvents() {
  const container = document.getElementById('active-exercises');

  container.querySelectorAll('.remove-exercise-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeWorkout.exercises.splice(Number(btn.dataset.ex), 1);
      persistActiveWorkout();
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.ss-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.activeWorkout.exercises[Number(btn.dataset.ex)];
      ex.linkedToPrev = !ex.linkedToPrev;
      persistActiveWorkout();
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.edit-ex-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.ex);
      const full = state.exercises.find(e => e.id === state.activeWorkout.exercises[exIdx].exerciseId);
      if (full) openExerciseEditor(full, { from: 'workout', exIdx });
    });
  });

  container.querySelectorAll('.add-set-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.activeWorkout.exercises[Number(btn.dataset.ex)];
      const lastSet = ex.sets[ex.sets.length - 1];
      if (isCardioExercise(ex.exerciseId)) {
        ex.sets.push({ km: lastSet ? lastSet.km : '', calories: lastSet ? lastSet.calories : '', completed: false });
      } else {
        ex.sets.push({ reps: lastSet ? lastSet.reps : '', weight: lastSet ? lastSet.weight : '', warmup: false, completed: false });
      }
      persistActiveWorkout();
      renderActiveWorkout();
    });
  });

  container.querySelectorAll('.exercise-note-input').forEach(input => {
    input.addEventListener('input', e => {
      state.activeWorkout.exercises[Number(input.dataset.ex)].notes = e.target.value;
      persistActiveWorkout();
    });
  });

  container.querySelectorAll('.set-row-table').forEach(row => {
    const exIdx = Number(row.dataset.ex);
    const setIdx = Number(row.dataset.set);
    const exObj = state.activeWorkout.exercises[exIdx];
    const set = exObj.sets[setIdx];

    if (isCardioExercise(exObj.exerciseId)) {
      selectContentsOnFocus(row.querySelector('.set-km-input'));
      selectContentsOnFocus(row.querySelector('.set-cal-input'));
      row.querySelector('.set-km-input').addEventListener('input', e => {
        set.km = e.target.value;
        persistActiveWorkout();
      });
      row.querySelector('.set-cal-input').addEventListener('input', e => {
        set.calories = e.target.value;
        persistActiveWorkout();
      });
    } else {
      row.querySelector('.set-num').addEventListener('click', () => {
        localStorage.setItem(WARMUP_HINT_KEY, '1');
        set.warmup = !set.warmup;
        persistActiveWorkout();
        renderActiveWorkout();
      });
      selectContentsOnFocus(row.querySelector('.set-weight-input'));
      selectContentsOnFocus(row.querySelector('.set-reps-input'));
      row.querySelector('.set-weight-input').addEventListener('input', e => {
        set.weight = e.target.value;
        persistActiveWorkout();
      });
      row.querySelector('.set-reps-input').addEventListener('input', e => {
        set.reps = e.target.value;
        persistActiveWorkout();
      });
    }
    row.querySelector('.set-check').addEventListener('click', () => {
      set.completed = !set.completed;
      persistActiveWorkout();
      // Ticking a set off is the moment rest starts; unticking is a
      // correction, so it shouldn't kick off a timer.
      if (set.completed) startRest();
      renderActiveWorkout();
    });
    row.querySelector('.set-remove').addEventListener('click', () => {
      state.activeWorkout.exercises[exIdx].sets.splice(setIdx, 1);
      persistActiveWorkout();
      renderActiveWorkout();
    });
  });

  enableExerciseReorder(container, order => {
    if (order.every((from, to) => from === to)) return;   // a tap, not a drag
    const previous = state.activeWorkout.exercises;
    state.activeWorkout.exercises = order.map(from => previous[from]);
    // Nothing sits above the first exercise, so it can never continue a superset.
    if (state.activeWorkout.exercises[0]) state.activeWorkout.exercises[0].linkedToPrev = false;
    persistActiveWorkout();
    renderActiveWorkout();
  });
}

async function finishWorkout() {
  const hasLoggedSet = state.activeWorkout.exercises.some(e =>
    e.sets.some(s => Number(s.reps) > 0 || Number(s.weight) > 0 || Number(s.km) > 0 || Number(s.calories) > 0));
  if (!hasLoggedSet) {
    alert('Log at least one set before finishing.');
    return;
  }
  // Recorded duration excludes paused time, so stepping away mid-workout
  // doesn't inflate it - endedAt - startedAt is the only thing any duration
  // display ever computes, so adjusting it here is enough everywhere.
  const payload = {
    name: state.activeWorkout.name || 'Workout',
    startedAt: state.activeWorkout.startedAt,
    endedAt: Date.now() - totalPausedMs(state.activeWorkout),
    date: todayStr(),
    exercises: state.activeWorkout.exercises,
    notes: state.activeWorkout.notes || ''
  };
  await db.addWorkout(payload);
  // This workout is now the most recent one, so every cached "previous"
  // lookup is stale. Without this, logging a second workout without
  // reloading shows no previous sets for the exercises just trained.
  state.lastCache = {};
  stopRest();
  state.activeWorkout = null;
  persistActiveWorkout();
  renderWorkoutTab();
  switchTab('history');
  showCelebration();
}

// ---------- Finish-workout celebration ----------
async function showCelebration() {
  const workouts = await db.getWorkouts();
  const count = workouts.length;
  document.getElementById('celebrate-sub').textContent = count === 1
    ? "That's your first logged workout - nice start!"
    : `That's ${count.toLocaleString()} workouts logged. Keep it up!`;
  launchConfetti();
  document.getElementById('celebrate-modal').classList.remove('hidden');
}

function launchConfetti() {
  const layer = document.getElementById('confetti-layer');
  const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#f472b6', '#a78bfa'];
  // Fresh nodes each time rather than reusing old ones, since replaying a
  // CSS animation on an existing element needs a reflow trick - a clean
  // element just plays it once, naturally, from the start.
  layer.innerHTML = '';
  for (let i = 0; i < 28; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${(Math.random() * 0.4).toFixed(2)}s`;
    piece.style.animationDuration = `${(1.2 + Math.random() * 0.9).toFixed(2)}s`;
    layer.appendChild(piece);
  }
}

// ---------- Exercise picker ----------
function openPicker(target) {
  state.pickerTarget = target;
  state.pickerSelection = [];
  state.pickerCategoryFilter = '';
  document.getElementById('picker-search').value = '';
  hidePickerNewForm();
  renderPickerCategoryFilters();
  renderPickerList();
  document.getElementById('exercise-picker').classList.remove('hidden');
}

function renderPickerCategoryFilters() {
  const categories = ['', ...new Set(state.exercises.map(e => e.category))];
  const container = document.getElementById('picker-category-filters');
  container.innerHTML = categories.map(c => `
    <button class="chip ${state.pickerCategoryFilter === c ? 'active' : ''}" data-cat="${escapeAttr(c)}">${c ? escapeHtml(c) : 'All'}</button>
  `).join('');
  container.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pickerCategoryFilter = btn.dataset.cat;
      renderPickerCategoryFilters();
      renderPickerList();
    });
  });
}

function closePicker() {
  document.getElementById('exercise-picker').classList.add('hidden');
  hidePickerNewForm();
}

function hidePickerNewForm() {
  document.getElementById('picker-new-form').classList.add('hidden');
  document.getElementById('picker-list').classList.remove('hidden');
  document.getElementById('picker-category-filters').classList.remove('hidden');
  document.getElementById('picker-new-btn').textContent = '+ New exercise';
  renderPickerAddButton();
  document.getElementById('picker-new-name').value = '';
  document.getElementById('picker-new-category').value = '';
  document.getElementById('picker-new-equipment').value = '';
}

function togglePickerNewForm() {
  const form = document.getElementById('picker-new-form');
  if (!form.classList.contains('hidden')) {
    hidePickerNewForm();
    return;
  }
  // Carry whatever was typed in the search box over as the name, since that
  // is usually the exercise the search just failed to find.
  document.getElementById('picker-new-name').value = document.getElementById('picker-search').value.trim();
  document.getElementById('picker-new-save').textContent =
    state.pickerTarget === 'routine' ? 'Create & add to template' : 'Create & add to workout';
  form.classList.remove('hidden');
  // The sheet is only so tall; hide the browse list while creating so the
  // form's save button can't get clipped off the bottom.
  document.getElementById('picker-list').classList.add('hidden');
  document.getElementById('picker-category-filters').classList.add('hidden');
  document.getElementById('picker-actions').classList.add('hidden');
  document.getElementById('picker-new-btn').textContent = 'Cancel';
  document.getElementById('picker-new-name').focus();
}

async function createExerciseFromPicker() {
  const name = document.getElementById('picker-new-name').value.trim();
  if (!name) {
    alert('Give the exercise a name.');
    return;
  }
  // Reuse an existing exercise rather than creating a duplicate, so history
  // for that lift stays on one entry.
  const existing = state.exercises.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    hidePickerNewForm();
    addExerciseToTarget(existing);
    return;
  }
  const exercise = await db.addExercise({
    name,
    category: document.getElementById('picker-new-category').value.trim(),
    equipment: document.getElementById('picker-new-equipment').value.trim()
  });
  state.exercises.push(exercise);
  hidePickerNewForm();
  addExerciseToTarget(exercise);
}

function renderPickerList() {
  const query = document.getElementById('picker-search').value.trim().toLowerCase();
  const matches = state.exercises.filter(e =>
    e.name.toLowerCase().includes(query) &&
    (!state.pickerCategoryFilter || e.category === state.pickerCategoryFilter)
  );
  const container = document.getElementById('picker-list');

  const exactMatch = state.exercises.some(e => e.name.toLowerCase() === query);
  const createRow = query && !exactMatch
    ? `<button class="entry entry-clickable" id="picker-create-btn">+ Create "${escapeHtml(query)}" and add it</button>`
    : '';

  container.innerHTML = createRow + matches.map(e => {
    const picked = state.pickerSelection.includes(e.id);
    return `
    <button class="entry entry-clickable picker-item ${picked ? 'picked' : ''}" data-id="${e.id}">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(e.name)}</div>
        <div class="entry-sub">${escapeHtml(e.category)} · ${escapeHtml(e.equipment)}</div>
      </div>
      <span class="pick-mark">${picked ? '✓' : ''}</span>
    </button>
  `;
  }).join('');

  container.querySelectorAll('.picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('picker-search').blur();
      const id = btn.dataset.id;
      const at = state.pickerSelection.indexOf(id);
      if (at === -1) state.pickerSelection.push(id);
      else state.pickerSelection.splice(at, 1);
      renderPickerList();
    });
  });
  renderPickerAddButton();
  const createBtn = document.getElementById('picker-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const exercise = await db.addExercise({ name: document.getElementById('picker-search').value.trim() });
      state.exercises.push(exercise);
      addExerciseToTarget(exercise);
    });
  }
}

function renderPickerAddButton() {
  const count = state.pickerSelection.length;
  const addBtn = document.getElementById('picker-add-btn');
  // The row stays on screen even with nothing selected: hiding it entirely
  // left no visible way to finish adding, which reads as the option missing.
  document.getElementById('picker-actions').classList.remove('hidden');
  addBtn.disabled = count === 0;
  addBtn.textContent = count === 0
    ? 'Tap exercises to add'
    : (count === 1 ? 'Add 1 exercise' : `Add ${count} exercises`);
  // Supersetting needs at least two exercises to link together.
  document.getElementById('picker-superset-btn').classList.toggle('hidden', count < 2);
}

function pickerTargetList() {
  return state.pickerTarget === 'routine'
    ? state.routineEditing.exercises
    : state.activeWorkout.exercises;
}

async function addPickedExercises(asSuperset) {
  // Added in the order they were ticked, so the workout reads the way it was
  // built up rather than in library order.
  const picked = state.pickerSelection
    .map(id => state.exercises.find(e => e.id === id))
    .filter(Boolean);
  const startedAt = pickerTargetList().length;
  for (const exercise of picked) {
    await addExerciseToTarget(exercise, { keepOpen: true });
  }

  if (asSuperset) {
    // Link the batch that was actually appended. Anything already in the
    // workout is skipped as a duplicate, so this counts what landed rather
    // than what was ticked.
    const list = pickerTargetList();
    if (list[startedAt]) list[startedAt].linkedToPrev = false;
    for (let i = startedAt + 1; i < list.length; i++) list[i].linkedToPrev = true;
    if (state.pickerTarget === 'routine') {
      renderRoutineEditor();
    } else {
      persistActiveWorkout();
      renderActiveWorkout();
    }
  }

  state.pickerSelection = [];
  closePicker();
}

async function addExerciseToTarget(exercise, opts) {
  const keepOpen = opts && opts.keepOpen;
  if (state.pickerTarget === 'workout') {
    if (state.activeWorkout.exercises.some(e => e.exerciseId === exercise.id)) {
      if (!keepOpen) closePicker();
      return;
    }
    await warmLastCache(exercise.id);
    const last = state.lastCache[exercise.id];
    const initialSet = exercise.isCardio
      ? { km: last ? last.sets[0].km : '', calories: last ? last.sets[0].calories : '', completed: false }
      : { reps: last ? last.sets[0].reps : '', weight: last ? last.sets[0].weight : '', warmup: false, completed: false };
    state.activeWorkout.exercises.push({
      exerciseId: exercise.id,
      name: exercise.name,
      // Carries over whatever was jotted down last time (machine settings,
      // grip width, cues) so it doesn't have to be retyped every session.
      notes: last && last.notes ? last.notes : '',
      sets: [initialSet]
    });
    persistActiveWorkout();
    renderActiveWorkout();
  } else if (state.pickerTarget === 'routine') {
    state.routineEditing.exercises.push({
      exerciseId: exercise.id,
      name: exercise.name,
      sets: exercise.isCardio ? [{ km: 0, calories: 0 }] : [{ reps: 8, weight: 0 }, { reps: 8, weight: 0 }, { reps: 8, weight: 0 }]
    });
    renderRoutineEditor();
  }
  if (!keepOpen) closePicker();
}

// ---------- History tab ----------
async function loadHistory() {
  const workouts = await db.getWorkouts();
  const container = document.getElementById('history-list');
  if (workouts.length === 0) {
    container.innerHTML = `<div class="empty-state">No workouts logged yet. Finish one to see it here.</div>`;
    return;
  }
  container.innerHTML = workouts.map(w => `
    <div class="entry entry-clickable history-item" data-id="${w.id}">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(w.name)}</div>
        <div class="entry-sub">${w.date} · ${formatDuration(w.endedAt - w.startedAt)} · ${w.exercises.length} exercises · vol ${Math.round(workoutVolume(w)).toLocaleString()}</div>
      </div>
      <button class="icon-btn del-btn" data-id="${w.id}" title="delete">🗑</button>
    </div>
  `).join('');

  container.querySelectorAll('.history-item').forEach(btn => {
    btn.addEventListener('click', e => {
      if (e.target.closest('.del-btn')) return;
      openWorkoutDetail(workouts.find(w => w.id === btn.dataset.id));
    });
  });
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete this workout?')) return;
      await db.deleteWorkout(btn.dataset.id);
      state.lastCache = {};
      loadHistory();
    });
  });
}

function openWorkoutDetail(workout) {
  const detailGroups = computeSupersets(workout.exercises);
  document.getElementById('detail-title').textContent = workout.name;
  document.getElementById('edit-exercise-btn').classList.add('hidden');
  const shareBtn = document.getElementById('share-detail-btn');
  shareBtn.classList.remove('hidden');
  shareBtn.onclick = () => shareWorkout(workout);
  document.getElementById('detail-body').innerHTML = `
    <div class="entry-sub" style="margin-bottom:12px;">${workout.date} · ${formatDuration(workout.endedAt - workout.startedAt)} · vol ${Math.round(workoutVolume(workout)).toLocaleString()}</div>
    ${workout.exercises.map((e, i) => `
      <div class="exercise-block ${detailGroups[i] !== null ? 'in-superset' : ''}" data-ss="${detailGroups[i] === null ? '' : detailGroups[i] % 4}">
        ${detailGroups[i] !== null ? '<div class="ss-tag">Superset</div>' : ''}
        <div class="exercise-block-header"><strong>${escapeHtml(e.name)}</strong></div>
        <div class="entry-sub">${formatSets(e.sets, isCardioExercise(e.exerciseId))}</div>
        ${e.notes ? `<div class="entry-sub exercise-note">“${escapeHtml(e.notes)}”</div>` : ''}
      </div>
    `).join('')}
    ${workout.notes ? `<div class="entry-sub" style="margin-top:10px;"><strong>Notes:</strong> ${escapeHtml(workout.notes)}</div>` : ''}
    <button id="save-as-template-btn" class="secondary-btn full">Save this workout as a template</button>
  `;
  document.getElementById('save-as-template-btn')
    .addEventListener('click', () => saveWorkoutAsTemplate(workout));
  document.getElementById('detail-modal').classList.remove('hidden');
}

async function saveWorkoutAsTemplate(workout) {
  const name = prompt('Name this template:', workout.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    alert('Give this template a name.');
    return;
  }
  // Warm-ups are specific to the day rather than part of the plan, so the
  // template keeps the working sets. Cardio has no warm-up concept, so every
  // logged set carries over as-is.
  const exercises = workout.exercises
    .map(e => {
      const cardio = isCardioExercise(e.exerciseId);
      return {
        exerciseId: e.exerciseId,
        name: e.name,
        linkedToPrev: !!e.linkedToPrev,
        sets: cardio
          ? e.sets.map(s => ({ km: s.km || 0, calories: s.calories || 0 }))
          : e.sets.filter(s => !s.warmup).map(s => ({ reps: s.reps, weight: s.weight }))
      };
    })
    .filter(e => e.sets.length > 0);
  if (exercises.length === 0) {
    alert('This workout has no working sets to save.');
    return;
  }
  await db.addRoutine({ name: trimmed, exercises });
  closeDetail();
  alert(`Saved "${trimmed}" as a template. You'll find it on the Workout tab.`);
  loadRoutines();
}

function closeDetail() {
  document.getElementById('detail-modal').classList.add('hidden');
  document.getElementById('share-detail-btn').classList.add('hidden');
  document.getElementById('edit-exercise-btn').classList.add('hidden');
}

function openExerciseEditor(exercise, context) {
  // Where this was opened from decides what saving should update afterward:
  // the Exercises tab just edits the library entry, but opening it from the
  // exercise's row in an in-progress workout or template needs that specific
  // slot re-pointed at the result too, not just the library.
  state.exerciseEditContext = context || { from: 'detail' };
  document.getElementById('edit-exercise-name').value = exercise.name;
  document.getElementById('edit-exercise-category').value = exercise.category || '';
  document.getElementById('edit-exercise-equipment').value = exercise.equipment || '';
  document.getElementById('edit-exercise-modal').dataset.id = exercise.id;
  document.getElementById('edit-exercise-modal').classList.remove('hidden');
}

function closeExerciseEditor() {
  document.getElementById('edit-exercise-modal').classList.add('hidden');
}

// Renaming refreshes every slot referencing this exercise, since it may
// appear more than once (e.g. across a superset).
function refreshExerciseNameEverywhere(exerciseId, name) {
  if (state.activeWorkout) {
    let changed = false;
    state.activeWorkout.exercises.forEach(e => {
      if (e.exerciseId === exerciseId) { e.name = name; changed = true; }
    });
    if (changed) persistActiveWorkout();
  }
  if (state.routineEditing) {
    state.routineEditing.exercises.forEach(e => { if (e.exerciseId === exerciseId) e.name = name; });
  }
}

// Splitting into a separate exercise should only repoint the one slot that
// was actually being edited at that new exercise, not every occurrence of
// the old one elsewhere in the same workout.
function repointEditedSlot(context, newExercise) {
  if (context.from === 'workout' && state.activeWorkout) {
    const slot = state.activeWorkout.exercises[context.exIdx];
    if (slot) {
      slot.exerciseId = newExercise.id;
      slot.name = newExercise.name;
      persistActiveWorkout();
    }
  } else if (context.from === 'routine' && state.routineEditing) {
    const slot = state.routineEditing.exercises[context.exIdx];
    if (slot) {
      slot.exerciseId = newExercise.id;
      slot.name = newExercise.name;
    }
  }
}

function rerenderEditContext(context) {
  if (context.from === 'workout') renderActiveWorkout();
  else if (context.from === 'routine') renderRoutineEditor();
  else if (context.from === 'detail') closeDetail();
}

async function saveExerciseEdit() {
  const modal = document.getElementById('edit-exercise-modal');
  const id = modal.dataset.id;
  const original = state.exercises.find(e => e.id === id);
  if (!original) return;

  const name = document.getElementById('edit-exercise-name').value.trim();
  if (!name) {
    alert('Give the exercise a name.');
    return;
  }
  const category = document.getElementById('edit-exercise-category').value.trim();
  const equipment = document.getElementById('edit-exercise-equipment').value.trim();

  // Changing the equipment on a lift you already have history for mixes
  // weights that aren't comparable: a machine incline press and a dumbbell one
  // are different lifts. Offer to split rather than silently blending them.
  const equipmentChanged = equipment !== (original.equipment || '');
  const sessions = await db.countSessions(id);
  if (equipmentChanged && sessions > 0) {
    const separate = confirm(
      `"${original.name}" has ${sessions} logged session${sessions !== 1 ? 's' : ''} on ${original.equipment}.\n\n` +
      'You lift different weights on different equipment, so mixing them in one history makes the numbers and records meaningless.\n\n' +
      'OK: keep those sessions on the old one and add this as a separate exercise.\n' +
      'Cancel: change this exercise anyway, keeping all history together.'
    );
    if (separate) {
      // Two exercises with the same name are indistinguishable in a workout,
      // where only the name is shown, so qualify the new one by its equipment.
      const clashes = state.exercises.some(e => e.name.toLowerCase() === name.toLowerCase());
      const newName = clashes && equipment ? `${name} (${equipment})` : name;
      const created = await db.addExercise({ name: newName, category, equipment });
      state.exercises.push(created);
      repointEditedSlot(state.exerciseEditContext, created);
      closeExerciseEditor();
      rerenderEditContext(state.exerciseEditContext);
      renderLibraryTab();
      alert(`Added "${newName}" as a separate exercise, tracked on its own.\n\n"${original.name}" keeps its ${sessions} session${sessions !== 1 ? 's' : ''}.`);
      return;
    }
  }

  const updated = await db.updateExercise(id, { name, category, equipment });
  Object.assign(original, updated);
  refreshExerciseNameEverywhere(id, updated.name);
  state.lastCache = {};
  closeExerciseEditor();
  rerenderEditContext(state.exerciseEditContext);
  renderLibraryTab();
}

// ---------- Exercises tab (library) ----------
function renderLibraryTab() {
  renderCategoryFilters();
  renderLibraryList();
}

function renderCategoryFilters() {
  const categories = ['', ...new Set(state.exercises.map(e => e.category))];
  const container = document.getElementById('category-filters');
  container.innerHTML = categories.map(c => `
    <button class="chip ${state.categoryFilter === c ? 'active' : ''}" data-cat="${escapeAttr(c)}">${c ? escapeHtml(c) : 'All'}</button>
  `).join('');
  container.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      state.categoryFilter = btn.dataset.cat;
      renderCategoryFilters();
      renderLibraryList();
    });
  });
}

function renderLibraryList() {
  const query = document.getElementById('exercise-search').value.trim().toLowerCase();
  const matches = state.exercises.filter(e =>
    e.name.toLowerCase().includes(query) &&
    (!state.categoryFilter || e.category === state.categoryFilter)
  );
  const container = document.getElementById('exercises-library-list');
  if (matches.length === 0) {
    container.innerHTML = `<div class="empty-state">No exercises found.</div>`;
    return;
  }
  container.innerHTML = matches.map(e => `
    <button class="entry entry-clickable lib-item" data-id="${e.id}">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(e.name)}</div>
        <div class="entry-sub">${escapeHtml(e.category)} · ${escapeHtml(e.equipment)}</div>
      </div>
    </button>
  `).join('');
  container.querySelectorAll('.lib-item').forEach(btn => {
    btn.addEventListener('click', () => openExerciseDetail(state.exercises.find(e => e.id === btn.dataset.id)));
  });
}

async function createExerciseFromLibrary() {
  const name = document.getElementById('new-exercise-name').value.trim();
  if (!name) return;
  const category = document.getElementById('new-exercise-category').value.trim();
  const equipment = document.getElementById('new-exercise-equipment').value.trim();
  const exercise = await db.addExercise({ name, category, equipment });
  state.exercises.push(exercise);
  document.getElementById('new-exercise-name').value = '';
  document.getElementById('new-exercise-category').value = '';
  document.getElementById('new-exercise-equipment').value = '';
  document.getElementById('new-exercise-form').classList.add('hidden');
  renderLibraryTab();
}

async function openExerciseDetail(exercise) {
  const sessions = await db.getExerciseHistory(exercise.id);
  document.getElementById('detail-title').textContent = exercise.name;
  document.getElementById('share-detail-btn').classList.add('hidden');
  const editBtn = document.getElementById('edit-exercise-btn');
  editBtn.classList.remove('hidden');
  editBtn.onclick = () => openExerciseEditor(exercise);

  if (exercise.isCardio) {
    renderCardioExerciseDetail(exercise, sessions);
    return;
  }

  let bestWeight = 0, bestE1rm = 0;
  sessions.forEach(s => s.sets.forEach(set => {
    if (set.warmup) return;
    if (set.weight > bestWeight) bestWeight = set.weight;
    bestE1rm = Math.max(bestE1rm, e1rm(set.reps, set.weight));
  }));

  const historyHtml = sessions.length
    ? sessions.map(s => `
        <div class="entry">
          <div class="entry-main">
            <div class="entry-title">${s.date}</div>
            <div class="entry-sub">${formatSets(s.sets)}</div>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state">No sessions logged for this exercise yet.</div>`;

  document.getElementById('detail-body').innerHTML = `
    <div class="entry-sub" style="margin-bottom:12px;">${escapeHtml(exercise.category)} · ${escapeHtml(exercise.equipment)}</div>
    <div class="pr-grid single">
      <div class="pr-cell">
        <div class="pr-row"><span>Best set</span><strong>${bestWeight ? bestWeight + 'kg' : '—'}</strong></div>
        <div class="pr-row"><span>Est. 1RM</span><strong>${bestE1rm ? Math.round(bestE1rm) + 'kg' : '—'}</strong></div>
        <div class="pr-row"><span>Sessions</span><strong>${sessions.length}</strong></div>
      </div>
    </div>
    <canvas id="exercise-chart" height="160"></canvas>
    <h3 class="subheading">History</h3>
    <div class="list">${historyHtml}</div>
  `;
  document.getElementById('detail-modal').classList.remove('hidden');
  drawExerciseChart(sessions);
}

// Cardio has no weight/reps or 1RM to speak of - distance and calories are
// the real-world numbers that matter, so its detail view and chart swap in
// those instead of reusing the strength PR layout.
function renderCardioExerciseDetail(exercise, sessions) {
  let bestKm = 0, totalKm = 0, totalCalories = 0;
  sessions.forEach(s => s.sets.forEach(set => {
    const km = Number(set.km) || 0;
    const calories = Number(set.calories) || 0;
    totalKm += km;
    totalCalories += calories;
    if (km > bestKm) bestKm = km;
  }));

  const historyHtml = sessions.length
    ? sessions.map(s => `
        <div class="entry">
          <div class="entry-main">
            <div class="entry-title">${s.date}</div>
            <div class="entry-sub">${formatSets(s.sets, true)}</div>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state">No sessions logged for this exercise yet.</div>`;

  document.getElementById('detail-body').innerHTML = `
    <div class="entry-sub" style="margin-bottom:12px;">${escapeHtml(exercise.category)} · ${escapeHtml(exercise.equipment)}</div>
    <div class="pr-grid single">
      <div class="pr-cell">
        <div class="pr-row"><span>Longest session</span><strong>${bestKm ? bestKm + 'km' : '—'}</strong></div>
        <div class="pr-row"><span>Total distance</span><strong>${totalKm ? `${Math.round(totalKm * 10) / 10}km` : '—'}</strong></div>
        <div class="pr-row"><span>Total calories</span><strong>${totalCalories ? Math.round(totalCalories).toLocaleString() : '—'}</strong></div>
        <div class="pr-row"><span>Sessions</span><strong>${sessions.length}</strong></div>
      </div>
    </div>
    <canvas id="exercise-chart" height="160"></canvas>
    <h3 class="subheading">History</h3>
    <div class="list">${historyHtml}</div>
  `;
  document.getElementById('detail-modal').classList.remove('hidden');
  drawExerciseChart(sessions, {
    label: 'km',
    valueFn: s => s.sets.reduce((sum, set) => sum + (Number(set.km) || 0), 0)
  });
}

function drawExerciseChart(sessions, opts) {
  const canvas = document.getElementById('exercise-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = 160;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const label = (opts && opts.label) || 'est 1RM';
  const valueFn = (opts && opts.valueFn) || (s => Math.max(0, ...s.sets.filter(set => !set.warmup).map(set => e1rm(set.reps, set.weight))));
  const points = [...sessions].reverse().map(s => ({
    date: s.date,
    value: valueFn(s)
  }));
  if (points.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('No data yet', 10, height / 2);
    return;
  }

  const maxVal = Math.max(1, ...points.map(p => p.value));
  const padding = { left: 40, right: 10, top: 10, bottom: 20 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;

  ctx.strokeStyle = '#334155';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = padding.left + i * step;
    const y = height - padding.bottom - (p.value / maxVal) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  points.forEach((p, i) => {
    const x = padding.left + i * step;
    const y = height - padding.bottom - (p.value / maxVal) * plotH;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  ctx.fillText(`${label} ${Math.round(points[0].value)}`, padding.left - 6, 10);
  if (points.length > 1) {
    ctx.fillText(points[0].date.slice(5), padding.left - 10, height - 4);
    ctx.fillText(points[points.length - 1].date.slice(5), width - padding.right - 30, height - 4);
  }
}

// ---------- Analytics tab ----------
function daysAgo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function weekVolumeStats(workouts) {
  let thisWeek = 0, lastWeek = 0, thisWeekCount = 0, sessionsLast28 = 0;
  workouts.forEach(w => {
    const age = daysAgo(w.date);
    if (age < 7) { thisWeek += workoutVolume(w); thisWeekCount++; }
    else if (age < 14) { lastWeek += workoutVolume(w); }
    if (age < 28) sessionsLast28++;
  });
  const volumeChangePct = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  const avgPerWeek = Math.round((sessionsLast28 / 4) * 10) / 10;
  return { thisWeek, lastWeek, volumeChangePct, thisWeekCount, avgPerWeek };
}

// Buckets workouts into calendar weeks, oldest first, ending with the
// current week - the shape both graphs on the Stats tab plot directly.
function weeklyBuckets(workouts, weeks) {
  const buckets = Array.from({ length: weeks }, () => ({ volume: 0, count: 0 }));
  workouts.forEach(w => {
    const weekIndex = Math.floor(daysAgo(w.date) / 7);
    if (weekIndex >= 0 && weekIndex < weeks) {
      const bucket = buckets[weeks - 1 - weekIndex];
      bucket.volume += workoutVolume(w);
      bucket.count += 1;
    }
  });
  return buckets;
}

// A small bar chart shared by the volume and frequency graphs - only the
// values and a couple of display options differ between them.
function drawBarChart(canvasId, values, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 150;
  const height = 110;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const color = (opts && opts.color) || '#22c55e';
  const fmt = (opts && opts.fmt) || (v => `${Math.round(v)}`);
  const maxVal = Math.max(1, ...values);
  const padding = { left: 4, right: 4, top: 16, bottom: 16 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const gap = 4;
  const barW = Math.max(1, (plotW - gap * (values.length - 1)) / values.length);

  values.forEach((v, i) => {
    const barH = (v / maxVal) * plotH;
    const x = padding.left + i * (barW + gap);
    const y = height - padding.bottom - barH;
    ctx.fillStyle = i === values.length - 1 ? color : `${color}80`;
    ctx.fillRect(x, y, barW, v > 0 ? Math.max(barH, 2) : 0);
  });

  ctx.strokeStyle = '#334155';
  ctx.beginPath();
  ctx.moveTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px sans-serif';
  const last = values[values.length - 1];
  ctx.textAlign = 'center';
  ctx.fillText(fmt(last), width - padding.right - barW / 2, padding.top - 5);
  ctx.textAlign = 'left';
  ctx.fillText(`${values.length}w ago`, padding.left, height - 4);
  ctx.textAlign = 'right';
  ctx.fillText('This wk', width - padding.right, height - 4);
}

// Reduces a history of sessions (oldest first) down to one "best" value per
// session. For strength that's the set with the highest estimated 1RM,
// ignoring warm-ups the same way every other record in the app does; for
// cardio there's no 1RM to speak of, so it's the day's total distance and
// calories instead.
function exerciseSessionSummaries(sessions, isCardio) {
  if (isCardio) {
    return sessions.map(s => {
      let km = 0, calories = 0;
      s.sets.forEach(set => {
        km += Number(set.km) || 0;
        calories += Number(set.calories) || 0;
      });
      return (km > 0 || calories > 0) ? { date: s.date, best: { km, calories } } : null;
    }).filter(Boolean);
  }
  return sessions.map(s => {
    let best = null;
    let volume = 0;
    s.sets.forEach(set => {
      if (set.warmup) return;
      volume += set.reps * set.weight;
      const val = e1rm(set.reps, set.weight);
      if (!best || val > best.e1rm) best = { weight: set.weight, reps: set.reps, e1rm: val };
    });
    return best ? { date: s.date, best, volume } : null;
  }).filter(Boolean);
}

// A common progressive-overload rule of thumb: once a working set clears a
// rep ceiling it's time to add weight; a stall or drop at the same weight
// calls for repeating it rather than pushing further.
const REP_CEILING = 12;

function recommendProgression(summaries, isCardio) {
  if (summaries.length === 0) return { text: 'No sessions logged yet.', tag: 'none' };
  const last = summaries[summaries.length - 1];

  if (isCardio) {
    if (summaries.length === 1) {
      return { text: `First session logged: ${last.best.km}km${last.best.calories ? ` · ${last.best.calories} cal` : ''}. Log another to see a trend.`, tag: 'none' };
    }
    const prevCardio = summaries[summaries.length - 2];
    if (last.best.km > prevCardio.best.km) {
      return { text: `Distance up from ${prevCardio.best.km}km to ${last.best.km}km - solid endurance progress. Build up gradually (~10% a week is a safe ceiling).`, tag: 'up' };
    }
    if (last.best.km < prevCardio.best.km) {
      return { text: `Distance dropped from ${prevCardio.best.km}km to ${last.best.km}km - fine as a lighter/recovery session, otherwise work back up to ${prevCardio.best.km}km.`, tag: 'down' };
    }
    return { text: `Holding steady at ${last.best.km}km - try to shave time or add distance next session.`, tag: 'flat' };
  }

  if (summaries.length === 1) {
    return { text: `One session in so far at ${last.best.weight}kg × ${last.best.reps}. Log it again to unlock a progression tip.`, tag: 'none' };
  }
  const prev = summaries[summaries.length - 2];

  // Bodyweight moves (no added weight) progress on reps alone, so they get
  // their own read rather than reporting "0kg to 0kg, hold here".
  if (last.best.weight === 0 && prev.best.weight === 0) {
    if (last.best.reps > prev.best.reps) {
      return { text: `Bodyweight reps up from ${prev.best.reps} to ${last.best.reps} - keep pushing, or add weight once you clear ${REP_CEILING}.`, tag: 'up' };
    }
    if (last.best.reps < prev.best.reps) {
      return { text: `Reps dipped from ${prev.best.reps} to ${last.best.reps} - repeat this rep count before pushing further.`, tag: 'down' };
    }
    if (last.best.reps >= REP_CEILING) {
      return { text: `Consistently hitting ${last.best.reps}+ reps - add external weight (vest or plate) to keep progressing.`, tag: 'up' };
    }
    return { text: `Holding at ${last.best.reps} reps - aim for one more next time.`, tag: 'flat' };
  }

  if (last.best.weight > prev.best.weight) {
    return { text: `Just moved up to ${last.best.weight}kg from ${prev.best.weight}kg. Hold here and build reps back up before jumping again.`, tag: 'hold' };
  }
  if (last.best.weight < prev.best.weight) {
    return { text: `Weight dropped to ${last.best.weight}kg from ${prev.best.weight}kg. Treat this as a deload - work back up once it feels solid.`, tag: 'down' };
  }
  // Same weight as last time.
  if (last.best.reps >= REP_CEILING) {
    const bump = Math.max(1, Math.round(last.best.weight * 0.025 * 2) / 2);
    return { text: `Hit ${last.best.reps} reps at ${last.best.weight}kg - add ${bump}kg next session and reset toward 8 reps.`, tag: 'up' };
  }
  if (last.best.reps > prev.best.reps) {
    return { text: `Same ${last.best.weight}kg, reps up from ${prev.best.reps} to ${last.best.reps}. Keep adding reps until ${REP_CEILING}, then increase weight.`, tag: 'up' };
  }
  if (last.best.reps < prev.best.reps) {
    return { text: `Reps dipped at ${last.best.weight}kg (${prev.best.reps} to ${last.best.reps}) - repeat this weight before pushing further.`, tag: 'down' };
  }
  return { text: `Holding steady at ${last.best.weight}kg × ${last.best.reps} - aim for one more rep next time.`, tag: 'flat' };
}

async function buildExerciseAnalytics() {
  const rows = [];
  for (const exercise of state.exercises) {
    const historyDesc = await db.getExerciseHistory(exercise.id);
    if (historyDesc.length === 0) continue;
    const summaries = exerciseSessionSummaries([...historyDesc].reverse(), exercise.isCardio);
    if (summaries.length === 0) continue;
    const last = summaries[summaries.length - 1];
    const prev = summaries.length > 1 ? summaries[summaries.length - 2] : null;
    let changePct = null;
    if (prev) {
      if (exercise.isCardio) {
        if (prev.best.km > 0) changePct = Math.round(((last.best.km - prev.best.km) / prev.best.km) * 100);
      } else if (prev.best.e1rm > 0) {
        changePct = Math.round(((last.best.e1rm - prev.best.e1rm) / prev.best.e1rm) * 100);
      } else if (prev.best.reps > 0) {
        // Bodyweight lift (no weight to base an e1RM on) - fall back to reps.
        changePct = Math.round(((last.best.reps - prev.best.reps) / prev.best.reps) * 100);
      }
    }
    rows.push({ exercise, summaries, last, changePct, recommendation: recommendProgression(summaries, exercise.isCardio) });
  }
  return rows;
}

function trendBadge(changePct) {
  if (changePct === null) return '<span class="trend-badge flat">New</span>';
  if (changePct > 0) return `<span class="trend-badge up">▲ ${changePct}%</span>`;
  if (changePct < 0) return `<span class="trend-badge down">▼ ${Math.abs(changePct)}%</span>`;
  return '<span class="trend-badge flat">— 0%</span>';
}

// ---------- Strength standards ("how you compare") ----------
// Rough, widely-cited strength-standard ratios (estimated 1RM as a multiple
// of bodyweight) for the four classic barbell lifts, by sex. These are a
// common simplified population benchmark - not a personalized or perfectly
// precise measurement, since real standards also shift a bit with
// bodyweight itself - but they're a solid "what should I aim for" guide.
const STRENGTH_STANDARDS = {
  'Squat': {
    male: [0.75, 1.25, 1.5, 1.75, 2.25],
    female: [0.5, 0.75, 1.0, 1.5, 1.75]
  },
  'Bench Press': {
    male: [0.5, 0.75, 1.0, 1.25, 1.75],
    female: [0.27, 0.5, 0.65, 0.8, 1.1]
  },
  'Deadlift': {
    male: [1.0, 1.5, 1.75, 2.25, 2.75],
    female: [0.65, 1.0, 1.25, 1.75, 2.15]
  },
  'Overhead Press': {
    male: [0.35, 0.55, 0.75, 0.9, 1.2],
    female: [0.2, 0.35, 0.5, 0.6, 0.8]
  }
};
const STRENGTH_LEVELS = ['Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite'];

function strengthStanding(liftName, bestE1rm, bodyweightKg, sex) {
  const table = STRENGTH_STANDARDS[liftName];
  if (!table || !bodyweightKg || !sex || !table[sex]) return null;
  const ratios = table[sex];
  const ratio = bestE1rm / bodyweightKg;
  let levelIdx = -1;
  ratios.forEach((r, i) => { if (ratio >= r) levelIdx = i; });
  const level = levelIdx === -1 ? 'Below beginner' : STRENGTH_LEVELS[levelIdx];
  const nextIdx = levelIdx + 1;
  const hasNext = nextIdx < ratios.length;
  return {
    ratio,
    level,
    bestE1rm,
    nextLevel: hasNext ? STRENGTH_LEVELS[nextIdx] : null,
    nextTargetKg: hasNext ? Math.round(ratios[nextIdx] * bodyweightKg) : null
  };
}

function levelBadgeClass(level) {
  return level.toLowerCase().replace(/\s+/g, '-');
}

function standardsRowHtml(liftName, standing) {
  const pct = standing.nextTargetKg
    ? Math.max(4, Math.min(100, Math.round((standing.bestE1rm / standing.nextTargetKg) * 100)))
    : 100;
  const tip = standing.nextTargetKg
    ? `Est. 1RM ${Math.round(standing.bestE1rm)}kg now - reach about ${standing.nextTargetKg}kg to hit ${standing.nextLevel}.`
    : `You're at the top tracked tier (Elite) for this lift - keep pushing your own numbers.`;
  return `
    <div class="entry standards-row">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(liftName)} <span class="level-badge ${levelBadgeClass(standing.level)}">${standing.level}</span></div>
        <div class="entry-sub">${standing.ratio.toFixed(2)}× bodyweight</div>
        <div class="standards-track"><div class="standards-fill" style="width:${pct}%"></div></div>
        <div class="analytics-tip">${tip}</div>
      </div>
    </div>
  `;
}

async function renderStrengthStandards() {
  const profile = await db.getProfile();
  if (!profile.bodyweightKg || !profile.sex) {
    return `
      <h3 class="subheading">How you compare</h3>
      <div class="card">
        <p class="hint-text" style="margin:0 0 12px;">Set your bodyweight and sex in Settings to see how your lifts stack up against published strength standards, and what to aim for next.</p>
        <button id="standards-open-settings-btn" class="secondary-btn full">Set bodyweight</button>
      </div>
    `;
  }

  const rows = [];
  for (const liftName of Object.keys(STRENGTH_STANDARDS)) {
    const exercise = state.exercises.find(e => e.name === liftName);
    if (!exercise) continue;
    const sessions = await db.getExerciseHistory(exercise.id);
    let bestE1rm = 0;
    sessions.forEach(s => s.sets.forEach(set => {
      if (set.warmup) return;
      bestE1rm = Math.max(bestE1rm, e1rm(set.reps, set.weight));
    }));
    if (bestE1rm === 0) continue;
    const standing = strengthStanding(liftName, bestE1rm, profile.bodyweightKg, profile.sex);
    if (standing) rows.push(standardsRowHtml(liftName, standing));
  }

  if (rows.length === 0) {
    return `
      <h3 class="subheading">How you compare</h3>
      <div class="empty-state">Log a Squat, Bench Press, Deadlift, or Overhead Press to see how you compare.</div>
    `;
  }

  return `
    <h3 class="subheading">How you compare</h3>
    <div class="list">${rows.join('')}</div>
  `;
}

function analyticsRowHtml(row) {
  const sub = row.exercise.isCardio
    ? `Last: ${row.last.best.km}km${row.last.best.calories ? ` · ${row.last.best.calories} cal` : ''}`
    : `Last: ${row.last.best.weight}kg × ${row.last.best.reps} · est. 1RM ${Math.round(row.last.best.e1rm)}kg`;
  return `
    <button class="entry entry-clickable analytics-row" data-id="${row.exercise.id}">
      <div class="entry-main">
        <div class="entry-title">${escapeHtml(row.exercise.name)} ${trendBadge(row.changePct)}</div>
        <div class="entry-sub">${sub}</div>
        <div class="analytics-tip">${escapeHtml(row.recommendation.text)}</div>
      </div>
    </button>
  `;
}

function bindAnalyticsRows(container, rows) {
  container.querySelectorAll('.analytics-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => r.exercise.id === btn.dataset.id);
      if (row) openExerciseDetail(row.exercise);
    });
  });
}

async function renderAnalyticsTab() {
  const container = document.getElementById('analytics-body');
  const workouts = await db.getWorkouts();
  if (workouts.length === 0) {
    container.innerHTML = `<div class="empty-state">Finish a few workouts to see trends, progression tips, and your best lifts here.</div>`;
    return;
  }

  const stats = weekVolumeStats(workouts);
  const buckets = weeklyBuckets(workouts, 8);
  const standardsHtml = await renderStrengthStandards();
  const rows = await buildExerciseAnalytics();
  // Sorting once and slicing both ends keeps "best" and "needs attention"
  // consistent with each other instead of computed by separate passes.
  const ranked = rows.filter(r => r.changePct !== null).sort((a, b) => b.changePct - a.changePct);
  const best = ranked.filter(r => r.changePct > 0).slice(0, 3);
  const needsWork = ranked.filter(r => r.changePct <= 0).slice(-3).reverse();
  const newLifts = rows.filter(r => r.changePct === null);

  container.innerHTML = `
    <h3 class="subheading">This week</h3>
    <div class="pr-grid">
      <div class="pr-cell">
        <div class="pr-row"><span>Volume</span><strong>${Math.round(stats.thisWeek).toLocaleString()}kg</strong></div>
        <div class="pr-row"><span>vs last week</span><strong>${stats.volumeChangePct === null ? '—' : `${stats.volumeChangePct > 0 ? '+' : ''}${stats.volumeChangePct}%`}</strong></div>
      </div>
      <div class="pr-cell">
        <div class="pr-row"><span>Workouts</span><strong>${stats.thisWeekCount}</strong></div>
        <div class="pr-row"><span>Avg/week (4wk)</span><strong>${stats.avgPerWeek}</strong></div>
      </div>
    </div>

    <div class="chart-row">
      <div class="chart-col">
        <div class="subheading">Volume · 8 weeks</div>
        <canvas id="volume-chart" height="110"></canvas>
      </div>
      <div class="chart-col">
        <div class="subheading">Workouts · 8 weeks</div>
        <canvas id="frequency-chart" height="110"></canvas>
      </div>
    </div>

    ${standardsHtml}

    <h3 class="subheading">Best progress</h3>
    <div class="list">${best.length ? best.map(analyticsRowHtml).join('') : '<div class="empty-state">Log a couple more sessions on a lift to see it climb here.</div>'}</div>

    <h3 class="subheading">Needs attention</h3>
    <div class="list">${needsWork.length ? needsWork.map(analyticsRowHtml).join('') : '<div class="empty-state">Nothing stalled right now.</div>'}</div>

    ${newLifts.length ? `
    <h3 class="subheading">Still gathering data</h3>
    <div class="list">${newLifts.map(analyticsRowHtml).join('')}</div>` : ''}
  `;

  drawBarChart('volume-chart', buckets.map(b => b.volume), { color: '#22c55e', fmt: v => `${Math.round(v).toLocaleString()}kg` });
  drawBarChart('frequency-chart', buckets.map(b => b.count), { color: '#3b82f6', fmt: v => `${v}` });

  bindAnalyticsRows(container, rows);

  const settingsBtn = document.getElementById('standards-open-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      await openDataModal();
      document.getElementById('profile-bodyweight-input').focus();
    });
  }
}

// ---------- Routine editor ----------
function openRoutineEditor(routine) {
  state.routineEditing = routine
    ? JSON.parse(JSON.stringify(routine))
    : { name: '', exercises: [] };
  document.getElementById('routine-modal-title').textContent = routine ? 'Edit Template' : 'New Template';
  document.getElementById('routine-name-input').value = state.routineEditing.name;
  renderRoutineEditor();
  document.getElementById('routine-modal').classList.remove('hidden');
}

function closeRoutineEditor() {
  document.getElementById('routine-modal').classList.add('hidden');
  state.routineEditing = null;
}

function renderRoutineEditor() {
  const container = document.getElementById('routine-exercises');
  if (state.routineEditing.exercises.length === 0) {
    container.innerHTML = `<div class="empty-state">Add the exercises you plan to do.</div>`;
    return;
  }
  const ssGroups = computeSupersets(state.routineEditing.exercises);
  container.innerHTML = state.routineEditing.exercises.map((ex, exIdx) => {
    const ss = ssGroups[exIdx];
    const cardio = isCardioExercise(ex.exerciseId);
    const rows = ex.sets.map((set, setIdx) => cardio ? `
      <div class="set-row-table target" data-ex="${exIdx}" data-set="${setIdx}">
        <span class="set-num">${setIdx + 1}</span>
        <input type="number" min="0" step="0.01" class="set-km-input" placeholder="km" value="${set.km}" />
        <input type="number" min="0" class="set-cal-input" placeholder="cal" value="${set.calories}" />
        <button class="set-remove" title="remove set">✕</button>
      </div>
    ` : `
      <div class="set-row-table target" data-ex="${exIdx}" data-set="${setIdx}">
        <span class="set-num">${setIdx + 1}</span>
        <input type="number" min="0" step="0.5" class="set-weight-input" placeholder="kg" value="${set.weight}" />
        <input type="number" min="0" class="set-reps-input" placeholder="reps" value="${set.reps}" />
        <button class="set-remove" title="remove set">✕</button>
      </div>
    `).join('');
    return `
      <div class="exercise-block ${ss !== null ? 'in-superset' : ''}" data-ex="${exIdx}" data-ss="${ss === null ? '' : ss % 4}">
        <div class="exercise-block-header">
          <button class="drag-handle" title="Drag to reorder" aria-label="Reorder ${escapeAttr(ex.name)}">≡</button>
          <strong>${escapeHtml(ex.name)}</strong>
          ${exIdx > 0 ? `<button class="ss-btn ${ex.linkedToPrev ? 'on' : ''}" data-ex="${exIdx}" title="${ex.linkedToPrev ? 'Break the superset' : 'Superset with the exercise above'}">⇄</button>` : ''}
          <button class="icon-btn edit-ex-btn" data-ex="${exIdx}" title="Edit this exercise's name/category/equipment">✎</button>
          <button class="icon-btn remove-exercise-btn" data-ex="${exIdx}" title="remove exercise">🗑</button>
        </div>
        ${ss !== null ? '<div class="ss-tag">Superset</div>' : ''}
        <div class="set-table target">
          <div class="set-table-head">${cardio
            ? '<span>Set</span><span>Km</span><span>Cal</span><span></span>'
            : '<span>Set</span><span>Weight</span><span>Reps</span><span></span>'}</div>
          ${rows}
        </div>
        <button class="secondary-btn small add-set-row-btn" data-ex="${exIdx}">+ Add set</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.remove-exercise-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.routineEditing.exercises.splice(Number(btn.dataset.ex), 1);
      renderRoutineEditor();
    });
  });
  container.querySelectorAll('.ss-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.routineEditing.exercises[Number(btn.dataset.ex)];
      ex.linkedToPrev = !ex.linkedToPrev;
      renderRoutineEditor();
    });
  });
  container.querySelectorAll('.edit-ex-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exIdx = Number(btn.dataset.ex);
      const full = state.exercises.find(e => e.id === state.routineEditing.exercises[exIdx].exerciseId);
      if (full) openExerciseEditor(full, { from: 'routine', exIdx });
    });
  });
  container.querySelectorAll('.add-set-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.routineEditing.exercises[Number(btn.dataset.ex)];
      const lastSet = ex.sets[ex.sets.length - 1];
      if (isCardioExercise(ex.exerciseId)) {
        ex.sets.push({ km: lastSet ? lastSet.km : 0, calories: lastSet ? lastSet.calories : 0 });
      } else {
        ex.sets.push({ reps: lastSet ? lastSet.reps : 8, weight: lastSet ? lastSet.weight : 0 });
      }
      renderRoutineEditor();
    });
  });
  container.querySelectorAll('.set-row-table').forEach(row => {
    const exIdx = Number(row.dataset.ex);
    const setIdx = Number(row.dataset.set);
    const exObj = state.routineEditing.exercises[exIdx];
    const set = exObj.sets[setIdx];
    if (isCardioExercise(exObj.exerciseId)) {
      selectContentsOnFocus(row.querySelector('.set-km-input'));
      selectContentsOnFocus(row.querySelector('.set-cal-input'));
      row.querySelector('.set-km-input').addEventListener('input', e => { set.km = Number(e.target.value) || 0; });
      row.querySelector('.set-cal-input').addEventListener('input', e => { set.calories = Number(e.target.value) || 0; });
    } else {
      selectContentsOnFocus(row.querySelector('.set-weight-input'));
      selectContentsOnFocus(row.querySelector('.set-reps-input'));
      row.querySelector('.set-weight-input').addEventListener('input', e => { set.weight = Number(e.target.value) || 0; });
      row.querySelector('.set-reps-input').addEventListener('input', e => { set.reps = Number(e.target.value) || 0; });
    }
    row.querySelector('.set-remove').addEventListener('click', () => {
      state.routineEditing.exercises[exIdx].sets.splice(setIdx, 1);
      renderRoutineEditor();
    });
  });

  enableExerciseReorder(container, order => {
    if (order.every((from, to) => from === to)) return;
    const previous = state.routineEditing.exercises;
    state.routineEditing.exercises = order.map(from => previous[from]);
    if (state.routineEditing.exercises[0]) state.routineEditing.exercises[0].linkedToPrev = false;
    renderRoutineEditor();
  });
}

async function saveRoutine() {
  const name = document.getElementById('routine-name-input').value.trim();
  if (!name) {
    alert('Give this template a name.');
    return;
  }
  if (state.routineEditing.exercises.length === 0) {
    alert('Add at least one exercise.');
    return;
  }
  const payload = { name, exercises: state.routineEditing.exercises };
  if (state.routineEditing.id) {
    await db.updateRoutine(state.routineEditing.id, payload);
  } else {
    await db.addRoutine(payload);
  }
  closeRoutineEditor();
  loadRoutines();
}

init();
