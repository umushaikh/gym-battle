let store = loadDb();
let deck = [];
let loadingIdeas = false;
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedBacklogId = null;

document.addEventListener('DOMContentLoaded', init);

function init() {
  registerServiceWorker();
  setupTabs();
  setupDeckActions();
  setupCalendarNav();
  setupStreakActions();
  setupSettings();

  document.getElementById('version-tag').textContent = versionLabel(false);
  document.getElementById('version-line').textContent = versionLabel(true);

  deck = store.ideas.filter(i => i.status === 'new');
  renderDeck();
  renderCalendar();
  renderStreak();
  ensureIdeaSupply();
  maybeNudgeOverdue();
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------------- Tabs ---------------- */
function setupTabs() {
  document.querySelectorAll('.tabbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbar-btn').forEach(b => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    });
  });
}

/* ---------------- Swipe deck ---------------- */
function setupDeckActions() {
  document.getElementById('like-btn').addEventListener('click', () => swipeTop('like'));
  document.getElementById('pass-btn').addEventListener('click', () => swipeTop('pass'));
}

function renderDeck() {
  const el = document.getElementById('deck');
  el.innerHTML = '';
  const cards = deck.slice(0, 3);
  if (cards.length === 0) {
    el.innerHTML = `<div class="deck-empty">${loadingIdeas ? 'Fetching new ideas…' : 'No ideas queued up. Pull the tab again in a moment.'}</div>`;
    return;
  }
  cards.forEach((idea, i) => {
    const card = document.createElement('div');
    card.className = 'idea-card';
    card.dataset.id = idea.id;
    card.style.zIndex = String(10 - i);
    card.style.transform = `translateY(${i * 8}px) scale(${1 - i * 0.04})`;
    card.innerHTML = `
      <span class="swipe-flag like">Like</span>
      <span class="swipe-flag pass">Pass</span>
      <div class="format-chip">${escapeHtml(idea.format || 'Idea')}</div>
      <div>
        <h3>${escapeHtml(idea.title)}</h3>
        <p>${escapeHtml(idea.hook || '')}</p>
      </div>
    `;
    if (i === 0) attachDrag(card, idea);
    el.appendChild(card);
  });
}

function attachDrag(card, idea) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const likeFlag = card.querySelector('.swipe-flag.like');
  const passFlag = card.querySelector('.swipe-flag.pass');

  card.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    card.style.transition = 'none';
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    likeFlag.style.opacity = Math.max(0, Math.min(1, dx / 90));
    passFlag.style.opacity = Math.max(0, Math.min(1, -dx / 90));
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform 0.3s ease';
    const threshold = 100;
    if (dx > threshold) {
      exitCard(card, 'like');
      finalizeSwipe(idea, 'like');
    } else if (dx < -threshold) {
      exitCard(card, 'pass');
      finalizeSwipe(idea, 'pass');
    } else {
      card.style.transform = 'translate(0, 0) rotate(0)';
      likeFlag.style.opacity = 0;
      passFlag.style.opacity = 0;
    }
    dx = 0; dy = 0;
  };

  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);
}

function exitCard(card, direction) {
  card.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
  card.style.transform = `translate(${direction === 'like' ? 700 : -700}px, -30px) rotate(${direction === 'like' ? 26 : -26}deg)`;
  card.style.opacity = '0';
}

function swipeTop(direction) {
  if (deck.length === 0) return;
  const idea = deck[0];
  const cardEl = document.querySelector(`.idea-card[data-id="${idea.id}"]`);
  if (cardEl) exitCard(cardEl, direction);
  setTimeout(() => finalizeSwipe(idea, direction), cardEl ? 200 : 0);
}

function finalizeSwipe(idea, direction) {
  const stored = store.ideas.find(i => i.id === idea.id);
  if (stored) stored.status = direction === 'like' ? 'liked' : 'passed';
  deck = deck.filter(i => i.id !== idea.id);
  saveDb(store);
  renderDeck();
  if (direction === 'like') renderCalendar();
  if (deck.length < 3) ensureIdeaSupply();
}

