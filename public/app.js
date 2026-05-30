/* ── Config ──────────────────────────────────────────────────────── */
const API_BASE = '';
const ADMIN_ID = '885394476';

/* ── State ───────────────────────────────────────────────────────── */
const state = {
  user: null,
  packages: [],
  currentTab: 'packages',
  adminFilter: 'all',
  adminSearch: '',
  editingId: null,
};

/* ── Telegram WebApp ─────────────────────────────────────────────── */
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
  tg.enableClosingConfirmation();
}

function getTgInitData() {
  return tg?.initData || '';
}

/* ── API ─────────────────────────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const initData = getTgInitData();
  const headers = {
    'Content-Type': 'application/json',
    'x-telegram-init-data': initData || 'dev',
    ...(options.headers || {}),
  };
  // Dev: allow simulating admin
  if (!initData) {
    const devId = state.user?.id || ADMIN_ID;
    headers['x-dev-user-id'] = devId;
  }
  const res = await fetch(API_BASE + path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

/* ── Rate Helpers (frontend mirror) ─────────────────────────────── */
function calcRate(weight) {
  if (weight <= 5)  return { type: 'Экспресс',     rate: 1900 };
  if (weight <= 20) return { type: 'Наземный',      rate: 1750 };
  return                   { type: 'Сборный груз',  rate: 1300 };
}
function fmt(n) { return n.toLocaleString('ru-RU'); }

const STATUS = {
  received:   { label: 'На складе',         cls: 'badge-received'   },
  processing: { label: 'Обрабатывается',     cls: 'badge-processing' },
  shipped:    { label: 'В пути',             cls: 'badge-shipped'    },
  ready:      { label: 'Готово к выдаче',    cls: 'badge-ready'      },
  delivered:  { label: 'Выдано',             cls: 'badge-delivered'  },
};

function statusBadge(status) {
  const s = STATUS[status] || { label: status, cls: '' };
  return `<span class="status-badge ${s.cls}">${s.label}</span>`;
}

function fmtDate(str) {
  return new Date(str).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ── Package Card HTML ───────────────────────────────────────────── */
function pkgCard(p, isAdmin) {
  const rate = p.rate || calcRate(p.weight).rate;
  const type = p.type || calcRate(p.weight).type;
  const total = p.total || Math.round(p.weight * rate);
  const clientRow = isAdmin && (p.client_name || p.client_username || p.client_id)
    ? `<div class="pkg-client">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        ${p.client_name || ''}${p.client_username ? ' @' + p.client_username : ''}${!p.client_name && !p.client_username && p.client_id ? 'ID: ' + p.client_id : ''}
      </div>`
    : '';
  const actionsRow = isAdmin
    ? `<div class="pkg-actions">
        <button class="btn-edit-status" data-id="${p.id}">Изменить статус</button>
        <button class="btn-delete" data-id="${p.id}" title="Удалить">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`
    : '';

  return `
    <div class="pkg-card status-${p.status}" data-id="${p.id}">
      <div class="pkg-top">
        <div class="pkg-tracking">
          <div class="pkg-track-label">Трек-номер</div>
          <div class="pkg-track-row">
            <span class="pkg-track-num">${p.tracking_number}</span>
            <button class="copy-btn" data-copy="${p.tracking_number}" title="Скопировать">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </div>
        ${statusBadge(p.status)}
      </div>
      <div class="pkg-details">
        <div class="pkg-detail-item">
          <div class="pkg-detail-label">Вес</div>
          <div class="pkg-detail-val">${p.weight} кг</div>
        </div>
        <div class="pkg-detail-item">
          <div class="pkg-detail-label">Тариф</div>
          <div class="pkg-detail-val">${type}</div>
        </div>
        <div class="pkg-detail-item">
          <div class="pkg-detail-label">₽/кг</div>
          <div class="pkg-detail-val">${fmt(rate)} ₽</div>
        </div>
        <div class="pkg-detail-item">
          <div class="pkg-detail-label">Стоимость</div>
          <div class="pkg-detail-val">~${fmt(total)} ₽</div>
        </div>
      </div>
      ${clientRow}
      ${p.description ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;padding:8px 10px;background:var(--card-hover);border-radius:6px;">${p.description}</div>` : ''}
      <div style="font-size:11px;color:var(--text3);">Добавлено: ${fmtDate(p.created_at)}</div>
      ${actionsRow}
    </div>`;
}

/* ── Packages Tab ────────────────────────────────────────────────── */
async function loadPackages() {
  const list = document.getElementById('packages-list');
  list.innerHTML = '<div class="spinner"></div>';

  try {
    let url = '/api/packages';
    const params = new URLSearchParams();
    if (state.adminFilter && state.adminFilter !== 'all') params.set('status', state.adminFilter);
    if (state.adminSearch) params.set('search', state.adminSearch);
    if (params.toString()) url += '?' + params.toString();

    state.packages = await apiFetch(url);
    renderPackages();

    if (state.user?.is_admin) loadStats();
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function renderPackages() {
  const list = document.getElementById('packages-list');
  const isAdmin = state.user?.is_admin;

  if (!state.packages.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📭</div>
      <div class="empty-title">${isAdmin ? 'Посылок нет' : 'Ваших посылок нет'}</div>
      <div class="empty-sub">${isAdmin ? 'Добавьте первую посылку через кнопку «+»' : 'Свяжитесь с менеджером для привязки посылки'}</div>
    </div>`;
    return;
  }

  list.innerHTML = state.packages.map(p => pkgCard(p, isAdmin)).join('');
}

