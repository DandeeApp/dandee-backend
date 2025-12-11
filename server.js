const express = require('express');
const cors = require('cors');
const stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Log startup immediately
console.log('🚀 Starting Dandee backend server...');
console.log(`📦 Node version: ${process.version}`);
console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

const app = express();
const parsePort = (value) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const envPort = parsePort(process.env.PORT);
const PORT = envPort ?? 8080;
console.log(`🔌 Will listen on port: ${PORT}`);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Initialize Stripe with your secret key
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

// Warn if using default/placeholder key
if (!process.env.STRIPE_SECRET_KEY || stripeSecretKey.includes('placeholder')) {
  console.warn('⚠️  WARNING: Using placeholder Stripe API key!');
  console.warn('⚠️  Stripe API calls will fail until you configure a valid key.');
}

let stripeClient = null;
try {
  stripeClient = stripe(stripeSecretKey);
  console.log('✅ Stripe client initialized');
} catch (err) {
  console.error('❌ Failed to initialize Stripe:', err.message);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

let supabaseAdmin = null;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn('⚠️  WARNING: Supabase service credentials not configured.');
  console.warn('⚠️  Onboarding completion API will be disabled until you set:');
  console.warn('⚠️    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env');
} else {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  console.log('✅ Supabase admin client initialized for onboarding persistence');
}

const sanitizeProfilePayload = (profile = {}, profileType = 'customer', userId) => {
  const customerAllowedFields = new Set([
    'id',
    'first_name',
    'last_name',
    'phone',
    'address',
    'city',
    'state',
    'zip_code',
    'bio',
    'profile_photo',
    'email_notifications',
    'sms_notifications',
    'preferred_contact_method',
    'home_type',
    'home_age',
    'latitude',
    'longitude',
  ]);

  const contractorAllowedFields = new Set([
    'id',
    'first_name',
    'last_name',
    'business_name',
    'phone',
    'business_email',
    'license_number',
    'address',
    'city',
    'state',
    'zip_code',
    'specialties',
    'years_experience',
    'email_notifications',
    'sms_notifications',
    'bio',
    'profile_photo',
    'preferred_contact_method',
    'service_radius',
    'business_type',
    'tax_id',
    'w9_on_file',
    'insurance_provider',
    'insurance_policy_number',
    'stripe_connect_account_id',
    'latitude',
    'longitude',
  ]);

  const allowedFields =
    profileType === 'contractor' ? contractorAllowedFields : customerAllowedFields;

  const sanitized = { user_id: userId };

  Object.entries(profile || {}).forEach(([key, value]) => {
    if (!allowedFields.has(key)) {
      return;
    }

    if (key === 'id') {
      if (typeof value === 'string' && value && !value.startsWith('temp-')) {
        sanitized.id = value;
      }
      return;
    }

    // Special handling for latitude/longitude - always include if they're valid numbers
    if (key === 'latitude' || key === 'longitude') {
      if (typeof value === 'number' && !Number.isNaN(value) && Number.isFinite(value)) {
        sanitized[key] = value;
      }
      return;
    }

    // CRITICAL: Always preserve address fields even if empty string
    // These are vital for location-based matching
    const addressFields = ['address', 'city', 'state', 'zip_code'];
    if (addressFields.includes(key)) {
      sanitized[key] = value !== undefined && value !== null ? String(value).trim() : null;
      return;
    }

    if (value === undefined || value === null) {
      return;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      sanitized[key] = trimmed;
      return;
    }

    sanitized[key] = value;
  });

  return sanitized;
};

const sanitizeScheduledJobPayload = (payload = {}) => {
  const allowedFields = new Set([
    'id',
    'quote_id',
    'contractor_id',
    'job_request_id',
    'title',
    'job_date',
    'start_time',
    'end_time',
    'status',
    'location',
    'job_value',
    'notes',
    'client_name',
    'client_email',
    'client_phone',
  ]);

  const sanitized = {};

  Object.entries(payload || {}).forEach(([key, value]) => {
    if (!allowedFields.has(key)) {
      return;
    }

    if (value === undefined || value === null) {
      return;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      sanitized[key] = trimmed;
      return;
    }

    sanitized[key] = value;
  });

  return sanitized;
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Stripe API server is running' });
});

