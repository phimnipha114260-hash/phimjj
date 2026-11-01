'use strict';

const main = document.getElementById('main');
const navigation = document.getElementById('navigation');
const menu = document.getElementById('menu-toggle');
const themes = ['navy', 'orange', 'sage', 'rose', 'ochre', 'blue'];
const themeNames = { navy: 'กรมท่า', orange: 'ส้ม', sage: 'เขียวเสจ', rose: 'กุหลาบ', ochre: 'เหลืองดิน', blue: 'ฟ้า' };
const state = { user: null, authError: null, version: 0, busy: new Set(), attempts: new Map() };
let toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idPath = id => encodeURIComponent(String(id));
const enabled = value => value === true || value === 1 || value === '1';
const money = value => new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(Number(value) || 0);
const integer = value => new Intl.NumberFormat('th-TH').format(Number(value) || 0);
const rules = '<div class="note"><strong>อ่านอย่างสบายใจ แบ่งปันอย่างรับผิดชอบ</strong>ยืมพร้อมกันได้สูงสุด 3 เล่ม กำหนดคืนภายใน 14 วัน ไม่ยืมหนังสือเล่มเดิมซ้ำขณะที่ยังไม่คืน และไม่สามารถยืมเพิ่มหากมีรายการเกินกำหนด<br>การกดขอคืนเป็นเพียงการแจ้งความประสงค์ ต้องนำหนังสือจริงมาคืน และรอผู้ดูแลยืนยัน จึงถือว่าคืนสำเร็จ</div>';

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(path, {
      method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    let data;
    try { data = await response.json(); } catch {
      throw new ApiError('เซิร์ฟเวอร์ส่งข้อมูลไม่สมบูรณ์ กรุณาลองอีกครั้ง', response.ok ? 502 : response.status);
    }
    if (!response.ok) {
      const fallback = response.status === 503 ? 'ฐานข้อมูลยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' : 'ไม่สามารถดำเนินการได้';
      throw new ApiError(data.error || fallback, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('การเชื่อมต่อขัดข้องหรือหมดเวลา ยังยืนยันผลไม่ได้ กรุณาลองอีกครั้ง');
  } finally { clearTimeout(timer); }
}

function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'ไม่ทราบวันที่';
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(parsed);
}

function routeInfo() {
  const raw = location.hash.slice(1) || 'home';
  const split = raw.indexOf('?');
  const path = split < 0 ? raw : raw.slice(0, split);
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  return { path, params, page: Math.max(1, parseInt(params.get('page'), 10) || 1) };
}

function href(path, values = {}) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== '' && value != null) params.set(key, value); });
  return `#${path}${params.size ? `?${params}` : ''}`;
}

function navigate(path) {
  if (location.hash === path) render();
  else location.hash = path;
}

function notify(message) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
}

function nav() {
  const path = routeInfo().path;
  const link = (target, label, extra = '') => `<a href="#${target}" ${path === target ? 'aria-current="page"' : ''} ${extra}>${label}</a>`;
  navigation.innerHTML = link('home', 'หน้าแรก') + link('books', 'ชั้นหนังสือ') + (state.user
    ? link('loans', 'รายการยืมของฉัน') + link('account', 'บัญชีของฉัน') + (state.user.role === 'admin' ? link('admin', 'ผู้ดูแล') : '') + '<button class="btn small alt" data-action="logout">ออกจากระบบ</button>'
    : link('login', 'เข้าสู่ระบบ') + link('register', 'สมัครสมาชิก', 'class="nav-join"'));
}

function errorBox(error, retry = 'retry') {
  const title = error.status === 503 ? 'ฐานข้อมูลยังไม่พร้อมใช้งาน' : 'ยังโหลดข้อมูลไม่ได้';
  return `<div class="error-box" role="alert"><h2>${title}</h2><p>${esc(error.message)}</p><button class="btn small alt" data-action="${retry}">ลองอีกครั้ง</button></div>`;
}

