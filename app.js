// ── FIREBASE / AUTH / SYNC ───────────────────────────────
let _fbAuth = null;
let _fbDb   = null;
let _currentUser = null;
let _syncTimer = null;
let _accountMode = 'signin';

function _hideAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  gate.style.opacity = '0';
  gate.style.pointerEvents = 'none';
  setTimeout(() => { gate.style.display = 'none'; }, 450);
  updateProfileAvatarBtn();
}

function _showAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  gate.style.display = 'flex';
  gate.style.pointerEvents = 'all';
  requestAnimationFrame(() => gate.style.opacity = '1');
  // Show landing state (title + buttons), not the form
  _showAuthGateLanding();
}

function _showAuthGateLanding() {
  const landing = document.getElementById('auth-gate-landing');
  const formEl  = document.getElementById('auth-gate-form');
  if (landing) landing.style.display = 'flex';
  if (formEl)  { formEl.classList.add('auth-gate-form-hidden'); formEl.innerHTML = ''; }
}

function showAuthGateForm(mode) {
  _accountMode = mode || 'signin';
  const landing = document.getElementById('auth-gate-landing');
  const formEl  = document.getElementById('auth-gate-form');
  if (landing) landing.style.display = 'none';
  if (formEl)  formEl.classList.remove('auth-gate-form-hidden');
  renderAuthGateForm();
}

async function authGoogleSignIn() {
  if (!_fbAuth) { alert('Firebase not configured yet. Fill in firebase-config.js first.'); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await _fbAuth.signInWithPopup(provider);
  } catch(e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-cancelled-by-user') {
      await _fbAuth.signInWithRedirect(provider);
    } else if (e.code === 'auth/popup-closed-by-user') {
      // user dismissed — do nothing
    } else {
      alert('Google sign-in error: ' + (e.code || e.message));
    }
  }
}

async function authAppleSignIn() {
  if (!_fbAuth) { alert('Firebase not configured yet. Fill in firebase-config.js first.'); return; }
  const provider = new firebase.auth.OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  try {
    await _fbAuth.signInWithPopup(provider);
  } catch(e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-cancelled-by-user') {
      await _fbAuth.signInWithRedirect(provider);
    } else if (e.code !== 'auth/popup-closed-by-user') {
      showAuthError(e.code);
    }
  }
}

function initFirebase() {
  // Always start with buttons visible — no loading delay
  _showAuthGateLanding();

  if (typeof FIREBASE_CONFIG === 'undefined' || FIREBASE_CONFIG.apiKey.startsWith('PASTE')) {
    return;
  }

  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    _fbAuth = firebase.auth();
    _fbDb   = firebase.firestore();

    // Force auth state to persist across page reloads (critical for iOS)
    _fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

    // Handle redirect result — iOS often converts popups to redirects
    _fbAuth.getRedirectResult().then(result => {
      if (result && result.user) {
        _currentUser = result.user;
        _hideAuthGate();
        loadFromCloud();
        refreshAccountArea();
      }
    }).catch(e => {
      if (e.code && e.code !== 'auth/no-current-user') {
        showAuthError(e.code);
      }
    });

    // Save ?add= param to localStorage before it gets wiped by auth redirects
    const params = new URLSearchParams(window.location.search);
    const addUidParam = params.get('add');
    const joinGroupParam = params.get('joingroup');
    if (addUidParam) {
      localStorage.setItem('pendingFriendAdd', addUidParam);
      window.history.replaceState({}, '', window.location.href.split('?')[0]);
    }
    if (joinGroupParam) {
      localStorage.setItem('pendingGroupJoin', joinGroupParam);
      window.history.replaceState({}, '', window.location.href.split('?')[0]);
    }

    _fbAuth.onAuthStateChanged(async user => {
      _currentUser = user;
      if (user) {
        _hideAuthGate();
        loadFromCloud();
        const pendingUid = localStorage.getItem('pendingFriendAdd');
        if (pendingUid && pendingUid !== user.uid) {
          localStorage.removeItem('pendingFriendAdd');
          await _handleFriendAdd(pendingUid);
        }
        const pendingGroup = localStorage.getItem('pendingGroupJoin');
        if (pendingGroup) {
          localStorage.removeItem('pendingGroupJoin');
          await joinGroup(pendingGroup);
          alert('You joined the group! Check the Friends tab.');
        }
      } else {
        _showAuthGateLanding();
      }
      refreshAccountArea();
    });
  } catch(e) {
    // On any Firebase error, keep gate showing with the buttons
    _showAuthGateLanding();
  }
}

async function _handleFriendAdd(friendUid) {
  if (!_currentUser || !_fbDb) { alert('Friend add failed: not logged in or database unavailable.'); return; }
  try {
    const myUid = _currentUser.uid;
    await _fbDb.collection('users').doc(myUid).set({
      friends: firebase.firestore.FieldValue.arrayUnion(friendUid)
    }, { merge: true });
    await _fbDb.collection('users').doc(friendUid).set({
      friends: firebase.firestore.FieldValue.arrayUnion(myUid)
    }, { merge: true });
    renderFriends();
  } catch(e) {
    alert('Friend add failed: ' + (e.code || e.message));
    console.error('Friend add failed:', e);
  }
}

async function removeFriend(friendUid) {
  if (!_currentUser || !_fbDb) return;
  if (!confirm('Remove this friend?')) return;
  try {
    await _fbDb.collection('users').doc(_currentUser.uid).update({
      friends: firebase.firestore.FieldValue.arrayRemove(friendUid)
    });
    renderFriends();
  } catch(e) {
    alert('Could not remove friend: ' + (e.code || e.message));
  }
}

function queueSync() {
  if (!_currentUser || !_fbDb) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncToCloud, 2500);
}

