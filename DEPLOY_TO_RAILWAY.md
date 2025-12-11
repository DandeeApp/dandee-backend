# 🚀 Deploy Backend to Railway - Launch Ready!

## Current Status

✅ **Railway Project:** `strong-insight`  
✅ **Railway URL:** `strong-insight-production.up.railway.app`  
✅ **Logged in:** Rob@nordicsolutionsai.com  
⚠️ **iOS App expects:** `dandee-backend-production.up.railway.app`

## Quick Deploy Steps

### Step 1: Set Environment Variables

Run this command to set all required environment variables:

```bash
cd /Users/robertnorrholm/Dandee/backend

railway variables set STRIPE_SECRET_KEY=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
railway variables set SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
railway variables set PORT=4001
railway variables set NODE_ENV=production
```

### Step 2: Deploy

```bash
railway up
```

### Step 3: Update iOS App Configuration

The iOS app is currently looking for: `dandee-backend-production.up.railway.app`

Your actual Railway URL is: `strong-insight-production.up.railway.app`

**Option A: Update iOS app to use your Railway URL**

OR

**Option B: Create a custom domain in Railway** to match `dandee-backend-production.up.railway.app`

### Step 4: Verify Deployment

Test the health endpoint:

```bash
curl https://strong-insight-production.up.railway.app/api/health
```

Should return:
```json
{"status":"OK","message":"Stripe API server is running"}
```

## Or Use the Deployment Script

```bash
cd /Users/robertnorrholm/Dandee/backend
./set-env-and-deploy.sh
```

This script will:
1. Set all environment variables
2. Deploy to Railway
3. Show your backend URL

## After Deployment

1. ✅ Backend will be live at: `strong-insight-production.up.railway.app`
2. ✅ Update iOS app URL (if needed)
3. ✅ Test profile saving
4. ✅ Test payment flows

---

## Launch Checklist

- [ ] Set environment variables
- [ ] Deploy to Railway
- [ ] Verify health endpoint
- [ ] Update iOS app URL (if different)
- [ ] Test profile saving
- [ ] Test payment processing

---

*Ready to launch! Run the commands above to deploy.*

