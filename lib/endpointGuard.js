import crypto from 'node:crypto';
import { recordExecutionLog, extractTriggerSource } from './logger.js';

/**
 * 安全字串比對，防禦 Timing Attack
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 統一提取 HTTP 請求中所夾帶的 Secret Token
 * 支援 Header (authorization Bearer, x-cron-secret, x-relay-secret), body.secret, query.secret
 * @param {object} req
 * @returns {string}
 */
export function extractIncomingSecret(req) {
  if (!req || typeof req !== 'object') return '';
  const authHeader = req.headers?.authorization ?? '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return (
    req.headers?.['x-cron-secret'] ||
    req.headers?.['x-relay-secret'] ||
    bearerToken ||
    req.body?.secret ||
    req.query?.secret ||
    ''
  );
}

/**
 * 統一驗證端點授權並於未授權時記錄稽核日誌
 * @param {object} req
 * @param {string} [expectedSecret]
 * @param {object} [options]
 * @returns {Promise<{ authorized: boolean, triggerSource: string, incomingSecret: string }>}
 */
export async function validateEndpointAuth(req, expectedSecret = process.env.CRON_SECRET, options = {}) {
  const triggerSource = options.triggerSource || extractTriggerSource(req);
  const incomingSecret = extractIncomingSecret(req);

  const authorized = Boolean(expectedSecret && safeCompare(String(incomingSecret || ''), expectedSecret));

  if (!authorized) {
    const unauthorizedReason = options.unauthorizedReason || 'invalid-cron-secret';
    const endpointName = options.endpointName || options.path || options.endpoint;

    await recordExecutionLog({
      status: 'unauthorized',
      reason: unauthorizedReason,
      triggerSource,
      details: {
        ...(endpointName ? { endpoint: endpointName, path: endpointName, endpointName } : {}),
        hasHeader: Boolean(
          req?.headers?.authorization ||
          req?.headers?.['x-cron-secret'] ||
          req?.headers?.['x-relay-secret']
        ),
      },
    });
  }

  return { authorized, triggerSource, incomingSecret };
}

/**
 * 端點守門函式：驗證密鑰並在未授權時記錄稽核日誌與回傳 401
 * @param {object} req
 * @param {object} res
 * @param {object} [options]
 * @returns {Promise<{ authorized: boolean, triggerSource?: string }>}
 */
export async function guardEndpoint(req, res, options = {}) {
  const expectedSecret = options.expectedSecret || process.env.CRON_SECRET;
  const { authorized, triggerSource } = await validateEndpointAuth(req, expectedSecret, options);

  if (!authorized) {
    if (res && typeof res.status === 'function') {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized: Invalid secret',
        reason: 'Unauthorized',
        triggerSource,
      });
    }
    return { authorized: false, triggerSource };
  }

  return { authorized: true, triggerSource };
}

/**
 * 高階函式包裝器 (Higher-Order Guarded Handler)
 * 自動守門並阻斷未授權請求，消除各進入點之樣板檢查碼
 * @param {object | Function} optionsOrHandler
 * @param {Function} [maybeHandler]
 * @returns {Function}
 */
export function withEndpointGuard(optionsOrHandler, maybeHandler) {
  const options = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler || {};
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;

  return async function guardedHandler(req, res) {
    const guard = await guardEndpoint(req, res, options);
    if (!guard.authorized) return;
    return handler(req, res, guard);
  };
}


