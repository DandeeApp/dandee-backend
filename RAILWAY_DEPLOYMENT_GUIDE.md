# Railway Backend Deployment Guide - Launch Ready

## 🚀 Quick Deploy to Railway

### Option 1: Deploy via Railway CLI (Recommended)

1. **Install Railway CLI** (if not installed):
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Navigate to backend directory**:
   ```bash
   cd /Users/robertnorrholm/Dandee/backend
   ```

4. **Initialize Railway project** (if not already connected):
   ```bash
   railway init
   ```
   - Select "Create new project" or "Link to existing project"
   - Name it: `dandee-backend-production`

5. **Set Environment Variables in Railway Dashboard**:
   - Go to: https://railway.app/project/[your-project-id]/variables
   - Add these variables:
     ```
     PORT=4001
     STRIPE_SECRET_KEY=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
     SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
     NODE_ENV=production
     ```

6. **Deploy**:
   ```bash
   railway up
   ```

7. **Get Your Backend URL**:
   ```bash
   railway domain
   ```
   - Or check Railway dashboard → Settings → Networking
   - Copy the generated URL (e.g., `https://dandee-backend-production.up.railway.app`)

### Option 2: Deploy via Railway Dashboard

1. **Go to Railway Dashboard**: https://railway.app

2. **Create New Project**:
   - Click "New Project"
   - Select "Deploy from GitHub repo" OR "Empty Project"

3. **Add Service**:
   - Click "New" → "GitHub Repo" (if connected)
   - OR "New" → "Empty Service"
   - Connect your `backend` directory

4. **Configure Service**:
   - **Root Directory**: `/backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

5. **Set Environment Variables**:
   - Go to Variables tab
   - Add all required variables (see above)

6. **Get Backend URL**:
   - Go to Settings → Networking
   - Generate domain or use custom domain
   - Copy the URL

### Option 3: Deploy from Terminal (Quick Start)

```bash
cd /Users/robertnorrholm/Dandee/backend

# Login to Railway
railway login

# Initialize (if first time)
railway init

# Set environment variables
railway variables set STRIPE_SECRET_KEY=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
railway variables set SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
railway variables set NODE_ENV=production
railway variables set PORT=4001

# Deploy
railway up

# Get URL
railway domain
```

## 🔧 Required Environment Variables

Add these in Railway Dashboard → Variables:

```
PORT=4001
STRIPE_SECRET_KEY=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
SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
NODE_ENV=production
```

## ✅ Verify Deployment

1. **Check Health Endpoint**:
   ```bash
   curl https://dandee-backend-production.up.railway.app/api/health
   ```
   Should return: `{"status":"OK","message":"Stripe API server is running"}`

2. **Test Profile Endpoint**:
   ```bash
   curl https://dandee-backend-production.up.railway.app/api/customers/profile
   ```
   Should return error (expected - needs authentication)

## 📱 Update iOS App Configuration

After Railway backend is deployed, update the iOS app:

1. **The app already uses the Railway URL by default**:
   - URL: `https://dandee-backend-production.up.railway.app`
   - This is already set as the default in `AuthContext.tsx`

2. **No changes needed** - app will automatically use Railway backend once it's deployed

## 🎯 Launch Checklist

- [ ] Railway backend deployed and running
- [ ] Health endpoint responding
- [ ] Environment variables set in Railway
- [ ] Stripe keys configured (production keys for launch)
- [ ] Supabase service role key configured
- [ ] Backend URL accessible from iOS app
- [ ] Profile save endpoints working
- [ ] Payment endpoints working

---
*Ready for production launch once Railway backend is deployed*