// Get contractor reviews (bypasses RLS)
app.get('/api/reviews/contractor/:contractorId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }
  
  try {
    const { contractorId } = req.params;
    console.log('⭐ Backend: Fetching reviews for contractor:', contractorId);
    
    const { data: reviews, error } = await supabaseAdmin
      .from('reviews')
      .select('*')
      .eq('contractor_id', contractorId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Backend: Error fetching reviews:', error);
      return res.status(500).json({ error: error.message });
    }
    
    console.log('✅ Backend: Found reviews:', reviews?.length || 0);
    res.json(reviews || []);
  } catch (error) {
    console.error('❌ Backend: Unexpected error fetching reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get contractor payments (bypasses RLS using admin client)
app.get('/api/payments/contractor/:contractorId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }
  
  try {
    const { contractorId } = req.params;
    console.log('💰 Backend: Fetching payments for contractor:', contractorId);
    
    const { data: payments, error } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('contractor_id', contractorId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Backend: Error fetching contractor payments:', error);
      return res.status(500).json({ error: error.message });
    }
    
    console.log('✅ Backend: Found contractor payments:', payments?.length || 0);
    res.json(payments || []);
  } catch (error) {
    console.error('❌ Debug: Unexpected error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata = {} } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    console.log('Creating payment intent:', { amount, currency, metadata });

    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: Math.round(amount), // Ensure amount is in cents
      currency,
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('Payment intent created:', paymentIntent.id);

    res.json({
      id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      created: paymentIntent.created,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      details: error.message 
    });
  }
});

// Confirm Payment
app.post('/api/confirm-payment', async (req, res) => {
  try {
    const { paymentIntentId, paymentMethodId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent ID is required' });
    }

    console.log('Confirming payment:', { paymentIntentId, paymentMethodId });

    const paymentIntent = await stripeClient.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethodId,
    });

    console.log('Payment confirmed:', paymentIntent.status);

    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ 
      error: 'Failed to confirm payment',
      details: error.message 
    });
  }
});

// Cancel Payment
app.post('/api/cancel-payment', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Payment intent ID is required' });
    }

    console.log('Canceling payment:', paymentIntentId);

    const paymentIntent = await stripeClient.paymentIntents.cancel(paymentIntentId);

    console.log('Payment canceled:', paymentIntent.status);

    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    console.error('Error canceling payment:', error);
    res.status(500).json({ 
      error: 'Failed to cancel payment',
      details: error.message 
    });
  }
});

// Get Payment Intent
app.get('/api/payment-intent/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('Getting payment intent:', id);

    const paymentIntent = await stripeClient.paymentIntents.retrieve(id);

    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      created: paymentIntent.created,
      metadata: paymentIntent.metadata,
    });
  } catch (error) {
    console.error('Error retrieving payment intent:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve payment intent',
      details: error.message 
    });
  }
});

// Stripe Connect - Create Connect Account
app.post('/api/create-connect-account', async (req, res) => {
  try {
    const { email, businessName, contractorId } = req.body;

    console.log('Creating Stripe Connect account for:', email);

    const account = await stripeClient.accounts.create({
      type: 'express',
      email,
      business_type: 'individual',
      metadata: {
        contractor_id: contractorId || '',
        business_name: businessName || '',
      },
    });

    console.log('✅ Stripe Connect account created:', account.id);

    res.json({
      accountId: account.id,
      account: {
        id: account.id,
        email: account.email,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
      },
    });
  } catch (error) {
    console.error('Error creating Connect account:', error);
    // Better error handling for Stripe errors
    const errorMessage = error?.message || error?.raw?.message || 'Unknown error';
    const errorType = error?.type || 'unknown';
    const errorCode = error?.code || 'unknown';
    
    console.error('Stripe error details:', { type: errorType, code: errorCode, message: errorMessage });
    
    res.status(500).json({ 
      error: 'Failed to create Connect account',
      details: errorMessage,
      type: errorType,
      code: errorCode
    });
  }
});

