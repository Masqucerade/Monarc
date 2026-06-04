/* ── Config ──────────────────────────────────────────────────────── */
const ADMIN_ID = '885394476';

const COUNTRIES = {
  eu: { flag: '🇪🇺', name: 'Европа'  },
  cn: { flag: '🇨🇳', name: 'Китай'   },
  jp: { flag: '🇯🇵', name: 'Япония'  },
};

// Tariffs per country (for manual selection)
const TARIFFS = {
  eu: null, // auto from weight
  cn: [
    { name: 'Авиа',     rate: 1200, label: '1 200 ₽/кг · 20–25 дн.' },
    { name: 'Экспресс', rate: 3500, label: '3 500 ₽/кг · 1–6 дн.'   },
    { name: 'Наземный', rate: 800,  label: '800 ₽/кг · 17–25 дн.'   },
  ],
  jp: [
    { name: 'Обычная', rate: 2000, label: '~2 000 ₽/кг · 25–30 дн.' },
    { name: 'Быстрая', rate: 4000, label: '~4 000 ₽/кг · ~2 нед.'   },
  ],
};

const STATUS = {
  pending:    { label: 'Ожидается',      cls: 'badge-pending'    },
  received:   { label: 'На складе',      cls: 'badge-received'   },
  processing: { label: 'Обрабатывается', cls: 'badge-processing' },
  shipped:    { label: 'В пути',         cls: 'badge-shipped'    },
  ready:      { label: 'Готово к выдаче',cls: 'badge-ready'      },
  delivered:  { label: 'Выдано',         cls: 'badge-delivered'  },
};

const INV_STATUS = {
  pending:   { label: '⏳ Ожидает оплаты',   cls: 'inv-badge-pending'   },
  reviewing: { label: '🔔 На проверке',       cls: 'inv-badge-reviewing' },
  paid:      { label: '✅ Оплачен',           cls: 'inv-badge-paid'      },
  cancelled: { label: '❌ Отменён',           cls: 'inv-badge-cancelled' },
};

/* ── State ───────────────────────────────────────────────────────── */
const state = {
  user: null,
  packages: [],
  invoices: [],
  currentTab: 'packages',
  currentView: 'packages', // 'packages' | 'invoices'
  adminFilter: 'all',
  adminSearch: '',
  editingId: null,
  calcCountry: 'eu',
  calcTariff: null,
  adminFormCountry: 'eu',
};

/* ── Telegram WebApp ─────────────────────────────────────────────── */
const tg = window.Telegram?.WebApp;
if (tg) { tg.expand(); tg.ready(); tg.enableClosingConfirmation(); }

function getTgInitData() { return tg?.initData || ''; }
function haptic(style = 'light') { tg?.HapticFeedback?.impactOccurred(style); }

