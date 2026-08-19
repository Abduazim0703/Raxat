require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');
const yookassa = require('./yookassa');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- отдаём три приложения прямо с бэкенда — один деплой, один адрес ----------
// index.html отдаётся автоматически на "/" благодаря express.static.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/staff', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'staff.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'owner.html')));

// ---------- photo uploads ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — телефонные фото с камеры укладываются с запасом
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new Error('Разрешены только изображения (JPEG, PNG, WEBP, GIF)'));
    }
    cb(null, true);
  },
});

const OWNER_API_KEY = process.env.OWNER_API_KEY || 'change-me-owner-key';
const STAFF_API_KEY = process.env.STAFF_API_KEY || 'change-me-staff-key';

const ACTIVE_STATUSES = ['awaiting_cash', 'paid', 'preparing', 'ready'];
const STAFF_ALLOWED_TRANSITIONS = { paid: 'preparing', preparing: 'ready', ready: 'served' };

// ---------- helpers ----------
function getSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}
function requireOwner(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== OWNER_API_KEY) {
    return res.status(401).json({ error: 'Неверный или отсутствующий x-api-key' });
  }
  next();
}
function requireStaff(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== STAFF_API_KEY && key !== OWNER_API_KEY) {
    return res.status(401).json({ error: 'Неверный или отсутствующий x-api-key' });
  }
  next();
}
function genOrderNumber() {
  const n = 100 + Math.floor(Math.random() * 900);
  return 'RH-' + n;
}

// ================= PUBLIC: menu =================
// Anyone can read the menu — this is what the guest-facing app calls.
app.get('/api/menu', (req, res) => {
  const rows = db.prepare(`SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name`).all();
  res.json({
    items: rows.map(r => ({
      id: r.id, name: r.name, description: r.description, weight: r.weight,
      kcal: r.kcal, price: r.price, category: r.category, isDishOfDay: !!r.is_dish_of_day,
      inStock: !!r.in_stock, imageUrl: r.image_url || null,
    })),
  });
});

// ================= PUBLIC: call a waiter (no order needed) =================
app.post('/api/waiter-calls', (req, res) => {
  const { table } = req.body || {};
  if (!table) return res.status(400).json({ error: 'Нужно указать table' });
  const result = db.prepare(`INSERT INTO waiter_calls (table_number, created_at) VALUES (?, ?)`)
    .run(String(table), Date.now());
  res.status(201).json({ ok: true, callId: result.lastInsertRowid });
});

// ================= PUBLIC: create order =================
// The client sends only item ids + quantities. Price is always looked up
// server-side — never trust a price the browser sends you.
app.post('/api/orders', async (req, res) => {
  const { table, items, dineType, paymentMethod } = req.body || {};
  if (!table || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Нужно указать table и непустой массив items: [{id, qty}]' });
  }
  if (!['dine_in', 'takeaway'].includes(dineType)) {
    return res.status(400).json({ error: `dineType должен быть "dine_in" или "takeaway"` });
  }
  if (!['sbp', 'cash'].includes(paymentMethod)) {
    return res.status(400).json({ error: `paymentMethod должен быть "sbp" или "cash"` });
  }

  const menuRows = db.prepare(`SELECT * FROM menu_items WHERE active = 1`).all();
  const menuById = Object.fromEntries(menuRows.map(r => [r.id, r]));

  const lineItems = [];
  let subtotal = 0;
  for (const it of items) {
    const menuItem = menuById[it.id];
    const qty = Number(it.qty) || 0;
    if (!menuItem || qty <= 0) {
      return res.status(400).json({ error: `Неизвестное блюдо или некорректное количество: ${it.id}` });
    }
    if (!menuItem.in_stock) {
      return res.status(409).json({ error: `«${menuItem.name}» сейчас нет в наличии — обновите меню и уберите это блюдо из заказа`, itemId: menuItem.id });
    }
    lineItems.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, qty });
    subtotal += menuItem.price * qty;
  }

  const commissionRate = parseFloat(getSetting('commission_rate', '0.04'));
  const commissionAmount = Math.round(subtotal * commissionRate);
  const orderNumber = genOrderNumber();
  const now = Date.now();
  // Cash orders skip the bank-payment flow entirely — a waiter has to physically
  // collect cash or walk the guest to a till, so there is no "pending_payment" step.
  const initialStatus = paymentMethod === 'cash' ? 'awaiting_cash' : 'pending_payment';

  const result = db.prepare(`
    INSERT INTO orders (order_number, table_number, items_json, subtotal, commission_rate, commission_amount, status, dine_type, payment_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderNumber, String(table), JSON.stringify(lineItems), subtotal, commissionRate, commissionAmount, initialStatus, dineType, paymentMethod, now);

  const response = {
    orderId: result.lastInsertRowid, orderNumber, subtotal, status: initialStatus, dineType, paymentMethod,
  };

  if (paymentMethod === 'sbp') {
    if (yookassa.isConfigured()) {
      // Реальный платёж СБП через ЮKassa. Гость переходит по confirmationUrl —
      // там ЮKassa сама покажет список банков (на телефоне) или QR (на компьютере).
      try {
        const returnUrl = `${req.protocol}://${req.get('host')}/?order=${orderNumber}`;
        const payment = await yookassa.createSbpPayment({
          amountRub: subtotal,
          description: `Заказ ${orderNumber}, стол ${table}`,
          orderNumber,
          returnUrl,
        });
        db.prepare(`UPDATE orders SET yk_payment_id = ? WHERE order_number = ?`).run(payment.paymentId, orderNumber);
        response.confirmationUrl = payment.confirmationUrl;
      } catch (err) {
        console.error('YooKassa createSbpPayment failed:', err.message);
        return res.status(502).json({ error: 'Не удалось создать платёж СБП. Попробуйте ещё раз или оплатите наличными.' });
      }
    } else {
      // Платёжный агрегатор ещё не подключён — оставляем демонстрационную заглушку,
      // чтобы приложение можно было показывать и тестировать без реальных денег.
      response.paymentStub = { note: 'ЮKassa не настроена (нет YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY) — это демо-режим.' };
    }
  }

  res.status(201).json(response);
});

