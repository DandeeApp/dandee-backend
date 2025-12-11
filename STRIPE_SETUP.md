# Stripe Payment Setup

## Issue
The payment setup is failing because Stripe API keys are not configured.

## Solution

### 1. Get Your Stripe API Keys
1. Go to https://dashboard.stripe.com/test/apikeys
2. Sign in or create a Stripe account
3. Copy your **Secret key** (starts with `sk_test_...`)

### 2. Configure the Backend
Create a `.env` file in the `backend/` directory:

```bash
cd /Users/robertnorrholm/Dandee/backend
touch .env
```

Add your Stripe API key to the `.env` file:

```
STRIPE_SECRET_KEY=sk_test_your_actual_stripe_key_here
PORT=3001
```

### 3. Restart the Backend Server
```bash
cd /Users/robertnorrholm/Dandee/backend
npm start
```

You should see:
```
🚀 Stripe API server running on port 3001
```

**NO WARNING** about placeholder keys

### 4. Test Payment Setup
- Rebuild and sync the iOS app
- Navigate to contractor profile
- Click "Complete Payment Setup"
- The Stripe Connect account creation should now work

## Current Status
⚠️  Backend is running but using a **placeholder Stripe API key**
❌ All payment operations will fail until you add a valid key

## Next Steps
1. Add your Stripe API key to `.env` file
2. Restart the backend server
3. Test payment setup in the app






