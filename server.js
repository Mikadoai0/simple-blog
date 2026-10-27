// Blog API + static file server, backed by PostgreSQL.
// Run:  node server.js  ->  http://localhost:3000

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const googleLoginCodes = new Map();

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function logEvent(event, details = {}) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject({ status: 413, message: 'Payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject({ status: 400, message: 'Invalid JSON body' });
      }
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// Tokens are random; only their SHA-256 hash is stored in the database.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function getGoogleOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL ||
    (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${PORT}/api/auth/google/callback`);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !callbackUrl)
    throw { status: 503, message: 'Google sign-in is not configured' };
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, callbackUrl);
}

function redirectGoogleResult(res, query, clearState = true) {
  const cookie = clearState
    ? 'google_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : '')
    : null;
  res.writeHead(302, {
    Location: '/' + (query ? '?' + query : ''),
    'Cache-Control': 'no-store',
    ...(cookie ? { 'Set-Cookie': cookie } : {}),
  });
  res.end();
}

async function findOrCreateGoogleUser(profile) {
  const existing = await db.query('SELECT id, username FROM users WHERE google_sub = $1', [profile.sub]);
  if (existing.rows[0]) return existing.rows[0];

  let baseUsername = profile.email.split('@')[0]
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  if (baseUsername.length < 3) baseUsername = 'google_' + crypto.randomBytes(3).toString('hex');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = attempt === 0 ? '' : '_' + crypto.randomBytes(3).toString('hex');
    const username = baseUsername.slice(0, 20 - suffix.length) + suffix;
    const inserted = await db.query(
      'INSERT INTO users (username, google_sub) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, username',
      [username, profile.sub]
    );
    if (inserted.rows[0]) {
      logEvent('auth.registered', {
        method: 'google',
        userId: inserted.rows[0].id,
        username: inserted.rows[0].username,
      });
      return inserted.rows[0];
    }

    const raced = await db.query('SELECT id, username FROM users WHERE google_sub = $1', [profile.sub]);
    if (raced.rows[0]) return raced.rows[0];
  }
  throw { status: 500, message: 'Could not create a Google account' };
}

async function handleGoogleCallback(req, res, url) {
  const state = url.searchParams.get('state');
  const savedState = getCookie(req, 'google_oauth_state');
  if (url.searchParams.has('error')) return redirectGoogleResult(res, 'google_error=cancelled');
  if (!state || !savedState || state !== savedState || !url.searchParams.get('code'))
    return redirectGoogleResult(res, 'google_error=invalid_state');

  try {
    const client = getGoogleOAuthClient();
    const { tokens } = await client.getToken(url.searchParams.get('code'));
    if (!tokens.id_token) throw new Error('Google did not return an ID token');
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const profile = ticket.getPayload();
    if (!profile || !profile.sub || !profile.email || profile.email_verified !== true)
      throw new Error('Google account has no verified email');

    const user = await findOrCreateGoogleUser(profile);
    const token = await createSession(user.id);
    logEvent('auth.login.succeeded', { method: 'google', userId: user.id, username: user.username });
    const code = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [savedCode, value] of googleLoginCodes) {
      if (value.expiresAt <= now) googleLoginCodes.delete(savedCode);
    }
    googleLoginCodes.set(code, { token, user, expiresAt: now + 60_000 });
    redirectGoogleResult(res, 'google_code=' + encodeURIComponent(code));
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    redirectGoogleResult(res, 'google_error=failed');
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [hashToken(token), userId]);
  return token;
}

async function getUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function requireUser(req) {
  const user = await getUser(req);
  if (!user) throw { status: 401, message: 'You need to log in first' };
  return user;
}

// Every post query returns the same shape the front end expects.
const POST_SELECT = `
  SELECT p.id, p.title, p.content,
         u.username AS author, p.author_id AS "authorId",
         p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM posts p JOIN users u ON u.id = p.author_id`;

async function findPost(id) {
  if (!UUID_RE.test(id)) return null; // a bad ID like "abc" just means "not found"
  const { rows } = await db.query(POST_SELECT + ' WHERE p.id = $1', [id]);
  return rows[0] || null;
}

function validatePost({ title, content }, partial = false) {
  if (!partial || title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw { status: 400, message: 'Title is required' };
    if (title.length > 150) throw { status: 400, message: 'Title is too long (max 150)' };
  }
  if (!partial || content !== undefined) {
    if (typeof content !== 'string' || !content.trim()) throw { status: 400, message: 'Content is required' };
    if (content.length > 20000) throw { status: 400, message: 'Content is too long' };
  }
}

// ---------- API routes ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'posts', '<id>']
  const method = req.method;
  const resource = parts[1];
  const id = parts[2];

  if (resource === 'auth' && id === 'google' && method === 'GET' && !parts[3]) {
    const client = getGoogleOAuthClient();
    const state = crypto.randomBytes(32).toString('hex');
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.writeHead(302, {
      Location: client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
      }),
      'Set-Cookie': `google_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=600${secure}`,
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  if (resource === 'auth' && id === 'google' && parts[3] === 'callback' && method === 'GET')
    return handleGoogleCallback(req, res, url);

  if (resource === 'auth' && id === 'google' && parts[3] === 'exchange' && method === 'POST') {
    const { code } = await readBody(req);
    const login = typeof code === 'string' ? googleLoginCodes.get(code) : null;
    if (!login || login.expiresAt <= Date.now()) {
      if (typeof code === 'string') googleLoginCodes.delete(code);
      throw { status: 401, message: 'Google sign-in expired. Please try again.' };
    }
    googleLoginCodes.delete(code);
    return send(res, 200, { token: login.token, user: login.user });
  }

  // --- auth ---
  if (resource === 'register' && method === 'POST') {
    const { username, password } = await readBody(req);
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username))
      throw { status: 400, message: 'Username must be 3-20 letters, numbers or underscores' };
    if (typeof password !== 'string' || password.length < 6)
      throw { status: 400, message: 'Password must be at least 6 characters' };

    const { salt, hash } = hashPassword(password);
    let user;
    try {
      const result = await db.query(
        'INSERT INTO users (username, password_salt, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
        [username, salt, hash]
      );
      user = result.rows[0];
    } catch (err) {
      if (err.code === '23505') throw { status: 409, message: 'That username is already taken' };
      throw err;
    }
    const token = await createSession(user.id);
    logEvent('auth.registered', { method: 'password', userId: user.id, username: user.username });
    return send(res, 201, { token, user });
  }

  if (resource === 'login' && method === 'POST') {
    const { username, password } = await readBody(req);
    const { rows } = await db.query(
      'SELECT id, username, password_salt, password_hash FROM users WHERE lower(username) = lower($1)',
      [String(username)]
    );
    const user = rows[0];
    if (!user || !user.password_salt || !user.password_hash || typeof password !== 'string' || !verifyPassword(password, user.password_salt, user.password_hash))
      throw { status: 401, message: 'Wrong username or password' };
    const token = await createSession(user.id);
    logEvent('auth.login.succeeded', { method: 'password', userId: user.id, username: user.username });
    return send(res, 200, { token, user: { id: user.id, username: user.username } });
  }

  if (resource === 'logout' && method === 'POST') {
    const token = getToken(req);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    return send(res, 200, { message: 'Logged out' });
  }

  if (resource === 'me' && method === 'GET') {
    return send(res, 200, await requireUser(req));
  }

  // --- posts ---
  if (resource === 'posts') {
    // GET /api/posts  (optional ?search=)
    if (method === 'GET' && !id) {
      const search = (url.searchParams.get('search') || '').trim();
      let result;
      if (search) {
        const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
        result = await db.query(
          POST_SELECT + ' WHERE p.title ILIKE $1 OR p.content ILIKE $1 ORDER BY p.created_at DESC',
          [pattern]
        );
      } else {
        result = await db.query(POST_SELECT + ' ORDER BY p.created_at DESC', []);
      }
      return send(res, 200, result.rows);
    }

    // GET /api/posts/:id
    if (method === 'GET' && id) {
      const post = await findPost(id);
      if (!post) throw { status: 404, message: 'Post not found' };
      return send(res, 200, post);
    }

    // POST /api/posts
    if (method === 'POST' && !id) {
      const user = await requireUser(req);
      const body = await readBody(req);
      validatePost(body);
      const { rows } = await db.query(
        'INSERT INTO posts (title, content, author_id) VALUES ($1, $2, $3) RETURNING id',
        [body.title.trim(), body.content.trim(), user.id]
      );
      return send(res, 201, await findPost(rows[0].id));
    }

    // PATCH /api/posts/:id (change some fields)  and  PUT (replace everything)
    if ((method === 'PATCH' || method === 'PUT') && id) {
      const user = await requireUser(req);
      const post = await findPost(id);
      if (!post) throw { status: 404, message: 'Post not found' };
      if (post.authorId !== user.id) throw { status: 403, message: 'You can only edit your own posts' };
      const body = await readBody(req);
      validatePost(body, method === 'PATCH');
      // COALESCE keeps the old value when a field was not sent
      await db.query(
        `UPDATE posts
            SET title = COALESCE($2, title),
                content = COALESCE($3, content),
                updated_at = now()
          WHERE id = $1`,
        [id, body.title === undefined ? null : body.title.trim(), body.content === undefined ? null : body.content.trim()]
      );
      return send(res, 200, await findPost(id));
    }

    // DELETE /api/posts/:id
    if (method === 'DELETE' && id) {
      const user = await requireUser(req);
      const post = await findPost(id);
      if (!post) throw { status: 404, message: 'Post not found' };
      if (post.authorId !== user.id) throw { status: 403, message: 'You can only delete your own posts' };
      await db.query('DELETE FROM posts WHERE id = $1', [id]);
      return send(res, 200, { message: 'Post deleted' });
    }
  }

  throw { status: 404, message: 'Route not found' };
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  const filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (err && err.status) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server' });
    }
  } else {
    serveStatic(req, res, url);
  }
});

// Check the database before accepting traffic so problems show up immediately.
db.query('SELECT 1 FROM users LIMIT 1', [])
  .then(() => db.query(
    `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS google_sub TEXT;
     ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;
     ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
     CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
       ON users (google_sub) WHERE google_sub IS NOT NULL`
  ))
  .then(() => server.listen(PORT, () => console.log(`Blog running at http://localhost:${PORT} (PostgreSQL connected)`)))
  .catch((err) => {
    console.error('Could not use the database:', err.message);
    if (err.code === '42P01') console.error('-> Tables are missing. Run schema.sql in pgAdmin first.');
    if (err.code === '28P01') console.error('-> Wrong password in DATABASE_URL (.env).');
    if (err.code === '3D000') console.error('-> That database does not exist. Create it in pgAdmin first.');
    if (err.code === 'ECONNREFUSED') console.error('-> PostgreSQL is not running (or the port is wrong).');
    process.exit(1);
  });