import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, SoldOutError } from './db.js';
import { createBilling } from './billing.js';
import { createMailer } from './mailer.js';
import { ticketsEmail } from './emails.js';

// ---------- Configuración ----------

const env = process.env;
const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TICKET_SECRET']
  .filter((k) => !env[k]);
if (missing.length) {
  console.error(`Faltan variables de entorno: ${missing.join(', ')}. Revisa .env.example`);
  process.exit(1);
}
if (!env.FIREBASE_SERVICE_ACCOUNT && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.FIRESTORE_EMULATOR_HOST) {
  console.error('Faltan las credenciales de Firebase: define FIREBASE_SERVICE_ACCOUNT. Revisa .env.example');
  process.exit(1);
}
const liveSecret = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);

const IS_PROD = env.NODE_ENV === 'production';
const SALES_ENABLED = env.SALES_ENABLED !== 'false';
const PORT = Number(env.PORT) || 3000;
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RESERVATION_MINUTES = Math.max(35, Number(env.RESERVATION_MINUTES) || 35);
const MAX_TICKETS_PER_ORDER = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const path = (p) => fileURLToPath(new URL(p, import.meta.url));

if (IS_PROD && SALES_ENABLED && !env.RESEND_API_KEY) {
  console.error('En producción hace falta RESEND_API_KEY para enviar las entradas por email.');
  process.exit(1);
}

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const db = openDb();
const billing = createBilling(stripe);
const mailer = createMailer({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM || 'Tiketek <entradas@tiketek.es>',
  outboxDir: path('./outbox'),
});
const events = loadEvents();

// Valida el catálogo al arrancar: mejor fallar aquí que vender una entrada mal configurada.
function loadEvents() {
  const list = JSON.parse(readFileSync(path('./data/events.json'), 'utf8'));
  const ids = new Set();
  for (const e of list) {
    if (!e.id || ids.has(e.id) || !Number.isInteger(e.monthlyPrice) || e.monthlyPrice < 50
      || (e.saleEnabled && (!Number.isFinite(Date.parse(e.date)) || !e.venue || !e.city))) {
      throw new Error(`Evento no válido: ${e.id} (revisa precio, fecha y ubicación)`);
    }
    if (IS_PROD && e.saleEnabled && (!e.date || !e.venue || !e.city || !e.subscriptionBenefits || e.subscriptionBenefits.toLowerCase().includes('por anunciar'))) {
      throw new Error(`No se puede vender en producción: completa fecha, ubicación, beneficios y activa la venta de ${e.id}.`);
    }
    ids.add(e.id);
    const ticketIds = new Set();
    for (const t of e.tickets) {
      const ok = t.id && !ticketIds.has(t.id)
        && Number.isInteger(t.price) && t.price >= 50
        && (e.saleEnabled ? Number.isInteger(t.capacity) && t.capacity >= 0 : t.capacity === null || (Number.isInteger(t.capacity) && t.capacity >= 0));
      if (!ok) throw new Error(`Entrada no válida en ${e.id}: ${t.id} (precio en céntimos ≥ 50 y aforo entero)`);
      ticketIds.add(t.id);
    }
  }
  return list;
}

if (IS_PROD) {
  const unfinishedLegalPages = ['condiciones.html', 'privacidad.html', 'aviso-legal.html']
    .filter((name) => readFileSync(path(`./public/legal/${name}`), 'utf8').includes('class="fill"'));
  if (unfinishedLegalPages.length) {
    throw new Error(`No se puede iniciar en producción mientras haya datos legales por completar: ${unfinishedLegalPages.join(', ')}`);
  }
}

// Comprueba la conexión con Firestore antes de aceptar ventas.
try {
  await db.takenByEvent(events.map((e) => e.id));
} catch (err) {
  console.error('No se puede conectar con Firestore:', err.message);
  process.exit(1);
}

// ---------- Lógica de negocio ----------

