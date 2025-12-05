require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const shortid = require('shortid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { supabaseServer } = require('./lib/supabase');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// prepare to parse webhook payloads as raw body for stripe signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return bodyParser.urlencoded({ extended: true })(req, res, next);
});
// Configure Content Security Policy to allow Stripe and Supabase resources
const SUPABASE_URL_RAW = process.env.SUPABASE_URL || 'https://snxzxesrbkfpheegbpms.supabase.co';
const SUPABASE_URL_CSP = SUPABASE_URL_RAW.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com'],
      scriptSrcElem: ["'self'", 'https://js.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://checkout.stripe.com', `https://${SUPABASE_URL_CSP}`],
      frameSrc: ["'self'", 'https://js.stripe.com', 'https://checkout.stripe.com'],
      formAction: ["'self'", 'https://checkout.stripe.com'],
      imgSrc: ["'self'", 'data:', `https://${SUPABASE_URL_CSP}`],
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  }
}));

// Stripe: create checkout session from product
// Stripe checkout route - moved to after fallbackStore declaration

// Use cookie-session for serverless-compatible sessions
// Use cookie-session for serverless-compatible sessions
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'snapthis-secret'],
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  httpOnly: true,
  secure: !!process.env.VERCEL,
  sameSite: 'lax'
}));

// middleware for contact email
app.use((req, res, next) => {
  res.locals.contactEmail = 'kontakt@snapthis.pl';
  next();
});

// upload setup: store files in /tmp for now; Supabase storage integration will be used by server if configured
const os = require('os');
const uploadBase = process.env.VERCEL ? path.join(os.tmpdir(), 'snapthis-uploads') : path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadBase, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadBase),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + shortid.generate() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Helper: fallback product store when no supabase
const fallbackStore = {
  products: [
    { id: 'standard', title: 'Standard QR', price: '99', description: 'QR only (download)' },
    { id: 'premium', title: 'Premium print', price: '199', description: 'Printed and more' },
    { id: 'exclusive', title: 'Exclusive with shipping', price: '249', description: 'Shipped to you' }
  ],
  guestPages: [],
  guestUploads: []
};

