/**
 * VSAT – exam.js  v8.0  (Supabase Edition)
 *
 * ══ CẤU HÌNH SUPABASE — sửa 2 dòng bên dưới ══
 *   Lấy tại: Supabase Dashboard → Settings → API
 *
 * FIX & FEATURES:
 *   ✓ Bank + History lưu trên Supabase (PostgreSQL)
 *   ✓ Config vẫn giữ localStorage (per-device)
 *   ✓ Loading overlay khi gọi API
 *   ✓ Giữ nguyên toàn bộ logic thi / chấm điểm
 *
 * SCORING (6đ/câu, tối đa 150đ):
 *   MCQ     : đúng = 6đ, sai/bỏ = 0đ
 *   TF      : 1 đúng→1đ | 2→2đ | 3→3đ | 4→6đ
 *   Matching: floor(đúng/n × 6)
 *   Short   : đúng = 6đ, sai/bỏ = 0đ
 *
 * SQL SCHEMA — chạy 1 lần trong Supabase SQL Editor:
 * ─────────────────────────────────────────────────
 * create table questions (
 *   id          text primary key,
 *   subject     text not null,
 *   type        text not null,
 *   question    text not null,
 *   options     jsonb, statements jsonb,
 *   left_col    jsonb, right_col  jsonb,
 *   answers     jsonb, answer     text,
 *   placeholder text,
 *   created_at  timestamptz default now()
 * );
 * create table exam_history (
 *   id         text primary key,
 *   username   text, subject text,
 *   score int, possible int, total_q int, answered int, title text,
 *   created_at timestamptz default now()
 * );
 * alter table questions    enable row level security;
 * alter table exam_history enable row level security;
 * create policy "public_all" on questions    for all using (true) with check (true);
 * create policy "public_all" on exam_history for all using (true) with check (true);
 * ─────────────────────────────────────────────────
 */

// ══════════════════════════════════════════
//  ★ ĐỔI 2 DÒNG NÀY ★
// ══════════════════════════════════════════
const SUPABASE_URL = 'https://hksqqvkldguxwxqhqrbj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhrc3FxdmtsZGd1eHd4cWhxcmJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjIyMzQsImV4cCI6MjA4ODYzODIzNH0.BTvLT7zb1BkKRwK0c8ntE2tez1kuSpVkKVf_kCg5wXI';
// ══════════════════════════════════════════

// Khởi tạo client — nếu chưa cấu hình sẽ fallback sang localStorage
let sb = null;
let USE_SUPABASE = false;
try {
  if (SUPABASE_URL && !SUPABASE_URL.includes('xxxxxxxxxxxx') &&
      SUPABASE_KEY && !SUPABASE_KEY.includes('your_anon')) {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    USE_SUPABASE = true;
  }
} catch(e) {
  console.warn('Supabase init failed, using localStorage fallback:', e);
}

// ══════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════
const LS_CONFIG = 'vsat_config_v2';   // config vẫn giữ localStorage

const SUBJECTS = ['Toán','Ngữ Văn','Vật Lý','Hóa Học','Sinh Học','Lịch Sử','Địa Lý'];

const DEFAULT_CONFIG = { mcq: 6, truefalse: 9, short: 5, matching: 5, time: 90 };
// 6+9+5+5 = 25 câu × 6đ = 150đ max

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
let examData      = null;
let answers       = [];
let answerKey     = [];
let currentIdx    = 0;
let timerInterval = null;
let timeLeft      = 0;
let currentTheme  = 'real';
let studentInfo   = { username: '', subject: 'Toán' };

let currentSubject = 'Toán';   // môn đang xem trong dashboard
let bank           = [];        // ngân hàng của môn đang xem
let config         = { ...DEFAULT_CONFIG };
let bankEditIdx    = -1;

// ══════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function escH(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Để render LaTeX, KHÔNG escape — dùng hàm này cho nội dung câu hỏi/đáp án
function safe(s) { return String(s || ''); }

const pad   = n => String(n).padStart(2, '0');
const ALPHA = ['A','B','C','D','E','F','G','H'];

function typeFull(t) {
  return { mcq:'Trắc nghiệm', truefalse:'Đúng/Sai', short:'Trả lời ngắn', matching:'Ghép cột' }[t] || t;
}
function typeShort(t) {
  return { mcq:'TN', truefalse:'Đ/S', short:'TLN', matching:'Ghép' }[t] || t;
}

// ── MathJax render ──
function renderMath(container) {
  if (!window.MathJax) return;
  if (MathJax.typesetPromise) {
    MathJax.typesetPromise(container ? [container] : undefined).catch(e => console.warn('MathJax error:', e));
  } else if (MathJax.Hub) {
    MathJax.Hub.Queue(['Typeset', MathJax.Hub, container]);
  }
}

// ── Config (giữ localStorage — per device) ──
function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CONFIG));
    if (c) config = { ...DEFAULT_CONFIG, ...c };
  } catch {}
}
function saveConfig() { localStorage.setItem(LS_CONFIG, JSON.stringify(config)); }

// ══════════════════════════════════════════
//  LOCALSTORAGE FALLBACK HELPERS
// ══════════════════════════════════════════
const BANK_PREFIX = 'vsat_bank_';
const LS_HISTORY  = 'vsat_history_v2';

function _lsLoadBank(subject) {
  try { return JSON.parse(localStorage.getItem(BANK_PREFIX + subject)) || []; } catch { return []; }
}
function _lsSaveBank(subject, data) {
  localStorage.setItem(BANK_PREFIX + subject, JSON.stringify(data));
}
function _lsLoadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch { return []; }
}
function _lsSaveHistory(entries) {
  const hist = _lsLoadHistory();
  hist.unshift(entries[0]);
  localStorage.setItem(LS_HISTORY, JSON.stringify(hist.slice(0, 200)));
}
function _lsCountAll() {
  const counts = {};
  SUBJECTS.forEach(s => counts[s] = _lsLoadBank(s).length);
  return counts;
}

// ══════════════════════════════════════════
//  SUPABASE — BANK (bảng questions)
// ══════════════════════════════════════════

function dbRowToQ(row) {
  return {
    id:          row.id,
    type:        row.type,
    question:    row.question,
    options:     row.options     || undefined,
    statements:  row.statements  || undefined,
    left:        row.left_col    || undefined,
    right:       row.right_col   || undefined,
    answers:     row.answers     || undefined,
    answer:      row.answer != null
                   ? (row.type === 'mcq' ? Number(row.answer) : row.answer)
                   : undefined,
    placeholder: row.placeholder || undefined,
  };
}

function qToDbRow(q, subject) {
  return {
    id:          q.id,
    subject:     subject,
    type:        q.type,
    question:    q.question,
    options:     q.options     || null,
    statements:  q.statements  || null,
    left_col:    q.left        || null,
    right_col:   q.right       || null,
    answers:     q.answers     || null,
    answer:      (q.answer !== null && q.answer !== undefined) ? String(q.answer) : null,
    placeholder: q.placeholder || null,
  };
}

async function loadBank(subject) {
  if (!USE_SUPABASE) return _lsLoadBank(subject);
  const { data, error } = await sb
    .from('questions').select('*').eq('subject', subject)
    .order('created_at', { ascending: true });
  if (error) { console.error('loadBank:', error); return _lsLoadBank(subject); }
  return (data || []).map(dbRowToQ);
}

async function saveBank(subject, data) {
  if (!USE_SUPABASE) { _lsSaveBank(subject, data || bank); return; }
  const rows = (data || bank).map(q => qToDbRow(q, subject || currentSubject));
  await sb.from('questions').delete().eq('subject', subject || currentSubject);
  if (rows.length > 0) {
    const { error } = await sb.from('questions').insert(rows);
    if (error) { console.error('saveBank:', error); showToast('⚠️ Lỗi lưu: ' + error.message, true); }
  }
  // Sync localStorage backup
  _lsSaveBank(subject || currentSubject, data || bank);
}