const findEvent = (id) => events.find((e) => e.id === id);
const isOnSale = (e) => {
  const endOfEventDate = /^\d{4}-\d{2}-\d{2}$/.test(e.date)
    ? Date.parse(`${e.date}T23:59:59.999Z`)
    : Date.parse(e.date);
  return e.saleEnabled === true && Number.isFinite(endOfEventDate) && endOfEventDate > Date.now();
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Plazas ocupadas por evento. El listado público usa una caché de pocos segundos para
// ahorrar lecturas en Firestore; la compra siempre comprueba el aforo real en una transacción.
const STOCK_CACHE_MS = 5_000;
let stockCache = { at: 0, data: new Map() };
async function takenFor(eventIds) {
  if (Date.now() - stockCache.at > STOCK_CACHE_MS) {
    stockCache = { at: Date.now(), data: await db.takenByEvent(events.map((e) => e.id)) };
  }
  return new Map(eventIds.map((id) => [id, stockCache.data.get(id) ?? new Map()]));
}

function ticketsWithStock(e, taken) {
  return e.tickets.map((t) => {
    const remaining = t.capacity == null ? null : t.soldOut ? 0 : Math.max(0, t.capacity - (taken.get(t.id) || 0));
    return { ...t, remaining };
  });
}

function eventView(e, taken, withDetails = false) {
  const tickets = ticketsWithStock(e, taken).map(({ capacity, remaining, ...t }) => ({
    ...t,
    soldOut: remaining === 0,
    // Solo se muestra cuántas quedan cuando son pocas.
    left: remaining > 0 && remaining <= 10 ? remaining : undefined,
    max: Math.min(remaining, MAX_TICKETS_PER_ORDER),
  }));
  const available = tickets.filter((t) => !t.soldOut);
  const view = {
    id: e.id,
    title: e.title,
    monthlyPrice: e.monthlyPrice,
    subscriptionBenefits: e.subscriptionBenefits,
    saleEnabled: SALES_ENABLED && e.saleEnabled === true,
    date: e.date,
    venue: e.venue,
    city: e.city,
    colors: e.colors,
    image: e.image || null,
    fromPrice: available.length ? Math.min(...available.map((t) => t.price)) : null,
    soldOut: SALES_ENABLED && e.saleEnabled === true && available.length === 0,
  };
  return withDetails ? { ...view, description: e.description, tickets } : view;
}

function publicOrder(order) {
  const e = findEvent(order.eventId);
  return {
    id: order.id,
    code: order.id.slice(0, 8).toUpperCase(),
    status: order.status,
    email: order.email,
    eventTitle: e.title,
    expiresAt: order.expiresAt,
    event: { id: e.id, title: e.title, date: e.date, venue: e.venue, city: e.city, colors: e.colors, image: e.image || null },
    items: order.items,
    total: order.total,
    ticketTotal: order.ticketTotal,
    monthlyTotal: order.monthlyTotal,
    subscriptionBenefits: order.subscriptionBenefits,
  };
}

async function markPaid(orderId, email, subscriptionId, customerId) {
  const previous = await db.markPaid(orderId, email ?? null, subscriptionId ?? null, customerId ?? null);
  if (!previous) return;
  if (previous === 'expired') {
    // Pagó justo al caducar la reserva: el pago es válido, pero revisa el aforo.
    console.warn(`Pedido ${orderId} pagado tras caducar su reserva. Revisa el aforo.`);
  }
  console.log(`Pedido pagado ${orderId}`);
  sendOrderEmail(orderId).catch((err) => console.error(`Email del pedido ${orderId} pendiente:`, err.message));
}

// Envía las entradas por email. Si falla, el pedido queda
// con emailStatus "pending" y el proceso periódico lo reintenta.
async function sendOrderEmail(orderId) {
  const order = await db.claimEmail(orderId);
  if (!order) return;
  try {
    const tickets = await db.getTickets(orderId);
    await mailer.send(await ticketsEmail({
      order,
      event: findEvent(order.eventId),
      tickets,
      secret: env.TICKET_SECRET,
      publicUrl: PUBLIC_URL,
    }));
    await db.markEmail(orderId, true);
  } catch (err) {
    await db.markEmail(orderId, false);
    throw err;
  }
}

// Sincroniza el pedido con Stripe por si el webhook todavía no ha llegado.
async function syncWithStripe(order) {
  if (order.status !== 'pending') return order;
  const { paid, email, subscriptionId, customerId } = await billing.checkPaid(order);
  if (!paid) return order;
  await markPaid(order.id, email, subscriptionId, customerId);
  return db.getOrder(order.id);
}

// Libera las reservas caducadas (cancelando sus cobros sin completar) y reintenta emails.
async function housekeeping() {
  for (const order of await db.staleOrders()) {
    try {
      const { paid, processing, email, subscriptionId, customerId } = await billing.checkPaid(order);
      if (paid) { await markPaid(order.id, email, subscriptionId, customerId); continue; }
      if (processing) continue; // lo resolverá el webhook
      await billing.expirePending(order);
      await db.markExpired(order.id);
    } catch (err) {
      console.error(`No se pudo liberar el pedido ${order.id}:`, err.message);
    }
  }
  for (const order of await db.ordersPendingEmail()) {
    if (order.emailAttempts >= 5) continue;
    await sendOrderEmail(order.id).catch((err) => console.error(`Reintento de email ${order.id}:`, err.message));
  }
}

// ---------- Servidor ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás del proxy HTTPS del hosting

app.get('/healthz', (req, res) => res.send('ok'));

if (IS_PROD) {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com', 'https://*.js.stripe.com'],
      frameSrc: ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://maps.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'https://*.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
}));

