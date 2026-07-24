const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || '885394476';
// Постоянное хранилище: Railway Volume (RAILWAY_VOLUME_MOUNT_PATH ставится автоматически
// при подключённом Volume), иначе /data в проде, локально — рядом с сервером
const DATA_DIR = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT ? '/data' : __dirname);
const DB_FILE  = path.join(DATA_DIR, 'data.json');
// Создаём директорию если её нет (нужно при первом запуске с Volume)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Папка для фотографий товаров
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch {}

// Deterministic export token derived from secrets (no extra env var needed)
const EXPORT_TOKEN = process.env.EXPORT_TOKEN ||
  crypto.createHash('sha256').update((BOT_TOKEN || '') + ADMIN_ID).digest('hex').slice(0, 24);

// ── JSON Database ─────────────────────────────────────────────────

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { packages: [], nextId: 1 }; }
}

function writeDB(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function now() { return new Date().toISOString(); }

// Resolve Telegram ID: by client_id or by username lookup (users → packages fallback)
function resolveClientId(clientId, clientUsername, db) {
  if (clientId) return clientId;
  if (!clientUsername) return null;
  const uname = clientUsername.replace('@', '').toLowerCase();
  // 1. Check users saved from bot interactions
  const foundUser = (db.users || []).find(u => (u.username || '').toLowerCase() === uname);
  if (foundUser?.id) return foundUser.id;
  // 2. Fallback: check packages where admin already linked this username to an ID
  const foundPkg = (db.packages || []).find(p =>
    (p.client_username || '').toLowerCase() === uname && p.client_id
  );
  return foundPkg?.client_id || null;
}

// ── User upsert (Mini App auth) ───────────────────────────────────

// Кэш в памяти — не сохраняем одного и того же пользователя повторно до рестарта
const _knownUserIds = new Set();

function upsertUserFromAuth(user) {
  if (!user.id || _knownUserIds.has(user.id)) return;
  _knownUserIds.add(user.id);
  try {
    const db = readDB();
    if (!db.users) db.users = [];
    const idx = db.users.findIndex(u => u.id === user.id);
    const data = { id: user.id, username: user.username, name: user.name, updated_at: now() };
    if (idx === -1) db.users.push({ ...data, created_at: now() });
    else db.users[idx] = { ...db.users[idx], ...data };
    writeDB(db);
  } catch {}
}

// ── Middleware ────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '8mb' })); // увеличен для загрузки фото
app.use(express.static(path.join(__dirname, 'public')));

// Отдаём фотографии товаров
app.get('/photos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // защита от path traversal
  const filepath = path.join(PHOTOS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// ── Auth ──────────────────────────────────────────────────────────

function verifyTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    return crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex') === hash;
  } catch { return false; }
}

function authMiddleware(req, res, next) {
  // Веб-версия для ПК: доступ админа по токену (тот же, что у Live-таблицы/CSV)
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && adminToken === EXPORT_TOKEN) {
    req.user = { id: ADMIN_ID, username: 'admin', name: 'Admin (Web)', is_admin: true };
    return next();
  }
  const initData = req.headers['x-telegram-init-data'];
  // dev-обход авторизации только локально — на Railway всегда строгая проверка
  if (process.env.NODE_ENV !== 'production' && !process.env.RAILWAY_ENVIRONMENT) {
    if (!initData || initData === 'dev') {
      const devId = req.headers['x-dev-user-id'] || '000000000';
      req.user = { id: String(devId), username: 'devuser', name: 'Dev User', is_admin: String(devId) === ADMIN_ID };
      return next();
    }
  }
  if (!initData) return res.status(401).json({ error: 'Unauthorized' });
  if (!verifyTelegramData(initData)) return res.status(401).json({ error: 'Invalid Telegram auth data' });
  const params = new URLSearchParams(initData);
  const user = JSON.parse(decodeURIComponent(params.get('user')));
  req.user = {
    id: String(user.id),
    username: (user.username || '').toLowerCase(),
    name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    is_admin: String(user.id) === ADMIN_ID,
  };
  // Сохраняем пользователя в базе — чтобы уведомления работали даже без /start
  upsertUserFromAuth(req.user);
  next();
}

// ── Rate calculation ──────────────────────────────────────────────

function calcRate(weight, country = 'eu') {
  if (!weight || weight <= 0) return { type: '—', rate: 0 };
  if (country === 'us') return { type: '—', rate: 0 }; // США: только ручная цена
  if (country === 'gb') {
    // фиксированная цена за коробку (£)
    if (weight <= 2) return { type: 'До 2 кг',  rate: 19,  fixed: true };
    if (weight <= 5) return { type: 'До 5 кг',  rate: 42,  fixed: true };
    return                  { type: 'До 20 кг', rate: 118, fixed: true };
  }
  if (country === 'cn') {
    if (weight >= 5) return { type: 'Наземный', rate: 700 };
    return { type: 'Авиа', rate: 950 };
  }
  if (country === 'jp') return { type: 'Обычная', rate: 1900 };
  // EU default
  if (weight <= 5)  return { type: 'Экспресс',    rate: 1900 };
  if (weight <= 20) return { type: 'Наземный',     rate: 1750 };
  return                   { type: 'Сборный груз', rate: 1300 };
}

function enrichPackage(p) {
  const isGb = p.country === 'gb'; // UK — фикс. цена за коробку в £
  let out;
  if (p.tariff_type && p.tariff_rate) {
    const total = p.tariff_rate > 0
      ? (isGb ? Math.round(p.tariff_rate) : (p.weight > 0 ? Math.round(p.weight * p.tariff_rate) : 0))
      : 0;
    out = { ...p, type: p.tariff_type, rate: p.tariff_rate, total };
  } else {
    const r = calcRate(p.weight, p.country || 'eu');
    const total = r.rate > 0 ? (isGb ? r.rate : Math.round((p.weight || 0) * r.rate)) : 0;
    out = { ...p, ...r, total };
  }
  // Своя стоимость от админа перекрывает расчёт; 0 = «стоимость не показывать»
  if (p.custom_total != null) {
    out.total = p.custom_total;
    if (!(p.tariff_type && p.tariff_rate)) { out.type = p.custom_total > 0 ? 'Свой' : '—'; out.rate = 0; }
  }
  return out;
}

// ── Notifications ─────────────────────────────────────────────────

const STATUS_LABELS = {
  pending: 'Ожидается', received: 'На складе', processing: 'Обрабатывается',
  shipped: 'В пути', ready: 'Готово к выдаче', delivered: 'Завершён',
};