function empty(title, text) {
  return `<div class="empty-state"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

function cover(book) {
  const theme = themes.includes(book.cover) ? book.cover : 'navy';
  return `<div class="cover ${theme}" aria-hidden="true"><small>BOOKSPACE / READING COLLECTION</small><strong>${esc(book.title)}</strong><span class="cover-author">${esc(book.author)}</span></div>`;
}

function card(book) {
  const target = href(`book/${idPath(book.id)}`);
  return `<article class="book-card"><a class="cover-stage" href="${esc(target)}" aria-label="${esc(`ดูรายละเอียด ${book.title}`)}">${cover(book)}<span class="stock">${Number(book.available_copies) > 0 ? 'พร้อมให้ยืม' : 'ยังไม่มีเล่มว่าง'}</span></a><p class="book-category">${esc(book.category || 'ไม่ระบุหมวดหมู่')}</p><a class="book-title" href="${esc(target)}">${esc(book.title)}</a><p class="book-author">${esc(book.author)}</p><div class="book-meta"><span>มูลค่าหนังสือ ${esc(money(book.price))}</span><a href="${esc(target)}">รายละเอียด ↗</a></div></article>`;
}

function pagination(data, path, params = {}) {
  const page = Number(data.page) || 1;
  const pages = Math.max(1, Number(data.pages) || 1);
  if (pages <= 1) return '';
  return `<nav class="pagination" aria-label="เปลี่ยนหน้า">${page > 1 ? `<a class="btn small alt" href="${esc(href(path, { ...params, page: page - 1 }))}">← ก่อนหน้า</a>` : '<span>หน้าแรก</span>'}<span>หน้า ${integer(page)} / ${integer(pages)}</span>${page < pages ? `<a class="btn small alt" href="${esc(href(path, { ...params, page: page + 1 }))}">ถัดไป →</a>` : '<span>หน้าสุดท้าย</span>'}</nav>`;
}

function heading(kicker, title, aside = '') {
  return `<div class="section-head"><div><p class="eyebrow">${kicker}</p><h1>${esc(title)}</h1></div>${aside}</div>`;
}

async function loadAuth() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    state.authError = null;
  } catch (error) {
    state.user = null;
    state.authError = error.status === 401 ? null : error;
  }
  nav();
}

async function home() {
  let shelf;
  try {
    const data = await api('/api/books?q=&category=&page=1');
    shelf = data.books.length ? `<div class="book-grid">${data.books.slice(0, 4).map(card).join('')}</div>` : empty('ชั้นหนังสือกำลังรอเรื่องราว', 'ยังไม่มีหนังสือในระบบ เมื่อผู้ดูแลเพิ่มหนังสือจะแสดงที่นี่');
  } catch (error) { shelf = errorBox(error); }
  return `<section class="landing"><div><p class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h1 class="display">Less noise.<br>More <em>pages.</em></h1><p class="hero-sub">พื้นที่เล็ก ๆ ของหนังสือและคุณ</p><p class="lead">พักจากความวุ่นวาย แล้วปล่อยให้หนังสือพาไปพบมุมมองใหม่ เลือกเล่มที่ชอบ ยืมไปอ่าน และส่งต่อเรื่องราวดี ๆ</p><div class="actions"><a class="btn orange" href="#books">ค้นพบเล่มถัดไป <span aria-hidden="true">↗</span></a><a href="#loans">รายการยืมของฉัน →</a></div></div><div class="hero-drawing" role="img" aria-label="ภาพประกอบหนังสือออกแบบตัวอักษร BOOK SPACE ไม่ใช่รายการหนังสือจริง"><div class="art-book art-back"><small>A NEW PERSPECTIVE</small><strong>Make<br>room for<br>stories.</strong><small>THE READING LIFE</small></div><div class="art-book art-front"><small>THE BOOKSPACE MANIFESTO</small><strong>One<br>more<br>chapter.</strong></div><span class="art-caption">A LITTLE SPACE. A BIGGER WORLD.</span></div></section><div class="rule-strip"><span><b>01</b>เลือกหนังสือที่อยากอ่าน</span><span><b>02</b>ยืมสูงสุด 3 เล่ม / 14 วัน</span><span><b>03</b>คืนเล่มจริง ส่งต่อการอ่าน</span></div><section aria-labelledby="shelf-heading"><div class="section-head"><div><p class="eyebrow">ON THE SHELF</p><h2 id="shelf-heading">เรื่องราวที่รอให้คุณเปิดอ่าน</h2></div><a href="#books">ดูหนังสือทั้งหมด ↗</a></div>${shelf}</section>`;
}

function categoryOptions(categories, selected = '', all = true) {
  return (all ? '<option value="">ทุกหมวดหมู่</option>' : '<option value="">เลือกหมวดหมู่</option>') + categories.map(c => `<option value="${esc(c.id)}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

async function books(info) {
  const q = info.params.get('q') || '';
  const category = info.params.get('category') || '';
  const query = new URLSearchParams({ q, category, page: info.page });
  const [data, categories] = await Promise.all([api(`/api/books?${query}`), api('/api/categories')]);
  return heading('THE BOOK COLLECTION', 'หาหนังสือที่เป็นคุณ') + `<p class="lead">ทุกเล่มคือประตูอีกบาน เลือกเปิดในจังหวะของคุณ · ราคาแสดงมูลค่าหนังสือเท่านั้น ไม่ใช่การซื้อสินค้า</p><form id="catalog-search" class="catalog-tools"><label class="field">ค้นหาหนังสือ<input type="search" name="q" value="${esc(q)}" placeholder="ชื่อหนังสือ หรือผู้เขียน" maxlength="150"></label><label class="field">หมวดหมู่<select name="category">${categoryOptions(categories.categories, category)}</select></label><button class="btn" type="submit">ค้นหา ↗</button></form><p class="muted" role="status">พบ ${integer(data.total)} เล่ม</p>${data.books.length ? `<div class="book-grid">${data.books.map(card).join('')}</div>` : empty('ยังไม่พบเล่มที่ใช่', 'ลองเปลี่ยนคำค้นหาหรือเลือกหมวดหมู่อื่น หากยังไม่มีหนังสือ โปรดรอผู้ดูแลเพิ่มรายการ')}${pagination(data, 'books', { q, category })}`;
}

async function bookDetail(id) {
  const { book } = await api(`/api/books/${idPath(id)}`);
  const canBorrow = Number(book.available_copies) > 0 && enabled(book.active);
  const button = state.user ? `<button class="btn orange" data-action="borrow" data-id="${esc(book.id)}" ${canBorrow ? '' : 'disabled'}>${canBorrow ? 'ยืมหนังสือเล่มนี้' : 'ยังไม่พร้อมให้ยืม'}</button>` : '<a class="btn orange" href="#login">เข้าสู่ระบบเพื่อยืมหนังสือ</a>';
  return `<a class="back-link" href="#books">← กลับชั้นหนังสือ</a><div class="detail-view"><div class="cover-stage">${cover(book)}</div><section><p class="eyebrow">${esc(book.category || 'BOOKSPACE COLLECTION')}</p><h1>${esc(book.title)}</h1><p class="lead">${esc(book.author)}</p><dl class="definition"><div><dt>มูลค่าหนังสือ (ไม่ใช่ราคาซื้อ)</dt><dd>${esc(money(book.price))}</dd></div><div><dt>จำนวนพร้อมให้ยืม / ทั้งหมด</dt><dd>${integer(book.available_copies)} / ${integer(book.total_copies)} เล่ม</dd></div></dl><p class="description">${esc(book.description || 'ยังไม่มีคำอธิบายหนังสือเล่มนี้')}</p>${rules}<div class="actions">${button}<a href="#loans">ดูรายการยืม →</a></div><div id="borrow-feedback" aria-live="polite"></div></section></div>`;
}

function feedback() { return '<p class="form-feedback" role="alert" hidden></p>'; }

function authPage(register) {
  if (state.user) return heading('WELCOME BACK', `สวัสดี ${state.user.name}`) + '<a class="btn" href="#account">ไปยังบัญชีของฉัน</a>';
  return `<div class="auth-layout"><aside class="auth-aside"><p class="eyebrow">BELONG TO A READING COMMUNITY</p><p class="display">A space<br>to <em>belong.</em></p><p>เพราะเรื่องราวดี ๆ<br>เริ่มต้นได้จากหนังสือเพียงเล่มเดียว</p></aside><form id="${register ? 'register' : 'login'}" class="form-stack"><p class="eyebrow">${register ? 'JOIN BOOKSPACE' : 'WELCOME BACK'}</p><h1>${register ? 'เริ่มบทใหม่กับเรา' : 'กลับสู่พื้นที่ของคุณ'}</h1><p class="muted">${register ? 'สมัครสมาชิกเพื่อยืมหนังสือและติดตามประวัติการอ่าน' : 'เข้าสู่ระบบเพื่อจัดการการยืมและข้อมูลสมาชิก'}</p>${register ? '<label class="field">ชื่อที่แสดง<input name="name" required maxlength="100" autocomplete="name"></label>' : ''}<label class="field">อีเมล<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label class="field">รหัสผ่าน<input name="password" type="password" required ${register ? 'minlength="8"' : ''} maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}">${register ? '<small>อย่างน้อย 8 ตัวอักษร</small>' : ''}</label>${feedback()}<button class="btn orange" type="submit">${register ? 'สร้างบัญชีสมาชิก' : 'เข้าสู่ระบบ'} ↗</button><p class="muted">${register ? 'มีบัญชีแล้ว? <a href="#login">เข้าสู่ระบบ</a>' : 'ยังไม่มีบัญชี? <a href="#register">สมัครสมาชิก</a>'}</p></form></div>`;
}

function loanCard(loan, admin = false) {
  const returned = Boolean(loan.returned_at);
  const pending = !returned && Boolean(loan.requested_return_at);
  const overdue = !returned && new Date(loan.due_at).getTime() < Date.now();
  const label = returned ? 'คืนสำเร็จแล้ว' : pending ? `รอยืนยันรับคืน${overdue ? ' · เกินกำหนด' : ''}` : overdue ? 'เกินกำหนดคืน' : 'กำลังยืม';
  const badgeClass = overdue ? 'overdue' : pending ? 'pending' : '';
  return `<article class="loan-card"><div class="loan-head"><div><h3><a href="${esc(href(`book/${idPath(loan.book_id)}`))}">${esc(loan.title)}</a></h3><p>${esc(loan.author)} · รายการ #${esc(loan.id)}</p></div><span class="badge ${badgeClass}">${label}</span></div>${admin ? `<p>${esc(loan.user_name)} <span class="muted">${esc(loan.user_email)}</span></p>` : ''}<div class="loan-dates"><span>ยืม ${esc(date(loan.borrowed_at))}</span><span>กำหนดคืน ${esc(date(loan.due_at))}</span>${returned ? `<span>คืนแล้ว ${esc(date(loan.returned_at))}</span>` : ''}${pending ? `<span>ขอคืน ${esc(date(loan.requested_return_at))}</span>` : ''}</div>${!returned ? `<div class="actions">${admin ? `<button class="btn small" data-action="confirm-return" data-id="${esc(loan.id)}">ยืนยันรับคืนเล่มจริง</button>` : pending ? '<p class="muted">กรุณานำหนังสือจริงคืนเจ้าหน้าที่ รายการยังนับเป็นการยืมจนกว่าจะยืนยันรับคืน</p>' : `<button class="btn small alt" data-action="request-return" data-id="${esc(loan.id)}">แจ้งขอคืนหนังสือ</button>`}</div>` : ''}</article>`;
}

async function loansView(info, account = false) {
  const data = await api(`/api/loans?page=${info.page}`);
  const history = `<h2>ประวัติการยืม–คืน</h2><p class="muted">ทั้งหมด ${integer(data.total)} รายการ · เวลาไทย (UTC+7)</p>${data.loans.length ? data.loans.map(l => loanCard(l)).join('') : empty('เรื่องราวบทแรกกำลังรออยู่', 'คุณยังไม่มีรายการยืม ลองเลือกหนังสือจากชั้นหนังสือ')}${pagination(data, account ? 'account' : 'loans')}`;
  if (!account) return heading('YOUR READING JOURNEY', 'รายการยืมของฉัน') + rules + history;
  return heading('MY BOOKSPACE', 'บัญชีของฉัน') + `<div class="account-grid"><section class="panel"><h2>ข้อมูลสมาชิก</h2><p class="muted">${esc(state.user.email)}<br>${state.user.role === 'admin' ? 'ผู้ดูแลระบบ' : 'สมาชิก'}</p><form id="account-form" class="form-stack"><label class="field">ชื่อที่แสดง<input name="name" value="${esc(state.user.name)}" required maxlength="100" autocomplete="name"></label>${feedback()}<button class="btn" type="submit">บันทึกชื่อ</button></form></section><section>${history}</section></div>`;
}

function bookForm(book, categories, info) {
  const editing = Boolean(book);
  const b = book || { title: '', author: '', category_id: '', price: 0, total_copies: 1, cover: 'navy', description: '', active: true };
  return `<section class="panel"><div class="section-head"><h2>${editing ? 'แก้ไขหนังสือ' : 'เพิ่มหนังสือใหม่'}</h2><a href="${esc(href('admin', { tab: 'books', page: info.page }))}">กลับรายการ ↗</a></div><form id="book-form" class="form-grid" ${editing ? `data-id="${esc(b.id)}"` : ''}><label class="field">ชื่อหนังสือ<input name="title" value="${esc(b.title)}" required maxlength="255"></label><label class="field">ผู้เขียน<input name="author" value="${esc(b.author)}" required maxlength="255"></label><label class="field">หมวดหมู่<select name="category_id" required>${categoryOptions(categories, b.category_id, false)}</select></label><label class="field">มูลค่าหนังสือ (บาท)<input name="price" type="number" min="0" step="0.01" value="${esc(b.price)}" required></label><label class="field">จำนวนเล่มทั้งหมด<input name="total_copies" type="number" min="0" step="1" value="${esc(b.total_copies)}" required><small>ลดจำนวนต่ำกว่าเล่มที่ยังยืมอยู่ไม่ได้</small></label><label class="field">ธีมปกตัวอักษร<select name="cover">${themes.map(theme => `<option value="${theme}" ${b.cover === theme ? 'selected' : ''}>${themeNames[theme]} / ${theme}</option>`).join('')}</select></label><label class="field span-all">รายละเอียด<textarea name="description" maxlength="10000">${esc(b.description)}</textarea></label><label class="check span-all"><input name="active" type="checkbox" ${enabled(b.active) ? 'checked' : ''}>เปิดให้ยืม / แสดงในชั้นหนังสือ</label><div class="span-all">${feedback()}<div class="actions"><button class="btn" type="submit">${editing ? 'บันทึกการแก้ไข' : 'เพิ่มหนังสือ'}</button></div></div></form></section>`;
}

async function adminView(info) {
  const tab = info.params.get('tab') || 'summary';
  const tabs = [['summary', 'ภาพรวม'], ['books', 'หนังสือ'], ['users', 'สมาชิก'], ['loans', 'การยืม–คืน'], ['categories', 'หมวดหมู่']];
  const header = heading('THE READING ROOM / MANAGEMENT', 'พื้นที่จัดการ') + `<nav class="admin-tabs" aria-label="เมนูผู้ดูแล">${tabs.map(([key, name]) => `<a href="${esc(href('admin', { tab: key }))}" ${tab === key ? 'aria-current="page"' : ''}>${name}</a>`).join('')}</nav>`;
  let body;
  if (tab === 'summary') {
    const data = await api('/api/admin/summary');
    const fields = [['users', 'สมาชิก'], ['books', 'หนังสือ'], ['activeLoans', 'กำลังยืม'], ['overdueLoans', 'เกินกำหนด'], ['pendingReturns', 'รอรับคืน']];
    body = `<div class="stats-grid">${fields.map(([key, name]) => `<div class="stat"><b>${integer(data[key])}</b><span>${name}</span></div>`).join('')}</div>${rules}`;
  } else if (tab === 'books') {
    const [data, categories] = await Promise.all([api(`/api/admin/books?page=${info.page}`), api('/api/categories')]);
    if (info.params.has('edit')) {
      const book = data.books.find(b => String(b.id) === info.params.get('edit'));
      if (!book) throw new ApiError('ไม่พบหนังสือในหน้านี้ กรุณากลับรายการหนังสือแล้วเลือกแก้ไขอีกครั้ง', 404);
      body = bookForm(book, categories.categories, info);
    } else if (info.params.has('create')) body = bookForm(null, categories.categories, info);
    else body = `<div class="section-head"><h2>หนังสือทั้งหมด · ${integer(data.total)}</h2><a class="btn small" href="${esc(href('admin', { tab, create: 1 }))}">+ เพิ่มหนังสือ</a></div>${data.books.length ? `<div class="table-scroll"><table><caption>ข้อมูลหนังสือทั้งหมด รวมรายการที่ปิดใช้งาน</caption><thead><tr><th scope="col">หนังสือ</th><th scope="col">มูลค่า</th><th scope="col">ว่าง / ทั้งหมด</th><th scope="col">สถานะ</th><th scope="col">จัดการ</th></tr></thead><tbody>${data.books.map(b => `<tr><td>${esc(b.title)}<small>${esc(b.author)} · ${esc(b.category)}</small></td><td>${esc(money(b.price))}</td><td>${integer(b.available_copies)} / ${integer(b.total_copies)}</td><td>${enabled(b.active) ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</td><td><a class="btn small alt" href="${esc(href('admin', { tab, page: info.page, edit: b.id }))}" aria-label="${esc(`แก้ไข ${b.title}`)}">แก้ไข</a></td></tr>`).join('')}</tbody></table></div>` : empty('ยังไม่มีหนังสือ', 'เพิ่มหนังสือเล่มแรกเพื่อเปิดชั้นหนังสือ')}${pagination(data, 'admin', { tab })}`;
  } else if (tab === 'users') {
    const q = info.params.get('q') || '';
    const data = await api(`/api/admin/users?${new URLSearchParams({ q, page: info.page })}`);
    body = `<form id="user-search" class="catalog-tools"><label class="field">ค้นหาสมาชิก<input name="q" type="search" value="${esc(q)}" maxlength="150" placeholder="ชื่อ หรืออีเมล"></label><button class="btn" type="submit">ค้นหา</button></form><p class="muted">ทั้งหมด ${integer(data.total)} คน · ไม่สามารถเปลี่ยนบทบาทหรือปิดบัญชีผู้ดูแล</p>${data.users.length ? `<div class="table-scroll"><table><caption>แก้ไขชื่อและสถานะสมาชิก</caption><thead><tr><th scope="col">สมาชิก</th><th scope="col">บทบาท / วันที่สมัคร</th><th scope="col">ข้อมูลและสถานะ</th></tr></thead><tbody>${data.users.map(u => `<tr><td>${esc(u.name)}<small>${esc(u.email)}</small></td><td>${u.role === 'admin' ? 'ผู้ดูแล' : 'สมาชิก'}<small>${esc(date(u.created_at))}</small></td><td><form class="form-stack user-form" data-id="${esc(u.id)}" data-role="${esc(u.role)}"><label class="field">ชื่อที่แสดง<input name="name" value="${esc(u.name)}" required maxlength="100"></label><label class="check"><input type="checkbox" name="active" ${enabled(u.active) ? 'checked' : ''} ${u.role === 'admin' ? 'disabled' : ''}>เปิดใช้งาน</label>${feedback()}<button class="btn small alt" type="submit">บันทึก</button></form></td></tr>`).join('')}</tbody></table></div>` : empty('ไม่พบสมาชิก', 'ลองค้นหาด้วยชื่อหรืออีเมลอื่น')}${pagination(data, 'admin', { tab, q })}`;
  } else if (tab === 'loans') {
    const data = await api(`/api/admin/loans?page=${info.page}`);
    body = `<h2>การยืม–คืน · ${integer(data.total)} รายการ</h2><div class="note">ยืนยันรับคืนเมื่อได้รับหนังสือจริงแล้วเท่านั้น สามารถยืนยันได้แม้สมาชิกยังไม่ได้ส่งคำขอ ระบบจะคืนจำนวนพร้อมให้ยืมหลังยืนยัน</div>${data.loans.length ? data.loans.map(l => loanCard(l, true)).join('') : empty('ยังไม่มีรายการยืม', 'รายการยืมของสมาชิกจะแสดงที่นี่')}${pagination(data, 'admin', { tab })}`;
  } else if (tab === 'categories') {
    const data = await api('/api/categories');
    body = `<div class="account-grid"><section class="panel"><h2>เพิ่มหมวดหมู่</h2><form id="category-form" class="form-stack"><label class="field">ชื่อหมวดหมู่<input name="name" required maxlength="100"></label>${feedback()}<button type="submit" class="btn">+ เพิ่มหมวดหมู่</button></form></section><section><h2>หมวดหมู่ทั้งหมด</h2>${data.categories.length ? `<ul>${data.categories.map(c => `<li>${esc(c.name)}</li>`).join('')}</ul>` : empty('ยังไม่มีหมวดหมู่', 'เพิ่มหมวดหมู่ก่อนสร้างหนังสือ')}</section></div>`;
  } else body = empty('ไม่พบเมนูนี้', 'เลือกเมนูผู้ดูแลที่ต้องการ');
  return header + body;
}

async function render() {
  const version = ++state.version;
  const info = routeInfo();
  nav();
  menu.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('is-open');
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = '<div class="loading" role="status">กำลังเปิดหน้าหนังสือ…</div>';
  let html;
  try {
    const protectedRoute = ['account', 'loans', 'admin'].includes(info.path);
    if (protectedRoute && state.authError) throw state.authError;
    if (protectedRoute && !state.user) {
      html = heading('MEMBERS ONLY', 'พื้นที่สำหรับสมาชิก') + '<p>เข้าสู่ระบบก่อนดูข้อมูลบัญชีและรายการยืมของคุณ</p><a class="btn orange" href="#login">เข้าสู่ระบบ</a>';
    } else if (info.path === 'admin' && state.user.role !== 'admin') {
      html = empty('ไม่มีสิทธิ์เข้าถึง', 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น');
    } else if (info.path === 'home') html = await home();
    else if (info.path === 'books') html = await books(info);
    else if (/^book\/[^/]+$/.test(info.path)) html = await bookDetail(decodeURIComponent(info.path.slice(5)));
    else if (info.path === 'register' || info.path === 'login') html = authPage(info.path === 'register');
    else if (info.path === 'account' || info.path === 'loans') html = await loansView(info, info.path === 'account');
    else if (info.path === 'admin') html = await adminView(info);
    else html = empty('หน้านี้ยังไม่มีเรื่องราว', 'กลับไปหน้าแรกหรือเลือกหนังสือจากเมนู');
  } catch (error) {
    if (version !== state.version) return;
    if (error.status === 401) {
      state.user = null;
      state.authError = null;
      nav();
      html = '<div class="note">เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง</div><a class="btn" href="#login">เข้าสู่ระบบ</a>';
    } else html = errorBox(error);
  }
  if (version !== state.version) return;
  main.innerHTML = (state.authError && !['account', 'loans', 'admin'].includes(info.path) ? `<div class="note" role="status">ตรวจสอบสมาชิกไม่ได้: ${esc(state.authError.message)} <button class="btn small alt" data-action="retry-auth">ตรวจสอบอีกครั้ง</button></div>` : '') + html;
  main.removeAttribute('aria-busy');
  document.title = `${({ home: 'พื้นที่ของหนังสือและคุณ', books: 'ชั้นหนังสือ', register: 'สมัครสมาชิก', login: 'เข้าสู่ระบบ', account: 'บัญชีของฉัน', loans: 'รายการยืมของฉัน', admin: 'พื้นที่จัดการ' })[info.path] || 'รายละเอียดหนังสือ'} | BOOKSPACE`;
}

function setBusy(form, busy) {
  form.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = busy; });
  form.setAttribute('aria-busy', String(busy));
}

