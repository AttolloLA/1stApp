// ════════════════════════════════════════════════════════
// FIREBASE INITIALIZATION — v10 CDN ES module imports
// ════════════════════════════════════════════════════════
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey:            "AIzaSyAHsyDPu8XJnfRS4EuQNHiujD38j69SZh0",
  authDomain:        "attollo-dashboard.firebaseapp.com",
  projectId:         "attollo-dashboard",
  storageBucket:     "attollo-dashboard.firebasestorage.app",
  messagingSenderId: "999488977671",
  appId:             "1:999488977671:web:d7e007631f29abf46ae3a2"
};

const app      = initializeApp(firebaseConfig);
const db       = getFirestore(app);
const auth     = getAuth(app);
const provider = new GoogleAuthProvider();

// ════════════════════════════════════════════════════════
// MUTABLE COLLECTION REFS
// These are null until a user signs in. Every Firestore
// operation uses these, so they automatically point to
// the right user's private subcollection.
//
// Data lives at: users/{uid}/tasks, users/{uid}/completedTasks, users/{uid}/wins
// ════════════════════════════════════════════════════════
let tasksRef     = null;
let completedRef = null;
let winsRef      = null;

// Unsubscribe handles — called when the user signs out to stop listeners
let unsubTasks     = null;
let unsubCompleted = null;
let unsubWins      = null;

// ════════════════════════════════════════════════════════
// CLOCK & DATE — no auth required, starts immediately
// ════════════════════════════════════════════════════════
function updateClock() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  document.getElementById('clock').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('date').textContent =
    `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()} ${now.getFullYear()}`;
}
setInterval(updateClock, 1000);
updateClock();

// ════════════════════════════════════════════════════════
// DAILY INTENTIONS v2 — Firestore real-time sync
// Active tasks:    users/{uid}/tasks
// Completed tasks: users/{uid}/completedTasks
// ════════════════════════════════════════════════════════
const taskList       = document.getElementById('intentions');
const archiveListEl  = document.getElementById('archive-list');
const archiveEmpty   = document.getElementById('archive-empty');
const archiveSection = document.getElementById('archive-section');
const archiveToggle  = document.getElementById('archive-toggle');

// Local cache — updated by onSnapshot, used for fractional ordering & archive render
let liveTasks           = [];
let latestCompletedDocs = [];

// Build one active task row with all Firestore-backed events
function createTaskRow(task) {
  const item = document.createElement('div');
  item.className = 'intention-item';
  item.dataset.id = task.id;

  // ── Checkbox: triggers fade-out animation then moves task to completedTasks ──
  const cb = document.createElement('input');
  cb.type    = 'checkbox';
  cb.checked = false;

  cb.addEventListener('change', () => {
    if (!cb.checked) return;
    item.classList.add('completing'); // CSS fade-out animation

    setTimeout(async () => {
      await deleteDoc(doc(tasksRef, task.id));
      await addDoc(completedRef, {
        text:        task.text,
        completedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      if (archiveSection.classList.contains('open')) renderArchive();
    }, 1000);
  });

  // ── Text input: debounced Firestore write ──
  const input = document.createElement('input');
  input.type        = 'text';
  input.value       = task.text;
  input.placeholder = 'Add an intention…';

  let debounceTimer;
  input.addEventListener('input', () => {
    task.text = input.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      updateDoc(doc(tasksRef, task.id), { text: input.value });
    }, 400);
  });

  // ── Enter key: insert new blank task below using fractional indexing ──
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();

    const idx      = liveTasks.findIndex(t => t.id === task.id);
    const current  = liveTasks[idx]?.order     ?? Date.now();
    const next     = liveTasks[idx + 1]?.order ?? (current + 2000);
    const newOrder = (current + next) / 2;

    const docRef = await addDoc(tasksRef, {
      text: '', order: newOrder, createdAt: serverTimestamp()
    });
    setTimeout(() => {
      taskList.querySelector(`[data-id="${docRef.id}"]`)
        ?.querySelector('input[type="text"]')?.focus();
    }, 150);
  });

  // ── Delete button ──
  const del = document.createElement('button');
  del.className   = 'intention-del';
  del.textContent = '✕';
  del.title       = 'Remove';
  del.addEventListener('click', () => deleteDoc(doc(tasksRef, task.id)));

  item.append(cb, input, del);
  return item;
}