// Stripe Connect - Create Account Link
app.post('/api/create-account-link', async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;

    console.log('Creating account link for:', accountId);

    const accountLink = await stripeClient.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || 'https://dandee.app/contractor/onboarding/refresh',
      return_url: returnUrl || 'https://dandee.app/contractor/onboarding/complete',
      type: 'account_onboarding',
    });

    console.log('✅ Account link created');

    res.json({
      url: accountLink.url,
      expires_at: accountLink.expires_at,
    });
  } catch (error) {
    console.error('Error creating account link:', error);
    res.status(500).json({ 
      error: 'Failed to create account link',
      details: error.message 
    });
  }
});

// Stripe Connect - Get Account Status
app.get('/api/account-status/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    console.log('Getting account status for:', accountId);

    const account = await stripeClient.accounts.retrieve(accountId);

    res.json({
      id: account.id,
      email: account.email,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: account.requirements,
    });
  } catch (error) {
    console.error('Error getting account status:', error);
    res.status(500).json({ 
      error: 'Failed to get account status',
      details: error.message 
    });
  }
});

// Stripe Connect - Transfer to Contractor
app.post('/api/transfer-to-contractor', async (req, res) => {
  try {
    const { accountId, amount, currency = 'usd', metadata = {} } = req.body;

    console.log('Transferring to contractor:', { accountId, amount, currency });

    const transfer = await stripeClient.transfers.create({
      amount: Math.round(amount),
      currency,
      destination: accountId,
      metadata,
    });

    console.log('✅ Transfer completed:', transfer.id);

    res.json({
      transferId: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      destination: transfer.destination,
      status: 'succeeded',
    });
  } catch (error) {
    console.error('Error transferring to contractor:', error);
    res.status(500).json({ 
      error: 'Failed to transfer to contractor',
      details: error.message 
    });
  }
});

// Stripe Connect - Create Payment Intent with Application Fee
app.post('/api/create-payment-intent-with-fee', async (req, res) => {
  try {
    const { amount, currency = 'usd', application_fee_amount, contractor_account_id, metadata = {} } = req.body;

    console.log('Creating payment intent with fee:', { amount, application_fee_amount, contractor_account_id });

    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: Math.round(amount),
      currency,
      application_fee_amount: Math.round(application_fee_amount),
      transfer_data: {
        destination: contractor_account_id,
      },
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('✅ Payment intent with fee created:', paymentIntent.id);

    res.json({
      id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      application_fee_amount: paymentIntent.application_fee_amount,
      status: paymentIntent.status,
    });
  } catch (error) {
    console.error('Error creating payment intent with fee:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent with fee',
      details: error.message 
    });
  }
});

app.post('/api/onboarding/complete', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({
      error: 'Supabase service role key not configured',
      details: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env',
    });
  }

  try {
    const { userId, metadata, profile, profileType = 'customer' } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    console.log('📝 Completing onboarding via backend:', {
      userId,
      hasMetadata: !!metadata,
      metadataKeys: metadata ? Object.keys(metadata) : [],
      profileType,
      hasProfile: !!profile,
      profileKeys: profile ? Object.keys(profile) : [],
      address: profile?.address,
      city: profile?.city,
      state: profile?.state,
      zip_code: profile?.zip_code,
    });

    const responseBody = {
      success: true,
      metadataUpdated: false,
      profileUpdated: false,
    };

    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: metadata,
      });

      if (error) {
        console.error('❌ Supabase admin metadata update failed:', error);
        return res.status(500).json({
          error: 'Failed to update user metadata',
          details: error.message,
        });
      }

      responseBody.metadataUpdated = true;
      responseBody.updatedUserMetadata = data?.user?.user_metadata || metadata;
    } else {
      console.log('📝 No metadata payload provided, skipping metadata update');
    }

    if (profile && typeof profile === 'object' && Object.keys(profile).length > 0) {
      const sanitizedProfile = sanitizeProfilePayload(profile, profileType, userId);
      
      console.log('📝 Backend: Sanitized profile after onboarding:', {
        keys: Object.keys(sanitizedProfile),
        address: sanitizedProfile.address,
        city: sanitizedProfile.city,
        state: sanitizedProfile.state,
        zip_code: sanitizedProfile.zip_code,
        latitude: sanitizedProfile.latitude,
        longitude: sanitizedProfile.longitude,
      });

      if (Object.keys(sanitizedProfile).length > 1) {
        const tableName = profileType === 'contractor' ? 'contractor_profiles' : 'customer_profiles';

        const { data: profileData, error: profileError } = await supabaseAdmin
          .from(tableName)
          .upsert(sanitizedProfile, { onConflict: 'user_id' })
          .select()
          .single();

        if (profileError) {
          console.error('❌ Supabase admin profile upsert failed:', profileError);
          return res.status(500).json({
            error: 'Failed to upsert profile',
            details: profileError.message,
          });
        }

        responseBody.profileUpdated = true;
        responseBody.profileData = profileData;
      } else {
        console.log('📝 Profile payload sanitized to empty object, skipping upsert');
      }
    } else {
      console.log('📝 No profile payload provided, skipping profile upsert');
    }

    res.json(responseBody);
  } catch (error) {
    console.error('Unhandled error completing onboarding via backend:', error);
    res.status(500).json({
      error: 'Failed to complete onboarding',
      details: error.message,
    });
  }
});