async function loadStats() {
  try {
    const stats = await apiFetch('/api/stats');
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-received').textContent = stats.received;
    document.getElementById('stat-shipped').textContent = stats.shipped;
    document.getElementById('stat-ready').textContent = stats.ready;
  } catch {}
}

/* ── Track Tab ───────────────────────────────────────────────────── */
async function doTrack(number) {
  const result = document.getElementById('track-result');
  if (!number.trim()) return;
  result.innerHTML = '<div class="spinner"></div>';

  try {
    const p = await apiFetch(`/api/track/${encodeURIComponent(number.trim().toUpperCase())}`);
    const rate = calcRate(p.weight);
    const total = Math.round(p.weight * rate.rate);
    const owned = p.client_id === state.user?.id;
    const unclaimed = !p.client_id;
    const historyHtml = (p.history || []).map(h =>
      `<div class="history-item"><div class="history-dot"></div>${STATUS[h.status]?.label || h.status} — ${fmtDate(h.changed_at)}</div>`
    ).join('');

    result.innerHTML = `
      <div class="track-found-card">
        <div class="pkg-top" style="margin-bottom:12px">
          <div class="pkg-tracking">
            <div class="pkg-track-label">Трек-номер</div>
            <div class="pkg-track-row">
              <span class="pkg-track-num">${p.tracking_number}</span>
              <button class="copy-btn" data-copy="${p.tracking_number}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
          </div>
          ${statusBadge(p.status)}
        </div>
        <div class="pkg-details">
          <div class="pkg-detail-item"><div class="pkg-detail-label">Вес</div><div class="pkg-detail-val">${p.weight} кг</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">Тариф</div><div class="pkg-detail-val">${rate.type}</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">₽/кг</div><div class="pkg-detail-val">${fmt(rate.rate)} ₽</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">Стоимость</div><div class="pkg-detail-val">~${fmt(total)} ₽</div></div>
        </div>
        ${historyHtml ? `<div class="track-history"><div class="track-history-title">История</div>${historyHtml}</div>` : ''}
        ${(unclaimed || owned) && !state.user?.is_admin
          ? `<button class="btn-claim" data-claim-id="${p.id}">${unclaimed ? 'Привязать к моему аккаунту' : '✅ Ваша посылка'}</button>`
          : ''}
      </div>`;

    // Claim button
    const claimBtn = result.querySelector('.btn-claim');
    if (claimBtn && unclaimed) {
      claimBtn.addEventListener('click', () => claimPackage(p.id));
    }
  } catch (e) {
    result.innerHTML = `<div class="track-not-found">
      <div style="font-size:32px;margin-bottom:8px">🔍</div>
      <div style="font-weight:600;margin-bottom:4px">Посылка не найдена</div>
      <div style="font-size:12px;color:var(--text3)">Проверьте трек-номер или свяжитесь с менеджером</div>
    </div>`;
  }
}