async function saveSingleQuestion(q, subject) {
  if (!USE_SUPABASE) { _lsSaveBank(subject || currentSubject, bank); return; }
  const { error } = await sb.from('questions')
    .upsert(qToDbRow(q, subject || currentSubject), { onConflict: 'id' });
  if (error) { console.error('saveSingleQ:', error); showToast('⚠️ Lỗi lưu câu hỏi: ' + error.message, true); }
}

async function deleteSingleQuestion(id) {
  if (!USE_SUPABASE) return;
  const { error } = await sb.from('questions').delete().eq('id', id);
  if (error) { console.error('deleteQ:', error); showToast('⚠️ Lỗi xóa: ' + error.message, true); }
}

async function loadAllSubjectCounts() {
  if (!USE_SUPABASE) return _lsCountAll();
  const { data, error } = await sb.from('questions').select('subject');
  if (error) { console.error('countSubjects:', error); return _lsCountAll(); }
  const counts = {};
  SUBJECTS.forEach(s => counts[s] = 0);
  (data || []).forEach(r => { if (counts[r.subject] !== undefined) counts[r.subject]++; });
  return counts;
}

// ══════════════════════════════════════════
//  SUPABASE — HISTORY (bảng exam_history)
// ══════════════════════════════════════════

async function loadHistory() {
  if (!USE_SUPABASE) return _lsLoadHistory();
  const { data, error } = await sb
    .from('exam_history').select('*')
    .order('created_at', { ascending: false }).limit(200);
  if (error) { console.error('loadHistory:', error); return _lsLoadHistory(); }
  return (data || []).map(r => ({
    id: r.id, date: r.created_at,
    username: r.username, subject: r.subject,
    score: r.score, possible: r.possible,
    totalQ: r.total_q, answered: r.answered, title: r.title,
  }));
}