/* ── API ─────────────────────────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const initData = getTgInitData();
  const headers = {
    'Content-Type': 'application/json',
    'x-telegram-init-data': initData || 'dev',
    ...(options.headers || {}),
  };
  if (!initData) headers['x-dev-user-id'] = state.user?.id || ADMIN_ID;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function fmt(n) { return Number(n).toLocaleString('ru-RU'); }
function fmtDate(str) {
  return new Date(str).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function calcRate(weight, country = 'eu') {
  if (!weight || weight <= 0) return { type: '—', rate: 0 };
  if (country === 'cn') {
    if (weight >= 20) return { type: 'Наземный', rate: 800 };
    return { type: 'Авиа', rate: 1200 };
  }
  if (country === 'jp') return { type: 'Обычная', rate: 2000 };
  if (weight <= 5)  return { type: 'Экспресс',    rate: 1900 };
  if (weight <= 20) return { type: 'Наземный',     rate: 1750 };
  return                   { type: 'Сборный груз', rate: 1300 };
}

function statusBadge(status) {
  const s = STATUS[status] || { label: status, cls: '' };
  return `<span class="status-badge ${s.cls}">${s.label}</span>`;
}

/* ── Package Card ────────────────────────────────────────────────── */
function pkgCard(p, isAdmin) {
  const country = p.country || 'eu';
  const c = COUNTRIES[country] || COUNTRIES.eu;
  const r = calcRate(p.weight, country);
  const total = r.rate > 0 ? Math.round((p.weight || 0) * r.rate) : 0;
  const isPending = p.status === 'pending';

  const shineEl = '';

  const detailsRow = isPending
    ? `<div style="font-size:13px;color:var(--text3);margin-bottom:12px;position:relative;z-index:1">Ожидаем поступления — менеджер обновит статус</div>`
    : `<div class="pkg-details">
        <div class="pkg-detail-item"><div class="pkg-detail-label">Вес</div><div class="pkg-detail-val">${p.weight > 0 ? p.weight + ' кг' : 'Не указан'}</div></div>
        <div class="pkg-detail-item"><div class="pkg-detail-label">Тариф</div><div class="pkg-detail-val">${r.rate > 0 ? r.type : '—'}</div></div>
        <div class="pkg-detail-item"><div class="pkg-detail-label">₽/кг</div><div class="pkg-detail-val">${r.rate > 0 ? fmt(r.rate) + ' ₽' : '—'}</div></div>
        <div class="pkg-detail-item"><div class="pkg-detail-label">Стоимость</div><div class="pkg-detail-val">${total > 0 ? '~' + fmt(total) + ' ₽' : '—'}</div></div>
      </div>`;

  const clientRow = isAdmin && (p.client_name || p.client_username || p.client_id)
    ? `<div class="pkg-client">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        ${p.client_name || ''}${p.client_username ? ' @' + p.client_username : ''}${!p.client_name && !p.client_username && p.client_id ? 'ID: ' + p.client_id : ''}
        ${p.source === 'client' ? '<span class="pkg-source-label">от клиента</span>' : ''}
      </div>`
    : '';

  const actionsRow = isAdmin
    ? `<div class="pkg-actions">
        <button class="btn-edit-status" data-id="${p.id}">Изменить / Редактировать</button>
        <button class="btn-delete" data-id="${p.id}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`
    : `<div class="pkg-actions">
        <button class="btn-client-remove" data-id="${p.id}" style="width:100%;padding:8px;border-radius:var(--radius-xs);background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.18);color:#f87171;font-size:13px;font-weight:500">
          Убрать из моего списка
        </button>
      </div>`;

  return `
    <div class="pkg-card status-${p.status}" data-id="${p.id}">
      ${shineEl}
      <div class="pkg-top">
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
      <div class="pkg-country"><span>${c.flag}</span>${c.name}</div>
      ${p.item_name ? `<div class="pkg-item-name">${p.item_name}</div>` : ''}
      ${detailsRow}
      ${clientRow}
      ${p.description ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;position:relative;z-index:1">${p.description}</div>` : ''}
      <div style="font-size:11px;color:var(--text3);position:relative;z-index:1">Добавлено: ${fmtDate(p.created_at)}</div>
      ${actionsRow}
    </div>`;
}

/* ── Invoice Card ────────────────────────────────────────────────── */
function fmtAmount(amount, currency) {
  if (currency === 'RUB') return Number(amount).toLocaleString('ru-RU') + ' ₽';
  if (currency === 'EUR') return Number(amount).toLocaleString('ru-RU') + ' €';
  return amount + ' USDT';
}

function invoiceCard(inv, isAdmin) {
  const st = INV_STATUS[inv.status] || { label: inv.status, cls: '' };
  const clientRow = isAdmin
    ? `<div class="inv-client">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        ${inv.client_name || ''}${inv.client_username ? ' @' + inv.client_username : ''}${!inv.client_name && !inv.client_username && inv.client_id ? 'ID: ' + inv.client_id : ''}
      </div>`
    : '';

  const detailsBlock = inv.payment_details
    ? `<div class="inv-details-block">
        <div class="inv-details-label">📋 Реквизиты</div>
        <div class="inv-details-text">${inv.payment_details.replace(/\n/g, '<br>')}</div>
      </div>`
    : '';

  let actions = '';
  if (isAdmin) {
    if (inv.status === 'reviewing') {
      actions = `<div class="inv-actions">
        <button class="btn-inv-confirm" data-id="${inv.id}">✅ Подтвердить</button>
        <button class="btn-inv-cancel" data-id="${inv.id}">❌ Отклонить</button>
      </div>`;
    } else if (inv.status !== 'paid') {
      actions = `<div class="inv-actions">
        <button class="btn-inv-cancel" data-id="${inv.id}" style="width:100%">Отменить</button>
      </div>`;
    }
    actions += `<button class="btn-inv-delete" data-id="${inv.id}" title="Удалить">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    </button>`;
  } else if (inv.status === 'pending') {
    actions = `<div class="inv-actions">
      <button class="btn-inv-paid" data-id="${inv.id}" style="width:100%">Отметить оплаченным</button>
    </div>`;
  }

  return `
    <div class="inv-card inv-${inv.status}">
      <div class="inv-top">
        <div>
          <div class="inv-num">Счёт #${inv.id}</div>
          <div class="inv-amount">${fmtAmount(inv.amount, inv.currency)}</div>
        </div>
        <span class="inv-badge ${st.cls}">${st.label}</span>
      </div>
      <div class="inv-desc">${inv.description}</div>
      ${clientRow}
      ${detailsBlock}
      <div class="inv-date">Выставлен: ${fmtDate(inv.created_at)}</div>
      ${actions}
    </div>`;
}

/* ── Invoices Tab ────────────────────────────────────────────────── */
async function loadInvoices() {
  const list = document.getElementById('invoices-list');
  list.innerHTML = skeletonCards(2);
  try {
    state.invoices = await apiFetch('/api/invoices');
    renderInvoices();
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function renderInvoices() {
  const list = document.getElementById('invoices-list');
  const isAdmin = state.user?.is_admin;
  if (!state.invoices.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">💰</div>
      <div class="empty-title">${isAdmin ? 'Счетов нет' : 'Счетов нет'}</div>
      <div class="empty-sub">${isAdmin ? 'Нажмите «+» чтобы выставить счёт' : 'Когда менеджер выставит счёт — он появится здесь'}</div>
    </div>`;
    return;
  }
  list.innerHTML = state.invoices.map(inv => invoiceCard(inv, isAdmin)).join('');
}

