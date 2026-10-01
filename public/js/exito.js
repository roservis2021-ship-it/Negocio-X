import { api, fecha, esc } from './common.js';
import { orderSummary } from './order.js';

const box = document.getElementById('result');
const params = new URLSearchParams(location.search);
const orderId = params.get('order') || '';

// La pasarela puede tardar unos segundos en confirmar; reintentamos antes de rendirnos.
async function check(attempt = 0) {
  // Stripe añade redirect_status al volver de una verificación del banco (3D Secure).
  if (params.get('redirect_status') === 'failed') {
    box.innerHTML = `
      <h1 class="panel-title">El pago no se ha completado</h1>
      <p class="muted">No se te ha cobrado nada. Puedes intentarlo de nuevo con otro método de pago.</p>
      <a class="btn primary wide" href="/pago?order=${encodeURIComponent(orderId)}">Reintentar pago</a>`;
    return;
  }
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    if (order.status === 'paid') return renderPaid(order);
    if (attempt < 5) return setTimeout(() => check(attempt + 1), 2000);
    box.innerHTML = `<p class="empty">Aún no hemos recibido la confirmación del pago. Si se te ha cobrado, recibirás tus entradas en breve.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}. <a href="/">Ver eventos</a></p>`;
  }
}

function renderPaid(order) {
  box.innerHTML = `
    <div class="success-icon">✓</div>
    <h1 class="panel-title">¡Entradas compradas!</h1>
    <p class="muted">${esc(order.event.title)} · ${esc(fecha(order.event.date))}<br />${esc(order.event.venue)} · ${esc(order.event.city)}</p>
    <p class="order-code">Pedido <strong>${esc(order.code)}</strong></p>
    <p class="sent-to">📩 Te hemos enviado las entradas con sus códigos QR a <strong>${esc(order.email)}</strong>. Revisa también la carpeta de spam.</p>
    ${orderSummary(order)}
    <p class="subscription-manage-note">Tu suscripción de ${esc(new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(order.monthlyTotal / 100))} al mes está programada: el primer cobro será el próximo día 2 disponible y después se renovará cada día 2. <a href="/suscripcion?order=${encodeURIComponent(order.id)}">Gestionar o cancelar suscripción</a>.</p>
    <a class="btn primary wide" href="/">Ver más eventos</a>`;
}

check();