async function saveHistory(entries) {
  if (!USE_SUPABASE) { _lsSaveHistory(entries); return; }
  if (!entries.length) return;
  const e = entries[0];
  const { error } = await sb.from('exam_history').insert({
    id: e.id, username: e.username, subject: e.subject,
    score: e.score, possible: e.possible,
    total_q: e.totalQ, answered: e.answered, title: e.title,
  });
  if (error) console.error('saveHistory:', error);
}
function showLoading(msg = 'Đang tải...') {
  let el = document.getElementById('vsat-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vsat-loading';
    el.innerHTML = `<div class="vl-box"><div class="vl-spinner"></div><span class="vl-msg"></span></div>`;
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9000;backdrop-filter:blur(3px)';
    const style = document.createElement('style');
    style.textContent = `.vl-box{background:var(--content-bg,#fff);border-radius:10px;padding:1.4rem 2rem;display:flex;flex-direction:column;align-items:center;gap:.75rem;box-shadow:0 8px 40px rgba(0,0,0,.3)}.vl-msg{font-size:.88rem;font-weight:600;color:var(--text,#1a202c);font-family:var(--sans,sans-serif)}.vl-spinner{width:30px;height:30px;border:3px solid var(--border,#dde1e7);border-top-color:var(--accent,#17b8c8);border-radius:50%;animation:vspin .7s linear infinite}@keyframes vspin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(style);
    document.body.appendChild(el);
  }
  el.querySelector('.vl-msg').textContent = msg;
  el.style.display = 'flex';
}
function hideLoading() {
  const el = document.getElementById('vsat-loading');
  if (el) el.style.display = 'none';
}

// ══════════════════════════════════════════
//  SUPABASE — BANK (bảng questions)
// ══════════════════════════════════════════

/** Chuyển DB row → app question object */
function dbRowToQ(row) {
  return {
    id:          row.id,
    type:        row.type,
    question:    row.question,
    options:     row.options     || undefined,
    statements:  row.statements  || undefined,
    left:        row.left_col    || undefined,
    right:       row.right_col   || undefined,
    answers:     row.answers     || undefined,
    answer:      row.answer != null
                   ? (row.type === 'mcq' ? Number(row.answer) : row.answer)
                   : undefined,
    placeholder: row.placeholder || undefined,
  };
}

/** Chuyển app question object → DB row */
function qToDbRow(q, subject) {
  return {
    id:          q.id,
    subject:     subject,
    type:        q.type,
    question:    q.question,
    options:     q.options     || null,
    statements:  q.statements  || null,
    left_col:    q.left        || null,
    right_col:   q.right       || null,
    answers:     q.answers     || null,
    answer:      (q.answer !== null && q.answer !== undefined) ? String(q.answer) : null,
    placeholder: q.placeholder || null,
  };
}

/** Lấy toàn bộ câu hỏi 1 môn */
async function loadBank(subject) {
  const { data, error } = await sb
    .from('questions')
    .select('*')
    .eq('subject', subject)
    .order('created_at', { ascending: true });
  if (error) { console.error('loadBank:', error); return []; }
  return (data || []).map(dbRowToQ);
}

// ══════════════════════════════════════════
//  SUPABASE — HISTORY (bảng exam_history)
// ══════════════════════════════════════════

async function loadHistory() {
  const { data, error } = await sb
    .from('exam_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) { console.error('loadHistory:', error); return []; }
  return (data || []).map(r => ({
    id:       r.id,
    date:     r.created_at,
    username: r.username,
    subject:  r.subject,
    score:    r.score,
    possible: r.possible,
    totalQ:   r.total_q,
    answered: r.answered,
    title:    r.title,
  }));
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  loadConfig();

  showLoading('Đang kết nối Supabase...');
  try {
    bank = await loadBank(currentSubject);
  } catch(e) {
    console.error(e);
    showToast('⚠️ Không kết nối được Supabase. Kiểm tra URL / Key.', true);
  }
  hideLoading();

  // Dashboard nav
  document.querySelectorAll('.dnav').forEach(btn =>
    btn.addEventListener('click', () => switchDashPanel(btn.dataset.panel))
  );
  document.getElementById('dash-start-btn').addEventListener('click', gotoLogin);

  // Format guide toggle
  document.getElementById('fg-toggle').addEventListener('click', () => {
    const body = document.getElementById('fg-body');
    body.classList.toggle('hidden');
    document.getElementById('fg-toggle').classList.toggle('open', !body.classList.contains('hidden'));
  });

  // Bank panel
  document.getElementById('bank-import-btn').addEventListener('click', () =>
    document.getElementById('bank-file-input').click()
  );
  document.getElementById('bank-file-input').addEventListener('change', handleBankImport);
  document.getElementById('bank-clear-btn').addEventListener('click', clearBank);
  document.getElementById('bank-filter-type').addEventListener('change', renderBankList);
  document.getElementById('bank-search').addEventListener('input', renderBankList);

  // Subject tabs in dashboard
  buildSubjectTabs();

  // Config panel
  ['cfg-mcq','cfg-tf','cfg-short','cfg-match'].forEach(id =>
    document.getElementById(id).addEventListener('input', updateConfigTotal)
  );
  document.getElementById('config-save-btn').addEventListener('click', saveConfigFromUI);

  // History
  document.getElementById('hist-clear-btn').addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ lịch sử làm bài?')) return;
    showLoading('Đang xóa...');
    if (USE_SUPABASE) {
      await sb.from('exam_history').delete().neq('id', '__never__');
    } else {
      localStorage.removeItem(LS_HISTORY);
    }
    hideLoading();
    renderHistory();
  });

  // Bank edit modal
  document.getElementById('bank-edit-close').addEventListener('click', closeBankEdit);
  document.getElementById('bank-edit-cancel').addEventListener('click', closeBankEdit);
  document.getElementById('bank-edit-save').addEventListener('click', saveBankEdit);

  // Login
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('file-input-login').addEventListener('change', handleFileInputLogin);
  document.getElementById('back-to-dash-btn').addEventListener('click', () => showScreen('dashboard-screen'));
  document.getElementById('login-subject').addEventListener('change', () => updateLoginBadge());

  // Exam
  document.getElementById('submit-btn-top').addEventListener('click', openSubmitModal);
  document.getElementById('modal-cancel').addEventListener('click', closeSubmitModal);
  document.getElementById('modal-confirm').addEventListener('click', submitExam);
  document.getElementById('prev-btn').addEventListener('click', () => navigateDot(-1));
  document.getElementById('next-btn').addEventListener('click', () => navigateDot(1));
  document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);

  // Result
  document.getElementById('restart-btn').addEventListener('click', gotoLogin);
  document.getElementById('goto-dash-btn').addEventListener('click', gotoDashboard);
  document.getElementById('btn-show-answers').addEventListener('click', toggleAnswerDisplay);
  document.getElementById('adp-close').addEventListener('click', toggleAnswerDisplay);
  document.getElementById('btn-edit-answers').addEventListener('click', openAnswerEditor);
  document.getElementById('answer-editor-close').addEventListener('click', closeAnswerEditor);
  document.getElementById('answer-editor-cancel').addEventListener('click', closeAnswerEditor);
  document.getElementById('answer-editor-save').addEventListener('click', saveAnswerKey);

  renderBankList();
  renderConfigTab();
  renderHistory();
});

// ══════════════════════════════════════════
//  SUBJECT TABS IN DASHBOARD
// ══════════════════════════════════════════
async function buildSubjectTabs() {
  // Đếm câu hỏi tất cả môn từ Supabase
  const counts = await loadAllSubjectCounts();

  const panelBank = document.getElementById('panel-bank');
  if (!panelBank) return;

  let tabBar = document.getElementById('subject-tab-bar');
  if (!tabBar) {
    tabBar = document.createElement('div');
    tabBar.id = 'subject-tab-bar';
    tabBar.style.cssText = 'display:flex;gap:.3rem;flex-wrap:wrap;padding:.5rem 0 .8rem;border-bottom:1px solid var(--border);margin-bottom:.9rem;';
    panelBank.insertBefore(tabBar, panelBank.firstChild);
  }

  tabBar.innerHTML = SUBJECTS.map(s => {
    const cnt = counts[s] || 0;
    const isActive = s === currentSubject;
    return `<button class="subj-tab ${isActive ? 'active' : ''}" data-subject="${s}"
      style="background:${isActive ? 'var(--accent)' : 'var(--q-alt-bg)'};
             color:${isActive ? '#fff' : 'var(--text-muted)'};
             border:1.5px solid ${isActive ? 'var(--accent)' : 'var(--border)'};
             font-family:var(--sans);font-size:.78rem;font-weight:600;
             padding:.32rem .75rem;border-radius:99px;cursor:pointer;
             transition:all .15s;white-space:nowrap;">
      ${s} <span style="font-family:var(--mono);font-size:.7rem;opacity:.8">(${cnt})</span>
    </button>`;
  }).join('');

  tabBar.querySelectorAll('.subj-tab').forEach(btn =>
    btn.addEventListener('click', () => switchSubject(btn.dataset.subject))
  );
}

async function switchSubject(subject) {
  currentSubject = subject;
  showLoading(`Đang tải ngân hàng ${subject}...`);
  bank = await loadBank(subject);
  hideLoading();
  buildSubjectTabs();
  renderBankList();
  renderConfigTab();
}

// ══════════════════════════════════════════
//  THEME
// ══════════════════════════════════════════
function toggleTheme() {
  currentTheme = currentTheme === 'real' ? 'galaxy' : 'real';
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.getElementById('theme-icon').textContent  = currentTheme === 'galaxy' ? '🌞' : '🌌';
  document.getElementById('theme-label').textContent = currentTheme === 'galaxy' ? 'Thi thật' : 'Galaxy';
}

// ══════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'exam-screen') setTimeout(initScrollObserver, 150);
}

function switchDashPanel(panelId) {
  document.querySelectorAll('.dnav').forEach(b => b.classList.toggle('active', b.dataset.panel === panelId));
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.toggle('active', p.id === panelId));
  if (panelId === 'panel-config')  renderConfigTab();
  if (panelId === 'panel-history') renderHistory();
}

async function gotoLogin() {
  await updateLoginBadge();
  showScreen('login-screen');
  const code = 'VKOD' + Math.floor(10000 + Math.random() * 90000);
  const pass = String(Math.floor(10000000 + Math.random() * 90000000));
  document.getElementById('info-account').textContent  = code;
  document.getElementById('info-password').textContent = pass;
  document.getElementById('login-username').value = code;
  document.getElementById('draw-error').classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
}

async function gotoDashboard() {
  clearInterval(timerInterval);
  examData = null; answers = []; answerKey = []; currentIdx = 0;
  showLoading('Đang tải...');
  bank = await loadBank(currentSubject);
  hideLoading();
  buildSubjectTabs();
  renderBankList();
  renderHistory();
  showScreen('dashboard-screen');
}

async function updateLoginBadge() {
  const subject = document.getElementById('login-subject')?.value || studentInfo.subject || 'Toán';
  const badge = document.getElementById('bank-status-badge');
  let data;
  if (USE_SUPABASE) {
    const res = await sb.from('questions').select('type').eq('subject', subject);
    data = res.data;
  } else {
    data = _lsLoadBank(subject);
  }
  if (!data || !data.length) { badge.classList.add('hidden'); return; }
  const c = { mcq: 0, truefalse: 0, short: 0, matching: 0 };
  data.forEach(r => { if (c[r.type] !== undefined) c[r.type]++; });
  badge.classList.remove('hidden');
  badge.innerHTML = `📚 Ngân hàng <b>${subject}</b>: <b>${data.length}</b> câu &nbsp;·&nbsp; TN:<b>${c.mcq}</b> &nbsp;Đ/S:<b>${c.truefalse}</b> &nbsp;TLN:<b>${c.short}</b> &nbsp;Ghép:<b>${c.matching}</b>`;
}

function countByType(bankArr) {
  const arr = bankArr || bank;
  const c = { mcq: 0, truefalse: 0, short: 0, matching: 0 };
  arr.forEach(q => { if (c[q.type] !== undefined) c[q.type]++; });
  return c;
}

// ══════════════════════════════════════════
//  LOGIN / FILE INPUT
// ══════════════════════════════════════════
async function handleLogin() {
  const user    = document.getElementById('login-username').value.trim();
  const pass    = document.getElementById('login-password').value.trim();
  const subject = document.getElementById('login-subject').value;
  const errEl   = document.getElementById('login-error');
  const drawErr = document.getElementById('draw-error');

  drawErr.classList.add('hidden');
  if (!user || !pass) {
    errEl.classList.remove('hidden');
    setTimeout(() => errEl.classList.add('hidden'), 3000);
    return;
  }
  errEl.classList.add('hidden');
  studentInfo = { username: user, subject };

  showLoading(`Đang bốc đề ${subject}...`);
  const subjectBank = await loadBank(subject);
  hideLoading();

  const drawn = drawFromBank(subjectBank);

  if (drawn === null) {
    drawErr.textContent = `⚠️ Ngân hàng môn "${subject}" chưa có câu hỏi. Vui lòng vào Dashboard để nhập đề.`;
    drawErr.classList.remove('hidden');
    return;
  }
  if (drawn.error) {
    drawErr.textContent = drawn.error;
    drawErr.classList.remove('hidden');
    return;
  }
  startExam({
    title: `${subject} – ${user} – ${new Date().toLocaleDateString('vi-VN')}`,
    time: config.time,
    questions: drawn
  });
}

function handleFileInputLogin(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      validateExamJSON(data);
      studentInfo = {
        username: document.getElementById('login-username').value.trim() || 'GUEST',
        subject:  document.getElementById('login-subject').value
      };
      startExam(data);
    } catch(err) {
      const el = document.getElementById('import-error');
      el.textContent = 'Lỗi file: ' + err.message; el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 6000);
    }
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
}

function validateExamJSON(data) {
  if (!data.title)   throw new Error("Thiếu 'title'.");
  if (!data.time)    throw new Error("Thiếu 'time'.");
  if (!Array.isArray(data.questions) || !data.questions.length)
    throw new Error("'questions' trống hoặc không hợp lệ.");
  const valid = ['truefalse','mcq','matching','short'];
  data.questions.forEach((q, i) => {
    if (!valid.includes(q.type)) throw new Error(`Câu ${i+1}: type '${q.type}' không hợp lệ.`);
    if (!q.question)             throw new Error(`Câu ${i+1}: thiếu 'question'.`);
  });
}

// ══════════════════════════════════════════
//  BANK DRAW (từ ngân hàng đã chọn)
// ══════════════════════════════════════════
function drawFromBank(subjectBank) {
  const b = subjectBank || bank;
  if (!b.length) return null;  // trống

  const byType = { mcq: [], truefalse: [], short: [], matching: [] };
  b.forEach(q => { if (byType[q.type]) byType[q.type].push(q); });

  const need = { mcq: config.mcq, truefalse: config.truefalse, short: config.short, matching: config.matching };
  const errors = [];
  Object.entries(need).forEach(([type, n]) => {
    if (n > 0 && byType[type].length < n)
      errors.push(`${typeFull(type)}: cần ${n}, có ${byType[type].length}`);
  });
  if (errors.length) return { error: '⚠️ Không đủ câu: ' + errors.join('; ') };

  const shuffle = arr => [...arr].sort(() => Math.random() - .5);
  let qs = [];
  ['truefalse','mcq','matching','short'].forEach(t => {
    if (need[t] > 0) qs.push(...shuffle(byType[t]).slice(0, need[t]));
  });
  return shuffle(qs);
}

// ══════════════════════════════════════════
//  START EXAM
// ══════════════════════════════════════════
function startExam(data) {
  examData   = data;
  currentIdx = 0;

  answers = data.questions.map(q => {
    if (q.type === 'truefalse') return new Array(q.statements.length).fill(null);
    if (q.type === 'matching')  return new Array(q.left.length).fill(null);
    return null;
  });

  answerKey = data.questions.map(q => {
    if (q.type === 'truefalse') {
      if (Array.isArray(q.answers) && q.answers.every(v => v === 'D' || v === 'S'))
        return [...q.answers];
      return new Array(q.statements.length).fill(null);
    }
    if (q.type === 'matching') {
      if (Array.isArray(q.answers) && q.answers.length === q.left.length)
        return [...q.answers];
      return new Array(q.left.length).fill(null);
    }
    if (q.type === 'mcq')
      return (q.answer !== undefined && q.answer !== null) ? Number(q.answer) : null;
    if (q.type === 'short')
      return (q.answer !== undefined && q.answer !== null) ? String(q.answer).trim() : null;
    return null;
  });

  document.getElementById('exam-title').textContent = data.title;
  timeLeft = data.time * 60;
  updateTimerDisplay();
  startTimer();
  renderAllQuestions();
  buildBottomDots();
  showScreen('exam-screen');
  scrollToQuestion(0);
}

// ══════════════════════════════════════════
//  RENDER QUESTIONS  (dùng innerHTML với LaTeX pass-through)
// ══════════════════════════════════════════
function renderAllQuestions() {
  const body = document.getElementById('exam-body');
  body.innerHTML = '';
  examData.questions.forEach((q, i) => {
    const block = document.createElement('div');
    block.className = 'question-block';
    block.id = `q-block-${i}`;
    block.innerHTML = `
      <div class="q-block-header">
        <span class="q-block-title">Câu ${i+1}
          <span style="font-size:.7rem;opacity:.75;font-weight:400">[${typeFull(q.type)}]</span>
        </span>
        <button class="q-pin-btn" data-idx="${i}">📌</button>
      </div>
      <div class="q-block-body">
        <div class="q-text">${safe(q.question)}</div>
        ${buildAnswerHTML(q, i)}
      </div>`;
    body.appendChild(block);
  });

  examData.questions.forEach((q, i) => {
    if (q.type === 'truefalse') attachTFListeners(i);
    if (q.type === 'mcq')       attachMCQListeners(i);
    if (q.type === 'matching')  attachMatchingListeners(i);
    if (q.type === 'short')     attachShortListeners(i);
    document.querySelector(`.q-pin-btn[data-idx="${i}"]`).addEventListener('click', () => togglePin(i));
  });

  // Render LaTeX cho toàn bộ exam body
  renderMath(body);
}

function buildAnswerHTML(q, i) {
  if (q.type === 'truefalse') return buildTFHTML(q, i);
  if (q.type === 'mcq')       return buildMCQHTML(q, i);
  if (q.type === 'matching')  return buildMatchingHTML(q, i);
  if (q.type === 'short')     return buildShortHTML(q, i);
  return '';
}

/* ── TRUE/FALSE ── */
function buildTFHTML(q, i) {
  const rows = q.statements.map((s, si) => {
    const dC = answers[i]?.[si] === 'D' ? 'checked' : '';
    const sC = answers[i]?.[si] === 'S' ? 'checked' : '';
    return `<tr>
      <td class="tf-cell">
        <input type="radio" class="tf-radio" name="tf_${i}_${si}" id="tf${i}_${si}_D"
          data-si="${si}" data-val="D" ${dC}/>
        <label class="tf-label" for="tf${i}_${si}_D"></label>
      </td>
      <td class="tf-cell">
        <input type="radio" class="tf-radio" name="tf_${i}_${si}" id="tf${i}_${si}_S"
          data-si="${si}" data-val="S" ${sC}/>
        <label class="tf-label" for="tf${i}_${si}_S"></label>
      </td>
      <td class="tf-stmt">${safe(s)}</td>
    </tr>`;
  }).join('');
  return `<table class="tf-table">
    <thead><tr><th>Đúng</th><th>Sai</th><th>Mệnh đề</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
function attachTFListeners(i) {
  document.getElementById(`q-block-${i}`).querySelectorAll('.tf-radio').forEach(r => {
    r.addEventListener('change', () => {
      if (!answers[i]) answers[i] = new Array(examData.questions[i].statements.length).fill(null);
      answers[i][+r.dataset.si] = r.dataset.val;
      updateDot(i);
    });
  });
}

/* ── MCQ ── */
function buildMCQHTML(q, i) {
  return `<div class="mcq-options">${
    q.options.map((opt, oi) => {
      const sel = answers[i] === String(oi) ? 'selected' : '';
      return `<input type="radio" class="mcq-option" name="mcq_${i}" value="${oi}" ${sel ? 'checked' : ''}/>
      <div class="mcq-row ${sel}" data-qi="${i}" data-oi="${oi}">
        <div class="mcq-radio-wrap"><div class="mcq-circle"></div></div>
        <div class="mcq-text-wrap">${ALPHA[oi]}. ${safe(opt)}</div>
      </div>`;
    }).join('')
  }</div>`;
}
function attachMCQListeners(i) {
  document.getElementById(`q-block-${i}`).querySelectorAll('.mcq-row').forEach(row => {
    row.addEventListener('click', () => {
      answers[i] = String(row.dataset.oi);
      document.getElementById(`q-block-${i}`).querySelectorAll('.mcq-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      updateDot(i);
    });
  });
}

/* ── MATCHING ── */
function buildMatchingHTML(q, i) {
  const leftRows  = q.left.map((it, li) =>
    `<tr><td class="match-idx">${li+1}.</td><td>${safe(it)}</td></tr>`).join('');
  const rightRows = q.right.map((it, ri) =>
    `<tr><td class="match-key">${ALPHA[ri]}.</td><td>${safe(it)}</td></tr>`).join('');
  const sels = q.left.map((_, li) => {
    const sv = answers[i]?.[li] != null ? answers[i][li] : '';
    let opts = `<option value="">Chọn</option>`;
    q.right.forEach((_, ri) =>
      opts += `<option value="${ri}" ${String(ri) === String(sv) ? 'selected' : ''}>${ALPHA[ri]}</option>`);
    return `<div class="match-label-item">
      <span class="match-label-text">Ý ${li+1}:</span>
      <select class="match-select ${sv !== '' ? 'selected' : ''}" data-li="${li}">${opts}</select>
    </div>`;
  }).join('');
  return `
    <div class="matching-tables">
      <div class="match-col">
        <div class="match-col-title">Cột trái</div>
        <table class="match-table"><tbody>${leftRows}</tbody></table>
      </div>
      <div class="match-col">
        <div class="match-col-title">Cột phải</div>
        <table class="match-table"><tbody>${rightRows}</tbody></table>
      </div>
    </div>
    <div class="matching-answer-section">
      <div class="matching-answer-label">Trả lời:</div>
      <div class="matching-selects">${sels}</div>
    </div>`;
}
function attachMatchingListeners(i) {
  document.getElementById(`q-block-${i}`).querySelectorAll('.match-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const li = +sel.dataset.li;
      if (!answers[i]) answers[i] = new Array(examData.questions[i].left.length).fill(null);
      answers[i][li] = sel.value !== '' ? +sel.value : null;
      sel.className = sel.value !== '' ? 'match-select selected' : 'match-select';
      updateDot(i);
    });
  });
}

