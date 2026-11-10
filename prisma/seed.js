// Loads demonstration data into the database in DATABASE_URL:
// sample network, tariffs and customers, plus billing history (cycles, readings,
// invoices, payments) when no billing data exists yet. Safe to run more than once.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedDemo } from '../server/demoSeed.js';

const prisma = new PrismaClient();
try {
  await seedDemo(prisma);
} catch (error) {
  console.error('Demo seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