async function submitForm(form) {
  if (form.dataset.busy === 'true' || !form.reportValidity()) return;
  const values = new FormData(form);
  const text = key => String(values.get(key) || '').trim();
  if (form.id === 'catalog-search' || form.id === 'user-search') {
    navigate(form.id === 'catalog-search' ? href('books', { q: text('q'), category: text('category') }) : href('admin', { tab: 'users', q: text('q') }));
    return;
  }
  const version = state.version;
  form.dataset.busy = 'true';
  setBusy(form, true);
  const output = form.querySelector('.form-feedback');
  if (output) output.hidden = true;
  try {
    if (['register', 'login'].includes(form.id)) {
      const body = { email: text('email'), password: String(values.get('password') || '') };
      if (form.id === 'register') body.name = text('name');
      const data = await api(`/api/auth/${form.id}`, { method: 'POST', body });
      state.user = data.user;
      state.authError = null;
      form.reset();
      notify(form.id === 'register' ? 'สมัครสมาชิกสำเร็จ ยินดีต้อนรับสู่ BOOKSPACE' : 'เข้าสู่ระบบสำเร็จ');
      nav();
      navigate('#account');
    } else if (form.id === 'account-form') {
      const data = await api('/api/account', { method: 'PATCH', body: { name: text('name') } });
      state.user = data.user;
      notify('บันทึกชื่อเรียบร้อย');
      nav();
    } else if (form.id === 'category-form') {
      await api('/api/admin/categories', { method: 'POST', body: { name: text('name') } });
      notify('เพิ่มหมวดหมู่เรียบร้อย');
      if (version === state.version) await render();
    } else if (form.id === 'book-form') {
      const body = { title: text('title'), author: text('author'), category_id: Number(text('category_id')), price: Number(text('price')), total_copies: Number(text('total_copies')), cover: text('cover'), description: text('description'), active: values.has('active') };
      if (!Number.isInteger(body.category_id) || body.category_id <= 0 || !Number.isInteger(body.total_copies) || body.total_copies < 0 || !Number.isFinite(body.price) || body.price < 0) throw new Error('กรุณาตรวจสอบหมวดหมู่ มูลค่า และจำนวนเล่ม');
      await api(form.dataset.id ? `/api/admin/books/${idPath(form.dataset.id)}` : '/api/admin/books', { method: form.dataset.id ? 'PUT' : 'POST', body });
      notify('บันทึกหนังสือเรียบร้อย');
      if (version === state.version) navigate(href('admin', { tab: 'books', page: routeInfo().page }));
    } else if (form.classList.contains('user-form')) {
      const body = { name: text('name'), active: form.dataset.role === 'admin' ? true : values.has('active') };
      await api(`/api/admin/users/${idPath(form.dataset.id)}`, { method: 'PATCH', body });
      if (state.user && String(state.user.id) === form.dataset.id) state.user.name = body.name;
      notify('บันทึกสมาชิกเรียบร้อย');
      if (version === state.version) await render();
    }
  } catch (error) {
    if (output && form.isConnected) {
      output.textContent = error.message;
      output.hidden = false;
      output.setAttribute('tabindex', '-1');
      output.focus();
    } else notify(error.message);
    if (error.status === 401) { state.user = null; nav(); }
  } finally {
    form.dataset.busy = 'false';
    setBusy(form, false);
  }
}

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Persist only opaque attempt keys, never account data or credentials.
function attempt(bookId) {
  const storageKey = `bookspace:p01:borrow:${state.user.id}:${bookId}`;
  let key = state.attempts.get(storageKey);
  if (!key) {
    try { key = sessionStorage.getItem(storageKey); } catch { /* Memory fallback when storage is blocked. */ }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key || '')) key = uuid();
    state.attempts.set(storageKey, key);
    try { sessionStorage.setItem(storageKey, key); } catch { /* The in-memory key still covers retries. */ }
  }
  return { key, clear() { state.attempts.delete(storageKey); try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be blocked. */ } } };
}

