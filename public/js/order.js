import { euros, esc } from './common.js';

export function orderSummary(order) {
  const rows = order.items.map((i) => `
    <li><span>${i.qty} × ${esc(i.name)}</span><span>${euros(i.unitPrice * i.qty)}</span></li>`).join('');
  return `
    <ul class="summary">${rows}
      <li><span>Suscripción mensual</span><span>${euros(order.monthlyTotal)}/mes</span></li>
      <li class="summary-note"><span>Beneficios</span><span>${esc(order.subscriptionBenefits || 'Consulta condiciones')}</span></li>
      <li class="summary-note"><span>Primer cobro</span><span>Próximo día 2 disponible; después, cada día 2</span></li>
      <li class="summary-total"><span>Total hoy</span><span>${euros(order.total)}</span></li>
    </ul>`;
}
