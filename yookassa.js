// Обёртка над API ЮKassa. Всё, что знает про конкретного провайдера платежей,
// живёт здесь — если завтра решите сменить агрегатора, менять нужно только этот
// файл, остальной сервер обращается только к функциям ниже.
const crypto = require('crypto');

// Позволяет подменить адрес API в тестах (см. test/yookassa.test.js) —
// в проде всегда используется настоящий адрес ЮKassa.
const API_BASE = process.env.YOOKASSA_API_BASE || 'https://api.yookassa.ru/v3';

function isConfigured() {
  return !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

function authHeader() {
  const token = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
  return `Basic ${token}`;
}

// Создаёт платёж СБП. amountRub — целое число рублей (как и везде в нашей базе).
// returnUrl — куда ЮKassa вернёт гостя после оплаты (страница меню с номером заказа).
async function createSbpPayment({ amountRub, description, orderNumber, returnUrl }) {
  const res = await fetch(`${API_BASE}/payments`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      // Idempotence-Key защищает от повторного списания, если запрос отправится
      // дважды из-за сетевого сбоя — ЮKassa вернёт тот же платёж, а не создаст новый.
      'Idempotence-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: { value: amountRub.toFixed(2), currency: 'RUB' },
      payment_method_data: { type: 'sbp' },
      confirmation: { type: 'redirect', return_url: returnUrl },
      capture: true,
      description,
      metadata: { order_number: orderNumber },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.description || data?.message || `YooKassa error ${res.status}`;
    throw new Error(msg);
  }
  return { paymentId: data.id, confirmationUrl: data.confirmation?.confirmation_url, status: data.status };
}

//change
// Перепроверяет статус платежа НАПРЯМУЮ у ЮKassa. Вебхуку самому по себе доверять
// нельзя — тело запроса теоретически можно подделать, поэтому при получении
// уведомления мы всегда переспрашиваем реальный статус через этот метод, и только
// после этого помечаем заказ оплаченным.
async function getPayment(paymentId) {
  const res = await fetch(`${API_BASE}/payments/${paymentId}`, {
    headers: { 'Authorization': authHeader() },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.description || data?.message || `YooKassa error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

module.exports = { isConfigured, createSbpPayment, getPayment };