// ================= PUBLIC: payment webhook =================
// В демо-режиме (без настоящего эквайринга) этот путь просто ставит "оплачено" по
// запросу гостя — так и должно быть, это заглушка. Как только подключена ЮKassa,
// этот же путь начинает делать это ПРАВИЛЬНО: он больше не принимает запрос гостя
// напрямую (см. защиту ниже), а статус меняет только настоящий вебхук от ЮKassa,
// причём мы ещё и сами перепроверяем платёж через их API, а не верим телу вебхука.
app.post('/api/orders/:orderNumber/confirm-payment', (req, res) => {
  if (yookassa.isConfigured()) {
    return res.status(410).json({
      error: 'Ручное подтверждение оплаты отключено — платёж подтверждается только банком через вебхук.',
    });
  }
  const { orderNumber } = req.params;
  const { bank } = req.body || {};
  const order = db.prepare(`SELECT * FROM orders WHERE order_number = ?`).get(orderNumber);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  db.prepare(`UPDATE orders SET status = 'paid', bank = ?, paid_at = ? WHERE order_number = ?`)
    .run(bank || null, Date.now(), orderNumber);

  res.json({ ok: true, orderNumber, status: 'paid' });
});

// Сюда стучится ЮKassa, когда статус платежа меняется. Настраивается в личном
// кабинете ЮKassa: Интеграция → HTTP-уведомления → этот адрес + /api/webhooks/yookassa.
app.post('/api/webhooks/yookassa', async (req, res) => {
  try {
    const paymentId = req.body?.object?.id;
    if (!paymentId) return res.status(400).json({ error: 'Нет id платежа в уведомлении' });

    // Никогда не доверяем статусу из тела вебхука напрямую — переспрашиваем
    // у самой ЮKassa, что реально произошло с этим платежом.
    const payment = await yookassa.getPayment(paymentId);
    const orderNumber = payment.metadata?.order_number;
    if (!orderNumber) return res.status(200).json({ ok: true }); // не наш платёж — просто отвечаем 200

    if (payment.status === 'succeeded') {
      db.prepare(`
        UPDATE orders SET status = 'paid', paid_at = ?, bank = COALESCE(bank, 'СБП')
        WHERE order_number = ? AND status != 'paid'
      `).run(Date.now(), orderNumber);
    } else if (payment.status === 'canceled') {
      db.prepare(`UPDATE orders SET status = 'payment_failed' WHERE order_number = ? AND status = 'pending_payment'`)
        .run(orderNumber);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('YooKassa webhook error:', err.message);
    // 200 даже при ошибке на нашей стороне — иначе ЮKassa будет бесконечно ретраить
    // один и тот же вебхук; ошибку смотрим в логах сервера.
    res.status(200).json({ ok: false });
  }
});

app.get('/api/orders/:orderNumber', (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE order_number = ?`).get(req.params.orderNumber);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(formatOrder(order));
});

function formatOrder(o) {
  return {
    orderNumber: o.order_number,
    table: o.table_number,
    items: JSON.parse(o.items_json),
    subtotal: o.subtotal,
    commissionRate: o.commission_rate,
    commissionAmount: o.commission_amount,
    status: o.status,
    dineType: o.dine_type,
    paymentMethod: o.payment_method,
    bank: o.bank,
    createdAt: o.created_at,
    paidAt: o.paid_at,
  };
}

// ================= STAFF-ONLY: kitchen / waiter view =================
app.use('/api/staff', requireStaff);

app.get('/api/staff/orders', (req, res) => {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM orders WHERE status IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...ACTIVE_STATUSES);
  res.json({ orders: rows.map(formatOrder) });
});

app.post('/api/staff/orders/:orderNumber/advance', (req, res) => {
  const { orderNumber } = req.params;
  const order = db.prepare(`SELECT * FROM orders WHERE order_number = ?`).get(orderNumber);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  const nextStatus = STAFF_ALLOWED_TRANSITIONS[order.status];
  if (!nextStatus) {
    return res.status(400).json({ error: `Нельзя изменить статус из "${order.status}"` });
  }
  db.prepare(`UPDATE orders SET status = ? WHERE order_number = ?`).run(nextStatus, orderNumber);
  res.json({ ok: true, orderNumber, status: nextStatus });
});

// Cash orders don't go through a bank webhook — a waiter physically collects the
// money (or walks the guest to the till) and confirms it here. This is the moment
// the order counts as real revenue, same as an SBP confirm-payment call.
app.post('/api/staff/orders/:orderNumber/confirm-cash', (req, res) => {
  const { orderNumber } = req.params;
  const order = db.prepare(`SELECT * FROM orders WHERE order_number = ?`).get(orderNumber);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.payment_method !== 'cash') {
    return res.status(400).json({ error: 'Этот заказ не наличный' });
  }
  if (order.status !== 'awaiting_cash') {
    return res.status(400).json({ error: `Заказ уже в статусе "${order.status}"` });
  }
  db.prepare(`UPDATE orders SET status = 'paid', paid_at = ? WHERE order_number = ?`).run(Date.now(), orderNumber);
  res.json({ ok: true, orderNumber, status: 'paid' });
});

// ---- "call a waiter" requests ----
app.get('/api/staff/calls', (req, res) => {
  const rows = db.prepare(`SELECT * FROM waiter_calls WHERE resolved_at IS NULL ORDER BY created_at ASC`).all();
  res.json({ calls: rows.map(c => ({ id: c.id, table: c.table_number, createdAt: c.created_at })) });
});

app.post('/api/staff/calls/:id/resolve', (req, res) => {
  const { id } = req.params;
  const call = db.prepare(`SELECT * FROM waiter_calls WHERE id = ?`).get(id);
  if (!call) return res.status(404).json({ error: 'Вызов не найден' });
  db.prepare(`UPDATE waiter_calls SET resolved_at = ? WHERE id = ?`).run(Date.now(), id);
  res.json({ ok: true });
});

// ---- upload a dish photo (from gallery/camera) — returns a URL to use as imageUrl ----
app.post('/api/staff/upload', (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить фото' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(201).json({ ok: true, url });
  });
});

// ---- staff menu management: price, availability, new dishes — doesn't need owner rights ----
app.get('/api/staff/menu', (req, res) => {
  const rows = db.prepare(`SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name`).all();
  res.json({
    items: rows.map(r => ({
      id: r.id, name: r.name, description: r.description, weight: r.weight,
      kcal: r.kcal, price: r.price, category: r.category, inStock: !!r.in_stock,
      imageUrl: r.image_url || null,
    })),
  });
});

app.post('/api/staff/menu/:id/stock', (req, res) => {
  const { id } = req.params;
  const { inStock } = req.body || {};
  const existing = db.prepare(`SELECT * FROM menu_items WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Блюдо не найдено' });
  db.prepare(`UPDATE menu_items SET in_stock = ? WHERE id = ?`).run(inStock ? 1 : 0, id);
  res.json({ ok: true, id, inStock: !!inStock });
});

// Официант/повар может поправить цену, состав, вес, калорийность и наличие —
// то, что реально меняется на смене. Удаление блюда и «блюдо дня» остаются
// только у владельца (см. /api/owner/menu), чтобы не терялась историчность меню.
app.put('/api/staff/menu/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, weight, kcal, price, category, inStock, imageUrl } = req.body || {};
  const existing = db.prepare(`SELECT * FROM menu_items WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Блюдо не найдено' });
  if (price !== undefined && (isNaN(Number(price)) || Number(price) < 0)) {
    return res.status(400).json({ error: 'Цена должна быть неотрицательным числом' });
  }
  db.prepare(`
    UPDATE menu_items SET
      name = COALESCE(?, name), description = COALESCE(?, description), weight = COALESCE(?, weight),
      kcal = COALESCE(?, kcal), price = COALESCE(?, price), category = COALESCE(?, category),
      in_stock = COALESCE(?, in_stock), image_url = COALESCE(?, image_url)
    WHERE id = ?
  `).run(
    name ?? null, description ?? null, weight ?? null, kcal ?? null,
    price === undefined ? null : Number(price), category ?? null,
    inStock === undefined ? null : (inStock ? 1 : 0),
    imageUrl === undefined ? null : (imageUrl || ''), id
  );
  res.json({ ok: true });
});

function slugify(name) {
  const translit = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  const base = name.toLowerCase().split('').map(ch => translit[ch] ?? ch).join('');
  const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dish';
  let candidate = slug, n = 1;
  while (db.prepare(`SELECT 1 FROM menu_items WHERE id = ?`).get(candidate)) {
    candidate = `${slug}-${++n}`;
  }
  return candidate;
}

app.post('/api/staff/menu', (req, res) => {
  const { name, description, weight, kcal, price, category, imageUrl } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно название блюда' });
  if (price === undefined || isNaN(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'Цена должна быть неотрицательным числом' });
  }
  const id = slugify(name);
  db.prepare(`
    INSERT INTO menu_items (id, name, description, weight, kcal, price, category, is_dish_of_day, active, in_stock, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)
  `).run(id, name, description || '', weight || '', Number(kcal) || 0, Number(price), category || 'salads', imageUrl || null);
  res.status(201).json({ ok: true, id });
});

// ================= OWNER-ONLY: everything below requires x-api-key =================
app.use('/api/owner', requireOwner);

app.get('/api/owner/orders', (req, res) => {
  const rows = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`).all();
  res.json({ orders: rows.map(formatOrder) });
});

