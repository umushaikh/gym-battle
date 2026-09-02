const state = {
  profiles: [],
  exercises: [],
  currentProfileId: localStorage.getItem('gymBattleProfileId') || null
};

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function profileName(id) {
  const p = state.profiles.find(p => p.id === id);
  return p ? p.name : 'Unknown';
}
function profileColor(id) {
  const p = state.profiles.find(p => p.id === id);
  return p ? p.color : '#888';
}

// ---------- Init ----------
async function init() {
  state.profiles = await api('/profiles');
  state.exercises = await api('/exercises');
  renderExerciseList();

  if (state.currentProfileId && state.profiles.some(p => p.id === state.currentProfileId)) {
    showApp();
  } else {
    showGate();
  }

  document.getElementById('date-input').value = todayStr();
  document.getElementById('bet-start').value = todayStr();
  const endDefault = new Date();
  endDefault.setDate(endDefault.getDate() + 7);
  document.getElementById('bet-end').value = endDefault.toISOString().slice(0, 10);

  addSetRow();
  bindEvents();
  loadRecent();
  loadProgress();
  loadBets();
}

function showGate() {
  const container = document.getElementById('profile-buttons');
  container.innerHTML = '';
  state.profiles.forEach(p => {
    const wrap = document.createElement('div');
    wrap.className = 'profile-row';

    const btn = document.createElement('button');
    btn.className = 'profile-btn';
    btn.style.background = p.color;
    btn.textContent = `I'm ${p.name}`;
    btn.onclick = () => {
      state.currentProfileId = p.id;
      localStorage.setItem('gymBattleProfileId', p.id);
      showApp();
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-profile-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Rename';
    editBtn.onclick = () => renameProfile(p.id);

    wrap.appendChild(btn);
    wrap.appendChild(editBtn);
    container.appendChild(wrap);
  });
  document.getElementById('profile-gate').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

async function renameProfile(id) {
  const current = state.profiles.find(p => p.id === id);
  const name = prompt('Enter a name:', current.name);
  if (!name || !name.trim() || name.trim() === current.name) return;
  const updated = await api(`/profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: name.trim() })
  });
  current.name = updated.name;
  showGate();
  if (state.currentProfileId) {
    document.getElementById('whoami-name').textContent = profileName(state.currentProfileId);
  }
}

function showApp() {
  document.getElementById('profile-gate').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('whoami-name').textContent = profileName(state.currentProfileId);
  loadRecent();
  loadBets();
}

function renderExerciseList() {
  const list = document.getElementById('exercise-list');
  list.innerHTML = state.exercises.map(e => `<option value="${escapeHtml(e)}">`).join('');
  const select = document.getElementById('progress-exercise');
  const prev = select.value;
  select.innerHTML = `<option value="">All exercises</option>` +
    state.exercises.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  if (prev) select.value = prev;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Tabs ----------
function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'progress') loadProgress();
      if (btn.dataset.tab === 'bets') loadBets();
    });
  });

  document.getElementById('switch-profile').addEventListener('click', () => {
    state.currentProfileId = null;
    localStorage.removeItem('gymBattleProfileId');
    showGate();
  });

  document.getElementById('add-set-btn').addEventListener('click', addSetRow);
  document.getElementById('workout-form').addEventListener('submit', submitWorkout);
  document.getElementById('bet-form').addEventListener('submit', submitBet);
  document.getElementById('progress-exercise').addEventListener('change', loadProgress);

  let hintDebounce;
  document.getElementById('exercise-input').addEventListener('input', () => {
    clearTimeout(hintDebounce);
    hintDebounce = setTimeout(updateLastTimeHint, 300);
  });
  document.getElementById('exercise-input').addEventListener('change', updateLastTimeHint);
}

// ---------- Last-time hint ----------
function formatSets(sets) {
  const groups = [];
  sets.forEach(s => {
    const last = groups[groups.length - 1];
    if (last && last.reps === s.reps && last.weight === s.weight) {
      last.count++;
    } else {
      groups.push({ reps: s.reps, weight: s.weight, count: 1 });
    }
  });
  return groups.map(g => `${g.count}×${g.reps}${g.weight ? ` @ ${g.weight}lbs` : ''}`).join(', ');
}

async function updateLastTimeHint() {
  const exercise = document.getElementById('exercise-input').value.trim();
  const hintEl = document.getElementById('last-time-hint');
  if (!exercise || !state.currentProfileId) {
    hintEl.textContent = '';
    return;
  }
  const workouts = await api(`/workouts?profileId=${encodeURIComponent(state.currentProfileId)}&exercise=${encodeURIComponent(exercise)}`);
  hintEl.textContent = workouts.length
    ? `Last time (${workouts[0].date}): ${formatSets(workouts[0].sets)}`
    : '';
}

// ---------- Log tab ----------
function addSetRow() {
  const container = document.getElementById('sets-container');
  const idx = container.children.length + 1;
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `
    <span>Set ${idx}</span>
    <input type="number" min="0" class="set-reps" placeholder="reps" required style="margin-top:0" />
    <input type="number" min="0" step="0.5" class="set-weight" placeholder="weight (lbs)" style="margin-top:0" />
    <button type="button" title="remove set">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    renumberSets();
  });
  container.appendChild(row);
}

function renumberSets() {
  document.querySelectorAll('#sets-container .set-row span').forEach((span, i) => {
    span.textContent = `Set ${i + 1}`;
  });
}

async function submitWorkout(e) {
  e.preventDefault();
  const exercise = document.getElementById('exercise-input').value.trim();
  const date = document.getElementById('date-input').value;
  const notes = document.getElementById('notes-input').value.trim();
  const sets = [...document.querySelectorAll('#sets-container .set-row')].map(row => ({
    reps: row.querySelector('.set-reps').value,
    weight: row.querySelector('.set-weight').value || 0
  }));

  try {
    await api('/workouts', {
      method: 'POST',
      body: JSON.stringify({ profileId: state.currentProfileId, exercise, sets, date, notes })
    });
    document.getElementById('workout-form').reset();
    document.getElementById('date-input').value = todayStr();
    document.getElementById('sets-container').innerHTML = '';
    addSetRow();
    if (!state.exercises.includes(exercise)) {
      state.exercises.push(exercise);
      renderExerciseList();
    }
    loadRecent();
  } catch (err) {
    alert(err.message);
  }
}

async function loadRecent() {
  const workouts = await api('/workouts');
  const container = document.getElementById('recent-list');
  if (workouts.length === 0) {
    container.innerHTML = `<div class="empty-state">No workouts logged yet. Add one above!</div>`;
    return;
  }
  container.innerHTML = workouts.slice(0, 20).map(w => {
    const totalReps = w.sets.reduce((s, set) => s + set.reps, 0);
    const maxWeight = Math.max(0, ...w.sets.map(s => s.weight));
    const setsDesc = `${w.sets.length} set${w.sets.length !== 1 ? 's' : ''} · ${totalReps} reps${maxWeight ? ` · up to ${maxWeight}lbs` : ''}`;
    return `
      <div class="entry">
        <div class="entry-main">
          <div class="entry-title">${escapeHtml(w.exercise)}</div>
          <div class="entry-sub">${w.date} · ${setsDesc}${w.notes ? ` · "${escapeHtml(w.notes)}"` : ''}</div>
        </div>
        <span class="entry-badge" style="background:${profileColor(w.profileId)}">${escapeHtml(profileName(w.profileId))}</span>
        <button class="del-btn" data-id="${w.id}" title="delete">🗑</button>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this workout entry?')) return;
      await api(`/workouts/${btn.dataset.id}`, { method: 'DELETE' });
      loadRecent();
      loadProgress();
      loadBets();
    });
  });
}

// ---------- Progress tab ----------
async function loadProgress() {
  const exercise = document.getElementById('progress-exercise').value;
  const query = exercise ? `?exercise=${encodeURIComponent(exercise)}` : '';
  const workouts = await api(`/workouts${query}`);

  const totals = {};
  state.profiles.forEach(p => totals[p.id] = 0);
  workouts.forEach(w => {
    const vol = w.sets.reduce((s, set) => s + set.reps * set.weight, 0);
    totals[w.profileId] = (totals[w.profileId] || 0) + vol;
  });
  const leaderId = Object.entries(totals).sort((a, b) => b[1] - a[1])[0]?.[0];

  const summary = document.getElementById('progress-summary');
  summary.innerHTML = state.profiles.map(p => `
    <div class="summary-cell ${totals[p.id] === totals[leaderId] && totals[leaderId] > 0 ? 'leader' : ''}">
      <div class="name" style="color:${p.color}">${escapeHtml(p.name)}</div>
      <div class="value">${Math.round(totals[p.id]).toLocaleString()}</div>
      <div style="color:var(--muted);font-size:0.75rem">total volume</div>
    </div>
  `).join('');

  drawChart(workouts);
  renderExerciseDetail(exercise, workouts);
}

function e1rm(reps, weight) {
  if (!weight || !reps) return 0;
  return weight * (1 + reps / 30);
}

function renderExerciseDetail(exercise, workouts) {
  const container = document.getElementById('exercise-detail');
  if (!exercise) {
    container.innerHTML = `<div class="empty-state">Pick a specific exercise above to see personal records and history.</div>`;
    return;
  }

  const byProfile = {};
  state.profiles.forEach(p => byProfile[p.id] = []);
  workouts.forEach(w => { (byProfile[w.profileId] = byProfile[w.profileId] || []).push(w); });

  const prHtml = state.profiles.map(p => {
    const ws = byProfile[p.id] || [];
    let bestWeight = 0, bestE1rm = 0;
    ws.forEach(w => w.sets.forEach(s => {
      if (s.weight > bestWeight) bestWeight = s.weight;
      bestE1rm = Math.max(bestE1rm, e1rm(s.reps, s.weight));
    }));
    return `
      <div class="pr-cell">
        <div class="name" style="color:${p.color}">${escapeHtml(p.name)}</div>
        <div class="pr-row"><span>Best set</span><strong>${bestWeight ? bestWeight + 'lbs' : '—'}</strong></div>
        <div class="pr-row"><span>Est. 1RM</span><strong>${bestE1rm ? Math.round(bestE1rm) + 'lbs' : '—'}</strong></div>
        <div class="pr-row"><span>Sessions</span><strong>${ws.length}</strong></div>
      </div>
    `;
  }).join('');

  const historyHtml = workouts.slice(0, 15).map(w => {
    const vol = w.sets.reduce((s, set) => s + set.reps * set.weight, 0);
    return `
      <div class="entry">
        <div class="entry-main">
          <div class="entry-title">${w.date}</div>
          <div class="entry-sub">${formatSets(w.sets)} · vol ${Math.round(vol).toLocaleString()}</div>
        </div>
        <span class="entry-badge" style="background:${profileColor(w.profileId)}">${escapeHtml(profileName(w.profileId))}</span>
      </div>
    `;
  }).join('') || `<div class="empty-state">No sessions logged for this exercise yet.</div>`;

  container.innerHTML = `
    <div class="pr-grid">${prHtml}</div>
    <h3 class="subheading">History</h3>
    <div class="list">${historyHtml}</div>
  `;
}

function drawChart(workouts) {
  const canvas = document.getElementById('progress-chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = 180;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // group by date -> volume per profile
  const byDate = {};
  workouts.forEach(w => {
    const vol = w.sets.reduce((s, set) => s + set.reps * set.weight, 0);
    byDate[w.date] = byDate[w.date] || {};
    byDate[w.date][w.profileId] = (byDate[w.date][w.profileId] || 0) + vol;
  });
  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('No data yet for this exercise', 10, height / 2);
    return;
  }

  const maxVal = Math.max(1, ...dates.flatMap(d => state.profiles.map(p => byDate[d][p.id] || 0)));
  const padding = { left: 36, right: 10, top: 10, bottom: 20 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const step = dates.length > 1 ? plotW / (dates.length - 1) : 0;

  // axes
  ctx.strokeStyle = '#334155';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  state.profiles.forEach(profile => {
    ctx.strokeStyle = profile.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    dates.forEach((d, i) => {
      const val = byDate[d][profile.id] || 0;
      const x = padding.left + i * step;
      const y = height - padding.bottom - (val / maxVal) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    dates.forEach((d, i) => {
      const val = byDate[d][profile.id] || 0;
      const x = padding.left + i * step;
      const y = height - padding.bottom - (val / maxVal) * plotH;
      ctx.fillStyle = profile.color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  if (dates.length <= 8) {
    dates.forEach((d, i) => {
      const x = padding.left + i * step;
      ctx.fillText(d.slice(5), x - 12, height - 4);
    });
  } else {
    ctx.fillText(dates[0].slice(5), padding.left - 10, height - 4);
    ctx.fillText(dates[dates.length - 1].slice(5), width - padding.right - 30, height - 4);
  }
}

// ---------- Bets tab ----------
async function loadBets() {
  const bets = await api('/bets');
  const container = document.getElementById('bets-list');
  if (bets.length === 0) {
    container.innerHTML = `<div class="empty-state">No bets yet. Start one below!</div>`;
    return;
  }
  container.innerHTML = bets.map(bet => {
    const topVal = Math.max(...bet.standings.map(s => s.value));
    return `
      <div class="bet-card">
        <div class="bet-title">${escapeHtml(bet.title)}</div>
        <div class="bet-meta">${escapeHtml(bet.exercise || 'All exercises')} · ${metricLabel(bet.metric)} · ${bet.startDate} → ${bet.endDate}</div>
        <div class="bet-standings">
          ${bet.standings.map(s => `
            <div class="bet-standing ${s.value === topVal && topVal > 0 ? 'win' : ''}">
              <div class="n" style="color:${profileColor(s.profileId)}">${escapeHtml(s.name)}</div>
              <div class="v">${Math.round(s.value).toLocaleString()}</div>
            </div>
          `).join('')}
        </div>
        ${bet.stake ? `<div class="bet-stake">Stake: ${escapeHtml(bet.stake)}</div>` : ''}
        <span class="bet-status ${bet.status}">
          ${bet.status === 'active' ? 'In progress' : (bet.winner === 'tie' ? "It's a tie!" : bet.winner ? `${profileName(bet.winner)} won!` : 'No winner')}
        </span>
        <button class="del-btn" data-id="${bet.id}" title="delete" style="float:right">🗑</button>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this bet?')) return;
      await api(`/bets/${btn.dataset.id}`, { method: 'DELETE' });
      loadBets();
    });
  });
}

function metricLabel(metric) {
  return {
    volume: 'Total volume',
    reps: 'Total reps',
    sets: 'Total sets',
    max_weight: 'Heaviest set',
    workouts: 'Workouts logged'
  }[metric] || metric;
}

async function submitBet(e) {
  e.preventDefault();
  const title = document.getElementById('bet-title').value.trim();
  const exercise = document.getElementById('bet-exercise').value.trim();
  const metric = document.getElementById('bet-metric').value;
  const startDate = document.getElementById('bet-start').value;
  const endDate = document.getElementById('bet-end').value;
  const stake = document.getElementById('bet-stake').value.trim();

  if (endDate < startDate) {
    alert('End date must be after start date');
    return;
  }

  try {
    await api('/bets', {
      method: 'POST',
      body: JSON.stringify({ title, exercise: exercise || null, metric, startDate, endDate, stake })
    });
    document.getElementById('bet-form').reset();
    document.getElementById('bet-start').value = todayStr();
    const endDefault = new Date();
    endDefault.setDate(endDefault.getDate() + 7);
    document.getElementById('bet-end').value = endDefault.toISOString().slice(0, 10);
    loadBets();
  } catch (err) {
    alert(err.message);
  }
}

init();
