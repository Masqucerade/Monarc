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
    `<b>🏭 Monarc Cargo</b>\n\n` +
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

app.listen(PORT, () => {
  console.log(`\n🏭 Monarc Cargo  →  http://localhost:${PORT}`);
  console.log(`   Admin ID : ${ADMIN_ID}`);
  console.log(`   Mode     : ${process.env.NODE_ENV}\n`);
  setupBot();
});
