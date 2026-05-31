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
const DB_FILE = path.join(__dirname, 'data.json');

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

// ── Middleware ────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const initData = req.headers['x-telegram-init-data'];
  if (process.env.NODE_ENV !== 'production') {
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
    username: user.username || '',
    name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    is_admin: String(user.id) === ADMIN_ID,
  };
  next();
}

// ── Rate calculation ──────────────────────────────────────────────

function calcRate(weight, country = 'eu') {
  if (!weight || weight <= 0) return { type: '—', rate: 0 };
  if (country === 'cn') {
    if (weight >= 20) return { type: 'Наземный', rate: 800 };
    return { type: 'Авиа', rate: 1200 };
  }
  if (country === 'jp') return { type: 'Обычная', rate: 2000 };
  // EU default
  if (weight <= 5)  return { type: 'Экспресс',    rate: 1900 };
  if (weight <= 20) return { type: 'Наземный',     rate: 1750 };
  return                   { type: 'Сборный груз', rate: 1300 };
}

function enrichPackage(p) {
  if (p.tariff_type && p.tariff_rate) {
    const total = p.tariff_rate > 0 && p.weight > 0 ? Math.round(p.weight * p.tariff_rate) : 0;
    return { ...p, type: p.tariff_type, rate: p.tariff_rate, total };
  }
  const r = calcRate(p.weight, p.country || 'eu');
  const total = r.rate > 0 ? Math.round((p.weight || 0) * r.rate) : 0;
  return { ...p, ...r, total };
}

// ── Notifications ─────────────────────────────────────────────────

const STATUS_LABELS = {
  pending: 'Ожидается', received: 'На складе', processing: 'Обрабатывается',
  shipped: 'В пути', ready: 'Готово к выдаче', delivered: 'Выдано',
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
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: clientId, text, parse_mode: 'HTML' }),
    });
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

// List packages
app.get('/api/packages', authMiddleware, (req, res) => {
  const { status, search } = req.query;
  let { packages } = readDB();

  if (req.user.is_admin) {
    if (status && status !== 'all') packages = packages.filter(p => p.status === status);
    if (search) {
      const s = search.toLowerCase();
      packages = packages.filter(p =>
        p.tracking_number.toLowerCase().includes(s) ||
        (p.client_name || '').toLowerCase().includes(s) ||
        (p.client_username || '').toLowerCase().includes(s)
      );
    }
  } else {
    packages = packages.filter(p => p.client_id === req.user.id);
  }

  packages = [...packages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(packages.map(enrichPackage));
});

// Admin: create package
app.post('/api/packages', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });

  const { tracking_number, client_id, client_username, client_name, weight, country, description, status } = req.body;
  if (!tracking_number?.trim()) return res.status(400).json({ error: 'Трек-номер обязателен' });
  if (!weight || isNaN(weight) || weight <= 0) return res.status(400).json({ error: 'Вес обязателен' });

  const db = readDB();
  const track = tracking_number.trim().toUpperCase();
  if (db.packages.find(p => p.tracking_number === track)) {
    return res.status(400).json({ error: 'Такой трек-номер уже существует' });
  }

  const initStatus = status || 'received';
  const { tariff_type, tariff_rate } = req.body;
  const pkg = {
    id: db.nextId++,
    tracking_number: track,
    client_id: client_id || null,
    client_username: client_username ? client_username.replace('@', '') : null,
    client_name: client_name || null,
    weight: parseFloat(weight),
    country: country || 'eu',
    tariff_type: tariff_type || null,
    tariff_rate: tariff_rate ? parseFloat(tariff_rate) : null,
    status: initStatus,
    description: description || null,
    source: 'admin',
    history: [{ status: initStatus, changed_at: now() }],
    created_at: now(),
    updated_at: now(),
  };

  db.packages.push(pkg);
  writeDB(db);
  if (client_id) notifyClient(client_id, pkg.tracking_number, initStatus);
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
  const countryLabel = { eu: '🇪🇺 Европа', cn: '🇨🇳 Китай', jp: '🇯🇵 Япония' }[country] || '—';
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
  const { status, weight, description, client_id, client_username, client_name, country } = req.body;

  if (status)                    pkg.status = status;
  if (weight)                    pkg.weight = parseFloat(weight);
  if (country)                   pkg.country = country;
  if (description !== undefined) pkg.description = description || null;
  if (client_id)                 pkg.client_id = client_id;
  if (client_username !== undefined) pkg.client_username = client_username ? client_username.replace('@', '') : null;
  if (client_name !== undefined)     pkg.client_name = client_name || null;
  pkg.updated_at = now();

  if (status && status !== prev) {
    if (!pkg.history) pkg.history = [];
    pkg.history.push({ status, changed_at: now() });
  }

  db.packages[idx] = pkg;
  writeDB(db);
  if (status && status !== prev && pkg.client_id) notifyClient(pkg.client_id, pkg.tracking_number, status);
  res.json(enrichPackage(pkg));
});

// Admin: delete
app.delete('/api/packages/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.packages = db.packages.filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
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
  if (pkg.client_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
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

// Admin: restore — upload JSON backup
app.post('/api/admin/restore', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { data } = req.body;
  if (!data || !Array.isArray(data.packages)) return res.status(400).json({ error: 'Неверный формат файла' });
  writeDB({ packages: data.packages, nextId: data.nextId || (Math.max(0, ...data.packages.map(p => p.id)) + 1) });
  res.json({ success: true, count: data.packages.length });
});

// Stats
app.get('/api/stats', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { packages } = readDB();
  const stats = { total: packages.length, pending: 0, received: 0, processing: 0, shipped: 0, ready: 0, delivered: 0 };
  packages.forEach(p => { if (stats[p.status] !== undefined) stats[p.status]++; });
  res.json(stats);
});