// Webhook de Stripe: fuente de verdad de los pagos. Va antes de express.json()
// porque la firma se verifica sobre el cuerpo sin procesar.
// Si falla al guardar, responde con error y Stripe reintenta el aviso más tarde.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Firma no válida: ${err.message}`);
  }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    if (session.metadata?.orderId && session.payment_status === 'paid') {
      const order = await db.getOrder(session.metadata.orderId);
      if (order) await syncWithStripe(order);
    }
  }
  if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) {
    const session = event.data.object;
    if (session.metadata?.orderId) await db.markExpired(session.metadata.orderId);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
const strictLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' },
});

// Tipografías servidas desde nuestro dominio (sin enviar la IP del visitante a Google).
// Stripe también las carga desde sus iframes, por eso se permite el acceso cruzado.
const fontHeaders = {
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  },
  maxAge: '30d',
};
app.use('/fonts/inter', express.static(path('./node_modules/@fontsource-variable/inter'), fontHeaders));
app.use('/fonts/syne', express.static(path('./node_modules/@fontsource-variable/syne'), fontHeaders));
app.use(express.static(path('./public'), { extensions: ['html'] }));

app.get('/api/events', async (req, res) => {
  const upcoming = events.filter((e) => e.published !== false && (!e.saleEnabled || isOnSale(e)))
    .sort((a, b) => (Date.parse(a.date) || Number.MAX_SAFE_INTEGER) - (Date.parse(b.date) || Number.MAX_SAFE_INTEGER));
  const taken = await takenFor(upcoming.map((e) => e.id));
  res.json(upcoming.map((e) => eventView(e, taken.get(e.id))));
});

app.get('/api/events/:id', async (req, res) => {
  const e = findEvent(req.params.id);
  if (!e || e.published === false) return res.status(404).json({ error: 'Evento no encontrado' });
  if (e.saleEnabled && !isOnSale(e)) return res.status(410).json({ error: 'Este evento ya no está a la venta' });
  const taken = await takenFor([e.id]);
  res.json(eventView(e, taken.get(e.id), true));
});