async function notifyClient(clientId, trackingNumber, status) {
  if (!BOT_TOKEN || !clientId) return;
  const emoji = { pending: '⏳', received: '📦', processing: '⚙️', shipped: '🚚', ready: '✅', delivered: '🎉' }[status] || '📬';
  const text =
    `<b>Monarc Cargo</b>\n\n` +
    `${emoji} Статус посылки изменён\n\n` +
    `Трек: <code>${trackingNumber}</code>\n` +
    `Статус: <b>${STATUS_LABELS[status] || status}</b>`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: clientId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`TG notify failed [${clientId}]:`, data.description);
  } catch (err) { console.error('TG notify error:', err.message); }
}

async function notifyAdmin(text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) { console.error('TG admin notify error:', err.message); }
}

// ── Routes ────────────────────────────────────────────────────────

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user));

// ── Client grouping ───────────────────────────────────────────────
// Единый ключ клиента: id → username → имя. unameToId склеивает посылки,
// где у одной указан только username, а у другой — username + id.
function buildUnameToId(packages) {
  const map = {};
  packages.forEach(p => {
    const u = (p.client_username || '').toLowerCase();
    if (u && p.client_id) map[u] = String(p.client_id);
  });
  return map;
}

function clientKey(p, unameToId) {
  if (p.client_id) return 'id:' + p.client_id;
  const u = (p.client_username || '').toLowerCase();
  if (u && unameToId[u]) return 'id:' + unameToId[u];
  if (u) return 'u:' + u;
  const n = (p.client_name || '').trim().toLowerCase();
  return n ? 'n:' + n : null;
}

// Admin: unique clients across packages (for filter dropdown)
app.get('/api/clients', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { packages } = readDB();
  const unameToId = buildUnameToId(packages);
  const map = new Map();
  packages.forEach(p => {
    const key = clientKey(p, unameToId);
    if (!key) return;
    const cur = map.get(key) || { key, name: null, username: null, count: 0 };
    cur.count++;
    if (!cur.name && p.client_name) cur.name = p.client_name;
    if (!cur.username && p.client_username) cur.username = p.client_username;
    map.set(key, cur);
  });
  const clients = [...map.values()].map(c => ({
    ...c,
    label: c.name || (c.username ? '@' + c.username : c.key.replace('id:', 'ID ')),
  })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  res.json(clients);
});

// List packages
app.get('/api/packages', authMiddleware, (req, res) => {
  const { status, search, client } = req.query;
  const db = readDB();
  let { packages } = db;

  if (req.user.is_admin) {
    // карта username→id строится по полному списку — до фильтров
    const unameToId = client ? buildUnameToId(packages) : null;
    if (status && status !== 'all') packages = packages.filter(p => p.status === status);
    if (client) packages = packages.filter(p => clientKey(p, unameToId) === client);
    if (search) {
      const s = search.toLowerCase();
      packages = packages.filter(p =>
        p.tracking_number.toLowerCase().includes(s) ||
        (p.client_name || '').toLowerCase().includes(s) ||
        (p.client_username || '').toLowerCase().includes(s)
      );
    }
  } else {
    // Клиент видит посылки, привязанные по ID или по @username
    // (важно для посылок без трека: клиент не может добавить их сам)
    const uname = (req.user.username || '').toLowerCase();
    packages = packages.filter(p =>
      p.client_id === req.user.id ||
      (uname && (p.client_username || '').toLowerCase() === uname)
    );
  }

  packages = [...packages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  // Прикрепляем метаданные общей доставки группы (вес/тариф на всю связку)
  res.json(packages.map(p => enrichPackage(
    p.group_id && db.groups && db.groups[p.group_id] ? { ...p, group_delivery: db.groups[p.group_id] } : p
  )));
});

// Admin: create package
app.post('/api/packages', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });

  const { tracking_number, client_id, client_username, client_name, weight, country, description, status, item_name } = req.body;
  if (!tracking_number?.trim()) return res.status(400).json({ error: 'Трек-номер обязателен' });

  const db = readDB();
  const trackRaw = tracking_number.trim().toUpperCase();
  const isNoTrack = trackRaw === 'NO'; // нет трека — генерируем временный ID
  const track = isNoTrack ? `NO-${db.nextId}` : trackRaw;

  if (!isNoTrack && db.packages.find(p => p.tracking_number === track)) {
    return res.status(400).json({ error: 'Такой трек-номер уже существует' });
  }

  const initStatus = status || 'received';
  const { tariff_type, tariff_rate, custom_total } = req.body;
  const pkg = {
    id: db.nextId++,
    tracking_number: track,
    no_tracking: isNoTrack || undefined,
    client_id: client_id || null,
    client_username: client_username ? client_username.replace('@', '') : null,
    client_name: client_name || null,
    item_name: item_name || null,
    weight: weight ? parseFloat(weight) : 0,
    country: country || 'eu',
    tariff_type: tariff_type || null,
    tariff_rate: tariff_rate ? parseFloat(tariff_rate) : null,
    custom_total: custom_total != null && custom_total !== '' && !isNaN(parseFloat(custom_total)) ? parseFloat(custom_total) : null,
    status: initStatus,
    description: description || null,
    source: 'admin',
    history: [{ status: initStatus, changed_at: now() }],
    created_at: now(),
    updated_at: now(),
  };

  db.packages.push(pkg);
  writeDB(db);
  const notifyId = resolveClientId(client_id, client_username, db);
  if (notifyId) notifyClient(notifyId, pkg.tracking_number, initStatus);
  res.json(enrichPackage(pkg));
});

// Client: self-add tracking number (pending)
app.post('/api/my-packages', authMiddleware, (req, res) => {
  const { tracking_number, country, description } = req.body;
  if (!tracking_number?.trim()) return res.status(400).json({ error: 'Трек-номер обязателен' });

  const db = readDB();
  const track = tracking_number.trim().toUpperCase();

  // If already exists — claim it
  const existing = db.packages.find(p => p.tracking_number === track);
  if (existing) {
    if (existing.client_id && existing.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Этот трек-номер уже привязан' });
    }
    existing.client_id = req.user.id;
    existing.client_username = req.user.username;
    existing.client_name = req.user.name;
    existing.updated_at = now();
    const idx = db.packages.findIndex(p => p.tracking_number === track);
    db.packages[idx] = existing;
    writeDB(db);
    return res.json(enrichPackage(existing));
  }

  const pkg = {
    id: db.nextId++,
    tracking_number: track,
    client_id: req.user.id,
    client_username: req.user.username,
    client_name: req.user.name,
    weight: 0,
    country: country || null,
    status: 'pending',
    description: description || null,
    source: 'client',
    history: [{ status: 'pending', changed_at: now() }],
    created_at: now(),
    updated_at: now(),
  };

  db.packages.push(pkg);
  writeDB(db);

  // Notify admin about new client-added tracking
  const countryLabel = { eu: '🇪🇺 Европа', gb: '🇬🇧 Великобритания', cn: '🇨🇳 Китай', jp: '🇯🇵 Япония' }[country] || '—';
  notifyAdmin(
    `<b>Monarc Cargo</b>\n\n` +
    `📥 Новый трек от клиента\n\n` +
    `Трек: <code>${track}</code>\n` +
    `Клиент: ${req.user.name || ''}${req.user.username ? ' @' + req.user.username : ''}\n` +
    `ID: <code>${req.user.id}</code>\n` +
    `Страна: ${countryLabel}` +
    (description ? `\nЗаметка: ${description}` : '')
  );

  res.json(enrichPackage(pkg));
});

