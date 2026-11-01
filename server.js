'use strict';
require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

/*
 * Required NEW schema, not an executable migration. Submit platform migrations
 * through the database UI only. Authorized local owner SQL must first verify
 * SELECT DATABASE() matches p01; never run schema changes on app startup.
 * All tables InnoDB/utf8mb4_unicode_ci. IDs are INT UNSIGNED AUTO_INCREMENT PK
 * except bs_sessions. All FKs use ON DELETE RESTRICT ON UPDATE RESTRICT.
 * Timestamps are UTC DATETIME; required timestamps are supplied by this app.
 * bs_users: id, name VARCHAR(100) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE,
 *   password_hash VARCHAR(255) NOT NULL, role ENUM('member','admin') NOT NULL
 *   DEFAULT 'member', active TINYINT UNSIGNED NOT NULL DEFAULT 1 CHECK(active
 *   IN (0,1)), created_at DATETIME NOT NULL.
 * bs_sessions: token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PK,
 *   user_id INT UNSIGNED NOT NULL FK bs_users(id), expires_at DATETIME NOT NULL;
 *   INDEX(user_id), INDEX(expires_at).
 * bs_categories: id, name VARCHAR(100) NOT NULL UNIQUE.
 * bs_books: id, title VARCHAR(255) NOT NULL, author VARCHAR(255) NOT NULL,
 *   category_id INT UNSIGNED NOT NULL FK bs_categories(id), price DECIMAL(10,2)
 *   UNSIGNED NOT NULL, total_copies INT UNSIGNED NOT NULL, available_copies INT
 *   UNSIGNED NOT NULL, cover ENUM('navy','orange','sage','rose','ochre','blue')
 *   NOT NULL, description TEXT NOT NULL, active TINYINT UNSIGNED NOT NULL
 *   DEFAULT 1 CHECK(active IN (0,1)), CHECK(available_copies<=total_copies),
 *   CHECK(total_copies<=1000000); INDEX(active,id), INDEX(category_id,active,id).
 * bs_loans: id, user_id INT UNSIGNED NOT NULL FK bs_users(id), book_id INT
 *   UNSIGNED NOT NULL FK bs_books(id), request_key CHAR(36) CHARACTER SET ascii
 *   COLLATE ascii_bin NOT NULL, title VARCHAR(255) NOT NULL, author VARCHAR(255)
 *   NOT NULL (snapshots), borrowed_at DATETIME NOT NULL, due_at DATETIME NOT NULL,
 *   requested_return_at DATETIME NULL DEFAULT NULL, returned_at DATETIME NULL
 *   DEFAULT NULL, returned_by INT UNSIGNED NULL DEFAULT NULL FK bs_users(id),
 *   active_book_id INT UNSIGNED GENERATED ALWAYS AS
 *     (CASE WHEN returned_at IS NULL THEN book_id ELSE NULL END) PERSISTENT;
 *   UNIQUE(user_id,request_key), UNIQUE(user_id,active_book_id),
 *   INDEX(user_id,returned_at,due_at), INDEX(book_id,returned_at),
 *   INDEX(returned_at,due_at), INDEX(returned_at,requested_return_at),
 *   CHECK(due_at=DATE_ADD(borrowed_at,INTERVAL 14 DAY)),
 *   CHECK(requested_return_at IS NULL OR requested_return_at>=borrowed_at),
 *   CHECK((returned_at IS NULL AND returned_by IS NULL) OR
 *     (returned_at IS NOT NULL AND returned_at>=borrowed_at AND returned_by IS NOT NULL)).
 * Keep loan rows/request keys for replay safety even after return. Stock invariant:
 * available_copies = total_copies - unreturned loans. Cross-row three-loan and
 * overdue rules require application user-row locks, not just CHECK constraints.
 * Existing ll_* data is never read, migrated, seeded or modified.
 */
