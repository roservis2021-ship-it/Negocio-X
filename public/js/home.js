import { api, euros, fecha, esc, coverStyle } from './common.js';

const grid = document.getElementById('events');

try {
  const events = await api('/api/events');
  grid.innerHTML = events.length
    ? events.map(card).join('')
    : '<p class="empty">No hay eventos a la venta ahora mismo. ¡Vuelve pronto!</p>';
} catch (err) {
  grid.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
}

function card(e) {
  const price = !e.saleEnabled
    ? `<span class="from">Entrada <strong>${euros(e.fromPrice)}</strong> · Próximamente</span>`
    : e.soldOut
      ? '<span class="tag sold">Agotado</span>'
      : `<span class="from">Desde <strong>${euros(e.fromPrice)} hoy</strong></span>`;
  return `
    <a class="card${e.soldOut ? ' is-sold' : ''}" href="/evento?id=${encodeURIComponent(e.id)}">
      <div class="cover" style="${coverStyle(e.colors, e.image)}"><span class="cover-title">${esc(e.title)}</span></div>
      <div class="card-body">
        <p class="date">${esc(fecha(e.date))}</p>
        <h2>${esc(e.title)}</h2>
        <p class="muted">${esc(e.venue)} · ${esc(e.city)}</p>
        <div class="card-foot">${price}<span class="cta">COMPRAR AHORA →</span></div>
      </div>
    </a>`;
}
