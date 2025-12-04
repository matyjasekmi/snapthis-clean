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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(helmet());

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
    { id: 'standard', title: 'Standard QR', price: '0.99', description: 'QR only (download)' },
    { id: 'premium', title: 'Premium print', price: '3.99', description: 'Printed and more' },
    { id: 'exclusive', title: 'Exclusive with shipping', price: '9.99', description: 'Shipped to you' }
  ],
  guestPages: [],
  guestUploads: []
};

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
  const token = shortid.generate();
  // Use lowercase keys which match unquoted postgres column names
  const record = { id: token, productid: id, title, buyeremail: buyerEmail, createdat: new Date().toISOString() };
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
  res.render('guest', { page, uploads });
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
app.get('/admin', (req, res) => {
  if (!req.session || !req.session.isAdmin) return res.redirect('/admin/login');
  // fetch products & guest pages
  let products = fallbackStore.products;
  let guestPages = fallbackStore.guestPages;
  if (supabaseServer) {
    // async fetch (no await to keep simple) but we'll just await
  }
  res.render('admin/dashboard', { products, guestPages });
});

// Health
app.get('/_health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => console.log(`SnapThis (clean) running on http://localhost:${PORT}`));

module.exports = app;