async function syncToCloud() {
  if (!_currentUser || !_fbDb) return;
  try {
    await _fbDb.collection('users').doc(_currentUser.uid).set({
      habitData:    JSON.parse(localStorage.getItem('habitData')    || '{}'),
      grateful:     JSON.parse(localStorage.getItem('grateful')     || '{}'),
      customHabits: JSON.parse(localStorage.getItem('customHabits') || '[]'),
      habitOrder:   JSON.parse(localStorage.getItem('habitOrder')   || '[]'),
      colorTheme:   localStorage.getItem('colorTheme') || 'default',
      email:        _currentUser.email || '',
      displayName:  localStorage.getItem('displayName') || '',
      bio:          localStorage.getItem('bio') || '',
      photoDataUrl: localStorage.getItem('photoDataUrl') || '',
      lastSync:     firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const lbl = document.getElementById('sync-label');
    if (lbl) lbl.textContent = '✓ Synced';
  } catch(e) { console.warn('Sync failed:', e); }
}

async function loadFromCloud() {
  if (!_currentUser || !_fbDb) return;
  try {
    const doc = await _fbDb.collection('users').doc(_currentUser.uid).get();
    if (!doc.exists) { syncToCloud(); return; }
    const d = doc.data();
    if (d.habitData)    localStorage.setItem('habitData',    JSON.stringify(d.habitData));
    if (d.grateful)     localStorage.setItem('grateful',     JSON.stringify(d.grateful));
    if (d.customHabits) localStorage.setItem('customHabits', JSON.stringify(d.customHabits));
    if (d.habitOrder)   localStorage.setItem('habitOrder',   JSON.stringify(d.habitOrder));
    if (d.colorTheme)   localStorage.setItem('colorTheme',   d.colorTheme);
    localStorage.setItem('displayName', d.displayName || '');
    localStorage.setItem('bio',         d.bio || '');
    localStorage.setItem('photoDataUrl', d.photoDataUrl || '');
    applyTheme();
    buildHabitCards();
    render();
    renderJournal();
    if (currentPage === 0) renderProgress();
    refreshAccountArea();
    updateProfileAvatarBtn();
  } catch(e) { console.warn('Load from cloud failed:', e); }
}

function getAuthErrorMsg(code) {
  const msgs = {
    'auth/user-not-found':            'No account with that email.',
    'auth/wrong-password':            'Incorrect password.',
    'auth/email-already-in-use':      'Email already has an account.',
    'auth/weak-password':             'Password must be at least 6 characters.',
    'auth/invalid-email':             'Invalid email address.',
    'auth/invalid-credential':        'Wrong email or password.',
    'auth/operation-not-allowed':     'Email sign-in is not enabled. Contact support.',
    'auth/too-many-requests':         'Too many attempts. Try again later.',
    'auth/network-request-failed':    'Network error. Check your connection.',
    'auth/unauthorized-continue-uri': 'Reset email config error. Contact support.',
  };
  return msgs[code] || `Something went wrong (${code}). Try again.`;
}

function renderAuthGateForm() {
  const el = document.getElementById('auth-gate-form');
  if (!el) return;
  const isCreate = _accountMode === 'create';
  el.innerHTML = `
    <div class="account-form-toggle">
      <button type="button" class="${!isCreate ? 'active' : ''}" onclick="setAuthMode('signin');renderAuthGateForm()">Sign In</button>
      <button type="button" class="${isCreate ? 'active' : ''}" onclick="setAuthMode('create');renderAuthGateForm()">Create Account</button>
    </div>
    <form id="gate-form" autocomplete="on" onsubmit="submitGateAuth();return false;">
      ${isCreate ? `<input type="text" id="gate-name" name="name" class="account-input" placeholder="Your name"
             autocomplete="name" autocapitalize="words" autocorrect="off" spellcheck="false"/>` : ''}
      <input type="email" id="gate-email" name="email" class="account-input" placeholder="Email address"
             autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false"/>
      <input type="password" id="gate-password" name="password" class="account-input" placeholder="Password"
             autocomplete="${isCreate ? 'new-password' : 'current-password'}"/>
      <div class="auth-error" id="gate-error"></div>
      <button type="submit" class="account-submit-btn" id="gate-submit-btn">${isCreate ? 'Create Account' : 'Sign In'}</button>
    </form>
    ${!isCreate ? `<button type="button" class="auth-gate-back-link" style="color:#666;font-size:0.8rem;margin-top:2px" onclick="sendPasswordReset()">Forgot password?</button>` : ''}
    <button type="button" class="auth-gate-back-link" onclick="_showAuthGateLanding()">← Back</button>
  `;
}

function submitGateAuth() {
  if (!_fbAuth) return;
  const isCreate = _accountMode === 'create';
  const name   = document.getElementById('gate-name')?.value.trim();
  const email  = document.getElementById('gate-email')?.value.trim();
  const pw     = document.getElementById('gate-password')?.value;
  const errEl  = document.getElementById('gate-error');
  const btn    = document.getElementById('gate-submit-btn');
  if (isCreate && !name) { if (errEl) errEl.textContent = 'Please enter your name.'; return; }
  if (!email || !pw) { if (errEl) errEl.textContent = 'Please enter email and password.'; return; }
  if (btn) { btn.textContent = 'Please wait…'; btn.disabled = true; }
  if (errEl) errEl.textContent = '';
  if (isCreate) {
    _fbAuth.createUserWithEmailAndPassword(email, pw).then(cred => {
      // Save display name to Firebase Auth profile
      return cred.user.updateProfile({ displayName: name }).then(() => {
        // Save to localStorage and Firestore
        localStorage.setItem('displayName', name);
        if (_fbDb) {
          _fbDb.collection('users').doc(cred.user.uid).set({ displayName: name, email }, { merge: true });
        }
        updateProfileAvatarBtn();
      });
    }).catch(e => {
      if (errEl) errEl.textContent = getAuthErrorMsg(e.code);
      if (btn) { btn.textContent = 'Create Account'; btn.disabled = false; }
    });
  } else {
    _fbAuth.signInWithEmailAndPassword(email, pw).catch(e => {
      if (errEl) errEl.textContent = getAuthErrorMsg(e.code);
      if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
    });
  }
}

function sendPasswordReset() {
  if (!_fbAuth) return;
  const email = document.getElementById('gate-email')?.value.trim();
  const errEl = document.getElementById('gate-error');
  if (!email) { if (errEl) { errEl.style.color = ''; errEl.textContent = 'Enter your email above first.'; } return; }
  if (errEl) { errEl.style.color = '#888'; errEl.textContent = 'Sending…'; }
  _fbAuth.sendPasswordResetEmail(email)
    .then(() => { if (errEl) { errEl.style.color = '#4ade80'; errEl.textContent = 'Reset email sent! Check your inbox (and spam).'; } })
    .catch(e => { console.error('Reset error:', e.code, e.message); if (errEl) { errEl.style.color = '#f87171'; errEl.textContent = getAuthErrorMsg(e.code); } });
}

async function authSignIn(email, password) {
  if (!_fbAuth) return;
  try { await _fbAuth.signInWithEmailAndPassword(email, password); }
  catch(e) { showAuthError(e.code); }
}

async function authCreate(email, password) {
  if (!_fbAuth) return;
  try { await _fbAuth.createUserWithEmailAndPassword(email, password); }
  catch(e) { showAuthError(e.code); }
}

async function authSignOut() {
  if (_fbAuth) await _fbAuth.signOut();
  _currentUser = null;
  closeDrawer();
  updateProfileAvatarBtn();
  // Let drawer close before gate appears
  setTimeout(() => _showAuthGate(), 250);
}

function showAuthError(code) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = getAuthErrorMsg(code);
}

function refreshAccountArea() {
  const area = document.getElementById('account-status-area');
  if (area) renderAccountStatus(area);
}

function _getProfileInitial() {
  const displayName = localStorage.getItem('displayName') || '';
  if (displayName) return displayName.charAt(0).toUpperCase();
  if (_currentUser && _currentUser.email) return _currentUser.email.charAt(0).toUpperCase();
  return '?';
}

function updateProfileAvatarBtn() {
  const btn = document.getElementById('profile-avatar-btn');
  if (!btn) return;
  if (!_currentUser) {
    btn.classList.remove('visible');
    return;
  }
  btn.classList.add('visible');
  const photoDataUrl = localStorage.getItem('photoDataUrl') || '';
  if (photoDataUrl) {
    btn.innerHTML = `<img src="${photoDataUrl}" alt="profile" />`;
  } else {
    btn.innerHTML = _getProfileInitial();
  }
}

function renderAccountStatus(container) {
  if (_currentUser) {
    const email = _currentUser.email;
    const displayName = localStorage.getItem('displayName') || '';
    const bio = localStorage.getItem('bio') || '';
    const photoDataUrl = localStorage.getItem('photoDataUrl') || '';
    const initial = _getProfileInitial();
    const created = _currentUser.metadata?.creationTime
      ? new Date(_currentUser.metadata.creationTime).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : '';
    const avatarContent = photoDataUrl
      ? `<img src="${photoDataUrl}" alt="profile" /><span class="avatar-edit-hint">CHANGE</span>`
      : `${initial}<span class="avatar-edit-hint">CHANGE</span>`;
    container.innerHTML = `
      <div class="account-profile">
        <div class="account-avatar-large" onclick="document.getElementById('profile-photo-input').click()">
          ${avatarContent}
        </div>
        <div class="account-display-name" id="account-display-name-view"
          onclick="editProfileField('displayName')"
        >${displayName ? _escHtml(displayName) : ''}</div>
        <div class="account-bio" id="account-bio-view"
          onclick="editProfileField('bio')"
        >${bio ? _escHtml(bio) : ''}</div>
        <div class="account-email-label">${_escHtml(email)}</div>
        ${created ? `<div class="account-meta">Member since ${created}</div>` : ''}
        <div class="account-sync-status" id="sync-label">✓ All data synced to cloud</div>
      </div>
      <div class="account-actions">
        <button class="account-signout-btn" onclick="authSignOut()">Sign Out</button>
      </div>`;
  } else {
    const isCreate = _accountMode === 'create';
    container.innerHTML = `
      <div class="account-form">
        <div class="account-form-toggle">
          <button class="${!isCreate ? 'active' : ''}" onclick="setAuthMode('signin')">Sign In</button>
          <button class="${isCreate ? 'active' : ''}" onclick="setAuthMode('create')">Create Account</button>
        </div>
        <input type="email" id="auth-email" class="account-input" placeholder="Email address" autocomplete="email"/>
        <input type="password" id="auth-password" class="account-input" placeholder="Password" autocomplete="${isCreate ? 'new-password' : 'current-password'}"/>
        <div class="auth-error" id="auth-error"></div>
        <button class="account-submit-btn" onclick="submitAuth()">${isCreate ? 'Create Account' : 'Sign In'}</button>
      </div>`;
  }
}

function _escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function editProfileField(field) {
  if (field === 'displayName') {
    const view = document.getElementById('account-display-name-view');
    if (!view) return;
    const current = localStorage.getItem('displayName') || '';
    view.innerHTML = `<input class="account-profile-edit-input" id="edit-displayName" type="text" value="${_escHtml(current)}" placeholder="Add your name" maxlength="40" />`;
    const inp = document.getElementById('edit-displayName');
    inp.focus();
    inp.select();
    const save = () => {
      const val = inp.value.trim();
      localStorage.setItem('displayName', val);
      queueSync();
      updateProfileAvatarBtn();
      refreshAccountArea();
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { inp.blur(); } });
  } else if (field === 'bio') {
    const view = document.getElementById('account-bio-view');
    if (!view) return;
    const current = localStorage.getItem('bio') || '';
    view.innerHTML = `<textarea class="account-profile-edit-input" id="edit-bio" placeholder="Add a bio..." maxlength="160" style="resize:none;height:64px">${_escHtml(current)}</textarea>`;
    const ta = document.getElementById('edit-bio');
    ta.focus();
    const save = () => {
      const val = ta.value.trim();
      localStorage.setItem('bio', val);
      queueSync();
      refreshAccountArea();
    };
    ta.addEventListener('blur', save);
  }
}

function handleProfilePhotoSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const MAX = 400;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      localStorage.setItem('photoDataUrl', dataUrl);
      queueSync();
      updateProfileAvatarBtn();
      refreshAccountArea();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  // Reset input so same file can be re-selected
  input.value = '';
}

function openDrawerToAccount() {
  const drawer = document.getElementById('side-drawer');
  if (!drawer.classList.contains('open')) {
    openDrawer();
  }
  showAccount();
}

function setAuthMode(mode) {
  _accountMode = mode;
  refreshAccountArea();
}

function submitAuth() {
  const email = document.getElementById('auth-email')?.value.trim();
  const password = document.getElementById('auth-password')?.value;
  if (!email || !password) {
    const el = document.getElementById('auth-error');
    if (el) el.textContent = 'Please enter email and password.';
    return;
  }
  if (_accountMode === 'create') authCreate(email, password);
  else authSignIn(email, password);
}

