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

// Client Supabase — khởi tạo từ supabase.js (window.supabase)
// exam.js KHÔNG tự tạo client, tránh xung đột
const sb = window.supabase;

// ══════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════
const LS_CONFIG = 'vsat_config_v2';   // config vẫn giữ localStorage

const SUBJECTS = ['Toán','Ngữ Văn','Vật Lý','Hóa Học','Sinh Học','Lịch Sử','Địa Lý','Tiếng Anh',];

// Cấu trúc cố định: câu 1-9=Đúng/Sai, 10-15=TN, 16-20=Ghép, 21-25=TLN
const DEFAULT_CONFIG = { truefalse: 9, mcq: 6, matching: 5, short: 5, time: 90 };
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
const expandedFiles = new Set();  // bank file groups đang mở
let   bankSortMode  = 'type';     // 'type' | 'date'

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
// Tự động render [IMG:url] thành thẻ <img>
function safe(s) {
  return String(s || '').replace(
    /\[IMG:(https?:\/\/[^\]]+)\]/g,
    (_, url) => `<img src="${url}" alt="Hình minh họa" class="q-inline-img" onerror="this.style.display='none'" loading="lazy"/>`
  );
}

const pad   = n => String(n).padStart(2, '0');
const ALPHA = ['A','B','C','D','E','F','G','H'];

// Bỏ prefix "Câu N:", "Câu N.", "Câu N)" khi lưu vào bank
function stripQuestionPrefix(text) {
  if (!text) return '';
  return String(text).replace(/^(câu|Câu|CAU)\s*\d+\s*[.:\)\-]\s*/i, '').trim();
}

// ── localStorage file-map: questionId → filename ──
function getFileMap() {
  try { return JSON.parse(localStorage.getItem('vsat_file_map') || '{}'); } catch { return {}; }
}
function setFileMap(m) { localStorage.setItem('vsat_file_map', JSON.stringify(m)); }
function registerFile(ids, filename) {
  const m = getFileMap(); ids.forEach(id => { if (id) m[id] = filename; }); setFileMap(m);
}

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
//  LOADING OVERLAY
// ══════════════════════════════════════════
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
    image_url:    row.image_url   || undefined,
    table_data:   row.table_data  || undefined,
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
    image_url:    q.image_url    || null,
    table_data:   q.table_data   || null,
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

/** Lưu toàn bộ bank — upsert (không xóa dữ liệu cũ) */
async function saveBank(subject, data) {
  const rows = (data || bank).map(q => qToDbRow(q, subject || currentSubject));
  if (!rows.length) return;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb
      .from('questions')
      .upsert(rows.slice(i, i + BATCH), { onConflict: 'id' });
    if (error) { console.error('saveBank:', error); showToast('⚠️ Lỗi lưu: ' + error.message, true); return; }
  }
}

/** Upsert 1 câu (dùng cho saveBankEdit) */
async function saveSingleQuestion(q, subject) {
  const { error } = await sb
    .from('questions')
    .upsert(qToDbRow(q, subject || currentSubject), { onConflict: 'id' });
  if (error) { console.error('saveSingleQuestion:', error); showToast('⚠️ Lỗi lưu câu hỏi: ' + error.message, true); }
}

/** Xóa 1 câu hỏi theo id */
async function deleteSingleQuestion(id) {
  const { error } = await sb.from('questions').delete().eq('id', id);
  if (error) { console.error('deleteSingleQuestion:', error); showToast('⚠️ Lỗi xóa: ' + error.message, true); }
}

