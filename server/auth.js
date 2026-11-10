import crypto from 'node:crypto';

const SESSION_COOKIE = 'millwater_pms_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api',
  };
}

function constantTimeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function readSessionToken(req) {
  const cookie = req.headers.cookie?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie?.slice(SESSION_COOKIE.length + 1) || null;
}

export function publicUser(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    department: user.department,
    lastLogin: user.lastLoginAt ? user.lastLoginAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Never',
    phone: user.phone || '',
    assignedFeeders: [],
    createdDate: user.createdAt.toISOString().slice(0, 10),
    mfaEnabled: false,
  };
}

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
    });
  });
}

export function verifyPassword(password, encodedHash) {
  const [algorithm, saltHex, hashHex] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex) ||
      !/^[a-f0-9]{128}$/i.test(hashHex)) return Promise.resolve(false);

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(crypto.timingSafeEqual(derivedKey, Buffer.from(hashHex, 'hex')));
    });
  });
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

export function createAuthHandlers(prisma) {
  async function authenticate(req, res, next) {
    const token = readSessionToken(req);
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    try {
      const session = await prisma.session.findUnique({
        where: { tokenHash: crypto.createHash('sha256').update(token).digest('hex') },
        include: { user: true },
      });
      if (!session || session.expiresAt <= new Date() || session.user.status !== 'active') {
        if (session) await prisma.session.delete({ where: { id: session.id } });
        res.clearCookie(SESSION_COOKIE, cookieOptions());
        return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
      }

      req.user = session.user;
      req.sessionId = session.id;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function startSession(user, req, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await prisma.$transaction(async tx => {
      await tx.session.create({
        data: {
          tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          userId: user.id,
          expiresAt,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'LOGIN',
          entity: 'users',
          entityId: user.id,
          details: 'Operator signed in.',
          ipAddress: req.ip || 'unknown',
        },
      });
    });
    res.cookie(SESSION_COOKIE, token, {
      ...cookieOptions(),
      maxAge: SESSION_DURATION_MS,
    });
  }

  return { authenticate, startSession };
}

export function safeBootstrapKey(candidate) {
  const expected = process.env.MILLWATER_BOOTSTRAP_KEY;
  return Boolean(expected && expected.length >= 32 && constantTimeEqual(candidate, expected));
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export async function writeAuditLog(prisma, req, { action, entity, entityId, details }) {
  await prisma.auditLog.create({
    data: {
      userId: req.user?.id || null,
      action,
      entity,
      entityId,
      details,
      ipAddress: req.ip || 'unknown',
    },
  });
}
