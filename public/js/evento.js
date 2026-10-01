import { api, euros, fecha, esc, coverStyle } from './common.js';

const MAX_TICKETS = 10;
const root = document.getElementById('event');
const buybar = document.getElementById('buybar');
const buyButton = document.getElementById('buy-button');
const errorBox = document.getElementById('error');

const id = new URLSearchParams(location.search).get('id');
const qty = {}; // ticketId -> cantidad
let event;

try {
  event = await api(`/api/events/${encodeURIComponent(id || '')}`);
  document.title = `${event.title} · Tiketek`;
  render();
  buybar.hidden = !event.saleEnabled;
} catch (err) {
  root.innerHTML = `<p class="empty">${esc(err.message)}. <a href="/">Ver eventos</a></p>`;
}

function render() {
  root.innerHTML = `
    <div class="event-cover" style="${coverStyle(event.colors, event.image)}"><span class="cover-title">${esc(event.title)}</span></div>
    <p class="date">${esc(fecha(event.date))}</p>
    <h1 class="event-title">${esc(event.title)}</h1>
    <p class="muted">${esc(event.venue)} · ${esc(event.city)}</p>
    <p class="event-desc">${esc(event.description)}</p>
    ${event.saleEnabled ? '' : '<aside class="subscription-callout"><strong>Entradas próximamente</strong><p>La apertura de venta y las modalidades disponibles se anunciarán pronto.</p></aside>'}
    <h2 class="section-title">Entradas</h2>
    <ul class="tickets">${event.tickets.map(ticketRow).join('')}</ul>`;
}

function ticketRow(t) {
  const control = !event.saleEnabled
    ? '<span class="tag">Próximamente</span>'
    : t.soldOut
      ? '<span class="tag sold">Agotado</span>'
    : `<div class="stepper" data-ticket="${esc(t.id)}">
         <button type="button" data-step="-1" aria-label="Quitar una ${esc(t.name)}">−</button>
         <output>0</output>
         <button type="button" data-step="1" aria-label="Añadir una ${esc(t.name)}">+</button>
       </div>`;
  const left = t.left ? `<span class="tag low">¡Últimas ${t.left}!</span>` : '';
  return `
    <li class="ticket${t.soldOut ? ' is-sold' : ''}">
      <div>
        <strong>${esc(t.name)} ${left}</strong>
        <small>${esc(t.description || '')}</small>
        <span class="price">${euros(t.price)}</span>
      </div>
      ${control}
    </li>`;
}

root.addEventListener('click', (e) => {
  const button = e.target.closest('[data-step]');
  if (!button) return;
  const stepper = button.closest('.stepper');
  const ticketId = stepper.dataset.ticket;
  const step = Number(button.dataset.step);
  const current = qty[ticketId] || 0;
  const ticket = event.tickets.find((t) => t.id === ticketId);
  if (step > 0 && totalCount() >= MAX_TICKETS) return showError(`Máximo ${MAX_TICKETS} entradas por compra`);
  if (step > 0 && current >= ticket.max) return showError(`Solo quedan ${ticket.max} entradas "${ticket.name}"`);
  qty[ticketId] = Math.max(0, current + step);
  stepper.querySelector('output').textContent = qty[ticketId];
  updateBuybar();
});

const totalCount = () => Object.values(qty).reduce((a, b) => a + b, 0);

function updateBuybar() {
  const count = totalCount();
  const total = event.tickets.reduce((sum, t) => sum + (qty[t.id] || 0) * t.price, 0);
  document.getElementById('buy-count').textContent = `${count} ${count === 1 ? 'entrada' : 'entradas'}`;
  document.getElementById('buy-total').textContent = `Hoy ${euros(total)}`;
  document.getElementById('buy-entries').textContent = count ? `Entradas: ${euros(total)}` : '';
  document.getElementById('buy-monthly').textContent = count ? `Suscripción: ${euros(event.monthlyPrice)}/mes · primer cobro el próximo día 2` : '';
  buyButton.disabled = count === 0;
}

buyButton.addEventListener('click', async () => {
  buyButton.disabled = true;
  buyButton.textContent = 'Redirigiendo…';
  try {
    const items = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([ticketId, n]) => ({ ticketId, qty: n }));
    const { url } = await api('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ eventId: event.id, items }),
    });
    location.href = url;
  } catch (err) {
    showError(err.message);
    buyButton.disabled = false;
    buyButton.textContent = 'Comprar';
  }
});

let errorTimer;
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorBox.hidden = true; }, 3500);
}