/* ── SHORT ── */
function buildShortHTML(q, i) {
  const val = answers[i] != null ? String(answers[i]) : '';
  return `<div class="short-wrap"><div class="short-row">
    <span class="short-row-label">Trả lời:</span>
    <input type="text" class="short-input" id="short_${i}"
      value="${escH(val)}" placeholder="${escH(q.placeholder || 'Nhập câu trả lời...')}" autocomplete="off"/>
  </div></div>`;
}
function attachShortListeners(i) {
  const inp = document.getElementById(`short_${i}`);
  if (inp) inp.addEventListener('input', () => { answers[i] = inp.value; updateDot(i); });
}

// PIN
const pinnedSet = new Set();
function togglePin(i) {
  const btn = document.querySelector(`.q-pin-btn[data-idx="${i}"]`);
  pinnedSet.has(i) ? (pinnedSet.delete(i), btn.classList.remove('pinned'))
                   : (pinnedSet.add(i),    btn.classList.add('pinned'));
}

// ══════════════════════════════════════════
//  BOTTOM DOTS
// ══════════════════════════════════════════
function buildBottomDots() {
  const c = document.getElementById('bottom-dots'); c.innerHTML = '';
  examData.questions.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'b-dot' + (i === 0 ? ' current' : '');
    d.textContent = i + 1; d.id = `bdot-${i}`;
    d.addEventListener('click', () => scrollToQuestion(i));
    c.appendChild(d);
  });
  updateNavBtns();
}
function updateDot(i) {
  const d = document.getElementById(`bdot-${i}`); if (!d) return;
  isAnswered(i) ? d.classList.add('answered') : d.classList.remove('answered');
}
function highlightCurrentDot() {
  document.querySelectorAll('.b-dot').forEach((d, i) => d.classList.toggle('current', i === currentIdx));
  const cur = document.getElementById(`bdot-${currentIdx}`);
  if (cur) cur.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  updateNavBtns();
}
function updateNavBtns() {
  if (!examData) return;
  document.getElementById('prev-btn').disabled = currentIdx === 0;
  document.getElementById('next-btn').disabled = currentIdx === examData.questions.length - 1;
}
function scrollToQuestion(i) {
  currentIdx = i;
  const b = document.getElementById(`q-block-${i}`);
  if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' });
  highlightCurrentDot();
}
function navigateDot(dir) {
  const n = currentIdx + dir;
  if (n >= 0 && n < examData.questions.length) scrollToQuestion(n);
}
function initScrollObserver() {
  if (!('IntersectionObserver' in window)) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > 0.25) {
        const m = e.target.id.match(/^q-block-(\d+)$/);
        if (m && +m[1] !== currentIdx) { currentIdx = +m[1]; highlightCurrentDot(); }
      }
    });
  }, { threshold: 0.25, rootMargin: '-46px 0px -50px 0px' });
  document.querySelectorAll('.question-block').forEach(b => obs.observe(b));
}

