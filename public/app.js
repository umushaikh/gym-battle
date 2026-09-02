const ACTIVE_WORKOUT_KEY = 'ironLogActiveWorkout';

const state = {
  exercises: [],
  activeWorkout: null,   // { name, startedAt, notes, exercises: [{exerciseId, name, sets:[{reps,weight,warmup,completed}]}] }
  lastCache: {},          // exerciseId -> { sets, date } | null
  pickerTarget: null,     // 'workout' | 'routine'
  pickerSelection: [],    // exercise ids ticked in the picker
  routineEditing: null,   // { id?, name, exercises: [{exerciseId, name, sets:[{reps,weight}]}] }
  timerInterval: null,
  rest: null,              // { endsAt } while resting between sets
  restInterval: null,
  categoryFilter: ''
};

if ('serviceWorker' in navigator) {
  // Whether a worker was already in charge when this page loaded. If one was,
  // a later handover means a new version has been deployed, so reload once to
  // show it. Guarded so a first-ever install doesn't reload, and so this can
  // never loop.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function e1rm(reps, weight) {
  if (!weight || !reps) return 0;
  return weight * (1 + reps / 30);
}

function formatSets(sets) {
  const groups = [];
  sets.forEach(s => {
    const warmup = !!s.warmup;
    const last = groups[groups.length - 1];
    if (last && last.reps === s.reps && last.weight === s.weight && last.warmup === warmup) {
      last.count++;
    } else {
      groups.push({ reps: s.reps, weight: s.weight, warmup, count: 1 });
    }
  });
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

function workoutVolume(workout) {
  return workout.exercises.reduce((sum, e) =>
    sum + e.sets.filter(set => !set.warmup).reduce((s, set) => s + set.reps * set.weight, 0), 0);
}

function buildShareText(workout) {
  const lines = [
    `${workout.name} — ${workout.date}`,
    `${formatDuration(workout.endedAt - workout.startedAt)} · Volume ${Math.round(workoutVolume(workout)).toLocaleString()}kg`,
    ''
  ];
  workout.exercises.forEach(e => {
    lines.push(`${e.name}: ${formatSets(e.sets)}`);
    if (e.notes) lines.push(`  (${e.notes})`);
  });
  if (workout.notes) lines.push('', `Notes: ${workout.notes}`);
  lines.push('', 'Logged with Iron Log');
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

// ---------- Backup & restore ----------
async function openDataModal() {
  document.getElementById('rest-default-input').value = getDefaultRest();
  const data = await db.exportData();
  document.getElementById('data-summary').innerHTML = `
    <div class="pr-row"><span>Workouts saved</span><strong>${data.workouts.length}</strong></div>
    <div class="pr-row"><span>Routines</span><strong>${data.routines.length}</strong></div>
    <div class="pr-row"><span>Exercises</span><strong>${data.exercises.length}</strong></div>
  `;
  document.getElementById('data-modal').classList.remove('hidden');
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
    alert('That file is not an Iron Log backup. Pick the .json file the Download backup button saved.');
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
  document.getElementById('rest-default-input').addEventListener('change', e => {
    const secs = Math.max(0, Math.min(900, Number(e.target.value) || 0));
    localStorage.setItem(REST_DEFAULT_KEY, String(secs));
    e.target.value = secs;
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
  state.activeWorkout = { name: '', startedAt: Date.now(), notes: '', exercises: [] };
  persistActiveWorkout();
  renderWorkoutTab();
}

function startFromRoutine(routine) {
  state.activeWorkout = {
    name: routine.name,
    startedAt: Date.now(),
    notes: '',
    exercises: routine.exercises.map(e => ({
      exerciseId: e.exerciseId,
      name: e.name,
      notes: '',
      linkedToPrev: !!e.linkedToPrev,
      sets: e.sets.map(s => ({ reps: s.reps ?? '', weight: s.weight ?? '', warmup: false, completed: false }))
    }))
  };
  state.activeWorkout.exercises.forEach(e => warmLastCache(e.exerciseId).then(renderActiveWorkout));
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
  state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

function updateTimerDisplay() {
  if (!state.activeWorkout) return;
  const elapsed = Date.now() - state.activeWorkout.startedAt;
  const totalSec = Math.max(0, Math.floor(elapsed / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  document.getElementById('active-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
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
    let workingCount = 0;
    const rows = ex.sets.map((set, setIdx) => {
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
          <button class="icon-btn remove-exercise-btn" data-ex="${exIdx}" title="remove exercise">🗑</button>
        </div>
        ${ss !== null ? '<div class="ss-tag">Superset</div>' : ''}
        <div class="set-table">
          <div class="set-table-head"><span>Set</span><span>Previous</span><span>Weight</span><span>Reps</span><span></span><span></span></div>
          ${rows}
        </div>
        <div class="warmup-hint">Tap a set number to make it a warm-up (W). Warm-ups don't count toward volume or records.</div>
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

  container.querySelectorAll('.add-set-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.activeWorkout.exercises[Number(btn.dataset.ex)];
      const lastSet = ex.sets[ex.sets.length - 1];
      ex.sets.push({ reps: lastSet ? lastSet.reps : '', weight: lastSet ? lastSet.weight : '', warmup: false, completed: false });
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
    const set = state.activeWorkout.exercises[exIdx].sets[setIdx];

    row.querySelector('.set-num').addEventListener('click', () => {
      set.warmup = !set.warmup;
      persistActiveWorkout();
      renderActiveWorkout();
    });
    row.querySelector('.set-weight-input').addEventListener('input', e => {
      set.weight = e.target.value;
      persistActiveWorkout();
    });
    row.querySelector('.set-reps-input').addEventListener('input', e => {
      set.reps = e.target.value;
      persistActiveWorkout();
    });
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
    e.sets.some(s => Number(s.reps) > 0 || Number(s.weight) > 0));
  if (!hasLoggedSet) {
    alert('Log at least one set before finishing.');
    return;
  }
  const payload = {
    name: state.activeWorkout.name || 'Workout',
    startedAt: state.activeWorkout.startedAt,
    endedAt: Date.now(),
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
}

// ---------- Exercise picker ----------
function openPicker(target) {
  state.pickerTarget = target;
  state.pickerSelection = [];
  document.getElementById('picker-search').value = '';
  hidePickerNewForm();
  renderPickerList();
  document.getElementById('exercise-picker').classList.remove('hidden');
}

function closePicker() {
  document.getElementById('exercise-picker').classList.add('hidden');
  hidePickerNewForm();
}

function hidePickerNewForm() {
  document.getElementById('picker-new-form').classList.add('hidden');
  document.getElementById('picker-list').classList.remove('hidden');
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
  const matches = state.exercises.filter(e => e.name.toLowerCase().includes(query));
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
  document.getElementById('picker-actions').classList.toggle('hidden', count === 0);
  document.getElementById('picker-add-btn').textContent =
    count === 1 ? 'Add 1 exercise' : `Add ${count} exercises`;
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
    state.activeWorkout.exercises.push({
      exerciseId: exercise.id,
      name: exercise.name,
      notes: '',
      sets: [{ reps: last ? last.sets[0].reps : '', weight: last ? last.sets[0].weight : '', warmup: false, completed: false }]
    });
    persistActiveWorkout();
    renderActiveWorkout();
  } else if (state.pickerTarget === 'routine') {
    state.routineEditing.exercises.push({
      exerciseId: exercise.id,
      name: exercise.name,
      sets: [{ reps: 8, weight: 0 }, { reps: 8, weight: 0 }, { reps: 8, weight: 0 }]
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
        <div class="entry-sub">${formatSets(e.sets)}</div>
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
  // template keeps the working sets.
  const exercises = workout.exercises
    .map(e => ({
      exerciseId: e.exerciseId,
      name: e.name,
      linkedToPrev: !!e.linkedToPrev,
      sets: e.sets.filter(s => !s.warmup).map(s => ({ reps: s.reps, weight: s.weight }))
    }))
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

function openExerciseEditor(exercise) {
  document.getElementById('edit-exercise-name').value = exercise.name;
  document.getElementById('edit-exercise-category').value = exercise.category || '';
  document.getElementById('edit-exercise-equipment').value = exercise.equipment || '';
  document.getElementById('edit-exercise-modal').dataset.id = exercise.id;
  document.getElementById('edit-exercise-modal').classList.remove('hidden');
}

function closeExerciseEditor() {
  document.getElementById('edit-exercise-modal').classList.add('hidden');
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
      closeExerciseEditor();
      closeDetail();
      renderLibraryTab();
      alert(`Added "${newName}" as a separate exercise, tracked on its own.\n\n"${original.name}" keeps its ${sessions} session${sessions !== 1 ? 's' : ''}.`);
      return;
    }
  }

  const updated = await db.updateExercise(id, { name, category, equipment });
  Object.assign(original, updated);
  if (state.activeWorkout) {
    state.activeWorkout.exercises.forEach(e => { if (e.exerciseId === id) e.name = updated.name; });
    persistActiveWorkout();
  }
  state.lastCache = {};
  closeExerciseEditor();
  closeDetail();
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

function drawExerciseChart(sessions) {
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

  const points = [...sessions].reverse().map(s => ({
    date: s.date,
    value: Math.max(0, ...s.sets.filter(set => !set.warmup).map(set => e1rm(set.reps, set.weight)))
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
  ctx.fillText(`est 1RM ${Math.round(points[0].value)}`, padding.left - 6, 10);
  if (points.length > 1) {
    ctx.fillText(points[0].date.slice(5), padding.left - 10, height - 4);
    ctx.fillText(points[points.length - 1].date.slice(5), width - padding.right - 30, height - 4);
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
    const rows = ex.sets.map((set, setIdx) => `
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
          <button class="icon-btn remove-exercise-btn" data-ex="${exIdx}" title="remove exercise">🗑</button>
        </div>
        ${ss !== null ? '<div class="ss-tag">Superset</div>' : ''}
        <div class="set-table target">
          <div class="set-table-head"><span>Set</span><span>Weight</span><span>Reps</span><span></span></div>
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
  container.querySelectorAll('.add-set-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = state.routineEditing.exercises[Number(btn.dataset.ex)];
      const lastSet = ex.sets[ex.sets.length - 1];
      ex.sets.push({ reps: lastSet ? lastSet.reps : 8, weight: lastSet ? lastSet.weight : 0 });
      renderRoutineEditor();
    });
  });
  container.querySelectorAll('.set-row-table').forEach(row => {
    const exIdx = Number(row.dataset.ex);
    const setIdx = Number(row.dataset.set);
    const set = state.routineEditing.exercises[exIdx].sets[setIdx];
    row.querySelector('.set-weight-input').addEventListener('input', e => { set.weight = Number(e.target.value) || 0; });
    row.querySelector('.set-reps-input').addEventListener('input', e => { set.reps = Number(e.target.value) || 0; });
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
