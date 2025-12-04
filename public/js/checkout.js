document.addEventListener('DOMContentLoaded', function(){
  const form = document.getElementById('checkout-form');
  if (!form) return;
  const pubKey = form.dataset.stripeKey || '';
  if (!pubKey) return;
  const stripeClient = Stripe(pubKey);
  // Debug: indicate client-side script executed
  try { const info = document.createElement('div'); info.style.color = 'green'; info.style.fontSize='12px'; info.textContent = 'JS loaded'; form.parentNode.insertBefore(info, form); } catch(e){}

  const submit = document.getElementById('checkout-submit');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    submit.disabled = true;
    submit.value = 'Przekierowanie...';
    const data = new URLSearchParams(new FormData(form));
    try {
      const resp = await fetch('/create-checkout-session', { method: 'POST', body: data });
      if (!resp.ok) { throw new Error('Checkout creation failed'); }
      const json = await resp.json();
      if (json.sessionId) {
        const { error } = await stripeClient.redirectToCheckout({ sessionId: json.sessionId });
        if (error) console.error('Stripe redirect error', error);
      } else if (json.url) {
        window.location = json.url;
      }
    } catch (err) { console.error('client stripe fail', err); window.location.href = form.action; }
    submit.disabled = false;
    submit.value = 'Przejdź do płatności';
  });
});