// ══════════════════════════════════════════
//  TIMER
// ══════════════════════════════════════════
function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) { clearInterval(timerInterval); submitExam(); }
  }, 1000);
}
function updateTimerDisplay() {
  const m = Math.floor(timeLeft / 60), s = timeLeft % 60;
  const box = document.getElementById('timer-box');
  box.textContent = `${pad(m)}:${pad(s)}`;
  box.classList.remove('warning','danger');
  if      (timeLeft <= 60)  box.classList.add('danger');
  else if (timeLeft <= 300) box.classList.add('warning');
}

// ══════════════════════════════════════════
//  SUBMIT
// ══════════════════════════════════════════
function openSubmitModal() {
  const ua = answers.filter((_, i) => !isAnswered(i)).length;
  document.getElementById('modal-message').innerHTML = ua === 0
    ? 'Bạn đã trả lời tất cả câu. Xác nhận nộp bài?'
    : `Còn <strong>${ua}</strong> câu chưa trả lời. Bạn có chắc muốn nộp không?`;
  document.getElementById('submit-modal').classList.remove('hidden');
}
function closeSubmitModal() { document.getElementById('submit-modal').classList.add('hidden'); }
function submitExam() { clearInterval(timerInterval); closeSubmitModal(); showResults(); }

// ══════════════════════════════════════════
//  SCORING  — tối đa 150đ (25 câu × 6đ)
// ══════════════════════════════════════════
function calcScore(q, studentAns, keyAns) {
  if (q.type === 'truefalse') {
    if (!Array.isArray(keyAns)) return null;
    if (!keyAns.some(v => v === 'D' || v === 'S')) return null;
    const n = keyAns.length;
    let correct = 0;
    for (let si = 0; si < n; si++) {
      const student = Array.isArray(studentAns) ? studentAns[si] : null;
      if (student !== null && student !== undefined && student === keyAns[si]) correct++;
    }
    if (correct === n) return 6;
    if (correct === 3) return 3;
    if (correct === 2) return 2;
    if (correct === 1) return 1;
    return 0;
  }
  if (q.type === 'mcq') {
    if (keyAns === null || keyAns === undefined) return null;
    if (studentAns === null || studentAns === undefined) return 0;
    return Number(studentAns) === Number(keyAns) ? 6 : 0;
  }
  if (q.type === 'matching') {
    if (!Array.isArray(keyAns) || !keyAns.some(v => v !== null && v !== undefined)) return null;
    if (!Array.isArray(studentAns)) return 0;
    const n = keyAns.length;
    let correct = 0;
    for (let li = 0; li < n; li++) {
      if (studentAns[li] !== null && studentAns[li] !== undefined &&
          keyAns[li]     !== null && keyAns[li]     !== undefined &&
          Number(studentAns[li]) === Number(keyAns[li])) correct++;
    }
    return Math.floor((correct / n) * 6);
  }
  if (q.type === 'short') {
    if (keyAns === null || keyAns === undefined || String(keyAns).trim() === '') return null;
    if (studentAns === null || studentAns === undefined) return 0;
    const g = String(studentAns).trim().toLowerCase().replace(/,/g, '.');
    const e = String(keyAns).trim().toLowerCase().replace(/,/g, '.');
    return g === e ? 6 : 0;
  }
  return 0;
}

