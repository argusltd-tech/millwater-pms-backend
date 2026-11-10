import express from 'express';
import { amiConfigProblem, amiConnection, getSettings } from './settings.js';

// Read-only proxy to the AMI head-end. The browser never sees the AMI token.
const adminApi = '/api/oss-admin/api/v3';
const iotApi = '/api/oss-iot/api/v3';
const maxResponseBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 20_000;
export const AMI_ROLES = ['admin', 'network_ops'];

async function requestAmi(connection, pathname, { method = 'GET', query, body } = {}) {
  const configError = amiConfigProblem(connection);
  if (configError) {
    const error = new Error(configError);
    error.status = 503;
    error.expose = true;
    throw error;
  }

  const origin = new URL(connection.baseUrl).origin;
  const url = new URL(`${origin}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'auth-token': connection.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const failure = new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'AMI API request timed out.'
      : 'AMI API could not be reached.');
    failure.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    failure.expose = true;
    throw failure;
  }

  if (response.status >= 300 && response.status < 400) {
    const error = new Error('AMI API redirect blocked.');
    error.status = 502;
    error.expose = true;
    throw error;
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxResponseBytes) {
    const error = new Error('AMI API response exceeds the allowed size.');
    error.status = 502;
    error.expose = true;
    throw error;
  }
  if (!response.body) {
    const error = new Error('AMI API returned an empty response.');
    error.status = 502;
    error.expose = true;
    throw error;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxResponseBytes) {
      await reader.cancel();
      const error = new Error('AMI API response exceeds the allowed size.');
      error.status = 502;
      error.expose = true;
      throw error;
    }
    chunks.push(value);
  }

  let payload;
  try {
    const bytes = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const error = new Error('AMI API returned an invalid JSON response.');
    error.status = 502;
    error.expose = true;
    throw error;
  }
  return { payload, status: response.ok ? 200 : 502 };
}

export function createAmiRouter(prisma, { authenticate, requireRole }) {
  const connectionFor = async () => amiConnection(await getSettings(prisma));
  const amiRouter = express.Router();
  amiRouter.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  amiRouter.use(authenticate, requireRole(...AMI_ROLES));

  amiRouter.get('/devices', async (req, res, next) => {
    const type = req.query.type;
    const pageNum = Number(req.query.pageNum ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    if (!['AMMETER', 'SENSOR_FCM'].includes(type) ||
        !Number.isInteger(pageNum) || pageNum < 1 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ success: false, message: 'Provide a supported device type and valid page limits.' });
    }
    try {
      const result = await requestAmi(await connectionFor(), `${adminApi}/device/new-query`, {
        method: 'POST',
        body: { pageNum, pageSize, type },
      });
      res.status(result.status).json(result.payload);
    } catch (error) {
      next(error);
    }
  });
  
  amiRouter.get('/devices/:deviceUuid/latest', async (req, res, next) => {
    const { deviceUuid } = req.params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceUuid)) {
      return res.status(400).json({ success: false, message: 'Invalid AMI device UUID.' });
    }
    try {
      const result = await requestAmi(await connectionFor(), `${iotApi}/ts/last/${encodeURIComponent(deviceUuid)}`);
      res.status(result.status).json(result.payload);
    } catch (error) {
      next(error);
    }
  });

  amiRouter.use((req, res) => {
    res.status(404).json({ success: false, message: 'AMI route not found.' });
  });

  /** Lightweight connectivity check used by Settings → Test connection. */
  const testAmiConnection = async () => {
    const connection = await connectionFor();
    const problem = amiConfigProblem(connection);
    if (problem) return { ok: false, message: problem };
    try {
      const result = await requestAmi(connection, `${adminApi}/device/new-query`, { method: 'POST', body: { pageNum: 1, pageSize: 1, type: 'AMMETER' } });
      const payload = result.payload ?? {};
      // The head-end signals success with code "ok" (same check as the live-readings panel).
      if (result.status !== 200 || payload.code !== 'ok') {
        return { ok: false, message: payload.message || `AMI responded with an error (code ${payload.code ?? result.status}).` };
      }
      const total = payload.result?.total;
      return { ok: true, message: typeof total === 'number' ? `${total} meter(s) visible` : 'connected' };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  };

  return { amiRouter, testAmiConnection };
}
