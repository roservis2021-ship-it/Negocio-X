import QRCode from 'qrcode';
import { createHmac } from 'node:crypto';

// Contenido de los emails. HTML con estilos en línea y tablas: es lo que mejor
// se ve en Gmail, Outlook y Apple Mail.

const euros = (cents) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const fecha = (iso) => new Intl.DateTimeFormat('es-ES', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
}).format(new Date(iso));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Contenido del QR: identificador de la entrada firmado, para validarla en la puerta
// sin que nadie pueda inventarse una entrada válida.
export function ticketQrPayload(ticketId, secret) {
  const sig = createHmac('sha256', secret).update(ticketId).digest('base64url').slice(0, 16);
  return `TKT1.${ticketId}.${sig}`;
}

function layout(title, content, publicUrl) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f2f2f5;font-family:Arial,Helvetica,sans-serif;color:#15151d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td style="background:#0b0b10;border-radius:16px 16px 0 0;padding:22px 28px;font-size:26px;font-weight:bold;color:#fff">tiketek<span style="color:#d4ff3a">.</span></td></tr>
  <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px">${content}</td></tr>
  <tr><td style="padding:18px 8px;text-align:center;font-size:12px;color:#8a8a99;line-height:1.6">
    <a href="${publicUrl}/legal/condiciones" style="color:#8a8a99">Condiciones de compra</a> ·
    <a href="${publicUrl}/legal/privacidad" style="color:#8a8a99">Privacidad</a><br>
    Has recibido este email porque has comprado entradas en Tiketek.
  </td></tr>
</table></td></tr></table></body></html>`;
}

// Email con las entradas (un QR por entrada) y el resumen del pago.
export async function ticketsEmail({ order, event, tickets, secret, publicUrl }) {
  const code = order.id.slice(0, 8).toUpperCase();
  const manageUrl = `${publicUrl}/suscripcion?order=${encodeURIComponent(order.id)}`;
  const attachments = [];
  const ticketBlocks = [];
  for (const t of tickets) {
    const cid = `qr-${t.number}`;
    const content = await QRCode.toBuffer(ticketQrPayload(t.id, secret), { width: 440, margin: 1, errorCorrectionLevel: 'M' });
    attachments.push({ filename: `entrada-${t.number}.png`, content, contentType: 'image/png', cid });
    ticketBlocks.push(`
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px dashed #d0d0da;border-radius:14px;margin:0 0 16px">
        <tr><td align="center" style="padding:20px">
          <div style="font-size:12px;color:#8a8a99;text-transform:uppercase;letter-spacing:1px">Entrada ${t.number} de ${t.of}</div>
          <div style="font-size:20px;font-weight:bold;margin:4px 0 12px">${esc(t.ticketName)}</div>
          <img src="cid:${cid}" width="220" height="220" alt="Código QR de la entrada ${t.number}" style="display:block;border:0">
          <div style="font-family:monospace;font-size:12px;color:#8a8a99;margin-top:10px">${esc(t.id.slice(0, 8).toUpperCase())}</div>
        </td></tr>
      </table>`);
  }

  const lines = order.items.map((i) => `
    <tr><td style="padding:6px 0">${i.qty} × ${esc(i.name)}</td><td align="right" style="padding:6px 0">${euros(i.unitPrice * i.qty)}</td></tr>`).join('');
  const content = `
    <h1 style="font-size:24px;margin:0 0 6px">¡Tus entradas están listas!</h1>
    <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.5">
      <b>${esc(event.title)}</b><br>${esc(fecha(event.date))}<br>${esc(event.venue)} · ${esc(event.city)}
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#555">Enseña el código QR de cada entrada en la puerta, desde el móvil o impreso. Cada código es único y solo vale una vez.</p>
    ${ticketBlocks.join('')}
    <h2 style="font-size:16px;margin:24px 0 8px">Resumen del pago · Pedido ${code}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #e6e6ee">
      ${lines}
      <tr><td style="padding:8px 0;border-top:1px solid #e6e6ee">Suscripción mensual (primer cobro el próximo día 2)</td>
          <td align="right" style="padding:8px 0;border-top:1px solid #e6e6ee">${euros(order.monthlyTotal)}/mes</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #e6e6ee;font-weight:bold">Total cobrado hoy</td>
          <td align="right" style="padding:10px 0;border-top:1px solid #e6e6ee;font-weight:bold">${euros(order.total)}</td></tr>
    </table>`;
  const subscriptionInfo = `<h2 style="font-size:16px;margin:24px 0 8px">Tu suscripción</h2>
    <p style="font-size:14px;line-height:1.6;color:#555">Hoy se ha cobrado solo el importe de las entradas. La primera cuota de <b>${euros(order.monthlyTotal)}</b> se cobrará el próximo día 2 disponible y después se renovará automáticamente cada día 2 hasta que la canceles. Si la compra se realiza el día 1, la primera cuota puede cobrarse al día siguiente. Beneficios: ${esc(order.subscriptionBenefits || 'los indicados en la página del evento')}. Puedes gestionar el método de pago o cancelar desde <a href="${manageUrl}" style="color:#5e52d7">este enlace seguro</a>; te pediremos confirmar el email de compra.</p>`;
  const html = layout('Tus entradas', `${content}${subscriptionInfo}`, publicUrl);

  const text = [
    `Tus entradas para ${event.title} (${fecha(event.date)}, ${event.venue} · ${event.city}).`,
    `Pedido ${code}. Total cobrado: ${euros(order.total)}.`,
    `Hoy se han cobrado solo las entradas. La suscripción de ${euros(order.monthlyTotal)}/mes se cobrará por primera vez el próximo día 2 disponible y se renovará cada día 2 hasta cancelar. Gestiona o cancela: ${manageUrl}`,
    'Los códigos QR de tus entradas están en la versión HTML de este email.',
  ].filter(Boolean).join('\n');

  return {
    to: order.email,
    subject: `Tus entradas para ${event.title} · Pedido ${code}`,
    html,
    text,
    attachments,
  };
}