app.get('/api/owner/summary', (req, res) => {
  const paid = db.prepare(`SELECT * FROM orders WHERE paid_at IS NOT NULL`).all();
  const count = paid.length;
  const revenue = paid.reduce((s, o) => s + o.subtotal, 0);
  const commission = paid.reduce((s, o) => s + o.commission_amount, 0);
  const avgCheck = count ? Math.round(revenue / count) : 0;
  const cashRevenue = paid.filter(o => o.payment_method === 'cash').reduce((s, o) => s + o.subtotal, 0);
  const sbpRevenue = paid.filter(o => o.payment_method === 'sbp').reduce((s, o) => s + o.subtotal, 0);
  res.json({
    count, revenue, commission, avgCheck, cashRevenue, sbpRevenue,
    commissionRate: parseFloat(getSetting('commission_rate', '0.04')),
  });
});

app.post('/api/owner/settings/commission-rate', (req, res) => {
  const { rate } = req.body || {};
  const n = Number(rate);
  if (isNaN(n) || n < 0 || n > 1) {
    return res.status(400).json({ error: 'rate должен быть числом от 0 до 1 (например 0.04 для 4%)' });
  }
  setSetting('commission_rate', n);
  res.json({ ok: true, commissionRate: n });
});

app.get('/api/owner/menu', (req, res) => {
  const rows = db.prepare(`SELECT * FROM menu_items ORDER BY category, name`).all();
  res.json({ items: rows });
});

