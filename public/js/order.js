import { euros, esc } from './common.js';

export function orderSummary(order) {
  const rows = order.items.map((i) => `
    <li><span>${i.qty} × ${esc(i.name)}</span><span>${euros(i.unitPrice * i.qty)}</span></li>`).join('');
  return `
    <ul class="summary">${rows}
      <li class="summary-total"><span>Total hoy</span><span>${euros(order.total)}</span></li>
    </ul>`;
}
