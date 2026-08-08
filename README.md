# ABUAD SRC Portal

**Real student representation, with actual accountability.**

A campus feedback and governance platform for Afe Babalola University (ABUAD) Student Representative Council. Students submit issues, upvote common problems, track resolution progress, and vote on SRC decisions — all in one installable PWA.

---

## 🚀 What Changed (v2.0)

The entire security model was rewritten. Version 1.x had:
- Plaintext passwords
- No authentication (every API route was public)
- "Admin mode" was a React `useState` — anyone could fake it in DevTools
- Base64 images saved inline in MongoDB

Version 2.0 fixes all of that:
- **Supabase Auth** — password hashing, JWTs, email verification, reset flows handled for you
- **Real role enforcement** — middleware verifies the token and role on every protected route
- **Signup domain policy** — dev: any email; launch: toggle to `@abuad.edu.ng` only (no redeploy)
- **Prisma + Postgres** — relational data model ready for analytics, upvoting, and polls
- **Supabase Storage** — images stay small and cheap
- **PWA** — installable, works offline, sends push notifications

Also shipped: comment threads, ticket timeline, upvoting, anonymous mode, SLA tracking, satisfaction ratings, SRC announcements, polls, saved filters, admin analytics, and a keep-alive ping to stop free-tier pausing.

---

## ⚡ Quick Start

### Prerequisites
- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier is fine)

### 1. Clone & Install
```bash
git clone https://github.com/israelidem/abuad-src-portal.git
cd abuad-src-portal
cd backend && npm install
cd ../frontend && npm install
```

### 2. Backend Setup
```bash
cd backend
cp .env.example .env
# Fill in your Supabase credentials (see .env.example for where to find them)
```

**Run the migration:**
```bash
npm run migrate:dev
```

**Then paste `prisma/sql/01_post_migration.sql` into the Supabase SQL Editor and run it.** This adds:
- Ticket number sequence
- Email-domain enforcement trigger
- Profile auto-creation trigger
- Denormalised counter sync
- Row Level Security policies
- Department seed data

### 3. Frontend Setup
```bash
cd frontend
cp .env.example .env
# Add your Supabase URL and anon key (public, safe for the browser)
```

### 4. Run It
```bash
# Terminal 1 — backend
cd backend && npm run dev

# Terminal 2 — frontend
cd frontend && npm run dev
```

Open http://localhost:5173. Signup works immediately (dev mode auto-confirms email). The first user needs their role set manually in Supabase Studio → `profiles` table → change `role` to `ADMIN`.

---

## 📂 Project Structure

```
backend/
  prisma/
    schema.prisma          # Full DB schema (all 13 features)
    sql/01_post_migration.sql  # Triggers, RLS, seed data
  src/
    config/                # Environment validation
    lib/                   # Prisma & Supabase clients
    middleware/            # Auth, validation, rate limiting, errors
    routes/                # API endpoints
    services/              # Domain policy, notifications, uploads
    validators/            # Zod schemas
  server.js                # Express app

frontend/
  src/
    App.jsx                # Main UI (to be split in Phase 3)
    AdminDashboard.jsx     # (deprecated — merged into App.jsx)
  public/
  index.html
```

---

## 🔒 Security

**Auth:** Supabase handles credentials. Your Express API verifies JWTs via `requireAuth` middleware and enforces roles.

**Domain policy:** In development, any email works. At launch, flip `restrictSignupDomains` to `true` in the admin settings UI → only `@abuad.edu.ng` addresses can sign up. A Postgres trigger enforces this at the DB level, so direct API calls with the anon key can't bypass it.

**Roles:** `STUDENT` (default), `REP` (SRC officer), `ADMIN` (full control). Set via Supabase Studio → `profiles` table. Never accepted from the client.

**Rate limiting:** Signup/reset: 10 per 15 min. Ticket creation: 15 per hour. Comments/votes: 60 per 5 min.

**RLS:** Enabled on every table. The API uses the service_role key (bypasses RLS), but policies protect direct client access and future Realtime subscriptions.

---

## 🎯 Roadmap

- **Phase 1 (done):** Auth & security hardening
- **Phase 2:** Ticket routes, comment threads, voting, attachments
- **Phase 3:** React Router, split `App.jsx`, PWA manifest, service worker
- **Phase 4:** All 13 features:
  - **4a (done):** Comments/timeline, in-app notifications (header bell),
    Web Push
  - **4b (partial):** Anonymous mode ✅, assignment + SLA due dates ✅,
    satisfaction rating / reopen — **not built** (the `TicketRating` model
    exists, no routes or UI)
  - **4c (partial):** Public board ✅, upvoting ✅, public tracking by
    ticket number for non-signed-in users — **not built**
  - **4d (partial):** Free-text search ✅ (description, location, ticket
    number), admin analytics beyond the current counts — **not built**
  - **4e:** Map picker, announcements/polls — **not built** (models and RLS
    policies exist; no routes, no UI)
  - **4f:** Realtime, dark mode, admin user management — **not built**
    (roles are set in Supabase Studio for now)

---

## 🚢 Deployment

**Frontend:** Vercel (auto-deploy from `main`)
**Backend:** Render free tier or Fly.io. The keep-alive GitHub Action lives at `.github/workflows/keepalive.yml` — repository root, because that is the only path GitHub reads workflows from. Point it elsewhere and it silently never runs.
**Database:** Stays on Supabase

Before launch:
1. Flip `restrictSignupDomains` to `true` in the admin UI
2. Configure custom SMTP in Supabase (Settings → Auth → SMTP) — the built-in sender is rate-limited
3. Set up real backups (Supabase free doesn't include them)

**VPS migration guide** is in the planning docs if you outgrow free tiers or need always-on.

---

## 📧 Support

Issues: https://github.com/israelidem/abuad-src-portal/issues

---

Built with Supabase, Prisma, Express, React, and Tailwind. License: MIT.