// Stripe: create checkout session from product
app.post('/checkout', async (req, res) => {
  try {
    const productId = req.body.productId || 'standard';
    // find product
    let product = fallbackStore.products.find(p => p.id === productId);
    if (supabaseServer) {
      const { data } = await supabaseServer.from('products').select('*').eq('id', productId).limit(1);
      if (data && data[0]) product = data[0];
    }
    if (!product) return res.status(404).send('Product not found');
    const siteUrl = process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://snapthis.vercel.app');
    const amount = Math.round(parseFloat(String(product.price || '0')) * 100);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'blik', 'p24', 'klarna'],

      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: product.title },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/product/${productId}`,
    });
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[stripe] create session failed', e);
    return res.status(500).send('Checkout error');
  }
});

// Create-checkout-session endpoint for client-side redirect (returns JSON)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const productId = req.body.productId || 'standard';
    const title = req.body.title || `${productId} Event`;
    const buyerEmail = req.body.buyerEmail || '';
    const buyername = req.body.buyername || null;
    const eventdate = req.body.eventdate || null;
    const background = req.body.background || null;
    const guestnames = req.body.guestnames || null;
    const quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : 0;
    const shipping_address = req.body.shipping_address ? { address: req.body.shipping_address } : null;
    const token = shortid.generate();
    const record = { id: token, productid: productId, title, buyeremail: buyerEmail, buyername, eventdate, background, guestnames, quantity, shipping_address, createdat: new Date().toISOString() };
    // create guestpage record before creating Stripe session
    if (supabaseServer) {
      try { const { data, error } = await supabaseServer.from('guestpages').insert([record]); if (error) throw error; } catch(e) { console.error('[supabase] failed to insert guestPage', e); }
    } else { fallbackStore.guestPages.push(record); }
    // find product
    let product = fallbackStore.products.find(p => p.id === productId);
    if (supabaseServer) {
      const { data } = await supabaseServer.from('products').select('*').eq('id', productId).limit(1);
      if (data && data[0]) product = data[0];
    }
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const siteUrl = process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://snapthis.vercel.app');
    const amount = Math.round(parseFloat(String(product.price || '0')) * 100);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'blik', 'p24', 'klarna'],
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: product.title },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      // include guest token in success redirect
      client_reference_id: token,
      metadata: { token },
      success_url: `${siteUrl}/success?token=${token}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/product/${productId}`,
    });
    return res.json({ sessionId: session.id, url: session.url });
  } catch (e) {
    console.error('[stripe] create session failed', e);
    return res.status(500).json({ error: 'Checkout error' });
  }
});

// Home
app.get('/', async (req, res) => {
  let products = fallbackStore.products;
  if (supabaseServer) {
    try {
      const { data, error } = await supabaseServer.from('products').select('*');
      if (!error && data) products = data;
    } catch(e) { console.error('[supabase] failed to fetch products', e); }
  }
  res.render('index', { products });
});

// Product page
app.get('/product/:id', async (req, res) => {
  const id = req.params.id;
  let product = fallbackStore.products.find(p => p.id === id);
  if (supabaseServer) {
    const { data, error } = await supabaseServer.from('products').select('*').eq('id', id).limit(1);
    if (!error && data && data[0]) product = data[0];
  }
  if (!product) return res.status(404).send('Not found');
  res.render('product', { product });
});

// Buy form
app.get('/buy/:id', async (req, res) => {
  const id = req.params.id;
  let product = fallbackStore.products.find(p => p.id === id);
  if (supabaseServer) {
    const { data } = await supabaseServer.from('products').select('*').eq('id', id).limit(1);
    if (data && data[0]) product = data[0];
  }
  if (!product) return res.status(404).send('Not found');
  res.render('buy', { product, error: null });
});

// Create guest page (simply create a record in supabase or fallback)
app.post('/buy/:id/create', async (req, res) => {
  const id = req.params.id;
  const title = req.body.title || `${id} Event`;
  const buyerEmail = req.body.buyerEmail || '';
  const buyername = req.body.buyername || null;
  const eventdate = req.body.eventdate || null;
  const background = req.body.background || null;
  const guestnames = req.body.guestnames || null;
  const quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : 0;
  const shipping_address = req.body.shipping_address ? { address: req.body.shipping_address } : null;
  const token = shortid.generate();
  // Use lowercase keys which match unquoted postgres column names
  const record = { id: token, productid: id, title, buyeremail: buyerEmail, buyername, eventdate, background, guestnames, quantity, shipping_address, createdat: new Date().toISOString() };
  if (supabaseServer) {
    try {
      const { data, error } = await supabaseServer.from('guestpages').insert([record]);
      if (error) throw error;
    } catch (e) { console.error('[supabase] failed to insert guestPage', e); fallbackStore.guestPages.push(record); }
  } else {
    fallbackStore.guestPages.push(record);
  }
  return res.redirect(`/guest/${token}`);
});

// Create guest and start payment flow (create guestpage then redirect to Stripe Checkout)
app.post('/buy/:id/create-pay', async (req, res) => {
  const id = req.params.id;
  const title = req.body.title || `${id} Event`;
  const buyerEmail = req.body.buyerEmail || '';
  const buyername = req.body.buyername || null;
  const eventdate = req.body.eventdate || null;
  const background = req.body.background || null;
  const guestnames = req.body.guestnames || null;
  const quantity = req.body.quantity ? parseInt(req.body.quantity, 10) : 0;
  const shipping_address = req.body.shipping_address ? { address: req.body.shipping_address } : null;
  const token = shortid.generate();
  const record = { id: token, productid: id, title, buyeremail: buyerEmail, buyername, eventdate, background, guestnames, quantity, shipping_address, createdat: new Date().toISOString() };
  if (supabaseServer) {
    try {
      const { data, error } = await supabaseServer.from('guestpages').insert([record]);
      if (error) throw error;
    } catch (e) { console.error('[supabase] failed to insert guestPage', e); }
  }
  // create stripe checkout for this product
  try {
    const productId = id;
    let product = fallbackStore.products.find(p => p.id === productId);
    if (supabaseServer) {
      const { data } = await supabaseServer.from('products').select('*').eq('id', productId).limit(1);
      if (data && data[0]) product = data[0];
    }
    if (!product) return res.status(404).send('Product not found');
    const siteUrl = process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://snapthis.vercel.app');
    const amount = Math.round(parseFloat(String(product.price || '0')) * 100);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'blik', 'p24', 'klarna'],
      client_reference_id: token,
      metadata: { token },
      line_items: [
        { price_data: { currency: 'pln', product_data: { name: product.title }, unit_amount: amount }, quantity: 1 }
      ],
      // On success, redirect to our success page with token, which will link to the guest page
      success_url: `${siteUrl}/success?token=${token}&session_id={CHECKOUT_SESSION_ID}&paid=1`,
      cancel_url: `${siteUrl}/guest/${token}?cancel=1`,
    });
    return res.redirect(303, session.url);
  } catch (e) { console.error('[stripe] create session failed', e); return res.status(500).send('Checkout error'); }
});

// Guest page
app.get('/guest/:token', async (req, res) => {
  const token = req.params.token;
  let page = (fallbackStore.guestPages || []).find(p => p.id === token);
  if (supabaseServer) {
    try {
      const { data, error } = await supabaseServer.from('guestpages').select('*').eq('id', token).limit(1);
      if (!error && data && data[0]) page = data[0];
    } catch (e) { console.error('[supabase] failed to get guest page', e); }
  }
  if (!page) return res.status(404).send('Not found');
  // guest uploads
  let uploads = [];
  if (supabaseServer) {
    try { const { data } = await supabaseServer.from('guestuploads').select('*').eq('token', token); if (data) uploads = data; } catch(e) { console.error('[supabase] failed to load uploads', e); }
  } else { uploads = (fallbackStore.guestUploads || []).filter(u => u.token === token); }

  // Make sure every upload has a public URL (support fallback to SUPABASE_URL or local uploads path)
  try {
    uploads = (uploads || []).map(u => {
      if (u.url) return u;
      const bucket = process.env.SUPABASE_BUCKET;
      if (process.env.SUPABASE_URL && bucket && u.filename) {
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/uploads/${u.filename}`;
        return Object.assign({}, u, { url: publicUrl });
      }
      // fallback: local path
      if (u.filename) return Object.assign({}, u, { url: `/uploads/${u.filename}` });
      return u;
    });
  } catch(e) { console.error('[server] failed to normalise upload urls', e); }
  // Detect if redirect from Stripe success
  const paid = req.query && (req.query.paid === '1' || !!req.query.session_id);
  res.render('guest', { page, uploads, paid });
});