async function ensureIdeaSupply() {
  if (loadingIdeas || deck.length >= 3) return;
  loadingIdeas = true;
  const statusEl = document.getElementById('deck-status');
  statusEl.textContent = 'Finding more ideas…';
  renderDeck();

  const seenTitles = store.ideas.map(i => i.title);
  const apiKey = (store.settings.apiKey || '').trim();
  let fresh = [];
  let usedFallback = false;

  if (apiKey) {
    try {
      fresh = await generateIdeas(apiKey, store.settings.niche, seenTitles.slice(-40));
    } catch (err) {
      statusEl.textContent = `Couldn't reach Claude (${err.message}) — showing starter ideas instead.`;
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (fresh.length === 0) {
    const unseen = SEED_IDEAS.filter(s => !seenTitles.includes(s.title));
    const pool = unseen.length >= 6 ? unseen : SEED_IDEAS;
    fresh = [...pool].sort(() => Math.random() - 0.5).slice(0, 8);
  }

  const newIdeas = fresh.map(f => ({
    id: uid(),
    title: f.title,
    hook: f.hook,
    format: f.format,
    createdAt: Date.now(),
    status: 'new',
    source: apiKey && !usedFallback ? 'ai' : 'seed'
  }));

  store.ideas.push(...newIdeas);
  deck.push(...newIdeas);
  saveDb(store);
  loadingIdeas = false;
  if (!usedFallback) statusEl.textContent = '';
  renderDeck();
}

/* ---------------- Calendar ---------------- */
function setupCalendarNav() {
  document.getElementById('prev-month-btn').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('next-month-btn').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById('day-modal-close').addEventListener('click', () => closeModal('day-modal'));
}

function isScheduled(ideaId) {
  return Object.values(store.calendar).some(e => e.ideaId === ideaId);
}

function renderBacklog() {
  const row = document.getElementById('backlog-row');
  const liked = store.ideas.filter(i => i.status === 'liked' && !isScheduled(i.id));
  if (liked.length === 0) {
    row.innerHTML = '<div class="empty-state" style="padding: 12px 4px;">Like some ideas in the Ideas tab to build a backlog to schedule.</div>';
    return;
  }
  row.innerHTML = '';
  liked.forEach(idea => {
    const chip = document.createElement('button');
    chip.className = 'backlog-chip';
    chip.style.background = selectedBacklogId === idea.id ? 'var(--accent-soft)' : '';
    chip.style.borderColor = selectedBacklogId === idea.id ? 'var(--accent)' : '';
    chip.innerHTML = `<strong>${escapeHtml(idea.title)}</strong>${escapeHtml(idea.format || '')}`;
    chip.addEventListener('click', () => {
      selectedBacklogId = selectedBacklogId === idea.id ? null : idea.id;
      showToast(selectedBacklogId ? 'Now tap a day to schedule it' : 'Selection cleared');
      renderBacklog();
    });
    row.appendChild(chip);
  });
}

function renderCalendar() {
  renderBacklog();

  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  document.getElementById('month-label').textContent = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
    const dow = document.createElement('div');
    dow.className = 'cal-dow';
    dow.textContent = d;
    grid.appendChild(dow);
  });

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = todayStr(new Date(year, month, d));
    const entry = store.calendar[dateStr];
    const posted = store.postLog.includes(dateStr);

    const cell = document.createElement('button');
    cell.className = 'cal-day';
    if (dateStr === today) cell.classList.add('today');
    if (entry) cell.classList.add('has-idea');
    if (posted) cell.classList.add('posted');
    cell.innerHTML = `<span class="cal-day-label">${d}</span>${posted ? '<span class="posted-mark">✓</span>' : (entry ? '<span class="dot"></span>' : '')}`;

    cell.addEventListener('click', () => {
      if (selectedBacklogId) {
        store.calendar[dateStr] = { ideaId: selectedBacklogId };
        saveDb(store);
        const idea = store.ideas.find(i => i.id === selectedBacklogId);
        selectedBacklogId = null;
        showToast(`Scheduled "${idea ? idea.title : 'idea'}" for ${dateStr}`);
        renderCalendar();
      } else {
        openDayModal(dateStr);
      }
    });
    grid.appendChild(cell);
  }
}