// Rates
app.get('/api/rates', (req, res) => {
  res.json([
    {
      id: 'eu', flag: '🇪🇺', name: 'Европа',
      warehouse: 'Парма, Италия', delivery_days: '10–15 дней',
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
      warehouse: 'Пекин, Китай', delivery_days: '17–25 дней',
      note: null,
      rates: [
        { name: 'Авиа',     price: 1200, condition: '20–25 дней' },
        { name: 'Экспресс', price: 3500, condition: '1–6 дней'   },
        { name: 'Наземный', price: 800,  condition: 'от 20 кг · 17–25 дней' },
      ],
      popular_stores: ['Poizon', 'GooFish (Xianyu)', 'Taobao', '1688'],
    },
    {
      id: 'jp', flag: '🇯🇵', name: 'Япония',
      warehouse: 'Катано, Япония', delivery_days: '2–4 нед.',
      note: '* Стоимость приблизительная, зависит от количества и типа товара',
      rates: [
        { name: 'Обычная',  price: 2000, condition: '~25–30 дней' },
        { name: 'Быстрая',  price: 4000, condition: '~2 недели'   },
      ],
      popular_stores: ['Mercari', 'Rakuten'],
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
    sheets_formula: `=IMPORTDATA("${base}/export.csv?token=${EXPORT_TOKEN}")`,
  });
});

// ── CSV Export (token-protected, no auth header needed → works in Google Sheets) ──

app.get('/export.csv', (req, res) => {
  if (req.query.token !== EXPORT_TOKEN) return res.status(403).send('Forbidden');

  const { packages } = readDB();
  const COUNTRY = { eu: 'Европа', cn: 'Китай', jp: 'Япония' };
  const STATUS_RU = {
    pending: 'Ожидается', received: 'На складе', processing: 'Обрабатывается',
    shipped: 'В пути', ready: 'Готово к выдаче', delivered: 'Выдано',
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
        esc(r.type || ''),
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
<title>Monarc — Live таблица</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#08080f;color:#f1f5f9;min-height:100vh}
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@900&display=swap');
  header{background:rgba(8,8,15,.9);border-bottom:1px solid rgba(255,255,255,.08);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;backdrop-filter:blur(16px)}
  .logo{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:900;letter-spacing:3px;background:linear-gradient(135deg,#fff,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .refresh-info{font-size:12px;color:#64748b}
  .countdown{color:#a78bfa;font-weight:600}
  .stats{display:flex;gap:12px;padding:16px 20px;flex-wrap:wrap}
  .stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 16px;font-size:13px}
  .stat b{font-size:20px;font-weight:700;display:block;background:linear-gradient(135deg,#fff,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .wrap{overflow-x:auto;padding:0 20px 40px}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px}
  thead th{text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
  tbody tr{border-bottom:1px solid rgba(255,255,255,.04);transition:background .15s}
  tbody tr:hover{background:rgba(255,255,255,.03)}
  td{padding:10px 12px;vertical-align:middle}
  .track{font-family:monospace;font-size:13px;font-weight:600;letter-spacing:.5px}
  .badge{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
  .b-pending   {background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
  .b-received  {background:rgba(59,130,246,.12); color:#60a5fa;border:1px solid rgba(59,130,246,.2)}
  .b-processing{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
  .b-shipped   {background:rgba(139,92,246,.12); color:#a78bfa;border:1px solid rgba(139,92,246,.3)}
  .b-ready     {background:rgba(34,197,94,.12);  color:#4ade80;border:1px solid rgba(34,197,94,.3)}
  .b-delivered {background:rgba(100,116,139,.12);color:#94a3b8;border:1px solid rgba(100,116,139,.2)}
  .muted{color:#475569}
  .csv-link{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.35);color:#a78bfa;text-decoration:none;font-size:12px;font-weight:600}
  .csv-link:hover{background:rgba(139,92,246,.2)}
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
const STATUS_RU={pending:'Ожидается',received:'На складе',processing:'Обрабатывается',shipped:'В пути',ready:'Готово к выдаче',delivered:'Выдано'};
const COUNTRY={eu:'🇪🇺 Европа',cn:'🇨🇳 Китай',jp:'🇯🇵 Япония'};
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
       <div class="stat"><b>\${stats.delivered}</b>Выдано</div>\`;
    document.getElementById('tbody').innerHTML=pkgs.map(p=>\`<tr>
      <td class="track">\${p.tracking_number}</td>
      <td><span class="badge b-\${p.status}">\${STATUS_RU[p.status]||p.status}</span></td>
      <td>\${COUNTRY[p.country]||p.country||'—'}</td>
      <td>\${p.weight?p.weight+' кг':'—'}</td>
      <td class="muted">\${p.type||'—'}</td>
      <td>\${p.total?'~'+fmt(p.total)+' ₽':'—'}</td>
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

// ── Bot setup ─────────────────────────────────────────────────────

async function setupBot() {
  if (!BOT_TOKEN) return;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  if (!WEBAPP_URL || WEBAPP_URL === 'https://yourdomain.com') return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: '📦 Monarc', web_app: { url: WEBAPP_URL } } }),
    });
    console.log('Bot menu button set to:', WEBAPP_URL);
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
    form.append('caption', `🗄 <b>Авто-бэкап Monarc</b>\n🕐 ${label} (МСК)\n📊 Посылок: <b>${data.packages.length}</b>`);
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
  console.log(`   Mode     : ${process.env.NODE_ENV}\n`);
  setupBot();
  setInterval(sendAutoBackup, 60 * 60 * 1000); // every hour
});