app.post('/api/contractors/profile', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId, profile } = req.body || {};

    if (!userId || !profile || typeof profile !== 'object') {
      return res.status(400).json({
        error: 'Invalid request payload',
        details: 'userId and profile are required',
      });
    }

    console.log('🛠️ Backend: Received contractor profile update:', {
      userId,
      profileKeys: Object.keys(profile || {}),
      latitude: profile?.latitude,
      longitude: profile?.longitude,
    });

    const sanitizedProfile = sanitizeProfilePayload(profile, 'contractor', userId);

    if (!sanitizedProfile || Object.keys(sanitizedProfile).length <= 1) {
      return res.status(400).json({
        error: 'No valid contractor profile fields provided',
      });
    }

    console.log('🛠️ Backend: Sanitized profile includes:', {
      keys: Object.keys(sanitizedProfile),
      latitude: sanitizedProfile.latitude,
      longitude: sanitizedProfile.longitude,
    });

    console.log('🛠️ Backend: Upserting contractor profile for user:', userId);

    const { data, error } = await supabaseAdmin
      .from('contractor_profiles')
      .upsert(sanitizedProfile, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      console.error('❌ Backend: Failed to upsert contractor profile:', error);
      return res.status(500).json({
        error: 'Failed to upsert contractor profile',
        details: error.message,
      });
    }

    console.log('✅ Backend: Contractor profile saved for user:', userId);
    res.json({
      success: true,
      profile: data,
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected contractor profile error:', error);
    res.status(500).json({
      error: 'Unexpected error updating contractor profile',
      details: error.message,
    });
  }
});

app.get('/api/contractors/profile/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        error: 'userId parameter is required',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('contractor_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Contractor profile not found',
        });
      }
      console.error('❌ Backend: Failed to fetch contractor profile:', error);
      return res.status(500).json({
        error: 'Failed to fetch contractor profile',
        details: error.message,
      });
    }

    res.json({
      success: true,
      profile: data,
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected error fetching contractor profile:', error);
    res.status(500).json({
      error: 'Unexpected error fetching contractor profile',
      details: error.message,
    });
  }
});