function hasAnyKey() {
  return answerKey.some(k => {
    if (k === null || k === undefined) return false;
    if (Array.isArray(k)) return k.some(v => v === 'D' || v === 'S' || (v !== null && v !== undefined));
    if (typeof k === 'string') return k.trim() !== '';
    return true;
  });
}

// ══════════════════════════════════════════
//  RESULTS
// ══════════════════════════════════════════
async function showResults() {
  document.getElementById('result-sbd').textContent     = studentInfo.username || 'GUEST';
  document.getElementById('result-subject').textContent = studentInfo.subject  || 'Toán';
  const answered = answers.filter((_, i) => isAnswered(i)).length;
  document.getElementById('result-answered').textContent = answered;
  document.getElementById('result-total').textContent    = examData.questions.length;
  document.getElementById('answer-display-panel').classList.add('hidden');
  renderScore();

  let total = 0, possible = 0;
  examData.questions.forEach((q, i) => {
    const pts = calcScore(q, answers[i], answerKey[i]);
    if (pts !== null) { total += pts; possible += 6; }
  });

  // Lưu lịch sử lên Supabase (không block UI)
  saveHistory([{
    id: uid(),
    date: new Date().toISOString(),
    username: studentInfo.username,
    subject: studentInfo.subject,
    score: total, possible,
    totalQ: examData.questions.length,
    answered, title: examData.title
  }]);

  showScreen('result-screen');
}

function renderScore() {
  let total = 0;
  examData.questions.forEach((q, i) => {
    const pts = calcScore(q, answers[i], answerKey[i]);
    if (pts !== null) total += pts;
  });
  const maxPts = examData.questions.length * 6;  // 25×6 = 150
  document.getElementById('result-score').textContent =
    hasAnyKey() ? `${total} / ${maxPts} điểm` : '– (chưa có đáp án)';
}

// ══════════════════════════════════════════
//  ANSWER DISPLAY PANEL
// ══════════════════════════════════════════
function toggleAnswerDisplay() {
  const panel = document.getElementById('answer-display-panel');
  const hide  = panel.classList.toggle('hidden');
  document.getElementById('btn-show-answers').classList.toggle('active-toggle', !hide);
  if (!hide) renderAnswerDisplay();
}

function renderAnswerDisplay() {
  document.getElementById('adp-body').innerHTML = examData.questions.map((q, i) => {
    const k = answerKey[i];
    let keyText = '';
    if (q.type === 'mcq')
      keyText = (k !== null && k !== undefined) ? ALPHA[Number(k)] : '–';
    else if (q.type === 'truefalse')
      keyText = Array.isArray(k)
        ? k.map((v, si) => `(${si+1})${v || '–'}`).join(' ')
        : '–';
    else if (q.type === 'matching')
      keyText = Array.isArray(k)
        ? k.map((v, si) => `Ý${si+1}→${v !== null && v !== undefined ? ALPHA[Number(v)] : '–'}`).join(' ')
        : '–';
    else if (q.type === 'short')
      keyText = (k && String(k).trim()) ? String(k) : '–';

    return `<div class="adp-row">
      <div class="adp-num">Câu ${i+1}</div>
      <div class="adp-content">${safe(q.question)}</div>
      <div class="adp-key ${keyText === '–' ? 'no-key' : ''}">${escH(keyText)}</div>
    </div>`;
  }).join('');
  renderMath(document.getElementById('adp-body'));
}

// ══════════════════════════════════════════
//  ANSWER EDITOR MODAL (result screen)
// ══════════════════════════════════════════
function openAnswerEditor() {
  const body = document.getElementById('answer-editor-body');
  body.innerHTML = examData.questions.map((q, i) => {
    const k = answerKey[i];
    let ctrl = '';

    if (q.type === 'mcq') {
      ctrl = `<div class="aem-controls">` +
        q.options.map((opt, oi) => {
          const chk = (k !== null && k !== undefined && Number(k) === oi) ? 'checked' : '';
          return `<input type="radio" class="aem-radio-pill" name="aem_mcq_${i}" id="aem_mcq_${i}_${oi}" value="${oi}" ${chk}/>
            <label class="aem-radio-label" for="aem_mcq_${i}_${oi}" title="${escH(opt)}">${ALPHA[oi]}</label>`;
        }).join('') + `</div>`;
    }
    else if (q.type === 'truefalse') {
      ctrl = `<div class="aem-controls" style="flex-direction:column;gap:.3rem;align-items:stretch">` +
        q.statements.map((s, si) => {
          const kv = Array.isArray(k) ? k[si] : null;
          return `<div class="aem-tf-row">
            <span class="aem-tf-stmt">(${si+1}) ${safe(s)}</span>
            <div class="aem-tf-group">
              <input type="radio" class="aem-tf-radio" name="aem_tf_${i}_${si}" id="aem_tf${i}_${si}_D" value="D" ${kv==='D'?'checked':''}/>
              <label class="aem-tf-label" for="aem_tf${i}_${si}_D">Đ</label>
              <input type="radio" class="aem-tf-radio" name="aem_tf_${i}_${si}" id="aem_tf${i}_${si}_S" value="S" ${kv==='S'?'checked':''}/>
              <label class="aem-tf-label" for="aem_tf${i}_${si}_S">S</label>
            </div>
          </div>`;
        }).join('') + `</div>`;
    }
    else if (q.type === 'matching') {
      ctrl = `<div class="aem-controls" style="flex-direction:column;gap:.28rem;align-items:stretch">` +
        q.left.map((lItem, li) => {
          const kv = Array.isArray(k) ? (k[li] !== null && k[li] !== undefined ? k[li] : '') : '';
          let opts = `<option value="">–</option>`;
          q.right.forEach((_, ri) =>
            opts += `<option value="${ri}" ${String(ri) === String(kv) ? 'selected' : ''}>${ALPHA[ri]}</option>`);
          return `<div class="aem-match-row">
            <span class="aem-match-stmt">(${li+1}) ${safe(lItem)}</span>
            <select class="aem-match-select" data-qi="${i}" data-li="${li}">${opts}</select>
          </div>`;
        }).join('') + `</div>`;
    }
    else if (q.type === 'short') {
      const val = (k !== null && k !== undefined) ? escH(String(k)) : '';
      ctrl = `<div class="aem-controls">
        <input type="text" class="aem-short-input" data-qi="${i}" value="${val}" placeholder="Nhập đáp án đúng..."/>
      </div>`;
    }

    return `<div class="aem-q-row">
      <div class="aem-q-num">Câu ${i+1} · ${typeFull(q.type)}</div>
      <div class="aem-q-text">${safe(q.question)}</div>
      ${ctrl}
    </div>`;
  }).join('');
  document.getElementById('answer-editor-modal').classList.remove('hidden');
  renderMath(body);
}
function closeAnswerEditor() { document.getElementById('answer-editor-modal').classList.add('hidden'); }

function saveAnswerKey() {
  examData.questions.forEach((q, i) => {
    if (q.type === 'mcq') {
      const s = document.querySelector(`input[name="aem_mcq_${i}"]:checked`);
      answerKey[i] = s ? Number(s.value) : null;
    }
    else if (q.type === 'truefalse') {
      answerKey[i] = q.statements.map((_, si) => {
        const s = document.querySelector(`input[name="aem_tf_${i}_${si}"]:checked`);
        return s ? s.value : null;
      });
    }
    else if (q.type === 'matching') {
      answerKey[i] = q.left.map((_, li) => {
        const s = document.querySelector(`.aem-match-select[data-qi="${i}"][data-li="${li}"]`);
        return (s && s.value !== '') ? Number(s.value) : null;
      });
    }
    else if (q.type === 'short') {
      const inp = document.querySelector(`.aem-short-input[data-qi="${i}"]`);
      answerKey[i] = inp ? (inp.value.trim() || null) : null;
    }
  });
  closeAnswerEditor();
  renderScore();
  const panel = document.getElementById('answer-display-panel');
  if (!panel.classList.contains('hidden')) renderAnswerDisplay();
}