/* ── View toggle ─────────────────────────────────────────────────── */
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view-pill').forEach(p => p.classList.toggle('active', p.dataset.view === view));

  const pkgList  = document.getElementById('packages-list');
  const invList  = document.getElementById('invoices-list');
  const stats    = document.getElementById('admin-stats');
  const search   = document.getElementById('admin-search');

  if (view === 'packages') {
    pkgList.style.display = ''; invList.style.display = 'none';
    if (state.user?.is_admin) { stats.style.display = 'flex'; search.style.display = 'flex'; }
  } else {
    pkgList.style.display = 'none'; invList.style.display = '';
    if (stats) stats.style.display = 'none';
    if (search) search.style.display = 'none';
    loadInvoices();
  }
  haptic('light');
}

/* ── Invoice Modal ───────────────────────────────────────────────── */
function openInvoiceModal() {
  document.getElementById('invoice-form').reset();
  showModal('invoice-modal-overlay');
}

async function handleInvoiceFormSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('invoice-form-submit');
  btn.disabled = true; btn.textContent = 'Отправляем…';
  try {
    await apiFetch('/api/invoices', {
      method: 'POST',
      body: JSON.stringify({
        client:          document.getElementById('inv-client').value.trim() || undefined,
        amount:          parseFloat(document.getElementById('inv-amount').value),
        currency:        document.getElementById('inv-currency').value,
        description:     document.getElementById('inv-description').value.trim(),
        payment_details: document.getElementById('inv-details').value.trim() || undefined,
      }),
    });
    toast('Счёт выставлен', 'success');
    haptic('medium');
    hideModal('invoice-modal-overlay');
    loadInvoices();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Выставить счёт'; }
}

/* ── Skeleton cards ──────────────────────────────────────────────── */
function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => `
    <div class="pkg-card" style="pointer-events:none">
      <div class="pkg-top">
        <div>
          <div class="skel" style="width:78px;height:10px;margin-bottom:8px"></div>
          <div class="skel" style="width:175px;height:18px"></div>
        </div>
        <div class="skel" style="width:90px;height:24px;border-radius:99px"></div>
      </div>
      <div class="skel" style="width:68px;height:12px;margin:4px 0 14px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-bottom:10px">
        ${Array.from({length:4}, () => `<div>
          <div class="skel" style="width:38px;height:9px;margin-bottom:6px"></div>
          <div class="skel" style="width:62px;height:16px"></div>
        </div>`).join('')}
      </div>
      <div class="skel" style="width:115px;height:10px;margin-top:4px"></div>
    </div>`).join('');
}