// Called by onSnapshot every time 'tasks' changes on ANY device
function renderTasksFromSnapshot(snapshot) {
  liveTasks = snapshot.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Bootstrap: if the user's task list is empty, seed one blank task
  if (liveTasks.length === 0) {
    addDoc(tasksRef, { text: '', order: Date.now(), createdAt: serverTimestamp() });
    return; // onSnapshot will fire again with the new doc
  }

  taskList.innerHTML = '';
  liveTasks.forEach(task => taskList.appendChild(createTaskRow(task)));
}

// Render completed tasks archive from our local cache
function renderArchive() {
  archiveListEl.innerHTML = '';
  if (latestCompletedDocs.length === 0) {
    archiveEmpty.style.display = 'block';
    return;
  }
  archiveEmpty.style.display = 'none';
  latestCompletedDocs.forEach(t => {
    const row   = document.createElement('div');
    row.className = 'archive-item';
    const check = document.createElement('span');
    check.className = 'archive-item-check'; check.textContent = '✓';
    const text  = document.createElement('span');
    text.className  = 'archive-item-text';  text.textContent = t.text || '(untitled)';
    const time  = document.createElement('span');
    time.className  = 'archive-item-time';  time.textContent = t.completedAt;
    row.append(check, text, time);
    archiveListEl.appendChild(row);
  });
}

// Archive panel toggle
archiveToggle.addEventListener('click', () => {
  const isOpen = archiveSection.classList.toggle('open');
  archiveToggle.querySelector('.archive-eye').textContent = isOpen ? '◉' : '◎';
  if (isOpen) renderArchive();
});

// ════════════════════════════════════════════════════════
// QUOTES — 10 Stoic + 10 Sales/Mindset — no auth required
// ════════════════════════════════════════════════════════
const quotes = [
  { category: 'stoic', text: "You have power over your mind — not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius" },
  { category: 'stoic', text: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius" },
  { category: 'stoic', text: "Waste no more time arguing what a good man should be. Be one.", author: "Marcus Aurelius" },
  { category: 'stoic', text: "It is not that I am brave — I simply choose which fears to listen to.", author: "Marcus Aurelius" },
  { category: 'stoic', text: "Luck is what happens when preparation meets opportunity.", author: "Seneca" },
  { category: 'stoic', text: "Begin at once to live, and count each separate day as a separate life.", author: "Seneca" },
  { category: 'stoic', text: "He suffers more than necessary who suffers before it is necessary.", author: "Seneca" },
  { category: 'stoic', text: "No man is free who is not master of himself.", author: "Epictetus" },
  { category: 'stoic', text: "Seek not that things happen as you wish; wish for things as they are — and you will have a tranquil flow of life.", author: "Epictetus" },
  { category: 'stoic', text: "First say to yourself what you would be; then do what you have to do.", author: "Epictetus" },
  { category: 'sales', text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { category: 'sales', text: "Every sale has five basic obstacles: no need, no money, no hurry, no desire, no trust.", author: "Zig Ziglar" },
  { category: 'sales', text: "Your attitude, not your aptitude, will determine your altitude.", author: "Zig Ziglar" },
  { category: 'sales', text: "Success is not delivered. It is taken — aggressively, relentlessly, every single day.", author: "Grant Cardone" },
  { category: 'sales', text: "Obscurity is a bigger problem than money. Get so visible that people can't ignore you.", author: "Grant Cardone" },
  { category: 'sales', text: "The biggest difference between professional salespeople and amateurs is their attitude toward rejection.", author: "Brian Tracy" },
  { category: 'sales', text: "The more you learn, the more you earn. Invest in yourself — it pays the best interest.", author: "Brian Tracy" },
  { category: 'sales', text: "People don't buy for logical reasons. They buy for emotional reasons.", author: "Zig Ziglar" },
  { category: 'sales', text: "Champions are made from something deep inside — a desire, a dream, a vision.", author: "Muhammad Ali" },
  { category: 'sales', text: "The future belongs to those who prepare for it today.", author: "Malcolm X" },
];

(function renderOneTruth() {
  const now  = new Date();
  const seed = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  let hash = 0;
  for (const ch of seed) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  const q       = quotes[hash % quotes.length];
  const isSales = q.category === 'sales';
  const catEl   = document.getElementById('truth-category');
  document.getElementById('truth-text').textContent   = `\u201c${q.text}\u201d`;
  document.getElementById('truth-author').textContent = `\u2014 ${q.author}`;
  catEl.textContent = isSales ? 'Sales & Mindset' : 'Stoic Philosophy';
  catEl.classList.toggle('sales-cat', isSales);
})();

// ════════════════════════════════════════════════════════
// WEATHER — Open-Meteo, no API key — starts immediately
// ════════════════════════════════════════════════════════
const WMO = {
  0:  { icon: '☀️', desc: 'Clear sky' },        1:  { icon: '🌤', desc: 'Mainly clear' },
  2:  { icon: '⛅', desc: 'Partly cloudy' },     3:  { icon: '☁️', desc: 'Overcast' },
  45: { icon: '🌫', desc: 'Foggy' },             48: { icon: '🌫', desc: 'Icy fog' },
  51: { icon: '🌦', desc: 'Light drizzle' },     53: { icon: '🌦', desc: 'Drizzle' },
  55: { icon: '🌦', desc: 'Heavy drizzle' },     61: { icon: '🌧', desc: 'Light rain' },
  63: { icon: '🌧', desc: 'Rain' },              65: { icon: '🌧', desc: 'Heavy rain' },
  71: { icon: '❄️', desc: 'Light snow' },        73: { icon: '❄️', desc: 'Snow' },
  75: { icon: '❄️', desc: 'Heavy snow' },        80: { icon: '🌦', desc: 'Rain showers' },
  81: { icon: '🌧', desc: 'Heavy showers' },     95: { icon: '⛈', desc: 'Thunderstorm' },
  96: { icon: '⛈', desc: 'Thunderstorm' },      99: { icon: '⛈', desc: 'Thunderstorm' },
};

async function fetchWeather() {
  let lat = 40.71, lon = -74.01, city = 'New York';
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
    );
    lat = pos.coords.latitude; lon = pos.coords.longitude;
    const geo = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`
    ).then(r => r.json());
    city = geo.address.city || geo.address.town || geo.address.village || 'Your City';
  } catch (_) {}
  try {
    const meteo = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode&temperature_unit=celsius`
    ).then(r => r.json());
    const { icon, desc } = WMO[meteo.current.weathercode] || { icon: '🌡', desc: '' };
    document.getElementById('weather-location').textContent = city;
    document.getElementById('weather-icon').textContent     = icon;
    document.getElementById('weather-temp').textContent     = `${Math.round(meteo.current.temperature_2m)}°C`;
    document.getElementById('weather-desc').textContent     = desc;
  } catch (_) { document.getElementById('weather-desc').textContent = 'Unavailable'; }
}
fetchWeather();

