import assert from 'node:assert/strict';
import test from 'node:test';

import { createBilling } from '../billing.js';

test('creates a monthly subscription with a Stripe product after ticket payment', async () => {
  const calls = {};
  const paidAt = Date.UTC(2026, 9, 1, 15, 15, 0) / 1000;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          status: 'complete',
          payment_status: 'paid',
          customer: 'cus_test',
          payment_intent: 'pi_test',
          created: paidAt,
          customer_details: { email: 'cliente@example.com' },
        }),
      },
    },
    subscriptions: {
      list: async () => ({ data: [] }),
      create: async (payload, options) => {
        calls.subscription = { payload, options };
        return { id: 'sub_test' };
      },
    },
    paymentIntents: {
      retrieve: async () => ({ payment_method: 'pm_test' }),
    },
    products: {
      create: async (payload, options) => {
        calls.product = { payload, options };
        return { id: 'prod_subscription' };
      },
      update: async (productId, payload) => {
        calls.productUpdate = { productId, payload };
        return { id: productId, ...payload };
      },
    },
  };

  const billing = createBilling(stripe);
  const result = await billing.checkPaid({
    id: 'order-1',
    eventId: 'event-1',
    eventTitle: 'Fiesta de prueba',
    monthlyTotal: 99,
    checkoutSessionId: 'cs_test',
  });

  assert.deepEqual(result, {
    paid: true,
    email: 'cliente@example.com',
    subscriptionId: 'sub_test',
    customerId: 'cus_test',
  });
  assert.deepEqual(calls.product, {
    payload: {
      name: 'Fiesta de prueba · suscripción mensual',
      metadata: { eventId: 'event-1' },
    },
    options: { idempotencyKey: 'subscription-product-event-1' },
  });
  assert.deepEqual(calls.productUpdate, {
    productId: 'prod_subscription',
    payload: { statement_descriptor: 'XXTS444WAB' },
  });
  assert.equal(calls.subscription.payload.items[0].price_data.product, 'prod_subscription');
  assert.equal(calls.subscription.payload.items[0].price_data.unit_amount, 99);
  assert.deepEqual(calls.subscription.payload.items[0].price_data.recurring, { interval: 'month' });
  assert.equal('product_data' in calls.subscription.payload.items[0].price_data, false);
  assert.equal(
    calls.subscription.payload.trial_end,
    Date.UTC(2026, 9, 2, 15, 15, 0) / 1000,
  );
  assert.deepEqual(calls.subscription.options, {
    idempotencyKey: 'subscription-order-v2-order-1',
  });
});

test('uses the following month when payment happens on billing day', async () => {
  let subscriptionPayload;
  const paidAt = Date.UTC(2026, 9, 2, 10, 0, 0) / 1000;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          status: 'complete',
          payment_status: 'paid',
          customer: 'cus_test',
          payment_intent: 'pi_test',
          created: paidAt,
        }),
      },
    },
    subscriptions: {
      list: async () => ({ data: [] }),
      create: async (payload) => {
        subscriptionPayload = payload;
        return { id: 'sub_test' };
      },
    },
    paymentIntents: {
      retrieve: async () => ({ payment_method: 'pm_test' }),
    },
    products: {
      create: async () => ({ id: 'prod_subscription' }),
      update: async () => ({ id: 'prod_subscription', statement_descriptor: 'XXTS444WAB' }),
    },
  };

  const billing = createBilling(stripe);
  await billing.checkPaid({
    id: 'order-2',
    eventId: 'event-1',
    monthlyTotal: 99,
    checkoutSessionId: 'cs_test',
  });

  assert.equal(
    subscriptionPayload.trial_end,
    Date.UTC(2026, 10, 2, 10, 0, 0) / 1000,
  );
});
