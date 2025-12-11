# 🚀 Quick Railway Backend Deployment - Launch Ready

## Current Status
- ✅ Railway CLI installed
- ✅ Backend code ready
- ⚠️  Railway backend not deployed (404 error)

## Quick Deploy Steps

### Step 1: Login to Railway
```bash
cd /Users/robertnorrholm/Dandee/backend
railway login
```

### Step 2: Create/Link Project
```bash
# Create new project or link existing
railway init

# Or link to existing project
railway link
```

### Step 3: Set Environment Variables
```bash
# Set all required environment variables
railway variables set STRIPE_SECRET_KEY=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
railway variables set SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
railway variables set PORT=4001
railway variables set NODE_ENV=production
```

### Step 4: Deploy
```bash
railway up
```

### Step 5: Get Backend URL
```bash
railway domain
```

This will show your backend URL. If you already have a domain:
```
dandee-backend-production.up.railway.app
```

## Verify Deployment

Test the health endpoint:
```bash
curl https://dandee-backend-production.up.railway.app/api/health
```

Should return:
```json
{"status":"OK","message":"Stripe API server is running"}
```

## Alternative: Use Deployment Script

Run the automated deployment script:
```bash
cd /Users/robertnorrholm/Dandee/backend
./deploy-railway.sh --deploy
```

## 📱 iOS App Configuration

The iOS app is already configured to use:
```
https://dandee-backend-production.up.railway.app
```

Once Railway backend is deployed, the app will automatically connect!

## 🔧 Troubleshooting

### If deployment fails:
1. Check Railway dashboard: https://railway.app
2. Verify all environment variables are set
3. Check deployment logs in Railway dashboard

### If backend URL doesn't work:
1. Run `railway domain` to get the correct URL
2. Update the URL in the iOS app if needed
3. Wait 1-2 minutes after deployment for DNS propagation

---
*Ready to deploy! Run the commands above to launch your backend.*

