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
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { packages: [], nextId: 1 };
  }
}

function writeDB(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function now() {
  return new Date().toISOString();
}

// ── Middleware ────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Telegram Auth ─────────────────────────────────────────────────

function verifyTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return computed === hash;
  } catch {
    return false;
  }
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  if (process.env.NODE_ENV !== 'production') {
    if (!initData || initData === 'dev') {
      const devId = req.headers['x-dev-user-id'] || '000000000';
      req.user = {
        id: String(devId),
        username: 'devuser',
        name: 'Dev User',
        is_admin: String(devId) === ADMIN_ID,
      };
      return next();
    }
  }

  if (!initData) return res.status(401).json({ error: 'Unauthorized' });

  if (!verifyTelegramData(initData)) {
    return res.status(401).json({ error: 'Invalid Telegram auth data' });
  }

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

// ── Helpers ───────────────────────────────────────────────────────

function calcRate(weight) {
  if (weight <= 5)  return { type: 'Экспресс',     rate: 1900 };
  if (weight <= 20) return { type: 'Наземный',      rate: 1750 };
  return                   { type: 'Сборный груз',  rate: 1300 };
}

function enrichPackage(p) {
  const r = calcRate(p.weight);
  return { ...p, ...r, total: Math.round(p.weight * r.rate) };
}

async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

const STATUS_LABELS = {
  received: 'На складе', processing: 'Обрабатывается',
  shipped: 'В пути', ready: 'Готово к выдаче', delivered: 'Выдано',
};

async function notifyClient(clientId, trackingNumber, status) {
  const emoji = { received: '📦', processing: '⚙️', shipped: '🚚', ready: '✅', delivered: '🎉' }[status] || '📬';
  const text =
    `<b>🏭 Monarc Cargo</b>\n\n` +
    `${emoji} Статус вашей посылки изменён\n\n` +
    `Трек-номер: <code>${trackingNumber}</code>\n` +
    `Статус: <b>${STATUS_LABELS[status] || status}</b>`;
  await sendTelegramMessage(clientId, text);
}

// ── API Routes ────────────────────────────────────────────────────

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user));

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

app.post('/api/packages', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });

  const { tracking_number, client_id, client_username, client_name, weight, description } = req.body;
  if (!tracking_number?.trim() || !weight || isNaN(weight) || weight <= 0) {
    return res.status(400).json({ error: 'Трек-номер и вес обязательны' });
  }

  const db = readDB();
  const track = tracking_number.trim().toUpperCase();

  if (db.packages.find(p => p.tracking_number === track)) {
    return res.status(400).json({ error: 'Такой трек-номер уже существует' });
  }

  const pkg = {
    id: db.nextId++,
    tracking_number: track,
    client_id: client_id || null,
    client_username: client_username ? client_username.replace('@', '') : null,
    client_name: client_name || null,
    weight: parseFloat(weight),
    status: 'received',
    description: description || null,
    history: [{ status: 'received', changed_at: now() }],
    created_at: now(),
    updated_at: now(),
  };

  db.packages.push(pkg);
  writeDB(db);

  if (client_id) notifyClient(client_id, pkg.tracking_number, 'received');

  res.json(enrichPackage(pkg));
});

app.put('/api/packages/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });

  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });

  const pkg = db.packages[idx];
  const prev = pkg.status;
  const { status, weight, description, client_id, client_username, client_name } = req.body;

  if (status)           pkg.status = status;
  if (weight)           pkg.weight = parseFloat(weight);
  if (description !== undefined) pkg.description = description || null;
  if (client_id)        pkg.client_id = client_id;
  if (client_username !== undefined) pkg.client_username = client_username ? client_username.replace('@', '') : null;
  if (client_name !== undefined)     pkg.client_name = client_name || null;
  pkg.updated_at = now();

  if (status && status !== prev) {
    if (!pkg.history) pkg.history = [];
    pkg.history.push({ status, changed_at: now() });
  }

  db.packages[idx] = pkg;
  writeDB(db);

  if (status && status !== prev && pkg.client_id) {
    notifyClient(pkg.client_id, pkg.tracking_number, status);
  }

  res.json(enrichPackage(pkg));
});

app.delete('/api/packages/:id', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const db = readDB();
  db.packages = db.packages.filter(p => p.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/track/:number', authMiddleware, (req, res) => {
  const { packages } = readDB();
  const pkg = packages.find(p => p.tracking_number === req.params.number.toUpperCase());
  if (!pkg) return res.status(404).json({ error: 'Посылка не найдена' });
  res.json({ ...enrichPackage(pkg), history: pkg.history || [] });
});

app.post('/api/claim/:id', authMiddleware, (req, res) => {
  const db = readDB();
  const idx = db.packages.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Посылка не найдена' });

  const pkg = db.packages[idx];
  if (pkg.client_id && pkg.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Посылка принадлежит другому пользователю' });
  }

  pkg.client_id = req.user.id;
  pkg.client_username = req.user.username;
  pkg.client_name = req.user.name;
  pkg.updated_at = now();
  db.packages[idx] = pkg;
  writeDB(db);

  res.json(enrichPackage(pkg));
});

app.get('/api/stats', authMiddleware, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { packages } = readDB();
  const stats = { total: packages.length, received: 0, processing: 0, shipped: 0, ready: 0, delivered: 0 };
  packages.forEach(p => { if (stats[p.status] !== undefined) stats[p.status]++; });
  res.json(stats);
});

app.get('/api/rates', (req, res) => {
  res.json([{
    id: 'eu', flag: '🇪🇺', name: 'Европа',
    warehouse: 'Парма, Италия', destination: 'Москва', delivery_days: '10–15 дней',
    rates: [
      { name: 'Экспресс',     price: 1900, condition: 'до 5 кг'   },
      { name: 'Наземный',      price: 1750, condition: '5–20 кг'  },
      { name: 'Сборный груз',  price: 1300, condition: 'от 20 кг' },
    ],
    popular_stores: ['eBay', 'Grailed', 'Farfetch', 'Jaded London', 'Racer Worldwide', 'Yeezy'],
  }]);
});

// ── Bot Setup ─────────────────────────────────────────────────────

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

// ── Start ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🏭 Monarc Cargo  →  http://localhost:${PORT}`);
  console.log(`   Admin ID : ${ADMIN_ID}`);
  console.log(`   Mode     : ${process.env.NODE_ENV}\n`);
  setupBot();
});
