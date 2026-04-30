// Smoke test: hits the live (or local) backend and verifies the
// Stripe payment-intent path works end-to-end. Run with:
//
//   node --test test/payments.smoke.test.js
//
// Env vars:
//   API_URL    — backend base URL (default: live prod URL)
//   NODE_TLS_REJECT_UNAUTHORIZED=0 if hitting a self-signed staging
//
// This is a smoke test against the deployed Stripe integration, not a
// hermetic unit test. It depends on:
//   - The backend being reachable
//   - The backend's STRIPE_SECRET_KEY env var being set to a real test key
//
// In CI we run this on a schedule; locally you can run it ad-hoc to
// verify a deploy didn't break the Stripe path.

const test = require('node:test');
const assert = require('node:assert/strict');

const API_URL = process.env.API_URL || 'https://strong-insight-production.up.railway.app';

async function get(path) {
  const res = await fetch(`${API_URL}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postJson(path, payload) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test('health endpoint responds 200 with version', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'OK');
  assert.match(body.version || '', /^v\d/);
});

test('create-payment-intent returns a client_secret + correct amount', async () => {
  const amountCents = 1000; // $10.00
  const { status, body } = await postJson('/api/create-payment-intent', {
    amount: amountCents,
    currency: 'usd',
    metadata: {
      idempotency_key: `smoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      source: 'smoke-test',
    },
  });
  assert.equal(status, 200, `unexpected status ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.id?.startsWith('pi_'), 'expected payment intent id');
  assert.ok(typeof body.client_secret === 'string' && body.client_secret.length > 0);
  assert.equal(body.amount, amountCents);
  assert.equal(body.currency, 'usd');
});

// NOTE: This test fails until the backend is redeployed with the
// idempotency-key changes from PROGRESS_LOG #4 (2026-04-28). Once the
// new backend is live, repeat calls with the same `metadata.idempotency_key`
// should return the *same* payment_intent id.
test('create-payment-intent is idempotent on repeat with same key', async () => {
  const amountCents = 2500;
  const idempotencyKey = `smoke-idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const first = await postJson('/api/create-payment-intent', {
    amount: amountCents,
    currency: 'usd',
    metadata: { idempotency_key: idempotencyKey, source: 'smoke-test' },
  });
  assert.equal(first.status, 200);
  const firstId = first.body.id;

  const second = await postJson('/api/create-payment-intent', {
    amount: amountCents,
    currency: 'usd',
    metadata: { idempotency_key: idempotencyKey, source: 'smoke-test' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, firstId, 'repeat with same key should return same payment intent');
});

test('create-payment-intent rejects missing amount', async () => {
  const { status, body } = await postJson('/api/create-payment-intent', {});
  assert.equal(status, 400);
  assert.ok(typeof body.error === 'string');
});
