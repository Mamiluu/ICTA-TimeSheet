// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { attachUser } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { superadminRouter } from './routes/superadmin.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';

const app = express();

app.set('trust proxy', 1); // Render/other reverse proxies sit in front of us; needed for correct req.ip and secure cookies.
app.use(helmet());
app.use(cors({ origin: process.env.PUBLIC_APP_URL, credentials: true }));
app.use(express.json({ limit: '2mb' })); // signatures are base64 data URLs, larger than a typical JSON body
app.use(cookieParser());
app.use(attachUser);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/admin', adminRouter);
app.use('/api', publicRouter);

app.use((req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ICTA attendance server listening on :${port}`));
