import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app = express();
const events = JSON.parse(readFileSync(new URL('./data/events.json', import.meta.url), 'utf8'));
const orders = new Map();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url)), { extensions: ['html'] }));
app.get('/api/events', (_req, res) => res.json(events.filter((e) => e.published !== false).map(view)));
app.get('/api/events/:id', (req, res) => {
  const event = events.find((e) => e.id === req.params.id && e.published !== false);
  return event ? res.json(view(event, true)) : res.status(404).json({ error: 'Evento no encontrado' });
});
app.post('/api/checkout', (req, res) => {
  const event = events.find((e) => e.id === req.body.eventId);
  if (!event || !event.saleEnabled) return res.status(409).json({ error: 'La venta aún no está disponible' });
  const items = (req.body.items || []).map(({ ticketId, qty }) => {
    const ticket = event.tickets.find((entry) => entry.id === ticketId);
    return ticket && Number.isInteger(qty) && qty > 0 && qty <= ticket.capacity
      ? { ticketId, name: ticket.name, qty, unitPrice: ticket.price } : null;
  }).filter(Boolean);
  if (!items.length) return res.status(400).json({ error: 'Selección de entradas no válida' });
  const ticketTotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const id = `demo-${Date.now()}`;
  orders.set(id, { id, status: 'pending', email: null, expiresAt: new Date(Date.now() + 35 * 60_000).toISOString(), event: view(event), items, ticketTotal, total: ticketTotal, monthlyTotal: event.monthlyPrice, subscriptionBenefits: event.subscriptionBenefits });
  res.json({ url: `/pago?order=${id}` });
});
app.get('/api/orders/:id', (req, res) => orders.has(req.params.id) ? res.json(orders.get(req.params.id)) : res.status(404).json({ error: 'Pedido de demostración no encontrado' }));
function view(event, details = false) {
  const tickets = event.tickets.map((ticket) => ({ ...ticket, soldOut: false, max: event.saleEnabled ? Math.min(ticket.capacity, 10) : 0 }));
  return { id: event.id, title: event.title, monthlyPrice: event.monthlyPrice, subscriptionBenefits: event.subscriptionBenefits, saleEnabled: event.saleEnabled, date: event.date, venue: event.venue, city: event.city, colors: event.colors, image: event.image, fromPrice: Math.min(...event.tickets.map((ticket) => ticket.price)), soldOut: false, ...(details ? { description: event.description, tickets } : {}) };
}
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Tiketek mobile preview: port ${port}`));
