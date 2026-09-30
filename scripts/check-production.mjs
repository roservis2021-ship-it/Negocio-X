import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const failures = [];
const warnings = [];

function requireCheck(ok, message) {
  if (!ok) failures.push(message);
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const env = process.env;
const publicUrl = env.PUBLIC_URL || '';
const serviceAccount = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
const salesEnabled = env.SALES_ENABLED !== 'false';

requireCheck(env.NODE_ENV === 'production', 'NODE_ENV debe ser production.');
requireCheck(/^https:\/\//.test(publicUrl) && !/localhost|127\.0\.0\.1/i.test(publicUrl), 'PUBLIC_URL debe ser la URL HTTPS pública.');
requireCheck(/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || ''), 'STRIPE_SECRET_KEY debe ser una clave live.');
requireCheck((env.TICKET_SECRET || '').length >= 32, 'TICKET_SECRET debe tener al menos 32 caracteres aleatorios.');
requireCheck(Boolean(serviceAccount?.project_id && serviceAccount?.client_email && serviceAccount?.private_key), 'FIREBASE_SERVICE_ACCOUNT no es una cuenta de servicio válida.');
if (salesEnabled) {
  requireCheck(/^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || ''), 'STRIPE_WEBHOOK_SECRET debe contener el secreto del webhook de producción.');
  requireCheck(/^re_/.test(env.RESEND_API_KEY || ''), 'RESEND_API_KEY debe estar configurada.');
  requireCheck(/^[^<>\s]+@[^<>\s]+\.[^<>\s]+/.test(env.EMAIL_FROM || '') || /<[^<>\s]+@[^<>\s]+\.[^<>\s]+>/.test(env.EMAIL_FROM || ''), 'EMAIL_FROM debe contener una dirección válida del dominio verificado.');
} else {
  warnings.push('SALES_ENABLED=false: el sitio se validará con las ventas desactivadas.');
}

for (const name of ['condiciones.html', 'privacidad.html', 'aviso-legal.html']) {
  const contents = readFileSync(root(`public/legal/${name}`), 'utf8');
  requireCheck(!contents.includes('class="fill"'), `${name} todavía contiene datos legales pendientes.`);
}

const events = JSON.parse(readFileSync(root('data/events.json'), 'utf8'));
const ids = new Set();
for (const event of events) {
  requireCheck(Boolean(event.id) && !ids.has(event.id), `ID de evento ausente o duplicado: ${event.id || '(vacío)'}.`);
  ids.add(event.id);
  if (event.published === false) continue;
  requireCheck(Boolean(event.title && event.date && event.venue && event.city), `${event.id}: faltan título, fecha, recinto o ciudad.`);
  requireCheck(Number.isFinite(Date.parse(event.date)) && Date.parse(event.date) > Date.now(), `${event.id}: la fecha debe ser futura.`);
  requireCheck(Boolean(event.subscriptionBenefits) && !/personalizados|por anunciar|pendiente/i.test(event.subscriptionBenefits), `${event.id}: sustituye los beneficios genéricos de la suscripción.`);
  requireCheck(Number.isInteger(event.monthlyPrice) && event.monthlyPrice >= 50, `${event.id}: monthlyPrice debe ser un entero en céntimos.`);
  requireCheck(Boolean(event.image) && existsSync(root(`public${event.image}`)), `${event.id}: no existe la imagen ${event.image || '(sin ruta)'}.`);
  requireCheck(Array.isArray(event.tickets) && event.tickets.length > 0, `${event.id}: debe tener al menos un tipo de entrada.`);
  for (const ticket of event.tickets || []) {
    requireCheck(Number.isInteger(ticket.price) && ticket.price >= 50, `${event.id}/${ticket.id}: precio inválido.`);
    requireCheck(Number.isInteger(ticket.capacity) && ticket.capacity > 0, `${event.id}/${ticket.id}: aforo inválido.`);
  }
}

if (!existsSync(root('render.yaml'))) warnings.push('No existe render.yaml.');

console.log('Comprobación de producción de Tiketek');
for (const warning of warnings) console.log(`AVISO: ${warning}`);
for (const failure of failures) console.error(`FALTA: ${failure}`);

if (failures.length) {
  console.error(`\nResultado: NO LISTO (${failures.length} requisito${failures.length === 1 ? '' : 's'} pendiente${failures.length === 1 ? '' : 's'}).`);
  process.exit(1);
}

console.log('\nResultado: LISTO para desplegar.');
