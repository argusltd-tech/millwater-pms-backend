// Creates one test operator per Millwater PMS role in a development database.
// Usage: npm run db:test-users
// Existing usernames are left unchanged. Passwords are random and printed once.
import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../server/auth.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create test users when NODE_ENV=production.');
  process.exit(1);
}

const USERS = [
  { username: 'admin', fullName: 'System Administrator', role: 'admin', department: 'IT & Systems' },
  { username: 'network_ops', fullName: 'Network Operations', role: 'network_ops', department: 'Network Operations' },
  { username: 'billing_specialist', fullName: 'Billing Specialist', role: 'billing_specialist', department: 'Revenue & Billing' },
  { username: 'finance_officer', fullName: 'Finance Officer', role: 'finance_officer', department: 'Treasury & Collections' },
  { username: 'customer_service', fullName: 'Customer Service', role: 'customer_service', department: 'Customer Relations' },
];

function randomPassword() {
  // 18 characters from an unambiguous alphabet.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(18), byte => alphabet[byte % alphabet.length]).join('');
}

const prisma = new PrismaClient();
const created = [];
const skipped = [];

try {
  for (const user of USERS) {
    const existing = await prisma.user.findUnique({ where: { username: user.username } });
    if (existing) {
      skipped.push(user.username);
      continue;
    }
    const password = randomPassword();
    const record = await prisma.user.create({
      data: {
        ...user,
        email: `${user.username}@millwater-pms.test`,
        passwordHash: await hashPassword(password),
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: null,
        action: 'CREATE',
        entity: 'users',
        entityId: record.id,
        details: `Created test operator ${record.username} (${record.role}) via scripts/create-test-users.mjs.`,
        ipAddress: 'local-script',
      },
    });
    created.push({ username: user.username, role: user.role, password });
  }

  if (created.length) {
    console.log('Created test operators (passwords are shown only once):');
    console.table(created);
  }
  if (skipped.length) console.log(`Already present, left unchanged: ${skipped.join(', ')}`);
} catch (error) {
  console.error('Could not create test users:', error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
