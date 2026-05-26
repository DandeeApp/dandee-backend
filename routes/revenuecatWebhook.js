// ============================================
// RevenueCat webhook
// ============================================
// Receives subscription lifecycle events from RevenueCat and mirrors them
// into public.user_subscriptions so the backend (tipsEngine, free-tier
// limit checks, score gating) always agrees with the App Store / Play Store
// source of truth — even when the client-side write after a purchase
// fails (network drop, app crash, etc.).
//
// Config (RevenueCat Dashboard → Project Settings → Integrations → Webhooks):
//   URL:    https://<your-railway-host>/api/webhooks/revenuecat
//   Auth:   header `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`
//
// Event types handled: INITIAL_PURCHASE, RENEWAL, PRODUCT_CHANGE,
// UNCANCELLATION, CANCELLATION, EXPIRATION, BILLING_ISSUE,
// SUBSCRIPTION_PAUSED, NON_RENEWING_PURCHASE, TRANSFER, TEST.
//
// Mounted in server.js as `app.use(require('./routes/revenuecatWebhook')(supabaseAdmin, notifyAdmin))`.

const express = require('express');

// Maps a RevenueCat product_id to (subscription_plan, user_type).
// Keep in sync with homeops-hub-connect/src/services/iapService.ts.
const PRODUCT_MAP = {
  'com.dandee.homecare_plus_monthly_2.0': { plan: 'homecare_plus', userType: 'homeowner' },
  'com.dandee.contractor_pro_monthly_2.0': { plan: 'pro', userType: 'contractor' },
};

function planForProduct(productId) {
  return PRODUCT_MAP[productId] || null;
}

module.exports = function buildRevenueCatWebhookRouter(supabaseAdmin, notifyAdmin) {
  const router = express.Router();

  router.post('/api/webhooks/revenuecat', async (req, res) => {
    // ---------- Auth ----------
    const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
    const received = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expected) {
      console.error('[revenuecat] REVENUECAT_WEBHOOK_SECRET not set — refusing all webhooks');
      return res.status(503).json({ error: 'webhook secret not configured' });
    }
    if (!received || received !== expected) {
      console.warn('[revenuecat] unauthorized webhook attempt');
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (!supabaseAdmin) {
      console.error('[revenuecat] supabaseAdmin not initialized; dropping event');
      return res.status(503).json({ error: 'database not configured' });
    }

    const event = req.body?.event;
    if (!event) {
      console.warn('[revenuecat] webhook with no event payload');
      return res.status(400).json({ error: 'missing event' });
    }

    const type = event.type;
    const userId = event.app_user_id;
    const productId = event.product_id;

    console.log(`[revenuecat] ${type} app_user_id=${userId} product=${productId}`);

    // TEST events: just ACK so the dashboard ping passes.
    if (type === 'TEST') {
      return res.json({ ok: true, test: true });
    }

    if (!userId) {
      console.warn('[revenuecat] event missing app_user_id — cannot map to user');
      return res.json({ ok: true, skipped: 'no_user' });
    }

    try {
      switch (type) {
        // ---------- Grants ----------
        case 'INITIAL_PURCHASE':
        case 'RENEWAL':
        case 'PRODUCT_CHANGE':
        case 'UNCANCELLATION':
        case 'NON_RENEWING_PURCHASE': {
          const mapping = planForProduct(productId);
          if (!mapping) {
            console.warn('[revenuecat] unknown product_id, skipping:', productId);
            return res.json({ ok: true, skipped: 'unknown_product' });
          }
          const trialEndMs = event.expiration_at_ms || null;
          await supabaseAdmin.from('user_subscriptions').upsert(
            {
              user_id: userId,
              user_type: mapping.userType,
              subscription_plan: mapping.plan,
              is_active: true,
              trial_status: event.period_type === 'TRIAL' ? 'active' : 'none',
              trial_end_date: trialEndMs ? new Date(trialEndMs).toISOString() : null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
          );
          break;
        }

        // ---------- Soft signals (keep access until expiration) ----------
        case 'CANCELLATION': {
          // User canceled auto-renewal but still has access until expiration_at_ms.
          // Leave is_active=true; downgrade happens on EXPIRATION event.
          break;
        }
        case 'SUBSCRIPTION_PAUSED': {
          // Paused (Android Play feature). Keep current state.
          break;
        }
        case 'BILLING_ISSUE': {
          // Auto-renew failed; user may resolve. Don't downgrade yet — Apple/Google
          // typically retry for ~16 days. Flag to admin so we can investigate.
          if (notifyAdmin) {
            await notifyAdmin({
              severity: 'warning',
              alertType: 'revenuecat.billing_issue',
              message: `Billing issue for user ${userId} on product ${productId}.`,
              metadata: { event },
            }).catch((e) => console.warn('[revenuecat] notifyAdmin failed:', e.message));
          }
          break;
        }

        // ---------- Hard revoke ----------
        case 'EXPIRATION': {
          await supabaseAdmin.from('user_subscriptions').upsert(
            {
              user_id: userId,
              user_type: 'homeowner', // best guess; entitlement gone either way
              subscription_plan: 'free',
              is_active: false,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' },
          );
          break;
        }

        // ---------- Edge cases ----------
        case 'TRANSFER': {
          // Subscription moved from one app_user_id to another.
          // event.transferred_from / transferred_to are arrays of app_user_ids.
          const from = event.transferred_from || [];
          const to = event.transferred_to || [];
          // Revoke from old user(s)
          for (const oldId of from) {
            await supabaseAdmin.from('user_subscriptions').update({
              subscription_plan: 'free', is_active: false, updated_at: new Date().toISOString(),
            }).eq('user_id', oldId);
          }
          // Grant to new user(s)
          const mapping = planForProduct(productId);
          if (mapping) {
            for (const newId of to) {
              await supabaseAdmin.from('user_subscriptions').upsert(
                {
                  user_id: newId,
                  user_type: mapping.userType,
                  subscription_plan: mapping.plan,
                  is_active: true,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
              );
            }
          }
          break;
        }

        default:
          console.log('[revenuecat] unhandled event type:', type);
          return res.json({ ok: true, unhandled: type });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('[revenuecat] handler error:', err);
      // ACK with 500 so RevenueCat retries.
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
