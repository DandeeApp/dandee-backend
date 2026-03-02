#!/bin/bash

# Railway Backend Deployment Script
# This script helps deploy the Dandee backend to Railway

echo "🚀 Dandee Backend Railway Deployment"
echo "======================================"
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Installing..."
    npm install -g @railway/cli
fi

echo "✅ Railway CLI found"
echo ""

# Navigate to backend directory
cd "$(dirname "$0")"
echo "📁 Working directory: $(pwd)"
echo ""

# Check if logged in
echo "🔐 Checking Railway login status..."
if railway whoami &> /dev/null; then
    echo "✅ Logged in to Railway"
    railway whoami
else
    echo "⚠️  Not logged in. Please login:"
    echo "   railway login"
    exit 1
fi

echo ""
echo "📋 Next steps:"
echo ""
echo "1. Link to Railway project (if not already linked):"
echo "   railway link"
echo ""
echo "2. Set environment variables:"
echo "   railway variables set STRIPE_SECRET_KEY=your_stripe_key"
echo "   railway variables set SUPABASE_URL=your_supabase_url"
echo "   railway variables set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key"
echo "   railway variables set PORT=4001"
echo "   railway variables set NODE_ENV=production"
echo ""
echo "3. Deploy:"
echo "   railway up"
echo ""
echo "4. Get your backend URL:"
echo "   railway domain"
echo ""
echo "Or run this script with --deploy flag to deploy automatically"
echo ""

if [ "$1" == "--deploy" ]; then
    echo "🚀 Deploying to Railway..."
    railway up
    echo ""
    echo "✅ Deployment initiated!"
    echo ""
    echo "📊 Get your backend URL:"
    railway domain
fi



