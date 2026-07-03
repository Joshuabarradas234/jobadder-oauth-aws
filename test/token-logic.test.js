'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldRefresh,
  computeExpiresAt,
  classifyApiStatus,
} = require('../lib/token-logic');

// ─── shouldRefresh ────────────────────────────────────────────────────────────

test('shouldRefresh: refreshes when close to expiry', () => {
  const now = 1_000_000;
  const expiresAt = now + 5 * 60; // 5 min left
  const { refresh, minutesRemaining } = shouldRefresh({ expiresAt, now });
  assert.equal(refresh, true);
  assert.equal(Math.round(minutesRemaining), 5);
});

test('shouldRefresh: skips when plenty of time remains', () => {
  const now = 1_000_000;
  const expiresAt = now + 40 * 60; // 40 min left
  const { refresh } = shouldRefresh({ expiresAt, now });
  assert.equal(refresh, false);
});

test('shouldRefresh: forced always refreshes even with time left', () => {
  const now = 1_000_000;
  const expiresAt = now + 40 * 60;
  const { refresh } = shouldRefresh({ expiresAt, now, forced: true });
  assert.equal(refresh, true);
});

test('shouldRefresh: refreshes on already-expired token', () => {
  const now = 1_000_000;
  const expiresAt = now - 60; // expired a minute ago
  const { refresh, minutesRemaining } = shouldRefresh({ expiresAt, now });
  assert.equal(refresh, true);
  assert.ok(minutesRemaining < 0);
});

test('shouldRefresh: respects a custom threshold', () => {
  const now = 1_000_000;
  const expiresAt = now + 20 * 60; // 20 min left
  assert.equal(shouldRefresh({ expiresAt, now, thresholdMinutes: 15 }).refresh, false);
  assert.equal(shouldRefresh({ expiresAt, now, thresholdMinutes: 25 }).refresh, true);
});

// ─── computeExpiresAt ─────────────────────────────────────────────────────────

test('computeExpiresAt: adds expires_in to now', () => {
  assert.equal(computeExpiresAt(1000, 3600), 4600);
});

test('computeExpiresAt: falls back to 3600 when missing', () => {
  assert.equal(computeExpiresAt(1000, undefined), 4600);
  assert.equal(computeExpiresAt(1000, 0), 4600);
  assert.equal(computeExpiresAt(1000, -5), 4600);
});

// ─── classifyApiStatus ────────────────────────────────────────────────────────

test('classifyApiStatus: maps known statuses', () => {
  assert.equal(classifyApiStatus(200), 'ok');
  assert.equal(classifyApiStatus(404), 'not_found');
  assert.equal(classifyApiStatus(401), 'unauthorized');
});

test('classifyApiStatus: anything else is an error', () => {
  assert.equal(classifyApiStatus(500), 'error');
  assert.equal(classifyApiStatus(429), 'error');
  assert.equal(classifyApiStatus(403), 'error');
});