app.post('/api/customers/profile', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId, profile } = req.body || {};

    if (!userId || !profile || typeof profile !== 'object') {
      return res.status(400).json({
        error: 'Invalid request payload',
        details: 'userId and profile are required',
      });
    }

    console.log('🛠️ Backend: Received customer profile update:', {
      userId,
      profileKeys: Object.keys(profile || {}),
      latitude: profile?.latitude,
      longitude: profile?.longitude,
    });

    const sanitizedProfile = sanitizeProfilePayload(profile, 'customer', userId);

    if (!sanitizedProfile || Object.keys(sanitizedProfile).length <= 1) {
      return res.status(400).json({
        error: 'No valid customer profile fields provided',
      });
    }

    // Ensure required fields are present (first_name and last_name are NOT NULL in database)
    if (!sanitizedProfile.first_name) {
      sanitizedProfile.first_name = profile.first_name || '';
    }
    if (!sanitizedProfile.last_name) {
      sanitizedProfile.last_name = profile.last_name || '';
    }

    console.log('🛠️ Backend: Sanitized profile includes:', {
      keys: Object.keys(sanitizedProfile),
      latitude: sanitizedProfile.latitude,
      longitude: sanitizedProfile.longitude,
      first_name: sanitizedProfile.first_name,
      last_name: sanitizedProfile.last_name,
    });

    console.log('🛠️ Backend: Upserting customer profile for user:', userId);

    const { data, error } = await supabaseAdmin
      .from('customer_profiles')
      .upsert(sanitizedProfile, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      console.error('❌ Backend: Failed to upsert customer profile:', error);
      return res.status(500).json({
        error: 'Failed to upsert customer profile',
        details: error.message,
      });
    }

    console.log('✅ Backend: Customer profile saved for user:', userId);
    res.json({
      success: true,
      profile: data,
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected customer profile error:', error);
    res.status(500).json({
      error: 'Unexpected error updating customer profile',
      details: error.message,
    });
  }
});

app.get('/api/customers/profile/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        error: 'userId parameter is required',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('customer_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          error: 'Customer profile not found',
        });
      }
      console.error('❌ Backend: Failed to fetch customer profile:', error);
      return res.status(500).json({
        error: 'Failed to fetch customer profile',
        details: error.message,
      });
    }

    res.json({
      success: true,
      profile: data,
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected error fetching customer profile:', error);
    res.status(500).json({
      error: 'Unexpected error fetching customer profile',
      details: error.message,
    });
  }
});

// Get full job details for quote submission (bypasses RLS for contractors)
app.get('/api/jobs/:jobId/details', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    console.log('📋 Fetching job details for quote:', jobId);

    const { data, error } = await supabaseAdmin
      .from('job_requests')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Job not found' });
      }
      console.error('❌ Failed to fetch job details:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Job details found:', data.id);

    res.json({
      success: true,
      job: {
        id: data.id,
        title: data.title || 'Untitled Job',
        description: data.description || '',
        location: data.address || data.location || 'Location TBD',
        address: data.address,
        date: data.preferred_date || new Date().toISOString().split('T')[0],
        time: data.preferred_time || '09:00:00',
        urgency: data.urgency || 'medium',
        category: data.category || 'general',
        budget_min: data.budget_min,
        budget_max: data.budget_max,
        customer_name: data.customer_name || 'Customer',
        customer_id: data.customer_id,
        customer_email: data.customer_email,
        customer_phone: data.customer_phone,
        status: data.status,
      },
    });
  } catch (error) {
    console.error('❌ Unexpected error fetching job details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get job location (bypasses RLS for contractors viewing confirmed jobs)
app.get('/api/jobs/:jobId/location', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    console.log('📍 Fetching location for job:', jobId);

    const { data, error } = await supabaseAdmin
      .from('job_requests')
      .select('id, address, location')
      .eq('id', jobId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Job not found' });
      }
      console.error('❌ Failed to fetch job location:', error);
      return res.status(500).json({ error: error.message });
    }

    // Use address if available, otherwise use location
    const fullAddress = data.address || data.location || '';

    console.log('✅ Job location found:', fullAddress);

    res.json({
      success: true,
      jobId: data.id,
      address: data.address,
      location: data.location,
      fullAddress: fullAddress.trim(),
    });
  } catch (error) {
    console.error('❌ Unexpected error fetching job location:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/onboarding/upload-profile-photo', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
    });
  }

  const { userId, dataUrl, fileNameHint } = req.body || {};

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({
      error: 'Invalid request: userId is required'
    });
  }

  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({
      error: 'Invalid request: dataUrl is required'
    });
  }

  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    return res.status(400).json({
      error: 'Invalid data URL format'
    });
  }

  const [, mimeType, base64Data] = match;

  try {
    const buffer = Buffer.from(base64Data, 'base64');

    const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({
        error: 'Photo too large. Please choose an image under 10MB.'
      });
    }

    const extension = (() => {
      if (!mimeType) return 'jpg';
      switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
          return 'jpg';
        case 'image/png':
          return 'png';
        case 'image/gif':
          return 'gif';
        case 'image/webp':
          return 'webp';
        default:
          return 'jpg';
      }
    })();

    const timestamp = Date.now();
    const sanitizedHint = typeof fileNameHint === 'string' ? fileNameHint.replace(/[^a-z0-9\-]/gi, '_') : 'profile';
    const filePath = `users/${userId}/${sanitizedHint || 'profile'}-${timestamp}.${extension}`;

    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('profile-photos')
      .upload(filePath, buffer, {
        contentType: mimeType || 'image/jpeg',
        cacheControl: '3600',
        upsert: true
      });

    if (uploadError) {
      console.error('❌ Supabase storage upload failed:', uploadError);
      return res.status(500).json({
        error: 'Failed to upload photo to storage'
      });
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('profile-photos')
      .getPublicUrl(uploadData?.path || filePath);

    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({
        error: 'Failed to generate public URL for uploaded photo'
      });
    }

    return res.json({
      success: true,
      url: publicUrlData.publicUrl,
      path: uploadData?.path || filePath
    });
  } catch (error) {
    console.error('❌ Unexpected error uploading onboarding photo:', error);
    return res.status(500).json({
      error: 'Unexpected error uploading photo'
    });
  }
});