async function borrow(button) {
  if (!state.user) { navigate('#login'); return; }
  const bookId = button.dataset.id;
  const busyKey = `borrow:${state.user.id}:${bookId}`;
  if (state.busy.has(busyKey)) return;
  state.busy.add(busyKey);
  button.disabled = true;
  const version = state.version;
  let current;
  try {
    current = attempt(bookId);
    await api('/api/loans', { method: 'POST', headers: { 'Idempotency-Key': current.key }, body: { bookId: Number(bookId) } });
    current.clear();
    notify('ยืมหนังสือสำเร็จ ตรวจสอบวันกำหนดคืนได้ในรายการยืม');
    if (version === state.version) navigate('#loans');
  } catch (error) {
    const uncertain = !error.status || error.status >= 500 || [408, 425, 429].includes(error.status);
    if (!uncertain && current) current.clear();
    const output = document.getElementById('borrow-feedback');
    if (output && version === state.version) {
      output.innerHTML = `<div class="error-box" role="alert"><p>${esc(error.message)}</p><p>${uncertain ? 'ยังยืนยันผลไม่ได้ ปุ่มลองอีกครั้งจะใช้รหัสคำขอเดิมเพื่อป้องกันการยืมซ้ำ โปรดตรวจรายการยืมก่อนเริ่มคำขอใหม่' : 'แก้ไขเงื่อนไขตามข้อความ แล้วลองใหม่ได้'}</p><a href="#loans">ตรวจสอบรายการยืม →</a></div>`;
      button.textContent = uncertain ? 'ลองยืมอีกครั้ง (คำขอเดิม)' : 'ลองยืมอีกครั้ง';
    } else notify(error.message);
  } finally { state.busy.delete(busyKey); if (button.isConnected) button.disabled = false; }
}