// Admin: update package
app.put('/api/packages/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });

  const pkg = db.packages[idx];
  const prev = pkg.status;
  const { status, weight, description, client_id, client_username, client_name, country, item_name, tariff_type, tariff_rate } = req.body;

  // Обновление трек-номера (в т.ч. присвоение реального трека посылке «NO»)
  const newTrack = (req.body.tracking_number || '').trim().toUpperCase();
  if (newTrack && newTrack !== 'NO' && newTrack !== pkg.tracking_number) {
    if (db.packages.find(p => p.tracking_number === newTrack && p.id !== pkg.id)) {
      return res.status(400).json({ error: 'Такой трек-номер уже существует' });
    }
    pkg.tracking_number = newTrack;
    delete pkg.no_tracking;
  }

  if (status)                    pkg.status = status;
  if (weight !== undefined)      pkg.weight = weight ? parseFloat(weight) : 0;
  if (country)                   pkg.country = country;
  if (item_name !== undefined)   pkg.item_name = item_name || null;
  if (description !== undefined) pkg.description = description || null;
  if (client_id)                 pkg.client_id = client_id;
  if (client_username !== undefined) pkg.client_username = client_username ? client_username.replace('@', '') : null;
  if (client_name !== undefined)     pkg.client_name = client_name || null;
  // Тариф и свою стоимость меняем только если поле пришло в запросе —
  // частичные PUT (быстрая смена статуса и т.п.) их не затирают
  if ('tariff_type' in req.body) pkg.tariff_type = tariff_type || null;
  if ('tariff_rate' in req.body) pkg.tariff_rate = tariff_rate ? parseFloat(tariff_rate) : null;
  if ('custom_total' in req.body) {
    const ct = req.body.custom_total;
    pkg.custom_total = ct != null && ct !== '' && !isNaN(parseFloat(ct)) ? parseFloat(ct) : null;
  }
  pkg.updated_at = now();

  if (status && status !== prev) {
    if (!pkg.history) pkg.history = [];
    pkg.history.push({ status, changed_at: now() });
  }

  db.packages[idx] = pkg;
  writeDB(db);
  if (status && status !== prev) {
    const notifyId = resolveClientId(pkg.client_id, pkg.client_username, db);
    if (notifyId) notifyClient(notifyId, pkg.tracking_number, status);
  }
  res.json(enrichPackage(pkg));
});

// ── Группировка посылок: объединение нескольких в одну «связку» ───
// (для выставления одного счёта и компактного отображения)
app.post('/api/packages/group', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (ids.length < 2) return res.status(400).json({ error: 'Выберите минимум две посылки' });
  const db = readDB();
  const pkgs = db.packages.filter(p => ids.includes(p.id));
  if (pkgs.length < 2) return res.status(404).json({ error: 'Посылки не найдены' });
  const gid = 'g' + Date.now();
  pkgs.forEach(p => { p.group_id = gid; p.updated_at = now(); });
  writeDB(db);
  res.json({ group_id: gid, count: pkgs.length });
});

app.post('/api/packages/ungroup', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { group_id } = req.body;
  if (!group_id) return res.status(400).json({ error: 'group_id обязателен' });
  const db = readDB();
  let n = 0;
  db.packages.forEach(p => { if (p.group_id === group_id) { delete p.group_id; p.updated_at = now(); n++; } });
  if (db.groups) delete db.groups[group_id];
  writeDB(db);
  res.json({ ungrouped: n });
});

// Общая доставка группы: единый вес и тариф на всю связку
app.post('/api/packages/group-delivery', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { group_id, weight, tariff_type, tariff_rate, custom_total, remove } = req.body;
  if (!group_id) return res.status(400).json({ error: 'group_id обязателен' });
  const db = readDB();
  if (!db.packages.some(p => p.group_id === group_id)) {
    return res.status(404).json({ error: 'Группа не найдена' });
  }
  db.groups = db.groups || {};
  if (remove) {
    delete db.groups[group_id];
  } else {
    db.groups[group_id] = {
      weight: weight ? parseFloat(weight) : 0,
      tariff_type: tariff_type || null,
      tariff_rate: tariff_rate ? parseFloat(tariff_rate) : 0,
      custom_total: custom_total != null && custom_total !== '' && !isNaN(parseFloat(custom_total)) ? parseFloat(custom_total) : null,
    };
  }
  db.packages.forEach(p => { if (p.group_id === group_id) p.updated_at = now(); });
  writeDB(db);
  res.json({ ok: true, group_delivery: db.groups[group_id] || null });
});