app.post('/api/scheduling/create-from-quote', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { scheduledJob } = req.body || {};

    if (!scheduledJob || typeof scheduledJob !== 'object') {
      return res.status(400).json({
        error: 'scheduledJob payload is required',
      });
    }

    const sanitized = sanitizeScheduledJobPayload(scheduledJob);

    if (!sanitized.contractor_id || !sanitized.job_request_id || !sanitized.job_date || !sanitized.start_time || !sanitized.title) {
      return res.status(400).json({
        error: 'Missing required fields for scheduled job',
      });
    }

    console.log('🗓️ Backend scheduling create-from-quote request:', sanitized);

    // Use insert instead of upsert since quote_id may not have a unique constraint
    const { data, error } = await supabaseAdmin
      .from('scheduled_jobs')
      .insert(sanitized)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to upsert scheduled job:', error);
      return res.status(500).json({
        error: 'Failed to create scheduled job',
        details: error.message,
      });
    }

    console.log('✅ Scheduled job persisted via backend:', data?.id);

    return res.json({
      success: true,
      scheduledJob: data,
    });
  } catch (error) {
    console.error('❌ Unexpected error creating scheduled job from quote:', error);
    return res.status(500).json({
      error: 'Unexpected error creating scheduled job',
      details: error.message,
    });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId, type, title, message, data, actionUrl } = req.body || {};
    const allowedTypes = new Set(['job', 'quote', 'message', 'review', 'payment', 'system']);

    if (!userId || !type || !title || !message) {
      return res.status(400).json({
        error: 'Missing required notification fields',
      });
    }

    if (!allowedTypes.has(type)) {
      return res.status(400).json({
        error: 'Invalid notification type',
      });
    }

    const insertPayload = {
      user_id: userId,
      type,
      title,
      message,
      metadata: data ?? null,  // Use 'metadata' column to match database schema
      action_url: actionUrl ?? null,
    };

    const { data: notification, error } = await supabaseAdmin
      .from('notifications')
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to insert notification:', error);
      return res.status(500).json({
        error: 'Failed to create notification',
        details: error.message,
      });
    }

    res.json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error('❌ Unexpected error creating notification:', error);
    res.status(500).json({
      error: 'Unexpected error creating notification',
      details: error.message,
    });
  }
});

// Get notifications for a user (bypasses RLS)
app.get('/api/notifications/:userId', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    console.log('📬 Fetching notifications for user:', userId);

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('❌ Failed to fetch notifications:', error);
      return res.status(500).json({
        error: 'Failed to fetch notifications',
        details: error.message,
      });
    }

    console.log('✅ Fetched notifications:', data?.length || 0);
    res.json({ success: true, notifications: data || [] });
  } catch (error) {
    console.error('❌ Unexpected error fetching notifications:', error);
    res.status(500).json({
      error: 'Unexpected error fetching notifications',
      details: error.message,
    });
  }
});

