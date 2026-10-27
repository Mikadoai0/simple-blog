// ---------- state ----------
let token = localStorage.getItem('token');
let currentUser = null;
let editingId = null;
let registerMode = false;

// ---------- element shortcuts ----------
const $ = (id) => document.getElementById(id);
const authArea = $('auth-area');
const authSection = $('auth-section');
const editorSection = $('editor-section');
const postsEl = $('posts');
const messageEl = $('message');

// ---------- API helper (sends the token automatically) ----------
async function api(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- small UI helpers ----------
function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.className = 'message' + (isError ? ' error' : '');
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => messageEl.classList.add('hidden'), 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

// ---------- auth UI ----------
function renderAuthArea() {
  if (currentUser) {
    authArea.innerHTML = `<span>Hi, ${escapeHtml(currentUser.username)}</span>
      <button class="link" id="logout-btn">Log out</button>`;
    $('logout-btn').onclick = logout;
  } else {
    authArea.innerHTML = `<button class="link" id="login-btn">Log in</button>`;
    $('login-btn').onclick = () => openAuth(false);
  }
  editorSection.classList.toggle('hidden', !currentUser);
}

function openAuth(register) {
  registerMode = register;
  $('auth-title').textContent = register ? 'Register' : 'Log in';
  $('auth-submit').textContent = register ? 'Create account' : 'Log in';
  $('auth-toggle').textContent = register ? 'Have an account? Log in' : 'Need an account? Register';
  authSection.classList.remove('hidden');
}

$('auth-toggle').onclick = () => openAuth(!registerMode);
$('auth-cancel').onclick = () => authSection.classList.add('hidden');

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const result = await api(registerMode ? '/register' : '/login', 'POST', {
      username: $('auth-username').value.trim(),
      password: $('auth-password').value,
    });
    token = result.token;
    localStorage.setItem('token', token);
    currentUser = result.user;
    $('auth-form').reset();
    authSection.classList.add('hidden');
    renderAuthArea();
    loadPosts();
    showMessage(registerMode ? 'Account created, you are logged in.' : 'Welcome back!');
  } catch (err) {
    showMessage(err.message, true);
  }
};

async function logout() {
  try { await api('/logout', 'POST'); } catch {}
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  resetEditor();
  renderAuthArea();
  loadPosts();
  showMessage('Logged out.');
}

// ---------- posts: GET ----------
async function loadPosts() {
  try {
    const search = $('search').value.trim();
    const posts = await api('/posts' + (search ? '?search=' + encodeURIComponent(search) : ''));
    renderPosts(posts);
  } catch (err) {
    showMessage(err.message, true);
  }
}

function renderPosts(posts) {
  if (!posts.length) {
    postsEl.innerHTML = '<p class="empty">No posts yet.</p>';
    return;
  }
  postsEl.innerHTML = posts
    .map((p) => {
      const mine = currentUser && currentUser.id === p.authorId;
      const edited = p.updatedAt !== p.createdAt ? ' (edited)' : '';
      return `
      <article class="card post" data-id="${p.id}">
        <h3>${escapeHtml(p.title)}</h3>
        <div class="meta">by ${escapeHtml(p.author)} · ${formatDate(p.createdAt)}${edited}</div>
        <div class="body">${escapeHtml(p.content)}</div>
        ${mine ? `<div class="actions">
          <button class="secondary" data-action="edit">Edit</button>
          <button class="danger" data-action="delete">Delete</button>
        </div>` : ''}
      </article>`;
    })
    .join('');

  postsEl.querySelectorAll('article').forEach((card, i) => {
    const post = posts[i];
    const edit = card.querySelector('[data-action="edit"]');
    const del = card.querySelector('[data-action="delete"]');
    if (edit) edit.onclick = () => startEdit(post);
    if (del) del.onclick = () => deletePost(post.id);
  });
}

// ---------- posts: POST (create) and PATCH (update) ----------
$('post-form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    title: $('post-title').value,
    content: $('post-content').value,
  };
  try {
    if (editingId) {
      await api('/posts/' + editingId, 'PATCH', payload); // update
      showMessage('Post updated.');
    } else {
      await api('/posts', 'POST', payload); // create
      showMessage('Post published.');
    }
    resetEditor();
    loadPosts();
  } catch (err) {
    showMessage(err.message, true);
  }
};

function startEdit(post) {
  editingId = post.id;
  $('editor-title').textContent = 'Edit post';
  $('post-submit').textContent = 'Save changes';
  $('post-cancel').classList.remove('hidden');
  $('post-title').value = post.title;
  $('post-content').value = post.content;
  editorSection.scrollIntoView({ behavior: 'smooth' });
}

function resetEditor() {
  editingId = null;
  $('post-form').reset();
  $('editor-title').textContent = 'New post';
  $('post-submit').textContent = 'Publish';
  $('post-cancel').classList.add('hidden');
}
$('post-cancel').onclick = resetEditor;

// ---------- posts: DELETE ----------
async function deletePost(id) {
  if (!confirm('Delete this post?')) return;
  try {
    await api('/posts/' + id, 'DELETE');
    if (editingId === id) resetEditor();
    showMessage('Post deleted.');
    loadPosts();
  } catch (err) {
    showMessage(err.message, true);
  }
}

// ---------- search ----------
let searchTimer;
$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadPosts, 250);
};

// ---------- start ----------
async function init() {
  const params = new URLSearchParams(location.search);
  const googleCode = params.get('google_code');
  const googleError = params.get('google_error');
  if (googleCode || googleError) history.replaceState(null, '', location.pathname + location.hash);

  if (googleCode) {
    try {
      const result = await api('/auth/google/exchange', 'POST', { code: googleCode });
      token = result.token;
      localStorage.setItem('token', token);
    } catch (err) {
      showMessage(err.message, true);
    }
  } else if (googleError) {
    showMessage('Google sign-in did not complete. Please try again.', true);
  }

  if (token) {
    try {
      currentUser = await api('/me'); // checks the saved token is still valid
    } catch {
      token = null;
      localStorage.removeItem('token');
    }
  }
  renderAuthArea();
  loadPosts();
}
init();
