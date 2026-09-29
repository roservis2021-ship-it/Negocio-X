import { api, euros, fecha, esc, coverStyle } from './common.js';
import { orderSummary } from './order.js';

const root = document.getElementById('checkout');
const orderId = new URLSearchParams(location.search).get('order') || '';
const orderPath = `/api/orders/${encodeURIComponent(orderId)}`;
const successUrl = `/exito?order=${encodeURIComponent(orderId)}`;

try {
  const order = await api(orderPath);
  if (order.status === 'paid') location.replace(successUrl);
  else if (order.status === 'expired' || new Date(order.expiresAt) <= new Date()) renderExpired(order);
  else await render(order);
} catch (err) {
  root.innerHTML = `<p class="empty">${esc(err.message)}. <a href="/">Ver eventos</a></p>`;
}

function renderExpired(order) {
  root.innerHTML = `
    <div class="panel expired">
      <h1 class="panel-title">Tu reserva ha caducado</h1>
      <p class="muted">Las entradas se han liberado para otros compradores. No se te ha cobrado nada.</p>
      <a class="btn primary wide" href="/evento?id=${encodeURIComponent(order.event.id)}">Volver a elegir entradas</a>
    </div>`;
}

async function render(order) {
  root.replaceChildren(document.getElementById('checkout-template').content.cloneNode(true));
  root.querySelector('[data-cover]').setAttribute('style', coverStyle(order.event.colors, order.event.image));
  root.querySelectorAll('[data-title]').forEach((el) => { el.textContent = order.event.title; });
  root.querySelector('[data-date]').textContent = fecha(order.event.date);
  root.querySelector('[data-venue]').textContent = `${order.event.venue} · ${order.event.city}`;
  root.querySelector('[data-lines]').innerHTML = orderSummary(order);
  root.querySelector('[data-pay-label]').textContent = `Pagar ${euros(order.total)} hoy`;
  root.querySelector('[data-monthly-label]').textContent = `Primer cobro de ${euros(order.monthlyTotal)} dentro de un mes; después, cada mes hasta cancelar.`;
  root.querySelector('[data-monthly-consent]').textContent = euros(order.monthlyTotal);
  root.querySelector('[data-cancel]').href = `/evento?id=${encodeURIComponent(order.event.id)}`;

  const form = document.getElementById('payment-form');
  const emailInput = document.getElementById('email');
  const termsInput = document.getElementById('accept-terms');
  const payButton = document.getElementById('pay-button');
  const errorBox = document.getElementById('payment-error');
  if (order.email) emailInput.value = order.email;

  let paying = false;
  startCountdown(order, () => { if (!paying) renderExpired(order); });

  payButton.disabled = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const email = emailInput.value.trim();
    if (!email || !emailInput.checkValidity()) {
      emailInput.focus();
      return showError('Escribe un email válido para recibir tus entradas.');
    }
    if (!termsInput.checked) {
      termsInput.focus();
      return showError('Debes aceptar las condiciones de compra para continuar.');
    }

    paying = true;
    setLoading(true);
    try {
      await api(`${orderPath}/details`, {
        method: 'POST',
        body: JSON.stringify({ email, acceptTerms: true }),
      });
      const { url } = await api(`${orderPath}/checkout-session`, { method: 'POST' });
      location.href = url;
    } catch (err) {
      paying = false;
      showError(err.message);
      setLoading(false);
    }
  });

  function setLoading(on) {
    payButton.disabled = on;
    payButton.classList.toggle('is-loading', on);
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }
}

function startCountdown(order, onExpire) {
  const label = root.querySelector('[data-countdown]');
  const box = root.querySelector('[data-reservation]');
  const end = new Date(order.expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    label.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    box.classList.toggle('is-urgent', left <= 120);
    if (left === 0) {
      clearInterval(timer);
      onExpire();
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
}