/* ── Packages Tab ────────────────────────────────────────────────── */
async function loadPackages() {
  const list = document.getElementById('packages-list');
  list.innerHTML = skeletonCards();
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
      <div class="empty-sub">${isAdmin ? 'Нажмите «+» чтобы добавить' : 'Перейдите в «Поиск» и добавьте трек'}</div>
    </div>`;
    return;
  }
  list.innerHTML = state.packages.map(p => pkgCard(p, isAdmin)).join('');
}

async function loadStats() {
  try {
    const s = await apiFetch('/api/stats');
    document.getElementById('stat-total').textContent = s.total;
    document.getElementById('stat-pending').textContent = s.pending;
    document.getElementById('stat-received').textContent = s.received;
    document.getElementById('stat-shipped').textContent = s.shipped;
    document.getElementById('stat-ready').textContent = s.ready;
  } catch {}
}

/* ── Track Tab ───────────────────────────────────────────────────── */
async function doTrack(number) {
  const result = document.getElementById('track-result');
  if (!number.trim()) return;
  result.innerHTML = skeletonCards(1);
  try {
    const p = await apiFetch(`/api/track/${encodeURIComponent(number.trim().toUpperCase())}`);
    const country = p.country || 'eu';
    const c = COUNTRIES[country] || COUNTRIES.eu;
    const r = calcRate(p.weight, country);
    const total = r.rate > 0 ? Math.round((p.weight || 0) * r.rate) : 0;
    const owned = p.client_id === state.user?.id;
    const unclaimed = !p.client_id;
    const historyHtml = (p.history || []).map(h =>
      `<div class="history-item"><div class="history-dot"></div>${STATUS[h.status]?.label || h.status} — ${fmtDate(h.changed_at)}</div>`
    ).join('');

    result.innerHTML = `
      <div class="track-found-card">
        <div class="pkg-top" style="margin-bottom:8px">
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
        <div class="pkg-country" style="margin-bottom:12px"><span>${c.flag}</span>${c.name}</div>
        ${p.weight > 0 ? `<div class="pkg-details">
          <div class="pkg-detail-item"><div class="pkg-detail-label">Вес</div><div class="pkg-detail-val">${p.weight} кг</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">Тариф</div><div class="pkg-detail-val">${r.type}</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">₽/кг</div><div class="pkg-detail-val">${fmt(r.rate)} ₽</div></div>
          <div class="pkg-detail-item"><div class="pkg-detail-label">Стоимость</div><div class="pkg-detail-val">~${fmt(total)} ₽</div></div>
        </div>` : ''}
        ${historyHtml ? `<div class="track-history"><div class="track-history-title">История</div>${historyHtml}</div>` : ''}
        ${(unclaimed || owned) && !state.user?.is_admin
          ? `<button class="btn-claim" data-claim-id="${p.id}">${owned ? '✅ Ваша посылка' : 'Привязать к моему аккаунту'}</button>`
          : ''}
      </div>`;

    const claimBtn = result.querySelector('[data-claim-id]');
    if (claimBtn && unclaimed) claimBtn.addEventListener('click', () => claimPackage(p.id));
  } catch {
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
  } catch (e) { toast(e.message, 'error'); }
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
          <div>
            <div class="country-name">${c.name}</div>
            <div class="country-route">${c.warehouse} → Москва</div>
          </div>
          <div class="country-badge">⏱ ${c.delivery_days}</div>
        </div>
        <table class="rates-table">
          <thead><tr><th>Тариф</th><th>Срок / Условие</th><th>Цена</th></tr></thead>
          <tbody>
            ${c.rates.map(r => `<tr>
              <td>${r.name}</td>
              <td><span class="rate-condition">${r.condition}</span></td>
              <td>${fmt(r.price)} ₽/кг</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${c.note ? `<div class="rates-note">${c.note}</div>` : ''}
        <div class="stores-section">
          <div class="stores-label">Популярные магазины</div>
          <div class="stores-list">${c.popular_stores.map(s => `<span class="store-chip">${s}</span>`).join('')}</div>
        </div>
      </div>`).join('');
  } catch {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Не удалось загрузить тарифы</div></div>`;
  }
}

/* ── Warehouse tabs ──────────────────────────────────────────────── */
function setupWarehouseTabs() {
  const tabs = document.querySelectorAll('.i-wh-tab');
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.i-wh-panel').forEach(p => { p.style.display = 'none'; });
      const panel = document.getElementById('wh-' + tab.dataset.wh);
      if (panel) { panel.style.display = 'block'; }
      haptic('light');
    });
  });
}

