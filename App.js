// ===================================================
// 1. SUPABASE CLIENT & SOFT AUTH SETUP
// ===================================================
const SUPABASE_URL = 'https://wauinjxrmknqtbohfkrd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhdWluanhybWtucXRib2hma3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjc3MjIsImV4cCI6MjA5OTYwMzcyMn0.oJLojkkqZbpYXEEJ1WGhpH2ICWLaJVjYyupCUgbpG3s';

// NOTE: Ownership used to be a random key stashed in localStorage (soft
// auth). That breaks the moment you switch browsers/devices or clear site
// data, which is why editing your own matches could randomly stop working.
// Ownership is now tied to a real Supabase Auth account (magic-link email
// sign-in) instead — see initAuth()/currentUser below.
let currentUser = null;

function getOrCreateHostSessionId() {
  try {
    let id = sessionStorage.getItem('athena_host_session_id');
    if (id) return id;
    const bytes = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    id = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    try {
      sessionStorage.setItem('athena_host_session_id', id);
    } catch (storageErr) {
      console.warn('Athena Hub: sessionStorage unavailable.');
    }
    return id;
  } catch (err) {
    return 'hsess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

const HOST_SESSION_ID = getOrCreateHostSessionId();
const HOST_LOCK_STALE_MS = 12000; // ms of silence before a host lock is considered abandoned

let supabaseClient = null;
try {
  if (SUPABASE_URL && !SUPABASE_URL.includes('YOUR_SUPABASE')) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.warn('Athena Hub: Supabase credentials are using placeholder values.');
  }
} catch (err) {
  console.error('Athena Hub: Invalid Supabase configuration:', err.message);
}

// Global Match & Live Host Engine States
let currentMatch = null;
let currentConfigs = {};
let currentQuestions = [];
let activeQuestionIndex = 0;
let isOwner = false;
let isTransitioning = false; // Prevents accidental double-clicks from skipping questions

const hostState = {
  audio: window.QuizArenaAudio ? new window.QuizArenaAudio() : null,
  snapshot: null,
  channel: null,
  gameId: '',
  gamePin: '',
  hostToken: '',
  serverOffsetMs: 0,
  timerInterval: null,
  autoAdvanceTimer: null,
  revealRequestedFor: '',
  lastAnswerTotal: 0,
  lastStatus: '',
  confettiFired: false,
  finishedRendered: false,
  muted: false,
  loading: false,
  snapshotQueued: false,
  isController: false,
  lockHeartbeatTimer: null,
  finishedRevealScheduled: false
};

const INDEX_TO_CHOICE = ['A', 'B', 'C', 'D'];
const CHOICE_TO_INDEX = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

// ===================================================
// 1b. AUTHENTICATION (Supabase Auth — magic link email)
// ===================================================
async function initAuth() {
  if (!supabaseClient) return;

  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session ? session.user : null;
  updateAuthUI();
  if (document.getElementById('matches-container')) {
    fetchMatchesFromDb();
  }

  supabaseClient.auth.onAuthStateChange((_event, newSession) => {
    currentUser = newSession ? newSession.user : null;
    updateAuthUI();

    const kahootView = document.getElementById('kahoot-view');
    if (kahootView && kahootView.style.display !== 'none') {
      fetchMatchesFromDb();
    }
  });
}

function updateAuthUI() {
  const signedOutEl = document.getElementById('auth-signed-out');
  const signedInEl = document.getElementById('auth-signed-in');
  const labelEl = document.getElementById('auth-user-label');
  const settingsInfo = document.getElementById('settings-account-info');
  const accountEmailDisplay = document.getElementById('account-email-display');
  const accountNameInput = document.getElementById('account-name-input');

  if (currentUser) {
    const displayName = (currentUser.user_metadata && currentUser.user_metadata.full_name) || '';

    if (signedOutEl) signedOutEl.style.display = 'none';
    if (signedInEl) signedInEl.style.display = 'flex';
    if (labelEl) labelEl.textContent = displayName || (currentUser.email || 'Account').split('@')[0];
    if (settingsInfo) settingsInfo.textContent = `Signed in as ${currentUser.email || currentUser.id}`;
    if (accountEmailDisplay) accountEmailDisplay.textContent = currentUser.email || '';
    if (accountNameInput) accountNameInput.value = displayName;
  } else {
    if (signedOutEl) signedOutEl.style.display = 'flex';
    if (signedInEl) signedInEl.style.display = 'none';
    if (settingsInfo) settingsInfo.textContent = "Not signed in \u2014 sign in to create and edit matches.";
  }
}

window.openSignInModal = function() {
  const overlay = document.getElementById('signin-modal-overlay');
  const status = document.getElementById('signin-modal-status');
  if (status) { status.textContent = ''; status.className = 'ai-modal-status'; }
  if (overlay) overlay.classList.add('open');
};

window.closeSignInModal = function() {
  const overlay = document.getElementById('signin-modal-overlay');
  if (overlay) overlay.classList.remove('open');
};

window.submitSignIn = async function() {
  const emailInput = document.getElementById('signin-email');
  const status = document.getElementById('signin-modal-status');
  const submitBtn = document.getElementById('signin-modal-submit');
  const setStatus = (msg, cls) => { if (status) { status.textContent = msg; status.className = 'ai-modal-status ' + (cls || ''); } };

  const email = emailInput ? emailInput.value.trim() : '';
  if (!email) {
    setStatus('Enter your email first.', 'error');
    return;
  }

  setStatus('Sending magic link...', 'is-loading');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    setStatus('Check your email for a sign-in link!', '');
  } catch (err) {
    setStatus(err.message || 'Could not send sign-in link.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

window.signOutUser = async function() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  window.closeAccountModal();
};

window.openAccountModal = function() {
  if (!currentUser) return;
  const overlay = document.getElementById('account-modal-overlay');
  const status = document.getElementById('account-modal-status');
  if (status) { status.textContent = ''; status.className = 'ai-modal-status'; }
  updateAuthUI();
  if (overlay) overlay.classList.add('open');
};

window.closeAccountModal = function() {
  const overlay = document.getElementById('account-modal-overlay');
  if (overlay) overlay.classList.remove('open');
};

window.submitAccountSettings = async function() {
  if (!supabaseClient || !currentUser) return;

  const nameInput = document.getElementById('account-name-input');
  const status = document.getElementById('account-modal-status');
  const submitBtn = document.getElementById('account-modal-submit');
  const setStatus = (msg, cls) => { if (status) { status.textContent = msg; status.className = 'ai-modal-status ' + (cls || ''); } };

  const name = nameInput ? nameInput.value.trim() : '';

  setStatus('Saving...', 'is-loading');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { data, error } = await supabaseClient.auth.updateUser({ data: { full_name: name } });
    if (error) throw error;
    currentUser = data.user;
    updateAuthUI();
    setStatus('Saved!', '');
  } catch (err) {
    setStatus(err.message || 'Could not save.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

// ===================================================
// 2. VIEW NAVIGATION & UI CONTROLS
// ===================================================
window.showKahootView = function(view) {
  const kahootView = document.getElementById('kahoot-view');
  const editorView = document.getElementById('editor-view');
  const hostView = document.getElementById('host-view');
  const hubStatusText = document.getElementById('hub-status-text');
  const navMatches = document.getElementById('nav-matches');
  const navEditor = document.getElementById('nav-editor');

  if (!kahootView || !editorView || !hostView) return;

  clearTimeout(hostState.autoAdvanceTimer);
  if (view !== 'host') {
    clearInterval(hostState.lockHeartbeatTimer);
  }

  kahootView.style.display = 'none';
  editorView.style.display = 'none';
  hostView.style.display = 'none';

  if (navMatches) navMatches.classList.remove('active');
  if (navEditor) navEditor.classList.remove('active');

  if (view === 'editor') {
    document.body.classList.remove('host-active');
    editorView.style.display = 'block';
    if (navEditor) navEditor.classList.add('active');
    if (hubStatusText) hubStatusText.textContent = 'Game Editor Active';
  } else if (view === 'host') {
    document.body.classList.add('host-active');
    hostView.style.display = 'block';
    if (navMatches) navMatches.classList.add('active');
    if (hubStatusText) hubStatusText.textContent = 'Hosting Match';
  } else {
    document.body.classList.remove('host-active');
    kahootView.style.display = 'block';
    if (navMatches) navMatches.classList.add('active');
    if (hubStatusText) hubStatusText.textContent = 'Kahoot Arena Active';
    fetchMatchesFromDb();
  }
};

window.toggleSidebar = function() {
  const kahootLayout = document.getElementById('kahoot-layout');
  if (kahootLayout) {
    kahootLayout.classList.toggle('sidebar-retracted');
  }
};

window.showSidebarTab = function(tab) {
  document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
  const modalRules = document.getElementById('modal-rules');
  const modalSettings = document.getElementById('modal-settings');

  if (modalRules) modalRules.style.display = 'none';
  if (modalSettings) modalSettings.style.display = 'none';

  if (tab === 'rules') {
    const menuRules = document.getElementById('menu-rules');
    if (menuRules) menuRules.classList.add('active');
    if (modalRules) modalRules.style.display = 'block';
  } else if (tab === 'settings') {
    const menuSettings = document.getElementById('menu-settings');
    if (menuSettings) menuSettings.classList.add('active');
    if (modalSettings) modalSettings.style.display = 'block';
  } else {
    const menuHome = document.getElementById('menu-home');
    if (menuHome) menuHome.classList.add('active');
  }
};

// ===================================================
// 3. MATCH DASHBOARD & EDITOR CRUD OPERATIONS
// ===================================================
function generateGamePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function fetchMatchesFromDb() {
  const container = document.getElementById('matches-container');
  if (!container) return;

  if (!supabaseClient) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 2rem;">
        <p style="color: #ff5e36; font-weight: 700; margin-bottom: 0.5rem;">Supabase Connection Required</p>
        <p style="opacity: 0.7; font-size: 0.9rem;">Update <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> at the top of <code>App.js</code>.</p>
      </div>`;
    return;
  }

  container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; opacity: 0.7;">Loading matches...</p>`;

  try {
    const { data: games, error: gError } = await supabaseClient
      .from('games')
      .select('*')
      .order('created_at', { ascending: false });

    if (gError) throw gError;

    if (!games || games.length === 0) {
      container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; opacity: 0.7;">No matches found. Click "Create Match" to start!</p>`;
      return;
    }

    const gameIds = games.map(g => g.id);
    const { data: configs } = await supabaseClient
      .from('config')
      .select('*')
      .in('game_id', gameIds);

    const configMap = {};
    if (configs) {
      configs.forEach(c => {
        if (!configMap[c.game_id]) configMap[c.game_id] = {};
        configMap[c.game_id][c.key] = c.value;
      });
    }

    container.innerHTML = '';

    games.forEach(game => {
      const isCreator = !!(currentUser && game.host_token === currentUser.id);
      const gameConfig = configMap[game.id] || {};
      const title = gameConfig.title || `Match PIN: ${game.game_pin}`;
      const teamTag = gameConfig.team_tag || 'TECH TEAM';

      const cardHtml = `
        <div class="match-card">
          <div class="match-thumb" style="background-image: linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.65)), url('Images/kahoot.jpg');">
            <span class="thumb-tag" style="background: ${isCreator ? '#10b981' : '#e63946'};">
              ${isCreator ? 'YOUR MATCH' : teamTag}
            </span>
          </div>
          <div class="match-title-row">
            <div class="match-title">${escapeHtml(title)}</div>
            ${isCreator ? `
              <i class="fa-solid fa-trash" style="color: #ef4444; cursor: pointer;" title="Delete match" onclick="deleteMatch('${game.id}', event)"></i>
            ` : `
              <i class="fa-solid fa-ellipsis-vertical" style="color: var(--text-muted);"></i>
            `}
          </div>
          <div class="match-stats">
            <div class="stat-box">
              <div class="stat-label">PIN</div>
              <div class="stat-value">${game.game_pin}</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Access</div>
              <div class="stat-value">${isCreator ? 'Editable' : 'Read-Only'}</div>
            </div>
          </div>
          <div class="match-actions">
            <button class="btn-host-match" onclick="hostMatch('${game.id}')">
              <i class="fa-solid fa-tower-broadcast"></i> Host Live
            </button>
            <button class="btn-edit-match" onclick="openMatchEditor('${game.id}')">
              <i class="fa-solid ${isCreator ? 'fa-pen-to-square' : 'fa-eye'}"></i>
              ${isCreator ? 'Edit' : 'View'}
            </button>
          </div>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', cardHtml);
    });

  } catch (error) {
    console.error('Error fetching games:', error);
    container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #ff5e36;">Failed to load matches from database.</p>`;
  }
}

window.deleteMatch = async function(gameId, evt) {
  if (evt) evt.stopPropagation();
  if (!supabaseClient || !currentUser) return;

  if (!confirm('Delete this match permanently? This removes all its questions and cannot be undone.')) return;

  try {
    // Clear out dependent rows first (no cascading FKs to rely on).
    await supabaseClient.from('game_events').delete().eq('game_id', gameId);
    await supabaseClient.from('players').delete().eq('game_id', gameId);
    await supabaseClient.from('questions').delete().eq('game_id', gameId);
    await supabaseClient.from('config').delete().eq('game_id', gameId);

    // Scoped to host_token as a defense-in-depth check even though the
    // button is only ever rendered for matches the current user owns.
    const { error } = await supabaseClient
      .from('games')
      .delete()
      .eq('id', gameId)
      .eq('host_token', currentUser.id);

    if (error) throw error;

    fetchMatchesFromDb();
  } catch (err) {
    alert('Error deleting match: ' + err.message);
  }
};

window.createNewMatchInDb = async function() {
  if (!supabaseClient) {
    alert('Please configure your Supabase URL and Anon Key in App.js first.');
    return;
  }

  if (!currentUser) {
    window.openSignInModal();
    return;
  }

  const pin = generateGamePin();

  try {
    const { data: newGame, error: gError } = await supabaseClient
      .from('games')
      .insert([{
        game_pin: pin,
        host_token: currentUser.id,
        status: 'LOBBY',
        default_timer: 20,
        question_timer_limit: 20
      }])
      .select()
      .single();

    if (gError) throw gError;

    await supabaseClient.from('config').insert([
      { game_id: newGame.id, key: 'title', value: 'New Kahoot Match' },
      { game_id: newGame.id, key: 'team_tag', value: 'TECH TEAM' }
    ]);

    await supabaseClient.from('questions').insert([{
      game_id: newGame.id,
      sort_order: 1,
      round: '1',
      question: 'What is the capital of France?',
      option_a: 'Berlin',
      option_b: 'London',
      option_c: 'Paris',
      option_d: 'Madrid',
      correct: 'C',
      image_url: 'Images/kahoot.jpg',
      time_limit: 20
    }]);

    window.openMatchEditor(newGame.id);
  } catch (err) {
    alert('Error creating game: ' + err.message);
  }
};

window.openMatchEditor = async function(gameId) {
  if (!supabaseClient) return;

  try {
    const { data: game, error: gError } = await supabaseClient
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gError || !game) {
      alert('Match not found.');
      return;
    }

    const { data: configs } = await supabaseClient
      .from('config')
      .select('*')
      .eq('game_id', gameId);

    currentConfigs = {};
    if (configs) {
      configs.forEach(c => { currentConfigs[c.key] = c; });
    }

    const { data: questions } = await supabaseClient
      .from('questions')
      .select('*')
      .eq('game_id', gameId)
      .order('sort_order', { ascending: true });

    currentMatch = game;
    currentQuestions = questions || [];
    activeQuestionIndex = 0;
    isOwner = !!(currentUser && game.host_token === currentUser.id);

    const btnAdd = document.getElementById('btn-add-q');
    const btnSave = document.getElementById('btn-save-q');
    const btnDelete = document.getElementById('btn-delete-q');
    const btnImport = document.getElementById('btn-import-q');
    const btnGenerate = document.getElementById('btn-generate-q');

    if (btnAdd) btnAdd.style.display = isOwner ? 'flex' : 'none';
    if (btnSave) btnSave.style.display = isOwner ? 'flex' : 'none';
    if (btnDelete) btnDelete.style.display = isOwner ? 'flex' : 'none';
    if (btnImport) btnImport.style.display = isOwner ? 'flex' : 'none';
    if (btnGenerate) btnGenerate.style.display = isOwner ? 'flex' : 'none';

    const titleVal = currentConfigs.title ? currentConfigs.title.value : `Match PIN: ${game.game_pin}`;
    const titleInput = document.getElementById('editor-game-title');
    if (titleInput) {
      titleInput.value = titleVal;
      titleInput.disabled = !isOwner;
    }

    const permissionPill = document.getElementById('permission-pill');
    if (permissionPill) {
      permissionPill.innerHTML = `<span style="opacity: 0.6; margin-right: 4px;">Access:</span> ${isOwner ? '<span style="color:#10b981;">Owner</span>' : '<span style="color:#ef4444;">Read Only</span>'}`;
    }

    renderQuestionsSidebar();

    if (currentQuestions.length > 0) {
      window.loadQuestionIntoCanvas(0);
    }

    window.showKahootView('editor');

  } catch (err) {
    alert('Error loading editor: ' + err.message);
  }
};

function renderQuestionsSidebar() {
  const container = document.getElementById('questions-list-container');
  const countBadge = document.getElementById('q-count-badge');
  if (countBadge) countBadge.textContent = currentQuestions.length;

  if (!container) return;
  container.innerHTML = '';

  currentQuestions.forEach((q, idx) => {
    const activeClass = idx === activeQuestionIndex ? 'active' : '';
    const qHtml = `
      <div class="q-thumb-card ${activeClass}" onclick="loadQuestionIntoCanvas(${idx})">
        <div class="q-thumb-label">${idx + 1}. Round ${q.round || idx + 1}</div>
        <div class="q-thumb-title">${escapeHtml(q.question || 'Untitled Question')}</div>
        <div class="q-thumb-img-placeholder" style="background-image: url('${q.image_url || 'Images/kahoot.jpg'}');"></div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', qHtml);
  });
}

window.loadQuestionIntoCanvas = function(index) {
  if (!currentQuestions[index]) return;
  activeQuestionIndex = index;
  renderQuestionsSidebar();

  const q = currentQuestions[index];

  const promptInput = document.getElementById('editor-q-prompt');
  if (promptInput) {
    promptInput.value = q.question;
    promptInput.disabled = !isOwner;
  }

  const mediaCanvas = document.getElementById('editor-media-canvas');
  if (mediaCanvas) {
    const imgUrl = q.image_url || 'Images/kahoot.jpg';
    mediaCanvas.style.backgroundImage = 'linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.4)), url(' + JSON.stringify(imgUrl) + ')';
  }

  const optionsText = [q.option_a, q.option_b, q.option_c, q.option_d];
  const correctIdx = CHOICE_TO_INDEX[q.correct] !== undefined ? CHOICE_TO_INDEX[q.correct] : 0;

  for (let i = 0; i < 4; i++) {
    const textInput = document.getElementById(`ans-${i}-text`);
    const checkBtn = document.getElementById(`ans-${i}-check`);

    if (textInput) {
      textInput.value = optionsText[i] || '';
      textInput.disabled = !isOwner;
    }

    if (checkBtn) {
      if (i === correctIdx) {
        checkBtn.className = 'ans-check selected';
        checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      } else {
        checkBtn.className = 'ans-check';
        checkBtn.innerHTML = '';
      }
    }
  }
};

window.selectCorrectAnswer = function(selectedIndex) {
  if (!isOwner) return;

  for (let i = 0; i < 4; i++) {
    const checkBtn = document.getElementById(`ans-${i}-check`);
    if (checkBtn) {
      if (i === selectedIndex) {
        checkBtn.className = 'ans-check selected';
        checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      } else {
        checkBtn.className = 'ans-check';
        checkBtn.innerHTML = '';
      }
    }
  }
};

window.saveActiveQuestion = async function() {
  if (!isOwner) {
    alert('You do not have permission to edit this match.');
    return;
  }

  const q = currentQuestions[activeQuestionIndex];
  if (!q) return;

  const newPrompt = document.getElementById('editor-q-prompt').value;
  const optionA = document.getElementById('ans-0-text').value;
  const optionB = document.getElementById('ans-1-text').value;
  const optionC = document.getElementById('ans-2-text').value;
  const optionD = document.getElementById('ans-3-text').value;

  let correctChoice = 'A';
  for (let i = 0; i < 4; i++) {
    const checkBtn = document.getElementById(`ans-${i}-check`);
    if (checkBtn && checkBtn.classList.contains('selected')) {
      correctChoice = INDEX_TO_CHOICE[i];
      break;
    }
  }

  const { error } = await supabaseClient
    .from('questions')
    .update({
      question: newPrompt,
      option_a: optionA,
      option_b: optionB,
      option_c: optionC,
      option_d: optionD,
      correct: correctChoice,
      updated_at: new Date().toISOString()
    })
    .eq('id', q.id);

  if (error) {
    alert('Error saving question: ' + error.message);
  } else {
    q.question = newPrompt;
    q.option_a = optionA;
    q.option_b = optionB;
    q.option_c = optionC;
    q.option_d = optionD;
    q.correct = correctChoice;
    renderQuestionsSidebar();
    alert('Question saved successfully!');
  }
};

window.addQuestionToMatch = async function() {
  if (!isOwner) {
    alert('You do not have permission to modify this match.');
    return;
  }

  const newOrder = currentQuestions.length + 1;
  const newQ = {
    game_id: currentMatch.id,
    sort_order: newOrder,
    round: newOrder.toString(),
    question: 'New Question Prompt',
    option_a: 'Option A',
    option_b: 'Option B',
    option_c: 'Option C',
    option_d: 'Option D',
    correct: 'A',
    image_url: 'Images/kahoot.jpg',
    time_limit: 20
  };

  const { data, error } = await supabaseClient
    .from('questions')
    .insert([newQ])
    .select()
    .single();

  if (error) {
    alert('Error adding question: ' + error.message);
    return;
  }

  currentQuestions.push(data);
  window.loadQuestionIntoCanvas(currentQuestions.length - 1);
};

window.deleteActiveQuestion = async function() {
  if (!isOwner) {
    alert('You do not have permission to modify this match.');
    return;
  }
  
  if (currentQuestions.length <= 1) {
    alert('A match must have at least one question.');
    return;
  }

  const q = currentQuestions[activeQuestionIndex];
  if (!q) return;

  if (confirm('Are you sure you want to delete this question?')) {
    const { error } = await supabaseClient
      .from('questions')
      .delete()
      .eq('id', q.id);

    if (error) {
      alert('Error deleting question: ' + error.message);
      return;
    }

    currentQuestions.splice(activeQuestionIndex, 1);
    activeQuestionIndex = Math.max(0, activeQuestionIndex - 1);
    renderQuestionsSidebar();
    window.loadQuestionIntoCanvas(activeQuestionIndex);
  }
};

window.updateMatchTitle = async function(newTitle) {
  if (!isOwner || !currentMatch || !supabaseClient) return;

  if (currentConfigs.title) {
    await supabaseClient
      .from('config')
      .update({ value: newTitle, updated_at: new Date().toISOString() })
      .eq('id', currentConfigs.title.id);
  } else {
    const { data } = await supabaseClient
      .from('config')
      .insert([{ game_id: currentMatch.id, key: 'title', value: newTitle }])
      .select()
      .single();
    if (data) currentConfigs.title = data;
  }
};

// ===================================================
// 3b. AI IMPORT / GENERATE QUESTIONS (Gemini via Supabase Edge Function)
// ===================================================
window.openImportModal = function() {
  if (!isOwner) return;
  const overlay = document.getElementById('import-modal-overlay');
  const status = document.getElementById('import-modal-status');
  const fileInput = document.getElementById('import-file-input');
  const maxQ = document.getElementById('import-max-questions');
  if (status) { status.textContent = ''; status.className = 'ai-modal-status'; }
  if (fileInput) fileInput.value = '';
  if (maxQ) maxQ.value = '';
  if (overlay) overlay.classList.add('open');
};

window.closeImportModal = function() {
  const overlay = document.getElementById('import-modal-overlay');
  if (overlay) overlay.classList.remove('open');
};

window.openGenerateModal = function() {
  if (!isOwner) return;
  const overlay = document.getElementById('generate-modal-overlay');
  const status = document.getElementById('generate-modal-status');
  if (status) { status.textContent = ''; status.className = 'ai-modal-status'; }
  if (overlay) overlay.classList.add('open');
};

window.closeGenerateModal = function() {
  const overlay = document.getElementById('generate-modal-overlay');
  if (overlay) overlay.classList.remove('open');
};

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

async function insertGeneratedQuestions(questions) {
  if (!currentMatch || !Array.isArray(questions) || questions.length === 0) return;

  const startOrder = currentQuestions.length + 1;
  const rows = questions.map((q, idx) => ({
  game_id: currentMatch.id,
  sort_order: startOrder + idx,
  round: String(startOrder + idx),
  question: q.question,
  option_a: q.option_a,
  option_b: q.option_b,
  option_c: q.option_c,
  option_d: q.option_d,
  correct: q.correct,
  image_url: q.image_url || 'Images/kahoot.jpg',
  time_limit: 20
  }));

  const { data, error } = await supabaseClient
    .from('questions')
    .insert(rows)
    .select();

  if (error) throw new Error(error.message);

  const inserted = data || [];
  currentQuestions = currentQuestions.concat(inserted);
  renderQuestionsSidebar();
  if (inserted.length > 0) {
    window.loadQuestionIntoCanvas(currentQuestions.length - inserted.length);
  }
}

window.submitImportQuestions = async function() {
  if (!isOwner || !currentMatch) return;

  const fileInput = document.getElementById('import-file-input');
  const maxQInput = document.getElementById('import-max-questions');
  const status = document.getElementById('import-modal-status');
  const submitBtn = document.getElementById('import-modal-submit');
  const setStatus = (msg, cls) => { if (status) { status.textContent = msg; status.className = 'ai-modal-status ' + (cls || ''); } };

  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) {
    setStatus('Choose a PDF or .docx file first.', 'error');
    return;
  }

  const nameLower = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || nameLower.endsWith('.pdf');
  const isDocx = nameLower.endsWith('.docx');
  const isOldDoc = nameLower.endsWith('.doc') && !isDocx;

  if (isOldDoc) {
    setStatus("The old .doc format isn't supported \u2014 please save the file as .docx or PDF and try again.", 'error');
    return;
  }
  if (!isPdf && !isDocx) {
    setStatus('Please upload a PDF or .docx file.', 'error');
    return;
  }

  setStatus('Reading file...', 'is-loading');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const payload = {
      action: 'extract',
      game_id: currentMatch.id,
      max_questions: maxQInput && maxQInput.value ? Number(maxQInput.value) : null
    };

    if (isPdf) {
      payload.file_base64 = await readFileAsBase64(file);
      payload.mime_type = 'application/pdf';
    } else {
      if (!window.mammoth) throw new Error('Word document reader failed to load. Please refresh and try again.');
      const arrayBuffer = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer });
      payload.document_text = result.value;
    }

    setStatus('Asking Gemini to extract questions... this can take a moment.', 'is-loading');

    const { data, error } = await supabaseClient.functions.invoke('gemini-questions', { body: payload });

    if (error) throw new Error(error.message || 'Import failed.');
    if (data && data.error) throw new Error(data.error);

    await insertGeneratedQuestions(data.questions);
    setStatus(`Imported ${data.questions.length} question(s).`, '');
    setTimeout(() => window.closeImportModal(), 900);
  } catch (err) {
    setStatus(err.message || 'Import failed.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

window.submitGenerateQuestions = async function() {
  if (!isOwner || !currentMatch) return;

  const topicInput = document.getElementById('generate-topic');
  const countInput = document.getElementById('generate-count');
  const difficultySelect = document.getElementById('generate-difficulty');
  const status = document.getElementById('generate-modal-status');
  const submitBtn = document.getElementById('generate-modal-submit');
  const setStatus = (msg, cls) => { if (status) { status.textContent = msg; status.className = 'ai-modal-status ' + (cls || ''); } };

  const topic = topicInput ? topicInput.value.trim() : '';
  if (!topic) {
    setStatus('Enter a topic first.', 'error');
    return;
  }

  setStatus('Generating questions with Gemini...', 'is-loading');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { data, error } = await supabaseClient.functions.invoke('gemini-questions', {
      body: {
        action: 'generate',
        game_id: currentMatch.id,
        topic,
        count: countInput ? Number(countInput.value) : 5,
        difficulty: difficultySelect ? difficultySelect.value : 'medium'
      }
    });

    if (error) throw new Error(error.message || 'Generation failed.');
    if (data && data.error) throw new Error(data.error);

    await insertGeneratedQuestions(data.questions);
    setStatus(`Generated ${data.questions.length} question(s).`, '');
    setTimeout(() => window.closeGenerateModal(), 900);
  } catch (err) {
    setStatus(err.message || 'Generation failed.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

// ===================================================
// 4. LIVE KAHOOT STADIUM HOST ENGINE (OM SYNC SYSTEM)
// ===================================================
async function hostRpc(name, args) {
  const { data, error } = await supabaseClient.rpc(name, args || {});
  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

async function claimHostLock(gameId) {
  try {
    const { data: rows } = await supabaseClient
      .from('config')
      .select('*')
      .eq('game_id', gameId)
      .in('key', ['host_session_id', 'host_session_ts']);

    const map = {};
    (rows || []).forEach(r => { map[r.key] = r; });

    const existingSession = map.host_session_id ? map.host_session_id.value : '';
    const existingTs = map.host_session_ts ? Number(map.host_session_ts.value) : 0;
    const isStale = (Date.now() - existingTs) > HOST_LOCK_STALE_MS;
    const isOurs = existingSession === HOST_SESSION_ID;

    if (existingSession && !isStale && !isOurs) {
      hostState.isController = false;
      return false;
    }

    const nowStr = String(Date.now());

    if (map.host_session_id) {
      await supabaseClient.from('config').update({ value: HOST_SESSION_ID, updated_at: new Date().toISOString() }).eq('id', map.host_session_id.id);
    } else {
      await supabaseClient.from('config').insert([{ game_id: gameId, key: 'host_session_id', value: HOST_SESSION_ID }]);
    }

    if (map.host_session_ts) {
      await supabaseClient.from('config').update({ value: nowStr, updated_at: new Date().toISOString() }).eq('id', map.host_session_ts.id);
    } else {
      await supabaseClient.from('config').insert([{ game_id: gameId, key: 'host_session_ts', value: nowStr }]);
    }

    hostState.isController = true;
    return true;
  } catch (err) {
    console.error('Athena Hub: host lock check failed, defaulting to controller:', err);
    hostState.isController = true;
    return true;
  }
}

function startHostLockHeartbeat(gameId) {
  clearInterval(hostState.lockHeartbeatTimer);
  hostState.lockHeartbeatTimer = setInterval(async () => {
    if (!hostState.isController) return;
    try {
      await supabaseClient
        .from('config')
        .update({ value: String(Date.now()), updated_at: new Date().toISOString() })
        .eq('game_id', gameId)
        .eq('key', 'host_session_ts');
    } catch (err) {
      // Non-fatal: a missed heartbeat just risks losing the lock to a takeover.
    }
  }, 4000);
}

window.hostMatch = async function(gameId) {
  if (!supabaseClient) {
    alert('Please configure your Supabase URL and Anon Key in App.js first.');
    return;
  }

  try {
    const { data: game, error: gError } = await supabaseClient
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gError || !game) {
      alert('Match not found.');
      return;
    }

    hostState.gameId = game.id;
    hostState.gamePin = game.game_pin;
    hostState.hostToken = game.host_token;

    const gotLock = await claimHostLock(gameId);
    if (gotLock) {
      startHostLockHeartbeat(gameId);
    } else {
      clearInterval(hostState.lockHeartbeatTimer);
    }

    if (hostState.audio) {
      hostState.audio.unlock();
      if (hostState.muted) {
        hostState.audio.setMuted(true);
      }
    }

    window.showKahootView('host');
    await loadHostSnapshot();

  } catch (err) {
    alert('Error launching host match: ' + err.message);
  }
};

async function loadHostSnapshot() {
  if (hostState.loading) {
    hostState.snapshotQueued = true;
    return;
  }
  hostState.loading = true;

  try {
    const snap = await hostRpc('qa_host_snapshot', {
      p_game_pin: hostState.gamePin,
      p_host_token: hostState.hostToken
    });
    setHostSnapshot(snap);
  } catch (err) {
    showHostError(err.message || err);
  } finally {
    hostState.loading = false;
    if (hostState.snapshotQueued) {
      hostState.snapshotQueued = false;
      setTimeout(loadHostSnapshot, 60);
    }
  }
}

function setHostSnapshot(snap) {
  if (!snap || !snap.game) return;
  const previous = hostState.snapshot;
  const prevStatus = (previous && previous.game ? previous.game.status : '').toUpperCase();
  const status = (snap.game.status || '').toUpperCase();

  hostState.snapshot = snap;
  hostState.serverOffsetMs = new Date(snap.serverTime).getTime() - Date.now();
  hostState.gameId = snap.game.id;

  if (status !== 'FINISHED') {
    hostState.finishedRendered = false;
    hostState.finishedRevealScheduled = false;
  }

  // --- STREAK TRACKING LOGIC ---
  if (!hostState.streaks) hostState.streaks = {};
  if (!hostState.lastScores) hostState.lastScores = {};

  // When a round is revealed, check who gained points
  if (status === 'REVEAL' && prevStatus !== 'REVEAL') {
    (snap.leaderboard || []).forEach(p => {
      const currentScore = Number(p.totalScore || 0);
      const oldScore = hostState.lastScores[p.nickname] || 0;
      
      if (currentScore > oldScore) {
        hostState.streaks[p.nickname] = (hostState.streaks[p.nickname] || 0) + 1;
      } else {
        hostState.streaks[p.nickname] = 0; // Lost streak
      }
      hostState.lastScores[p.nickname] = currentScore;
    });
  } else if (status === 'LOBBY') {
    // Reset streaks if the room is reset
    hostState.streaks = {};
    hostState.lastScores = {};
  }

  subscribeHostRealtime();
  handleAudioTransitions(previous, snap);
  renderHostStage();
  startHostTimerLoop();
}

function subscribeHostRealtime() {
  if (!hostState.gameId || hostState.channel) return;

  hostState.channel = supabaseClient
    .channel('quiz-arena-host-' + hostState.gameId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'id=eq.' + hostState.gameId }, debounceHostSnapshot)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'game_id=eq.' + hostState.gameId }, debounceHostSnapshot)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_events', filter: 'game_id=eq.' + hostState.gameId }, function(payload) {
      const eventType = payload && payload.new ? payload.new.event_type : '';
      if (eventType === 'ANSWER' && hostState.audio && !hostState.muted) {
        hostState.audio.playSfx('Music/soundreality-pop-sound-423716.mp3');
      }
      debounceHostSnapshot();
    })
    .subscribe();
}

let hostDebounceHandle = null;
function debounceHostSnapshot() {
  clearTimeout(hostDebounceHandle);
  hostDebounceHandle = setTimeout(loadHostSnapshot, 90);
}

function nowServerMs() {
  return Date.now() + hostState.serverOffsetMs;
}

function startHostTimerLoop() {
  clearInterval(hostState.timerInterval);
  hostState.timerInterval = setInterval(function() {
    updateHostLiveTimer();
  }, 160);
  updateHostLiveTimer();
}

function updateHostLiveTimer() {
  const snap = hostState.snapshot;
  if (!snap || !snap.game) return;

  const g = snap.game;
  const status = (g.status || '').toUpperCase();

  if (status === 'PRECOUNTDOWN') {
    const started = new Date(g.precountdownStartedAt || snap.serverTime).getTime();
    const remaining = Math.max(0, 3 - ((nowServerMs() - started) / 1000));
    const el = document.getElementById('precountdownNumber');
    if (el) el.textContent = String(Math.max(1, Math.ceil(remaining)));

    if (remaining <= 0.05 && hostState.revealRequestedFor !== 'begin-' + g.currentRound) {
      hostState.revealRequestedFor = 'begin-' + g.currentRound;
      if (hostState.isController) advanceHostGame();
    }
    return;
  }

  if (status === 'QUESTION') {
    const limit = Number(g.questionTimerLimit || 20);
    const started = new Date(g.questionStartedAt || snap.serverTime).getTime();
    const elapsed = Math.max(0, (nowServerMs() - started) / 1000);
    const remaining = Math.max(0, limit - elapsed);
    const pct = Math.max(0, Math.min(100, (remaining / limit) * 100));
    const sec = Math.ceil(remaining);

    const timer = document.getElementById('timerNumber');
    const ring = document.getElementById('timerRing');

    if (timer) timer.textContent = String(sec);
    if (ring) ring.style.setProperty('--pct', pct + '%');

    if (remaining <= 0.05 && hostState.revealRequestedFor !== 'reveal-' + g.currentRound) {
      hostState.revealRequestedFor = 'reveal-' + g.currentRound;
      if (hostState.isController) revealHostRound('timer');
    }
  }
}

function renderHostStage() {
  const stage = document.getElementById('hostStage');
  if (!stage || !hostState.snapshot || !hostState.snapshot.game) return;

  const status = (hostState.snapshot.game.status || '').toUpperCase();

  if (status === 'LOBBY') return renderHostLobby(stage);
  if (status === 'PRECOUNTDOWN') return renderHostPrecountdown(stage);
  if (status === 'QUESTION') return renderHostQuestion(stage, false);
  if (status === 'REVEAL') return renderHostQuestion(stage, true);
  if (status === 'LEADERBOARD') return renderHostLeaderboard(stage);
  if (status === 'FINISHED') return renderHostFinished(stage);

  stage.innerHTML = `<div class="info-modal" style="display:block;"><h3>Unknown Status (${escapeHtml(hostState.snapshot.game.status)})</h3></div>`;
}

function renderHostLobby(stage) {
  const players = hostState.snapshot.players || [];
  
  // Hardcoded URL pointing to your GitHub Pages deployment
  const playUrl = `https://leviskibet.github.io/Athena-Hub/play.html?pin=${hostState.snapshot.game.gamePin}`;

  stage.innerHTML = `
    <div class="card lobby-split-grid">
      <!-- Left Half: PIN, QR Code & Clickable Link -->
      <div class="lobby-left-panel">
        <div class="pin-label">Game PIN</div>
        <div class="pin" style="font-size: 4rem; font-weight: 800; color: var(--accent-color); margin-bottom: 0.5rem;">
          ${escapeHtml(hostState.snapshot.game.gamePin)}
        </div>
        
        <div class="lobby-qr-container">
          <!-- Using the static local image for the QR code -->
          <img id="lobby-qr-img" src="Images/loginqr.png" alt="Game QR Code" style="width:180px; height:180px; display:block; border-radius:12px;" />
        </div>

        <button class="copy-url-btn" onclick="copyPlayUrl('${escapeAttr(playUrl)}')">
          <i class="fa-solid fa-copy"></i>
          <span>${escapeHtml(playUrl)}</span>
        </button>
        <div id="copy-toast-msg" class="copy-toast-msg">Copied to clipboard!</div>
      </div>

      <!-- Right Half: Joined Players & Match Controls -->
      <div class="lobby-right-panel">
        <div>
          <h3 style="font-size: 1.5rem; margin-top: 0; margin-bottom: 0.5rem;">
            Joined Players <span class="subtle">(${players.length})</span>
          </h3>
          <div class="joined-players-container">
            ${players.map(p => `
              <div class="player-chip player-chip-pop" style="display:flex; align-items:center; gap:0.6rem; background:rgba(255,255,255,0.12); border:1px solid var(--card-border); padding:0.5rem 1rem; border-radius:99px;">
                <span class="avatar" style="background:${escapeAttr(p.avatarColor || '#8b5cf6')}; width:28px; height:28px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:0.8rem; font-weight:800; color:#fff;">
                  ${escapeHtml((p.nickname || '?').slice(0,1).toUpperCase())}
                </span>
                <span style="font-weight:700; font-size:0.95rem;">${escapeHtml(p.nickname || '')}</span>
              </div>
            `).join('') || '<p class="subtle" style="margin-top:1rem;">Waiting for players to join...</p>'}
          </div>
        </div>

        <div class="actions" style="justify-content:flex-end; gap:1rem; margin-top:1.5rem; display:flex; align-items:center;">
          ${hostState.isController ? `
            <button class="btn-create-match" style="padding:0.8rem 2rem; font-size:1.1rem;" onclick="advanceHostGame()">
              <i class="fa-solid fa-play"></i> Start Game
            </button>
            <button class="btn-back" style="border-color:#ef4444; color:#ef4444;" onclick="resetHostGame()">
              Reset Room
            </button>
          ` : `
            <span class="status-badge" style="background:#f59e0b;">
              <i class="fa-solid fa-eye"></i> Spectator Mode — another session is controlling this match
            </span>
          `}
        </div>
      </div>
    </div>
  `;
}

window.copyPlayUrl = function(url) {
  if (!navigator.clipboard) {
    const textArea = document.createElement("textarea");
    textArea.value = url;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      showCopyToast();
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
    return;
  }

  navigator.clipboard.writeText(url).then(() => {
    showCopyToast();
  }).catch(err => {
    console.error('Failed to copy link: ', err);
  });
};

function showCopyToast() {
  const toast = document.getElementById('copy-toast-msg');
  if (toast) {
    toast.style.opacity = '1';
    setTimeout(() => {
      toast.style.opacity = '0';
    }, 2000);
  }
}

function renderHostPrecountdown(stage) {
  const players = hostState.snapshot.players || [];
  stage.innerHTML = `
    <section class="card" style="text-align:center; padding:3rem;">
      <span class="status-badge" style="background:#f59e0b; margin-bottom:1rem; display:inline-block;">GET READY</span>
      <h1>Question ${escapeHtml(hostState.snapshot.game.currentRound)}</h1>
      <div id="precountdownNumber" class="host-lobby-pin" style="font-size:8rem; margin:1rem 0;">3</div>
      <p class="subtle" style="font-size:1.2rem;">${players.length} players in the arena</p>
      <div class="actions" style="justify-content:center; margin-top:1.5rem; display:flex; gap:1rem; align-items:center;">
        ${hostState.isController ? `
          <button class="btn-create-match" onclick="advanceHostGame()">Start Now</button>
          <button class="btn-back" onclick="revealHostRound('host')">Skip / Reveal</button>
        ` : `
          <span class="status-badge" style="background:#f59e0b;"><i class="fa-solid fa-eye"></i> Spectator Mode</span>
        `}
      </div>
    </section>
  `;
}

function renderHostQuestion(stage, revealed) {
  const snap = hostState.snapshot;
  const q = snap.question || {};
  const stats = snap.answerStats || { A:0, B:0, C:0, D:0, total:0 };
  const active = Number(snap.activePlayerCount || 0);
  const correct = String(q.correct || '').toUpperCase();

  if (revealed) {
    clearTimeout(hostState.autoAdvanceTimer);
    hostState.autoAdvanceTimer = setTimeout(() => {
      if (hostState.snapshot && hostState.snapshot.game && (hostState.snapshot.game.status || '').toUpperCase() === 'REVEAL') {
        advanceHostGame();
      }
    }, 2500);
  }

  const answers = ['A','B','C','D'].map(function(letter) {
    const text = q['option' + letter] || q['option' + letter.toLowerCase()] || '';
    const isCorrect = letter === correct;
    const cls = revealed ? (isCorrect ? 'ans-green' : 'ans-red') : ('ans-' + (letter === 'A' ? 'red' : letter === 'B' ? 'blue' : letter === 'C' ? 'yellow' : 'green'));
    
    return `
      <div class="ans-card ${cls}" style="${revealed && !isCorrect ? 'opacity: 0.4;' : ''}">
        <div class="ans-left">
          <div class="ans-shape">${letter}</div>
          <div>${escapeHtml(text)}</div>
        </div>
      </div>
    `;
  }).join('');

  const imageUrl = q.imageUrl || q.image_url || 'Images/kahoot.jpg';

  stage.innerHTML = `
    <div style="width:100%; max-width:1000px; margin:0 auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <span class="status-badge">Round ${escapeHtml(snap.game.currentRound || '')}</span>
        <div id="timerRing" class="timer-ring" style="width:70px; height:70px; border-radius:50%; background:var(--accent-color); display:inline-flex; align-items:center; justify-content:center;">
          <span id="timerNumber" style="font-size:1.6rem; font-weight:800; color:#fff;">${Number(snap.game.questionTimerLimit || 20)}</span>
        </div>
      </div>

      <h1 class="host-question-title">${escapeHtml(q.question || 'Question')}</h1>

      <div class="host-question-media">
        <img src="${escapeAttr(imageUrl)}" alt="Question Media" />
      </div>

      <div class="answers-grid" style="margin-top:1.5rem;">${answers}</div>

      <div style="text-align:center; margin-top:1.2rem;">
        ${revealed ? `
          <div class="auto-reveal-banner">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem;"></i>
          </div>
        ` : `
          <p style="font-size:1.2rem; font-weight:800; opacity:0.85;">${Number(stats.total || 0)} / ${active} answered</p>
          ${hostState.isController ? `
            <button class="btn-back" style="color:#ef4444; border-color:#ef4444; margin-top:0.5rem;" onclick="revealHostRound('host')">Skip / Reveal</button>
          ` : `
            <span class="status-badge" style="background:#f59e0b; margin-top:0.5rem; display:inline-block;"><i class="fa-solid fa-eye"></i> Spectator Mode</span>
          `}
        `}
      </div>
    </div>
  `;
}

function renderHostLeaderboard(stage) {
  const rows = hostState.snapshot.leaderboard || [];

  // Warm the podium track's cache now, since LEADERBOARD usually precedes FINISHED,
  // so playback can start with minimal buffering delay once the match ends.
  try {
    if (!hostState.podiumPreload) {
      hostState.podiumPreload = new Audio();
      hostState.podiumPreload.preload = 'auto';
      hostState.podiumPreload.src = 'Music/Kahoot Podium animation.mp3';
      hostState.podiumPreload.load();
    }
  } catch (err) {}
  
  // 1. Capture current positions for the FLIP animation
  const oldPositions = {};
  const existingRows = stage.querySelectorAll('.lb-row');
  existingRows.forEach(row => {
    oldPositions[row.dataset.nick] = row.getBoundingClientRect().top;
  });

  // 2. Render new HTML with Streak Badges
  stage.innerHTML = `
    <section class="card" style="max-width:700px; margin:0 auto; padding:2rem;">
      <h1 style="text-align:center; font-size:2.5rem; margin-bottom:1.5rem;">Leaderboard</h1>
      <div id="lb-container" style="display:flex; flex-direction:column; gap:0.8rem; position:relative;">
        
        ${rows.map((p, i) => {
          const nick = escapeHtml(p.nickname || '');
          const streakCount = (hostState.streaks && hostState.streaks[p.nickname]) ? hostState.streaks[p.nickname] : 0;
          
          // Only show fire if they have a streak of 2 or more
          const streakHtml = streakCount >= 2 
            ? `<div style="display:inline-flex; align-items:center; color:#ff8a00; background:rgba(255, 138, 0, 0.15); border: 1px solid rgba(255,138,0,0.3); padding:0.2rem 0.6rem; border-radius:12px; font-size:0.95rem; font-weight:800; margin-right:1rem;">
                 <i class="fa-solid fa-fire" style="margin-right:0.3rem;"></i> ${streakCount}
               </div>` 
            : '';

          return `
          <div class="lb-row" data-nick="${nick}" style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:0.8rem 1.2rem; border-radius:16px;">
            <div style="display:flex; align-items:center; gap:1rem;">
              <strong style="font-size:1.2rem; color:var(--accent-color);">#${p.rank || i + 1}</strong>
              <span style="font-size:1.1rem; font-weight:700;">${nick}</span>
            </div>
            <div style="display:flex; align-items:center;">
              ${streakHtml}
              <strong style="font-size:1.2rem;">${Number(p.totalScore || 0).toLocaleString()} pts</strong>
            </div>
          </div>
        `}).join('') || '<p class="subtle" style="text-align:center;">No scores yet.</p>'}
        
      </div>
      <div class="actions" style="justify-content:center; margin-top:2rem;">
        ${hostState.isController ? `
          <button class="btn-create-match" onclick="advanceHostGame()">Next Question</button>
        ` : `
          <span class="status-badge" style="background:#f59e0b;"><i class="fa-solid fa-eye"></i> Spectator Mode</span>
        `}
      </div>
    </section>
  `;

  // 3. Apply the FLIP transition logic to the newly rendered rows
  requestAnimationFrame(() => {
    const newRows = stage.querySelectorAll('.lb-row');
    newRows.forEach(row => {
      const nick = row.dataset.nick;
      
      if (oldPositions[nick] !== undefined) {
        const newTop = row.getBoundingClientRect().top;
        const delta = oldPositions[nick] - newTop;
        
        if (delta !== 0) {
          // Invert: instantly move the row back to its old position
          row.style.transform = `translateY(${delta}px)`;
          row.style.transition = 'none';

          // Play: animate it smoothly to its actual new position
          requestAnimationFrame(() => {
            row.style.transform = 'translateY(0)';
            row.style.transition = 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
          });
        }
      } else {
        // If a new player joins mid-game, pop them in smoothly
        row.style.opacity = '0';
        row.style.transform = 'translateY(20px)';
        requestAnimationFrame(() => {
          row.style.opacity = '1';
          row.style.transform = 'translateY(0)';
          row.style.transition = 'all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
        });
      }
    });
  });
}

function renderHostFinished(stage) {
  const rows = hostState.snapshot.leaderboard || [];
  
  const winner = rows[0] || null;
  const second = rows[1] || null;
  const third = rows[2] || null;
  const runnerUps = rows.slice(3, 5);

  if (!hostState.finishedRendered) {
    hostState.finishedRendered = true;

    stage.innerHTML = `
      <!-- Spotlight Overlay -->
      <div id="spotlight-overlay" class="spotlight-overlay">
        <div class="spotlight-beam"></div>
      </div>

      <div class="podium-stage-wrapper">
        <h1 class="host-question-title" style="font-size: 3rem;">Final Podium</h1>

        <div class="podium-box">
          
          <!-- 2ND PLACE -->
          <div class="podium-col podium-col-2nd" id="podium-col-2nd">
            <div class="podium-player-card">
              <div class="podium-player-name">${second ? escapeHtml(second.nickname) : '—'}</div>
              <div class="podium-player-score">${second ? Number(second.totalScore || 0).toLocaleString() + ' pts' : ''}</div>
            </div>
            <div class="podium-pedestal-block">
              <span class="podium-num">2</span>
            </div>
          </div>

          <!-- 1ST PLACE -->
          <div class="podium-col podium-col-1st" id="podium-col-1st">
            <div class="podium-player-card">
              <div class="podium-crown-icon"><i class="fa-solid fa-crown"></i></div>
              <div class="podium-player-name" style="font-size: 1.6rem; color: #f59e0b;">${winner ? escapeHtml(winner.nickname) : '—'}</div>
              <div class="podium-player-score">${winner ? Number(winner.totalScore || 0).toLocaleString() + ' pts' : ''}</div>
            </div>
            <div class="podium-pedestal-block">
              <span class="podium-num">1</span>
            </div>
          </div>

          <!-- 3RD PLACE -->
          <div class="podium-col podium-col-3rd" id="podium-col-3rd">
            <div class="podium-player-card">
              <div class="podium-player-name">${third ? escapeHtml(third.nickname) : '—'}</div>
              <div class="podium-player-score">${third ? Number(third.totalScore || 0).toLocaleString() + ' pts' : ''}</div>
            </div>
            <div class="podium-pedestal-block">
              <span class="podium-num">3</span>
            </div>
          </div>

        </div>

        <!-- RUNNER UPS (4th & 5th Place) -->
        <div class="runner-ups-bar" id="runner-ups-bar">
          ${runnerUps.map(p => `
            <div class="runner-up-item">
              <strong style="color: var(--accent-color);">#${p.rank}</strong>
              <span style="font-weight: 700;">${escapeHtml(p.nickname)}</span>
              <span style="opacity: 0.8;">${Number(p.totalScore || 0).toLocaleString()} pts</span>
            </div>
          `).join('')}
        </div>

        <!-- RESET / EXIT ACTION -->
        <div class="actions" style="justify-content: center; margin-top: 2.5rem; position: relative; z-index: 101;">
          ${hostState.isController ? `
            <button class="btn-back" style="border-color: #ef4444; color: #ef4444;" onclick="resetHostGame()">
              <i class="fa-solid fa-rotate-left"></i> Reset Match
            </button>
          ` : `
            <span class="status-badge" style="background:#f59e0b;"><i class="fa-solid fa-eye"></i> Spectator Mode</span>
          `}
        </div>
      </div>
    `;

    // Align the podium reveal sequence to when the finale music actually becomes
    // audible, rather than to the moment this render happened. Without this, the
    // browser's audio buffering delay makes the winner reveal fire before the
    // fanfare in the track catches up (heard as the sound trailing the visual).
    const podiumAudio = hostState.audio ? hostState.audio.currentAudio : null;
    if (podiumAudio && !hostState.muted) {
      podiumAudio.addEventListener('playing', scheduleFinishedReveal, { once: true });
      // Safety net in case 'playing' never fires (e.g. autoplay blocked).
      setTimeout(scheduleFinishedReveal, 1500);
    } else {
      scheduleFinishedReveal();
    }
  }
}

function scheduleFinishedReveal() {
  if (hostState.finishedRevealScheduled) return;
  hostState.finishedRevealScheduled = true;

  // 1. Reveal 3rd Place at 5.0s
  setTimeout(() => {
    const col3 = document.getElementById('podium-col-3rd');
    if (col3) col3.classList.add('revealed');
  }, 5000);

  // 2. Reveal 2nd Place at 8.5s
  setTimeout(() => {
    const col2 = document.getElementById('podium-col-2nd');
    if (col2) col2.classList.add('revealed');
  }, 8500);

  // 3. Dim lights and start searching spotlight shortly after, leading into the climax
  setTimeout(() => {
    const spotlight = document.getElementById('spotlight-overlay');
    if (spotlight) spotlight.classList.add('active', 'searching');
  }, 8800);

  // 4. Reveal 1st Place, Snap Spotlight, and Confetti at 14.5 seconds
  setTimeout(() => {
    const col1 = document.getElementById('podium-col-1st');
    const runnerBar = document.getElementById('runner-ups-bar');
    const spotlight = document.getElementById('spotlight-overlay');

    if (col1) col1.classList.add('revealed');
    if (runnerBar) runnerBar.classList.add('revealed');

      if (spotlight) {
        spotlight.classList.remove('searching');
        // Force the browser to commit the searching animation's end state
        // before switching to the transition-driven highlight-winner state;
        // changing both classes in the same tick can make the size jump
        // straight to 450px instead of easing into it.
        void spotlight.offsetWidth;
        requestAnimationFrame(() => {
          spotlight.classList.add('highlight-winner');
        });
      }

    if (!hostState.confettiFired && window.confetti) {
      hostState.confettiFired = true;
      confetti({ particleCount: 160, spread: 85, origin: { y: 0.6 }, zIndex: 1000 });
      setTimeout(() => confetti({ particleCount: 100, spread: 100, origin: { x: 0.2, y: 0.6 }, zIndex: 1000 }), 400);
      setTimeout(() => confetti({ particleCount: 100, spread: 100, origin: { x: 0.8, y: 0.6 }, zIndex: 1000 }), 800);
    }

    setTimeout(() => {
      if (spotlight) spotlight.classList.remove('active');
    }, 2000);
  }, 14500);
}

async function advanceHostGame() {
  if (!hostState.isController || isTransitioning) return;
  isTransitioning = true;
  try {
    clearTimeout(hostState.autoAdvanceTimer);
    hostState.finishedRendered = false;
    hostState.finishedRevealScheduled = false;
    const snap = await hostRpc('qa_advance_game', {
      p_game_pin: hostState.gamePin,
      p_host_token: hostState.hostToken
    });
    setHostSnapshot(snap);
  } catch (err) {
    showHostError(err.message || err);
  } finally {
    setTimeout(() => isTransitioning = false, 500); // 500ms debounce
  }
}

async function revealHostRound(reason) {
  if (!hostState.isController || isTransitioning) return;
  isTransitioning = true;
  try {
    hostState.finishedRendered = false;
    hostState.finishedRevealScheduled = false;
    const snap = await hostRpc('qa_reveal_round', {
      p_game_pin: hostState.gamePin,
      p_host_token: hostState.hostToken,
      p_reason: reason || 'host'
    });
    setHostSnapshot(snap);
  } catch (err) {
    showHostError(err.message || err);
  } finally {
    setTimeout(() => isTransitioning = false, 500);
  }
}

async function resetHostGame() {
  if (!hostState.isController || isTransitioning) return;
  if (!confirm('Reset the room and remove players/scores?')) return;

  isTransitioning = true;
  clearTimeout(hostState.autoAdvanceTimer);
  hostState.confettiFired = false;
  hostState.finishedRendered = false;
  hostState.finishedRevealScheduled = false;
  hostState.revealRequestedFor = '';
  
  try {
    const snap = await hostRpc('qa_reset_game', {
      p_game_pin: hostState.gamePin,
      p_host_token: hostState.hostToken,
      p_keep_players: false
    });
    setHostSnapshot(snap);
  } catch (err) {
    showHostError(err.message || err);
  } finally {
    setTimeout(() => isTransitioning = false, 500);
  }
}

function handleAudioTransitions(prev, next) {
  if (!hostState.audio || hostState.muted) return;
  const prevStatus = (prev && prev.game ? prev.game.status : '').toUpperCase();
  const status = (next.game.status || '').toUpperCase();

  if (status === prevStatus) return;

  if (status === 'LOBBY') {
    hostState.audio.playMusic('Music/Kahoot Lobby Music.mp3', true);
  } else if (status === 'PRECOUNTDOWN') {
    hostState.audio.playMusic('Music/321-countdown.mp3', false);
    if (hostState.audio.currentAudio) {
      hostState.audio.currentAudio.volume = 0.25; 
    }
  } else if (status === 'QUESTION') {
    const q = next.question || {};
    const timerLimit = Number(q.timeLimit || next.game.questionTimerLimit || 20);
    const questionMusic = timerLimit <= 20 
      ? 'Music/Kahoot In Game Music (20 Second Countdown) 3_3.mp3'
      : 'Music/Kahoot Music (30 Second Countdown) 2_3.mp3';
    
    hostState.audio.playMusic(questionMusic, false);
  } else if (status === 'REVEAL') {
    hostState.audio.stopMusic();
    hostState.audio.playSfx('Music/Kahoot Gong Sound Effect.mp3');
  } else if (status === 'LEADERBOARD') {
    hostState.audio.playMusic('Music/leaderboard-theme.mp3', false);
  } else if (status === 'FINISHED') {
    hostState.audio.stopMusic();
    hostState.audio.playMusic('Music/Kahoot Podium animation.mp3', false);
    if (hostState.audio.currentAudio) {
      hostState.audio.currentAudio.volume = 1.0; 
    }
  }
}

function showHostError(msg) {
  const el = document.getElementById('hostError');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

// ===================================================
// 5. INITIALIZATION & UTILITIES
// ===================================================
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

function applyTheme(isLight) {
  const body = document.body;
  const icons = document.querySelectorAll('.theme-icon');

  if (isLight) {
    body.classList.add('light-mode');
    body.classList.remove('dark-mode');
    icons.forEach(i => i.className = 'fa-solid fa-sun theme-icon');
  } else {
    body.classList.remove('light-mode');
    body.classList.add('dark-mode');
    icons.forEach(i => i.className = 'fa-solid fa-moon theme-icon');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAuth();

  document.addEventListener('click', () => {
    if (hostState.audio && !hostState.audio.unlocked) {
      hostState.audio.unlock();
    }
  }, { once: true });

  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      hostState.muted = !hostState.muted;
      if (hostState.audio) hostState.audio.setMuted(hostState.muted);
      muteBtn.innerHTML = `<i class="fa-solid ${hostState.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i> ${hostState.muted ? 'Muted' : 'Audio'}`;
    });
  }

  const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)');
  applyTheme(systemPrefersLight.matches);
  systemPrefersLight.addEventListener('change', (e) => applyTheme(e.matches));

  document.querySelectorAll('.theme-btn-global').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(!document.body.classList.contains('light-mode')));
  });

  const dateElement = document.getElementById('live-date');
  if (dateElement) {
    const now = new Date();
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    dateElement.textContent = now.toLocaleDateString('en-US', options);
  }
});