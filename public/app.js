/* ── Config ──────────────────────────────────────────────────────── */
const ADMIN_ID = '885394476';

const COUNTRIES = {
  eu: { flag: '🇪🇺', name: 'Европа'  },
  cn: { flag: '🇨🇳', name: 'Китай'   },
  jp: { flag: '🇯🇵', name: 'Япония'  },
};

// Tariffs per country (for manual selection)
const TARIFFS = {
  eu: null, // для публичного калькулятора — авто по весу
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
  delivered:  { label: 'Завершён', cls: 'badge-delivered' },
};

const INV_STATUS = {
  pending:   { label: '⏳ Ожидает оплаты',   cls: 'inv-badge-pending'   },
  reviewing: { label: '🔔 На проверке',       cls: 'inv-badge-reviewing' },
  paid:      { label: '✅ Оплачен',           cls: 'inv-badge-paid'      },
  cancelled: { label: '❌ Отменён',           cls: 'inv-badge-cancelled' },
};

/* ── State ───────────────────────────────────────────────────────── */
let currentPhotoPackageId = null;

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

/* ── Photo lightbox ──────────────────────────────────────────────── */
function openPhotoLightbox(src, label) {
  const lb = document.getElementById('photo-lightbox');
  document.getElementById('photo-lb-img').src = src;
  document.getElementById('photo-lb-label').textContent = label || '';
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  haptic('light');
}
function closePhotoLightbox() {
  const lb = document.getElementById('photo-lightbox');
  lb.style.display = 'none';
  document.getElementById('photo-lb-img').src = '';
  document.body.style.overflow = '';
}

