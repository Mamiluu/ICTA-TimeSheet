// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { attachUser } from './middleware/auth.js';
import { attachHostOrg } from './lib/tenantHost.js';
import { authRouter } from './routes/auth.js';
import { superadminRouter } from './routes/superadmin.js';
import { platformRouter } from './routes/platform.js';
import { dutyReviewRouter } from './routes/dutyReview.js';
import { ownerRouter } from './routes/owner.js';
import { signupRouter } from './routes/signup.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { startAnchorJob } from './lib/anchor.js';
import { startReminderJob } from './lib/dutyReminders.js';
import { bootstrapPlatformAdmin, bootstrapOwner } from './lib/bootstrapPlatformAdmin.js';
import { logger, requestLogger, logRequestError, newErrorRef } from './lib/logger.js';

// The static frontend (index.html, admin.html, assets/, etc.) lives at the
// repo root, one level above this server/ directory, so a single Node
// service can serve both the API and the pages from one origin.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const app = express();

app.set('trust proxy', 1); // Render/other reverse proxies sit in front of us; needed for correct req.ip and secure cookies.

// The frontend is deliberately plain HTML/vanilla JS with no build step
// (every page has its own inline <script>/<style> -- see the plan's
// rationale for staying framework-free at this scale), so Helmet's default
// CSP -- which blocks all inline script/style -- has to be relaxed for
// script-src/style-src specifically. img-src additionally allows data:
// URLs for signature images and the QR code images admin.html embeds --
// those are now rendered by this server itself (GET
// /api/admin/events/:id/qr, via the local `qrcode` package) rather than a
// third-party image service, so no external host needs allowing here.
//
// No map/geocoding provider is wired in right now (event location is a
// plain typed address -- see admin.html's Address field and
// assets/map-config.js for notes on re-enabling a map picker later), so
// there's nothing extra to allow here beyond that.
app.use(helmet({
  // OpenStreetMap refuses map tiles that arrive with no referrer (a grey map and a 403 picture), so
  // other sites are told only the origin, never the page address or its query string.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      // The venue map on the event form draws its tiles from OpenStreetMap.
      'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
      // One test tile is fetched to see whether OpenStreetMap will serve this address.
      'connect-src': ["'self'", 'https://tile.openstreetmap.org']
    }
  }
}));
app.use(cors({ origin: process.env.PUBLIC_APP_URL, credentials: true }));
app.use(express.json({ limit: '2mb' })); // signatures are base64 data URLs, larger than a typical JSON body
app.use(cookieParser());
app.use(requestLogger);
app.use(attachHostOrg);
app.use(attachUser);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/owner', ownerRouter);
app.use('/api/signup', signupRouter);
app.use('/api/platform', platformRouter);
app.use('/api/duty-review', dutyReviewRouter);
app.use('/api/admin', adminRouter);
app.use('/api', publicRouter);

// The front page. Without this the bare address answered NOT_FOUND, which is
// what anyone opening the link without a page name saw first.
app.get('/', (req, res) => res.sendFile(path.join(REPO_ROOT, 'home.html')));
// The attendee sign in page, reached through every event's link and QR code.
app.get('/attend', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
// REPO_ROOT also contains this server/ directory (with .env and source) --
// block it explicitly before the static handler below, which would
// otherwise happily serve anything else under REPO_ROOT by path.
app.use('/server', (req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));
// Pages are reached by name, /login and not /login.html. The old file addresses still work (they are
// in emails and printed QR codes) and send the reader to the clean one, keeping the rest of the
// address. The attendee sign in page, index.html, is /attend.
const CLEAN_PAGES = new Set([
  'login', 'signup', 'admin', 'superadmin', 'platform', 'owner', 'owner-org', 'verify', 'wallet', 'privacy',
  'activate', 'forgot-password', 'reset-password', 'certificate', 'sign', 'duty-roll', 'duty-review', 'duty-sign', 'claim-pack'
]);
app.get(/^\/([a-z0-9-]+)\.html$/, (req, res, next) => {
  const name = req.params[0];
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  if (name === 'home') return res.redirect(302, '/' + query);
  if (name === 'index') return res.redirect(302, '/attend' + query);
  if (CLEAN_PAGES.has(name)) return res.redirect(302, '/' + name + query);
  return next();
});
app.use(express.static(REPO_ROOT, { dotfiles: 'ignore', index: false, extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));

// Express identifies error-handling middleware by arity (exactly 4 params);
// `next` must stay in the signature even though this handler never calls it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const errorRef = newErrorRef();
  logRequestError(err, req, errorRef);
  // The ref is safe to hand back to the caller -- it's an opaque lookup key
  // into the server's own logs, not a description of what went wrong -- so
  // an attendee or admin hitting a genuine bug has something concrete to
  // quote when they report it, without any internal detail leaving the
  // response body itself.
  res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', errorRef });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info('server listening', { port });
  startAnchorJob();
  startReminderJob();
  bootstrapOwner().catch((err) => logger.error('owner bootstrap failed', { stack: err.stack }));
  bootstrapPlatformAdmin().catch((err) => logger.error('platform admin bootstrap failed', { stack: err.stack }));
});
