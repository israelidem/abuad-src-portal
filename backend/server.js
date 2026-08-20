/**
 * ABUAD SRC Portal — API entry point.
 */

// env.js loads .env (relative to the backend folder) as a side effect of
// being imported, so it must come before anything that reads process.env.
import { env } from './src/config/env.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

import { prisma } from './src/lib/prisma.js';
import { logger } from './src/lib/logger.js';
import { requestContext } from './src/middleware/requestContext.js';
import { apiLimiter } from './src/middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './src/middleware/errorHandler.js';
import authRoutes from './src/routes/authRoutes.js';
import ticketRoutes from './src/routes/ticketRoutes.js';
import departmentRoutes from './src/routes/departmentRoutes.js';
import notificationRoutes from './src/routes/notificationRoutes.js';
import adminRoutes from './src/routes/adminRoutes.js';
import announcementRoutes from './src/routes/announcementRoutes.js';
import { maintenanceGuard } from './src/middleware/maintenance.js';

const app = express();

// Render/Vercel/Fly sit behind a proxy — required for correct client IPs,
// which rate limiting depends on.
app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());

// First in the chain: everything downstream — including CORS rejections and
// body-parser failures — should be attributable to a request id.
app.use(requestContext);

// CORS locked to an explicit allowlist (was previously wide open).
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / mobile webviews (no Origin header)
      if (!origin) return callback(null, true);
      if (env.cors.origins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// Payloads are small now that images go to Supabase Storage
// instead of being inlined as base64.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/** Health check — also the keep-alive target that stops Supabase/Render idling. */
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    // Health checks are excluded from the access log, so an unreachable
    // database would otherwise fail silently — the one case where this
    // endpoint most needs to leave a trace.
    req.log.error('health.db_unreachable', { err: error });
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

app.get('/', (_req, res) => {
  res.json({ name: 'ABUAD SRC Portal API', version: '2.0.0', status: 'running' });
});

app.use('/api', apiLimiter);

// Ahead of the routers so every mutating endpoint is covered without
// each one remembering the check. Reads and staff always pass through.
app.use('/api', maintenanceGuard);

app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.port, () => {
  logger.info('server.started', { port: env.port, env: env.nodeEnv });
});

const shutdown = async (signal) => {
  logger.info('server.shutdown', { signal });
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

// Without these, an unhandled rejection prints a bare stack to stderr with
// no context and, on newer Node, takes the process down — which on Render
// reads as an unexplained restart. Logging first makes it diagnosable.
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    err: reason instanceof Error ? reason : new Error(String(reason)),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', { err: error });
  // The process state is now unknown, so exit and let the platform restart
  // us rather than serving requests from a corrupted runtime.
  shutdown('uncaughtException');
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