/* ── Image helpers ───────────────────────────────────────────────── */
function resizeImage(file, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ── Package Card ────────────────────────────────────────────────── */
function pkgCard(p, isAdmin) {
  const country = p.country || 'eu';
  const c = COUNTRIES[country] || COUNTRIES.eu;
  // Используем сохранённый тариф если он есть, иначе пересчитываем
  const r = (p.type && p.rate) ? { type: p.type, rate: p.rate } : calcRate(p.weight, country);
  const total = p.total || (r.rate > 0 ? Math.round((p.weight || 0) * r.rate) : 0);
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

  // Фото товара: админ видит сразу, клиент — кнопку «Посмотреть фото»
  const photoBlock = (!isPending && p.photo_url)
    ? isAdmin
      ? `<div class="pkg-photo-wrap">
          <img src="${p.photo_url}" class="pkg-photo-img" alt="Фото товара" loading="lazy" />
          <button class="btn-photo-delete" data-id="${p.id}" title="Удалить фото">✕</button>
        </div>`
      : `<button class="btn-view-photo" data-photo="${p.photo_url}"
            data-label="${p.tracking_number}${p.item_name ? ' · ' + p.item_name : ''}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <path d="m21 15-5-5L5 21"/>
          </svg>
          📸 Посмотреть фото товара
        </button>`
    : '';

  // Иконка-кнопка прикрепить/заменить фото (только для админа, не-pending)
  const photoIconBtn = (isAdmin && !isPending)
    ? `<button class="btn-photo-icon${p.photo_url ? ' has-photo' : ''}" data-pkg-id="${p.id}" title="${p.photo_url ? 'Заменить фото' : 'Прикрепить фото'}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      </button>`
    : '';

  const clientRow = isAdmin && (p.client_name || p.client_username || p.client_id)
    ? `<div class="pkg-client">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        ${p.client_name || ''}${p.client_username ? ' @' + p.client_username : ''}${!p.client_name && !p.client_username && p.client_id ? 'ID: ' + p.client_id : ''}
        ${p.source === 'client' ? '<span class="pkg-source-label">от клиента</span>' : ''}
      </div>`
    : '';

  const DLABELS = { yandex: 'Яндекс Доставка', cdek: 'СДЭК', pochta: 'Почта РФ' };
  const dr = p.delivery_request;
  const deliveryBlock = !isPending
    ? isAdmin
      ? dr?.status === 'filled'
        ? `<div class="pkg-delivery-info">
            <div class="pkg-delivery-title">📬 Данные доставки</div>
            <div class="pkg-delivery-type">${DLABELS[dr.delivery_type] || dr.delivery_type}</div>
            <div class="pkg-delivery-row">${dr.pickup_address}</div>
            <div class="pkg-delivery-row">${dr.phone}</div>
            ${dr.full_name ? `<div class="pkg-delivery-row">${dr.full_name}</div>` : ''}
          </div>`
        : dr?.status === 'pending'
          ? `<div class="pkg-delivery-pending">⏳ Ожидаем данные от клиента</div>`
          : '' // кнопка перенесена в строку действий
      : dr?.status === 'pending'
        ? `<button class="btn-fill-delivery" data-id="${p.id}">📬 Указать адрес доставки</button>`
        : dr?.status === 'filled'
          ? `<div class="pkg-delivery-done">✅ Данные доставки отправлены</div>`
          : ''
    : '';

  // Кнопка запроса доставки — иконка в строке с остальными кнопками
  const deliveryIconBtn = (isAdmin && !isPending && !dr)
    ? `<button class="btn-req-delivery btn-action-icon" data-id="${p.id}" title="Запросить доставку">📬</button>`
    : '';

  const actionsRow = isAdmin
    ? `<div class="pkg-actions">
        <button class="btn-edit-status" data-id="${p.id}">Редактировать</button>
        ${deliveryIconBtn}
        ${photoIconBtn}
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
            ${p.no_tracking
              ? `<span class="pkg-track-num pkg-no-track">Трек не получен</span>
                 ${isAdmin ? `<span class="pkg-no-track-id">${p.tracking_number}</span>` : ''}`
              : `<span class="pkg-track-num">${p.tracking_number}</span>
                 <button class="copy-btn" data-copy="${p.tracking_number}">
                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                 </button>`}
          </div>
        </div>
        ${statusBadge(p.status)}
      </div>
      <div class="pkg-country"><span>${c.flag}</span>${c.name}</div>
      ${p.item_name ? `<div class="pkg-item-name">${p.item_name}</div>` : ''}
      ${detailsRow}
      ${photoBlock}
      ${clientRow}
      ${p.description ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;position:relative;z-index:1">${p.description}</div>` : ''}
      ${deliveryBlock}
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
    } else if (inv.status === 'pending') {
      actions = `<div class="inv-actions">
        <button class="btn-inv-confirm" data-id="${inv.id}">✅ Оплачен</button>
        <button class="btn-inv-cancel" data-id="${inv.id}">❌ Отменить</button>
      </div>`;
    } else if (!['paid', 'cancelled'].includes(inv.status)) {
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

/* ── Invoice badge dot ───────────────────────────────────────────── */
function updateInvoiceBadge(invoices) {
  const dot = document.getElementById('inv-dot');
  if (!dot || state.user?.is_admin) return;
  const hasUnpaid = (invoices || state.invoices).some(inv => inv.status === 'pending');
  dot.style.display = hasUnpaid ? 'block' : 'none';
}

/* ── Invoices Tab ────────────────────────────────────────────────── */
async function loadInvoices() {
  const list = document.getElementById('invoices-list');
  list.innerHTML = skeletonCards(2);
  try {
    state.invoices = await apiFetch('/api/invoices');
    renderInvoices();
    updateInvoiceBadge(state.invoices);
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function renderInvoices() {
  const list = document.getElementById('invoices-list');
  const isAdmin = state.user?.is_admin;

  const active   = state.invoices.filter(inv => !['paid', 'cancelled'].includes(inv.status));
  const archived = state.invoices.filter(inv =>  ['paid', 'cancelled'].includes(inv.status));

  if (!active.length && !archived.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">💰</div>
      <div class="empty-title">Счетов нет</div>
      <div class="empty-sub">${isAdmin ? 'Нажмите «+» чтобы выставить счёт' : 'Когда менеджер выставит счёт — он появится здесь'}</div>
    </div>`;
    return;
  }

  let html = active.length
    ? active.map(inv => invoiceCard(inv, isAdmin)).join('')
    : `<div class="empty-state" style="padding:20px 0"><div class="empty-icon">✅</div><div class="empty-title">Активных счетов нет</div></div>`;

  if (archived.length) {
    html += `
      <button class="btn-archive-toggle" id="inv-archive-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
        Архив — ${archived.length} завершённых
        <svg class="archive-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div id="inv-archive-list" class="archive-list" style="display:none">
        ${archived.map(inv => invoiceCard(inv, isAdmin)).join('')}
      </div>`;
  }

  list.innerHTML = html;
  list.querySelectorAll('.inv-card').forEach((card, i) => {
    card.style.animationDelay = `${Math.min(i, 8) * 55}ms`;
  });

  document.getElementById('inv-archive-btn')?.addEventListener('click', () => {
    const al = document.getElementById('inv-archive-list');
    const btn = document.getElementById('inv-archive-btn');
    const open = al.style.display !== 'none';
    al.style.display = open ? 'none' : 'block';
    btn.querySelector('.archive-chevron').style.transform = open ? '' : 'rotate(180deg)';
    haptic('light');
  });
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
async function openInvoiceModal() {
  document.getElementById('invoice-form').reset();
  showModal('invoice-modal-overlay');
  loadClientTemplates();
  await loadPaymentTemplates();
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
  // Запоминаем статусы до обновления — для анимации изменений
  const prevStatuses = {};
  state.packages.forEach(p => { prevStatuses[p.id] = p.status; });

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
    animateChangedBadges(prevStatuses);
    if (state.user?.is_admin) loadStats();
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function animateChangedBadges(prev) {
  if (!Object.keys(prev).length) return;
  // setTimeout 0 гарантирует что DOM уже перерисован после renderPackages()
  setTimeout(() => {
    state.packages.forEach(pkg => {
      if (prev[pkg.id] && prev[pkg.id] !== pkg.status) {
        const badge = document.querySelector(`.pkg-card[data-id="${pkg.id}"] .status-badge`);
        if (badge) {
          badge.classList.remove('badge-pop');
          void badge.offsetWidth; // принудительный reflow → анимация стартует заново
          badge.classList.add('badge-pop');
          badge.addEventListener('animationend', () => badge.classList.remove('badge-pop'), { once: true });
        }
      }
    });
  }, 50); // небольшая задержка после рендера
}

function renderPackages() {
  const list = document.getElementById('packages-list');
  const isAdmin = state.user?.is_admin;

  const active   = state.packages.filter(p => p.status !== 'delivered');
  const archived = state.packages.filter(p => p.status === 'delivered');

  if (!active.length && !archived.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📭</div>
      <div class="empty-title">${isAdmin ? 'Посылок нет' : 'Ваших посылок нет'}</div>
      <div class="empty-sub">${isAdmin ? 'Нажмите «+» чтобы добавить' : 'Перейдите в «Поиск» и добавьте трек'}</div>
    </div>`;
    return;
  }

  let html = active.map(p => pkgCard(p, isAdmin)).join('');

  if (archived.length) {
    html += `
      <button class="btn-archive-toggle" id="pkg-archive-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
        Архив — ${archived.length} выданных
        <svg class="archive-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div id="pkg-archive-list" class="archive-list" style="display:none">
        ${archived.map(p => pkgCard(p, isAdmin)).join('')}
      </div>`;
  }

  list.innerHTML = html;
  list.querySelectorAll('.pkg-card').forEach((card, i) => {
    card.style.animationDelay = `${Math.min(i, 8) * 55}ms`;
  });

  document.getElementById('pkg-archive-btn')?.addEventListener('click', () => {
    const al = document.getElementById('pkg-archive-list');
    const btn = document.getElementById('pkg-archive-btn');
    const open = al.style.display !== 'none';
    al.style.display = open ? 'none' : 'block';
    btn.querySelector('.archive-chevron').style.transform = open ? '' : 'rotate(180deg)';
    haptic('light');
  });
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
    const r = (p.type && p.rate) ? { type: p.type, rate: p.rate } : calcRate(p.weight, country);
    const total = p.total || (r.rate > 0 ? Math.round((p.weight || 0) * r.rate) : 0);
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
              <td>${fmt(r.price)} ${c.price_unit || '₽/кг'}</td>
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
  document.getElementById('pkg-dup-hint').style.display = 'none';
  document.getElementById('pkg-status').value = 'received';
  document.getElementById('pkg-country').value = 'eu';
  updateAdminTariffSelector('eu');
  showModal('modal-overlay');
  renderClientChips();
}

function openEditModal(pkg) {
  state.editingId = pkg.id;
  document.getElementById('modal-title').textContent = 'Редактировать посылку';
  document.getElementById('pkg-dup-hint').style.display = 'none';
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
  // Восстанавливаем выбранный тариф
  if (pkg.tariff_type && pkg.tariff_rate) {
    const sel = document.getElementById('pkg-tariff');
    if (sel) sel.value = `${pkg.tariff_type}|${pkg.tariff_rate}`;
  }
  renderClientChips();
  showModal('modal-overlay');
}

// Country change in admin form
document.getElementById('pkg-country')?.addEventListener('change', e => {
  updateAdminTariffSelector(e.target.value);
});

// Duplicate detect — инлайн при вводе трек-номера
document.getElementById('pkg-tracking')?.addEventListener('input', e => {
  const val = e.target.value.trim().toUpperCase();
  const hint = document.getElementById('pkg-dup-hint');
  if (!hint) return;
  const editingId = state.editingId;
  const dup = val.length > 2 && val !== 'NO'
    ? state.packages.find(p => p.tracking_number === val && p.id !== editingId)
    : null;
  if (dup) {
    const who = dup.client_name || (dup.client_username ? '@' + dup.client_username : null) || 'без клиента';
    const st  = STATUS[dup.status]?.label || dup.status;
    hint.innerHTML = `⚠️ Уже есть: <b>${who}</b> · ${st}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
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

/* ── Delivery Modal ──────────────────────────────────────────────── */
let addressTemplates = [];
let currentDeliveryType = 'yandex';

async function loadAddressTemplates() {
  try {
    addressTemplates = await apiFetch('/api/address-templates');
    renderAddrChips();
  } catch {}
}

function renderAddrChips() {
  const row = document.getElementById('addr-tpl-chips');
  const wrap = document.getElementById('addr-tpl-wrap');
  if (!row || !wrap) return;
  if (!addressTemplates.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  row.innerHTML = addressTemplates.map(t =>
    `<button type="button" class="tpl-chip" data-addr-id="${t.id}">${t.name}</button>`
  ).join('');
  row.querySelectorAll('.tpl-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = addressTemplates.find(a => a.id === parseInt(btn.dataset.addrId));
      if (!t) return;
      // Set type pill
      currentDeliveryType = t.delivery_type;
      document.querySelectorAll('.delivery-type-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.type === t.delivery_type);
      });
      updateDeliveryNameWrap(t.delivery_type);
      document.getElementById('delivery-address').value = t.pickup_address;
      document.getElementById('delivery-phone').value = t.phone;
      document.getElementById('delivery-fullname').value = t.full_name || '';
      haptic('light');
    });
  });
}

function updateDeliveryNameWrap(type) {
  const wrap = document.getElementById('delivery-name-wrap');
  if (wrap) wrap.style.display = (type === 'yandex') ? 'none' : 'block';
}

function openDeliveryModal(pkgId) {
  const form = document.getElementById('delivery-form');
  form.reset();
  document.getElementById('delivery-pkg-id').value = pkgId;
  currentDeliveryType = 'yandex';
  document.querySelectorAll('.delivery-type-pill').forEach((p, i) => p.classList.toggle('active', i === 0));
  updateDeliveryNameWrap('yandex');
  // Сбрасываем toggle и поле имени шаблона
  document.getElementById('delivery-save-toggle')?.classList.remove('active');
  document.getElementById('delivery-tpl-name').style.display = 'none';
  document.getElementById('delivery-tpl-name').value = '';
  showModal('delivery-modal-overlay');
  loadAddressTemplates();
}

function setupDeliveryModal() {
  // Type pills
  document.querySelectorAll('.delivery-type-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.delivery-type-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDeliveryType = btn.dataset.type;
      updateDeliveryNameWrap(currentDeliveryType);
    });
  });

  // Toggle "Сохранить как шаблон" — кастомная кнопка вместо нативного чекбокса
  const saveToggle = document.getElementById('delivery-save-toggle');
  const tplNameInput = document.getElementById('delivery-tpl-name');
  if (saveToggle && tplNameInput) {
    saveToggle.addEventListener('click', () => {
      saveToggle.classList.toggle('active');
      const isOn = saveToggle.classList.contains('active');
      tplNameInput.style.display = isOn ? 'block' : 'none';
      if (isOn) setTimeout(() => tplNameInput.focus(), 80);
      haptic('light');
    });
  }

  // Form submit
  document.getElementById('delivery-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('delivery-submit');
    btn.disabled = true; btn.textContent = 'Отправляем…';
    const pkgId = document.getElementById('delivery-pkg-id').value;
    const pickup_address = document.getElementById('delivery-address').value.trim();
    const phone = document.getElementById('delivery-phone').value.trim();
    const full_name = document.getElementById('delivery-fullname').value.trim();

    const saveToggleEl = document.getElementById('delivery-save-toggle');
    const saveAsTpl = saveToggleEl?.classList.contains('active') ?? false;
    const tplName = document.getElementById('delivery-tpl-name').value.trim();

    // Если toggle включён но имя не введено — показываем подсказку
    if (saveAsTpl && !tplName) {
      toast('Введите название шаблона', 'error');
      document.getElementById('delivery-tpl-name').focus();
      btn.disabled = false; btn.textContent = 'Отправить';
      return;
    }

    try {
      await apiFetch(`/api/packages/${pkgId}/delivery-response`, {
        method: 'POST',
        body: JSON.stringify({ delivery_type: currentDeliveryType, pickup_address, phone, full_name }),
      });

      if (saveAsTpl && tplName) {
        await apiFetch('/api/address-templates', {
          method: 'POST',
          body: JSON.stringify({ name: tplName, delivery_type: currentDeliveryType, pickup_address, phone, full_name }),
        }).catch(() => {});
        toast('Данные отправлены и шаблон сохранён!', 'success');
      } else {
        toast('Данные доставки отправлены!', 'success');
      }

      haptic('medium');
      hideModal('delivery-modal-overlay');
      loadPackages();
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Отправить'; }
  });
}

/* ── Client Templates ────────────────────────────────────────────── */
let clientTemplates = [];

async function loadClientTemplates() {
  try {
    clientTemplates = await apiFetch('/api/client-templates');
    renderClientChips();
    renderClientMgmt();
  } catch {}
}

function renderClientChips() {
  ['pkg-client-chips', 'inv-client-chips'].forEach(id => {
    const row = document.getElementById(id);
    if (!row) return;
    if (!clientTemplates.length) { row.innerHTML = ''; return; }
    row.innerHTML = clientTemplates.map(ct =>
      `<button type="button" class="tpl-chip" data-ct-id="${ct.id}">${ct.name}</button>`
    ).join('');
    row.querySelectorAll('.tpl-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const ct = clientTemplates.find(c => c.id === parseInt(btn.dataset.ctId));
        if (!ct) return;
        if (id === 'pkg-client-chips') {
          document.getElementById('pkg-client-id').value = ct.telegram_id || '';
          document.getElementById('pkg-client-username').value = ct.username ? '@' + ct.username : '';
          document.getElementById('pkg-client-name').value = ct.name || '';
        } else {
          document.getElementById('inv-client').value = ct.telegram_id || (ct.username ? '@' + ct.username : '');
        }
        haptic('light');
      });
    });
  });
}

function renderClientMgmt() {
  const list = document.getElementById('ct-list');
  if (!list) return;
  if (!clientTemplates.length) {
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:4px 0 12px">Нет сохранённых клиентов</div>`;
    return;
  }
  list.innerHTML = clientTemplates.map(ct => `
    <div class="tpl-mgmt-row">
      <div class="tpl-mgmt-info">
        <div class="tpl-mgmt-name">${ct.name}</div>
        <div class="tpl-mgmt-preview">${[ct.telegram_id, ct.username ? '@' + ct.username : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="btn-tpl-delete" data-ct-id="${ct.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>`).join('');
  list.querySelectorAll('.btn-tpl-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/client-templates/${btn.dataset.ctId}`, { method: 'DELETE' });
        await loadClientTemplates();
        toast('Клиент удалён', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function setupClientMgmt() {
  const addBtn    = document.getElementById('ct-add-btn');
  const addForm   = document.getElementById('ct-add-form');
  const cancelBtn = document.getElementById('ct-cancel-btn');
  const saveBtn   = document.getElementById('ct-save-btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', () => {
    addForm.style.display = 'flex'; addBtn.style.display = 'none';
    document.getElementById('ct-name').focus();
  });
  cancelBtn.addEventListener('click', () => {
    addForm.style.display = 'none'; addBtn.style.display = 'flex';
    ['ct-name','ct-telegram-id','ct-username'].forEach(id => document.getElementById(id).value = '');
  });
  saveBtn.addEventListener('click', async () => {
    const name        = document.getElementById('ct-name').value.trim();
    const telegram_id = document.getElementById('ct-telegram-id').value.trim();
    const username    = document.getElementById('ct-username').value.trim();
    if (!name) { toast('Укажите имя клиента', 'error'); return; }
    if (!telegram_id && !username) { toast('Укажите Telegram ID или @username', 'error'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Сохраняем…';
    try {
      await apiFetch('/api/client-templates', { method: 'POST', body: JSON.stringify({ name, username, telegram_id }) });
      await loadClientTemplates();
      addForm.style.display = 'none'; addBtn.style.display = 'flex';
      ['ct-name','ct-telegram-id','ct-username'].forEach(id => document.getElementById(id).value = '');
      toast('Клиент сохранён', 'success'); haptic('medium');
    } catch (e) { toast(e.message, 'error'); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Сохранить'; }
  });
}

/* ── Payment Templates ───────────────────────────────────────────── */
let paymentTemplates = [];

async function loadPaymentTemplates() {
  try {
    paymentTemplates = await apiFetch('/api/payment-templates');
    renderTemplateChips();
    renderTemplateMgmt();
  } catch {}
}

function renderTemplateChips() {
  const row = document.getElementById('inv-tpl-chips');
  if (!row) return;
  if (!paymentTemplates.length) { row.innerHTML = ''; return; }
  row.innerHTML = paymentTemplates.map(t =>
    `<button type="button" class="tpl-chip" data-tpl-id="${t.id}">${t.name}</button>`
  ).join('');
  row.querySelectorAll('.tpl-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = paymentTemplates.find(t => t.id === parseInt(btn.dataset.tplId));
      if (tpl) { document.getElementById('inv-details').value = tpl.details; haptic('light'); }
    });
  });
}

function renderTemplateMgmt() {
  const list = document.getElementById('tpl-list');
  if (!list) return;
  if (!paymentTemplates.length) {
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:4px 0 12px">Нет шаблонов</div>`;
    return;
  }
  list.innerHTML = paymentTemplates.map(t => `
    <div class="tpl-mgmt-row">
      <div class="tpl-mgmt-info">
        <div class="tpl-mgmt-name">${t.name}</div>
        <div class="tpl-mgmt-preview">${t.details.replace(/\n/g, ' · ')}</div>
      </div>
      <button class="btn-tpl-delete" data-tpl-id="${t.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>`).join('');
  list.querySelectorAll('.btn-tpl-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/payment-templates/${btn.dataset.tplId}`, { method: 'DELETE' });
        await loadPaymentTemplates();
        toast('Шаблон удалён', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function setupTemplateMgmt() {
  const addBtn    = document.getElementById('tpl-add-btn');
  const addForm   = document.getElementById('tpl-add-form');
  const cancelBtn = document.getElementById('tpl-cancel-btn');
  const saveBtn   = document.getElementById('tpl-save-btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', () => {
    addForm.style.display = 'flex'; addBtn.style.display = 'none';
    document.getElementById('tpl-name').focus();
  });
  cancelBtn.addEventListener('click', () => {
    addForm.style.display = 'none'; addBtn.style.display = 'flex';
    document.getElementById('tpl-name').value = '';
    document.getElementById('tpl-details').value = '';
  });
  saveBtn.addEventListener('click', async () => {
    const name    = document.getElementById('tpl-name').value.trim();
    const details = document.getElementById('tpl-details').value.trim();
    if (!name || !details) { toast('Заполните название и реквизиты', 'error'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Сохраняем…';
    try {
      await apiFetch('/api/payment-templates', { method: 'POST', body: JSON.stringify({ name, details }) });
      await loadPaymentTemplates();
      addForm.style.display = 'none'; addBtn.style.display = 'flex';
      document.getElementById('tpl-name').value = '';
      document.getElementById('tpl-details').value = '';
      toast('Шаблон сохранён', 'success'); haptic('medium');
    } catch (e) { toast(e.message, 'error'); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Сохранить'; }
  });
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
    const result = await apiFetch('/api/admin/restore', { method: 'POST', body: JSON.stringify({ data }) });
    toast(`Восстановлено: ${result.packages} посылок, ${result.invoices} счетов, ${result.templates} шаблонов, ${result.clients} клиентов`, 'success');
    loadPackages();
    loadPaymentTemplates();
    loadClientTemplates();
  } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
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

  const viewPhotoBtn = e.target.closest('.btn-view-photo');
  if (viewPhotoBtn) {
    openPhotoLightbox(viewPhotoBtn.dataset.photo, viewPhotoBtn.dataset.label);
    return;
  }

  if (e.target.closest('#photo-lb-close') || e.target.classList.contains('photo-lb-bg')) {
    closePhotoLightbox(); return;
  }

  const photoUploadBtn = e.target.closest('.btn-photo-icon');
  if (photoUploadBtn) {
    currentPhotoPackageId = parseInt(photoUploadBtn.dataset.pkgId);
    document.getElementById('photo-input').click();
    return;
  }

  const photoDeleteBtn = e.target.closest('.btn-photo-delete');
  if (photoDeleteBtn) {
    const id = parseInt(photoDeleteBtn.dataset.id);
    const doDelete = async () => {
      try {
        await apiFetch(`/api/packages/${id}/photo`, { method: 'DELETE' });
        toast('Фото удалено', 'success');
        haptic('light');
        loadPackages();
      } catch (err) { toast(err.message, 'error'); }
    };
    if (tg?.showConfirm) tg.showConfirm('Удалить фото?', ok => { if (ok) doDelete(); });
    else if (confirm('Удалить фото?')) doDelete();
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
  if (e.target.closest('#delivery-modal-close') || e.target.id === 'delivery-modal-overlay') { hideModal('delivery-modal-overlay'); return; }

  const reqDelivery = e.target.closest('.btn-req-delivery');
  if (reqDelivery) {
    try {
      await apiFetch(`/api/packages/${reqDelivery.dataset.id}/request-delivery`, { method: 'POST' });
      toast('Запрос отправлен клиенту', 'success');
      haptic('medium');
      loadPackages();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const fillDelivery = e.target.closest('.btn-fill-delivery');
  if (fillDelivery) { openDeliveryModal(fillDelivery.dataset.id); return; }

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

/* ── Scriptable widget generator ────────────────────────────────── */
function generateScriptableWidget(base, token) {
  return `// Monarc Cargo — виджет на iPhone
// 1. Установи Scriptable из App Store (бесплатно)
// 2. Открой Scriptable → нажми «+» → вставь этот код → сохрани
// 3. Добавь виджет Scriptable на экран «Домой» → выбери этот скрипт

const BASE = "${base}";
const TOKEN = "${token}";

async function run() {
  const req = new Request(BASE + "/admin/widget-data?token=" + TOKEN);
  const d = await req.loadJSON();

  const w = new ListWidget();
  w.backgroundColor = new Color("#08080f");
  w.url = BASE + "/admin/live?token=" + TOKEN;
  w.setPadding(14, 16, 14, 16);

  // Header
  const hdr = w.addStack();
  hdr.layoutHorizontally();
  hdr.centerAlignContent();
  const ttl = hdr.addText("MONARC");
  ttl.font = Font.heavySystemFont(15);
  ttl.textColor = Color.white();
  hdr.addSpacer();
  const sub = hdr.addText("CARGO");
  sub.font = Font.semiboldSystemFont(9);
  sub.textColor = new Color("#475569");

  w.addSpacer(10);

  const rows = [
    { icon: "📦", label: "Склад",  val: d.received, color: "#fb923c" },
    { icon: "🚚", label: "В пути", val: d.shipped,  color: "#60a5fa" },
    { icon: "✅", label: "Готово", val: d.ready,    color: "#4ade80" },
    { icon: "📊", label: "Всего",  val: d.total,    color: "#94a3b8" },
  ];

  for (const r of rows) {
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const lbl = row.addText(r.icon + " " + r.label);
    lbl.font = Font.systemFont(12);
    lbl.textColor = new Color("#64748b");
    row.addSpacer();
    const num = row.addText(String(r.val));
    num.font = Font.boldSystemFont(15);
    num.textColor = new Color(r.color);
    w.addSpacer(5);
  }

  if (d.reviewing_invoices > 0) {
    w.addSpacer(4);
    const inv = w.addText("💰 " + d.reviewing_invoices + " оплат на проверке");
    inv.font = Font.systemFont(10);
    inv.textColor = new Color("#fbbf24");
  }

  Script.setWidget(w);
  if (!config.runsInWidget) await w.presentSmall();
  Script.complete();
}

run();`;
}

/* ── Theme ───────────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('monarc_theme');
  if (saved === 'light') applyTheme('light');

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isLight = document.body.classList.contains('theme-light');
    applyTheme(isLight ? 'dark' : 'light');
    haptic('light');
  });
}

function applyTheme(theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('theme-light', isLight);
  localStorage.setItem('monarc_theme', theme);
  const moon = document.querySelector('.icon-moon');
  const sun  = document.querySelector('.icon-sun');
  if (moon) moon.style.display = isLight ? 'none'  : '';
  if (sun)  sun.style.display  = isLight ? ''      : 'none';
  // Telegram header colour
  tg?.setHeaderColor?.(isLight ? '#f1f5f9' : '#08080f');
  tg?.setBackgroundColor?.(isLight ? '#f1f5f9' : '#08080f');
}

/* ── Pull-to-refresh ─────────────────────────────────────────────── */
function setupPullToRefresh() {
  const scroller = document.getElementById('content');
  const ptr      = document.getElementById('ptr-indicator');
  if (!ptr || !scroller) return;

  const THRESHOLD = 70;
  let startY = 0, dist = 0, active = false, refreshing = false;

  function setPtrPos(pull) {
    // pull: 0 = hidden above, 1 = fully visible
    const y = -52 + Math.min(pull, 1.2) * 64;
    ptr.style.transform = `translateX(-50%) translateY(${y}px)`;
    ptr.style.opacity   = Math.min(pull * 1.5, 1);
  }

  scroller.addEventListener('touchstart', e => {
    if (scroller.scrollTop === 0 && !refreshing) {
      startY = e.touches[0].clientY;
      active = true;
      dist   = 0;
      ptr.style.transition = 'none';
    }
  }, { passive: true });

  scroller.addEventListener('touchmove', e => {
    if (!active || refreshing) return;
    dist = Math.max(0, e.touches[0].clientY - startY);
    if (dist > 0) {
      setPtrPos(dist / THRESHOLD);
      ptr.classList.toggle('ptr-ready', dist >= THRESHOLD);
    }
  }, { passive: true });

  scroller.addEventListener('touchend', () => {
    if (!active) return;
    active = false;
    ptr.style.transition = '';

    if (dist >= THRESHOLD && !refreshing) {
      refreshing = true;
      ptr.classList.add('ptr-spinning');
      ptr.classList.remove('ptr-ready');
      setPtrPos(1);
      haptic('medium');
      loadPackages().finally(() => {
        refreshing = false;
        ptr.classList.remove('ptr-spinning');
        setPtrPos(0);
      });
    } else {
      ptr.classList.remove('ptr-ready');
      setPtrPos(0);
    }
    dist = 0;
  }, { passive: true });
}

/* ── Onboarding ──────────────────────────────────────────────────── */
function showOnboarding() {
  if (localStorage.getItem('monarc_onboarded')) return;
  const el = document.getElementById('onboarding');
  if (!el) return;

  el.style.display = 'flex';
  haptic('light');

  const inner = document.getElementById('ob-slides-inner');
  const dots  = document.querySelectorAll('.ob-dot');
  const total = dots.length;
  let cur = 0;

  function goTo(n) {
    cur = n;
    inner.style.transform = `translateX(-${cur * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle('active', i === cur));
    const nextBtn = document.getElementById('ob-next');
    if (nextBtn) nextBtn.textContent = cur === total - 1 ? 'Начать' : 'Далее';
    const skipBtn = document.getElementById('ob-skip');
    if (skipBtn) skipBtn.style.opacity = cur === total - 1 ? '0' : '1';
    haptic('light');
  }

  function finish() {
    localStorage.setItem('monarc_onboarded', '1');
    el.classList.add('ob-out');
    setTimeout(() => { el.style.display = 'none'; el.classList.remove('ob-out'); }, 380);
    haptic('medium');
  }

  document.getElementById('ob-next')?.addEventListener('click', () => {
    if (cur < total - 1) goTo(cur + 1); else finish();
  });
  document.getElementById('ob-skip')?.addEventListener('click', finish);

  // Swipe support
  let touchStartX = 0;
  el.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) {
      if (dx < 0 && cur < total - 1) goTo(cur + 1);
      else if (dx > 0 && cur > 0) goTo(cur - 1);
    }
  }, { passive: true });
}

/* ── Init ────────────────────────────────────────────────────────── */
async function init() {
  initTheme();
  if (!tg?.initData) {
    await new Promise(r => setTimeout(r, 1200));
    document.getElementById('loading').innerHTML = `
      <div style="text-align:center;padding:32px 24px;max-width:320px;position:relative;z-index:1">
        <div style="font-size:52px;margin-bottom:20px">✈️</div>
        <div style="font-family:'Montserrat',sans-serif;font-size:26px;font-weight:900;letter-spacing:5px;
          color:#ffffff;
          margin-bottom:6px">MONARC</div>
        <div style="color:#94a3b8;font-size:13px;margin-bottom:28px">Cargo Delivery</div>
        <div style="color:#f1f5f9;font-size:15px;font-weight:600;margin-bottom:8px">Откройте в Telegram</div>
        <div style="color:#64748b;font-size:13px;line-height:1.6;margin-bottom:28px">
          Это Telegram Mini App — работает только внутри Telegram
        </div>
        <a href="https://t.me/euro_monarc"
          style="display:inline-block;padding:12px 28px;border-radius:12px;
          background:#ffffff;color:#08080f;
          font-weight:700;font-size:14px;text-decoration:none">
          Написать менеджеру →
        </a>
      </div>`;
    return;
  }

  try {
    state.user = await apiFetch('/api/me');

    if (state.user.is_admin) {
      document.getElementById('btn-add').style.display = 'flex';
      document.getElementById('admin-stats').style.display = 'flex';
      document.getElementById('admin-search').style.display = 'flex';
      document.getElementById('admin-backup').style.display = 'block';

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

        // iPhone buttons
        document.getElementById('btn-live-iphone')?.addEventListener('click', () => {
          window.open(info.live_url, '_blank');
        });
        document.getElementById('btn-widget-script')?.addEventListener('click', () => {
          const base = info.live_url.replace(/\/admin\/live.*$/, '');
          const script = generateScriptableWidget(base, info.token);
          copyText(script);
          toast('Скрипт скопирован! Вставь в Scriptable', 'success');
          haptic('medium');
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
      if (!localStorage.getItem('monarc_onboarded')) showOnboarding();
    }

    document.getElementById('my-id-value').textContent = state.user.id;

    // Показываем приложение сразу, данные грузятся в фоне
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Обработчик загрузки фото
    document.getElementById('photo-input')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !currentPhotoPackageId) return;
      const pkgId = currentPhotoPackageId;
      currentPhotoPackageId = null;
      const uploadBtn = document.querySelector(`.btn-photo-icon[data-pkg-id="${pkgId}"]`);
      if (uploadBtn) { uploadBtn.style.opacity = '0.4'; uploadBtn.disabled = true; }
      try {
        const photoData = await resizeImage(file, 1200, 1200, 0.82);
        await apiFetch(`/api/packages/${pkgId}/photo`, {
          method: 'POST',
          body: JSON.stringify({ photo_data: photoData }),
        });
        toast('Фото прикреплено', 'success');
        haptic('medium');
        loadPackages();
      } catch (err) {
        toast(err.message || 'Ошибка загрузки фото', 'error');
        if (uploadBtn) { uploadBtn.style.opacity = ''; uploadBtn.disabled = false; }
      }
    });

    loadPackages();
    // Проверяем неоплаченные счета в фоне (только для клиентов)
    if (!state.user.is_admin) {
      apiFetch('/api/invoices').then(invs => {
        state.invoices = invs;
        updateInvoiceBadge(invs);
      }).catch(() => {});
    }
    setupCalc();
    setupWarehouseTabs();
    setupDeliveryModal();
    setupPullToRefresh();
    if (state.user.is_admin) {
      loadPaymentTemplates(); setupTemplateMgmt();
      loadClientTemplates();  setupClientMgmt();
    }
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