app.post('/api/jobs/update-status', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  const { jobRequestId, status } = req.body || {};
  const allowedStatuses = new Set([
    'open',
    'quoted',
    'accepted',
    'in-progress',
    'completed',
    'cancelled',
  ]);

  if (!jobRequestId || !status) {
    return res.status(400).json({
      error: 'jobRequestId and status are required',
    });
  }

  const normalizedStatus = status === 'in_progress' ? 'in-progress' : status;

  if (!allowedStatuses.has(normalizedStatus)) {
    return res.status(400).json({
      error: `Invalid status "${status}"`,
    });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('job_requests')
      .update({ status: normalizedStatus })
      .eq('id', jobRequestId)
      .select('id, status')
      .single();

    if (error) {
      console.error('❌ Failed to update job status:', error);
      return res.status(500).json({
        error: 'Failed to update job status',
        details: error.message,
      });
    }

    res.json({
      success: true,
      jobRequest: data,
    });
  } catch (error) {
    console.error('❌ Unexpected error updating job status:', error);
    res.status(500).json({
      error: 'Unexpected error updating job status',
      details: error.message,
    });
  }
});

// Create payment record (bypasses RLS)
app.post('/api/payments/create', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { invoice_id, job_request_id, contractor_id, customer_id, amount, payment_method } = req.body || {};

    if (!invoice_id || !job_request_id || !contractor_id || !customer_id || !amount) {
      return res.status(400).json({
        error: 'Missing required payment fields',
      });
    }

    console.log('💳 Backend: Creating payment record:', { invoice_id, amount, customer_id });

    // Generate payment number
    const timestamp = Date.now();
    const payment_number = `PAY-${timestamp}`;

    // Calculate platform fee (2.9% + $0.30)
    const platform_fee = (amount * 0.029) + 0.30;
    const contractor_payout = amount - platform_fee;

    const paymentData = {
      payment_number,
      invoice_id,
      job_request_id,
      contractor_id,
      customer_id,
      amount,
      payment_method: payment_method || 'stripe',
      status: 'pending',
      currency: 'usd',
      platform_fee,
      contractor_payout,
    };

    const { data, error } = await supabaseAdmin
      .from('payments')
      .insert(paymentData)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to create payment:', error);
      return res.status(500).json({
        error: 'Failed to create payment',
        details: error.message,
      });
    }

    console.log('✅ Payment created:', data.id);
    res.json({
      success: true,
      payment: data,
    });
  } catch (error) {
    console.error('❌ Unexpected error creating payment:', error);
    res.status(500).json({
      error: 'Unexpected error creating payment',
      details: error.message,
    });
  }
});

// Update payment status (bypasses RLS)
app.post('/api/payments/update-status', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { paymentId, status, stripe_payment_intent_id } = req.body || {};

    if (!paymentId || !status) {
      return res.status(400).json({
        error: 'paymentId and status are required',
      });
    }

    console.log('💳 Backend: Updating payment status:', { paymentId, status });

    const updateData = { status };
    if (stripe_payment_intent_id) {
      updateData.stripe_payment_intent_id = stripe_payment_intent_id;
    }
    if (status === 'succeeded') {
      updateData.payment_date = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('payments')
      .update(updateData)
      .eq('id', paymentId)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to update payment:', error);
      return res.status(500).json({
        error: 'Failed to update payment status',
        details: error.message,
      });
    }

    console.log('✅ Payment status updated:', data.id);
    res.json({
      success: true,
      payment: data,
    });
  } catch (error) {
    console.error('❌ Unexpected error updating payment:', error);
    res.status(500).json({
      error: 'Unexpected error updating payment',
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    details: error.message 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Bind to 0.0.0.0 for Railway/Docker compatibility
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dandee API server running on port ${PORT}`);
  console.log(`📊 Health check: /api/health`);
  console.log(`✅ Server ready to accept connections`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
}); 