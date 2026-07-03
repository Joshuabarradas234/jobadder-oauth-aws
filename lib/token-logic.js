'use strict';

/**
 * Pure, side-effect-free decision logic shared by the Lambdas.
 * Keeping this separate makes the token/refresh rules unit-testable without
 * touching AWS, the network, or the clock.
 */

/**
 * Decide whether a token should be refreshed now.
 *
 * @param {Object}  p
 * @param {number}  p.expiresAt  absolute expiry (unix seconds)
 * @param {number}  p.now        current time (unix seconds)
 * @param {boolean} [p.forced]   force refresh regardless of remaining time (e.g. after a 401)
 * @param {number}  [p.thresholdMinutes=15] refresh when fewer than this many minutes remain
 * @returns {{ refresh: boolean, minutesRemaining: number }}
 */
function shouldRefresh({ expiresAt = 0, now, forced = false, thresholdMinutes = 15 }) {
  const minutesRemaining = (expiresAt - now) / 60;
  if (forced) return { refresh: true, minutesRemaining };
  return { refresh: minutesRemaining <= thresholdMinutes, minutesRemaining };
}

/**
 * Compute an absolute expiry timestamp from an expires_in duration.
 * Falls back to 3600s (JobAdder default) when expires_in is missing.
 *
 * @param {number} now         current time (unix seconds)
 * @param {number} [expiresIn] seconds until expiry
 * @returns {number} absolute expiry (unix seconds)
 */
function computeExpiresAt(now, expiresIn) {
  return now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600);
}

/**
 * Classify a JobAdder API HTTP status into an action the fetcher should take.
 *   200 → 'ok'            (use the data)
 *   404 → 'not_found'     (drop the message; not retryable)
 *   401 → 'unauthorized'  (refresh token, retry once)
 *   else → 'error'        (throw → SQS retry / DLQ)
 *
 * @param {number} statusCode
 * @returns {'ok'|'not_found'|'unauthorized'|'error'}
 */
function classifyApiStatus(statusCode) {
  if (statusCode === 200) return 'ok';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 401) return 'unauthorized';
  return 'error';
}

module.exports = { shouldRefresh, computeExpiresAt, classifyApiStatus };