// Admin: delete
app.delete('/api/packages/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.packages = db.packages.filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// Admin: прикрепить фото к посылке
app.post('/api/packages/:id/photo', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { photo_data } = req.body;
  if (!photo_data) return res.status(400).json({ error: 'Нет данных фото' });

  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];

  // Удаляем старое фото если было
  if (pkg.photo_url) {
    try { fs.unlinkSync(path.join(PHOTOS_DIR, path.basename(pkg.photo_url))); } catch {}
  }

  // Разбираем data URL: data:image/jpeg;base64,...
  const m = photo_data.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!m) return res.status(400).json({ error: 'Неверный формат фото' });
  const ext = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  const filename = `pkg_${pkg.id}_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), Buffer.from(m[2], 'base64'));

  pkg.photo_url = `/photos/${filename}`;
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);

  // Уведомляем клиента
  const notifyId = resolveClientId(pkg.client_id, pkg.client_username, db);
  if (notifyId && BOT_TOKEN) {
    const base = process.env.WEBAPP_URL || '';
    const caption =
      `📸 <b>Фото вашего товара</b>\n\n` +
      `Трек: <code>${pkg.tracking_number}</code>` +
      (pkg.item_name ? `\n${escHtml(pkg.item_name)}` : '') +
      `\n\nОткройте приложение Monarc чтобы посмотреть`;
    // Пробуем отправить само фото, иначе — текст
    const photoUrl = base ? `${base}${pkg.photo_url}` : null;
    (async () => {
      try {
        if (photoUrl) {
          const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: notifyId, photo: photoUrl, caption, parse_mode: 'HTML' }),
          });
          const d = await r.json();
          if (d.ok) return;
          console.warn('[photo notify] sendPhoto failed, fallback to text:', d.description);
        }
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: notifyId, text: caption, parse_mode: 'HTML' }),
        });
      } catch (err) { console.error('[photo notify] Error:', err.message); }
    })();
  }

  res.json(enrichPackage(pkg));
});

// Admin: удалить фото
app.delete('/api/packages/:id/photo', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];
  if (pkg.photo_url) {
    try { fs.unlinkSync(path.join(PHOTOS_DIR, path.basename(pkg.photo_url))); } catch {}
  }
  pkg.photo_url = null;
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);
  res.json(enrichPackage(pkg));
});

// Track by number
app.get('/api/track/:number', authMiddleware, (req, res) => {
  const { packages } = readDB();
  const pkg = packages.find(p => p.tracking_number === req.params.number.toUpperCase());
  if (!pkg) return res.status(404).json({ error: 'Посылка не найдена' });
  res.json({ ...enrichPackage(pkg), history: pkg.history || [] });
});

// Claim package
app.post('/api/claim/:id', authMiddleware, (req, res) => {
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];
  if (pkg.client_id && pkg.client_id !== req.user.id) return res.status(403).json({ error: 'Посылка принадлежит другому' });
  pkg.client_id = req.user.id;
  pkg.client_username = req.user.username;
  pkg.client_name = req.user.name;
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);
  res.json(enrichPackage(pkg));
});

// Client: remove own package (delete if client-added, unlink if admin-added)
app.delete('/api/my-packages/:id', authMiddleware, (req, res) => {
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];
  const uname = (req.user.username || '').toLowerCase();
  const isOwner = pkg.client_id === req.user.id ||
    (uname && (pkg.client_username || '').toLowerCase() === uname);
  if (!isOwner) return res.status(403).json({ error: 'Нет доступа' });
  if (pkg.source === 'client') {
    db.packages.splice(idx, 1);
  } else {
    pkg.client_id = null; pkg.client_username = null; pkg.client_name = null;
    pkg.updated_at = now(); db.packages[idx] = pkg;
  }
  writeDB(db);
  res.json({ success: true });
});

// Admin: backup — download data.json
app.get('/api/admin/backup', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const data = readDB();
  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="monarc-backup-${date}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// Admin: send backup to Telegram manually
app.post('/api/admin/backup-tg', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  await sendAutoBackup();
  res.json({ success: true });
});

// Admin: restore — upload JSON backup
app.post('/api/admin/restore', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { data } = req.body;
  if (!data || !Array.isArray(data.packages)) return res.status(400).json({ error: 'Неверный формат файла' });

  const pkgIds = data.packages.map(p => p.id).filter(Boolean);
  const invIds = (data.invoices || []).map(i => i.id).filter(Boolean);

  const tplIds  = (data.payment_templates  || []).map(t => t.id).filter(Boolean);
  const ctIds   = (data.client_templates   || []).map(c => c.id).filter(Boolean);
  const addrIds = (data.address_templates  || []).map(a => a.id).filter(Boolean);
  writeDB({
    packages:           data.packages,
    nextId:             data.nextId             || (pkgIds.length  ? Math.max(...pkgIds)  + 1 : 1),
    invoices:           data.invoices           || [],
    nextInvoiceId:      data.nextInvoiceId      || (invIds.length  ? Math.max(...invIds)  + 1 : 1),
    users:              data.users              || [],
    payment_templates:  data.payment_templates  || [],
    nextTemplateId:     data.nextTemplateId     || (tplIds.length  ? Math.max(...tplIds)  + 1 : 1),
    client_templates:   data.client_templates   || [],
    nextClientTplId:    data.nextClientTplId    || (ctIds.length   ? Math.max(...ctIds)   + 1 : 1),
    address_templates:  data.address_templates  || [],
    nextAddressTplId:   data.nextAddressTplId   || (addrIds.length ? Math.max(...addrIds) + 1 : 1),
  });

  res.json({
    success: true,
    packages:  data.packages.length,
    invoices:  (data.invoices || []).length,
    templates: (data.payment_templates || []).length,
    clients:   (data.client_templates  || []).length,
  });
});

// ── Client templates (saved clients) ─────────────────────────────

app.get('/api/client-templates', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  res.json(readDB().client_templates || []);
});

app.post('/api/client-templates', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { name, username, telegram_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Укажите имя клиента' });
  if (!telegram_id && !username) return res.status(400).json({ error: 'Укажите Telegram ID или @username' });
  const db = readDB();
  if (!db.client_templates) db.client_templates = [];
  if (!db.nextClientTplId) db.nextClientTplId = 1;
  const ct = {
    id: db.nextClientTplId++,
    name: name.trim(),
    username: username ? username.replace(/^@/, '').trim().toLowerCase() : null,
    telegram_id: telegram_id ? String(telegram_id).trim() : null,
    created_at: now(),
  };
  db.client_templates.push(ct);
  writeDB(db);
  res.json(ct);
});

app.delete('/api/client-templates/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.client_templates = (db.client_templates || []).filter(c => c.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ── Delivery request ─────────────────────────────────────────────

const DELIVERY_LABELS = { yandex: 'Яндекс Доставка', cdek: 'СДЭК', pochta: 'Почта РФ' };

// Admin: request delivery info from client
app.post('/api/packages/:id/request-delivery', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];
  pkg.delivery_request = { status: 'pending', requested_at: now() };
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);
  const notifyId = resolveClientId(pkg.client_id, pkg.client_username, db);
  if (notifyId && BOT_TOKEN) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: notifyId,
        text: `📬 <b>Требуются данные для доставки</b>\n\nПосылка: <code>${pkg.tracking_number}</code>${pkg.item_name ? '\n' + pkg.item_name : ''}\n\nОткройте приложение и укажите адрес ПВЗ, телефон и ФИО`,
        parse_mode: 'HTML',
      }),
    }).catch(() => {});
  }
  res.json(enrichPackage(pkg));
});

// Client: fill delivery info
app.post('/api/packages/:id/delivery-response', authMiddleware, async (req, res) => {
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });
  const pkg = db.packages[idx];
  const isOwner = pkg.client_id === req.user.id ||
    (pkg.client_username && pkg.client_username.toLowerCase() === (req.user.username || '').toLowerCase());
  if (!isOwner && !req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' });
  const { delivery_type, pickup_address, phone, full_name } = req.body;
  if (!delivery_type || !pickup_address?.trim() || !phone?.trim()) {
    return res.status(400).json({ error: 'Укажите тип доставки, адрес и телефон' });
  }
  pkg.delivery_request = {
    ...pkg.delivery_request,
    status: 'filled',
    delivery_type,
    pickup_address: pickup_address.trim(),
    phone: phone.trim(),
    full_name: full_name?.trim() || null,
    filled_at: now(),
  };
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);
  notifyAdmin(
    `📬 <b>Клиент заполнил данные доставки</b>\n\n` +
    `Посылка: <code>${pkg.tracking_number}</code>${pkg.item_name ? ' · ' + pkg.item_name : ''}\n` +
    `Способ: ${DELIVERY_LABELS[delivery_type] || delivery_type}\n` +
    `Адрес ПВЗ: ${pickup_address}\n` +
    `Телефон: ${phone}` +
    (full_name ? `\nФИО: ${full_name}` : '')
  );
  res.json(enrichPackage(pkg));
});

// ── Address templates ─────────────────────────────────────────────

app.get('/api/address-templates', authMiddleware, (req, res) => {
  const db = readDB();
  const all = db.address_templates || [];
  res.json(req.user.is_admin ? all : all.filter(t => t.owner_id === req.user.id));
});

app.post('/api/address-templates', authMiddleware, (req, res) => {
  const { name, delivery_type, pickup_address, phone, full_name } = req.body;
  if (!name?.trim() || !pickup_address?.trim() || !phone?.trim()) {
    return res.status(400).json({ error: 'Укажите название, адрес и телефон' });
  }
  const db = readDB();
  if (!db.address_templates) db.address_templates = [];
  if (!db.nextAddressTplId) db.nextAddressTplId = 1;
  const tpl = {
    id: db.nextAddressTplId++,
    owner_id: req.user.id,
    name: name.trim(),
    delivery_type: delivery_type || 'cdek',
    pickup_address: pickup_address.trim(),
    phone: phone.trim(),
    full_name: full_name?.trim() || null,
    created_at: now(),
  };
  db.address_templates.push(tpl);
  writeDB(db);
  res.json(tpl);
});

app.delete('/api/address-templates/:id', authMiddleware, (req, res) => {
  const db = readDB();
  const idx = (db.address_templates || []).findIndex(t => t.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  if (db.address_templates[idx].owner_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  db.address_templates.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

// ── Payment templates ─────────────────────────────────────────────

app.get('/api/payment-templates', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  res.json(readDB().payment_templates || []);
});

app.post('/api/payment-templates', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { name, details } = req.body;
  if (!name?.trim() || !details?.trim()) return res.status(400).json({ error: 'Укажите название и реквизиты' });
  const db = readDB();
  if (!db.payment_templates) db.payment_templates = [];
  if (!db.nextTemplateId) db.nextTemplateId = 1;
  const tpl = { id: db.nextTemplateId++, name: name.trim(), details: details.trim(), created_at: now() };
  db.payment_templates.push(tpl);
  writeDB(db);
  res.json(tpl);
});

app.delete('/api/payment-templates/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.payment_templates = (db.payment_templates || []).filter(t => t.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ── Invoice helpers ───────────────────────────────────────────────

function formatAmount(amount, currency) {
  if (currency === 'RUB') return Number(amount).toLocaleString('ru-RU') + ' ₽';
  if (currency === 'EUR') return Number(amount).toLocaleString('ru-RU') + ' €';
  if (currency === 'GBP') return Number(amount).toLocaleString('ru-RU') + ' £';
  return amount + ' USDT';
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyClientInvoice(clientId, inv) {
  if (!BOT_TOKEN || !clientId) return;
  const details = inv.payment_details
    ? `\n\n📋 <b>Реквизиты:</b>\n${escHtml(inv.payment_details)}`
    : '';
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: clientId,
        text: `💰 <b>Новый счёт #${inv.id}</b>\n\n${escHtml(inv.description)}\nСумма: <b>${formatAmount(inv.amount, inv.currency)}</b>${details}\n\nОткройте приложение Monarc чтобы подтвердить оплату`,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[invoice notify] TG failed [${clientId}]:`, data.description);
    else console.log(`[invoice notify] Sent to ${clientId}, inv#${inv.id}`);
  } catch (err) { console.error('[invoice notify] Error:', err.message); }
}