/* ── Calculator ──────────────────────────────────────────────────── */
function setupCalc() {
  const weightInput  = document.getElementById('calc-weight');
  const resultEl     = document.getElementById('calc-result');
  const tariffWrap   = document.getElementById('calc-tariff-wrap');
  const tariffPills  = document.getElementById('calc-tariff-pills');

  function renderTariffPills(country) {
    const tariffs = TARIFFS[country];
    if (!tariffs) { tariffWrap.style.display = 'none'; state.calcTariff = null; return; }
    state.calcTariff = tariffs[0];
    tariffWrap.style.display = 'flex';
    tariffPills.innerHTML = tariffs.map((t, i) => `
      <button class="tariff-pill ${i === 0 ? 'active' : ''}" data-idx="${i}">
        <span>${t.name}</span>
        <span class="pill-price">${t.label}</span>
      </button>`).join('');

    tariffPills.querySelectorAll('.tariff-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        tariffPills.querySelectorAll('.tariff-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.calcTariff = TARIFFS[state.calcCountry][parseInt(btn.dataset.idx)];
        updateCalc();
      });
    });
  }

  function updateCalc() {
    const w = parseFloat(weightInput.value);
    resultEl.style.display = 'none';
    if (!w || w <= 0) return;

    let type, rate;
    if (state.calcCountry === 'eu') {
      const r = calcRate(w, 'eu');
      type = r.type; rate = r.rate;
    } else {
      if (!state.calcTariff) return;
      type = state.calcTariff.name; rate = state.calcTariff.rate;
    }

    const total = Math.round(w * rate);
    document.getElementById('calc-type').textContent = type;
    document.getElementById('calc-kg').textContent = fmt(rate) + ' ₽/кг';
    document.getElementById('calc-w').textContent = w + ' кг';
    document.getElementById('calc-total').textContent = fmt(total) + ' ₽';
    resultEl.style.display = 'block';
  }

  // Country pills
  document.querySelectorAll('.country-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.country-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.calcCountry = pill.dataset.country;
      renderTariffPills(state.calcCountry);
      weightInput.value = '';
      resultEl.style.display = 'none';
      haptic('light');
    });
  });

  weightInput.addEventListener('input', updateCalc);
  renderTariffPills('eu');
}

/* ── Admin form tariff selector ──────────────────────────────────── */
function updateAdminTariffSelector(country) {
  const wrap = document.getElementById('pkg-tariff-wrap');
  const sel  = document.getElementById('pkg-tariff');
  const tariffs = TARIFFS[country];
  if (!tariffs) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  sel.innerHTML = tariffs.map(t => `<option value="${t.name}|${t.rate}">${t.name} — ${t.label}</option>`).join('');
}

/* ── Admin Modal ─────────────────────────────────────────────────── */
function openAddModal() {
  state.editingId = null;
  document.getElementById('modal-title').textContent = 'Добавить посылку';
  document.getElementById('pkg-form').reset();
  document.getElementById('pkg-id').value = '';
  document.getElementById('pkg-status').value = 'received';
  document.getElementById('pkg-country').value = 'eu';
  updateAdminTariffSelector('eu');
  showModal('modal-overlay');
}

function openEditModal(pkg) {
  state.editingId = pkg.id;
  document.getElementById('modal-title').textContent = 'Редактировать посылку';
  document.getElementById('pkg-id').value = pkg.id;
  document.getElementById('pkg-tracking').value = pkg.tracking_number;
  document.getElementById('pkg-item-name').value = pkg.item_name || '';
  document.getElementById('pkg-weight').value = pkg.weight || '';
  document.getElementById('pkg-country').value = pkg.country || 'eu';
  document.getElementById('pkg-client-id').value = pkg.client_id || '';
  document.getElementById('pkg-client-username').value = pkg.client_username ? '@' + pkg.client_username : '';
  document.getElementById('pkg-client-name').value = pkg.client_name || '';
  document.getElementById('pkg-status').value = pkg.status;
  document.getElementById('pkg-description').value = pkg.description || '';
  updateAdminTariffSelector(pkg.country || 'eu');
  showModal('modal-overlay');
}