// ════════════════════════════════════════════════════════
// REVENUE TRACKER — localStorage, device-local — no auth
// ════════════════════════════════════════════════════════
const loadSales = () => JSON.parse(localStorage.getItem('rev_sales') || '[]');
const saveSales = s  => localStorage.setItem('rev_sales', JSON.stringify(s));
const fmt       = n  => '€' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

function renderRevenue() {
  const sales = loadSales();
  const goal  = parseFloat(localStorage.getItem('rev_goal')) || 0;
  const total = sales.reduce((sum, s) => sum + s.amount, 0);
  document.getElementById('revenue-total').textContent = fmt(total);
  const goalInput = document.getElementById('goal-input');
  if (document.activeElement !== goalInput) goalInput.value = goal || '';
  const pct = goal > 0 ? Math.min((total / goal) * 100, 100) : 0;
  document.getElementById('progress-fill').style.width      = pct + '%';
  document.getElementById('progress-pct').textContent       = goal > 0 ? `${Math.round(pct)}% of goal` : '0% — set a goal';
  document.getElementById('progress-remaining').textContent = goal > 0
    ? (goal - total > 0 ? `${fmt(goal - total)} to go` : '🎉 Goal smashed!') : '';
  const list = document.getElementById('sales-list');
  list.innerHTML = '';
  [...sales].reverse().forEach(sale => {
    const row = document.createElement('div');
    row.className = 'sale-item';
    row.innerHTML = `
      <span class="sale-label">${sale.label || 'Unnamed deal'}</span>
      <span class="sale-date">${sale.date}</span>
      <span class="sale-amt">${fmt(sale.amount)}</span>
      <button class="sale-delete" data-id="${sale.id}" title="Remove">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.sale-delete').forEach(btn =>
    btn.addEventListener('click', () => { saveSales(loadSales().filter(s => s.id !== btn.dataset.id)); renderRevenue(); })
  );
}

document.getElementById('goal-input').addEventListener('change', e => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val) && val >= 0) localStorage.setItem('rev_goal', val);
  renderRevenue();
});
document.getElementById('add-sale-btn').addEventListener('click', () => {
  const amtInput = document.getElementById('sale-amount');
  const lblInput = document.getElementById('sale-label');
  const amount   = parseFloat(amtInput.value);
  if (isNaN(amount) || amount <= 0) {
    amtInput.style.borderColor = '#e05a5a';
    setTimeout(() => amtInput.style.borderColor = '', 900);
    amtInput.focus(); return;
  }
  const sales = loadSales();
  sales.push({ id: Date.now().toString(), amount, label: lblInput.value.trim(),
    date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) });
  saveSales(sales); amtInput.value = ''; lblInput.value = ''; renderRevenue();
});
['sale-amount','sale-label'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('add-sale-btn').click();
  })
);
document.getElementById('reset-revenue').addEventListener('click', () => {
  if (confirm('Reset all sales for this month? Your goal will stay.')) { saveSales([]); renderRevenue(); }
});
renderRevenue();

// ════════════════════════════════════════════════════════
// MINDSET REFRAMER — no auth required
// ════════════════════════════════════════════════════════
const perspectives = [
  { lens: 'Dichotomy of Control',     text: 'You control the effort, not the outcome. Did you show up fully? Then you have already won where it truly counts.' },
  { lens: 'Amor Fati — Love of Fate', text: 'This rejection is exactly what you need to sharpen your next pitch. Every "no" is the universe handing you a free lesson. Love the challenge.' },
  { lens: 'Premeditatio Malorum',     text: 'The worst happened — a "no." You are still standing, still breathing, still capable. What is the single next logical step forward?' },
];
let lastPerspective = -1;

document.getElementById('reframe-btn').addEventListener('click', () => {
  let idx;
  do { idx = Math.floor(Math.random() * perspectives.length); } while (idx === lastPerspective);
  lastPerspective = idx;
  const response = document.getElementById('reframe-response');
  response.classList.remove('visible');
  setTimeout(() => {
    document.getElementById('reframe-lens').textContent = perspectives[idx].lens;
    document.getElementById('reframe-text').textContent = perspectives[idx].text;
    response.classList.add('visible');
  }, 300);
});

// ════════════════════════════════════════════════════════
// DAILY MOMENTUM — localStorage, daily auto-reset — no auth
// ════════════════════════════════════════════════════════
(function initMomentum() {
  const now      = new Date();
  const todayKey = `momentum_${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const circlesEl = document.getElementById('momentum-circles');
  let state = JSON.parse(localStorage.getItem(todayKey) || 'null');
  if (!state) state = Array(10).fill(false);
  function save() { localStorage.setItem(todayKey, JSON.stringify(state)); }
  function render() {
    circlesEl.innerHTML = '';
    state.forEach((active, i) => {
      const dot = document.createElement('button');
      dot.className = 'win-dot' + (active ? ' active' : '');
      dot.title     = active ? 'Win logged!' : 'Click to log a win';
      dot.addEventListener('click', () => { state[i] = !state[i]; save(); render(); });
      circlesEl.appendChild(dot);
    });
  }
  render();
})();

// ════════════════════════════════════════════════════════
// HALL OF FAME — win log render & button
// The onSnapshot listener is started in startFirestoreListeners() after login.
// The button handler is wired once here — winsRef will be set by the time
// the user can interact with it (the dashboard is only visible after login).
// ════════════════════════════════════════════════════════
function formatWinDate(isoString) {
  const d      = new Date(isoString);
  const pad    = n => String(n).padStart(2, '0');
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}  ·  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderWinsFromSnapshot(snapshot) {
  const listEl = document.getElementById('wins-list');
  listEl.innerHTML = '';
  if (snapshot.empty) {
    listEl.innerHTML = '<p class="wins-empty">Your victories will live here. Log your first win.</p>';
    return;
  }
  const wins = snapshot.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  wins.forEach(win => {
    const entry = document.createElement('div');
    entry.className = 'win-entry';
    entry.innerHTML = `<p class="win-note">${win.note}</p><p class="win-timestamp">${formatWinDate(win.timestamp)}</p>`;
    listEl.appendChild(entry);
  });
}

function flashHeatmap() {
  const dots = document.querySelectorAll('.win-dot');
  dots.forEach(dot => { dot.classList.remove('flash'); void dot.offsetWidth; dot.classList.add('flash'); });
  setTimeout(() => dots.forEach(dot => dot.classList.remove('flash')), 2100);
}

document.getElementById('log-win-btn').addEventListener('click', async () => {
  const inputEl = document.getElementById('win-input');
  const note    = inputEl.value.trim();
  if (!note || !winsRef) return; // guard: won't run if not logged in
  await addDoc(winsRef, { note, timestamp: new Date().toISOString() });
  inputEl.value = '';
  flashHeatmap();
});

// ════════════════════════════════════════════════════════
// SALES SCRIPT TELEPROMPTER — no auth required
// ════════════════════════════════════════════════════════
(function initTeleprompter() {
  const overlay  = document.getElementById('script-overlay');
  const toggle   = document.getElementById('script-toggle');
  const closeBtn = document.getElementById('script-close');
  const cards    = document.querySelectorAll('.objection-card');
  const open  = () => { overlay.classList.add('open');    document.body.style.overflow = 'hidden'; };
  const close = () => { overlay.classList.remove('open'); document.body.style.overflow = ''; };
  toggle.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const isActive = card.classList.contains('active');
      cards.forEach(c => c.classList.remove('active'));
      if (!isActive) card.classList.add('active');
    });
  });
})();