// ── Invoice routes ────────────────────────────────────────────────

// List invoices
app.get('/api/invoices', authMiddleware, (req, res) => {
  const db = readDB();
  const invoices = db.invoices || [];
  const sorted = [...invoices].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (req.user.is_admin) return res.json(sorted);
  const own = sorted.filter(inv =>
    inv.client_id === req.user.id ||
    (inv.client_username && inv.client_username.toLowerCase() === (req.user.username || '').toLowerCase())
  );
  res.json(own);
});

// Create invoice (admin)
app.post('/api/invoices', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { client, amount, currency, description, payment_details } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Укажите сумму' });
  if (!description?.trim()) return res.status(400).json({ error: 'Укажите за что' });

  const db = readDB();
  if (!db.invoices) db.invoices = [];
  if (!db.nextInvoiceId) db.nextInvoiceId = 1;

  // Resolve client: @username, plain username, or numeric ID
  const clientRaw = client ? String(client).trim() : '';
  const isNumericId = /^\d{5,}$/.test(clientRaw); // numeric = Telegram ID (5+ digits)
  const clientId = isNumericId ? clientRaw : null;
  const clientUsername = !isNumericId && clientRaw ? clientRaw.replace(/^@/, '').toLowerCase() : null;
  const foundUser = (db.users || []).find(u =>
    (clientId && u.id === clientId) ||
    (clientUsername && (u.username || '').toLowerCase() === clientUsername)
  );

  console.log(`[invoice] client="${client}" → id=${clientId} uname=${clientUsername} foundUser=${foundUser?.id || 'NOT FOUND'} db.users=${(db.users||[]).length}`);

  const inv = {
    id: db.nextInvoiceId++,
    client_id: clientId || foundUser?.id || null,
    client_username: clientUsername || foundUser?.username || null,
    client_name: foundUser?.name || null,
    amount: parseFloat(amount),
    currency: currency || 'RUB',
    description: description.trim(),
    payment_details: payment_details?.trim() || null,
    status: 'pending',
    created_at: now(), updated_at: now(),
    paid_at: null, confirmed_at: null,
  };

  db.invoices.push(inv);
  writeDB(db);

  const notifyId = resolveClientId(inv.client_id, inv.client_username, db);
  console.log(`[invoice] notifyId=${notifyId} → will send: ${!!notifyId}`);
  if (notifyId) await notifyClientInvoice(notifyId, inv);

  res.json(inv);
});

