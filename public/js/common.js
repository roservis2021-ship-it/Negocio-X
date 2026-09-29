export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de conexión');
  return data;
}

const euroFormat = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const euros = (cents) => euroFormat.format(cents / 100);

const dateFormat = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const calendarDateFormat = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
export const fecha = (iso) => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'Fecha por anunciar';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return calendarDateFormat.format(new Date(`${iso}T12:00:00Z`));
  return dateFormat.format(new Date(iso));
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const HEX = /^#[0-9a-f]{3,8}$/i;
export function coverStyle(colors = [], image = null) {
  const [a, b] = colors.filter((c) => HEX.test(c));
  if (typeof image === 'string' && /^\/images\/[\w./-]+$/.test(image)) {
    return `background-image: linear-gradient(0deg, rgba(11,11,16,.28), rgba(11,11,16,0)), url(${image}); background-size: cover; background-position: center`;
  }
  return `background: linear-gradient(135deg, ${a || '#7a2cff'}, ${b || '#ff2e88'})`;
}