// ════════════════════════════════════════════════════════
// AUTH — STATE MANAGEMENT
// ════════════════════════════════════════════════════════

// Start all three Firestore real-time listeners for the signed-in user.
// Each user's data lives under users/{uid}/... so data is fully private.
function startFirestoreListeners(user) {
  const uid = user.uid;
  tasksRef     = collection(db, 'users', uid, 'tasks');
  completedRef = collection(db, 'users', uid, 'completedTasks');
  winsRef      = collection(db, 'users', uid, 'wins');

  // Active tasks — ordered by fractional 'order' field
  unsubTasks = onSnapshot(
    query(tasksRef, orderBy('order')),
    renderTasksFromSnapshot
  );

  // Completed tasks — update cache, refresh archive panel if open
  unsubCompleted = onSnapshot(completedRef, snapshot => {
    latestCompletedDocs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    if (archiveSection.classList.contains('open')) renderArchive();
  });

  // Hall of Fame wins — real-time sync across all devices
  unsubWins = onSnapshot(winsRef, renderWinsFromSnapshot);
}

// Stop all listeners and clear the UI when the user signs out
function stopFirestoreListeners() {
  unsubTasks?.();     unsubTasks     = null;
  unsubCompleted?.(); unsubCompleted = null;
  unsubWins?.();      unsubWins      = null;
  // Clear live data from the UI
  taskList.innerHTML = '';
  document.getElementById('wins-list').innerHTML = '';
  archiveListEl.innerHTML = '';
  liveTasks = []; latestCompletedDocs = [];
  // Reset refs so no stale writes can happen
  tasksRef = null; completedRef = null; winsRef = null;
}