// Upload handler
app.post('/guest/:token/upload', upload.single('photo'), async (req, res) => {
  const token = req.params.token;
  if (!req.file) return res.redirect(`/guest/${token}`);
  const filepath = req.file.path;
  const filename = req.file.filename;
  const record = { id: shortid.generate(), token, filename, originalname: req.file.originalname, createdat: new Date().toISOString() };
  // Upload to Supabase Storage if configured
  if (supabaseServer && process.env.SUPABASE_BUCKET) {
    try {
      const bucket = process.env.SUPABASE_BUCKET;
      const data = fs.readFileSync(filepath);
      const { error } = await supabaseServer.storage.from(bucket).upload(`uploads/${filename}`, data, { contentType: req.file.mimetype });
      if (error) throw error;
      // remove local tmp file
      try { fs.unlinkSync(filepath); } catch(e){}
      // record URL -- prefer SDK helper to build public URL
      try {
        const { data: urlData } = supabaseServer.storage.from(bucket).getPublicUrl(`uploads/${filename}`);
        record.url = urlData && urlData.publicUrl ? urlData.publicUrl : `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/uploads/${filename}`;
      } catch (err) {
        record.url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/uploads/${filename}`;
      }
    } catch (e) { console.error('[supabase] storage upload error', e); }
  }
  if (supabaseServer) {
    try { await supabaseServer.from('guestuploads').insert([record]); } catch(e){ console.error('[supabase] failed to insert upload record', e); }
  } else { fallbackStore.guestUploads.push(record); }
  return res.redirect(`/guest/${token}`);
});

// Stripe webhook handler - update DB on checkout completion
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // no webhook secret provided - parse payload (not recommended in prod)
      event = req.body;
    }
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = (session.metadata && session.metadata.token) || session.client_reference_id;
    if (token && supabaseServer) {
      try {
        // try to update guestpages paid flag
        const { error } = await supabaseServer.from('guestpages').update({ paid: true }).eq('id', token);
        if (error) console.error('[stripe-webhook] supabase update error', error);
      } catch (e) { console.error('[stripe-webhook] failed to update DB', e); }
    }
  }
  return res.json({ received: true });
});

// Admin routes - simple login
app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));
app.post('/admin/login', (req, res) => {
  const username = req.body.username;
  const password = req.body.password;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.isAdmin = true; return res.redirect('/admin');
  }
  return res.render('admin/login', { error: 'invalid' });
});
// Admin logout
app.get('/admin/logout', (req, res) => {
  // destroy session for cookie-session
  try { req.session = null; } catch(e) { req.session = {}; }
  return res.redirect('/admin/login');
});
app.get('/admin', async (req, res) => {
  if (!req.session || !req.session.isAdmin) return res.redirect('/admin/login');
  // fetch products & guest pages
  let products = fallbackStore.products;
  let guestPages = fallbackStore.guestPages;
  if (supabaseServer) {
    try {
      const { data: pages, error: pagesErr } = await supabaseServer.from('guestpages').select('*').order('createdat', { ascending: false });
      if (!pagesErr && pages) guestPages = pages;
      // fetch uploads to count per token
      const { data: uploads } = await supabaseServer.from('guestuploads').select('token');
      const counts = {};
      (uploads || []).forEach(u => { counts[u.token] = (counts[u.token] || 0) + 1; });
      guestPages = (guestPages || []).map(g => Object.assign({}, g, { uploadCount: counts[g.id] || 0 }));
    } catch (e) { console.error('[supabase] failed to fetch admin guestPages', e); }
  }
  res.render('admin/dashboard', { products, guestPages });
});

// Stripe success and cancel pages
app.get('/success', (req, res) => {
  // Render a success page which links to the guest page if token is present
  const token = req.query && req.query.token ? req.query.token : null;
  res.render('success', { token });
});
app.get('/cancel', (req, res) => {
  res.send('<html><body><h1>Payment cancelled</h1><p>Your payment was cancelled.</p><p><a href="/">Return home</a></p></body></html>');
});

// Health
app.get('/_health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => console.log(`SnapThis (clean) running on http://localhost:${PORT}`));

module.exports = app;
