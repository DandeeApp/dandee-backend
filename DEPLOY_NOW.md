# 🚀 Deploy Railway Backend NOW - Launch Ready

## Quick Steps to Deploy

You're logged in to Railway as: **Rob@nordicsolutionsai.com**

### Option 1: Link to Existing Project (Recommended)

If you already have a Railway project:

```bash
cd /Users/robertnorrholm/Dandee/backend
railway link
```

Select your project (likely `focused-determination` or create new one)

### Option 2: Create New Project

```bash
cd /Users/robertnorrholm/Dandee/backend
railway init
```

Name it: `dandee-backend-production`

---

## After Linking/Creating Project:

### 1. Set Environment Variables

```bash
railway variables set STRIPE_SECRET_KEY=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
railway variables set SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
railway variables set PORT=4001
railway variables set NODE_ENV=production
```

### 2. Deploy

```bash
railway up
```

### 3. Get Your Backend URL

```bash
railway domain
```

This will show your backend URL. Use it in your iOS app!

---

## Or Use Railway Dashboard

1. Go to: https://railway.app
2. Select your project (or create new)
3. Click "New Service" → "GitHub Repo" or "Empty Service"
4. Point it to your `backend` directory
5. Set environment variables in the Variables tab
6. Deploy!

---

## Verify Deployment

Once deployed, test:

```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/api/health
```

Should return:
```json
{"status":"OK","message":"Stripe API server is running"}
```

---

## iOS App Configuration

Your iOS app is already configured to use:
```
https://dandee-backend-production.up.railway.app
```

If your Railway URL is different, update the default in:
- `homeops-hub-connect/src/contexts/AuthContext.tsx` (line 1563, 1640, etc.)

---

## Ready to Launch! 🚀

Run these commands to deploy:

```bash
cd /Users/robertnorrholm/Dandee/backend
railway link        # Select your project
railway up          # Deploy!
railway domain      # Get your URL
```