const port = Number(process.env.PORT);
if (port !== 31121) throw new Error('Set the confirmed p01 PORT (31121).');
let origin;
try {
  const url = new URL(process.env.APP_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  origin = url.origin;
} catch { throw new Error('Set APP_ORIGIN to a valid HTTP(S) origin without credentials or a path.'); }
const production = process.env.NODE_ENV === 'production';
const secureOrigin = origin.startsWith('https://');
// HTTP is opt-in only for the platform-confirmed private p01 route.
const privateHttp = process.env.ALLOW_PRIVATE_HTTP === 'true' && origin === 'http://10.200.210.117:31121';
if (production && !secureOrigin && !privateHttp) throw new Error('Production requires HTTPS or the explicitly enabled p01 private HTTP origin.');
const configured = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].every(key => process.env[key]);
// The platform supplies an isolated runtime DB user, distinct from the local owner.
if ((process.env.DB_NAME && process.env.DB_NAME !== 'db_std12_p01') ||
    (process.env.DB_PORT && process.env.DB_PORT !== '3306')) throw new Error('Database configuration must match confirmed project p01.');
const pool = configured ? mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionLimit: 4,
  waitForConnections: true, queueLimit: 20, connectTimeout: 5000, enableKeepAlive: true,
  multipleStatements: false, decimalNumbers: true, charset: 'utf8mb4', timezone: 'Z'
}) : null;

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', false);
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (production && secureOrigin) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
function fail(status, message) {
  const error = new Error(message); error.status = status; error.bookspaceSafe = true; throw error;
}
const limits = new Map();
function throttle(name, maximum, windowMs, identify = req => req.ip) {
  return (req, res, next) => {
    const key = `${name}:${identify(req)}`;
    const now = Date.now();
    let item = limits.get(key);
    if (!item || item.until <= now) {
      if (!item && limits.size >= 10000) return res.status(429).set('Retry-After', '60').json({ error: 'Too many requests. Try again later.' });
      item = { count: 0, until: now + windowMs }; limits.set(key, item);
    }
    if (++item.count > maximum) return res.status(429).set('Retry-After', String(Math.max(1, Math.ceil((item.until - now) / 1000)))).json({ error: 'Too many requests. Try again later.' });
    next();
  };
}
const cleanup = setInterval(() => { for (const [key, item] of limits) if (item.until <= Date.now()) limits.delete(key); }, 60000);
cleanup.unref();
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Frontend sends no CSRF token: exact Origin plus JSON is required instead.
    if (req.get('Origin') !== origin) fail(403, 'Open BOOKSPACE using the configured APP_ORIGIN.');
    if (!req.is('application/json')) fail(415, 'A JSON request body is required.');
  }
  next();
}, throttle('api', 240, 60000), express.json({ limit: '96kb', strict: true, inflate: false }));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const authLimit = throttle('auth-ip', 12, 15 * 60000);
const accountLimit = throttle('auth-account', 20, 15 * 60000, req => hash(typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : 'invalid'));
const borrowLimit = throttle('lending', 30, 60000);
app.use(['/api/auth/login', '/api/auth/register'], authLimit, accountLimit);
app.use('/api/loans', (req, res, next) => req.method === 'POST' ? borrowLimit(req, res, next) : next());
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, `Invalid ${label}.`);
  return value.trim();
}
function idOf(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]*$/.test(String(value))) fail(400, 'Invalid ID.');
  const id = Number(value);
  if (!Number.isInteger(id) || id > 4294967295) fail(400, 'Invalid ID.');
  return id;
}
function body(req, allowed) {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Invalid request fields.');
  return value;
}
function bool(value) { if (typeof value !== 'boolean') fail(400, 'Invalid active status.'); return value ? 1 : 0; }
function search(req) { return req.query.q === undefined ? '' : text(req.query.q, 0, 150, 'search'); }
function like(value) { return `%${value.replace(/[!%_]/g, character => `!${character}`)}%`; }
function pageOf(req) {
  const raw = req.query.page === undefined ? '1' : req.query.page;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,6}$/.test(raw)) fail(400, 'Invalid page.');
  return Number(raw);
}
const pageSize = 12;
function pageData(total, page) { return { total: Number(total), page, pages: Math.max(1, Math.ceil(Number(total) / pageSize)) }; }
const cookieName = secureOrigin ? '__Host-bs_p01_session' : 'bs_p01_session';
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: secureOrigin, path: '/' };
function cookieToken(req) {
  const tokens = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (tokens.length !== 1) return null;
  const token = tokens[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
async function query(db, sql, values = []) {
  const [result] = await db.execute({ sql, timeout: 8000 }, values); return result;
}
const userColumns = 'id,name,email,role,active,created_at';
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, created_at: user.created_at };
}
async function authenticate(req) {
  const token = cookieToken(req);
  if (!token) fail(401, 'Please sign in.');
  const rows = await query(req.db, `SELECT u.id,u.name,u.email,u.role,u.active,u.created_at
    FROM bs_sessions s JOIN bs_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=1`, [hash(token)]);
  if (!rows.length) fail(401, 'Your session has expired. Please sign in again.');
  req.user = rows[0];
}
// Transactional writers lock users in ascending order, then book, then loan.
async function lockUsers(req, target = req.user.id) {
  const ids = [...new Set([req.user.id, target])].sort((a, b) => a - b);
  const users = new Map();
  for (const id of ids) {
    const rows = await query(req.db, `SELECT ${userColumns} FROM bs_users WHERE id=? FOR UPDATE`, [id]);
    if (!rows.length) fail(404, 'Member not found.');
    users.set(id, rows[0]);
  }
  const current = users.get(req.user.id);
  if (!current.active) fail(401, 'This account is disabled.');
  if (req.adminRequired && current.role !== 'admin') fail(403, 'Administrator access required.');
  const sessions = await query(req.db, 'SELECT token_hash FROM bs_sessions WHERE token_hash=? AND user_id=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE', [hash(cookieToken(req)), current.id]);
  if (!sessions.length) fail(401, 'Your session has expired.');
  req.user = current;
  return users.get(target);
}
async function issueSession(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  // One live session per account; its user row is locked or newly inserted.
  await query(req.db, 'DELETE FROM bs_sessions WHERE user_id=?', [user.id]);
  await query(req.db, 'INSERT INTO bs_sessions (token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))', [hash(token), user.id]);
  req.newToken = token;
}
function route(method, url, options, handler) {
  app[method](url, async (req, res) => {
    if (!pool) fail(503, 'Database configuration is incomplete.');
    let db;
    let transaction = false;
    try {
      db = await pool.getConnection(); req.db = db;
      const rows = await query(db, 'SELECT DATABASE() AS selected_database');
      if (rows[0]?.selected_database !== 'db_std12_p01') fail(503, 'Project database verification failed.');
      await query(db, "SET SESSION time_zone = '+00:00'");
      if (options.auth) await authenticate(req);
      req.adminRequired = Boolean(options.admin);
      if (options.admin && req.user.role !== 'admin') fail(403, 'Administrator access required.');
      if (options.tx) {
        await query(db, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await db.beginTransaction(); transaction = true;
      }
      const data = await handler(req);
      if (transaction) { await db.commit(); transaction = false; }
      if (req.newToken) res.cookie(cookieName, req.newToken, { ...cookieOptions, maxAge: 7 * 86400000 });
      if (req.clearToken) res.clearCookie(cookieName, cookieOptions);
      res.status(req.responseStatus || 200).json(data);
    } catch (error) {
      if (transaction) {
        try { await db.rollback(); } catch { db.destroy(); db = null; }
      }
      throw error;
    } finally { if (db) db.release(); }
  });
}
const member = { auth: true };
const memberWrite = { auth: true, tx: true };
const administrator = { auth: true, admin: true };
const adminWrite = { auth: true, admin: true, tx: true };
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'BOOKSPACE', databaseChecked: false }));
const dummyHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);
function emailOf(value) {
  const email = text(value, 3, 254, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Invalid email.');
  return email;
}
function passwordOf(value, registering = false) {
  if (typeof value !== 'string' || value.length < (registering ? 8 : 1) || value.length > 128 || Buffer.byteLength(value, 'utf8') > 72 || value.includes('\0')) fail(400, 'Password must be 8-128 characters for registration and at most 72 UTF-8 bytes.');
  return value;
}
route('post', '/api/auth/register', { tx: true }, async req => {
  const input = body(req, ['name', 'email', 'password']);
  const name = text(input.name, 1, 100, 'name');
  const email = emailOf(input.email);
  const passwordHash = await bcrypt.hash(passwordOf(input.password, true), 12);
  const result = await query(req.db, "INSERT INTO bs_users (name,email,password_hash,role,active,created_at) VALUES (?,?,?,'member',1,UTC_TIMESTAMP())", [name, email, passwordHash]);
  const [user] = await query(req.db, `SELECT ${userColumns} FROM bs_users WHERE id=?`, [result.insertId]);
  await issueSession(req, user);
  req.responseStatus = 201;
  return { user: publicUser(user) };
});
route('post', '/api/auth/login', { tx: true }, async req => {
  const input = body(req, ['email', 'password']);
  const email = emailOf(input.email);
  const password = passwordOf(input.password);
  const [user] = await query(req.db, `SELECT ${userColumns},password_hash FROM bs_users WHERE email=? FOR UPDATE`, [email]);
  const valid = await bcrypt.compare(password, user?.password_hash || dummyHash);
  if (!valid || !user || !user.active) fail(401, 'Invalid email or password.');
  await issueSession(req, user);
  return { user: publicUser(user) };
});
route('get', '/api/auth/me', member, async req => ({ user: publicUser(req.user) }));
route('post', '/api/auth/logout', { tx: true }, async req => {
  body(req, []);
  const token = cookieToken(req);
  if (token) {
    const [owner] = await query(req.db, 'SELECT user_id FROM bs_sessions WHERE token_hash=?', [hash(token)]);
    if (owner) {
      await query(req.db, 'SELECT id FROM bs_users WHERE id=? FOR UPDATE', [owner.user_id]);
      await query(req.db, 'DELETE FROM bs_sessions WHERE token_hash=? AND user_id=?', [hash(token), owner.user_id]);
    }
  }
  req.clearToken = true;
  return { ok: true };
});
route('patch', '/api/account', memberWrite, async req => {
  const name = text(body(req, ['name']).name, 1, 100, 'name');
  await lockUsers(req);
  await query(req.db, 'UPDATE bs_users SET name=? WHERE id=?', [name, req.user.id]);
  return { user: publicUser({ ...req.user, name }) };
});
route('get', '/api/categories', {}, async req => ({ categories: await query(req.db, 'SELECT id,name FROM bs_categories ORDER BY name,id') }));
route('post', '/api/admin/categories', adminWrite, async req => {
  const name = text(body(req, ['name']).name, 1, 100, 'category name');
  await lockUsers(req);
  const result = await query(req.db, 'INSERT INTO bs_categories (name) VALUES (?)', [name]);
  req.responseStatus = 201;
  return { id: result.insertId, category: { id: result.insertId, name } };
});
const bookColumns = 'b.id,b.title,b.author,b.category_id,c.name AS category,b.price,b.total_copies,b.available_copies,b.cover,b.description,b.active';
async function booksList(req, all) {
  const page = pageOf(req);
  const q = search(req);
  const clauses = all ? ['1=1'] : ['b.active=1'];
  const values = [];
  if (q) {
    clauses.push("(b.title LIKE ? ESCAPE '!' OR b.author LIKE ? ESCAPE '!')");
    values.push(like(q), like(q));
  }
  if (req.query.category !== undefined && req.query.category !== '') {
    clauses.push('b.category_id=?'); values.push(idOf(req.query.category));
  }
  const where = clauses.join(' AND ');
  const [count] = await query(req.db, `SELECT COUNT(*) AS total FROM bs_books b WHERE ${where}`, values);
  const books = await query(req.db, `SELECT ${bookColumns} FROM bs_books b JOIN bs_categories c ON c.id=b.category_id WHERE ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
  return { books, ...pageData(count.total, page) };
}
route('get', '/api/books', {}, req => booksList(req, false));
route('get', '/api/admin/books', administrator, req => booksList(req, true));
route('get', '/api/books/:id', {}, async req => {
  const [book] = await query(req.db, `SELECT ${bookColumns} FROM bs_books b JOIN bs_categories c ON c.id=b.category_id WHERE b.id=? AND b.active=1`, [idOf(req.params.id)]);
  if (!book) fail(404, 'Book not found or no longer listed.');
  return { book };
});
async function loansList(req, all) {
  const page = pageOf(req);
  const where = all ? '' : 'WHERE l.user_id=?';
  const values = all ? [] : [req.user.id];
  const [count] = await query(req.db, `SELECT COUNT(*) AS total FROM bs_loans l ${where}`, values);
  const loans = await query(req.db, `SELECT l.id,l.user_id,l.book_id,l.title,l.author,l.borrowed_at,l.due_at,l.requested_return_at,l.returned_at,l.returned_by${all ? ',u.name AS user_name,u.email AS user_email' : ''}
    FROM bs_loans l ${all ? 'JOIN bs_users u ON u.id=l.user_id' : ''} ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
  return { loans, ...pageData(count.total, page) };
}
route('get', '/api/loans', member, req => loansList(req, false));
route('get', '/api/admin/loans', administrator, req => loansList(req, true));
route('post', '/api/loans', memberWrite, async req => {
  const input = body(req, ['bookId']);
  if (typeof input.bookId !== 'number') fail(400, 'Invalid book ID.');
  const bookId = idOf(input.bookId);
  const rawKey = req.get('Idempotency-Key');
  if (typeof rawKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawKey)) fail(400, 'A UUID v4 Idempotency-Key is required.');
  const key = rawKey.toLowerCase();
  await lockUsers(req);
  // Replays precede stock and overdue rules, even after the loan is returned.
  const [previous] = await query(req.db, 'SELECT id,book_id FROM bs_loans WHERE user_id=? AND request_key=? FOR UPDATE', [req.user.id, key]);
  if (previous) {
    if (previous.book_id !== bookId) fail(409, 'This request key belongs to another book.');
    return { id: previous.id, replayed: true };
  }
  const [book] = await query(req.db, 'SELECT id,title,author,active,total_copies,available_copies FROM bs_books WHERE id=? FOR UPDATE', [bookId]);
  if (!book || !book.active) fail(404, 'Book not found or no longer available for lending.');
  const active = await query(req.db, 'SELECT id,book_id,(due_at<UTC_TIMESTAMP()) AS overdue FROM bs_loans WHERE user_id=? AND returned_at IS NULL FOR UPDATE', [req.user.id]);
  if (active.some(loan => loan.overdue)) fail(409, 'Return overdue books and wait for physical return confirmation before borrowing.');
  if (active.length >= 3) fail(409, 'You may have at most 3 active loans.');
  if (active.some(loan => loan.book_id === bookId)) fail(409, 'You already have an active loan for this title.');
  const [count] = await query(req.db, 'SELECT COUNT(*) AS count FROM bs_loans WHERE book_id=? AND returned_at IS NULL', [bookId]);
  if (book.total_copies - book.available_copies !== Number(count.count)) fail(503, 'Inventory needs administrator review.');
  if (book.available_copies < 1) fail(409, 'No copies are currently available.');
  const result = await query(req.db, `INSERT INTO bs_loans (user_id,book_id,request_key,title,author,borrowed_at,due_at)
    VALUES (?,?,?,?,?,UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(), INTERVAL 14 DAY))`, [req.user.id, bookId, key, book.title, book.author]);
  const stock = await query(req.db, 'UPDATE bs_books SET available_copies=available_copies-1 WHERE id=? AND available_copies>0', [bookId]);
  if (stock.affectedRows !== 1) fail(409, 'No copies are currently available.');
  req.responseStatus = 201;
  return { id: result.insertId, replayed: false };
});
async function returnLoan(req, confirm) {
  body(req, []);
  const id = idOf(req.params.id);
  const [identity] = await query(req.db, `SELECT user_id,book_id FROM bs_loans WHERE id=?${confirm ? '' : ' AND user_id=?'}`, confirm ? [id] : [id, req.user.id]);
  if (!identity) fail(404, 'Loan not found.');
  await lockUsers(req, identity.user_id);
  const [book] = await query(req.db, 'SELECT id,total_copies,available_copies FROM bs_books WHERE id=? FOR UPDATE', [identity.book_id]);
  if (!book) fail(503, 'Inventory needs administrator review.');
  const [loan] = await query(req.db, 'SELECT id,user_id,book_id,requested_return_at,returned_at FROM bs_loans WHERE id=? FOR UPDATE', [id]);
  if (!loan || loan.user_id !== identity.user_id || loan.book_id !== identity.book_id) fail(409, 'Loan changed. Please reload.');
  if (loan.returned_at) return { ok: true, id, alreadyReturned: true };
  if (!confirm) {
    if (!loan.requested_return_at) await query(req.db, 'UPDATE bs_loans SET requested_return_at=UTC_TIMESTAMP() WHERE id=? AND returned_at IS NULL AND requested_return_at IS NULL', [id]);
    return { ok: true, id, pending: true };
  }
  const [count] = await query(req.db, 'SELECT COUNT(*) AS count FROM bs_loans WHERE book_id=? AND returned_at IS NULL', [identity.book_id]);
  if (book.total_copies - book.available_copies !== Number(count.count)) fail(503, 'Inventory needs administrator review.');
  const closed = await query(req.db, 'UPDATE bs_loans SET returned_at=UTC_TIMESTAMP(),returned_by=? WHERE id=? AND returned_at IS NULL', [req.user.id, id]);
  if (closed.affectedRows !== 1) fail(409, 'Loan changed. Please reload.');
  const stock = await query(req.db, 'UPDATE bs_books SET available_copies=available_copies+1 WHERE id=? AND available_copies<total_copies', [identity.book_id]);
  if (stock.affectedRows !== 1) fail(503, 'Inventory needs administrator review.');
  return { ok: true, id, alreadyReturned: false };
}
route('post', '/api/loans/:id/return', memberWrite, req => returnLoan(req, false));
route('post', '/api/admin/loans/:id/return', adminWrite, req => returnLoan(req, true));
function bookInput(req) {
  const input = body(req, ['title', 'author', 'category_id', 'price', 'total_copies', 'cover', 'description', 'active']);
  const title = text(input.title, 1, 255, 'title');
  const author = text(input.author, 1, 255, 'author');
  if (typeof input.category_id !== 'number') fail(400, 'Invalid category.');
  const category = idOf(input.category_id);
  const price = input.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 99999999.99 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) fail(400, 'Invalid book value (maximum 99999999.99, two decimal places).');
  const total = input.total_copies;
  if (!Number.isInteger(total) || total < 0 || total > 1000000) fail(400, 'Total copies must be an integer from 0 to 1000000.');
  if (!['navy', 'orange', 'sage', 'rose', 'ochre', 'blue'].includes(input.cover)) fail(400, 'Invalid cover theme.');
  return { title, author, category, price, total, cover: input.cover, description: text(input.description, 0, 10000, 'description'), active: bool(input.active) };
}
async function categoryExists(req, id) {
  const rows = await query(req.db, 'SELECT id FROM bs_categories WHERE id=? LOCK IN SHARE MODE', [id]);
  if (!rows.length) fail(400, 'Category not found.');
}
route('post', '/api/admin/books', adminWrite, async req => {
  const b = bookInput(req);
  await lockUsers(req);
  await categoryExists(req, b.category);
  const result = await query(req.db, 'INSERT INTO bs_books (title,author,category_id,price,total_copies,available_copies,cover,description,active) VALUES (?,?,?,?,?,?,?,?,?)', [b.title, b.author, b.category, b.price, b.total, b.total, b.cover, b.description, b.active]);
  req.responseStatus = 201;
  return { id: result.insertId };
});
route('put', '/api/admin/books/:id', adminWrite, async req => {
  const id = idOf(req.params.id);
  const b = bookInput(req);
  await lockUsers(req);
  const [existing] = await query(req.db, 'SELECT id,total_copies,available_copies FROM bs_books WHERE id=? FOR UPDATE', [id]);
  if (!existing) fail(404, 'Book not found.');
  const [counts] = await query(req.db, 'SELECT COUNT(*) AS count FROM bs_loans WHERE book_id=? AND returned_at IS NULL', [id]);
  if (existing.total_copies - existing.available_copies !== Number(counts.count)) fail(503, 'Inventory needs administrator review.');
  if (b.total < Number(counts.count)) fail(409, 'Total copies cannot be lower than the number still on loan.');
  await categoryExists(req, b.category);
  await query(req.db, 'UPDATE bs_books SET title=?,author=?,category_id=?,price=?,total_copies=?,available_copies=?,cover=?,description=?,active=? WHERE id=?', [b.title, b.author, b.category, b.price, b.total, b.total - Number(counts.count), b.cover, b.description, b.active, id]);
  return { ok: true };
});
route('get', '/api/admin/users', administrator, async req => {
  const page = pageOf(req);
  const q = search(req);
  const where = q ? "WHERE name LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!'" : '';
  const values = q ? [like(q), like(q)] : [];
  const [count] = await query(req.db, `SELECT COUNT(*) AS total FROM bs_users ${where}`, values);
  const users = await query(req.db, `SELECT ${userColumns} FROM bs_users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
  return { users, ...pageData(count.total, page) };
});
route('patch', '/api/admin/users/:id', adminWrite, async req => {
  const id = idOf(req.params.id);
  const input = body(req, ['name', 'active']);
  const name = text(input.name, 1, 100, 'name');
  const active = bool(input.active);
  const user = await lockUsers(req, id);
  if (user.role === 'admin' && !active) fail(403, 'Administrator accounts cannot be disabled.');
  await query(req.db, 'UPDATE bs_users SET name=?,active=? WHERE id=?', [name, active, id]);
  if (!active) await query(req.db, 'DELETE FROM bs_sessions WHERE user_id=?', [id]);
  return { ok: true, user: publicUser({ ...user, name, active }) };
});
route('get', '/api/admin/summary', administrator, async req => {
  const [summary] = await query(req.db, `SELECT
    (SELECT COUNT(*) FROM bs_users) AS users,
    (SELECT COUNT(*) FROM bs_books) AS books,
    (SELECT COUNT(*) FROM bs_loans WHERE returned_at IS NULL) AS activeLoans,
    (SELECT COUNT(*) FROM bs_loans WHERE returned_at IS NULL AND due_at<UTC_TIMESTAMP()) AS overdueLoans,
    (SELECT COUNT(*) FROM bs_loans WHERE returned_at IS NULL AND requested_return_at IS NOT NULL) AS pendingReturns`);
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value)]));
});
// Serve only the known frontend assets and images; reject symlinks and traversal.
app.use(async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  let requested;
  try { requested = decodeURIComponent(req.path); } catch { fail(400, 'Invalid path.'); }
  if (requested === '/') requested = '/index.html';
  const known = ['/index.html', '/style.css', '/index.js'].includes(requested);
  if (!known && !/^\/images\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|gif|webp)$/i.test(requested)) return next();
  const segments = requested.slice(1).split('/');
  if (segments.some(segment => !segment || segment.startsWith('.'))) return next();
  const root = path.join(__dirname, 'public');
  try {
    let current = root;
    if ((await fs.lstat(current)).isSymbolicLink()) return next();
    for (const segment of segments) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) return next();
    }
    const canonicalRoot = await fs.realpath(root);
    const target = await fs.realpath(current);
    const relative = path.relative(canonicalRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(target)).isFile()) return next();
    res.sendFile(target, { dotfiles: 'deny', cacheControl: false }, error => { if (error) next(error); });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return next();
    throw error;
  }
});
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let status = 500;
  let message = 'The service could not complete the request. Please try again.';
  if (error.bookspaceSafe === true && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    status = error.status; message = error.message;
  } else if (['entity.parse.failed', 'request.aborted', 'request.size.invalid'].includes(error.type) || error instanceof URIError) {
    status = 400; message = 'Invalid request.';
  } else if (error.type === 'entity.too.large') {
    status = 413; message = 'Request body is too large.';
  } else if (['encoding.unsupported', 'charset.unsupported'].includes(error.type)) {
    status = 415; message = 'Unsupported request encoding.';
  } else if (error.code === 'ER_DUP_ENTRY') {
    status = 409; message = 'A conflicting account, category or loan already exists. Reload and try again.';
  } else if (['ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2', 'ER_CHECK_CONSTRAINT_VIOLATED', 'ER_CONSTRAINT_FAILED'].includes(error.code)) {
    status = 409; message = 'The request conflicts with current data. Reload and try again.';
  } else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_DB_ERROR', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'POOL_ENQUEUELIMIT', 'POOL_CLOSED', 'ER_CON_COUNT_ERROR'].includes(error.code) || error.message === 'Queue limit reached.') {
    status = 503; message = 'Database unavailable or lending schema not ready. Please try again later.';
  }
  if (status === 503) res.set('Retry-After', '5');
  // Never log SQL, parameters, cookies, connection details or raw exceptions.
  if (status >= 500) console.error('BOOKSPACE request unavailable.');
  res.status(status).json({ error: message });
});
const server = app.listen(port, '0.0.0.0', () => console.log('BOOKSPACE / p01 listening.'));
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on('error', () => { console.error('Unable to start BOOKSPACE. Check the assigned port.'); process.exitCode = 1; });
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 10000); timer.unref();
  server.close(async () => {
    try { if (pool) await pool.end(); clearTimeout(timer); process.exit(0); }
    catch { process.exit(1); }
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

