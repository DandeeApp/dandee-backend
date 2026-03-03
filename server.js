const express = require('express');
const cors = require('cors');
const stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const pushService = require('./pushNotificationService'); // Keep for backward compatibility
const oneSignalService = require('./oneSignalPushService'); // NEW: OneSignal integration
const { Resend } = require('resend');
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

// Initialize Resend for email
let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Resend email client initialized successfully');
  } catch (err) {
    console.error('❌ Failed to initialize Resend:', err.message);
  }
} else {
  console.warn('⚠️  WARNING: RESEND_API_KEY not set - email sending will be disabled');
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

// Initialize Push Notification Service
try {
  const pushConfig = {};

  // APNs configuration for iOS
  if (process.env.APNS_KEY_PATH || process.env.APNS_KEY) {
    pushConfig.apns = {
      key: process.env.APNS_KEY_PATH || process.env.APNS_KEY,
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
      production: process.env.APNS_PRODUCTION !== 'false',
    };
  }

  // FCM configuration for Android
  if (process.env.FCM_SERVICE_ACCOUNT_PATH || process.env.FCM_SERVICE_ACCOUNT) {
    try {
      pushConfig.fcm = {
        serviceAccountKey: process.env.FCM_SERVICE_ACCOUNT_PATH
          ? require(process.env.FCM_SERVICE_ACCOUNT_PATH)
          : JSON.parse(process.env.FCM_SERVICE_ACCOUNT),
      };
    } catch (err) {
      console.warn('⚠️ Failed to parse FCM service account:', err.message);
    }
  }

  if (pushConfig.apns || pushConfig.fcm) {
    pushService.initialize(pushConfig);
    console.log('✅ Push notification service initialized');
  } else {
    console.warn('⚠️ Push notifications not configured (set APNS_* and FCM_* env vars)');
  }
} catch (err) {
  console.error('❌ Failed to initialize push service:', err.message);
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
    'customer_id',
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
  res.json({ 
    status: 'OK', 
    message: 'Stripe API server is running',
    version: 'v2.2-invitations-endpoint-added',
    timestamp: new Date().toISOString()
  });
});

