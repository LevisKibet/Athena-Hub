const SUPABASE_URL = 'https://wauinjxrmknqtbohfkrd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhdWluanhybWtucXRib2hma3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjc3MjIsImV4cCI6MjA5OTYwMzcyMn0.oJLojkkqZbpYXEEJ1WGhpH2ICWLaJVjYyupCUgbpG3s';

let supabase = null;

try {
  if (SUPABASE_URL && !SUPABASE_URL.includes('YOUR_SUPABASE')) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.warn('Athena Hub: Supabase credentials are using placeholder values.');
  }
} catch (err) {
  console.error('Athena Hub: Invalid Supabase configuration:', err.message);
}

function getOrCreateUserKey() {
  try {
    let key = localStorage.getItem('athena_user_key');
    if (key) return key;

    const bytes = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    key = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    try {
      localStorage.setItem('athena_user_key', key);
    } catch (storageErr) {
      console.warn('Athena Hub: localStorage unavailable.');
    }

    return key;
  } catch (err) {
    return 'temp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

const USER_KEY = getOrCreateUserKey();

let currentMatch = null;
let currentConfigs = {};
let currentQuestions = [];
let activeQuestionIndex = 0;
let isOwner = false;
let hostMatchState = null;

const INDEX_TO_CHOICE = ['A', 'B', 'C', 'D'];
const CHOICE_TO_INDEX = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

window.showKahootView = function(view) {
  const kahootView = document.getElementById('kahoot-view');
  const editorView = document.getElementById('editor-view');
  const hostView = document.getElementById('host-view');
  const hubStatusText = document.getElementById('hub-status-text');

  const navMatches = document.getElementById('nav-matches');
  const navEditor = document.getElementById('nav-editor');

  if (!kahootView || !editorView || !hostView) return;

  kahootView.style.display = 'none';
  editorView.style.display = 'none';
  hostView.style.display = 'none';

  if (navMatches) navMatches.classList.remove('active');
  if (navEditor) navEditor.classList.remove('active');

  if (view === 'editor') {
    editorView.style.display = 'block';
    if (navEditor) navEditor.classList.add('active');
    if (hubStatusText) hubStatusText.textContent = 'Game Editor Active';
  } else if (view === 'host') {
    hostView.style.display = 'block';
    if (navMatches) navMatches.classList.add('active');
    if (hubStatusText) hubStatusText.textContent = 'Hosting Match';
  } else {
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

function generateGamePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function fetchMatchesFromDb() {
  const container = document.getElementById('matches-container');
  if (!container) return;

  if (!supabase) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 2rem;">
        <p style="color: #ff5e36; font-weight: 700; margin-bottom: 0.5rem;">Supabase Connection Required</p>
        <p style="opacity: 0.7; font-size: 0.9rem;">Update <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> at the top of <code>app.js</code>.</p>
      </div>`;
    return;
  }

  container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; opacity: 0.7;">Loading matches...</p>`;

  try {
    const { data: games, error: gError } = await supabase
      .from('games')
      .select('*')
      .order('created_at', { ascending: false });

    if (gError) throw gError;

    if (!games || games.length === 0) {
      container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; opacity: 0.7;">No matches found. Click "Create Match" to start!</p>`;
      return;
    }

    const gameIds = games.map(g => g.id);
    const { data: configs } = await supabase
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
      const isCreator = game.host_token === USER_KEY;
      const gameConfig = configMap[game.id] || {};
      const title = gameConfig.title || `Match PIN: ${game.game_pin}`;
      const teamTag = gameConfig.team_tag || 'TECH TEAM';

      const cardHtml = `
        <div class="match-card">
          <div class="match-thumb" style="background-image: linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.65)), url('images/kahoot.jpg');">
            <span class="thumb-tag" style="background: ${isCreator ? '#10b981' : '#e63946'};">
              ${isCreator ? 'YOUR MATCH' : teamTag}
            </span>
          </div>
          <div class="match-title-row">
            <div class="match-title">${escapeHtml(title)}</div>
            <i class="fa-solid fa-ellipsis-vertical" style="color: var(--text-muted);"></i>
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
              <i class="fa-solid fa-tower-broadcast"></i> Host
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

window.createNewMatchInDb = async function() {
  if (!supabase) {
    alert('Please configure your Supabase URL and Anon Key in app.js first.');
    return;
  }

  const pin = generateGamePin();

  try {
    const { data: newGame, error: gError } = await supabase
      .from('games')
      .insert([{
        game_pin: pin,
        host_token: USER_KEY,
        status: 'LOBBY',
        default_timer: 20,
        question_timer_limit: 20
      }])
      .select()
      .single();

    if (gError) throw gError;

    await supabase.from('config').insert([
      { game_id: newGame.id, key: 'title', value: 'New Kahoot Match' },
      { game_id: newGame.id, key: 'team_tag', value: 'TECH TEAM' }
    ]);

    await supabase.from('questions').insert([{
      game_id: newGame.id,
      sort_order: 1,
      round: '1',
      question: 'What is the capital of France?',
      option_a: 'Berlin',
      option_b: 'London',
      option_c: 'Paris',
      option_d: 'Madrid',
      correct: 'C',
      image_url: 'images/kahoot.jpg',
      time_limit: 20
    }]);

    window.openMatchEditor(newGame.id);
  } catch (err) {
    alert('Error creating game: ' + err.message);
  }
};

window.openMatchEditor = async function(gameId) {
  if (!supabase) return;

  try {
    const { data: game, error: gError } = await supabase
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gError || !game) {
      alert('Match not found.');
      return;
    }

    const { data: configs } = await supabase
      .from('config')
      .select('*')
      .eq('game_id', gameId);

    currentConfigs = {};
    if (configs) {
      configs.forEach(c => { currentConfigs[c.key] = c; });
    }

    const { data: questions } = await supabase
      .from('questions')
      .select('*')
      .eq('game_id', gameId)
      .order('sort_order', { ascending: true });

    currentMatch = game;
    currentQuestions = questions || [];
    activeQuestionIndex = 0;

    isOwner = (game.host_token === USER_KEY);

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

window.hostMatch = async function(gameId) {
  if (!supabase) {
    alert('Please configure your Supabase URL and Anon Key in app.js first.');
    return;
  }

  try {
    const { data: game, error: gError } = await supabase
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gError || !game) {
      alert('Match not found.');
      return;
    }

    const { data: configs } = await supabase
      .from('config')
      .select('*')
      .eq('game_id', gameId);

    const configMap = {};
    if (configs) {
      configs.forEach(c => { configMap[c.key] = c; });
    }

    const { count: questionCount } = await supabase
      .from('questions')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', gameId);

    hostMatchState = { game, configs: configMap };

    const titleVal = configMap.title ? configMap.title.value : `Match PIN: ${game.game_pin}`;

    const pinDisplay = document.getElementById('host-pin-display');
    const titleDisplay = document.getElementById('host-match-title');
    const statusDisplay = document.getElementById('host-match-status');
    const countDisplay = document.getElementById('host-question-count');

    if (pinDisplay) pinDisplay.textContent = game.game_pin;
    if (titleDisplay) titleDisplay.textContent = titleVal;
    if (statusDisplay) statusDisplay.textContent = `Status: ${game.status || 'LOBBY'}`;
    if (countDisplay) countDisplay.textContent = `${questionCount || 0} question${questionCount === 1 ? '' : 's'}`;

    updateStartButton(game.status);
    window.showKahootView('host');
  } catch (err) {
    alert('Error loading host lobby: ' + err.message);
  }
};

function updateStartButton(status) {
  const btn = document.getElementById('btn-start-match');
  if (!btn) return;

  if (status === 'ACTIVE') {
    btn.innerHTML = '<i class="fa-solid fa-stop"></i> End Match';
    btn.classList.add('is-active');
  } else {
    btn.innerHTML = '<i class="fa-solid fa-play"></i> Start Match';
    btn.classList.remove('is-active');
  }
}

window.toggleMatchStatus = async function() {
  if (!hostMatchState || !hostMatchState.game || !supabase) return;

  const nextStatus = hostMatchState.game.status === 'ACTIVE' ? 'ENDED' : 'ACTIVE';

  try {
    const { error } = await supabase
      .from('games')
      .update({ status: nextStatus })
      .eq('id', hostMatchState.game.id);

    if (error) throw error;

    hostMatchState.game.status = nextStatus;
    const statusDisplay = document.getElementById('host-match-status');
    if (statusDisplay) statusDisplay.textContent = `Status: ${nextStatus}`;
    updateStartButton(nextStatus);
  } catch (err) {
    alert('Error updating match status: ' + err.message);
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
        <div class="q-thumb-img-placeholder" style="background-image: url('${q.image_url || 'images/kahoot.jpg'}');"></div>
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

  const { error } = await supabase
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
    image_url: 'images/kahoot.jpg',
    time_limit: 20
  };

  const { data, error } = await supabase
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

window.updateMatchTitle = async function(newTitle) {
  if (!isOwner || !currentMatch || !supabase) return;

  if (currentConfigs.title) {
    await supabase
      .from('config')
      .update({ value: newTitle, updated_at: new Date().toISOString() })
      .eq('id', currentConfigs.title.id);
  } else {
    const { data } = await supabase
      .from('config')
      .insert([{ game_id: currentMatch.id, key: 'title', value: newTitle }])
      .select()
      .single();
    if (data) currentConfigs.title = data;
  }
};

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

function applyTheme(isLight) {
  const themeIcon = document.getElementById('theme-icon');
  const body = document.body;

  if (isLight) {
    body.classList.add('light-mode');
    body.classList.remove('dark-mode');
    if (themeIcon) themeIcon.className = 'fa-solid fa-sun';
  } else {
    body.classList.remove('light-mode');
    body.classList.add('dark-mode');
    if (themeIcon) themeIcon.className = 'fa-solid fa-moon';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const userKeyDisplay = document.getElementById('user-key-display');
  if (userKeyDisplay) {
    userKeyDisplay.textContent = USER_KEY.substring(0, 16) + '...';
  }

  const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)');
  applyTheme(systemPrefersLight.matches);

  systemPrefersLight.addEventListener('change', (e) => applyTheme(e.matches));

  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => applyTheme(!document.body.classList.contains('light-mode')));
  }

  const dateElement = document.getElementById('live-date');
  if (dateElement) {
    const now = new Date();
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    dateElement.textContent = now.toLocaleDateString('en-US', options);
  }

  if (document.getElementById('kahoot-view')) {
    fetchMatchesFromDb();
  }
});