// Client marks as paid
app.post('/api/invoices/:id/mark-paid', authMiddleware, async (req, res) => {
  const db = readDB();
  const inv = (db.invoices || []).find(i => i.id === parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Счёт не найден' });
  if (inv.status !== 'pending') return res.status(400).json({ error: 'Счёт уже обработан' });

  const isOwner = inv.client_id === req.user.id ||
    (inv.client_username && inv.client_username.toLowerCase() === (req.user.username || '').toLowerCase());
  if (!isOwner && !req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' });

  inv.status = 'reviewing';
  inv.paid_at = now();
  inv.updated_at = now();
  writeDB(db);

  notifyAdmin(
    `💰 <b>Клиент отметил оплату</b>\n\n` +
    `Счёт #${inv.id}: <b>${formatAmount(inv.amount, inv.currency)}</b>\n` +
    `${inv.description}\n` +
    `Клиент: ${inv.client_name || ''}${inv.client_username ? ' @' + inv.client_username : ''}`
  );
  res.json(inv);
});

// Admin confirms payment
app.post('/api/invoices/:id/confirm', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  const inv = (db.invoices || []).find(i => i.id === parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Счёт не найден' });

  inv.status = 'paid';
  inv.confirmed_at = now();
  inv.updated_at = now();
  writeDB(db);

  const notifyId = resolveClientId(inv.client_id, inv.client_username, db);
  if (notifyId && BOT_TOKEN) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: notifyId,
        text: `✅ <b>Оплата подтверждена!</b>\n\nСчёт #${inv.id}: ${formatAmount(inv.amount, inv.currency)}\n${inv.description}`,
        parse_mode: 'HTML',
      }),
    }).catch(() => {});
  }
  res.json(inv);
});

// Admin cancels invoice
app.post('/api/invoices/:id/cancel', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  const inv = (db.invoices || []).find(i => i.id === parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Счёт не найден' });
  inv.status = 'cancelled';
  inv.updated_at = now();
  writeDB(db);
  res.json(inv);
});

// Admin deletes invoice
app.delete('/api/invoices/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.invoices = (db.invoices || []).filter(i => i.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// Stats
app.get('/api/stats', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { packages } = readDB();
  const stats = { total: 0, pending: 0, received: 0, processing: 0, shipped: 0, ready: 0, delivered: 0 };
  packages.forEach(p => { if (stats[p.status] !== undefined) stats[p.status]++; });
  stats.total = packages.length - stats.delivered;
  res.json(stats);
});

// Rates
app.get('/api/rates', (req, res) => {
  res.json([
    {
      id: 'eu', flag: '🇪🇺', name: 'Европа',
      warehouse: 'Парма, Италия', delivery_days: '7–12 дней',
      note: null,
      rates: [
        { name: 'Экспресс',    price: 1900, condition: 'до 5 кг'   },
        { name: 'Наземный',    price: 1750, condition: '5–20 кг'   },
        { name: 'Сборный груз', price: 1300, condition: 'от 20 кг' },
      ],
      popular_stores: ['eBay', 'Grailed', 'Farfetch', 'Jaded London', 'Racer Worldwide', 'Yeezy'],
    },
    {
      id: 'cn', flag: '🇨🇳', name: 'Китай',
      warehouse: 'Пекин, Китай', delivery_days: '8–12 дней (авиа)',
      note: null,
      rates: [
        { name: 'Авиа',     price: 950,  condition: '8–12 дней' },
        { name: 'Экспресс', price: 3500, condition: 'от 1 кг · 1–3 дня' },
        { name: 'Наземный', price: 700,  condition: 'от 5 кг · 13–18 дней' },
      ],
      popular_stores: ['Poizon', 'GooFish (Xianyu)', 'Taobao', '1688'],
    },
    {
      id: 'gb', flag: '🇬🇧', name: 'Великобритания',
      warehouse: 'Великобритания', delivery_days: '~2 недели',
      price_unit: '£ / кор.',
      note: '* Стоимость приблизительная, цена за коробку',
      rates: [
        { name: 'До 2 кг',  price: 19,  condition: '~2 недели' },
        { name: 'До 5 кг',  price: 42,  condition: '~2 недели' },
        { name: 'До 20 кг', price: 118, condition: '~2 недели' },
      ],
      popular_stores: ['Jaded London', 'ASOS', 'Represent', 'End Clothing', 'Size?', 'Footpatrol', 'Palace', 'JD Sports', 'Flannels', 'Selfridges'],
    },
    {
      id: 'jp', flag: '🇯🇵', name: 'Япония',
      warehouse: 'Катано, Япония', delivery_days: '18–23 дня',
      note: '* Стоимость приблизительная, зависит от количества и типов товара. Выкуп с Mercari — моментально, с остальных сайтов — до 1 дня',
      rates: [
        { name: 'Обычная',  price: 1900, condition: '18–23 дней' },
        { name: 'Быстрая',  price: 3900, condition: '6–9 дней'   },
      ],
      popular_stores: ['Mercari', 'Rakuten'],
    },
    {
      id: 'us', flag: '🇺🇸', name: 'США',
      warehouse: 'США', delivery_days: 'индивидуально',
      note: 'Сроки и стоимость доставки из США рассчитываются индивидуально — уточняйте у менеджера',
      rates: [],
      popular_stores: [],
    },
  ]);
});

// ── Export token info ─────────────────────────────────────────────

app.get('/api/admin/export-info', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const base = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
  res.json({
    token: EXPORT_TOKEN,
    csv_url: `${base}/export.csv?token=${EXPORT_TOKEN}`,
    live_url: `${base}/admin/live?token=${EXPORT_TOKEN}`,
    web_url: `${base}/?token=${EXPORT_TOKEN}`,
    sheets_formula: `=IMPORTDATA("${base}/export.csv?token=${EXPORT_TOKEN}")`,
  });
});

// ── CSV Export (token-protected, no auth header needed → works in Google Sheets) ──

app.get('/export.csv', (req, res) => {
  if (req.query.token !== EXPORT_TOKEN) return res.status(403).send('Forbidden');

  const { packages } = readDB();
  const COUNTRY = { eu: 'Европа', gb: 'Великобритания', cn: 'Китай', jp: 'Япония' };
  const STATUS_RU = {
    pending: 'Ожидается', received: 'На складе', processing: 'Обрабатывается',
    shipped: 'В пути', ready: 'Готово к выдаче', delivered: 'Завершён',
  };

  const header = ['ID', 'Трек-номер', 'Статус', 'Страна', 'Вес (кг)', 'Тариф', 'Стоимость (₽)',
    'Клиент', 'Username', 'TG ID', 'Заметка', 'Дата добавления'].join(',');

  const rows = [...packages]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(p => {
      const r = enrichPackage(p);
      const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
      return [
        p.id,
        esc(p.tracking_number),
        esc(STATUS_RU[p.status] || p.status),
        esc(COUNTRY[p.country] || p.country || ''),
        p.weight || '',
        esc(r.type ? (p.country === 'gb' ? r.type + ' (£)' : r.type) : ''),
        r.total || '',
        esc(p.client_name || ''),
        esc(p.client_username ? '@' + p.client_username : ''),
        p.client_id || '',
        esc(p.description || ''),
        `="${new Date(p.created_at).toLocaleDateString('ru-RU')}"`,
      ].join(',');
    });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="monarc-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send('﻿' + [header, ...rows].join('\r\n'));
});