// ══════════════════════════════════════════
//  BANK IMPORT — GÁN ID + LƯU THEO MÔN
// ══════════════════════════════════════════
function handleBankImport(e) {
  const files = [...e.target.files];
  let added = 0, errors = [];
  let pending = files.length;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        let data = JSON.parse(ev.target.result);
        let qs = [];
        if (Array.isArray(data)) qs = data;
        else if (Array.isArray(data.questions)) qs = data.questions;
        else throw new Error('Không tìm thấy mảng questions');

        const valid = ['truefalse','mcq','matching','short'];
        qs.forEach(q => {
          if (valid.includes(q.type) && q.question) {
            if (!q.id) q.id = uid();
            bank.push({ ...q });
            added++;
          }
        });
      } catch(err) { errors.push(`${file.name}: ${err.message}`); }
      pending--;
      if (pending === 0) {
        showLoading(`Đang lưu ${added} câu lên Supabase...`);
        await saveBank(currentSubject, bank);
        hideLoading();
        buildSubjectTabs();
        renderBankList();
        showToast(added > 0 ? `✓ Đã thêm ${added} câu vào ngân hàng [${currentSubject}]` : '⚠️ Không thêm được câu nào');
        if (errors.length) showToast('⚠️ ' + errors.join('; '), true);
      }
    };
    reader.readAsText(file, 'UTF-8');
  });
  e.target.value = '';
}

async function clearBank() {
  if (!confirm(`Xóa toàn bộ ngân hàng môn "${currentSubject}"? Không thể hoàn tác.`)) return;
  showLoading('Đang xóa...');
  if (USE_SUPABASE) {
    await sb.from('questions').delete().eq('subject', currentSubject);
  }
  _lsSaveBank(currentSubject, []);
  bank = [];
  hideLoading();
  buildSubjectTabs();
  renderBankList();
}

async function deleteBankItem(idx) {
  if (!confirm('Xóa câu hỏi này?')) return;
  const q = bank[idx];
  showLoading('Đang xóa...');
  await deleteSingleQuestion(q.id);
  bank.splice(idx, 1);
  hideLoading();
  buildSubjectTabs();
  renderBankList();
}

// ══════════════════════════════════════════
//  RENDER BANK LIST
// ══════════════════════════════════════════
function renderBankList() {
  const cnt = countByType(bank);
  document.getElementById('bstat-total').textContent = bank.length;
  document.getElementById('bstat-mcq').textContent   = cnt.mcq;
  document.getElementById('bstat-tf').textContent    = cnt.truefalse;
  document.getElementById('bstat-short').textContent = cnt.short;
  document.getElementById('bstat-match').textContent = cnt.matching;

  const typeF  = document.getElementById('bank-filter-type')?.value || '';
  const search = (document.getElementById('bank-search')?.value || '').toLowerCase();
  const emptyState = document.getElementById('bank-empty-state');
  const listEl     = document.getElementById('bank-list');
  if (!listEl) return;

  const filtered = bank.filter(q => {
    if (typeF && q.type !== typeF) return false;
    if (search && !q.question.toLowerCase().includes(search)) return false;
    return true;
  });

  // Show subject context label
  let subjectLabel = document.getElementById('bank-subject-label');
  if (!subjectLabel) {
    subjectLabel = document.createElement('div');
    subjectLabel.id = 'bank-subject-label';
    subjectLabel.style.cssText = 'font-size:.78rem;color:var(--text-muted);margin-bottom:.4rem;font-weight:600;';
    listEl.parentNode.insertBefore(subjectLabel, listEl);
  }
  subjectLabel.textContent = `Đang xem: ${currentSubject} — ${bank.length} câu hỏi`;

  if (bank.length === 0) {
    emptyState.style.display = '';
    listEl.innerHTML = '';
    return;
  }
  emptyState.style.display = 'none';

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted);font-size:.85rem">Không tìm thấy câu hỏi phù hợp.</div>';
    return;
  }

  listEl.innerHTML = filtered.map(q => {
    const idx = bank.findIndex(b => b.id === q.id);
    const hasAns = checkQuestionHasAnswer(q);
    const keyPreview = getKeyPreview(q);
    return `<div class="bank-card">
      <div class="bank-card-type ${q.type}">${typeShort(q.type)}</div>
      <div class="bank-card-body">
        <div class="bank-card-q">${safe(q.question)}</div>
        <div class="bank-card-meta">
          <span style="font-family:var(--mono);font-size:.68rem;color:var(--text-muted);opacity:.7">ID: ${q.id || '–'}</span>
          &nbsp;·&nbsp;
          <span class="bank-card-ans ${hasAns ? 'has-ans' : 'no-ans'}">${hasAns ? '✓ Có đáp án' : '✗ Chưa có đáp án'}</span>
          ${keyPreview ? `<span class="bank-card-key">→ ${escH(keyPreview)}</span>` : ''}
        </div>
      </div>
      <div class="bank-card-actions">
        <button class="bc-btn" onclick="openBankEdit(${idx})">✏️</button>
        <button class="bc-btn del" onclick="deleteBankItem(${idx})">🗑</button>
      </div>
    </div>`;
  }).join('');

  // Render LaTeX trong bank list
  renderMath(listEl);
}

function checkQuestionHasAnswer(q) {
  if (q.type === 'mcq')       return q.answer !== null && q.answer !== undefined;
  if (q.type === 'short')     return q.answer !== null && q.answer !== undefined && String(q.answer).trim() !== '';
  if (q.type === 'truefalse') return Array.isArray(q.answers) && q.answers.some(v => v === 'D' || v === 'S');
  if (q.type === 'matching')  return Array.isArray(q.answers) && q.answers.some(v => v !== null && v !== undefined);
  return false;
}
function getKeyPreview(q) {
  if (q.type === 'mcq'       && q.answer !== null && q.answer !== undefined) return ALPHA[Number(q.answer)];
  if (q.type === 'short'     && q.answer !== null && q.answer !== undefined) return String(q.answer);
  if (q.type === 'truefalse' && Array.isArray(q.answers)) return q.answers.map((v, i) => `${i+1}:${v||'?'}`).join(' ');
  if (q.type === 'matching'  && Array.isArray(q.answers)) return q.answers.map((v, i) => `${i+1}→${v!==null&&v!==undefined?ALPHA[Number(v)]:'?'}`).join(' ');
  return '';
}