async function claimPackage(id) {
  try {
    await apiFetch(`/api/claim/${id}`, { method: 'POST' });
    toast('Посылка привязана к вашему аккаунту', 'success');
    document.getElementById('track-result').innerHTML = '';
    document.getElementById('track-input').value = '';
    loadPackages();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── Rates Tab ───────────────────────────────────────────────────── */
async function loadRates() {
  const container = document.getElementById('rates-list');
  try {
    const rates = await fetch('/api/rates').then(r => r.json());
    container.innerHTML = rates.map(c => `
      <div class="country-card">
        <div class="country-header">
          <div class="country-flag">${c.flag}</div>
          <div class="country-info">
            <div class="country-name">${c.name}</div>
            <div class="country-route">🏭 ${c.warehouse} → Москва</div>
          </div>
          <div class="country-badge">⏱ ${c.delivery_days}</div>
        </div>
        <table class="rates-table">
          <thead><tr><th>Тариф</th><th>Условие</th><th>Цена</th></tr></thead>
          <tbody>
            ${c.rates.map(r => `
              <tr>
                <td>${r.name}</td>
                <td><span class="rate-condition">${r.condition}</span></td>
                <td>${fmt(r.price)} ₽/кг</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="stores-section">
          <div class="stores-label">Популярные магазины</div>
          <div class="stores-list">
            ${c.popular_stores.map(s => `<span class="store-chip">${s}</span>`).join('')}
          </div>
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Не удалось загрузить тарифы</div></div>`;
  }
}

/* ── Admin Modal ─────────────────────────────────────────────────── */
function openAddModal() {
  state.editingId = null;
  document.getElementById('modal-title').textContent = 'Добавить посылку';
  document.getElementById('pkg-form').reset();
  document.getElementById('pkg-id').value = '';
  document.getElementById('pkg-status').value = 'received';
  showModal();
}

function openEditModal(pkg) {
  state.editingId = pkg.id;
  document.getElementById('modal-title').textContent = 'Редактировать посылку';
  document.getElementById('pkg-id').value = pkg.id;
  document.getElementById('pkg-tracking').value = pkg.tracking_number;
  document.getElementById('pkg-weight').value = pkg.weight;
  document.getElementById('pkg-client-id').value = pkg.client_id || '';
  document.getElementById('pkg-client-username').value = pkg.client_username ? '@' + pkg.client_username : '';
  document.getElementById('pkg-client-name').value = pkg.client_name || '';
  document.getElementById('pkg-status').value = pkg.status;
  document.getElementById('pkg-description').value = pkg.description || '';
  showModal();
}

function showModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.style.opacity = '1');
  document.body.style.overflow = 'hidden';
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('form-submit');
  btn.disabled = true;
  btn.textContent = 'Сохраняем…';

  const body = {
    tracking_number: document.getElementById('pkg-tracking').value.trim(),
    weight: parseFloat(document.getElementById('pkg-weight').value),
    client_id: document.getElementById('pkg-client-id').value.trim() || undefined,
    client_username: document.getElementById('pkg-client-username').value.trim() || undefined,
    client_name: document.getElementById('pkg-client-name').value.trim() || undefined,
    status: document.getElementById('pkg-status').value,
    description: document.getElementById('pkg-description').value.trim() || undefined,
  };

  try {
    if (state.editingId) {
      await apiFetch(`/api/packages/${state.editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('Посылка обновлена', 'success');
    } else {
      await apiFetch('/api/packages', { method: 'POST', body: JSON.stringify(body) });
      toast('Посылка добавлена', 'success');
    }
    hideModal();
    loadPackages();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
  }
}

async function deletePackage(id) {
  if (!confirm('Удалить посылку?')) return;
  try {
    await apiFetch(`/api/packages/${id}`, { method: 'DELETE' });
    toast('Посылка удалена', 'success');
    loadPackages();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── Navigation ──────────────────────────────────────────────────── */
function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'rates' && !document.getElementById('rates-list').innerHTML) loadRates();
}

/* ── Toast ───────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

/* ── Clipboard ───────────────────────────────────────────────────── */
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Скопировано!'));
  } else {
    const el = document.createElement('textarea');
    el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
    document.body.appendChild(el); el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    toast('Скопировано!');
  }
}

/* ── Calculator ──────────────────────────────────────────────────── */
function setupCalc() {
  const input = document.getElementById('calc-weight');
  const result = document.getElementById('calc-result');
  const typeEl = document.getElementById('calc-type');
  const kgEl = document.getElementById('calc-kg');
  const wEl = document.getElementById('calc-w');
  const totalEl = document.getElementById('calc-total');

  input.addEventListener('input', () => {
    const w = parseFloat(input.value);
    if (!w || w <= 0) { result.style.display = 'none'; return; }
    const r = calcRate(w);
    const total = Math.round(w * r.rate);
    typeEl.textContent = r.type;
    kgEl.textContent = fmt(r.rate) + ' ₽/кг';
    wEl.textContent = w + ' кг';
    totalEl.textContent = fmt(total) + ' ₽';
    result.style.display = 'block';
  });
}

/* ── Event Delegation ────────────────────────────────────────────── */
document.addEventListener('click', e => {
  // Copy buttons
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) { copyText(copyBtn.dataset.copy); return; }

  // Copy my ID
  if (e.target.closest('#copy-my-id')) { copyText(document.getElementById('my-id-value').textContent); return; }

  // Nav tabs
  const navItem = e.target.closest('.nav-item');
  if (navItem) { switchTab(navItem.dataset.tab); return; }

  // Add package
  if (e.target.closest('#btn-add')) { openAddModal(); return; }

  // Edit status
  const editBtn = e.target.closest('.btn-edit-status');
  if (editBtn) {
    const pkg = state.packages.find(p => p.id === parseInt(editBtn.dataset.id));
    if (pkg) openEditModal(pkg);
    return;
  }

  // Delete
  const delBtn = e.target.closest('.btn-delete');
  if (delBtn) { deletePackage(parseInt(delBtn.dataset.id)); return; }

  // Modal close
  if (e.target.closest('#modal-close') || e.target.id === 'modal-overlay') { hideModal(); return; }

  // Stat chips
  const chip = e.target.closest('.stat-chip');
  if (chip) {
    document.querySelectorAll('.stat-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.adminFilter = chip.dataset.filter;
    loadPackages();
    return;
  }
});

// Track input
document.getElementById('track-btn').addEventListener('click', () => {
  doTrack(document.getElementById('track-input').value);
});
document.getElementById('track-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doTrack(document.getElementById('track-input').value);
});