// Crea el pedido y reserva las entradas durante RESERVATION_MINUTES.
app.post('/api/checkout', strictLimit, async (req, res) => {
  if (!SALES_ENABLED) return res.status(503).json({ error: 'Las ventas todavía no están activas.' });
  const e = findEvent(req.body?.eventId);
  if (!e) return res.status(404).json({ error: 'Evento no encontrado' });
  if (!isOnSale(e)) return res.status(410).json({ error: 'Este evento ya no está a la venta' });

  // Los precios siempre salen del servidor; del cliente solo se acepta tipo y cantidad.
  // El aforo se comprueba después, dentro de la transacción de db.reserve().
  const requested = Array.isArray(req.body.items) ? req.body.items : [];
  const seen = new Set();
  const items = [];
  for (const { ticketId, qty } of requested) {
    const ticket = e.tickets.find((t) => t.id === ticketId);
    if (!ticket || seen.has(ticketId) || !Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ error: 'Selección de entradas no válida' });
    }
    if (ticket.soldOut) return res.status(409).json({ error: `Las entradas "${ticket.name}" se han agotado` });
    seen.add(ticketId);
    items.push({ ticketId, name: ticket.name, unitPrice: ticket.price, qty });
  }

  const totalQty = items.reduce((n, i) => n + i.qty, 0);
  if (totalQty === 0) return res.status(400).json({ error: 'Elige al menos una entrada' });
  if (totalQty > MAX_TICKETS_PER_ORDER) {
    return res.status(400).json({ error: `Máximo ${MAX_TICKETS_PER_ORDER} entradas por compra` });
  }

  const now = new Date();
  const ticketTotal = items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
  const monthlyTotal = e.monthlyPrice;
  const order = {
    id: randomUUID(),
    eventId: e.id,
    eventTitle: e.title,
    items,
    ticketTotal,
    monthlyTotal,
    total: ticketTotal,
    subscriptionBenefits: e.subscriptionBenefits,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESERVATION_MINUTES * 60_000).toISOString(),
  };
  try {
    await db.reserve(order, (ticketId) => e.tickets.find((t) => t.id === ticketId).capacity);
  } catch (err) {
    if (err instanceof SoldOutError) return res.status(409).json({ error: err.message });
    throw err;
  }
  res.json({ url: `/pago?order=${order.id}` });
});

async function payableOrder(req) {
  const order = await db.getOrder(req.params.id);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  if (order.status === 'paid') throw new HttpError(409, 'Este pedido ya está pagado');
  if (order.status === 'expired' || new Date(order.expiresAt) <= new Date()) {
    throw new HttpError(410, 'Tu reserva ha caducado. Vuelve a elegir tus entradas.');
  }
  return order;
}

app.get('/api/orders/:id', async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(publicOrder(await syncWithStripe(order)));
});

// Crea una sesión Stripe para cobrar las entradas y guardar el método de pago
// que se usará para completar el pago único autorizado por el cliente.
app.post('/api/orders/:id/checkout-session', strictLimit, async (req, res) => {
  if (!SALES_ENABLED) return res.status(503).json({ error: 'Las ventas todavía no están activas.' });
  const order = await payableOrder(req);
  if (!order.email || !order.termsVersion) throw new HttpError(400, 'Confirma tu email y acepta las condiciones antes de pagar');
  const checkout = await billing.checkoutFor(order, findEvent(order.eventId), PUBLIC_URL);
  if (checkout.checkoutSessionId) await db.updateOrder(order.id, { checkoutSessionId: checkout.checkoutSessionId });
  res.json({ url: checkout.url });
});

// Portal de Stripe para gestionar el método de pago o cancelar la renovación.
app.post('/api/orders/:id/customer-portal', strictLimit, async (req, res) => {
  const order = await db.getOrder(req.params.id);
  if (!order || order.status !== 'paid') throw new HttpError(404, 'Pedido no encontrado');
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email !== String(order.email || '').toLowerCase()) throw new HttpError(403, 'El email no coincide con el de la compra');
  res.json({ url: await billing.portalFor(order, PUBLIC_URL) });
});

// Guarda email y aceptación de condiciones justo antes de pagar.
app.post('/api/orders/:id/details', async (req, res) => {
  const order = await payableOrder(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(400, 'Email no válido');
  if (req.body?.acceptTerms !== true) throw new HttpError(400, 'Debes aceptar las condiciones de compra');
  await db.setDetails(order.id, email);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Algo ha fallado. Inténtalo de nuevo.' });
});

const server = app.listen(PORT, () => {
  console.log(`Tiketek en el puerto ${PORT} · Stripe ${liveSecret ? 'PRODUCCIÓN (cobros reales)' : 'modo test'}`
    + ` · emails: ${mailer.mode === 'resend' ? 'Resend' : 'carpeta outbox/ (no se envían)'}`);
});

// Evita solapar pasadas si Firestore o Stripe van lentos.
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await housekeeping();
  } catch (err) {
    console.error('Error en tareas periódicas:', err.message);
  } finally {
    busy = false;
  }
}, 60_000);

function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