// ── Widget data (для Scriptable виджета на iPhone) ────────────────

app.get('/admin/widget-data', (req, res) => {
  if (req.query.token !== EXPORT_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  const db = readDB();
  const s = { total: db.packages.length, pending: 0, received: 0, processing: 0, shipped: 0, ready: 0, delivered: 0 };
  db.packages.forEach(p => { if (s[p.status] !== undefined) s[p.status]++; });
  const reviewing = (db.invoices || []).filter(i => i.status === 'reviewing').length;
  res.json({ ...s, reviewing_invoices: reviewing });
});

// ── Live admin table ──────────────────────────────────────────────

app.get('/admin/data', (req, res) => {
  if (req.query.token !== EXPORT_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  const { packages } = readDB();
  res.json([...packages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(enrichPackage));
});

app.get('/admin/live', (req, res) => {
  if (req.query.token !== EXPORT_TOKEN) {
    return res.status(403).send('<h1>403 Forbidden</h1>');
  }
  const token = req.query.token;
  const base = process.env.WEBAPP_URL || `http://localhost:${PORT}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-title" content="Monarc Live"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="theme-color" content="#08080f"/>
<link rel="icon" type="image/png" href="/favicon.png?v=2"/>
<title>Monarc — Live таблица</title>
<script>
try{
  var _c=document.createElement('canvas').getContext('2d');
  _c.font='20px sans-serif';
  if(_c.measureText('\u{1F1EA}\u{1F1FA}').width/_c.measureText('\u{1F642}').width>1.4)
    document.documentElement.classList.add('no-flag-emoji');
}catch(e){}
</script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#08080f;color:#f1f5f9;min-height:100vh}
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@900&display=swap');
  /* Флаги на Windows: шрифт только с глифами флагов, включается детектом */
  @font-face{font-family:'TwemojiFlags';src:url('https://cdn.jsdelivr.net/npm/country-flag-emoji-polyfill@0.1/dist/TwemojiCountryFlags.woff2') format('woff2');unicode-range:U+1F1E6-1F1FF,U+1F3F4,U+E0060-E007F;font-display:swap}
  html.no-flag-emoji body{font-family:'TwemojiFlags','Inter',-apple-system,sans-serif}
  header{background:rgba(8,8,15,.9);border-bottom:1px solid rgba(255,255,255,.08);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;backdrop-filter:blur(16px)}
  .logo{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:900;letter-spacing:3px;color:#ffffff}
  .refresh-info{font-size:12px;color:#64748b}
  .countdown{color:#ffffff;font-weight:600}
  .stats{display:flex;gap:12px;padding:16px 20px;flex-wrap:wrap}
  .stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 16px;font-size:13px}
  .stat b{font-size:20px;font-weight:700;display:block;color:#ffffff}
  .wrap{overflow-x:auto;padding:0 20px 40px}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px}
  thead th{text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
  tbody tr{border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s}
  tbody tr:hover{background:rgba(255,255,255,.03)}
  td{padding:10px 12px;vertical-align:middle}
  .track{font-family:monospace;font-size:13px;font-weight:600;letter-spacing:.5px}
  .badge{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
  .b-pending   {background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
  .b-received  {background:rgba(249,115,22,.12);  color:#fb923c;border:1px solid rgba(249,115,22,.25)}
  .b-processing{background:rgba(100,116,139,.12);color:#94a3b8;border:1px solid rgba(100,116,139,.2)}
  .b-shipped   {background:rgba(59,130,246,.12);  color:#60a5fa;border:1px solid rgba(59,130,246,.2)}
  .b-ready     {background:rgba(34,197,94,.12);  color:#4ade80;border:1px solid rgba(34,197,94,.3)}
  .b-delivered {background:rgba(100,116,139,.12);color:#94a3b8;border:1px solid rgba(100,116,139,.2)}
  .muted{color:#475569}
  .csv-link{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:#f1f5f9;text-decoration:none;font-size:12px;font-weight:600}
  .csv-link:hover{background:rgba(255,255,255,.14)}
  .btn-refresh{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#4ade80;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
  .btn-refresh:hover{background:rgba(34,197,94,.18)}
  .btn-refresh.spinning svg{animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .loading{text-align:center;padding:60px;color:#475569}
</style>
</head>
<body>
<header>
  <div class="logo">MONARC</div>
  <div class="refresh-info" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <button class="btn-refresh" id="btn-refresh">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      Обновить
    </button>
    <span style="color:#334155">Авто через <span class="countdown" id="cd">60</span> сек</span>
    <a href="${base}/?token=${token}" class="csv-link">🖥 Открыть приложение</a>
    <a href="${base}/export.csv?token=${token}" class="csv-link">⬇ Скачать CSV</a>
  </div>
</header>
<div class="stats" id="stats"></div>
<div class="wrap"><table id="tbl">
  <thead><tr>
    <th>Трек-номер</th><th>Статус</th><th>Страна</th><th>Вес</th><th>Тариф</th>
    <th>Стоимость</th><th>Клиент</th><th>Заметка</th><th>Добавлено</th>
  </tr></thead>
  <tbody id="tbody"><tr><td colspan="9" class="loading">Загрузка…</td></tr></tbody>
</table></div>
<script>
const TOKEN='${token}';
const BASE='${base}';
const STATUS_RU={pending:'Ожидается',received:'На складе',processing:'Обрабатывается',shipped:'В пути',ready:'Готово к выдаче',delivered:'Завершён'};
const COUNTRY={eu:'🇪🇺 Европа',gb:'🇬🇧 Великобритания',cn:'🇨🇳 Китай',jp:'🇯🇵 Япония'};
function fmt(n){return Number(n).toLocaleString('ru-RU')}
function fmtDate(s){return new Date(s).toLocaleDateString('ru-RU',{day:'2-digit',month:'short',year:'numeric'})}

async function load(){
  try{
    const r=await fetch(BASE+'/admin/data?token='+TOKEN);
    const pkgs=await r.json();
    const stats={total:pkgs.length,pending:0,received:0,shipped:0,ready:0,delivered:0};
    pkgs.forEach(p=>{ if(stats[p.status]!==undefined) stats[p.status]++ });
    document.getElementById('stats').innerHTML=
      \`<div class="stat"><b>\${stats.total}</b>Всего</div>
       <div class="stat"><b>\${stats.pending}</b>Ожидают</div>
       <div class="stat"><b>\${stats.received}</b>На складе</div>
       <div class="stat"><b>\${stats.shipped}</b>В пути</div>
       <div class="stat"><b style="-webkit-text-fill-color:#4ade80">\${stats.ready}</b>Готово</div>
       <div class="stat"><b>\${stats.delivered}</b>Завершён</div>\`;
    document.getElementById('tbody').innerHTML=pkgs.map(p=>\`<tr>
      <td class="track">\${p.tracking_number}</td>
      <td><span class="badge b-\${p.status}">\${STATUS_RU[p.status]||p.status}</span></td>
      <td>\${COUNTRY[p.country]||p.country||'—'}</td>
      <td>\${p.weight?p.weight+' кг':'—'}</td>
      <td class="muted">\${p.type||'—'}</td>
      <td>\${p.total?(p.country==='gb'?'~£'+fmt(p.total):'~'+fmt(p.total)+' ₽'):'—'}</td>
      <td>\${p.client_name||''}${' '}\${p.client_username?'@'+p.client_username:''}\${!p.client_name&&!p.client_username&&p.client_id?'ID: '+p.client_id:''}</td>
      <td class="muted">\${p.description||''}</td>
      <td class="muted">\${fmtDate(p.created_at)}</td>
    </tr>\`).join('');
  }catch(e){ document.getElementById('tbody').innerHTML='<tr><td colspan="9" class="loading">Ошибка загрузки</td></tr>' }
}

let sec=60;
function tick(){
  sec--;
  document.getElementById('cd').textContent=sec;
  if(sec<=0){ sec=60; load(); }
}

document.getElementById('btn-refresh').addEventListener('click',()=>{
  const btn=document.getElementById('btn-refresh');
  btn.classList.add('spinning'); btn.disabled=true;
  sec=60; document.getElementById('cd').textContent=sec;
  load().finally(()=>{ btn.classList.remove('spinning'); btn.disabled=false; });
});

load();
setInterval(tick,1000);
</script>
</body></html>`);
});

// ── Telegram webhook ──────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ответить Telegram сразу
  const update = req.body;
  if (!update?.message) return;

  const { chat, from, text } = update.message;

  // Сохраняем username → ID при каждом сообщении
  if (from && !from.is_bot && from.username) {
    const db = readDB();
    if (!db.users) db.users = [];
    const idx = db.users.findIndex(u => u.id === String(from.id));
    const userData = {
      id: String(from.id),
      username: from.username.toLowerCase(),
      name: [from.first_name, from.last_name].filter(Boolean).join(' '),
      updated_at: now(),
    };
    if (idx === -1) { userData.created_at = now(); db.users.push(userData); }
    else db.users[idx] = { ...db.users[idx], ...userData };
    writeDB(db);
  }

  if (text !== '/start') return;

  const WEBAPP_URL = process.env.WEBAPP_URL;
  const welcome =
    `Добро пожаловать в <b>Monarc Cargo</b>! 🚀\n\n` +

    `📦 <b>Доставляем товары из:</b>\n` +
    `🇮🇹 Италия  •  🇬🇧 UK  •  🇨🇳 Китай  •  🇯🇵 Япония\n\n` +

    `<b>Что умеет приложение:</b>\n\n` +

    `🔍 <b>Трекинг посылок</b>\n` +
    `Добавь свой трек-номер и следи за статусом — от склада до выдачи. Уведомление придёт автоматически при каждом изменении.\n\n` +

    `📸 <b>Фото товара</b>\n` +
    `Менеджер прикрепит фото твоего товара прямо на складе — увидишь что пришло, ещё до получения.\n\n` +

    `💰 <b>Счета на оплату</b>\n` +
    `Менеджер выставит счёт прямо в приложении — оплати и отметь кнопкой. Подтверждение придёт сюда.\n\n` +

    `🚚 <b>Запрос доставки</b>\n` +
    `Укажи адрес пункта выдачи (Яндекс / СДЭК / Почта РФ) — менеджер организует последнюю милю.\n\n` +

    `📊 <b>Тарифы и калькулятор</b>\n` +
    `Смотри актуальные цены по всем направлениям и считай стоимость доставки по весу.\n\n` +

    `Открой приложение 👇`;

  const keyboard = WEBAPP_URL ? {
    inline_keyboard: [[{ text: '📦 Открыть Monarc Cargo', web_app: { url: WEBAPP_URL } }]],
  } : undefined;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat.id,
        text: welcome,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }),
    });
  } catch (err) { console.error('Webhook send error:', err.message); }
});