app.put('/api/owner/menu/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, weight, kcal, price, category, active, isDishOfDay, inStock, imageUrl } = req.body || {};
  const existing = db.prepare(`SELECT * FROM menu_items WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Блюдо не найдено' });

  if (isDishOfDay) {
    db.prepare(`UPDATE menu_items SET is_dish_of_day = 0`).run();
  }

  db.prepare(`
    UPDATE menu_items SET
      name = COALESCE(?, name), description = COALESCE(?, description), weight = COALESCE(?, weight),
      kcal = COALESCE(?, kcal), price = COALESCE(?, price), category = COALESCE(?, category),
      active = COALESCE(?, active), is_dish_of_day = COALESCE(?, is_dish_of_day),
      in_stock = COALESCE(?, in_stock), image_url = COALESCE(?, image_url)
    WHERE id = ?
  `).run(
    name ?? null, description ?? null, weight ?? null, kcal ?? null, price ?? null,
    category ?? null, active === undefined ? null : (active ? 1 : 0),
    isDishOfDay === undefined ? null : (isDishOfDay ? 1 : 0),
    inStock === undefined ? null : (inStock ? 1 : 0),
    imageUrl === undefined ? null : (imageUrl || ''), id
  );

  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rahat backend listening on port ${PORT}`));

module.exports = app;