/** Đếm câu hỏi tất cả môn — dùng cho subject tabs */
async function loadAllSubjectCounts() {
  const { data, error } = await sb.from('questions').select('subject');
  if (error) { console.error('loadAllSubjectCounts:', error); return {}; }
  const counts = {};
  SUBJECTS.forEach(s => counts[s] = 0);
  (data || []).forEach(r => { if (counts[r.subject] !== undefined) counts[r.subject]++; });
  return counts;
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

async function saveHistory(entries) {
  // entries là mảng đã slice(0,200) từ showResults
  // Chỉ insert entry đầu tiên (entry mới nhất)
  if (!entries.length) return;
  const e = entries[0];
  const { error } = await sb.from('exam_history').insert({
    id:       e.id,
    username: e.username,
    subject:  e.subject,
    score:    e.score,
    possible: e.possible,
    total_q:  e.totalQ,
    answered: e.answered,
    title:    e.title,
  });
  if (error) console.error('saveHistory:', error);
}

// ══════════════════════════════════════════
//  SUPABASE CONNECTION STATUS BADGE
// ══════════════════════════════════════════
function createConnectionBadge() {
  const badge = document.createElement('div');
  badge.id = 'sb-status-badge';
  badge.style.cssText = `
    position:fixed;bottom:16px;left:16px;z-index:9999;
    display:flex;align-items:center;gap:6px;
    background:rgba(20,28,40,.85);backdrop-filter:blur(6px);
    border:1px solid rgba(255,255,255,.1);border-radius:99px;
    padding:5px 12px 5px 8px;cursor:pointer;
    font-family:var(--sans,sans-serif);font-size:.72rem;font-weight:600;
    color:#fff;transition:opacity .2s;user-select:none;
    box-shadow:0 2px 12px rgba(0,0,0,.3);
  `;
  badge.innerHTML = `<span id="sb-dot" style="width:8px;height:8px;border-radius:50%;background:#f5a623;display:inline-block;flex-shrink:0"></span><span id="sb-label">Đang kết nối...</span>`;
  badge.title = 'Trạng thái Supabase — click để thử lại';
  badge.addEventListener('click', checkSupabaseConnection);
  document.body.appendChild(badge);
}

async function checkSupabaseConnection() {
  const dot   = document.getElementById('sb-dot');
  const label = document.getElementById('sb-label');
  if (!dot) return;
  dot.style.background = '#f5a623';
  label.textContent = 'Đang kiểm tra...';
  try {
    if (!sb) throw new Error('Chưa khởi tạo');
    const { error } = await sb.from('questions').select('id').limit(1);
    if (error) throw error;
    dot.style.background = '#38d690';
    label.textContent = '';
  } catch(e) {
    dot.style.background = '#e53e3e';
    label.textContent = 'Mất kết nối';
    console.error('Supabase connection error:', e);
  }
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  loadConfig();
  createConnectionBadge();
  checkSupabaseConnection();

  // Mặc định vào login screen
  showScreen('login-screen');
  // Tạo mã thi ngay
  const code = 'VKOD' + Math.floor(10000 + Math.random() * 90000);
  const pass  = String(Math.floor(10000000 + Math.random() * 90000000));
  document.getElementById('info-account').textContent  = code;
  document.getElementById('info-password').textContent = pass;
  document.getElementById('login-username').value = code;

  // Load bank ngầm (không block UI)
  loadBank(currentSubject).then(b => { bank = b; }).catch(() => {});

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
  document.getElementById('bank-pdf-btn').addEventListener('click', () =>
    document.getElementById('bank-pdf-input').click()
  );
  document.getElementById('bank-pdf-input').addEventListener('change', handlePdfImport);
  document.getElementById('bank-clear-btn').addEventListener('click', clearBank);
  document.getElementById('bank-filter-type').addEventListener('change', renderBankList);
  document.getElementById('bank-sort')?.addEventListener('change', () => { bankSortMode = document.getElementById('bank-sort').value; renderBankList(); });
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
    await sb.from('exam_history').delete().neq('id', '__never__');
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
  showLoading(`ĐỢI LOAD${subject}...`);
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
  document.getElementById('theme-icon').textContent  = currentTheme === 'galaxy' ? '' : '';
  document.getElementById('theme-label').textContent = currentTheme === 'galaxy' ? 'CTU' : 'VSAT';
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
  updateLoginBadge().catch(() => {});
  showScreen('login-screen');
  // Tạo mã mới mỗi lần vào thi lại
  const code = 'CTU' + Math.floor(10000 + Math.random() * 90000);
  const pass  = String(Math.floor(10000000 + Math.random() * 90000000));
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
  try { bank = await loadBank(currentSubject); } catch(e) { console.error(e); }
  hideLoading();
  buildSubjectTabs();
  renderBankList();
  renderHistory();
  showScreen('dashboard-screen');
}

async function updateLoginBadge() {
  const subject = document.getElementById('login-subject')?.value || studentInfo.subject || 'Toán';
  const badge = document.getElementById('bank-status-badge');
  const { data, error } = await sb.from('questions').select('type').eq('subject', subject);
  if (error || !data || !data.length) { badge.classList.add('hidden'); return; }
  const c = { mcq: 0, truefalse: 0, short: 0, matching: 0 };
  data.forEach(r => { if (c[r.type] !== undefined) c[r.type]++; });
  badge.classList.remove('hidden');
  badge.innerHTML = `NGÂN HÀNG <b>${subject}</b>: <b>${data.length}</b> CÂU &nbsp;·&nbsp; TRẮC NGHIỆM:<b>${c.mcq}</b> &nbsp;ĐÚNG/SAI:<b>${c.truefalse}</b> &nbsp;TRẢ LỜI NGẮN:<b>${c.short}</b> &nbsp;GHÉP CỘT:<b>${c.matching}</b>`;
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

  showLoading(`Đang lấy đề ${subject}...`);
  const subjectBank = await loadBank(subject);
  hideLoading();

  const drawn = drawFromBank(subjectBank);

  if (drawn === null) {
    drawErr.textContent = `Ngân hàng môn "${subject}" chưa có câu hỏi.Vui lòng thêm vào màn dashboard để thêm câu hỏi`;
    drawErr.classList.remove('hidden');
    return;
  }
  if (drawn.error) {
    drawErr.textContent = drawn.error;
    drawErr.classList.remove('hidden');
    return;
  }
  startExam({
    title: `Ca 0 - Phòng ONLINE - ${user}`,  // subject=${subject}
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
// ── Tách pool thành: nhóm passage (phải bốc cả nhóm) + câu độc lập ──
function splitPassageGroups(pool) {
  const groups = new Map();   // passage_id → questions[]
  const loners = [];
  pool.forEach(q => {
    if (q.passage_id) {
      if (!groups.has(q.passage_id)) groups.set(q.passage_id, []);
      groups.get(q.passage_id).push(q);
    } else {
      loners.push(q);
    }
  });
  return { groups, loners };
}

// Chọn đủ `count` câu từ pool, ưu tiên lấy nguyên nhóm passage
function pickWithPassages(pool, count) {
  if (!count) return [];
  const shuffle = arr => [...arr].sort(() => Math.random() - .5);
  const { groups, loners } = splitPassageGroups(pool);

  const shuffledGroups = shuffle([...groups.values()]);
  const shuffledLoners = shuffle(loners);
  const result = [];

  // Thêm nhóm passage: nếu nhóm vừa khít với slot còn lại thì thêm
  for (const grp of shuffledGroups) {
    if (result.length >= count) break;
    const remaining = count - result.length;
    // Chỉ lấy nhóm nếu còn đủ slot (không cắt giữa nhóm)
    if (grp.length <= remaining) {
      result.push(...grp);
    }
    // Nếu không đủ slot cho cả nhóm → bỏ qua nhóm này (không lấy lẻ)
  }

  // Bổ sung câu đơn lẻ vào các slot còn trống
  for (const q of shuffledLoners) {
    if (result.length >= count) break;
    result.push(q);
  }

  // Nếu vẫn chưa đủ và còn nhóm dư → thêm nhóm dù vượt slot (ưu tiên tính toàn vẹn)
  if (result.length < count) {
    for (const grp of shuffledGroups) {
      if (result.length >= count) break;
      if (!result.find(q => q.passage_id === grp[0].passage_id)) {
        result.push(...grp);
      }
    }
  }

  return result.slice(0, count);
}

function drawFromBank(subjectBank) {
  const b = subjectBank || bank;
  if (!b.length) return null;

  const byType = { mcq: [], truefalse: [], short: [], matching: [] };
  b.forEach(q => { if (byType[q.type]) byType[q.type].push(q); });

  const need = { mcq: config.mcq, truefalse: config.truefalse, short: config.short, matching: config.matching };
  const errors = [];
  Object.entries(need).forEach(([type, n]) => {
    if (n > 0 && byType[type].length < n)
      errors.push(`${typeFull(type)}: cần ${n}, có ${byType[type].length}`);
  });
  if (errors.length) return { error: 'Không đủ câu: ' + errors.join('; ') };

  let qs = [];
  // Thứ tự CỐ ĐỊNH: Đúng/Sai → TN → Ghép cột → TLN
  // Mỗi loại dùng pickWithPassages để đảm bảo lấy nguyên nhóm ngữ liệu
  if (need.truefalse > 0) qs.push(...pickWithPassages(byType.truefalse, need.truefalse));
  if (need.mcq       > 0) qs.push(...pickWithPassages(byType.mcq,       need.mcq));
  if (need.matching  > 0) qs.push(...pickWithPassages(byType.matching,  need.matching));
  if (need.short     > 0) qs.push(...pickWithPassages(byType.short,     need.short));
  return qs;
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
  // Section headers cố định theo cấu trúc V-SAT
  const SECTION_DEFS = [
    { at:0,  title:'PHẦN I. CÂU HỎI ĐÚNG – SAI',    desc:'Từ câu hỏi 01 đến 09, thí sinh hãy cho biết các phát biểu sau đúng hay sai. Tích vào ô tương ứng.' },
    { at:9,  title:'PHẦN II. CÂU HỎI TRẮC NGHIỆM',  desc:'Từ câu hỏi 10 đến 15, mỗi câu có 4 lựa chọn A, B, C, D. Chỉ có một đáp án đúng.' },
    { at:15, title:'PHẦN III. CÂU HỎI GHÉP CỘT',    desc:'Từ câu hỏi 16 đến 20, ghép mỗi ý ở cột trái với một mục phù hợp ở cột phải.' },
    { at:20, title:'PHẦN IV. CÂU HỎI TRẢ LỜI NGẮN', desc:'Từ câu hỏi 21 đến 25, thí sinh điền đáp án số vào ô trả lời.' },
  ];

  // Tập hợp tất cả passage_id đã render để không render lại
  const renderedPassages = new Set();

  examData.questions.forEach((q, i) => {
    // Section header
    const secDef = SECTION_DEFS.find(s => s.at === i);
    if (secDef) {
      const sec = document.createElement('div');
      sec.className = 'section-header';
      sec.innerHTML = `<div class="section-title">${secDef.title}</div><div class="section-desc">${secDef.desc}</div>`;
      body.appendChild(sec);
    }

    // Passage banner (ngữ liệu) — chỉ render lần đầu gặp passage_id này
    if (q.passage_id && q.passage_text && !renderedPassages.has(q.passage_id)) {
      renderedPassages.add(q.passage_id);
      // Đếm số câu dùng ngữ liệu này trong đề hiện tại
      const groupCount = examData.questions.filter(qq => qq.passage_id === q.passage_id).length;
      const passageDiv = document.createElement('div');
      passageDiv.className = 'passage-box';
      passageDiv.innerHTML = `
        <div class="passage-notice">
          Thí sinh dùng ngữ liệu sau đây để trả lời câu hỏi
          <span class="passage-q-count">${groupCount} câu</span>
        </div>
        <div class="passage-content">${safe(q.passage_text)}</div>`;
      body.appendChild(passageDiv);
    }

    const block = document.createElement('div');
    block.className = 'question-block';
    block.id = `q-block-${i}`;
    const isPinned = pinnedSet.has(i);
    block.innerHTML = `
      <div class="q-block-header${isPinned ? ' pinned-header' : ''}">
        <span class="q-block-title">Câu ${i+1}</span>
        <button class="q-pin-btn${isPinned ? ' pinned' : ''}" data-idx="${i}" title="Đánh dấu / bỏ đánh dấu">&#9670;</button>
      </div>
      <div class="q-block-body">
        <div class="q-text">${safe(q.question)}</div>
        ${buildQuestionExtras(q)}
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


// ── Image + Table extras rendered AFTER question text ──
function buildQuestionExtras(q) {
  let html = '';
  if (q.image_url) {
    html += `<div class="question-image">
      <img src="${q.image_url}" alt="Hình minh họa" loading="lazy"
        onerror="this.parentElement.style.display='none'"/>
    </div>`;
  }
  if (q.table_data) {
    html += renderTable(q.table_data);
  }
  return html;
}

function renderTable(data) {
  if (!data || !data.headers || !data.rows) return '';
  let html = '<div class="question-table-wrap"><table class="question-table"><thead><tr>';
  data.headers.forEach(h => { html += `<th>${safe(String(h))}</th>`; });
  html += '</tr></thead><tbody>';
  data.rows.forEach(r => {
    html += '<tr>';
    r.forEach(c => { html += `<td>${safe(String(c))}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function buildAnswerHTML(q, i) {
  if (q.type === 'truefalse') return buildTFHTML(q, i);
  if (q.type === 'mcq')       return buildMCQHTML(q, i);
  if (q.type === 'matching')  return buildMatchingHTML(q, i);
  if (q.type === 'short')     return buildShortHTML(q, i);
  return '';
}

/* ── TRUE/FALSE ── */
const TF_LETTERS = ['a','b','c','d','e','f'];
function buildTFHTML(q, i) {
  const rows = q.statements.map((s, si) => {
    const curAns = answers[i]?.[si];
    const dC = curAns === 'D' ? 'checked' : '';
    const sC = curAns === 'S' ? 'checked' : '';
    const rowCls = curAns === 'D' ? 'tf-row-D' : curAns === 'S' ? 'tf-row-S' : '';
    return `<tr class="${rowCls}">
      <td class="tf-cell">
        <input type="radio" class="tf-radio" name="tf_${i}_${si}" id="tf${i}_${si}_D"
          data-si="${si}" data-val="D" ${dC}/>
        <label class="tf-label tf-label-D" for="tf${i}_${si}_D"></label>
      </td>
      <td class="tf-cell">
        <input type="radio" class="tf-radio" name="tf_${i}_${si}" id="tf${i}_${si}_S"
          data-si="${si}" data-val="S" ${sC}/>
        <label class="tf-label tf-label-S" for="tf${i}_${si}_S"></label>
      </td>
      <td class="tf-stmt"><span class="tf-label-letter">${TF_LETTERS[si]})</span> ${safe(s)}</td>
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
      const si = +r.dataset.si;
      answers[i][si] = r.dataset.val;
      const row = r.closest('tr');
      if (row) row.className = r.dataset.val === 'D' ? 'tf-row-D' : 'tf-row-S';
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
    let opts = `<option value="">Chọn phương án</option>`;
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
  return `<div class="short-wrap">
    <div class="short-row">
      <span class="short-row-label">Trả lời:</span>
      <input type="text" class="short-input" id="short_${i}"
        value="${escH(val)}"
        placeholder="${escH(q.placeholder || 'Dùng dấu chấm . phân cách phần nguyên và thập phân')}"
        autocomplete="off" spellcheck="false"/>
    </div>
  </div>`;
}
function attachShortListeners(i) {
  const inp = document.getElementById(`short_${i}`);
  if (inp) inp.addEventListener('input', () => { answers[i] = inp.value; updateDot(i); });
}

// PIN
const pinnedSet = new Set();
function togglePin(i) {
  const btn    = document.querySelector(`.q-pin-btn[data-idx="${i}"]`);
  const header = btn?.closest('.q-block-header');
  if (pinnedSet.has(i)) {
    pinnedSet.delete(i);
    btn?.classList.remove('pinned');
    header?.classList.remove('pinned-header');
  } else {
    pinnedSet.add(i);
    btn?.classList.add('pinned');
    header?.classList.add('pinned-header');
  }
  updateDot(i);
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
  pinnedSet.has(i) ? d.classList.add('pinned') : d.classList.remove('pinned');
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
//  BANK IMPORT — UPSERT TỪNG CÂU LÊN SUPABASE
// ══════════════════════════════════════════
function handleBankImport(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  let totalAdded = 0, totalSkipped = 0, errors = [];
  let pending = files.length;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        let data = JSON.parse(ev.target.result);
        let qs = [];
        if (Array.isArray(data))                 qs = data;
        else if (Array.isArray(data.questions))  qs = data.questions;
        else throw new Error('Không tìm thấy mảng questions');

        const valid = ['truefalse', 'mcq', 'matching', 'short'];
        const rows = [];
        const newIds = [];
        qs.forEach(q => {
          if (!valid.includes(q.type) || !q.question) { totalSkipped++; return; }
          if (!q.id) q.id = uid();
          q.question = stripQuestionPrefix(q.question);  // bỏ "Câu N:"
          rows.push(qToDbRow({ ...q }, currentSubject));
          bank.push({ ...q });
          newIds.push(q.id);
          totalAdded++;
        });
        registerFile(newIds, file.name);  // lưu tên file cho từng câu

        if (rows.length > 0) {
          showLoading(`Đang lưu ${rows.length} câu lên Supabase...`);
          // Upsert từng batch 50 câu — không xóa dữ liệu cũ
          const BATCH = 50;
          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await sb
              .from('questions')
              .upsert(rows.slice(i, i + BATCH), { onConflict: 'id' });
            if (error) throw error;
          }
          hideLoading();
        }
      } catch(err) {
        hideLoading();
        errors.push(`${file.name}: ${err.message}`);
      }

      pending--;
      if (pending === 0) {
        // Reload bank từ Supabase để đảm bảo đồng bộ
        bank = await loadBank(currentSubject);
        buildSubjectTabs();
        renderBankList();
        checkSupabaseConnection();
        if (totalAdded > 0)
          showToast(`✓ Đã upsert ${totalAdded} câu vào [${currentSubject}]${totalSkipped ? ` (bỏ qua ${totalSkipped})` : ''}`);
        else
          showToast('⚠️ Không thêm được câu nào', true);
        if (errors.length) showToast('⚠️ ' + errors.join('; '), true);
      }
    };
    reader.readAsText(file, 'UTF-8');
  });
  e.target.value = '';
}

// ══════════════════════════════════════════
//  PDF IMPORT → AI PARSE → SUPABASE
// ══════════════════════════════════════════

// Modal hiển thị kết quả AI parse trước khi lưu
function showPdfReviewModal(questions, filename) {
  let modal = document.getElementById('pdf-review-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pdf-review-modal';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:8000;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(4px)`;
    document.body.appendChild(modal);
  }

  const typeCount = { mcq:0, truefalse:0, short:0, matching:0 };
  questions.forEach(q => { if(typeCount[q.type]!==undefined) typeCount[q.type]++; });

  modal.innerHTML = `
    <div style="background:var(--content-bg,#fff);border-radius:14px;max-width:640px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4)">
      <div style="padding:1.2rem 1.4rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:1rem;font-weight:700;color:var(--text)">🤖 AI đã phân tích xong</div>
          <div style="font-size:.78rem;color:var(--text-muted);margin-top:.2rem">${filename}</div>
        </div>
        <button onclick="closePdfReview()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--text-muted)">✕</button>
      </div>

      <div style="padding:1rem 1.4rem;border-bottom:1px solid var(--border);display:flex;gap:.8rem;flex-wrap:wrap">
        <span style="background:var(--accent-soft,#e8f4fd);color:var(--accent);padding:.3rem .8rem;border-radius:99px;font-size:.78rem;font-weight:700">
          Tổng: ${questions.length} câu
        </span>
        ${typeCount.truefalse ? `<span style="background:#e8fdf0;color:#16a34a;padding:.3rem .8rem;border-radius:99px;font-size:.78rem;font-weight:600">Đ/S: ${typeCount.truefalse}</span>` : ''}
        ${typeCount.mcq ? `<span style="background:#fff7e6;color:#d97706;padding:.3rem .8rem;border-radius:99px;font-size:.78rem;font-weight:600">TN: ${typeCount.mcq}</span>` : ''}
        ${typeCount.matching ? `<span style="background:#f3e8ff;color:#7c3aed;padding:.3rem .8rem;border-radius:99px;font-size:.78rem;font-weight:600">Ghép: ${typeCount.matching}</span>` : ''}
        ${typeCount.short ? `<span style="background:#fef2f2;color:#dc2626;padding:.3rem .8rem;border-radius:99px;font-size:.78rem;font-weight:600">TLN: ${typeCount.short}</span>` : ''}
      </div>

      <div id="pdf-review-list" style="flex:1;overflow-y:auto;padding:1rem 1.4rem">
        ${questions.map((q,i) => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:.8rem;margin-bottom:.6rem;font-size:.8rem">
            <div style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:.4rem">
              <span style="background:var(--q-alt-bg);padding:.15rem .5rem;border-radius:4px;font-size:.7rem;font-weight:700;color:var(--text-muted);flex-shrink:0">${typeFull(q.type)}</span>
              <span style="color:var(--text);line-height:1.4">${safe(q.question).slice(0,120)}${q.question.length>120?'…':''}</span>
            </div>
            <div style="color:var(--text-muted);font-size:.72rem">
              ${q.type==='truefalse'&&q.statements ? `${q.statements.length} mệnh đề · ${q.answers?.filter(Boolean).length||0} có đáp án` : ''}
              ${q.type==='mcq'&&q.options ? `${q.options.length} phương án · ${q.answer!=null?'Có đáp án':'Chưa có đáp án'}` : ''}
              ${q.type==='matching'&&q.left ? `${q.left.length} cặp ghép · ${q.answers?.some(v=>v!=null)?'Có đáp án':'Chưa có đáp án'}` : ''}
              ${q.type==='short' ? (q.answer!=null&&q.answer!==''?`Đáp án: ${q.answer}`:'Chưa có đáp án') : ''}
            </div>
          </div>
        `).join('')}
      </div>

      <div style="padding:1rem 1.4rem;border-top:1px solid var(--border);display:flex;gap:.6rem;justify-content:flex-end">
        <button onclick="closePdfReview()" style="padding:.5rem 1.2rem;border-radius:8px;border:1.5px solid var(--border);background:none;color:var(--text-muted);font-size:.84rem;cursor:pointer;font-family:var(--sans)">Hủy</button>
        <button onclick="confirmPdfImport()" id="pdf-confirm-btn" style="padding:.5rem 1.4rem;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:.84rem;font-weight:700;cursor:pointer;font-family:var(--sans)">
          ✓ Lưu ${questions.length} câu vào [${currentSubject}]
        </button>
      </div>
    </div>`;

  modal.style.display = 'flex';
}

function closePdfReview() {
  const m = document.getElementById('pdf-review-modal');
  if (m) m.style.display = 'none';
  window._pdfParsedQuestions = null;
}

async function confirmPdfImport() {
  const questions = window._pdfParsedQuestions;
  if (!questions?.length) return;

  document.getElementById('pdf-confirm-btn').textContent = 'Đang lưu...';
  document.getElementById('pdf-confirm-btn').disabled = true;

  const newIds = [];
  const rows = questions.map(q => {
    const id = q.id || uid();
    newIds.push(id);
    return qToDbRow({ ...q, id, question: stripQuestionPrefix(q.question) }, currentSubject);
  });
  const BATCH = 50;
  let ok = true;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb.from('questions').upsert(rows.slice(i, i+BATCH), { onConflict:'id' });
    if (error) { showToast('⚠️ Lỗi lưu: ' + error.message, true); ok = false; break; }
  }

  if (ok) {
    registerFile(newIds, window._pdfFilename || 'PDF Import');  // lưu tên file PDF
    bank = await loadBank(currentSubject);
    buildSubjectTabs();
    renderBankList();
    showToast(`✓ Đã lưu ${questions.length} câu từ PDF vào [${currentSubject}]`);
    checkSupabaseConnection();
  }

  closePdfReview();
}

async function handlePdfImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  if (!file.type.includes('pdf') && !file.name.endsWith('.pdf')) {
    showToast('Vui lòng chọn file PDF', true);
    return;
  }

  showLoading('AI đang đọc PDF...');

  try {
    // Convert PDF to base64
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = () => rej(new Error('Không đọc được file'));
      r.readAsDataURL(file);
    });

    const systemPrompt = `Bạn là hệ thống phân tích đề thi VSAT của Đại học Cần Thơ. Hãy đọc file PDF đề thi và trích xuất TẤT CẢ câu hỏi.

ĐỊNH DẠNG OUTPUT: Chỉ trả về JSON array thuần túy, không có markdown, không có backtick, không có giải thích.

CẤU TRÚC MỖI CÂU:
- Câu Đúng/Sai (từ câu 01-09): {"id":"auto","type":"truefalse","question":"Nội dung dẫn câu","statements":["mệnh đề 1","mệnh đề 2","mệnh đề 3","mệnh đề 4"],"answers":["D","S","D","S"]}
- Câu MCQ (từ câu 10-15): {"id":"auto","type":"mcq","question":"Nội dung câu hỏi","options":["A. ...","B. ...","C. ...","D. ..."],"answer":0}
  (answer là index 0-3 tương ứng A-D)
- Câu ghép cột (từ câu 16-20): {"id":"auto","type":"matching","question":"Nội dung","left":["ý 1","ý 2","ý 3","ý 4"],"right":["A. ...","B. ...","C. ...","D. ...","E. ...","F. ..."],"answers":[indexA,indexB,indexC,indexD]}
  (answers là array index 0-based của cột phải tương ứng với từng ý cột trái)
- Câu trả lời ngắn (từ câu 21-25): {"id":"auto","type":"short","question":"Nội dung câu hỏi","answer":"đáp án số"}

QUY TẮC:
- Nếu câu có hình ảnh/sơ đồ không đọc được, ghi "[IMG:PLACEHOLDER]" vào question
- Giữ nguyên ký hiệu hóa học: H₂SO₄, Fe²⁺, NH₃, v.v. (dùng unicode subscript/superscript)
- Giữ nguyên công thức toán: dùng LaTeX nếu cần, ví dụ \\(x^2\\)
- answers cho truefalse: "D" = Đúng, "S" = Sai, null nếu không rõ
- Trích xuất ĐẦY ĐỦ tất cả 25 câu
- Không thêm bất kỳ trường nào khác ngoài schema trên`;

    // Gọi qua Vercel proxy — tránh CORS và giấu API key
    const response = await fetch('/api/parse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, filename: file.name })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Lỗi server ${response.status}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    const questions = data.questions;
    if (!Array.isArray(questions) || !questions.length) {
      throw new Error('Không tìm thấy câu hỏi nào trong file');
    }

    // Gán ID nếu thiếu
    questions.forEach(q => { if (!q.id || q.id === 'auto') q.id = uid(); });

    hideLoading();
    window._pdfParsedQuestions = questions;
    window._pdfFilename = file.name;
    showPdfReviewModal(questions, file.name);

  } catch(err) {
    hideLoading();
    console.error('PDF import error:', err);
    showToast('⚠️ Lỗi AI parse: ' + err.message, true);
  }
}

async function clearBank() {
  if (!confirm(`Xóa toàn bộ ngân hàng môn "${currentSubject}"? Không thể hoàn tác.`)) return;
  showLoading('Đang xóa...');
  await sb.from('questions').delete().eq('subject', currentSubject);
  const m = getFileMap(); bank.forEach(q => delete m[q.id]); setFileMap(m);
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
  const m = getFileMap(); delete m[q.id]; setFileMap(m);
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
  const sortMode = document.getElementById('bank-sort')?.value || 'type';
  const listEl = document.getElementById('bank-list');
  if (!listEl) return;

  if (bank.length === 0) {
    document.getElementById('bank-empty-state').style.display = '';
    listEl.innerHTML = '';
    return;
  }
  document.getElementById('bank-empty-state').style.display = 'none';

  const fileMap = getFileMap();

  // Filter
  const filtered = bank.filter(q => {
    if (typeF && q.type !== typeF) return false;
    if (search && !q.question.toLowerCase().includes(search)) return false;
    return true;
  });

  // Group by source file
  const fileGroups = new Map();
  filtered.forEach(q => {
    const f = fileMap[q.id] || '📎 Câu hỏi lẻ';
    if (!fileGroups.has(f)) fileGroups.set(f, []);
    fileGroups.get(f).push(q);
  });

  // Sort within each group
  const typeOrder = { truefalse: 0, mcq: 1, matching: 2, short: 3 };
  fileGroups.forEach(qs => {
    if (sortMode === 'type') qs.sort((a, b) => (typeOrder[a.type]||9) - (typeOrder[b.type]||9));
  });

  listEl.innerHTML = [...fileGroups.entries()].map(([filename, qs]) => {
    const isExpanded = expandedFiles.has(filename);
    const gc = countByType(qs);
    const meta = [
      gc.truefalse ? `Đ/S: ${gc.truefalse}` : '',
      gc.mcq       ? `TN: ${gc.mcq}` : '',
      gc.matching  ? `Ghép: ${gc.matching}` : '',
      gc.short     ? `TLN: ${gc.short}` : '',
    ].filter(Boolean).join(' · ');

    const isPdf  = filename.toLowerCase().endsWith('.pdf');
    const isJson = filename.toLowerCase().endsWith('.json');
    const icon   = isPdf ? '📄' : isJson ? '📋' : '📎';
    const displayName = filename.startsWith('📎') ? filename : filename.replace(/\.[^.]+$/, '');

    const cardsHTML = isExpanded ? qs.map(q => {
      const idx = bank.findIndex(b => b.id === q.id);
      const hasAns = checkQuestionHasAnswer(q);
      const keyPrev = getKeyPreview(q);
      return `<div class="bank-card">
        <div class="bank-card-type ${q.type}">${typeShort(q.type)}</div>
        <div class="bank-card-body">
          <div class="bank-card-q">${safe(q.question)}</div>
          <div class="bank-card-meta">
            <span class="bank-card-ans ${hasAns?'has-ans':'no-ans'}">${hasAns?'✓ Có đáp án':'✗ Chưa có đáp án'}</span>
            ${keyPrev ? `<span class="bank-card-key">→ ${escH(keyPrev)}</span>` : ''}
          </div>
        </div>
        <div class="bank-card-actions">
          <button class="bc-btn" onclick="openBankEdit(${idx})">✏️</button>
          <button class="bc-btn del" onclick="deleteBankItem(${idx})">🗑</button>
        </div>
      </div>`;
    }).join('') : '';

    const isLone = filename.startsWith('📎');
    return `<div class="file-group">
      <div class="file-group-header" onclick="toggleFileGroup('${escH(filename).replace(/'/g,'&#39;')}')">
        <span class="file-group-icon">${icon}</span>
        <div class="file-group-info">
          <span class="file-group-name">${escH(displayName)}</span>
          <span class="file-group-meta">${qs.length} câu &nbsp;·&nbsp; ${meta}</span>
        </div>
        ${!isLone ? `<button class="file-group-del" onclick="event.stopPropagation();deleteFileGroup('${escH(filename).replace(/'/g,'&#39;')}')" title="Xóa toàn bộ file này">🗑</button>` : ''}
        <span class="file-group-arrow${isExpanded?' open':''}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </div>
      ${isExpanded ? `<div class="file-group-body">${cardsHTML||'<div class="fg-empty">Không có câu hỏi phù hợp</div>'}</div>` : ''}
    </div>`;
  }).join('');

  renderMath(listEl);
}

function toggleFileGroup(filename) {
  if (expandedFiles.has(filename)) expandedFiles.delete(filename);
  else expandedFiles.add(filename);
  renderBankList();
}

async function deleteFileGroup(filename) {
  const m = getFileMap();
  const toDel = bank.filter(q => (m[q.id] || '📎 Câu hỏi lẻ') === filename).map(q => q.id);
  if (!toDel.length || !confirm(`Xóa ${toDel.length} câu từ "${filename.replace(/\.[^.]+$/,'')}"`)) return;
  showLoading('Đang xóa...');
  for (const id of toDel) { await deleteSingleQuestion(id); delete m[id]; }
  setFileMap(m);
  bank = bank.filter(q => !toDel.includes(q.id));
  expandedFiles.delete(filename);
  hideLoading();
  buildSubjectTabs();
  renderBankList();
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