// ── UI Transitions ───────────────────────────────────────
const loginScreen = document.getElementById('login-screen');

function showDashboard(user) {
  // Show the signed-in user's first name next to Sign Out
  const nameEl = document.getElementById('user-display-name');
  if (nameEl) nameEl.textContent = user.displayName?.split(' ')[0] || 'Coach';

  // Fade the login overlay out, then remove it from the layout
  loginScreen.classList.add('fade-out');
  loginScreen.addEventListener('transitionend', () => {
    loginScreen.classList.add('hidden');
  }, { once: true }); // 'once' ensures this only fires one time
}

function showLoginScreen() {
  // Remove 'hidden' first, force a reflow, then remove 'fade-out' to re-show
  loginScreen.classList.remove('hidden');
  void loginScreen.offsetWidth; // forces browser to recalculate layout
  loginScreen.classList.remove('fade-out');
}

// ── Auth State Observer ──────────────────────────────────
// Fires immediately on page load with the cached auth state,
// so returning users never see the login screen flash.
onAuthStateChanged(auth, user => {
  if (user) {
    startFirestoreListeners(user);
    showDashboard(user);
  } else {
    stopFirestoreListeners();
    showLoginScreen();
  }
});

// ── Sign In ──────────────────────────────────────────────
document.getElementById('google-signin-btn').addEventListener('click', () => {
  signInWithPopup(auth, provider).catch(err => {
    console.error('Google sign-in failed:', err.message);
  });
});

// ── Sign Out ─────────────────────────────────────────────
document.getElementById('signout-btn').addEventListener('click', () => {
  if (confirm('Sign out of your Attollo dashboard?')) signOut(auth);
});