// Admin search
document.getElementById('admin-search-input')?.addEventListener('input', e => {
  state.adminSearch = e.target.value;
  clearTimeout(state._searchTimer);
  state._searchTimer = setTimeout(loadPackages, 400);
});

// Package form
document.getElementById('pkg-form').addEventListener('submit', handleFormSubmit);

/* ── Init ────────────────────────────────────────────────────────── */
async function init() {
  // Simulate loading
  await new Promise(r => setTimeout(r, 1200));

  try {
    // Get current user
    state.user = await apiFetch('/api/me');

    // Show admin controls
    if (state.user.is_admin) {
      document.getElementById('btn-add').style.display = 'flex';
      document.getElementById('admin-stats').style.display = 'flex';
      document.getElementById('admin-search').style.display = 'flex';
      document.getElementById('packages-title').textContent = 'Все посылки';
    }

    // Set my ID
    document.getElementById('my-id-value').textContent = state.user.id;

    // Load packages
    await loadPackages();

    // Setup calculator
    setupCalc();

    // Show app
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

  } catch (e) {
    document.getElementById('loading').innerHTML = `
      <div style="text-align:center;padding:24px">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="color:var(--text2);font-size:14px">${e.message}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:8px">Проверьте соединение и перезагрузите</div>
      </div>`;
  }
}

init();
