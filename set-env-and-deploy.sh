#!/bin/bash

# Set Railway Environment Variables and Deploy
# This script sets all required environment variables and deploys the backend

echo "🚀 Setting Railway Environment Variables and Deploying Backend"
echo "=============================================================="
echo ""
echo "Project: strong-insight"
echo ""

cd "$(dirname "$0")"

# Set environment variables
echo "📝 Setting environment variables..."

railway variables set STRIPE_SECRET_KEY=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
railway variables set SUPABASE_URL=https://ztvrjnborprzzbeilicr.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dnJqbmJvcnByenpiZWlsaWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MjQzMDAzNCwiZXhwIjoyMDY4MDA2MDM0fQ.DdcPoP2iv7-c61bYG0lifafDBLfQR3i__oEY1YYx2uo
railway variables set PORT=4001
railway variables set NODE_ENV=production

echo ""
echo "✅ Environment variables set!"
echo ""

# Deploy
echo "🚀 Deploying to Railway..."
railway up

echo ""
echo "✅ Deployment initiated!"
echo ""
echo "📊 Getting backend URL..."
railway domain

echo ""
echo "🎉 Backend deployment complete!"
echo ""
echo "Next steps:"
echo "1. Wait 1-2 minutes for deployment to complete"
echo "2. Test health endpoint: curl https://YOUR-URL.up.railway.app/api/health"
echo "3. Update iOS app if URL is different from dandee-backend-production.up.railway.app"
echo ""