function showAccount() {
  document.getElementById('drawer-title').textContent = 'Account';
  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-back" onclick="renderDrawerMenu()">‹ Back</button>
    <div id="account-status-area"></div>
  `;
  renderAccountStatus(document.getElementById('account-status-area'));
}

// ── HABITS CONFIG ────────────────────────────────────────
const HABITS = [
  { id: 'wake-early',  name: 'Wake Up Early',      emoji: '☀️', color: '#fbbf24' },
  { id: 'clean-room',  name: 'Clean Room & Bed',   emoji: '🛏️', color: '#4ade80' },
  { id: 'cold-shower', name: 'Cold Shower',        emoji: '🚿', color: '#38bdf8' },
  { id: 'brush-teeth', name: 'Brush Teeth',        emoji: '🦷', color: '#60a5fa' },
  { id: 'bed-early',   name: 'Go to Bed Early',    emoji: '🌙', color: '#a78bfa' },
];

// Rainbow spectrum: red → orange → yellow → green → teal → sky → blue → purple → pink
const HABIT_COLORS = ['#f87171','#fb923c','#fbbf24','#a3e635','#4ade80','#34d399','#38bdf8','#60a5fa','#a78bfa','#e879f9'];
let habitEditMode = false;
let selectedEmoji = '🌟';

const EMOJI_PICKER_LIST = [
  '⭐','🌟','🔥','💪','🏃','🧘','🏋️','🚴','🤸','🧗',
  '💧','🥗','🍎','🥑','🫐','☀️','🌙','😴','💊','🧠',
  '📚','✏️','💰','🎯','📝','🎵','🎨','🏆','💎','🚀',
  '🌱','🌸','🦷','🚿','🛏️','🧹','❤️','🙏','😊','✅',
  '🐶','🌊','⚡','🎮','🍕','☕','🏅','🎉','🕐','🌍',
];

function toggleEmojiPicker() {
  const dd = document.getElementById('emoji-dropdown');
  if (dd) dd.classList.toggle('hidden');
}

function selectEmoji(emoji) {
  selectedEmoji = emoji;
  const btn = document.getElementById('emoji-picker-btn');
  if (btn) btn.textContent = emoji;
  const dd = document.getElementById('emoji-dropdown');
  if (dd) dd.classList.add('hidden');
}

function getHabits() {
  const saved = localStorage.getItem('customHabits');
  if (saved) {
    const custom = JSON.parse(saved);
    if (custom.length > 0) return custom;
  }
  return [...HABITS];
}

function saveHabitsConfig(habits) {
  localStorage.setItem('customHabits', JSON.stringify(habits));
  queueSync();
}

function toggleHabitEditMode() {
  habitEditMode = !habitEditMode;
  const btn = document.getElementById('habit-edit-btn');
  if (btn) btn.classList.toggle('active', habitEditMode);
  buildHabitCards();
  render();
}

// ── CONFIRM MODAL ─────────────────────────────────────────
let _confirmCallback = null;

function showConfirmModal({ icon, title, message, confirmLabel }) {
  closeConfirmModal();
  const overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay';
  overlay.id = 'confirm-modal-overlay';
  overlay.innerHTML = `
    <div class="confirm-modal">
      <div class="confirm-modal-icon">${icon}</div>
      <div class="confirm-modal-title">${title}</div>
      ${message ? `<div class="confirm-modal-message">${message}</div>` : ''}
      <div class="confirm-modal-btns">
        <button class="confirm-modal-cancel" onclick="closeConfirmModal()">Cancel</button>
        <button class="confirm-modal-confirm" onclick="executeConfirmModal()">${confirmLabel}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeConfirmModal() {
  _confirmCallback = null;
  document.getElementById('confirm-modal-overlay')?.remove();
}

function executeConfirmModal() {
  const cb = _confirmCallback;
  closeConfirmModal();
  if (cb) cb();
}

function removeHabit(id) {
  const habit = getHabits().find(h => h.id === id);
  const name = habit ? habit.name : 'this habit';
  showConfirmModal({
    icon: habit?.emoji || '🗑️',
    title: `Delete "${name}"?`,
    message: 'This habit and all its history will be removed.',
    confirmLabel: 'Delete',
  });
  _confirmCallback = () => {
    const habits = getHabits().filter(h => h.id !== id);
    saveHabitsConfig(habits);
    buildHabitCards();
    render();
  };
}

function showAddHabitForm() {
  const existing = document.getElementById('add-habit-form');
  if (existing) { existing.remove(); return; }
  selectedEmoji = '🌟';
  const emojiGrid = EMOJI_PICKER_LIST.map(e =>
    `<button class="emoji-option" onclick="selectEmoji('${e}')">${e}</button>`
  ).join('');
  const form = document.createElement('div');
  form.id = 'add-habit-form';
  form.className = 'add-habit-form';
  form.innerHTML = `
    <div class="add-habit-inputs">
      <div class="emoji-picker-wrap">
        <button class="emoji-picker-btn" id="emoji-picker-btn" onclick="toggleEmojiPicker()">🌟</button>
        <div class="emoji-dropdown hidden" id="emoji-dropdown">${emojiGrid}</div>
      </div>
      <input type="text" id="new-habit-name" class="add-habit-name-input" placeholder="Habit name...">
    </div>
    <button class="add-habit-save" onclick="saveNewHabit()">Add Habit</button>
  `;
  const btn = document.getElementById('add-habit-btn');
  if (btn) btn.insertAdjacentElement('beforebegin', form);
  document.getElementById('new-habit-name')?.focus();
}

function saveNewHabit() {
  const emoji = selectedEmoji || '⭐';
  const name = document.getElementById('new-habit-name')?.value.trim();
  if (!name) return;
  const habits = getHabits();
  const id = 'habit-' + Date.now();
  const color = HABIT_COLORS[habits.length % HABIT_COLORS.length];
  habits.push({ id, name, emoji, color });
  saveHabitsConfig(habits);
  buildHabitCards();
  render();
  const newCard = document.querySelector(`[data-habit="${id}"]`);
  if (newCard) {
    newCard.classList.add('new-card');
    newCard.addEventListener('animationend', () => newCard.classList.remove('new-card'), { once: true });
  }
}

// ── QUOTES ───────────────────────────────────────────────
const QUOTES = [
  { text: "Take care of your body. It's the only place you have to live.", author: "Jim Rohn" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Aristotle" },
  { text: "The secret of your future is hidden in your daily routine.", author: "Mike Murdock" },
  { text: "Motivation is what gets you started. Habit is what keeps you going.", author: "Jim Ryun" },
  { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
  { text: "Your health is an investment, not an expense.", author: "Unknown" },
  { text: "You don't rise to the level of your goals. You fall to the level of your systems.", author: "James Clear" },
  { text: "Small daily improvements are the key to staggering long-term results.", author: "Robin Sharma" },
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "The groundwork of all happiness is health.", author: "Leigh Hunt" },
  { text: "A healthy outside starts from the inside.", author: "Robert Urich" },
  { text: "Don't count the days. Make the days count.", author: "Muhammad Ali" },
  { text: "It is not enough to take steps which may someday lead to a goal; each step must be itself a goal.", author: "Goethe" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Sleep is the best meditation.", author: "Dalai Lama" },
  { text: "Early to bed and early to rise makes a man healthy, wealthy, and wise.", author: "Benjamin Franklin" },
  { text: "To keep the body in good health is a duty, otherwise we shall not be able to keep our mind strong.", author: "Buddha" },
  { text: "Gratitude turns what we have into enough.", author: "Aesop" },
  { text: "The more you praise and celebrate your life, the more there is in life to celebrate.", author: "Oprah Winfrey" },
  { text: "Gratitude is not only the greatest of virtues, but the parent of all others.", author: "Cicero" },
  { text: "Be grateful for what you have; you'll end up having more.", author: "Oprah Winfrey" },
  { text: "When you arise in the morning, think of what a precious privilege it is to be alive.", author: "Marcus Aurelius" },
  { text: "Winning is a habit. Unfortunately, so is losing.", author: "Vince Lombardi" },
  { text: "First forget inspiration. Habit is more dependable.", author: "Octavia Butler" },
  { text: "In essence, if we want to direct our lives, we must take control of our consistent actions.", author: "Tony Robbins" },
  { text: "The chains of habit are too light to be felt until they are too heavy to be broken.", author: "Warren Buffett" },
  { text: "A man who masters patience masters everything else.", author: "George Savile" },
  { text: "You will never change your life until you change something you do daily.", author: "John C. Maxwell" },
  { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
  { text: "The biggest adventure you can take is to live the life of your dreams.", author: "Oprah Winfrey" },
];

function getDayNumber() {
  const today = getToday();
  const start = new Date('2025-01-01T12:00:00');
  const d = new Date(today + 'T12:00:00');
  return Math.floor((d - start) / (1000 * 60 * 60 * 24));
}

function getDailyQuote() {
  const day = getDayNumber();
  return QUOTES[((day % QUOTES.length) + QUOTES.length) % QUOTES.length];
}

// ── NAVIGATION ───────────────────────────────────────────
let currentPage = 1;
let startX = 0;

function goTo(index) {
  // Exit habit edit mode when leaving the habits page
  if (index !== 1 && habitEditMode) {
    habitEditMode = false;
    const btn = document.getElementById('habit-edit-btn');
    if (btn) btn.classList.remove('active');
    buildHabitCards();
  }
  currentPage = index;
  document.getElementById('pages').style.transform = `translateX(-${index * 100}vw)`;
  document.querySelectorAll('.nav-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });
  // Always restore nav when switching pages
  document.querySelector('.bottom-nav').classList.remove('hidden');
  if (index === 0) renderProgress();
  if (index === 1) render();
  if (index === 2) renderJournal();
  if (index === 3) renderFriends();
}

// ── DATA ─────────────────────────────────────────────────
function getToday() {
  const now = new Date();
  // Day resets at 4am — before 4am counts as the previous day
  if (now.getHours() < 4) now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadData() {
  const raw = localStorage.getItem('habitData');
  return raw ? JSON.parse(raw) : {};
}

function saveData(data) {
  localStorage.setItem('habitData', JSON.stringify(data));
  queueSync();
}

function getStreak(habitId, data) {
  let streak = 0;
  const today = getToday();
  let date = new Date(today);

  while (true) {
    const key = date.toISOString().split('T')[0];
    if (key === today) {
      date.setDate(date.getDate() - 1);
      continue;
    }
    if (data[key] && data[key][habitId]) {
      streak++;
      date.setDate(date.getDate() - 1);
    } else {
      break;
    }
  }

  if (data[today] && data[today][habitId]) streak++;
  return streak;
}

function getGratitudeStreak() {
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  const today = getToday();
  let streak = 0;
  let date = new Date(today);

  while (true) {
    const key = date.toISOString().split('T')[0];
    if (key === today) {
      date.setDate(date.getDate() - 1);
      continue;
    }
    const e = journals[key];
    if (e && e.s1 && e.s2 && e.s3) {
      streak++;
      date.setDate(date.getDate() - 1);
    } else {
      break;
    }
  }

  const todayEntry = journals[today];
  if (todayEntry && todayEntry.s1 && todayEntry.s2 && todayEntry.s3) streak++;
  return streak;
}

// ── HABITS ───────────────────────────────────────────────
function getOrderedHabits() {
  const habits = getHabits();
  const saved = localStorage.getItem('habitOrder');
  let ordered;
  if (!saved) {
    ordered = habits;
  } else {
    const order = JSON.parse(saved);
    ordered = order.map(id => habits.find(h => h.id === id)).filter(Boolean);
    habits.forEach(h => { if (!ordered.find(o => o.id === h.id)) ordered.push(h); });
  }
  // Remap colors by rainbow position so dots always go red→orange→yellow→…
  return ordered.map((h, i) => ({ ...h, color: HABIT_COLORS[i % HABIT_COLORS.length] }));
}

function saveHabitOrder() {
  const cards = document.querySelectorAll('#habit-list .habit-card');
  const order = [...cards].map(c => c.dataset.habit);
  localStorage.setItem('habitOrder', JSON.stringify(order));
  queueSync();
}

function buildHabitCards() {
  const list = document.getElementById('habit-list');
  if (!list) return;
  const ordered = getOrderedHabits();

  list.innerHTML = ordered.map(h => `
    <div class="habit-card" data-habit="${h.id}" ${habitEditMode ? 'draggable="true"' : ''}>
      <button class="remove-habit-btn" onclick="removeHabit('${h.id}')">−</button>
      <div class="drag-handle">⠿</div>
      <div class="habit-info">
        <span class="emoji">${h.emoji}</span>
        <span class="habit-name">${h.name}</span>
      </div>
      <div class="habit-right">
        <span class="streak" id="streak-${h.id}">0 days</span>
        <button class="check-btn" id="btn-${h.id}" onclick="toggleHabit('${h.id}')">✓</button>
      </div>
    </div>
  `).join('');

  list.classList.toggle('edit-mode', habitEditMode);

  // Remove old add button/form
  document.getElementById('add-habit-btn')?.remove();
  document.getElementById('add-habit-form')?.remove();

  if (habitEditMode) {
    const addBtn = document.createElement('button');
    addBtn.className = 'add-habit-btn';
    addBtn.id = 'add-habit-btn';
    addBtn.innerHTML = '＋ Add Habit';
    addBtn.onclick = showAddHabitForm;
    list.insertAdjacentElement('afterend', addBtn);
  }

  initDragAndDrop();
}

function toggleHabit(habitId) {
  const data = loadData();
  const today = getToday();
  if (!data[today]) data[today] = {};
  data[today][habitId] = !data[today][habitId];
  saveData(data);
  render();
}

function render() {
  const data = loadData();
  const today = getToday();
  const todayData = data[today] || {};

  const dateEl = document.getElementById('today-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  // Build cards if not yet rendered
  const list = document.getElementById('habit-list');
  if (list && !list.querySelector('.habit-card')) buildHabitCards();

  getHabits().forEach(h => {
    const card = document.querySelector(`[data-habit="${h.id}"]`);
    const streakEl = document.getElementById(`streak-${h.id}`);
    const done = !!todayData[h.id];
    const streak = getStreak(h.id, data);
    if (card) card.classList.toggle('done', done);
    if (streakEl) {
      streakEl.textContent = streak > 0
        ? `🔥 ${streak} day${streak !== 1 ? 's' : ''}`
        : '0 days';
    }
  });

  updateHabitsNavTab();
}

// ── DRAG & DROP ──────────────────────────────────────────
function initDragAndDrop() {
  const list = document.getElementById('habit-list');
  if (!list) return;

  let dragEl = null;
  let touchClone = null;

  // ── Desktop drag ──
  list.addEventListener('dragstart', e => {
    dragEl = e.target.closest('.habit-card');
    if (!dragEl) return;
    e.dataTransfer.effectAllowed = 'move';
    // Delay so browser captures element before we style it
    setTimeout(() => {
      dragEl.classList.add('dragging');
      list.classList.add('is-dragging');
    }, 0);
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    const over = e.target.closest('.habit-card');
    if (!over || over === dragEl) return;
    const rect = over.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      list.insertBefore(dragEl, over);
    } else {
      list.insertBefore(dragEl, over.nextSibling);
    }
  });

  list.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    list.classList.remove('is-dragging');
    saveHabitOrder();
    dragEl = null;
  });

  // ── Touch drag (mobile) ──
  list.addEventListener('touchstart', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    dragEl = handle.closest('.habit-card');
    const rect = dragEl.getBoundingClientRect();
    touchClone = dragEl.cloneNode(true);
    touchClone.style.cssText = `
      position: fixed; left: ${rect.left}px; top: ${rect.top}px;
      width: ${rect.width}px; opacity: 0.85; pointer-events: none;
      z-index: 999; border-radius: 14px; background: #2a1a00;
      border: 1.5px solid #f59e0b;
    `;
    document.body.appendChild(touchClone);
    dragEl.style.opacity = '0.3';
  }, { passive: true });

  list.addEventListener('touchmove', e => {
    if (!dragEl || !touchClone) return;
    e.preventDefault();
    const touch = e.touches[0];
    touchClone.style.top = (touch.clientY - dragEl.offsetHeight / 2) + 'px';

    const cards = [...list.querySelectorAll('.habit-card')].filter(c => c !== dragEl);
    const over = cards.find(c => {
      const r = c.getBoundingClientRect();
      return touch.clientY >= r.top && touch.clientY <= r.bottom;
    });
    if (over) {
      const r = over.getBoundingClientRect();
      if (touch.clientY < r.top + r.height / 2) {
        list.insertBefore(dragEl, over);
      } else {
        list.insertBefore(dragEl, over.nextSibling);
      }
    }
  }, { passive: false });

  list.addEventListener('touchend', () => {
    if (!dragEl) return;
    dragEl.style.opacity = '';
    if (touchClone) { touchClone.remove(); touchClone = null; }
    saveHabitOrder();
    dragEl = null;
  }, { passive: true });
}

// ── PROGRESS ─────────────────────────────────────────────
let calViewMode = 'weekly';
let viewWeekOffset = 0;
let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth();

// Nature photos — curated list, rotates daily
const NATURE_PHOTOS = [
  'photo-1506905489-9ba3d02c0b37', // mountain lake reflection
  'photo-1469474968028-56623f02e42e', // forest path sunlight
  'photo-1447752875215-b2761acb3c5d', // misty forest
  'photo-1501854140801-50d01698950b', // mountain landscape
  'photo-1439853672-1e736eda7c9b', // snow mountain
  'photo-1476673160081-cf065607f449', // lake mountain blue
  'photo-1500534314209-a25ddb2bd429', // forest walk trail
  'photo-1518495973542-4542c06a5843', // sunlight through trees
  'photo-1504701954957-2010ec3bcec1', // ocean waves rocks
  'photo-1433086966358-54859d0ed716', // waterfall forest
  'photo-1507003211169-0a1dd7228f2d', // mountain sunrise
  'photo-1464822759023-fed622ff2c3b', // green mountain valley
  'photo-1511884642898-4c92249e20b6', // misty mountains
  'photo-1465146344425-f00d5f5c8f07', // green meadow mountains
  'photo-1486870591958-9b9d0d1dda99', // winter mountain peaks
  'photo-1490750967868-88df5691cc51', // cherry blossoms nature
  'photo-1470770903676-69b98201ea1c', // lake cabin forest
  'photo-1448375240586-882707db888b', // dense forest green
  'photo-1505118380757-91f5f5632de0', // road through forest
  'photo-1419242902214-272b3f66ee7a', // night sky stars mountain
  'photo-1532274402911-5a369e4c4bb5', // autumn lake reflection
  'photo-1507525428034-b723cf961d3e', // tropical beach clear water
  'photo-1455156218388-5e61b526818b', // desert sand dunes
  'photo-1497449493050-aad1e7cad165', // canyon rocks golden
  'photo-1559827260-dc66d52bef19', // ocean cliff sunset
  'photo-1501630834273-4b5604d2ee31', // snowy pine trees
  'photo-1441974231531-c6227db76b6e', // forest light rays
  'photo-1475924156734-496f6cac6ec1', // green rolling hills
  'photo-1490730141103-6cac27aaab94', // sunrise over mountains
  'photo-1519681393784-d120267933ba', // mountain snow storm
];

function setProgressBg() {
  const bg = document.getElementById('progress-bg');
  if (!bg) return;
  const day = getDayNumber();
  const photoId = NATURE_PHOTOS[((( day + 1) % NATURE_PHOTOS.length) + NATURE_PHOTOS.length) % NATURE_PHOTOS.length];
  bg.style.backgroundImage = `url(https://images.unsplash.com/${photoId}?w=1200&q=75&auto=format&fit=crop)`;
}

function renderProgress() {
  const data = loadData();

  // Always reset to current week when visiting Progress
  viewWeekOffset = 0;

  setProgressBg();

  const el = document.getElementById('progress-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const grid = document.getElementById('streak-grid');
  if (grid) {
    const habitCards = getOrderedHabits().map(h => {
      const s = getStreak(h.id, data);
      return `
        <div class="streak-card">
          <div class="streak-card-emoji">${h.emoji}</div>
          <div class="streak-card-name">${h.name}</div>
          <div class="streak-card-fire-row">
            <span class="streak-card-count">${s}</span>
            <span class="streak-fire">🔥</span>
          </div>
          <div class="streak-card-label">day streak</div>
        </div>`;
    }).join('');
    const gratStreak = getGratitudeStreak();
    const gratCard = `
      <div class="streak-card streak-card-gratitude">
        <div class="streak-card-emoji">🙏</div>
        <div class="streak-card-name">Gratitude</div>
        <div class="streak-card-fire-row">
          <span class="streak-card-count">${gratStreak}</span>
          <span class="streak-fire">🔥</span>
        </div>
        <div class="streak-card-label">day streak</div>
      </div>`;
    grid.innerHTML = habitCards + gratCard;
  }

  const legend = document.getElementById('legend');
  if (legend) {
    legend.innerHTML = getOrderedHabits().map(h => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${h.color}"></div>
        <span>${h.name}</span>
      </div>`).join('');
  }

  updateCalHeader();
  renderCalendar(data);
  renderHistory();

  document.getElementById('prev-month').onclick = () => {
    if (calViewMode === 'weekly') {
      viewWeekOffset--;
    } else {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    }
    renderProgress();
  };
  document.getElementById('next-month').onclick = () => {
    if (calViewMode === 'weekly') {
      viewWeekOffset++;
    } else {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    }
    renderProgress();
  };
}

function renderHistory() {
  const habitData = loadData();
  const journals  = JSON.parse(localStorage.getItem('grateful') || '{}');
  const today     = getToday();

  const container = document.getElementById('history-list');
  if (!container) return;

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay    = new Date(viewYear, viewMonth, 1).getDay();

  const dayHeaders = ['Su','Mo','Tu','We','Th','Fr','Sa']
    .map(d => `<div class="flame-day-header">${d}</div>`).join('');

  // Empty spacer cells before the 1st
  let cells = '';
  for (let i = 0; i < firstDay; i++) {
    cells += `<div class="flame-cell empty"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday  = dateStr === today;
    const isFuture = dateStr > today;

    const dayHabits      = habitData[dateStr] || {};
    const dayJournal     = journals[dateStr]  || {};
    const habitsCompleted = getHabits().filter(h => dayHabits[h.id]).length;
    const gratitudeDone   = [1,2,3].filter(n => dayJournal[`s${n}`]).length;
    const hasActivity     = habitsCompleted > 0 || gratitudeDone > 0;
    const isPerfect       = habitsCompleted === getHabits().length && gratitudeDone === 3;

    let cls = 'flame-cell';
    if (isFuture)       cls += ' future';
    else if (isPerfect) cls += ' perfect';
    else if (hasActivity) cls += ' active';
    else                cls += ' no-data';
    if (isToday) cls += ' today';

    const score = habitsCompleted + gratitudeDone;
    cells += `
      <div class="${cls}">
        <span class="flame-cell-fire">🔥</span>
        ${hasActivity ? `<span class="flame-cell-score">${score}</span>` : ''}
      </div>`;
  }

  container.innerHTML = `
    <div class="flame-grid-headers">${dayHeaders}</div>
    <div class="flame-grid">${cells}</div>
  `;
}

function updateCalHeader() {
  const monthLabel = document.getElementById('month-label');
  if (!monthLabel) return;
  if (calViewMode === 'weekly') {
    const now = new Date();
    const todayDay = now.getDay();
    const wStart = new Date(now);
    wStart.setDate(now.getDate() - todayDay + viewWeekOffset * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    monthLabel.innerHTML = `${fmt(wStart)} – ${fmt(wEnd)} <button class="cal-view-toggle" onclick="toggleCalView()">Monthly ›</button>`;
  } else {
    const label = new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    monthLabel.innerHTML = `${label} <button class="cal-view-toggle" onclick="toggleCalView()">‹ Weekly</button>`;
  }
}

function toggleCalView() {
  calViewMode = calViewMode === 'weekly' ? 'monthly' : 'weekly';
  viewWeekOffset = 0;
  const now = new Date();
  viewYear  = now.getFullYear();
  viewMonth = now.getMonth();
  renderProgress();
}

function renderCalendar(data) {
  if (calViewMode === 'weekly') {
    renderWeeklyCalendar(data);
  } else {
    renderMonthlyCalendar(data);
  }
}

function renderWeeklyCalendar(data) {
  const cal = document.getElementById('calendar');
  if (!cal) return;
  const today = getToday();
  const now = new Date();
  const wStart = new Date(now);
  wStart.setDate(now.getDate() - now.getDay() + viewWeekOffset * 7);
  wStart.setHours(0,0,0,0);

  const allCells = Array.from({length: 7}, (_, i) => {
    const d = new Date(wStart);
    d.setDate(wStart.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const isToday = dateStr === today;
    const isFuture = dateStr > today;
    const dayData = data[dateStr] || {};
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dots = getOrderedHabits().map(h =>
      `<div class="cal-dot" style="background:${dayData[h.id] && !isFuture ? h.color : '#2a2a2a'}"></div>`
    ).join('');
    return `
      <div class="cal-cell weekly-cell${isToday ? ' today' : ''}">
        <div class="weekly-day-name">${dayNames[d.getDay()]}</div>
        <div class="cal-num">${d.getDate()}</div>
        <div class="cal-dots">${dots}</div>
      </div>`;
  });
  const row1 = allCells.slice(0, 4).join('');
  const row2 = allCells.slice(4).join('');
  cal.innerHTML = `
    <div class="cal-grid-weekly cal-grid-weekly-4">${row1}</div>
    <div class="cal-grid-weekly cal-grid-weekly-3">${row2}</div>`;
}

function renderMonthlyCalendar(data) {
  const cal = document.getElementById('calendar');
  if (!cal) return;
  const today = getToday();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const dayHeaders = ['Su','Mo','Tu','We','Th','Fr','Sa']
    .map(d => `<div class="cal-day-header">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += `<div class="cal-cell"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = dateStr === today;
    const dayData = data[dateStr] || {};

    const dots = getOrderedHabits().map(h =>
      `<div class="cal-dot" style="background:${dayData[h.id] ? h.color : '#252525'}"></div>`
    ).join('');

    cells += `
      <div class="cal-cell${isToday ? ' today' : ''}">
        <div class="cal-num">${day}</div>
        <div class="cal-dots">${dots}</div>
      </div>`;
  }

  cal.innerHTML = `
    <div class="cal-day-headers">${dayHeaders}</div>
    <div class="cal-grid">${cells}</div>`;
}

// ── JOURNAL / GRATITUDE ───────────────────────────────────

function renderJournal() {
  const today = getToday();
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  const entry = journals[today] || { g1: '', g2: '', g3: '', s1: false, s2: false, s3: false };

  const dateEl = document.getElementById('journal-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const q = getDailyQuote();
  const qText = document.getElementById('quote-text');
  const qAuth = document.getElementById('quote-author');
  if (qText) qText.textContent = q.text;
  if (qAuth) qAuth.textContent = '— ' + q.author;

  [1, 2, 3].forEach(n => {
    const textarea = document.getElementById(`grateful-${n}`);
    const doneText = document.getElementById(`gdone-${n}`);
    const item = document.getElementById(`gitem-${n}`);
    const text = entry[`g${n}`] || '';
    const submitted = entry[`s${n}`] || false;

    if (textarea) textarea.value = text;
    if (doneText) doneText.textContent = 'completed';

    if (submitted && text) {
      item?.classList.add('done');
    } else {
      item?.classList.remove('done');
    }

    // Auto-submit on Enter key or blur
    if (textarea && !submitted) {
      textarea.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (textarea.value.trim()) submitGrateful(n);
        }
      };

      // Auto-submit when user taps away (fixes mobile double-tap on check button)
      textarea.onblur = () => {
        if (textarea.value.trim()) submitGrateful(n);
      };

      // Auto-submit after 1.5s of no typing
      let autoTimer = null;
      textarea.oninput = () => {
        clearTimeout(autoTimer);
        if (textarea.value.trim()) {
          autoTimer = setTimeout(() => submitGrateful(n), 1500);
        }
      };
    }
  });

  updateJournalNavTab(journals[today]);
}

const _gratefulSubmitTimes = {};
function submitGrateful(n) {
  const now = Date.now();
  const today = getToday();
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  if (!journals[today]) journals[today] = { g1: '', g2: '', g3: '', s1: false, s2: false, s3: false };

  const item = document.getElementById(`gitem-${n}`);
  const textarea = document.getElementById(`grateful-${n}`);
  const doneText = document.getElementById(`gdone-${n}`);
  const isAlreadyDone = item?.classList.contains('done');

  if (isAlreadyDone) {
    // Open for inline editing without un-submitting — gold circle stays
    if (now - (_gratefulSubmitTimes[n] || 0) < 400) return;
    item?.classList.remove('done');
    // Wire up events so re-submitting or clearing works
    if (textarea) {
      textarea.onblur = () => {
        const text = textarea.value.trim();
        const j2 = JSON.parse(localStorage.getItem('grateful') || '{}');
        if (!j2[today]) j2[today] = { g1: '', g2: '', g3: '', s1: false, s2: false, s3: false };
        if (text) {
          j2[today][`g${n}`] = text;
          j2[today][`s${n}`] = true;
          item?.classList.add('done');
        } else {
          j2[today][`s${n}`] = false;
          j2[today][`g${n}`] = '';
        }
        localStorage.setItem('grateful', JSON.stringify(j2));
        queueSync();
        updateJournalNavTab(j2[today]);
      };
      textarea.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textarea.blur(); }
      };
    }
    return;
  }

  const text = textarea?.value?.trim() || '';
  if (!text) return;
  _gratefulSubmitTimes[n] = now;
  journals[today][`g${n}`] = text;
  journals[today][`s${n}`] = true;
  if (doneText) doneText.textContent = 'completed';
  item?.classList.add('done');

  localStorage.setItem('grateful', JSON.stringify(journals));
  queueSync();
  updateJournalNavTab(journals[today]);
}

function updateJournalNavTab(entry) {
  const journalBtn = document.getElementById('nav-2');
  if (!journalBtn) return;
  const allDone = entry && entry.s1 && entry.s2 && entry.s3;
  journalBtn.classList.toggle('completed', !!allDone);
}

function updateHabitsNavTab() {
  const habitsBtn = document.getElementById('nav-1');
  if (!habitsBtn) return;
  const habits = getHabits();
  if (!habits.length) { habitsBtn.classList.remove('completed'); return; }
  const today = getToday();
  const todayData = loadData()[today] || {};
  const allDone = habits.every(h => !!todayData[h.id]);
  habitsBtn.classList.toggle('completed', allDone);
}

// ── FRIENDS ───────────────────────────────────────────────

async function renderFriends() {
  const container = document.getElementById('friends-content');
  if (!container) return;

  if (!_currentUser || !_fbDb) {
    container.innerHTML = `<div class="friends-empty">Sign in to use Friends.</div>`;
    return;
  }

  container.innerHTML = `<div class="auth-gate-loading"><div class="pull-spinner"></div></div>`;

  try {
    const myDoc = await _fbDb.collection('users').doc(_currentUser.uid).get();
    const myData = myDoc.exists ? myDoc.data() : {};
    const friends = myData.friends || [];

    const shareUrl = 'https://habit-tracker-2a0ed.web.app/?add=' + _currentUser.uid;

    let html = `<div class="friends-row">`;

    const demoFriend = {
      displayName: 'Computer',
      email: 'demo@example.com',
      habitData: { [getToday()]: { wake: true, clean: true, shower: false, teeth: true, workout: false } },
      customHabits: [],
      photoDataUrl: ''
    };
    const showDemo = friends.length === 0;

    if (showDemo) {
      // Show demo "Computer" friend bubble
      html += `
        <div class="friend-bubble-wrap">
          <div class="friend-bubble" style="background:#444;color:#fff">C</div>
          <div class="friend-bubble-name">Computer</div>
        </div>
      `;
    } else {
      // Show existing friend avatars as circles
      for (const friendUid of friends) {
        try {
          const friendDoc = await _fbDb.collection('users').doc(friendUid).get();
          if (!friendDoc.exists) continue;
          const fd = friendDoc.data();
          const friendEmail = fd.email || friendUid;
          const friendName = fd.displayName || friendEmail;
          const initial = friendName.charAt(0).toUpperCase();
          const photoUrl = fd.photoDataUrl || '';
          const avatarInner = photoUrl
            ? `<img src="${photoUrl}" alt="${initial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
            : initial;
          html += `
            <div class="friend-bubble-wrap">
              <div class="friend-bubble">${avatarInner}</div>
              <div class="friend-bubble-name">${friendName.split(' ')[0]}</div>
            </div>
          `;
        } catch(e) { /* skip */ }
      }
    }

    html += `</div>`;

    if (showDemo) {
      const demoHabits = HABITS;
      const demoToday = demoFriend.habitData[getToday()] || {};
      const demoCompleted = demoHabits.filter(h => !!demoToday[h.id]).length;
      const demoPct = Math.round((demoCompleted / demoHabits.length) * 100);
      const demoRows = demoHabits.map(h => {
        const done = !!demoToday[h.id];
        return `<div class="fcard-habit-row ${done ? 'done' : ''}">
          <span class="fcard-habit-name">${h.name}</span>
          <span class="fcard-habit-check">${done ? '✓' : ''}</span>
        </div>`;
      }).join('');
      html += `
        <div class="friends-list" id="friends-list">
          <div class="friend-card">
            <div class="fcard-header">
              <div class="friend-avatar" style="background:#444;color:#fff;overflow:hidden">C</div>
              <div class="fcard-header-info">
                <div class="fcard-name-row">
                  <div class="friend-name">Computer <span style="font-size:0.7rem;color:#666;font-weight:400">(demo)</span></div>
                </div>
                <div class="fcard-meta"><span class="fcard-meta-dim">Demo account</span></div>
                <div class="fcard-progress-bar-wrap"><div class="fcard-progress-bar" style="width:${demoPct}%"></div></div>
                <div class="fcard-progress-label">${demoCompleted}/${demoHabits.length} habits today</div>
              </div>
            </div>
            <div class="fcard-habits">${demoRows}</div>
          </div>
        </div>
      `;
    }

    if (friends.length > 0) {
      html += `<div class="friends-list" id="friends-list">`;
      // Fetch each friend's data
      for (const friendUid of friends) {
        try {
          const friendDoc = await _fbDb.collection('users').doc(friendUid).get();
          if (!friendDoc.exists) continue;
          const fd = friendDoc.data();
          const friendEmail = fd.email || friendUid;
          const friendName = fd.displayName || friendEmail;
          const today = getToday();
          const todayData = (fd.habitData && fd.habitData[today]) || {};
          const habits = (fd.customHabits && fd.customHabits.length > 0)
            ? fd.customHabits
            : HABITS;
          const completedCount = habits.filter(h => !!todayData[h.id]).length;
          const totalCount = habits.length;

          const friendPhotoUrl = fd.photoDataUrl || '';
          const friendInitial = (fd.displayName || friendEmail).charAt(0).toUpperCase();
          const friendAvatarInner = friendPhotoUrl
            ? `<img src="${friendPhotoUrl}" alt="${friendInitial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
            : friendInitial;

          // Calculate best streak across all habits
          const bestStreak = Math.max(...habits.map(h => getStreak(h.id, fd.habitData || {})));
          const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

          // Build habit rows with emoji + name + done indicator
          const habitRows = habits.map(h => {
            const done = !!todayData[h.id];
            const hStreak = getStreak(h.id, fd.habitData || {});
            return `
              <div class="fcard-habit-row ${done ? 'done' : ''}">
                <span class="fcard-habit-name">${h.name}</span>
                ${hStreak > 0 ? `<span class="fcard-habit-streak">🔥${hStreak}</span>` : ''}
                <span class="fcard-habit-check">${done ? '✓' : ''}</span>
              </div>`;
          }).join('');

          html += `
            <div class="friend-card">
              <div class="fcard-header">
                <div class="friend-avatar">${friendAvatarInner}</div>
                <div class="fcard-header-info">
                  <div class="fcard-name-row">
                    <div class="friend-name">${friendName}</div>
                  </div>
                  <div class="fcard-meta">
                    ${bestStreak > 0 ? `<span class="fcard-best-streak">🔥 ${bestStreak} day streak</span>` : '<span class="fcard-meta-dim">No streak yet</span>'}
                  </div>
                  <div class="fcard-progress-bar-wrap">
                    <div class="fcard-progress-bar" style="width:${pct}%"></div>
                  </div>
                  <div class="fcard-progress-label">${completedCount}/${totalCount} habits today</div>
                </div>
              </div>
              <div class="fcard-habits">${habitRows}</div>
            </div>
          `;
        } catch(e) { /* skip this friend if fetch fails */ }
      }
      html += `</div>`;
    }

    // ── GROUPS ──
    try {
      const groupSnap = await _fbDb.collection('groups')
        .where('members', 'array-contains', _currentUser.uid).get();
      if (!groupSnap.empty) {
        for (const groupDoc of groupSnap.docs) {
          const g = groupDoc.data();
          html += `<div class="friends-group-header">👥 ${g.name}</div>`;
          html += `<div class="friends-list">`;
          for (const memberUid of (g.members || [])) {
            if (memberUid === _currentUser.uid) continue;
            try {
              const fd = (await _fbDb.collection('users').doc(memberUid).get()).data() || {};
              const mEmail = fd.email || memberUid;
              const mName = fd.displayName || mEmail;
              const mInitial = mName.charAt(0).toUpperCase();
              const mPhoto = fd.photoDataUrl ? `<img src="${fd.photoDataUrl}" alt="${mInitial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : mInitial;
              const mHabits = (fd.customHabits && fd.customHabits.length > 0) ? fd.customHabits : HABITS;
              const mToday = (fd.habitData && fd.habitData[getToday()]) || {};
              const mDone = mHabits.filter(h => !!mToday[h.id]).length;
              const mPct = mHabits.length > 0 ? Math.round((mDone / mHabits.length) * 100) : 0;
              const mBest = Math.max(0, ...mHabits.map(h => getStreak(h.id, fd.habitData || {})));
              const mRows = mHabits.map(h => {
                const done = !!mToday[h.id];
                const s = getStreak(h.id, fd.habitData || {});
                return `<div class="fcard-habit-row ${done ? 'done' : ''}">
                  <span class="fcard-habit-name">${h.name}</span>
                  ${s > 0 ? `<span class="fcard-habit-streak">🔥${s}</span>` : ''}
                  <span class="fcard-habit-check">${done ? '✓' : ''}</span>
                </div>`;
              }).join('');
              html += `
                <div class="friend-card">
                  <div class="fcard-header">
                    <div class="friend-avatar">${mPhoto}</div>
                    <div class="fcard-header-info">
                      <div class="fcard-name-row"><div class="friend-name">${mName}</div></div>
                      <div class="fcard-meta">${mBest > 0 ? `<span class="fcard-best-streak">🔥 ${mBest} day streak</span>` : '<span class="fcard-meta-dim">No streak yet</span>'}</div>
                      <div class="fcard-progress-bar-wrap"><div class="fcard-progress-bar" style="width:${mPct}%"></div></div>
                      <div class="fcard-progress-label">${mDone}/${mHabits.length} habits today</div>
                    </div>
                  </div>
                  <div class="fcard-habits">${mRows}</div>
                </div>`;
            } catch(e) { /* skip */ }
          }
          html += `</div>`;
        }
      }
    } catch(e) { /* groups not available */ }

    container.innerHTML = html;
  } catch(e) {
    console.warn('renderFriends error:', e);
    container.innerHTML = `<div class="friends-empty-inline" style="padding:20px 0;color:#555;">Tap + to invite friends</div>`;
  }
}

function shareFriendLink(url) {
  if (navigator.share) {
    navigator.share({
      title: 'Daily Habit Tracker',
      text: 'Track habits with me!',
      url: url,
    }).catch(() => {});
  } else {
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(url).then(() => {
      const label = document.querySelector('.add-friend-label');
      if (label) { label.textContent = '✓ Copied!'; setTimeout(() => { label.textContent = 'Add Friend'; }, 2000); }
    }).catch(() => {
      prompt('Copy your invite link:', url);
    });
  }
}

// ── SWIPE & SCROLL ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const pages = document.getElementById('pages');
  const nav = document.querySelector('.bottom-nav');

  // Swipe between pages
  let swipeBlocked = false;
  pages.addEventListener('touchstart', e => {
    // Don't swipe if tapping on interactive elements
    swipeBlocked = !!e.target.closest('textarea, input, button, .grateful-item, .habit-card, .check-btn, .grateful-check, .emoji-dropdown');
    startX = e.touches[0].clientX;
  }, { passive: true });

  pages.addEventListener('touchend', e => {
    if (swipeBlocked) return;
    const diff = startX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 60) {
      if (diff > 0 && currentPage < 3) goTo(currentPage + 1);
      if (diff < 0 && currentPage > 0) goTo(currentPage - 1);
    }
  }, { passive: true });

  // Fade nav on scroll down, restore on scroll up — works on phone & desktop
  document.querySelectorAll('.page').forEach(page => {
    let lastScroll = 0;
    page.addEventListener('scroll', () => {
      const current = page.scrollTop;
      if (current > lastScroll && current > 40) {
        nav.classList.add('hidden');
      } else {
        nav.classList.remove('hidden');
      }
      lastScroll = Math.max(0, current);
    }, { passive: true });
  });

  // Parallax — bg moves at 10% of scroll speed
  const progressPage = document.getElementById('page-progress');
  const progressBg   = document.getElementById('progress-bg');
  if (progressPage && progressBg) {
    progressPage.addEventListener('scroll', () => {
      progressBg.style.transform = `translateY(${progressPage.scrollTop * -0.07}px)`;
    }, { passive: true });
  }

  // Pull-to-refresh on progress page
  const pullIndicator = document.getElementById('pull-refresh');
  let pullStartY   = 0;
  let pullActive   = false;
  let pullDone     = false;
  const PULL_THRESHOLD = 72;

  progressPage.addEventListener('touchstart', e => {
    if (progressPage.scrollTop <= 0) {
      pullStartY = e.touches[0].clientY;
      pullActive = true;
      pullDone   = false;
    }
  }, { passive: true });

  progressPage.addEventListener('touchmove', e => {
    if (!pullActive || pullDone) return;
    const dist = e.touches[0].clientY - pullStartY;
    if (dist <= 0) return;
    const pct = Math.min(dist / PULL_THRESHOLD, 1);
    // Slide indicator down from above
    pullIndicator.style.top     = (-56 + pct * 72) + 'px';
    pullIndicator.style.opacity = pct.toFixed(2);
    pullIndicator.classList.toggle('spinning', pct >= 1);
  }, { passive: true });

  progressPage.addEventListener('touchend', e => {
    if (!pullActive) return;
    pullActive = false;
    const dist = e.changedTouches[0].clientY - pullStartY;

    if (dist >= PULL_THRESHOLD) {
      pullDone = true;
      // Lock indicator in place and keep spinning
      pullIndicator.style.top     = '16px';
      pullIndicator.style.opacity = '1';
      pullIndicator.classList.add('spinning');

      setTimeout(() => {
        // Refresh content
        renderProgress();
        progressPage.scrollTo({ top: 0, behavior: 'smooth' });

        // Brief pause then hide
        setTimeout(() => {
          pullIndicator.classList.remove('spinning');
          pullIndicator.style.top     = '-56px';
          pullIndicator.style.opacity = '0';
          pullDone = false;
        }, 400);
      }, 1000);
    } else {
      // Snap back without triggering
      pullIndicator.style.transition = 'top 0.25s ease, opacity 0.25s';
      pullIndicator.style.top        = '-56px';
      pullIndicator.style.opacity    = '0';
      pullIndicator.classList.remove('spinning');
      setTimeout(() => pullIndicator.style.transition = '', 300);
    }
  }, { passive: true });

  applyTheme();
  initFirebase();
  goTo(1);

  // Block all text selection except inside textareas/inputs
  document.addEventListener('selectstart', e => {
    if (!e.target.closest('textarea, input')) e.preventDefault();
  });
});

// ── HAMBURGER DRAWER ─────────────────────────────────────

function toggleDrawer() {
  const drawer = document.getElementById('side-drawer');
  const isOpen = drawer.classList.contains('open');
  if (isOpen) closeDrawer();
  else openDrawer();
}

function openDrawer() {
  document.getElementById('side-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('visible');
  document.getElementById('hamburger-btn').style.visibility = 'hidden';
  renderDrawerMenu();
}

function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('visible');
  document.getElementById('hamburger-btn').style.visibility = '';
}

function renderDrawerMenu() {
  document.getElementById('drawer-title').textContent = 'Menu';
  const userEmail = _currentUser ? _currentUser.email : null;
  const isWood = (localStorage.getItem('colorTheme') || 'default') === 'wood';
  const photoUrl = localStorage.getItem('photoDataUrl') || '';
  const dName = localStorage.getItem('displayName') || '';
  const initial = dName ? dName[0].toUpperCase() : (userEmail ? userEmail[0].toUpperCase() : '?');
  const avatarHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
    : `<span class="drawer-avatar-circle">${initial}</span>`;
  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-item" onclick="showAccount()">
      ${avatarHtml}
      <span class="drawer-item-text" style="flex:1">${dName || (userEmail ? userEmail : 'Account')}</span>
      <span class="drawer-item-arrow">›</span>
    </button>
    ${userEmail ? `<button class="drawer-item drawer-signout-row" onclick="authSignOut()">
      <span class="drawer-item-icon">🚪</span>
      <span class="drawer-item-text">Sign Out</span>
    </button>` : ''}

    <button class="drawer-item" onclick="showSettings()">
      <span class="drawer-item-icon">⚙️</span>
      <span class="drawer-item-text">Settings</span>
      <span class="drawer-item-arrow">›</span>
    </button>

    <div class="drawer-divider"></div>

    <div class="drawer-section-label">Editing</div>

    <button class="drawer-item" onclick="showDateCalendar()">
      <span class="drawer-item-icon">📅</span>
      <span class="drawer-item-text">Edit a Day</span>
      <span class="drawer-item-arrow">›</span>
    </button>

    <button class="drawer-item" onclick="showColorThemes()">
      <span class="drawer-item-icon">🎨</span>
      <span class="drawer-item-text">Color Themes</span>
      <span class="drawer-item-arrow">›</span>
    </button>
  `;
}

function applyTheme() {
  const theme = localStorage.getItem('colorTheme') || 'default';
  document.body.classList.toggle('theme-wood', theme === 'wood');
}

function showColorThemes() {
  const isWood = (localStorage.getItem('colorTheme') || 'default') === 'wood';
  document.getElementById('drawer-title').textContent = 'Color Themes';
  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-back" onclick="renderDrawerMenu()">‹ Back</button>
    <button class="drawer-toggle-row" onclick="toggleWoodTheme()">
      <span class="drawer-toggle-icon">🪵</span>
      <span class="drawer-toggle-label">Wood Theme</span>
      <div class="toggle-switch ${isWood ? 'on' : ''}" id="wood-toggle-switch"></div>
    </button>
  `;
}

function toggleWoodTheme() {
  const current = localStorage.getItem('colorTheme') || 'default';
  const isNowWood = current !== 'wood';
  localStorage.setItem('colorTheme', isNowWood ? 'wood' : 'default');
  applyTheme();
  queueSync();
  // Update any visible toggle in-place
  const toggle = document.getElementById('wood-toggle-switch') ||
    document.querySelector('#color-themes-content .toggle-switch');
  if (toggle) toggle.classList.toggle('on', isNowWood);
}

function showSettings() {
  const isWood = (localStorage.getItem('colorTheme') || 'default') === 'wood';
  document.getElementById('drawer-title').textContent = 'Settings';
  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-back" onclick="renderDrawerMenu()">‹ Back</button>

    <button class="drawer-item" onclick="toggleColorThemes()" id="color-themes-toggle">
      <span class="drawer-item-icon">🎨</span>
      <span class="drawer-item-text">Color Themes</span>
      <span class="drawer-item-arrow" id="color-themes-arrow">›</span>
    </button>
    <div id="color-themes-content" style="display:none;">
      <button class="drawer-toggle-row" style="padding-left:36px" onclick="toggleWoodTheme()">
        <span class="drawer-toggle-icon">🪵</span>
        <span class="drawer-toggle-label">Wood</span>
        <div class="toggle-switch ${isWood ? 'on' : ''}"></div>
      </button>
    </div>

    <div class="drawer-divider"></div>

    <button class="drawer-item danger" onclick="toggleDangerZone()" id="danger-zone-toggle">
      <span class="drawer-item-icon">⚠️</span>
      <span class="drawer-item-text">Danger Zone</span>
      <span class="drawer-item-arrow" id="danger-arrow">›</span>
    </button>
    <div id="danger-zone-content" style="display:none;">
      <button class="drawer-item danger" style="padding-left:36px" onclick="clearTodayData()">
        <span class="drawer-item-icon">🗑️</span>
        <span class="drawer-item-text">Clear Today's Data</span>
      </button>
      <button class="drawer-item danger" style="padding-left:36px" onclick="resetAllData()">
        <span class="drawer-item-icon">💣</span>
        <span class="drawer-item-text">Reset All Data</span>
      </button>
    </div>
  `;
}

function toggleColorThemes() {
  const content = document.getElementById('color-themes-content');
  const arrow = document.getElementById('color-themes-arrow');
  const open = content.style.display === 'none';
  content.style.display = open ? 'block' : 'none';
  arrow.textContent = open ? '⌄' : '›';
}

function toggleDangerZone() {
  const content = document.getElementById('danger-zone-content');
  const arrow = document.getElementById('danger-arrow');
  const open = content.style.display === 'none';
  content.style.display = open ? 'block' : 'none';
  arrow.textContent = open ? '⌄' : '›';
}

// ── DRAWER CALENDAR ──────────────────────────────────────
let drawerYear  = new Date().getFullYear();
let drawerMonth = new Date().getMonth();

function showDateCalendar() {
  document.getElementById('drawer-title').textContent = 'Edit a Day';
  renderDrawerCalendar();
}

function drawerCalPrev() {
  drawerMonth--;
  if (drawerMonth < 0) { drawerMonth = 11; drawerYear--; }
  renderDrawerCalendar();
}

function drawerCalNext() {
  drawerMonth++;
  if (drawerMonth > 11) { drawerMonth = 0; drawerYear++; }
  renderDrawerCalendar();
}

function renderDrawerCalendar() {
  const habitData = loadData();
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  const today = getToday();

  const monthLabel = new Date(drawerYear, drawerMonth).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric'
  });

  const firstDay = new Date(drawerYear, drawerMonth, 1).getDay();
  const daysInMonth = new Date(drawerYear, drawerMonth + 1, 0).getDate();

  const dayHeaders = ['Su','Mo','Tu','We','Th','Fr','Sa']
    .map(d => `<div class="drawer-cal-day-header">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < firstDay; i++) {
    cells += `<div class="drawer-cal-cell empty"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${drawerYear}-${String(drawerMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday   = dateStr === today;
    const isFuture  = dateStr > today;

    const dayHabits  = habitData[dateStr] || {};
    const dayJournal = journals[dateStr] || {};
    const habitsCompleted = getHabits().filter(h => dayHabits[h.id]).length;
    const gratitudeDone   = [1,2,3].filter(n => dayJournal[`s${n}`]).length;
    const hasData   = habitsCompleted > 0 || gratitudeDone > 0;
    const isPerfect = habitsCompleted === getHabits().length && gratitudeDone === 3;

    let cls = 'drawer-cal-cell';
    if (isFuture)       cls += ' future';
    else if (isPerfect) cls += ' has-data perfect';
    else if (hasData)   cls += ' has-data';
    if (isToday) cls += ' is-today';

    const click = isFuture ? '' : `onclick="openEditDay('${dateStr}')"`;
    cells += `<div class="${cls}" ${click}>${day}</div>`;
  }

  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-back" onclick="renderDrawerMenu()">‹ Back</button>
    <div class="drawer-cal-header">
      <button class="drawer-cal-nav" onclick="drawerCalPrev()">‹</button>
      <span class="drawer-cal-month">${monthLabel}</span>
      <button class="drawer-cal-nav" onclick="drawerCalNext()">›</button>
    </div>
    <div class="drawer-cal-grid">
      <div class="drawer-cal-day-headers">${dayHeaders}</div>
      <div class="drawer-cal-cells">${cells}</div>
    </div>
  `;
}

function openEditDay(date) {
  const label = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  document.getElementById('drawer-title').textContent = label;

  const habitData = loadData();
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  const dayHabits = habitData[date] || {};
  const dayJournal = journals[date] || {};

  const habitRows = getHabits().map(h => {
    const done = !!dayHabits[h.id];
    return `
      <div class="edit-habit-row${done ? ' done' : ''}">
        <span class="edit-habit-emoji">${h.emoji}</span>
        <span class="edit-habit-name">${h.name}</span>
        <button class="edit-habit-btn${done ? ' done' : ''}" onclick="toggleEditHabit('${date}', '${h.id}')">✓</button>
      </div>`;
  }).join('');

  const gratitudeRows = [1,2,3].map(n => {
    const text = dayJournal[`g${n}`] || '';
    const submitted = !!dayJournal[`s${n}`];
    return `
      <div class="edit-grateful-row${submitted ? ' done' : ''}">
        <div class="edit-grateful-num">${n}</div>
        <div class="edit-grateful-content">
          <textarea id="egt-${n}-${date}" class="edit-grateful-input"
            placeholder="I'm grateful for..."
            style="${submitted ? 'display:none' : ''}"
          >${text}</textarea>
          <div class="edit-grateful-done-text" style="${!submitted ? 'display:none' : ''}">completed</div>
        </div>
        <button class="edit-grateful-btn${submitted ? ' done' : ''}" onclick="toggleEditGrateful('${date}', ${n})">✓</button>
      </div>`;
  }).join('');

  document.getElementById('drawer-body').innerHTML = `
    <button class="drawer-back" onclick="showDateCalendar()">‹ Calendar</button>
    <div class="edit-section-label">Habits</div>
    ${habitRows}
    <div class="edit-section-label" style="margin-top:12px">Gratitude</div>
    ${gratitudeRows}
  `;
}

function toggleEditHabit(date, habitId) {
  const data = loadData();
  if (!data[date]) data[date] = {};
  data[date][habitId] = !data[date][habitId];
  saveData(data);
  openEditDay(date);
  if (date === getToday()) render();
}

function toggleEditGrateful(date, n) {
  const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
  if (!journals[date]) journals[date] = { g1:'', g2:'', g3:'', s1:false, s2:false, s3:false };
  const isSubmitted = journals[date][`s${n}`];
  if (isSubmitted) {
    journals[date][`s${n}`] = false;
  } else {
    const ta = document.getElementById(`egt-${n}-${date}`);
    const text = ta ? ta.value.trim() : '';
    if (!text) return;
    journals[date][`g${n}`] = text;
    journals[date][`s${n}`] = true;
  }
  localStorage.setItem('grateful', JSON.stringify(journals));
  openEditDay(date);
  if (date === getToday()) renderJournal();
}

function clearTodayData() {
  showConfirmModal({
    icon: '🗑️',
    title: "Clear Today's Data?",
    message: "All of today's habits and gratitude entries will be permanently erased.",
    confirmLabel: 'Clear Today',
  });
  _confirmCallback = () => {
    const today = getToday();
    const data = loadData();
    delete data[today];
    saveData(data);
    const journals = JSON.parse(localStorage.getItem('grateful') || '{}');
    delete journals[today];
    localStorage.setItem('grateful', JSON.stringify(journals));
    closeDrawer();
    buildHabitCards();
    render();
    renderJournal();
  };
}

function resetAllData() {
  showConfirmModal({
    icon: '💣',
    title: 'Delete ALL Data?',
    message: 'Every habit record and gratitude entry will be permanently deleted. This cannot be undone.',
    confirmLabel: 'Delete Everything',
  });
  _confirmCallback = () => {
    localStorage.removeItem('habitData');
    localStorage.removeItem('grateful');
    localStorage.removeItem('habitOrder');
    closeDrawer();
    buildHabitCards();
    render();
    renderJournal();
  };
}

// ── PULL TO REFRESH ──────────────────────────────────────
(function initPullToRefresh() {
  let startY = 0;
  let pulling = false;
  let triggered = false;
  const threshold = window.innerHeight * 0.10;

  const indicator = document.createElement('div');
  indicator.id = 'ptr-indicator';
  indicator.innerHTML = '<div class="ptr-spinner"></div>';
  document.body.appendChild(indicator);

  const appEl = document.querySelector('.app') || document.body;

  function getScrollTop() {
    const active = document.querySelector('.page-inner.active') || document.querySelector('.page.active');
    return active ? active.scrollTop : window.scrollY;
  }

  document.addEventListener('touchstart', e => {
    if (getScrollTop() > 2) return;
    startY = e.touches[0].clientY;
    pulling = true;
    triggered = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pulling = false; return; }
    if (getScrollTop() > 2) { pulling = false; return; }

    const pull = Math.min(dy, threshold * 1.5);
    const pct  = Math.min(pull / threshold, 1);

    appEl.style.transform = `translateY(${pull * 0.4}px)`;
    appEl.style.transition = 'none';

    indicator.style.opacity = pct;
    indicator.style.transform = `translateX(-50%) translateY(${Math.min(pull * 0.4, 32)}px) scale(${0.5 + pct * 0.5})`;

    if (pull >= threshold && !triggered) {
      triggered = true;
      indicator.classList.add('spinning');
    }
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;

    appEl.style.transition = 'transform 0.35s cubic-bezier(0.25,1,0.5,1)';
    appEl.style.transform = '';

    if (triggered) {
      indicator.style.opacity = '1';
      setTimeout(() => {
        // Refresh current tab content
        const tab = document.querySelector('.nav-btn.active');
        if (tab) tab.click();
        if (typeof loadFromCloud === 'function') loadFromCloud();

        indicator.style.opacity = '0';
        indicator.style.transform = 'translateX(-50%) translateY(0) scale(0.5)';
        indicator.classList.remove('spinning');
      }, 900);
    } else {
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateX(-50%) translateY(0) scale(0.5)';
    }
  });
})();

// ── FRIENDS MANAGER ──────────────────────────────────────
async function openFriendsManager() {
  // Remove any existing modal
  document.getElementById('friends-manager-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'friends-manager-modal';
  modal.innerHTML = `
    <div class="fmgr-backdrop" onclick="closeFriendsManager()"></div>
    <div class="fmgr-sheet">
      <div class="fmgr-handle"></div>
      <div class="fmgr-header">
        <span class="fmgr-title">Friends & Groups</span>
        <button class="fmgr-close" onclick="closeFriendsManager()">✕</button>
      </div>

      <div class="fmgr-section-label">Add a Friend</div>
      <button class="fmgr-add-btn" onclick="shareFriendLink('https://habit-tracker-2a0ed.web.app/?add=${_currentUser ? _currentUser.uid : ''}');">
        <span class="fmgr-add-icon">🔗</span> Copy Friend Invite Link
      </button>

      <div class="fmgr-section-label" style="margin-top:20px">Your Friends</div>
      <div id="fmgr-friends-list"><div class="fmgr-loading">Loading…</div></div>

      <div class="fmgr-section-label" style="margin-top:24px">Groups</div>
      <button class="fmgr-add-btn fmgr-group-btn" onclick="promptCreateGroup()">
        <span class="fmgr-add-icon">👥</span> Create a Group
      </button>
      <div id="fmgr-groups-list" style="margin-top:12px"><div class="fmgr-loading">Loading…</div></div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  if (!_currentUser || !_fbDb) {
    document.getElementById('fmgr-friends-list').innerHTML = '<div class="fmgr-empty">Sign in to manage friends.</div>';
    document.getElementById('fmgr-groups-list').innerHTML = '';
    return;
  }

  // Load friends
  try {
    const myDoc = await _fbDb.collection('users').doc(_currentUser.uid).get();
    const friends = myDoc.exists ? (myDoc.data().friends || []) : [];
    const listEl = document.getElementById('fmgr-friends-list');
    if (friends.length === 0) {
      listEl.innerHTML = '<div class="fmgr-empty">No friends yet — share your invite link!</div>';
    } else {
      let html = '';
      for (const uid of friends) {
        try {
          const fd = (await _fbDb.collection('users').doc(uid).get()).data() || {};
          const name = fd.displayName || fd.email || uid;
          const initial = name.charAt(0).toUpperCase();
          const photo = fd.photoDataUrl ? `<img src="${fd.photoDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initial;
          html += `
            <div class="fmgr-friend-row">
              <div class="fmgr-avatar">${photo}</div>
              <div class="fmgr-friend-name">${name}</div>
              <button class="fmgr-remove" onclick="removeFriendFromManager('${uid}')">Remove</button>
            </div>`;
        } catch(e) { /* skip */ }
      }
      listEl.innerHTML = html;
    }
  } catch(e) {
    document.getElementById('fmgr-friends-list').innerHTML = '<div class="fmgr-empty">Could not load friends.</div>';
  }

  // Load groups
  await _loadManagerGroups();
}

async function _loadManagerGroups() {
  const listEl = document.getElementById('fmgr-groups-list');
  if (!listEl) return;
  try {
    const snap = await _fbDb.collection('groups')
      .where('members', 'array-contains', _currentUser.uid).get();
    if (snap.empty) {
      listEl.innerHTML = '<div class="fmgr-empty">No groups yet — create one!</div>';
      return;
    }
    let html = '';
    snap.forEach(doc => {
      const g = doc.data();
      const memberCount = (g.members || []).length;
      html += `
        <div class="fmgr-group-row">
          <div class="fmgr-group-icon">👥</div>
          <div class="fmgr-group-info">
            <div class="fmgr-group-name">${g.name}</div>
            <div class="fmgr-group-meta">${memberCount} member${memberCount !== 1 ? 's' : ''}</div>
          </div>
          <div class="fmgr-group-actions">
            <button class="fmgr-remove" onclick="shareGroupLink('${doc.id}')">Invite</button>
            <button class="fmgr-remove" style="color:#888" onclick="leaveGroup('${doc.id}')">Leave</button>
          </div>
        </div>`;
    });
    listEl.innerHTML = html;
  } catch(e) {
    listEl.innerHTML = '<div class="fmgr-empty">Could not load groups.</div>';
  }
}

async function removeFriendFromManager(friendUid) {
  if (!_currentUser || !_fbDb) return;
  if (!confirm('Remove this friend?')) return;
  try {
    await _fbDb.collection('users').doc(_currentUser.uid).update({
      friends: firebase.firestore.FieldValue.arrayRemove(friendUid)
    });
    openFriendsManager(); // refresh the modal
    renderFriends();
  } catch(e) {
    alert('Could not remove: ' + (e.code || e.message));
  }
}

function closeFriendsManager() {
  const modal = document.getElementById('friends-manager-modal');
  if (!modal) return;
  modal.classList.remove('open');
  setTimeout(() => modal.remove(), 300);
}

function promptCreateGroup() {
  const name = prompt('Group name:');
  if (!name || !name.trim()) return;
  createGroup(name.trim());
}

async function createGroup(name) {
  if (!_currentUser || !_fbDb) return;
  try {
    const ref = await _fbDb.collection('groups').add({
      name,
      createdBy: _currentUser.uid,
      members: [_currentUser.uid],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await _fbDb.collection('users').doc(_currentUser.uid).update({
      groups: firebase.firestore.FieldValue.arrayUnion(ref.id)
    });
    shareGroupLink(ref.id);
    await _loadManagerGroups();
    renderFriends();
  } catch(e) {
    alert('Could not create group: ' + (e.code || e.message));
  }
}

function shareGroupLink(groupId) {
  const url = `https://habit-tracker-2a0ed.web.app/?joingroup=${groupId}`;
  if (navigator.share) {
    navigator.share({ title: 'Join my habit group!', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => alert('Group invite link copied!')).catch(() => {});
  }
}

async function joinGroup(groupId) {
  if (!_currentUser || !_fbDb) return;
  try {
    await _fbDb.collection('groups').doc(groupId).update({
      members: firebase.firestore.FieldValue.arrayUnion(_currentUser.uid)
    });
    await _fbDb.collection('users').doc(_currentUser.uid).update({
      groups: firebase.firestore.FieldValue.arrayUnion(groupId)
    });
    renderFriends();
  } catch(e) {
    console.warn('Could not join group:', e);
  }
}

async function leaveGroup(groupId) {
  if (!_currentUser || !_fbDb) return;
  if (!confirm('Leave this group?')) return;
  try {
    await _fbDb.collection('groups').doc(groupId).update({
      members: firebase.firestore.FieldValue.arrayRemove(_currentUser.uid)
    });
    await _fbDb.collection('users').doc(_currentUser.uid).update({
      groups: firebase.firestore.FieldValue.arrayRemove(groupId)
    });
    await _loadManagerGroups();
    renderFriends();
  } catch(e) {
    alert('Could not leave group: ' + (e.code || e.message));
  }
}
