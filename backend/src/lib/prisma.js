/**
 * Prisma Client singleton.
 *
 * Importing this module always returns the same PrismaClient instance
 * so we don't exhaust the connection pool in development when nodemon
 * reloads the server.
 */

import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: env.isDev ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (env.isDev) globalForPrisma.__prisma = prisma;