function openDayModal(dateStr) {
  const entry = store.calendar[dateStr];
  const posted = store.postLog.includes(dateStr);
  const idea = entry && entry.ideaId ? store.ideas.find(i => i.id === entry.ideaId) : null;
  const backlog = store.ideas.filter(i => i.status === 'liked' && !isScheduled(i.id));

  document.getElementById('day-modal-title').textContent = new Date(dateStr + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const body = document.getElementById('day-modal-body');
  let html = '';

  if (idea || (entry && entry.customTitle)) {
    const title = idea ? idea.title : entry.customTitle;
    const hook = idea ? idea.hook : '';
    html += `
      <div class="card">
        <div class="format-chip">${escapeHtml(idea ? idea.format || 'Idea' : 'Custom')}</div>
        <h3 style="margin: 10px 0 6px;">${escapeHtml(title)}</h3>
        ${hook ? `<p style="color: var(--muted); margin: 0;">${escapeHtml(hook)}</p>` : ''}
      </div>
      <button id="remove-idea-btn" class="danger-btn full" style="width: 100%;">Remove from this day</button>
    `;
  } else {
    html += `<p class="hint-text">Nothing scheduled yet.</p>`;
    if (backlog.length) {
      html += `<div class="section-header"><h2>Pick from backlog</h2></div><div class="picker-list" id="day-backlog-list">`;
      backlog.forEach(i => {
        html += `<button class="picker-item" data-idea-id="${i.id}"><strong>${escapeHtml(i.title)}</strong>${escapeHtml(i.format || '')}</button>`;
      });
      html += `</div>`;
    }
    html += `
      <div class="section-header"><h2>Or write your own</h2></div>
      <input id="custom-idea-input" type="text" placeholder="What are you posting?" />
      <button id="save-custom-idea-btn" class="secondary-btn full">Add to this day</button>
    `;
  }

  html += `
    <div class="section-header"><h2>Posted</h2></div>
    <button id="toggle-posted-btn" class="${posted ? 'secondary-btn' : 'primary-btn'} full">${posted ? '✓ Marked posted — tap to undo' : 'Mark as posted'}</button>
  `;

  body.innerHTML = html;

  const removeBtn = document.getElementById('remove-idea-btn');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    delete store.calendar[dateStr];
    saveDb(store);
    closeModal('day-modal');
    renderCalendar();
  });

  document.querySelectorAll('#day-backlog-list .picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      store.calendar[dateStr] = { ideaId: btn.dataset.ideaId };
      saveDb(store);
      closeModal('day-modal');
      renderCalendar();
    });
  });

  const saveCustomBtn = document.getElementById('save-custom-idea-btn');
  if (saveCustomBtn) saveCustomBtn.addEventListener('click', () => {
    const val = document.getElementById('custom-idea-input').value.trim();
    if (!val) return;
    store.calendar[dateStr] = { customTitle: val };
    saveDb(store);
    closeModal('day-modal');
    renderCalendar();
  });

  document.getElementById('toggle-posted-btn').addEventListener('click', () => {
    togglePosted(dateStr);
    closeModal('day-modal');
    renderCalendar();
    renderStreak();
  });

  showModal('day-modal');
}

function togglePosted(dateStr) {
  const idx = store.postLog.indexOf(dateStr);
  if (idx === -1) {
    store.postLog.push(dateStr);
  } else {
    store.postLog.splice(idx, 1);
  }
  saveDb(store);
}

/* ---------------- Streak ---------------- */
const MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];

function setupStreakActions() {
  document.getElementById('post-today-btn').addEventListener('click', () => {
    const wasPosted = store.postLog.includes(todayStr());
    togglePosted(todayStr());
    renderStreak();
    renderCalendar();
    if (!wasPosted) {
      const { current } = computeStreak(store.postLog);
      showToast(`🔥 Day ${current} logged!`);
    }
  });
}

function computeMotivation(streak, postedToday, reminderTime) {
  if (postedToday) {
    if (MILESTONES.includes(streak.current)) {
      return { text: `🎉 ${streak.current} days straight. That's a real habit now — don't stop here.`, urgent: false };
    }
    if (streak.current <= 1) return { text: "First one's down. That's day one of many.", urgent: false };
    return { text: `🔥 Day ${streak.current} logged. Keep showing up.`, urgent: false };
  }

  const now = new Date();
  const [h, m] = (reminderTime || '18:00').split(':').map(Number);
  const pastReminder = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);

  if (streak.current > 0 && pastReminder) {
    return { text: `You're ${streak.current} days deep. Don't break it now — post no matter what, even something small counts.`, urgent: true };
  }
  if (streak.current > 0) {
    return { text: `Day ${streak.current} isn't logged yet. Post before midnight to keep it alive.`, urgent: false };
  }
  if (store.postLog.length > 0) {
    return { text: "Streaks reset, momentum doesn't have to. Post today and start a new one.", urgent: false };
  }
  return { text: 'Every creator starts at zero. Post your first one today.', urgent: false };
}