// ── Bot setup ─────────────────────────────────────────────────────

async function setupBot() {
  if (!BOT_TOKEN) return;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  if (!WEBAPP_URL || WEBAPP_URL === 'https://yourdomain.com') return;
  try {
    // Меню-кнопка
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: '📦 Monarc', web_app: { url: WEBAPP_URL } } }),
    });
    // Регистрация webhook
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${WEBAPP_URL}/webhook` }),
    });
    console.log('Bot ready, webhook:', `${WEBAPP_URL}/webhook`);
  } catch {}
}

// ── Hourly auto-backup → Telegram ────────────────────────────────

async function sendAutoBackup() {
  if (!BOT_TOKEN) return;
  try {
    const data = readDB();
    const date = new Date();
    const label = date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    });
    const tag = date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const filename = `monarc-backup-${tag}.json`;
    const json = JSON.stringify(data, null, 2);

    const form = new FormData();
    form.append('chat_id', ADMIN_ID);
    const invoices = (data.invoices || []).length;
    const env = process.env.NODE_ENV || 'local';
    form.append('caption', `🗄 <b>Авто-бэкап Monarc</b>\n🕐 ${label} (МСК)\n📊 Посылок: <b>${data.packages.length}</b> · Счетов: <b>${invoices}</b>\n🖥 ${env} · ${DB_FILE}`);
    form.append('parse_mode', 'HTML');
    form.append('document', new Blob([json], { type: 'application/json' }), filename);

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST', body: form,
    });
    console.log(`[backup] Sent: ${filename} (${data.packages.length} packages)`);
  } catch (err) {
    console.error('[backup] Error:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n🏭 Monarc Cargo  →  http://localhost:${PORT}`);
  console.log(`   Admin ID : ${ADMIN_ID}`);
  console.log(`   Mode     : ${process.env.NODE_ENV}`);
  console.log(`   Data dir : ${DATA_DIR}${process.env.RAILWAY_VOLUME_MOUNT_PATH ? ' (Railway Volume)' : ''}\n`);
  setupBot();
  setInterval(sendAutoBackup, 6 * 60 * 60 * 1000); // every 6 hours
});
