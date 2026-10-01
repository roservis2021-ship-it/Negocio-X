import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';

// Datos en Firestore (solo desde el servidor, con el Admin SDK):
//   orders/{orderId}         → pedido y estado del pago
//   stock/{eventId}          → { taken: { [ticketId]: n } } entradas ocupadas (pagadas + reservadas)
//   tickets/{ticketId}       → una entrada individual (la que lleva el QR)
// El aforo se controla con transacciones: comprobar y reservar ocurre de forma atómica
// aunque haya varios servidores o compras simultáneas.

export class SoldOutError extends Error {}

// Credenciales: FIREBASE_SERVICE_ACCOUNT (JSON o JSON en base64) o, si no,
// las credenciales por defecto de Google (GOOGLE_APPLICATION_CREDENTIALS).
function credential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return applicationDefault();
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return cert(JSON.parse(json));
}

const iso = (ts) => ts?.toDate().toISOString() ?? null;

export function openDb() {
  const app = initializeApp(
    process.env.FIRESTORE_EMULATOR_HOST
      ? { projectId: process.env.FIREBASE_PROJECT_ID || 'demo-tiketek' }
      : { credential: credential() },
  );
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });

  const orders = db.collection('orders');
  const stock = db.collection('stock');
  const tickets = db.collection('tickets');

  const toOrder = (snap) => {
    if (!snap.exists) return null;
    const d = snap.data();
    return {
      id: snap.id,
      eventId: d.eventId,
      eventTitle: d.eventTitle ?? '',
      items: d.items,
      total: d.total,
      ticketTotal: d.ticketTotal ?? d.total,
      monthlyTotal: d.monthlyTotal ?? 0,
      subscriptionBenefits: d.subscriptionBenefits ?? '',
      status: d.status,
      email: d.email ?? null,
      checkoutSessionId: d.checkoutSessionId ?? null,
      stripeSubscriptionId: d.stripeSubscriptionId ?? null,
      stripeCustomerId: d.stripeCustomerId ?? null,
      termsVersion: d.termsVersion ?? null,
      emailStatus: d.emailStatus ?? null,
      emailAttempts: d.emailAttempts ?? 0,
      emailAttemptStartedAt: iso(d.emailAttemptStartedAt),
      createdAt: iso(d.createdAt),
      expiresAt: iso(d.expiresAt),
      paidAt: iso(d.paidAt),
    };
  };

  const takenUpdate = (items, sign) => ({
    taken: Object.fromEntries(items.map((i) => [i.ticketId, FieldValue.increment(sign * i.qty)])),
  });

  return {
    close: () => db.terminate(),

    // Comprueba el aforo y crea el pedido en una sola transacción.
    // `capacityOf(ticketId)` devuelve el aforo configurado de cada entrada.
    async reserve(order, capacityOf) {
      const stockRef = stock.doc(order.eventId);
      await db.runTransaction(async (tx) => {
        const taken = (await tx.get(stockRef)).data()?.taken ?? {};
        for (const i of order.items) {
          const remaining = Math.max(0, capacityOf(i.ticketId) - (taken[i.ticketId] ?? 0));
          if (i.qty > remaining) {
            throw new SoldOutError(remaining === 0
              ? `Las entradas "${i.name}" se han agotado`
              : `Solo quedan ${remaining} entradas "${i.name}"`);
          }
        }
        tx.set(stockRef, takenUpdate(order.items, 1), { merge: true });
        tx.create(orders.doc(order.id), {
          eventId: order.eventId,
          eventTitle: order.eventTitle,
          items: order.items,
          total: order.total,
          ticketTotal: order.ticketTotal,
          monthlyTotal: order.monthlyTotal,
          subscriptionBenefits: order.subscriptionBenefits,
          status: 'pending',
          createdAt: Timestamp.fromDate(new Date(order.createdAt)),
          expiresAt: Timestamp.fromDate(new Date(order.expiresAt)),
        });
      });
    },

    async getOrder(id) {
      if (!id || id.includes('/')) return null;
      return toOrder(await orders.doc(id).get());
    },

    updateOrder: (id, fields) => orders.doc(id).update(fields),

    // Email del comprador y versión aceptada de las condiciones de compra.
    setDetails: (id, email) => orders.doc(id).update({ email, termsAcceptedAt: FieldValue.serverTimestamp(), termsVersion: '2026-09-subscription-v1' }),

    // Entradas ocupadas por evento: Map<eventId, Map<ticketId, n>>.
    async takenByEvent(eventIds) {
      if (!eventIds.length) return new Map();
      const snaps = await db.getAll(...eventIds.map((id) => stock.doc(id)));
      return new Map(snaps.map((s) => [s.id, new Map(Object.entries(s.data()?.taken ?? {}))]));
    },

    // Marca el pedido como pagado, emite sus entradas individuales y deja el email en cola.
    // Devuelve el estado anterior del pedido, o null si no existe o ya estaba pagado.
    markPaid(id, email = null, stripeSubscriptionId = null, stripeCustomerId = null) {
      const ref = orders.doc(id);
      return db.runTransaction(async (tx) => {
        const order = toOrder(await tx.get(ref));
        if (!order || order.status === 'paid') return null;
        // Si la reserva ya había caducado, sus plazas se liberaron: se vuelven a ocupar.
        if (order.status === 'expired') {
          tx.set(stock.doc(order.eventId), takenUpdate(order.items, 1), { merge: true });
        }
        // El email confirmado por Stripe es la fuente de verdad. Así evitamos
        // enviar las entradas a una dirección antigua escrita antes del pago.
        const holder = email ?? order.email;
        let n = 0;
        const count = order.items.reduce((s, i) => s + i.qty, 0);
        for (const item of order.items) {
          for (let k = 0; k < item.qty; k++) {
            tx.create(tickets.doc(randomUUID()), {
              orderId: id,
              eventId: order.eventId,
              ticketTypeId: item.ticketId,
              ticketName: item.name,
              number: ++n,
              of: count,
              email: holder,
              status: 'valid',
              createdAt: FieldValue.serverTimestamp(),
            });
          }
        }
        tx.update(ref, {
          status: 'paid',
          paidAt: FieldValue.serverTimestamp(),
          emailStatus: 'pending',
          ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
          ...(stripeCustomerId ? { stripeCustomerId } : {}),
          ...(holder ? { email: holder } : {}),
        });
        return order.status;
      });
    },

    async getTickets(orderId) {
      const snap = await tickets.where('orderId', '==', orderId).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.number - b.number);
    },

    // Caduca un pedido pendiente y devuelve sus plazas al aforo.
    markExpired(id) {
      const ref = orders.doc(id);
      return db.runTransaction(async (tx) => {
        const order = toOrder(await tx.get(ref));
        if (!order || order.status !== 'pending') return false;
        tx.set(stock.doc(order.eventId), takenUpdate(order.items, -1), { merge: true });
        tx.update(ref, { status: 'expired' });
        return true;
      });
    },

    // Pedidos pendientes cuya reserva ya venció. Solo filtra por estado para no
    // necesitar índices compuestos: los pendientes son siempre pocos.
    async staleOrders(now = new Date()) {
      const snap = await orders.where('status', '==', 'pending').get();
      return snap.docs.map(toOrder).filter((o) => new Date(o.expiresAt) <= now);
    },

    async ordersPendingEmail() {
      const snap = await orders.where('emailStatus', 'in', ['pending', 'sending']).get();
      return snap.docs.map(toOrder);
    },

    // Reserva el envío de forma atómica. Puede haber dos procesos (webhook,
    // sincronización o tarea periódica) intentando enviar el mismo pedido.
    // Solo uno obtiene la reserva; una reserva abandonada se recupera a los
    // diez minutos para no dejar el correo bloqueado tras un reinicio.
    claimEmail(id, staleBefore = new Date(Date.now() - 10 * 60_000)) {
      const ref = orders.doc(id);
      return db.runTransaction(async (tx) => {
        const order = toOrder(await tx.get(ref));
        if (!order || !order.email) return null;
        const retryStaleSending = order.emailStatus === 'sending'
          && order.emailAttemptStartedAt
          && new Date(order.emailAttemptStartedAt) <= staleBefore;
        if (order.emailStatus !== 'pending' && !retryStaleSending) return null;
        tx.update(ref, {
          emailStatus: 'sending',
          emailAttemptStartedAt: FieldValue.serverTimestamp(),
        });
        return order;
      });
    },

    markEmail(id, sent) {
      return orders.doc(id).update(sent
        ? {
            emailStatus: 'sent',
            emailSentAt: FieldValue.serverTimestamp(),
            emailAttemptStartedAt: FieldValue.delete(),
          }
        : {
            emailStatus: 'pending',
            emailAttempts: FieldValue.increment(1),
            emailAttemptStartedAt: FieldValue.delete(),
          });
    },
  };
}