function renderStreak() {
  const streak = computeStreak(store.postLog);
  document.getElementById('streak-num').textContent = String(streak.current);
  document.getElementById('streak-best').textContent = streak.longest > 0 ? `Best streak: ${streak.longest} days` : '';

  const postedToday = store.postLog.includes(todayStr());
  const motivation = computeMotivation(streak, postedToday, store.settings.reminderTime);
  const banner = document.getElementById('motivation-banner');
  banner.textContent = motivation.text;
  banner.classList.toggle('urgent', motivation.urgent);

  const postBtn = document.getElementById('post-today-btn');
  postBtn.textContent = postedToday ? '✓ Posted today — tap to undo' : 'I posted today';

  const strip = document.getElementById('week-strip');
  strip.innerHTML = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = todayStr(d);
    const done = store.postLog.includes(dateStr);
    const cell = document.createElement('div');
    cell.className = 'week-day';
    cell.innerHTML = `<span class="dow">${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span><span class="mark ${done ? 'done' : ''}">${done ? '✓' : ''}</span>`;
    strip.appendChild(cell);
  }
}

/* ---------------- Settings / notifications ---------------- */
function setupSettings() {
  document.getElementById('settings-btn').addEventListener('click', () => {
    const form = document.getElementById('settings-form');
    form.apiKey.value = store.settings.apiKey || '';
    form.niche.value = store.settings.niche || '';
    form.reminderTime.value = store.settings.reminderTime || '18:00';
    form.remindersEnabled.checked = !!store.settings.remindersEnabled;
    showModal('settings-modal');
  });
  document.getElementById('settings-close').addEventListener('click', () => closeModal('settings-modal'));

  document.getElementById('settings-form').addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    store.settings.apiKey = form.apiKey.value.trim();
    store.settings.niche = form.niche.value.trim();
    store.settings.reminderTime = form.reminderTime.value || '18:00';
    store.settings.remindersEnabled = form.remindersEnabled.checked;
    saveDb(store);
    closeModal('settings-modal');
    showToast('Settings saved');
    renderStreak();
  });

  document.getElementById('enable-notif-btn').addEventListener('click', enableNotifications);
  document.getElementById('export-btn').addEventListener('click', exportBackup);
  document.getElementById('import-file').addEventListener('change', handleImportFile);
  document.getElementById('reset-btn').addEventListener('click', resetAllData);
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    showToast('Notifications are not supported in this browser.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    showToast('Notifications were not enabled.');
    return;
  }
  store.settings.remindersEnabled = true;
  saveDb(store);
  document.getElementById('settings-form').remindersEnabled.checked = true;

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        await reg.periodicSync.register('streak-check', { minInterval: 12 * 60 * 60 * 1000 });
      }
    } catch {
      // Periodic Background Sync isn't available (most browsers/platforms) —
      // the foreground check on app open still covers the reminder.
    }
  }
  showToast('Notifications enabled');
}

// Reliable reminder path: whenever the app is opened (or brought back to the
// foreground) past the reminder time without a post logged yet, nudge right
// away instead of depending only on best-effort background sync.
function maybeNudgeOverdue() {
  if (!store.settings.remindersEnabled) return;
  if (store.postLog.includes(todayStr())) return;
  const now = new Date();
  const [h, m] = (store.settings.reminderTime || '18:00').split(':').map(Number);
  const pastReminder = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  if (!pastReminder) return;

  const streak = computeStreak(store.postLog);
  const msg = computeMotivation(streak, false, store.settings.reminderTime).text;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(streak.current > 0 ? `🔥 Day ${streak.current} streak` : 'Time to post', { body: msg, icon: 'icons/icon-192.png' });
  } else {
    showToast(msg);
  }
}

async function exportBackup() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `content-studio-backup-${todayStr()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    alert('That file could not be read. Pick the .json backup file this app saved.');
    input.value = '';
    return;
  }

  const looksLikeBackup = payload && typeof payload === 'object'
    && Array.isArray(payload.ideas) && Array.isArray(payload.postLog) && payload.calendar && payload.settings;
  if (!looksLikeBackup) {
    alert('That file does not look like a Content Studio backup.');
    input.value = '';
    return;
  }

  if (!confirm('This replaces everything currently in the app with the backup. Continue?')) {
    input.value = '';
    return;
  }

  store = payload;
  saveDb(store);
  input.value = '';
  closeModal('settings-modal');
  deck = store.ideas.filter(i => i.status === 'new');
  renderDeck();
  renderCalendar();
  renderStreak();
  showToast('Backup restored');
}

function resetAllData() {
  if (!confirm('This permanently deletes every idea, calendar entry, and your streak history. Continue?')) return;
  localStorage.removeItem('contentStudioDb');
  store = loadDb();
  deck = [];
  selectedBacklogId = null;
  closeModal('settings-modal');
  renderDeck();
  renderCalendar();
  renderStreak();
  ensureIdeaSupply();
  showToast('All data reset');
}

/* ---------------- Modal helpers ---------------- */
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
});