// Country change in admin form
document.getElementById('pkg-country')?.addEventListener('change', e => {
  updateAdminTariffSelector(e.target.value);
});

function showModal(id) {
  document.getElementById(id).style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function hideModal(id) {
  document.getElementById(id).style.display = 'none';
  document.body.style.overflow = '';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('form-submit');
  btn.disabled = true; btn.textContent = 'Сохраняем…';

  const country = document.getElementById('pkg-country').value;
  const tariffRaw = document.getElementById('pkg-tariff')?.value;
  let tariff_type, tariff_rate;
  if (tariffRaw && tariffRaw.includes('|')) {
    [tariff_type, tariff_rate] = tariffRaw.split('|');
    tariff_rate = parseFloat(tariff_rate);
  }

  const weightVal = parseFloat(document.getElementById('pkg-weight').value);
  const body = {
    tracking_number: document.getElementById('pkg-tracking').value.trim(),
    item_name: document.getElementById('pkg-item-name').value.trim() || undefined,
    weight: isNaN(weightVal) ? 0 : weightVal,
    country,
    tariff_type: tariff_type || undefined,
    tariff_rate: tariff_rate || undefined,
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
    haptic('medium');
    hideModal('modal-overlay');
    loadPackages();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
}

/* ── Client Add Modal ────────────────────────────────────────────── */
async function handleClientFormSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('client-form-submit');
  btn.disabled = true; btn.textContent = 'Добавляем…';
  const body = {
    tracking_number: document.getElementById('client-pkg-tracking').value.trim(),
    country: document.getElementById('client-pkg-country').value || undefined,
    description: document.getElementById('client-pkg-description').value.trim() || undefined,
  };
  try {
    await apiFetch('/api/my-packages', { method: 'POST', body: JSON.stringify(body) });
    toast('Трек-номер добавлен', 'success');
    haptic('medium');
    hideModal('client-modal-overlay');
    document.getElementById('client-pkg-form').reset();
    loadPackages();
    switchTab('packages');
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Добавить'; }
}

async function deletePackage(id) {
  if (!confirm('Удалить посылку?')) return;
  try {
    await apiFetch(`/api/packages/${id}`, { method: 'DELETE' });
    toast('Посылка удалена', 'success');
    loadPackages();
  } catch (e) { toast(e.message, 'error'); }
}

async function clientRemovePackage(id) {
  if (!confirm('Убрать посылку из вашего списка?')) return;
  try {
    await apiFetch(`/api/my-packages/${id}`, { method: 'DELETE' });
    toast('Посылка убрана из списка', 'success');
    loadPackages();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Backup ──────────────────────────────────────────────────────── */
async function downloadBackup() {
  try {
    const initData = getTgInitData();
    const headers = { 'x-telegram-init-data': initData || 'dev' };
    if (!initData) headers['x-dev-user-id'] = state.user?.id || ADMIN_ID;
    const res = await fetch('/api/admin/backup', { headers });
    if (!res.ok) throw new Error('Ошибка');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().split('T')[0];
    a.href = url; a.download = `monarc-backup-${date}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('Резервная копия скачана', 'success');
  } catch (e) { toast('Ошибка скачивания', 'error'); }
}

async function restoreBackup(file) {
  if (!file) return;
  const msg = `Восстановить базу из "${file.name}"? Текущие данные будут заменены.`;
  const confirmed = await new Promise(resolve => {
    if (tg?.showConfirm) tg.showConfirm(msg, ok => resolve(ok));
    else resolve(confirm(msg));
  });
  if (!confirmed) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await apiFetch('/api/admin/restore', { method: 'POST', body: JSON.stringify({ data }) });
    toast(`Восстановлено ${data.packages?.length || 0} посылок`, 'success');
    loadPackages();
  } catch (e) { toast('Ошибка восстановления — проверьте файл', 'error'); }
}

/* ── Navigation ──────────────────────────────────────────────────── */
function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'rates' && !document.getElementById('rates-list').innerHTML) loadRates();
  haptic('light');
}

/* ── Toast ───────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

/* ── Clipboard ───────────────────────────────────────────────────── */
function copyText(text) {
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast('Скопировано!')); return; }
  const el = document.createElement('textarea');
  el.value = text; el.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(el); el.select(); document.execCommand('copy');
  document.body.removeChild(el); toast('Скопировано!');
}

/* ── Events ──────────────────────────────────────────────────────── */
document.addEventListener('click', async e => {
  if (e.target.closest('[data-copy]')) { copyText(e.target.closest('[data-copy]').dataset.copy); return; }
  if (e.target.closest('#copy-my-id')) { copyText(document.getElementById('my-id-value').textContent); return; }

  const nav = e.target.closest('.nav-item');
  if (nav) { switchTab(nav.dataset.tab); return; }

  const viewPill = e.target.closest('.view-pill');
  if (viewPill) { switchView(viewPill.dataset.view); return; }

  if (e.target.closest('#btn-add')) {
    state.currentView === 'invoices' ? openInvoiceModal() : openAddModal();
    return;
  }
  if (e.target.closest('#btn-add-client')) { showModal('client-modal-overlay'); return; }

  const invPaidBtn = e.target.closest('.btn-inv-paid');
  if (invPaidBtn) {
    const id = parseInt(invPaidBtn.dataset.id);
    const msg = 'Отметить счёт как оплаченный?';
    const doIt = async () => {
      try {
        await apiFetch(`/api/invoices/${id}/mark-paid`, { method: 'POST' });
        toast('Оплата отмечена — ожидайте подтверждения', 'success');
        haptic('medium'); loadInvoices();
      } catch (err) { toast(err.message, 'error'); }
    };
    if (tg?.showConfirm) tg.showConfirm(msg, ok => { if (ok) doIt(); });
    else if (confirm(msg)) doIt();
    return;
  }

  const invConfirmBtn = e.target.closest('.btn-inv-confirm');
  if (invConfirmBtn) {
    try {
      await apiFetch(`/api/invoices/${parseInt(invConfirmBtn.dataset.id)}/confirm`, { method: 'POST' });
      toast('Оплата подтверждена', 'success'); haptic('medium'); loadInvoices();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const invCancelBtn = e.target.closest('.btn-inv-cancel');
  if (invCancelBtn) {
    try {
      await apiFetch(`/api/invoices/${parseInt(invCancelBtn.dataset.id)}/cancel`, { method: 'POST' });
      toast('Счёт отменён', 'success'); loadInvoices();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const invDeleteBtn = e.target.closest('.btn-inv-delete');
  if (invDeleteBtn) {
    const doDelete = async () => {
      try {
        await apiFetch(`/api/invoices/${parseInt(invDeleteBtn.dataset.id)}`, { method: 'DELETE' });
        toast('Счёт удалён', 'success'); loadInvoices();
      } catch (err) { toast(err.message, 'error'); }
    };
    const msg = 'Удалить счёт?';
    if (tg?.showConfirm) tg.showConfirm(msg, ok => { if (ok) doDelete(); });
    else if (confirm(msg)) doDelete();
    return;
  }

  const editBtn = e.target.closest('.btn-edit-status');
  if (editBtn) {
    const pkg = state.packages.find(p => p.id === parseInt(editBtn.dataset.id));
    if (pkg) openEditModal(pkg);
    return;
  }

  const delBtn = e.target.closest('.btn-delete');
  if (delBtn) { deletePackage(parseInt(delBtn.dataset.id)); return; }

  const removeBtn = e.target.closest('.btn-client-remove');
  if (removeBtn) { clientRemovePackage(parseInt(removeBtn.dataset.id)); return; }

  if (e.target.closest('#modal-close') || e.target.id === 'modal-overlay')               { hideModal('modal-overlay'); return; }
  if (e.target.closest('#client-modal-close') || e.target.id === 'client-modal-overlay') { hideModal('client-modal-overlay'); return; }
  if (e.target.closest('#invoice-modal-close') || e.target.id === 'invoice-modal-overlay') { hideModal('invoice-modal-overlay'); return; }

  const chip = e.target.closest('.stat-chip');
  if (chip) {
    document.querySelectorAll('.stat-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.adminFilter = chip.dataset.filter;
    loadPackages();
  }
});

document.getElementById('track-btn').addEventListener('click', () => doTrack(document.getElementById('track-input').value));
document.getElementById('track-input').addEventListener('keydown', e => { if (e.key === 'Enter') doTrack(document.getElementById('track-input').value); });
document.getElementById('admin-search-input')?.addEventListener('input', e => {
  state.adminSearch = e.target.value;
  clearTimeout(state._st);
  state._st = setTimeout(loadPackages, 400);
});
document.getElementById('pkg-form').addEventListener('submit', handleFormSubmit);
document.getElementById('client-pkg-form').addEventListener('submit', handleClientFormSubmit);
document.getElementById('invoice-form').addEventListener('submit', handleInvoiceFormSubmit);

/* ── Init ────────────────────────────────────────────────────────── */
async function init() {
  if (!tg?.initData) {
    await new Promise(r => setTimeout(r, 1200));
    document.getElementById('loading').innerHTML = `
      <div style="text-align:center;padding:32px 24px;max-width:320px;position:relative;z-index:1">
        <div style="font-size:52px;margin-bottom:20px">✈️</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:26px;font-weight:900;letter-spacing:5px;
          background:linear-gradient(135deg,#fff,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;
          margin-bottom:6px">MONARC</div>
        <div style="color:#94a3b8;font-size:13px;margin-bottom:28px">Cargo Delivery</div>
        <div style="color:#f1f5f9;font-size:15px;font-weight:600;margin-bottom:8px">Откройте в Telegram</div>
        <div style="color:#64748b;font-size:13px;line-height:1.6;margin-bottom:28px">
          Это Telegram Mini App — работает только внутри Telegram
        </div>
        <a href="https://t.me/euro_monarc"
          style="display:inline-block;padding:12px 28px;border-radius:12px;
          background:linear-gradient(135deg,#6d28d9,#8b5cf6);color:#fff;
          font-weight:700;font-size:14px;text-decoration:none">
          Написать менеджеру →
        </a>
      </div>`;
    return;
  }

  await new Promise(r => setTimeout(r, 1200));

  try {
    state.user = await apiFetch('/api/me');

    if (state.user.is_admin) {
      document.getElementById('btn-add').style.display = 'flex';
      document.getElementById('admin-stats').style.display = 'flex';
      document.getElementById('admin-search').style.display = 'flex';
      document.getElementById('admin-backup').style.display = 'block';
      document.getElementById('packages-title').textContent = 'Все посылки';

      // Export info: live table, Google Sheets formula, CSV
      apiFetch('/api/admin/export-info').then(info => {
        state.exportInfo = info;
        document.getElementById('btn-live-table').addEventListener('click', () => {
          window.open(info.live_url, '_blank');
        });
        document.getElementById('btn-copy-formula').addEventListener('click', () => {
          copyText(info.sheets_formula);
          toast('Формула скопирована — вставьте в ячейку A1 Google Sheets', 'success');
        });
        document.getElementById('btn-csv').addEventListener('click', () => {
          window.open(info.csv_url, '_blank');
        });
      }).catch(() => {});

      // Backup handlers
      document.getElementById('btn-backup').addEventListener('click', downloadBackup);
      document.getElementById('btn-backup-tg').addEventListener('click', async () => {
        const btn = document.getElementById('btn-backup-tg');
        btn.disabled = true; btn.textContent = 'Отправляем…';
        try {
          await apiFetch('/api/admin/backup-tg', { method: 'POST' });
          toast('Бэкап отправлен в Telegram', 'success');
          haptic('medium');
        } catch (e) { toast('Ошибка отправки', 'error'); }
        finally {
          btn.disabled = false;
          btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 6.628 5.374 12 12 12s12-5.372 12-12c0-6.627-5.374-12-12-12zm5.562 8.248l-1.97 9.269c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.17 14.463l-2.95-.924c-.642-.204-.657-.642.136-.953l11.57-4.461c.537-.194 1.006.131.636.123z"/></svg> Telegram`;
        }
      });
      document.getElementById('restore-file').addEventListener('change', e => {
        restoreBackup(e.target.files[0]);
        e.target.value = '';
      });
    } else {
      document.getElementById('btn-add-client').style.display = 'flex';
    }

    document.getElementById('my-id-value').textContent = state.user.id;

    await loadPackages();
    setupCalc();
    setupWarehouseTabs();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
  } catch (e) {
    document.getElementById('loading').innerHTML = `
      <div style="text-align:center;padding:24px;position:relative;z-index:1">
        <div style="font-size:44px;margin-bottom:16px">⚠️</div>
        <div style="color:#94a3b8;font-size:14px">${e.message}</div>
        <div style="font-size:12px;color:#475569;margin-top:8px">Перезагрузите приложение</div>
      </div>`;
  }
}

init();