async function action(button) {
  const name = button.dataset.action;
  if (name === 'borrow') { await borrow(button); return; }
  if (name === 'retry' || name === 'retry-auth') { await loadAuth(); await render(); return; }
  const key = `${name}:${button.dataset.id || ''}`;
  if (state.busy.has(key)) return;
  const version = state.version;
  if (name === 'confirm-return' && !confirm('ได้รับหนังสือเล่มจริงแล้วใช่หรือไม่? การยืนยันจะปิดรายการยืมและคืนจำนวนพร้อมให้ยืม')) return;
  if (name === 'request-return' && !confirm('แจ้งขอคืนหนังสือ? คุณยังต้องนำเล่มจริงมาคืน และรอผู้ดูแลยืนยัน รายการจึงจะเสร็จสมบูรณ์')) return;
  state.busy.add(key);
  button.disabled = true;
  try {
    if (name === 'logout') {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      state.user = null;
      state.authError = null;
      nav();
      navigate('#home');
      notify('ออกจากระบบแล้ว');
    } else if (name === 'request-return' || name === 'confirm-return') {
      await api(`${name === 'confirm-return' ? '/api/admin/loans' : '/api/loans'}/${idPath(button.dataset.id)}/return`, { method: 'POST', body: {} });
      notify(name === 'confirm-return' ? 'ยืนยันรับคืนหนังสือจริงแล้ว' : 'ส่งคำขอคืนแล้ว กรุณานำหนังสือจริงคืนเจ้าหน้าที่');
      if (version === state.version) await render();
    }
  } catch (error) {
    notify(error.message);
    if (error.status === 401) { state.user = null; nav(); if (version === state.version) await render(); }
  } finally { state.busy.delete(key); if (button.isConnected) button.disabled = false; }
}

menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); menu.focus();
  }
});
document.addEventListener('submit', event => {
  if (!(event.target instanceof HTMLFormElement)) return;
  event.preventDefault();
  submitForm(event.target);
});
document.addEventListener('click', event => {
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    main.focus();
    main.scrollIntoView();
    return;
  }
  const button = event.target.closest('button[data-action]');
  if (button && !button.disabled) action(button);
});
window.addEventListener('hashchange', () => {
  render();
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
});
(async () => { await loadAuth(); await render(); })();
