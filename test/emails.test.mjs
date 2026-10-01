import assert from 'node:assert/strict';
import test from 'node:test';

import { ticketsEmail } from '../emails.js';

const base = {
  order: {
    id: '99500d7e-6e85-4d47-987f-4f1544aaae36',
    email: 'cliente@example.com',
    total: 99,
    monthlyTotal: 99,
    items: [{ qty: 1, name: 'Entrada VIP', unitPrice: 99 }],
  },
  event: {
    title: 'Evento de prueba',
    date: '2026-10-02T20:00:00.000Z',
    venue: 'Recinto',
    city: 'Las Palmas',
  },
  tickets: [{ id: 'ticket-1', number: 1, of: 1, ticketName: 'Entrada VIP' }],
  secret: 'test-secret',
  publicUrl: 'https://tiketek.es',
};

test('the ticket email explains the separate recurring subscription', async () => {
  const email = await ticketsEmail(base);

  assert.equal(email.to, 'cliente@example.com');
  assert.match(email.html, /suscripción mensual/);
  assert.match(email.html, /renueva automáticamente/);
  assert.doesNotMatch(email.html, /No hay cuotas posteriores/);
  assert.equal(email.attachments.length, 1);
});

test('the ticket email keeps one-time wording without a subscription', async () => {
  const email = await ticketsEmail({
    ...base,
    order: { ...base.order, monthlyTotal: 0 },
  });

  assert.match(email.html, /No hay cuotas posteriores ni renovación automática/);
});
