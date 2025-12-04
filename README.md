# SnapThis — Clean starter

This is a minimal SnapThis (QR/guest page) app to serve as a clean starting point.

Features:
- Express + EJS frontend
- Supabase backend integration (for products, guestPages, uploads)
- Simple checkout flow: create guest page and upload images
- Admin login: view guest pages and uploads

Setup
1. Install:
   ```powershell
   npm install
   ```
2. Create `.env` and set at least:
   ```env
   SUPABASE_URL=https://your-supabase-url
   SUPABASE_SERVICE_ROLE_KEY=service-role-key
   SUPABASE_ANON_KEY=anon-key
   SESSION_SECRET=some-secret
   DEBUG_STARTUP=false
   DEBUG_KEY=some-secret
   DISABLE_SHARP=true
   ```
3. Run:
   ```powershell
   npm start
   # or
   npm run dev
   ```

Dev notes:
- The site currently uses Supabase for storage and DB. If you don't provide SUPABASE envs, the app uses a simple in-memory fallback database (ephemeral) so you can run locally.

Next steps:
- Migrate your product and guest data to Supabase.
- Add Supabase Storage and move `public/uploads` there.