// Create review (bypasses RLS using admin client)
app.post('/api/reviews/create', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }
  
  try {
    const { reviewData } = req.body || {};
    
    if (!reviewData) {
      return res.status(400).json({ error: 'Review data is required' });
    }
    
    console.log('⭐ Backend: Creating review:', reviewData);
    
    // Handle empty string job_request_id - convert to null for UUID fields
    let jobRequestId = reviewData.job_request_id;
    if (!jobRequestId || jobRequestId === '') {
      // Try to get job_request_id from the invoice if available
      if (reviewData.invoice_id) {
        console.log('⭐ Backend: job_request_id empty, fetching from invoice:', reviewData.invoice_id);
        const { data: invoiceData } = await supabaseAdmin
          .from('invoices')
          .select('job_request_id')
          .eq('id', reviewData.invoice_id)
          .single();
        
        if (invoiceData?.job_request_id) {
          jobRequestId = invoiceData.job_request_id;
          console.log('⭐ Backend: Found job_request_id from invoice:', jobRequestId);
        }
      }
      
      // If still no job_request_id, try to find one from the payment
      if (!jobRequestId && reviewData.payment_id) {
        console.log('⭐ Backend: job_request_id still empty, fetching from payment:', reviewData.payment_id);
        const { data: paymentData } = await supabaseAdmin
          .from('payments')
          .select('job_request_id')
          .eq('id', reviewData.payment_id)
          .single();
        
        if (paymentData?.job_request_id) {
          jobRequestId = paymentData.job_request_id;
          console.log('⭐ Backend: Found job_request_id from payment:', jobRequestId);
        }
      }
      
      // If still no job_request_id, try to find a recent one for the customer/contractor
      if (!jobRequestId && reviewData.customer_id) {
        console.log('⭐ Backend: job_request_id still empty, searching for recent job request');
        const { data: recentJob } = await supabaseAdmin
          .from('job_requests')
          .select('id')
          .eq('customer_id', reviewData.customer_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        
        if (recentJob?.id) {
          jobRequestId = recentJob.id;
          console.log('⭐ Backend: Found recent job_request_id:', jobRequestId);
        }
      }
    }
    
    const reviewToInsert = {
      job_request_id: jobRequestId || null,
      invoice_id: reviewData.invoice_id || null,
      payment_id: reviewData.payment_id || null,
      contractor_id: reviewData.contractor_id,
      customer_id: reviewData.customer_id,
      rating: reviewData.rating,
      review_text: reviewData.review_text || null,
      quality_rating: reviewData.quality_rating || null,
      communication_rating: reviewData.communication_rating || null,
      timeliness_rating: reviewData.timeliness_rating || null,
      professionalism_rating: reviewData.professionalism_rating || null,
      photo_urls: reviewData.photo_urls || [],
      status: 'published',
      is_verified: true,
    };
    
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .insert(reviewToInsert)
      .select()
      .single();
    
    if (error) {
      console.error('❌ Backend: Failed to create review:', error);
      return res.status(500).json({ error: 'Failed to create review', details: error.message });
    }
    
    console.log('✅ Backend: Review created:', data.id);
    res.json({ success: true, review: data });
  } catch (error) {
    console.error('❌ Backend: Unexpected error creating review:', error);
    res.status(500).json({ error: 'Unexpected error creating review', details: error.message });
  }
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
      
      // CRITICAL: Ensure required NOT NULL fields are present
      // Both customer_profiles and contractor_profiles require first_name and last_name
      if (!sanitizedProfile.first_name) {
        sanitizedProfile.first_name = profile.first_name || '';
      }
      if (!sanitizedProfile.last_name) {
        sanitizedProfile.last_name = profile.last_name || '';
      }
      
      console.log('📝 Backend: Sanitized profile after onboarding:', {
        keys: Object.keys(sanitizedProfile),
        first_name: sanitizedProfile.first_name,
        last_name: sanitizedProfile.last_name,
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
        
        // AUTOMATIC REFERRAL CODE GENERATION for contractors after onboarding
        if (profileType === 'contractor' && profileData) {
          console.log('🎁 Auto-generating referral code for new contractor:', userId);
          try {
            // Check if they already have a code
            const { data: existingCode } = await supabaseAdmin
              .from('contractor_referral_codes')
              .select('code')
              .eq('user_id', userId)
              .single();
            
            if (!existingCode) {
              // Generate referral code using the database function
              const firstName = profileData.first_name || sanitizedProfile.first_name || '';
              const lastName = profileData.last_name || sanitizedProfile.last_name || '';
              const contractorId = profileData.id;
              
              console.log('🎁 Generating code with:', { contractorId, userId, firstName, lastName });
              
              const { data: referralCode, error: codeError } = await supabaseAdmin
                .rpc('generate_unique_referral_code', {
                  p_contractor_id: contractorId,
                  p_user_id: userId,
                  p_first_name: firstName,
                  p_last_name: lastName
                });
              
              if (codeError) {
                console.error('❌ Failed to auto-generate referral code:', codeError);
                // Don't fail the onboarding - just log it
              } else {
                console.log('✅ Auto-generated referral code:', referralCode);
                responseBody.referralCode = referralCode;
              }
            } else {
              console.log('✅ Contractor already has referral code:', existingCode.code);
              responseBody.referralCode = existingCode.code;
            }
          } catch (referralError) {
            console.error('❌ Error in auto-referral generation:', referralError);
            // Don't fail the onboarding - just log it
          }
          
          // RECORD REFERRAL if they used a referral code
          if (metadata?.referral_code || profile?.referral_code) {
            const usedReferralCode = metadata?.referral_code || profile?.referral_code;
            console.log('🎁 Recording referral - contractor used code:', usedReferralCode);
            
            try {
              // Look up the referral code to get referrer info
              const { data: referrerCodeData } = await supabaseAdmin
                .from('contractor_referral_codes')
                .select('contractor_id, user_id')
                .eq('code', usedReferralCode.toUpperCase())
                .single();
              
              if (referrerCodeData) {
                // Check if referral already exists
                const { data: existingReferral } = await supabaseAdmin
                  .from('contractor_referrals')
                  .select('id')
                  .eq('referred_user_id', userId)
                  .single();
                
                if (!existingReferral) {
                  // Create the referral record with status 'onboarded' since they're completing onboarding now
                  const { error: referralRecordError } = await supabaseAdmin
                    .from('contractor_referrals')
                    .insert({
                      referrer_contractor_id: referrerCodeData.contractor_id,
                      referrer_user_id: referrerCodeData.user_id,
                      referred_contractor_id: profileData.id,
                      referred_user_id: userId,
                      referred_email: sanitizedProfile.business_email || profile.business_email,
                      referral_code: usedReferralCode.toUpperCase(),
                      status: 'onboarded', // Set to 'onboarded' immediately since they're completing onboarding
                      onboarded_at: new Date().toISOString()
                    });
                  
                  if (referralRecordError) {
                    console.error('❌ Failed to record referral:', referralRecordError);
                  } else {
                    console.log('✅ Referral recorded successfully as onboarded');
                    responseBody.referralRecorded = true;
                  }
                } else {
                  console.log('ℹ️ Referral already exists - updating to onboarded');
                  // Update existing referral to onboarded
                  const { error: updateError } = await supabaseAdmin
                    .from('contractor_referrals')
                    .update({
                      status: 'onboarded',
                      onboarded_at: new Date().toISOString()
                    })
                    .eq('id', existingReferral.id);
                  
                  if (updateError) {
                    console.error('❌ Failed to update referral status:', updateError);
                  } else {
                    console.log('✅ Referral updated to onboarded');
                  }
                }
              } else {
                console.warn('⚠️ Referral code not found:', usedReferralCode);
              }
            } catch (referralRecordError) {
              console.error('❌ Error recording referral:', referralRecordError);
              // Don't fail onboarding - just log it
            }
          }
        }
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

    // CRITICAL: Ensure required NOT NULL fields are present for contractor_profiles
    if (!sanitizedProfile.first_name) {
      sanitizedProfile.first_name = profile.first_name || '';
    }
    if (!sanitizedProfile.last_name) {
      sanitizedProfile.last_name = profile.last_name || '';
    }

    console.log('🛠️ Backend: Sanitized profile includes:', {
      keys: Object.keys(sanitizedProfile),
      first_name: sanitizedProfile.first_name,
      last_name: sanitizedProfile.last_name,
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

// Get past contractors for a customer (for service request form)
app.get('/api/customers/:customerId/past-contractors', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { customerId } = req.params;

    if (!customerId) {
      return res.status(400).json({
        error: 'customerId parameter is required',
      });
    }

    console.log('📋 Backend: Fetching past contractors for customer:', customerId);

    // Get contractors from invoices
    const { data: invoices, error: invoicesError } = await supabaseAdmin
      .from('invoices')
      .select('contractor_id, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });

    if (invoicesError) {
      console.error('❌ Backend: Error fetching invoices:', invoicesError);
      return res.status(500).json({
        error: 'Failed to fetch invoices',
        details: invoicesError.message,
      });
    }

    console.log('📋 Backend: Found', invoices?.length || 0, 'invoices');

    // Extract unique contractor IDs
    const contractorIds = [...new Set(invoices?.map(inv => inv.contractor_id).filter(Boolean) || [])];

    if (contractorIds.length === 0) {
      return res.json({
        success: true,
        contractors: [],
      });
    }

    // Fetch contractor profiles
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('contractor_profiles')
      .select('id, user_id, first_name, last_name, business_name, phone, business_email, specialties')
      .in('user_id', contractorIds);

    if (profilesError) {
      console.error('❌ Backend: Error fetching contractor profiles:', profilesError);
      return res.status(500).json({
        error: 'Failed to fetch contractor profiles',
        details: profilesError.message,
      });
    }

    // Build response with job counts
    const contractors = profiles?.map(profile => {
      const jobCount = invoices.filter(inv => inv.contractor_id === profile.user_id).length;
      const lastJobDate = invoices.find(inv => inv.contractor_id === profile.user_id)?.created_at;

      return {
        contractor_id: profile.user_id,
        contractor_name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Contractor',
        business_name: profile.business_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        phone: profile.phone || '',
        email: profile.business_email || '',
        total_jobs: jobCount,
        last_job_date: lastJobDate,
        specialties: profile.specialties || [],
      };
    }) || [];

    console.log('✅ Backend: Returning', contractors.length, 'past contractors');

    res.json({
      success: true,
      pastContractors: contractors.sort((a, b) => 
        new Date(b.last_job_date).getTime() - new Date(a.last_job_date).getTime()
      ),
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected error fetching past contractors:', error);
    res.status(500).json({
      error: 'Unexpected error fetching past contractors',
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
    const { userId, type, title, message, data, actionUrl, sendPush = true } = req.body || {};
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

    // Send push notification if requested
    let pushResult = null;
    if (sendPush) {
      try {
        // NEW: Use OneSignal for push notifications
        if (oneSignalService.isConfigured()) {
          console.log(`📱 Sending OneSignal push to user: ${userId}`);
          
          const oneSignalResult = await oneSignalService.sendToUser({
            userId,
            title,
            body: message,
            data: data || {},
            url: actionUrl,
          });

          if (oneSignalResult.success) {
            pushResult = {
              provider: 'onesignal',
              sent: oneSignalResult.recipients || 1,
              id: oneSignalResult.id,
            };
            console.log(`✅ OneSignal push sent successfully: ${oneSignalResult.id}`);
          } else {
            console.error(`❌ OneSignal push failed: ${oneSignalResult.error}`);
            pushResult = {
              provider: 'onesignal',
              sent: 0,
              error: oneSignalResult.error,
            };
          }
        } else {
          console.warn('⚠️ OneSignal not configured (missing ONESIGNAL_REST_API_KEY)');
          
          // FALLBACK: Try Firebase/APNs method (legacy)
          // Get user's device tokens
          const { data: tokens, error: tokenError } = await supabaseAdmin
            .from('push_tokens')
            .select('device_token, platform')
            .eq('user_id', userId)
            .eq('is_active', true);

          if (!tokenError && tokens && tokens.length > 0) {
            console.log(`📱 Sending push to ${tokens.length} device(s) for user ${userId}`);
            
            // Send push to all active devices
            const pushPromises = tokens.map(({ device_token, platform }) =>
              pushService.sendPushNotification({
                deviceToken: device_token,
                platform,
                title,
                body: message,
                data: data || {},
                sound: 'default',
                badge: 1,
              })
            );

            const pushResults = await Promise.allSettled(pushPromises);
            const successful = pushResults.filter(r => r.status === 'fulfilled' && r.value.success).length;
            
            pushResult = {
              provider: 'firebase',
              sent: successful,
              total: tokens.length,
              failed: tokens.length - successful,
            };

            console.log(`📊 Push results: ${successful}/${tokens.length} sent successfully`);
          } else {
            console.log(`⚠️ No active push tokens found for user ${userId}`);
          }
        }
      } catch (pushError) {
        console.error('❌ Error sending push notification:', pushError);
        // Don't fail the request if push fails - notification was still saved
      }
    }

    res.json({
      success: true,
      notification,
      push: pushResult,
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

    // job_request_id is optional - we can get it from the invoice if not provided
    if (!invoice_id || !contractor_id || !customer_id || !amount) {
      return res.status(400).json({
        error: 'Missing required payment fields',
        details: { invoice_id: !!invoice_id, contractor_id: !!contractor_id, customer_id: !!customer_id, amount: !!amount }
      });
    }

    // Get job_request_id from invoice if not provided
    let finalJobRequestId = job_request_id;
    if (!finalJobRequestId || finalJobRequestId === '') {
      console.log('💳 Backend: job_request_id not provided, fetching from invoice...');
      const { data: invoiceData, error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .select('job_request_id')
        .eq('id', invoice_id)
        .single();
      
      if (invoiceData?.job_request_id) {
        finalJobRequestId = invoiceData.job_request_id;
        console.log('💳 Backend: Got job_request_id from invoice:', finalJobRequestId);
      } else {
        // If invoice doesn't have job_request_id, try to find one from job_requests for this customer
        // First try with contractor_id
        let { data: jobData } = await supabaseAdmin
          .from('job_requests')
          .select('id')
          .eq('customer_id', customer_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        
        if (jobData?.id) {
          finalJobRequestId = jobData.id;
          console.log('💳 Backend: Got job_request_id from job_requests:', finalJobRequestId);
          
          // Also update the invoice with the job_request_id for future reference
          await supabaseAdmin
            .from('invoices')
            .update({ job_request_id: finalJobRequestId })
            .eq('id', invoice_id);
          console.log('💳 Backend: Updated invoice with job_request_id');
        } else {
          // No job request found - this is an error state
          console.error('💳 Backend: No job_request_id found for customer:', customer_id);
          return res.status(400).json({
            error: 'No job request found for this invoice',
            details: 'Please ensure this invoice is associated with a job request'
          });
        }
      }
    }

    console.log('💳 Backend: Creating payment record:', { invoice_id, job_request_id: finalJobRequestId, amount, customer_id });

    // Generate payment number
    const timestamp = Date.now();
    const payment_number = `PAY-${timestamp}`;

    // Calculate platform fee (2.9% + $0.30)
    const platform_fee = (amount * 0.029) + 0.30;
    const contractor_payout = amount - platform_fee;

    const paymentData = {
      payment_number,
      invoice_id,
      job_request_id: finalJobRequestId,
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

    // If payment succeeded, also update the invoice status to 'paid'
    if (status === 'succeeded' && data.invoice_id) {
      console.log('💳 Backend: Updating invoice status to paid:', data.invoice_id);
      const { error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .update({ 
          status: 'paid', 
          paid_date: new Date().toISOString(),
          amount_paid: data.amount 
        })
        .eq('id', data.invoice_id);

      if (invoiceError) {
        console.error('⚠️ Failed to update invoice status:', invoiceError);
        // Don't fail the whole request, payment was successful
      } else {
        console.log('✅ Invoice status updated to paid');
      }
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

// Update invoice status (bypasses RLS)
app.post('/api/invoices/update-status', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { invoiceId, status, amount_paid } = req.body || {};

    if (!invoiceId || !status) {
      return res.status(400).json({
        error: 'invoiceId and status are required',
      });
    }

    console.log('📄 Backend: Updating invoice status:', { invoiceId, status });

    const updateData = { status };
    if (status === 'paid') {
      updateData.paid_date = new Date().toISOString();
    }
    if (amount_paid !== undefined) {
      updateData.amount_paid = amount_paid;
    }

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', invoiceId)
      .select()
      .single();

    if (error) {
      console.error('❌ Failed to update invoice:', error);
      return res.status(500).json({
        error: 'Failed to update invoice status',
        details: error.message,
      });
    }

    console.log('✅ Invoice status updated:', data.id);
    res.json({
      success: true,
      invoice: data,
    });
  } catch (error) {
    console.error('❌ Unexpected error updating invoice:', error);
    res.status(500).json({
      error: 'Unexpected error updating invoice',
      details: error.message,
    });
  }
});

// Delete user account (requires admin privileges)
app.post('/api/account/delete', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
      details: 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
    });
  }

  try {
    const { userId, userType } = req.body || {};

    if (!userId) {
      return res.status(400).json({
        error: 'userId is required',
      });
    }

    console.log('🗑️ Backend: Deleting account for user:', userId, 'type:', userType);

    // Step 1: Delete profile data based on user type
    const profileTable = userType === 'contractor' ? 'contractor_profiles' : 'customer_profiles';
    
    console.log(`🗑️ Backend: Deleting ${profileTable} for user:`, userId);
    const { error: profileError } = await supabaseAdmin
      .from(profileTable)
      .delete()
      .eq('user_id', userId);

    if (profileError) {
      console.error('⚠️ Backend: Failed to delete profile (continuing):', profileError);
      // Continue anyway - profile might not exist
    } else {
      console.log('✅ Backend: Profile deleted');
    }

    // Step 2: Delete related data (job requests, quotes, etc.)
    // For customers: delete their job requests
    if (userType === 'customer') {
      console.log('🗑️ Backend: Cleaning up customer data...');
      
      // Delete job requests created by this customer
      const { error: jobsError } = await supabaseAdmin
        .from('job_requests')
        .delete()
        .eq('customer_id', userId);
      
      if (jobsError) {
        console.error('⚠️ Backend: Failed to delete job requests:', jobsError);
      }

      // Delete reviews by this customer
      const { error: reviewsError } = await supabaseAdmin
        .from('reviews')
        .delete()
        .eq('customer_id', userId);
      
      if (reviewsError) {
        console.error('⚠️ Backend: Failed to delete reviews:', reviewsError);
      }
    }

    // For contractors: clean up contractor-specific data
    if (userType === 'contractor') {
      console.log('🗑️ Backend: Cleaning up contractor data...');
      
      // Delete quotes by this contractor
      const { error: quotesError } = await supabaseAdmin
        .from('quotes')
        .delete()
        .eq('contractor_id', userId);
      
      if (quotesError) {
        console.error('⚠️ Backend: Failed to delete quotes:', quotesError);
      }

      // Delete scheduled jobs for this contractor
      const { error: scheduledError } = await supabaseAdmin
        .from('scheduled_jobs')
        .delete()
        .eq('contractor_id', userId);
      
      if (scheduledError) {
        console.error('⚠️ Backend: Failed to delete scheduled jobs:', scheduledError);
      }

      // Delete reviews for this contractor
      const { error: reviewsError } = await supabaseAdmin
        .from('reviews')
        .delete()
        .eq('contractor_id', userId);
      
      if (reviewsError) {
        console.error('⚠️ Backend: Failed to delete contractor reviews:', reviewsError);
      }
    }

    // Delete notifications for this user
    const { error: notifError } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('user_id', userId);
    
    if (notifError) {
      console.error('⚠️ Backend: Failed to delete notifications:', notifError);
    }

    // Step 3: Delete the auth user account using admin API
    console.log('🗑️ Backend: Deleting auth user:', userId);
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      console.error('❌ Backend: Failed to delete auth user:', authError);
      return res.status(500).json({
        error: 'Failed to delete auth user account',
        details: authError.message,
      });
    }

    console.log('✅ Backend: Account fully deleted for user:', userId);
    res.json({
      success: true,
      message: 'Account and all associated data have been permanently deleted',
    });
  } catch (error) {
    console.error('❌ Backend: Unexpected error deleting account:', error);
    res.status(500).json({
      error: 'Unexpected error deleting account',
      details: error.message,
    });
  }
});

// ======================
// PUSH NOTIFICATION HELPER ENDPOINTS
// ======================

/**
 * Trigger notification when a new message is received
 * POST /api/notifications/message
 */
app.post('/api/notifications/message', async (req, res) => {
  try {
    const { recipientId, senderName, messagePreview } = req.body;

    if (!recipientId || !senderName) {
      return res.status(400).json({ error: 'recipientId and senderName required' });
    }

    await fetch(`${req.protocol}://${req.get('host')}/api/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: recipientId,
        type: 'message',
        title: `New message from ${senderName}`,
        message: messagePreview || 'You have a new message',
        data: { type: 'message', senderId: senderName },
        actionUrl: '/messages',
        sendPush: true,
      }),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error triggering message notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger notification when a new quote is received
 * POST /api/notifications/quote
 */
app.post('/api/notifications/quote', async (req, res) => {
  try {
    const { customerId, contractorName, quoteAmount } = req.body;

    if (!customerId || !contractorName) {
      return res.status(400).json({ error: 'customerId and contractorName required' });
    }

    await fetch(`${req.protocol}://${req.get('host')}/api/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: customerId,
        type: 'quote',
        title: 'New Quote Received',
        message: `${contractorName} sent you a quote${quoteAmount ? ` for $${quoteAmount}` : ''}`,
        data: { type: 'quote', contractor: contractorName },
        actionUrl: '/quotes',
        sendPush: true,
      }),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error triggering quote notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger notification when a new job request is received
 * POST /api/notifications/job
 */
app.post('/api/notifications/job', async (req, res) => {
  try {
    const { contractorId, customerName, jobType } = req.body;

    if (!contractorId || !customerName) {
      return res.status(400).json({ error: 'contractorId and customerName required' });
    }

    await fetch(`${req.protocol}://${req.get('host')}/api/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: contractorId,
        type: 'job',
        title: 'New Job Request',
        message: `${customerName} sent you a ${jobType || 'job'} request`,
        data: { type: 'job', customer: customerName },
        actionUrl: '/jobs',
        sendPush: true,
      }),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error triggering job notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// REFERRAL PROGRAM ENDPOINTS
// ==========================================

// Validate referral code
app.get('/api/referrals/validate/:code', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { code } = req.params;
    
    // Look up the referral code
    const { data, error } = await supabaseAdmin
      .from('contractor_referral_codes')
      .select(`
        *,
        contractor_profiles!contractor_referral_codes_contractor_id_fkey (
          business_name,
          first_name,
          last_name
        )
      `)
      .eq('code', code.toUpperCase())
      .single();
    
    if (error) {
      // Table might not exist yet - return invalid instead of crashing
      console.log('❌ Referral code lookup error:', error.message);
      return res.json({ valid: false });
    }
    
    if (!data) {
      console.log('❌ Referral code not found:', code);
      return res.json({ valid: false });
    }
    
    // Get contractor profile info for display
    const profile = data.contractor_profiles;
    const referrerName = profile?.business_name || 
                        `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() ||
                        'a contractor';
    
    console.log('✅ Valid referral code:', code, 'from:', referrerName);
    res.json({ 
      valid: true,
      referrerName: referrerName
    });
  } catch (error) {
    console.error('❌ Error validating referral code:', error);
    res.json({ valid: false }); // Return invalid instead of 500 error
  }
});

// Record a new referral
app.post('/api/referrals/record', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { referralCode, referredUserId, referredEmail } = req.body;
    
    if (!referralCode || !referredUserId) {
      return res.status(400).json({ error: 'referralCode and referredUserId are required' });
    }
    
    console.log('🎁 Recording referral:', { referralCode, referredUserId, referredEmail });
    
    // Look up the referral code to get referrer info
    const { data: codeData, error: codeError } = await supabaseAdmin
      .from('contractor_referral_codes')
      .select('contractor_id, user_id')
      .eq('code', referralCode.toUpperCase())
      .single();
    
    if (codeError || !codeData) {
      console.error('❌ Invalid referral code:', referralCode);
      return res.status(404).json({ error: 'Invalid referral code' });
    }
    
    // Check if this referral already exists (prevent duplicates)
    const { data: existingReferral } = await supabaseAdmin
      .from('contractor_referrals')
      .select('id')
      .eq('referred_user_id', referredUserId)
      .single();
    
    if (existingReferral) {
      console.log('⚠️ Referral already exists for user:', referredUserId);
      return res.json({ success: true, referralId: existingReferral.id, alreadyExists: true });
    }
    
    // Create the referral record
    const { data: referralData, error: referralError } = await supabaseAdmin
      .from('contractor_referrals')
      .insert({
        referrer_contractor_id: codeData.contractor_id,
        referrer_user_id: codeData.user_id,
        referred_user_id: referredUserId,
        referred_email: referredEmail,
        referral_code: referralCode.toUpperCase(),
        status: 'signed_up'
      })
      .select()
      .single();
    
    if (referralError) {
      console.error('❌ Error creating referral record:', referralError);
      throw referralError;
    }
    
    console.log('✅ Referral recorded successfully:', referralData.id);
    res.json({ success: true, referralId: referralData.id });
  } catch (error) {
    console.error('❌ Error recording referral:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update referral status (e.g., when contractor completes onboarding)
app.post('/api/referrals/update-status', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { referredUserId, status } = req.body;
    
    if (!referredUserId || !status) {
      return res.status(400).json({ error: 'referredUserId and status are required' });
    }
    
    console.log('📊 Updating referral status:', { referredUserId, status });
    
    // Find the referral
    const { data: referral, error: findError } = await supabaseAdmin
      .from('contractor_referrals')
      .select('*')
      .eq('referred_user_id', referredUserId)
      .single();
    
    if (findError || !referral) {
      console.log('⚠️ No referral found for user:', referredUserId);
      return res.json({ success: false, message: 'No referral found' });
    }
    
    // Update the status
    const updateData = { status };
    if (status === 'onboarded') {
      updateData.onboarded_at = new Date().toISOString();
    }
    
    const { error: updateError } = await supabaseAdmin
      .from('contractor_referrals')
      .update(updateData)
      .eq('id', referral.id);
    
    if (updateError) {
      console.error('❌ Error updating referral status:', updateError);
      throw updateError;
    }
    
    console.log('✅ Referral status updated to:', status);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error updating referral status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate referral code for a contractor (called after they complete onboarding)
app.post('/api/referrals/generate-code', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { userId, contractorId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    console.log('🎲 Generating referral code for user:', userId, 'contractor:', contractorId);
    
    // Check if they already have a code
    const { data: existing } = await supabaseAdmin
      .from('contractor_referral_codes')
      .select('code')
      .eq('user_id', userId)
      .single();
    
    if (existing) {
      console.log('✅ Contractor already has code:', existing.code);
      return res.json({ code: existing.code });
    }
    
    // Get contractor profile to create personalized code
    // Use user_id instead of contractor id (which might be temp-)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('contractor_profiles')
      .select('id, first_name, last_name')
      .eq('user_id', userId)
      .single();
    
    if (profileError && profileError.code !== 'PGRST116') {
      console.warn('⚠️ Could not fetch contractor profile:', profileError.message);
    }
    
    // Use the real contractor ID from database, or generate code anyway
    const realContractorId = profile?.id || contractorId || userId;
    const firstName = profile?.first_name || '';
    const lastName = profile?.last_name || '';
    
    console.log('🎲 Using contractor data:', { realContractorId, firstName, lastName });
    
    // Use database function to generate unique code
    const { data: result, error } = await supabaseAdmin
      .rpc('generate_unique_referral_code', {
        p_contractor_id: realContractorId,
        p_user_id: userId,
        p_first_name: firstName,
        p_last_name: lastName
      });
    
    if (error) {
      console.error('❌ Error generating referral code:', error);
      throw error;
    }
    
    console.log('✅ Generated referral code:', result);
    res.json({ code: result });
  } catch (error) {
    console.error('❌ Error generating referral code:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get contractor's referral stats
app.get('/api/referrals/stats/:userId', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { userId } = req.params;
    
    // Get referral code and stats
    const { data: codeData } = await supabaseAdmin
      .from('contractor_referral_codes')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (!codeData) {
      return res.json({ 
        hasCode: false,
        code: null,
        stats: null
      });
    }
    
    // Get detailed referral breakdown
    const { data: referrals } = await supabaseAdmin
      .from('contractor_referrals')
      .select(`
        *,
        contractor_profiles!contractor_referrals_referred_contractor_id_fkey (
          first_name,
          last_name,
          business_name
        )
      `)
      .eq('referrer_user_id', userId)
      .order('created_at', { ascending: false });
    
    // Count by status
    const stats = {
      total: referrals?.length || 0,
      signed_up: referrals?.filter(r => r.status === 'signed_up').length || 0,
      onboarded: referrals?.filter(r => r.status === 'onboarded').length || 0,
      counted: referrals?.filter(r => r.status === 'counted').length || 0,
    };
    
    res.json({
      hasCode: true,
      code: codeData.code,
      successfulReferrals: codeData.successful_referrals,
      giftCardEarned: codeData.gift_card_earned,
      giftCardEarnedAt: codeData.gift_card_earned_at,
      giftCardSent: codeData.gift_card_sent,
      stats,
      referrals: referrals || []
    });
  } catch (error) {
    console.error('❌ Error getting referral stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint: Mark gift card as sent
app.post('/api/referrals/mark-gift-card-sent', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { userId, notes } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const { error } = await supabaseAdmin
      .from('contractor_referral_codes')
      .update({
        gift_card_sent: true,
        gift_card_sent_at: new Date().toISOString(),
        gift_card_notes: notes || null
      })
      .eq('user_id', userId);
    
    if (error) throw error;
    
    console.log('✅ Marked gift card as sent for user:', userId);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error marking gift card as sent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint: Get all contractors eligible for gift cards
app.get('/api/referrals/gift-card-eligible', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { data, error } = await supabaseAdmin
      .from('referral_program_overview')
      .select('*')
      .eq('gift_card_earned', true)
      .order('gift_card_earned_at', { ascending: true });
    
    if (error) throw error;
    
    res.json({ contractors: data || [] });
  } catch (error) {
    console.error('❌ Error getting gift card eligible contractors:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================================================================
// FLEET MANAGEMENT ENDPOINTS
// ================================================================

// Helper function to generate a secure temporary password
function generateSecurePassword() {
  const length = 12;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }
  return password;
}

// Create Fleet Tech with Credentials
app.post('/api/fleet/techs/create-with-credentials', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { fleetAdminId, adminUserId, techData } = req.body;
    
    if (!fleetAdminId || !adminUserId || !techData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { firstName, lastName, email, phone, employeeId, specialties } = techData;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }

    // Check if email already exists
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserByEmail(email);
    if (existingUser?.user) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    // Check tech limit
    const { data: adminProfile, error: adminError } = await supabaseAdmin
      .from('fleet_admin_profiles')
      .select('max_techs, active_techs_count, subscription_status')
      .eq('id', fleetAdminId)
      .single();

    if (adminError) throw adminError;

    if (adminProfile.active_techs_count >= adminProfile.max_techs) {
      return res.status(400).json({
        error: `Tech limit reached. You have ${adminProfile.active_techs_count} active techs (max: ${adminProfile.max_techs}). Upgrade your subscription to add more.`
      });
    }

    if (!['active', 'trial'].includes(adminProfile.subscription_status)) {
      return res.status(400).json({
        error: `Cannot add techs. Subscription is ${adminProfile.subscription_status}`
      });
    }

    // Generate temporary password
    const temporaryPassword = generateSecurePassword();

    // Create Supabase auth user
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: temporaryPassword,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        user_type: 'fleet_tech',
        first_name: firstName,
        last_name: lastName,
        fleet_admin_id: fleetAdminId
      }
    });

    if (authError) {
      console.error('❌ Error creating auth user:', authError);
      throw authError;
    }

    console.log('✅ Created auth user for tech:', authUser.user.id);

    // Create fleet tech profile
    const { data: techProfile, error: techError } = await supabaseAdmin
      .from('fleet_techs')
      .insert({
        user_id: authUser.user.id,
        fleet_admin_id: fleetAdminId,
        first_name: firstName,
        last_name: lastName,
        email: email,
        phone: phone || null,
        employee_id: employeeId || null,
        specialties: specialties || [],
        employment_status: 'active',
        password_changed: false,
        password_reset_required: true,
        created_by_admin_id: fleetAdminId
      })
      .select()
      .single();

    if (techError) {
      // Rollback: delete the auth user
      await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      console.error('❌ Error creating tech profile:', techError);
      throw techError;
    }

    console.log('✅ Created fleet tech profile:', techProfile.id);

    res.json({
      success: true,
      techId: techProfile.id,
      userId: authUser.user.id,
      temporaryPassword: temporaryPassword,
      message: `Tech account created for ${firstName} ${lastName}`
    });

  } catch (error) {
    console.error('❌ Error creating tech with credentials:', error);
    res.status(500).json({ error: error.message || 'Failed to create tech account' });
  }
});

// Get Fleet Admin Profile
app.get('/api/fleet/admin/profile/:userId', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { userId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('fleet_admin_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) throw error;

    res.json({ profile: data });
  } catch (error) {
    console.error('❌ Error getting fleet admin profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Fleet Techs for Admin
app.get('/api/fleet/admin/:adminId/techs', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { adminId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('fleet_techs')
      .select('*')
      .eq('fleet_admin_id', adminId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ techs: data || [] });
  } catch (error) {
    console.error('❌ Error getting fleet techs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update Tech Status
app.patch('/api/fleet/techs/:techId/status', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { techId } = req.params;
    const { employment_status } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(employment_status)) {
      return res.status(400).json({ error: 'Invalid employment status' });
    }

    const { data, error } = await supabaseAdmin
      .from('fleet_techs')
      .update({ employment_status, updated_at: new Date().toISOString() })
      .eq('id', techId)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, tech: data });
  } catch (error) {
    console.error('❌ Error updating tech status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset Tech Password (Admin action)
app.post('/api/fleet/techs/:techId/reset-password', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { techId } = req.params;

    // Get tech info
    const { data: tech, error: techError } = await supabaseAdmin
      .from('fleet_techs')
      .select('user_id, first_name, last_name, email')
      .eq('id', techId)
      .single();

    if (techError) throw techError;

    // Generate new temporary password
    const newPassword = generateSecurePassword();

    // Update auth user password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      tech.user_id,
      { password: newPassword }
    );

    if (updateError) throw updateError;

    // Update tech profile
    await supabaseAdmin
      .from('fleet_techs')
      .update({
        password_changed: false,
        password_reset_required: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', techId);

    console.log('✅ Reset password for tech:', tech.email);

    res.json({
      success: true,
      temporaryPassword: newPassword,
      email: tech.email,
      message: `Password reset for ${tech.first_name} ${tech.last_name}`
    });

  } catch (error) {
    console.error('❌ Error resetting tech password:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tech Change Password (First login)
app.post('/api/fleet/techs/change-password', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { userId, newPassword } = req.body;

    if (!userId || !newPassword) {
      return res.status(400).json({ error: 'userId and newPassword are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Update auth password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { password: newPassword }
    );

    if (updateError) throw updateError;

    // Update tech profile
    const { error: techError } = await supabaseAdmin
      .from('fleet_techs')
      .update({
        password_changed: true,
        password_reset_required: false,
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (techError) throw techError;

    console.log('✅ Tech changed password:', userId);

    res.json({ success: true, message: 'Password changed successfully' });

  } catch (error) {
    console.error('❌ Error changing tech password:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create Tech Assignment
app.post('/api/fleet/assignments', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { fleetAdminId, fleetTechId, jobRequestId, assignmentType, scheduledDate, scheduledTime, adminInstructions, priority } = req.body;

    if (!fleetAdminId || !fleetTechId || !jobRequestId || !assignmentType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabaseAdmin
      .from('tech_assignments')
      .insert({
        fleet_admin_id: fleetAdminId,
        fleet_tech_id: fleetTechId,
        job_request_id: jobRequestId,
        assignment_type: assignmentType,
        status: 'assigned',
        scheduled_date: scheduledDate || null,
        scheduled_time: scheduledTime || null,
        admin_instructions: adminInstructions || null,
        priority: priority || 'normal'
      })
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Created tech assignment:', data.id);

    res.json({ success: true, assignment: data });

  } catch (error) {
    console.error('❌ Error creating assignment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Tech Assignments (for Tech)
app.get('/api/fleet/techs/:techId/assignments', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { techId } = req.params;
    const { status } = req.query;

    let query = supabaseAdmin
      .from('tech_assignments')
      .select('*, job_requests(*)')
      .eq('fleet_tech_id', techId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ assignments: data || [] });

  } catch (error) {
    console.error('❌ Error getting tech assignments:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit Tech Report
app.post('/api/fleet/reports', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const reportData = req.body;

    if (!reportData.assignment_id || !reportData.fleet_tech_id || !reportData.job_request_id || !reportData.report_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabaseAdmin
      .from('tech_reports')
      .insert(reportData)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Created tech report:', data.id);

    res.json({ success: true, report: data });

  } catch (error) {
    console.error('❌ Error creating tech report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Reports for Admin
app.get('/api/fleet/admin/:adminId/reports', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { adminId } = req.params;
    const { status } = req.query;

    // Get all techs for this admin
    const { data: techs } = await supabaseAdmin
      .from('fleet_techs')
      .select('id')
      .eq('fleet_admin_id', adminId);

    if (!techs || techs.length === 0) {
      return res.json({ reports: [] });
    }

    const techIds = techs.map(t => t.id);

    let query = supabaseAdmin
      .from('tech_reports')
      .select('*, fleet_techs(first_name, last_name), job_requests(*)')
      .in('fleet_tech_id', techIds)
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ reports: data || [] });

  } catch (error) {
    console.error('❌ Error getting admin reports:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================================================================
// END FLEET MANAGEMENT ENDPOINTS
// ================================================================

// ============================================================
// INVITATION ENDPOINTS
// ============================================================

// Get contractor invitations
app.get('/api/contractors/:contractorId/invitations', async (req, res) => {
  const { contractorId } = req.params;
  const { status } = req.query;
  
  console.log(`📧 Fetching invitations for contractor: ${contractorId}, status: ${status || 'all'}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    let query = supabaseAdmin
      .from('contractor_client_invitations')
      .select('*')
      .eq('contractor_id', contractorId)
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('❌ Error fetching invitations:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Found ${data.length} invitations`);
    res.json(data);
  } catch (error) {
    console.error('❌ Exception in invitations endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create invitation
app.post('/api/contractors/:contractorId/invitations', async (req, res) => {
  const { contractorId } = req.params;
  const { client_name, client_email, client_phone, notes, relationship_context, contractor_name } = req.body;
  
  console.log(`📝 Creating invitation for contractor: ${contractorId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (!client_email && !client_phone) {
    return res.status(400).json({ error: 'Either email or phone number is required' });
  }

  try {
    // Generate invitation code
    const { data: codeData, error: codeError } = await supabaseAdmin
      .rpc('generate_invitation_code', { p_contractor_id: contractorId });

    if (codeError) {
      console.error('❌ Error generating invitation code:', codeError);
      return res.status(500).json({ error: codeError.message });
    }

    const invitationCode = codeData;
    // Link to download page with invitation code as parameter
    // After installing the app, user can enter the code or it can be auto-filled
    const invitationUrl = `https://www.dandeeapp.com/download?invite=${invitationCode}`;

    // Create invitation record
    const { data, error } = await supabaseAdmin
      .from('contractor_client_invitations')
      .insert([{
        contractor_id: contractorId,
        client_name,
        client_email: client_email || null,
        client_phone: client_phone || null,
        invitation_code: invitationCode,
        invitation_url: invitationUrl,
        notes: notes || null,
        relationship_context: relationship_context || null,
        status: 'pending',
      }])
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating invitation:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Invitation created: ${data.id}`);

    // Send email if client has email
    if (client_email) {
      console.log(`📧 Attempting to send email to: ${client_email}`);
      
      if (!resendClient) {
        console.error('❌ Cannot send email - Resend client not initialized (RESEND_API_KEY missing)');
      } else {
        try {
          const { data: emailData, error: emailError } = await resendClient.emails.send({
            from: 'Dandee <support@dandeeapp.com>',
            to: [client_email],
            subject: `${contractor_name} invited you to join Dandee!`,
            html: `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
              </head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background-color: #f9fafb; padding: 30px; border-radius: 10px;">
                  <h2 style="color: #1f2937; margin-top: 0;">You've been invited to Dandee!</h2>
                  <p>Hi ${client_name},</p>
                  <p><strong>${contractor_name}</strong> has invited you to join Dandee, the easiest way to manage your home services.</p>
                  
                  <div style="margin: 30px 0; text-align: center;">
                    <a href="${invitationUrl}" style="background-color: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Download Dandee & Accept Invitation</a>
                  </div>
                  
                  <p style="color: #6b7280; font-size: 14px; margin-top: 20px;"><strong>Your invitation code:</strong> <span style="background-color: #e5e7eb; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${invitationCode}</span></p>
                  <p style="color: #6b7280; font-size: 14px;">After downloading the app, you can use this code to connect with ${contractor_name}.</p>
                  
                  <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">Or click this link:</p>
                  <p style="word-break: break-all;"><a href="${invitationUrl}" style="color: #4F46E5; text-decoration: underline;">${invitationUrl}</a></p>
                  
                  <p style="color: #9ca3af; font-size: 12px; margin-top: 30px;">This invitation will expire in 30 days.</p>
                </div>
              </body>
              </html>
            `,
            text: `You've been invited to Dandee!

Hi ${client_name},

${contractor_name} has invited you to join Dandee, the easiest way to manage your home services.

Download the Dandee app and accept your invitation here: ${invitationUrl}

Your invitation code: ${invitationCode}

After downloading the app, you can use this code to connect with ${contractor_name}.

This invitation will expire in 30 days.`,
          });

          if (emailError) {
            console.error('❌ Error sending email:', emailError);
          } else {
            console.log(`✅ Email sent successfully to ${client_email}`, emailData);
          }
        } catch (emailError) {
          console.error('❌ Exception sending email:', emailError);
        }
      }
    } else {
      console.log('ℹ️  No email address provided - skipping email send');
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Exception in create invitation endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel invitation
app.patch('/api/invitations/:invitationId/cancel', async (req, res) => {
  const { invitationId } = req.params;
  
  console.log(`🚫 Cancelling invitation: ${invitationId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('contractor_client_invitations')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', invitationId);

    if (error) {
      console.error('❌ Error cancelling invitation:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Invitation cancelled: ${invitationId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Exception in cancel invitation endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resend invitation
app.patch('/api/invitations/:invitationId/resend', async (req, res) => {
  const { invitationId } = req.params;
  
  console.log(`📨 Resending invitation: ${invitationId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 30);

    const { data, error } = await supabaseAdmin
      .from('contractor_client_invitations')
      .update({
        expires_at: newExpiresAt.toISOString(),
        status: 'pending',
        updated_at: new Date().toISOString()
      })
      .eq('id', invitationId)
      .select()
      .single();

    if (error) {
      console.error('❌ Error resending invitation:', error);
      return res.status(500).json({ error: error.message });
    }

    // Send email if available
    if (data.client_email && resendClient) {
      try {
        console.log(`📧 Sending resend email to: ${data.client_email}`);
        
        const { data: emailData, error: emailError } = await resendClient.emails.send({
          from: 'Dandee <support@dandeeapp.com>',
          to: [data.client_email],
          subject: `Reminder: ${data.contractor_name || 'Your contractor'} invited you to join Dandee!`,
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background-color: #f9fafb; padding: 30px; border-radius: 10px;">
                <h2 style="color: #1f2937; margin-top: 0;">Reminder: You've been invited to Dandee!</h2>
                <p>Hi ${data.client_name},</p>
                <p>This is a reminder that <strong>${data.contractor_name || 'your contractor'}</strong> has invited you to join Dandee, the easiest way to manage your home services.</p>
                
                <div style="margin: 30px 0; text-align: center;">
                  <a href="${data.invitation_url}" style="background-color: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Download Dandee & Accept Invitation</a>
                </div>
                
                <p style="color: #6b7280; font-size: 14px; margin-top: 20px;"><strong>Your invitation code:</strong> <span style="background-color: #e5e7eb; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${data.invitation_code}</span></p>
                <p style="color: #6b7280; font-size: 14px;">After downloading the app, you can use this code to connect with ${data.contractor_name || 'your contractor'}.</p>
                
                <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">Or click this link:</p>
                <p style="word-break: break-all;"><a href="${data.invitation_url}" style="color: #4F46E5; text-decoration: underline;">${data.invitation_url}</a></p>
                
                <p style="color: #9ca3af; font-size: 12px; margin-top: 30px;">This invitation will expire in 30 days.</p>
              </div>
            </body>
            </html>
          `,
          text: `Reminder: You've been invited to Dandee!

Hi ${data.client_name},

This is a reminder that ${data.contractor_name || 'your contractor'} has invited you to join Dandee, the easiest way to manage your home services.

Download the Dandee app and accept your invitation here: ${data.invitation_url}

Your invitation code: ${data.invitation_code}

After downloading the app, you can use this code to connect with ${data.contractor_name || 'your contractor'}.

This invitation will expire in 30 days.`,
        });

        if (emailError) {
          console.error('❌ Error sending resend email:', emailError);
        } else {
          console.log(`✅ Resend email sent successfully to ${data.client_email}`, emailData);
        }
      } catch (emailError) {
        console.error('❌ Exception sending resend email:', emailError);
      }
    }

    console.log(`✅ Invitation resent: ${invitationId}`);
    res.json(data);
  } catch (error) {
    console.error('❌ Exception in resend invitation endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accept an invitation (called when client signs up)
app.post('/api/invitations/:invitationCode/accept', async (req, res) => {
  const { invitationCode } = req.params;
  const { client_user_id } = req.body;

  console.log(`✅ Accepting invitation: ${invitationCode} for user: ${client_user_id}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (!client_user_id) {
    return res.status(400).json({ error: 'client_user_id is required' });
  }

  try {
    // Update invitation to accepted status
    const { data, error } = await supabaseAdmin
      .from('contractor_client_invitations')
      .update({
        status: 'accepted',
        client_user_id: client_user_id,
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('invitation_code', invitationCode)
      .eq('status', 'pending') // Only accept if still pending
      .select()
      .single();

    if (error) {
      console.error('❌ Error accepting invitation:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Invitation not found or already accepted' });
    }

    console.log(`✅ Invitation accepted: ${invitationCode}, trigger will create CRM entry`);
    res.json(data);
  } catch (error) {
    console.error('❌ Exception in accept invitation endpoint:', error);
    res.status(500).json({ error: error.message });
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
// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dandee API server running on port ${PORT}`);
  console.log(`📊 Health check: /api/health`);
  console.log(`✅ Server ready to accept connections`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
}); 