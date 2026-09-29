// Cobra las entradas ahora y programa la primera cuota mensual para un mes
// después del pago, usando el método guardado con autorización para futuros cargos.
export function createBilling(stripe) {
  async function checkoutFor(order, event, publicUrl) {
    if (order.checkoutSessionId) {
      const existing = await stripe.checkout.sessions.retrieve(order.checkoutSessionId);
      if (existing.status === 'open') return { url: existing.url };
      throw new Error('La sesión de pago ya no está disponible. Vuelve a elegir tus entradas.');
    }

    const lineItems = order.items.map((item) => ({
      quantity: item.qty,
      price_data: {
        currency: 'eur',
        unit_amount: item.unitPrice,
        product_data: { name: `${event.title} · ${item.name} (entrada)` },
      },
    }));

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_creation: 'always',
      customer_email: order.email,
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: { orderId: order.id, eventId: event.id },
      },
      client_reference_id: order.id,
      metadata: { orderId: order.id, eventId: event.id },
      success_url: `${publicUrl}/exito?order=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/pago?order=${encodeURIComponent(order.id)}`,
      expires_at: Math.floor(new Date(order.expiresAt).getTime() / 1000),
    }, { idempotencyKey: `ticket-order-${order.id}` });
    return { checkoutSessionId: session.id, url: session.url };
  }

  async function subscriptionAfterPayment(session, order) {
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customerId) throw new Error('Stripe no devolvió el cliente del pago.');
    if (order.stripeSubscriptionId) return { subscriptionId: order.stripeSubscriptionId, customerId };
    // Recupera una suscripción creada si el proceso se reinició antes de guardar el pedido.
    const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const existingForOrder = existing.data.find((subscription) => subscription.metadata?.orderId === order.id);
    if (existingForOrder) return { subscriptionId: existingForOrder.id, customerId };
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!intentId) throw new Error('Stripe no devolvió el pago de las entradas.');
    const intent = await stripe.paymentIntents.retrieve(intentId);
    const paymentMethodId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
    if (!paymentMethodId) throw new Error('No se pudo guardar el método de pago para la suscripción.');

    const paidAt = new Date((session.created || Math.floor(Date.now() / 1000)) * 1000);
    const firstChargeAt = addCalendarMonth(paidAt);
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price_data: {
        currency: 'eur',
        unit_amount: order.monthlyTotal,
        recurring: { interval: 'month' },
        product_data: { name: `${order.eventTitle || 'Tiketek'} · suscripción mensual` },
      } }],
      default_payment_method: paymentMethodId,
      trial_end: Math.floor(firstChargeAt.getTime() / 1000),
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { orderId: order.id, eventId: order.eventId },
      description: `${order.eventTitle || 'Tiketek'} · suscripción de entradas`,
    }, { idempotencyKey: `subscription-order-${order.id}` });
    return { subscriptionId: subscription.id, customerId };
  }

  async function checkPaid(order) {
    if (!order.checkoutSessionId) return { paid: false };
    const session = await stripe.checkout.sessions.retrieve(order.checkoutSessionId);
    const paid = session.status === 'complete' && session.payment_status === 'paid';
    if (!paid) return { paid: false, processing: session.status === 'complete' && session.payment_status === 'unpaid' };
    const { subscriptionId, customerId } = await subscriptionAfterPayment(session, order);
    return {
      paid: true,
      email: session.customer_details?.email || session.customer_email,
      subscriptionId,
      customerId,
    };
  }

  async function portalFor(order, publicUrl) {
    if (!order.stripeCustomerId) throw new Error('No encontramos una suscripción activa para este pedido.');
    const session = await stripe.billingPortal.sessions.create({
      customer: order.stripeCustomerId,
      return_url: `${publicUrl}/suscripcion?order=${encodeURIComponent(order.id)}`,
    });
    return session.url;
  }

  async function expirePending(order) {
    if (!order.checkoutSessionId) return;
    const session = await stripe.checkout.sessions.retrieve(order.checkoutSessionId);
    if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
  }

  return { checkoutFor, checkPaid, expirePending, portalFor };
}

function addCalendarMonth(date) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