// ══════════════════════════════════════════
//  BANK EDIT MODAL
// ══════════════════════════════════════════
function openBankEdit(idx) {
  bankEditIdx = idx;
  const q = bank[idx];
  document.getElementById('bank-edit-title').textContent = `Sửa câu hỏi · ${typeFull(q.type)} · ID: ${q.id || '–'}`;

  let html = `<div class="bedit-group">
    <label class="bedit-label">Câu hỏi</label>
    <textarea class="bedit-textarea" id="bedit-question">${escH(q.question)}</textarea>
  </div>`;

  if (q.type === 'mcq') {
    html += q.options.map((opt, oi) => `<div class="bedit-group">
      <label class="bedit-label">Phương án ${ALPHA[oi]}</label>
      <input class="bedit-input" id="bedit-opt-${oi}" value="${escH(opt)}"/>
    </div>`).join('');
    html += `<div class="bedit-group"><label class="bedit-label">✅ Đáp án đúng</label>
      <select class="bedit-select" id="bedit-answer">
        <option value="">– Chưa có –</option>
        ${q.options.map((_, oi) => `<option value="${oi}" ${q.answer===oi?'selected':''}>${ALPHA[oi]}</option>`).join('')}
      </select></div>`;
  }
  else if (q.type === 'truefalse') {
    html += q.statements.map((s, si) => `
      <div class="bedit-group">
        <label class="bedit-label">Mệnh đề ${si+1}</label>
        <input class="bedit-input" id="bedit-stmt-${si}" value="${escH(s)}"/>
      </div>
      <div class="bedit-group">
        <label class="bedit-label">✅ Đáp án mệnh đề ${si+1}</label>
        <select class="bedit-select" id="bedit-ans-${si}">
          <option value="">– Chưa có –</option>
          <option value="D" ${q.answers?.[si]==='D'?'selected':''}>Đúng</option>
          <option value="S" ${q.answers?.[si]==='S'?'selected':''}>Sai</option>
        </select>
      </div>`).join('');
  }
  else if (q.type === 'short') {
    html += `<div class="bedit-group"><label class="bedit-label">✅ Đáp án đúng</label>
      <input class="bedit-input" id="bedit-answer" value="${escH(q.answer || '')}"/></div>`;
    html += `<div class="bedit-group"><label class="bedit-label">Placeholder</label>
      <input class="bedit-input" id="bedit-placeholder" value="${escH(q.placeholder || '')}"/></div>`;
  }
  else if (q.type === 'matching') {
    html += `<div class="bedit-group"><label class="bedit-label">Cột trái (mỗi dòng 1 ý)</label>
      <textarea class="bedit-textarea" id="bedit-left">${q.left.map(escH).join('\n')}</textarea></div>`;
    html += `<div class="bedit-group"><label class="bedit-label">Cột phải (mỗi dòng 1 mục)</label>
      <textarea class="bedit-textarea" id="bedit-right">${q.right.map(escH).join('\n')}</textarea></div>`;
    html += `<div class="bedit-group">
      <label class="bedit-label">✅ Đáp án (vd: A,B,C,D – tương ứng từng ý cột trái)</label>
      <input class="bedit-input" id="bedit-answer" value="${
        Array.isArray(q.answers) ? q.answers.map(v => v !== null && v !== undefined ? ALPHA[Number(v)] : '–').join(',') : ''
      }"/></div>`;
  }

  document.getElementById('bank-edit-body').innerHTML = html;
  document.getElementById('bank-edit-modal').classList.remove('hidden');
}
function closeBankEdit() {
  document.getElementById('bank-edit-modal').classList.add('hidden');
  bankEditIdx = -1;
}
async function saveBankEdit() {
  if (bankEditIdx < 0) return;
  const q = { ...bank[bankEditIdx] };
  q.question = document.getElementById('bedit-question').value.trim();

  if (q.type === 'mcq') {
    q.options = q.options.map((_, oi) => document.getElementById(`bedit-opt-${oi}`).value);
    const av  = document.getElementById('bedit-answer').value;
    q.answer  = av !== '' ? Number(av) : null;
  }
  else if (q.type === 'truefalse') {
    q.statements = q.statements.map((_, si) => document.getElementById(`bedit-stmt-${si}`).value);
    q.answers    = q.statements.map((_, si) => {
      const v = document.getElementById(`bedit-ans-${si}`).value;
      return v || null;
    });
  }
  else if (q.type === 'short') {
    q.answer      = document.getElementById('bedit-answer').value.trim() || null;
    q.placeholder = document.getElementById('bedit-placeholder').value.trim();
  }
  else if (q.type === 'matching') {
    q.left  = document.getElementById('bedit-left').value.split('\n').map(s => s.trim()).filter(Boolean);
    q.right = document.getElementById('bedit-right').value.split('\n').map(s => s.trim()).filter(Boolean);
    const raw = document.getElementById('bedit-answer').value.split(',').map(s => s.trim().toUpperCase());
    q.answers = raw.map(s => { const i = ALPHA.indexOf(s); return i >= 0 ? i : null; });
  }

  bank[bankEditIdx] = q;
  closeBankEdit();
  showLoading('Đang lưu...');
  await saveSingleQuestion(q, currentSubject);
  hideLoading();
  renderBankList();
  showToast('✓ Đã lưu câu hỏi');
}

// ══════════════════════════════════════════
//  CONFIG TAB
// ══════════════════════════════════════════
function renderConfigTab() {
  document.getElementById('cfg-mcq').value   = config.mcq;
  document.getElementById('cfg-tf').value    = config.truefalse;
  document.getElementById('cfg-short').value = config.short;
  document.getElementById('cfg-match').value = config.matching;
  document.getElementById('cfg-time').value  = config.time;
  const cnt = countByType(bank);
  document.getElementById('avail-mcq').textContent   = `${cnt.mcq} câu trong ngân hàng [${currentSubject}]`;
  document.getElementById('avail-tf').textContent    = `${cnt.truefalse} câu trong ngân hàng [${currentSubject}]`;
  document.getElementById('avail-short').textContent = `${cnt.short} câu trong ngân hàng [${currentSubject}]`;
  document.getElementById('avail-match').textContent = `${cnt.matching} câu trong ngân hàng [${currentSubject}]`;
  updateConfigTotal();
}
function updateConfigTotal() {
  const t = ['cfg-mcq','cfg-tf','cfg-short','cfg-match']
    .reduce((s, id) => s + (+document.getElementById(id).value || 0), 0);
  document.getElementById('cfg-total').textContent = t;
  // Gợi ý điểm tối đa
  const maxEl = document.getElementById('cfg-maxscore');
  if (maxEl) maxEl.textContent = `(tối đa ${t * 6} điểm)`;
}
function saveConfigFromUI() {
  config.mcq       = +document.getElementById('cfg-mcq').value   || 0;
  config.truefalse = +document.getElementById('cfg-tf').value    || 0;
  config.short     = +document.getElementById('cfg-short').value || 0;
  config.matching  = +document.getElementById('cfg-match').value || 0;
  config.time      = +document.getElementById('cfg-time').value  || 90;
  saveConfig();
  const msg = document.getElementById('config-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2500);
}

// ══════════════════════════════════════════
//  HISTORY TAB
// ══════════════════════════════════════════
async function renderHistory() {
  const hist    = await loadHistory();
  const emptyEl = document.getElementById('hist-empty');
  const tbody   = document.getElementById('hist-tbody');
  if (!tbody) return;
  if (!hist.length) {
    emptyEl.classList.remove('hidden');
    tbody.innerHTML = '';
    return;
  }
  emptyEl.classList.add('hidden');
  tbody.innerHTML = hist.map((h, idx) => {
    const d = new Date(h.date);
    const dateStr = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const isFull  = h.possible > 0 && h.score === h.possible;
    const maxPts  = h.totalQ ? h.totalQ * 6 : h.possible;
    const scoreDisplay = h.possible > 0 ? `${h.score}/${maxPts}` : '–';
    return `<tr>
      <td style="color:var(--text-muted);font-family:var(--mono);font-size:.76rem">${idx + 1}</td>
      <td><b>${escH(h.username)}</b></td>
      <td><span class="hist-subject">${escH(h.subject)}</span></td>
      <td style="font-family:var(--mono)">${h.answered || 0}/${h.totalQ}</td>
      <td><span class="hist-score ${isFull ? 'full' : ''}">${scoreDisplay} đ</span></td>
      <td class="hist-date">${dateStr}</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════
function isAnswered(i) {
  const a = answers[i];
  if (a === null || a === undefined) return false;
  if (typeof a === 'string') return a.trim() !== '';
  if (Array.isArray(a)) return a.some(v => v !== null && v !== undefined && v !== '');
  return false;
}

function showToast(msg, isErr = false) {
  let t = document.getElementById('vsat-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'vsat-toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'padding:.5rem 1.2rem;border-radius:99px;font-family:var(--sans);font-size:.82rem;' +
      'font-weight:700;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:opacity .3s;color:#fff;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isErr ? '#c0392b' : '#1a2a3a';
  t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}
