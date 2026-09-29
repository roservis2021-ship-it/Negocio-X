import { api } from './common.js';

const form = document.getElementById('manage-form');
const params = new URLSearchParams(location.search);
const orderInput = document.getElementById('order-id');
const emailInput = document.getElementById('customer-email');
const button = document.getElementById('manage-button');
const error = document.getElementById('manage-error');
orderInput.value = params.get('order') || '';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Conectando…';
  try {
    const { url } = await api(`/api/orders/${encodeURIComponent(orderInput.value.trim())}/customer-portal`, {
      method: 'POST',
      body: JSON.stringify({ email: emailInput.value.trim() }),
    });
    location.assign(url);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = 'Continuar a Stripe';
  }
});
