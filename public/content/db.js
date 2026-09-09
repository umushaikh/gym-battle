const DB_KEY = 'contentStudioDb';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadDb() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.ideas) parsed.ideas = [];
      if (!parsed.calendar) parsed.calendar = {};
      if (!parsed.postLog) parsed.postLog = [];
      if (!parsed.settings) parsed.settings = {};
      if (parsed.settings.apiKey === undefined) parsed.settings.apiKey = '';
      if (parsed.settings.niche === undefined) parsed.settings.niche = '';
      if (parsed.settings.reminderTime === undefined) parsed.settings.reminderTime = '18:00';
      if (parsed.settings.remindersEnabled === undefined) parsed.settings.remindersEnabled = false;
      return parsed;
    } catch {
      // fall through and reseed a fresh db below
    }
  }
  const seeded = {
    ideas: [],
    calendar: {},
    postLog: [],
    settings: {
      apiKey: '',
      niche: '',
      reminderTime: '18:00',
      remindersEnabled: false
    }
  };
  saveDb(seeded);
  return seeded;
}

function saveDb(store) {
  localStorage.setItem(DB_KEY, JSON.stringify(store));
  syncMetaToServiceWorker(store);
}

// Service workers can't read localStorage, so the handful of fields the
// background reminder check needs (whether reminders are on, what time, and
// today's post state) get mirrored into IndexedDB on every save. Best-effort:
// if IndexedDB isn't available for some reason, the app still works fine —
// only the background nudge degrades to foreground-only.
function syncMetaToServiceWorker(store) {
  if (!('indexedDB' in window)) return;
  const meta = {
    remindersEnabled: store.settings.remindersEnabled,
    reminderTime: store.settings.reminderTime,
    postedToday: store.postLog.includes(todayStr()),
    today: todayStr(),
    streak: computeStreak(store.postLog).current
  };
  try {
    const req = indexedDB.open('content-studio-meta', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(meta, 'reminder');
      tx.oncomplete = () => db.close();
    };
    req.onerror = () => {};
  } catch {
    // ignore — background reminder just won't have fresh data
  }
}

// Longest run counts backwards from `today` (or from yesterday if today
// hasn't been logged yet — the streak isn't broken until a whole day is
// missed, not the instant the clock passes midnight with nothing logged yet).
function computeStreak(postLog) {
  const dates = new Set(postLog);
  const today = new Date();
  let current = 0;
  let cursor = new Date(today);
  if (!dates.has(todayStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (dates.has(todayStr(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const sorted = [...dates].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    if (prev) {
      const prevDate = new Date(prev);
      const expected = new Date(prevDate);
      expected.setDate(expected.getDate() + 1);
      run = todayStr(expected) === d ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = d;
  }

  return { current, longest: Math.max(longest, current) };
}
