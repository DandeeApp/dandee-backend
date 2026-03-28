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
        // Use OneSignal for push notifications (handles APNs/FCM for us)
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
          console.warn('⚠️ Push notifications will not be sent (no push service configured)');
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

// Helper function to calculate distance between two coordinates (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in miles
};

// NEW: Notify contractors within service radius about a new job request
app.post('/api/notifications/notify-all-contractors', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Supabase admin client not configured',
    });
  }

  try {
    const { jobId, title, message, category, urgency, location, customerName, latitude, longitude } = req.body || {};

    if (!jobId || !title || !message) {
      return res.status(400).json({
        error: 'Missing required fields: jobId, title, message',
      });
    }

    console.log('📢 Notifying contractors within radius about new job request:', jobId);

    // First, get the job location from the database if not provided
    let jobLat = latitude;
    let jobLon = longitude;
    
    if (!jobLat || !jobLon) {
      console.log('📍 Job coordinates not provided, fetching from database...');
      const { data: jobData, error: jobError } = await supabaseAdmin
        .from('job_requests')
        .select('latitude, longitude')
        .eq('id', jobId)
        .single();
      
      if (!jobError && jobData) {
        jobLat = jobData.latitude;
        jobLon = jobData.longitude;
        console.log(`📍 Job location: ${jobLat}, ${jobLon}`);
      }
    }

    // Fetch ALL contractors with their location and service radius
    const { data: contractors, error: fetchError } = await supabaseAdmin
      .from('contractor_profiles')
      .select('user_id, latitude, longitude, service_radius, specialties, business_name');

    if (fetchError) {
      console.error('❌ Failed to fetch contractors:', fetchError);
      return res.status(500).json({
        error: 'Failed to fetch contractors',
        details: fetchError.message,
      });
    }

    if (!contractors || contractors.length === 0) {
      console.log('ℹ️ No contractors found in database');
      return res.json({
        success: true,
        notifiedCount: 0,
        message: 'No contractors to notify',
      });
    }

    console.log(`👥 Found ${contractors.length} total contractors`);

    // Filter contractors by distance and service radius
    const eligibleContractors = [];
    
    if (jobLat && jobLon) {
      for (const contractor of contractors) {
        // Skip contractors without location or service radius
        if (!contractor.latitude || !contractor.longitude || !contractor.service_radius) {
          console.log(`⚠️ Skipping contractor ${contractor.user_id}: missing location or service_radius`);
          continue;
        }

        // Calculate distance from contractor to job
        const distance = calculateDistance(
          contractor.latitude,
          contractor.longitude,
          jobLat,
          jobLon
        );

        console.log(`📏 Contractor ${contractor.business_name || contractor.user_id}: ${distance.toFixed(1)} miles away (radius: ${contractor.service_radius} miles)`);

        // Check if job is within contractor's service radius
        if (distance <= contractor.service_radius) {
          eligibleContractors.push({
            ...contractor,
            distance: distance.toFixed(1),
          });
          console.log(`✅ Within radius - will notify`);
        } else {
          console.log(`❌ Outside radius - skipping`);
        }
      }
    } else {
      console.warn('⚠️ No job location available, notifying ALL contractors');
      // If no job location, notify all contractors (fallback)
      eligibleContractors.push(...contractors.map(c => ({ ...c, distance: 'unknown' })));
    }

    console.log(`👥 ${eligibleContractors.length} contractors within service radius`);

    console.log(`👥 ${eligibleContractors.length} contractors within service radius`);

    if (eligibleContractors.length === 0) {
      console.log('ℹ️ No contractors within service radius');
      return res.json({
        success: true,
        notifiedCount: 0,
        message: 'No contractors within service radius',
      });
    }

    // Create notification for each eligible contractor
    const notificationsToInsert = eligibleContractors.map(contractor => ({
      user_id: contractor.user_id,
      type: 'job',
      title,
      message,
      metadata: {
        jobId,
        category,
        urgency,
        location,
        customerName,
        distance: contractor.distance,
      },
      action_url: `/contractor/jobs/${jobId}`,
      read: false,
    }));

    // Bulk insert all notifications
    const { data: insertedNotifications, error: insertError } = await supabaseAdmin
      .from('notifications')
      .insert(notificationsToInsert)
      .select('user_id');

    if (insertError) {
      console.error('❌ Failed to insert notifications:', insertError);
      return res.status(500).json({
        error: 'Failed to create notifications',
        details: insertError.message,
      });
    }

    console.log(`✅ Created ${insertedNotifications?.length || 0} notifications`);

    // Attempt to send push notifications to eligible contractors via OneSignal
    let pushCount = 0;
    if (oneSignalService.isConfigured()) {
      console.log('📱 Sending OneSignal push notifications to eligible contractors...');
      
      for (const contractor of eligibleContractors) {
        try {
          const pushResult = await oneSignalService.sendToUser({
            userId: contractor.user_id,
            title,
            body: `${message} (${contractor.distance} miles away)`,
            data: {
              jobId,
              category,
              urgency,
              distance: contractor.distance,
            },
            url: `/contractor/jobs/${jobId}`,
          });

          if (pushResult.success) {
            pushCount++;
          }
        } catch (pushError) {
          console.error(`⚠️ Failed to send push to ${contractor.user_id}:`, pushError.message);
          // Continue to next contractor
        }
      }

      console.log(`📊 Sent ${pushCount}/${eligibleContractors.length} push notifications`);
    } else {
      console.warn('⚠️ OneSignal not configured, push notifications not sent');
    }

    res.json({
      success: true,
      notifiedCount: insertedNotifications?.length || 0,
      pushSent: pushCount,
      totalContractors: contractors.length,
      eligibleContractors: eligibleContractors.length,
      jobLocation: jobLat && jobLon ? { latitude: jobLat, longitude: jobLon } : null,
    });
  } catch (error) {
    console.error('❌ Unexpected error notifying contractors:', error);
    res.status(500).json({
      error: 'Unexpected error notifying contractors',
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

    // Create client entry immediately with "invited" status
    // This allows contractor to see invited clients before they accept
    try {
      const { error: clientError } = await supabaseAdmin
        .from('clients')
        .insert({
          contractor_id: contractorId,
          name: client_name,
          email: client_email || null,
          phone: client_phone || null,
          status: 'invited', // Special status for pending invitations
          source: 'invitation',
          notes: notes || 'Invited to join Dandee',
          total_jobs: 0,
          total_spent: 0,
        });

      if (clientError) {
        // Don't fail the invitation if client entry fails, just log it
        console.warn('⚠️ Warning: Could not create client entry for invitation:', clientError);
      } else {
        console.log(`✅ Client entry created for invited client: ${client_name}`);
      }
    } catch (clientError) {
      console.warn('⚠️ Warning: Exception creating client entry:', clientError);
    }


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

    console.log(`✅ Invitation accepted: ${invitationCode}`);

    // Update the client entry from "invited" to "active" and link the customer_id
    try {
      const { error: clientError } = await supabaseAdmin
        .from('clients')
        .update({
          customer_id: client_user_id,
          status: 'active',
          first_job_date: new Date().toISOString(), // Set when they join
          updated_at: new Date().toISOString()
        })
        .eq('contractor_id', data.contractor_id)
        .eq('email', data.client_email); // Match by email since we don't have invitation_id in clients table

      if (clientError) {
        console.warn('⚠️ Warning: Could not update client entry:', clientError);
      } else {
        console.log(`✅ Client entry updated to active for user: ${client_user_id}`);
      }
    } catch (clientError) {
      console.warn('⚠️ Warning: Exception updating client entry:', clientError);
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Exception in accept invitation endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Migrate existing CRM clients from crm_clients table to clients table
app.post('/api/contractors/:contractorId/migrate-crm', async (req, res) => {
  const { contractorId } = req.params;
  console.log(`🔄 Migrating CRM data for contractor: ${contractorId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    // Get all entries from crm_clients for this contractor
    const { data: crmClients, error: fetchError } = await supabaseAdmin
      .from('crm_clients')
      .select('*')
      .eq('contractor_id', contractorId);

    if (fetchError) {
      console.error('❌ Error fetching crm_clients:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    console.log(`📊 Found ${crmClients?.length || 0} crm_clients entries`);

    // Also check accepted invitations
    const { data: acceptedInvitations, error: inviteError } = await supabaseAdmin
      .from('contractor_client_invitations')
      .select('*')
      .eq('contractor_id', contractorId)
      .eq('status', 'accepted');

    if (inviteError) {
      console.error('❌ Error fetching accepted invitations:', inviteError);
    }

    console.log(`📊 Found ${acceptedInvitations?.length || 0} accepted invitations`);

    let migratedCount = 0;
    let skippedCount = 0;

    // Migrate from crm_clients
    if (crmClients && crmClients.length > 0) {
      for (const crmClient of crmClients) {
        // Check if already exists in clients table
        const { data: existingClient } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('contractor_id', crmClient.contractor_id)
          .eq('email', crmClient.email)
          .maybeSingle();

        if (existingClient) {
          console.log(`⏭️ Skipping ${crmClient.name} - already exists in clients table`);
          skippedCount++;
          continue;
        }

        // Insert into clients table
        const { error: insertError } = await supabaseAdmin
          .from('clients')
          .insert({
            contractor_id: crmClient.contractor_id,
            customer_id: crmClient.customer_id,
            name: crmClient.name,
            email: crmClient.email,
            phone: crmClient.phone,
            address: crmClient.address,
            city: crmClient.city,
            state: crmClient.state,
            zip_code: crmClient.zip_code,
            source: crmClient.source || 'invitation',
            status: crmClient.status || 'active',
            notes: crmClient.notes,
            total_jobs: 0,
            total_spent: 0,
            first_job_date: crmClient.created_at,
            created_at: crmClient.created_at,
            updated_at: crmClient.updated_at || new Date().toISOString(),
          });

        if (insertError) {
          console.error(`❌ Error migrating ${crmClient.name}:`, insertError);
        } else {
          console.log(`✅ Migrated ${crmClient.name} to clients table`);
          migratedCount++;
        }
      }
    }

    // Migrate from accepted invitations
    if (acceptedInvitations && acceptedInvitations.length > 0) {
      for (const invitation of acceptedInvitations) {
        if (!invitation.client_user_id) {
          console.log(`⏭️ Skipping invitation ${invitation.client_name} - no client_user_id`);
          skippedCount++;
          continue;
        }

        // Check if already exists in clients table
        const { data: existingClient } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('contractor_id', invitation.contractor_id)
          .eq('customer_id', invitation.client_user_id)
          .maybeSingle();

        if (existingClient) {
          console.log(`⏭️ Skipping ${invitation.client_name} - already exists in clients table`);
          skippedCount++;
          continue;
        }

        // Insert into clients table
        const { error: insertError } = await supabaseAdmin
          .from('clients')
          .insert({
            contractor_id: invitation.contractor_id,
            customer_id: invitation.client_user_id,
            name: invitation.client_name,
            email: invitation.client_email,
            phone: invitation.client_phone,
            source: 'invitation',
            status: 'active',
            notes: invitation.notes || 'Migrated from accepted invitation',
            total_jobs: 0,
            total_spent: 0,
            first_job_date: invitation.accepted_at,
            created_at: invitation.invited_at,
            updated_at: invitation.accepted_at,
          });

        if (insertError) {
          console.error(`❌ Error migrating invitation for ${invitation.client_name}:`, insertError);
        } else {
          console.log(`✅ Migrated ${invitation.client_name} from accepted invitation`);
          migratedCount++;
        }
      }
    }

    console.log(`✅ Migration complete: ${migratedCount} migrated, ${skippedCount} skipped`);
    res.json({ 
      migrated: migratedCount, 
      skipped: skippedCount,
      total: (crmClients?.length || 0) + (acceptedInvitations?.length || 0),
      crmClientsFound: crmClients?.length || 0,
      acceptedInvitationsFound: acceptedInvitations?.length || 0,
      message: `Successfully migrated ${migratedCount} clients`
    });
  } catch (error) {
    console.error('❌ Exception in migration endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Diagnostic endpoint: Check invitation status
app.get('/api/debug/invitations/:contractorId', async (req, res) => {
  const { contractorId } = req.params;
  
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const { data: invitations } = await supabaseAdmin
      .from('contractor_client_invitations')
      .select('*')
      .eq('contractor_id', contractorId);

    const { data: crmClients } = await supabaseAdmin
      .from('crm_clients')
      .select('*')
      .eq('contractor_id', contractorId);

    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('contractor_id', contractorId);

    res.json({
      invitations: {
        total: invitations?.length || 0,
        pending: invitations?.filter(i => i.status === 'pending').length || 0,
        accepted: invitations?.filter(i => i.status === 'accepted').length || 0,
        cancelled: invitations?.filter(i => i.status === 'cancelled').length || 0,
        expired: invitations?.filter(i => i.status === 'expired').length || 0,
        list: invitations || []
      },
      crmClients: {
        total: crmClients?.length || 0,
        list: crmClients || []
      },
      clients: {
        total: clients?.length || 0,
        invited: clients?.filter(c => c.status === 'invited').length || 0,
        active: clients?.filter(c => c.status === 'active').length || 0,
        list: clients || []
      }
    });
  } catch (error) {
    console.error('❌ Error in debug endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual fix: Link existing user to invitation by email
app.post('/api/invitations/link-by-email', async (req, res) => {
  const { email, contractorId } = req.body;
  
  console.log(`🔗 Manually linking user by email: ${email} to contractor: ${contractorId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (!email || !contractorId) {
    return res.status(400).json({ error: 'Email and contractorId are required' });
  }

  try {
    // 1. Find the customer_profile by looking up user_id from customer_profiles where email matches
    const { data: customerProfile, error: profileError } = await supabaseAdmin
      .from('customer_profiles')
      .select('user_id, email, first_name, last_name')
      .ilike('email', email) // Case insensitive match - but customer_profiles doesn't have email directly
      .maybeSingle();

    // If not found in customer_profiles, look for them via auth lookup
    let userId = customerProfile?.user_id;
    
    if (!userId) {
      // Try looking up by auth email - but we need to check auth.users which requires admin
      console.log(`⚠️ User not found in customer_profiles, attempting auth lookup...`);
      
      // Alternative: Check if invitation exists and use the email to find any related data
      // For now, return error
      return res.status(404).json({ error: `User not found with email ${email}. They may need to complete signup first.` });
    }

    console.log(`✅ Found user: ${userId}`);

    // 2. Find pending invitation for this email and contractor
    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('contractor_client_invitations')
      .select('*')
      .eq('contractor_id', contractorId)
      .ilike('client_email', email) // Case insensitive match
      .eq('status', 'pending')
      .order('invited_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (inviteError) {
      console.error('❌ Error finding invitation:', inviteError);
      return res.status(500).json({ error: inviteError.message });
    }

    if (!invitation) {
      return res.status(404).json({ error: 'No pending invitation found for this email and contractor' });
    }

    console.log(`✅ Found pending invitation: ${invitation.invitation_code}`);

    // 3. Accept the invitation
    const { data: updatedInvitation, error: updateError } = await supabaseAdmin
      .from('contractor_client_invitations')
      .update({
        status: 'accepted',
        client_user_id: userId,
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', invitation.id)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error accepting invitation:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    console.log(`✅ Invitation accepted: ${invitation.invitation_code}`);

    // 4. Update the client entry from "invited" to "active"
    const { data: updatedClient, error: clientError } = await supabaseAdmin
      .from('clients')
      .update({
        customer_id: userId,
        status: 'active',
        first_job_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('contractor_id', contractorId)
      .ilike('email', email)
      .select()
      .single();

    if (clientError) {
      console.warn('⚠️ Warning: Could not update client entry:', clientError);
    } else {
      console.log(`✅ Client entry updated to active: ${updatedClient.name}`);
    }

    res.json({
      success: true,
      invitation: updatedInvitation,
      client: updatedClient,
      message: `Successfully linked ${email} to contractor`
    });
  } catch (error) {
    console.error('❌ Exception in link-by-email endpoint:', error);
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

// Delete a client from CRM
app.delete('/api/contractors/:contractorId/clients/:clientId', async (req, res) => {
  const { contractorId, clientId } = req.params;
  
  console.log(`🗑️ Deleting client: ${clientId} for contractor: ${contractorId}`);

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    // Delete the client from the clients table
    const { error: deleteError } = await supabaseAdmin
      .from('clients')
      .delete()
      .eq('id', clientId)
      .eq('contractor_id', contractorId); // Ensure contractor owns this client

    if (deleteError) {
      console.error('❌ Error deleting client:', deleteError);
      return res.status(500).json({ error: deleteError.message });
    }

    console.log(`✅ Client deleted successfully: ${clientId}`);
    res.json({ success: true, message: 'Client deleted successfully' });
  } catch (error) {
    console.error('❌ Exception in delete client endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN: Re-engagement drip for unconverted contractors
// ============================================================

function buildReEngagementEmail(touch, firstName) {
  const name = firstName || 'there';
  const appUrl = 'https://dandeeapp.com';

  const headerHtml = `
    <div style="background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); padding: 36px 30px; text-align: center; border-radius: 10px 10px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">Dandee</h1>
      <p style="color: rgba(255,255,255,0.8); margin: 6px 0 0; font-size: 13px;">Built for Contractors</p>
    </div>`;

  const footerHtml = `
    <div style="background: #f9fafb; padding: 20px 30px; border-radius: 0 0 10px 10px; border-top: 1px solid #e5e7eb; text-align: center;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">Dandee &middot; <a href="mailto:support@dandeeapp.com" style="color: #6b7280; text-decoration: none;">support@dandeeapp.com</a></p>
      <p style="color: #9ca3af; font-size: 11px; margin: 8px 0 0;">You're receiving this because you created a Dandee contractor account.</p>
    </div>`;

  const ctaButton = (label) =>
    `<div style="text-align: center; margin: 32px 0;">
      <a href="${appUrl}" style="background: #4F46E5; color: white; padding: 16px 36px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px;">${label}</a>
    </div>`;

  const wrapHtml = (body) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px; background: #f3f4f6;">
  <div style="background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07);">
    ${headerHtml}
    <div style="padding: 40px 30px;">
      ${body}
    </div>
    ${footerHtml}
  </div>
</body></html>`;

  if (touch === 1) {
    return {
      subject: `Hi ${name}, your Dandee profile is almost ready`,
      html: wrapHtml(`
        <h2 style="margin: 0 0 16px; font-size: 22px;">You're almost there, ${name}</h2>
        <p style="color: #4b5563; margin: 0 0 20px;">You created your Dandee account but haven't finished setting up your contractor profile. It only takes about 3 minutes — and once you're live, homeowners in your area can start finding you.</p>
        <div style="background: #f5f3ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <p style="margin: 0 0 12px; font-weight: 600; color: #1f2937;">What you'll unlock:</p>
          <ul style="margin: 0; padding-left: 20px; color: #4b5563;">
            <li style="margin-bottom: 8px;">Get matched with homeowners near you automatically</li>
            <li style="margin-bottom: 8px;">Send professional quotes and invoices in seconds</li>
            <li style="margin-bottom: 8px;">Get paid directly through the app</li>
            <li>30-day free trial &mdash; no credit card needed to start</li>
          </ul>
        </div>
        ${ctaButton('Complete My Profile &rarr;')}
        <p style="color: #6b7280; font-size: 14px; margin: 0;">Questions? Just reply to this email.</p>`),
      text: `Hi ${name},\n\nYou created your Dandee account but haven't finished your contractor profile. It only takes about 3 minutes.\n\nComplete your profile: ${appUrl}\n\nWhat you'll unlock:\n- Get matched with homeowners near you automatically\n- Send professional quotes and invoices in seconds\n- Get paid directly through the app\n- 30-day free trial, no credit card needed\n\nQuestions? Reply to this email.\n\nThanks,\nThe Dandee Team`,
    };
  }

  if (touch === 2) {
    return {
      subject: 'Contractors near you are winning jobs on Dandee',
      html: wrapHtml(`
        <h2 style="margin: 0 0 16px; font-size: 22px;">Don't let others take your jobs, ${name}</h2>
        <p style="color: #4b5563; margin: 0 0 20px;">Contractors in your area are already getting matched with homeowners on Dandee. Your profile isn't live yet — which means those jobs are going to someone else.</p>
        <div style="border-left: 4px solid #4F46E5; padding: 16px 20px; background: #f5f3ff; border-radius: 0 8px 8px 0; margin: 24px 0;">
          <p style="margin: 0; color: #4b5563; font-style: italic;">"I booked 3 new clients in my first week. The job matching only shows me work I actually want — no more wasted bids."</p>
          <p style="margin: 10px 0 0; color: #6b7280; font-size: 13px; font-weight: 600;">&mdash; Dandee contractor</p>
        </div>
        <p style="color: #4b5563;">Finish your profile in 3 minutes. Your first 30 days are completely free &mdash; no credit card required.</p>
        ${ctaButton('Finish My Profile &rarr;')}
        <p style="color: #6b7280; font-size: 14px; margin: 0;">Need help? Reply to this email and we'll walk you through it.</p>`),
      text: `Hi ${name},\n\nContractors in your area are already getting matched with homeowners on Dandee. Your profile isn't live yet — those jobs are going to someone else.\n\nFinish your profile: ${appUrl}\n\nYour first 30 days are completely free, no credit card required.\n\nNeed help? Reply to this email.\n\nThanks,\nThe Dandee Team`,
    };
  }

  // touch === 3
  return {
    subject: `${name}, your 30-day free trial is still here`,
    html: wrapHtml(`
      <h2 style="margin: 0 0 16px; font-size: 22px;">Your free trial is still waiting, ${name}</h2>
      <p style="color: #4b5563; margin: 0 0 20px;">We want to make sure you don't miss out. Your Dandee contractor account is ready — we just need a few more details to get your profile live.</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 8px; font-weight: 600; color: #166534;">Your free trial includes:</p>
        <ul style="margin: 0; padding-left: 20px; color: #15803d;">
          <li style="margin-bottom: 6px;">Unlimited job matches for 30 days</li>
          <li style="margin-bottom: 6px;">White-label quotes &amp; invoices</li>
          <li style="margin-bottom: 6px;">Built-in payment processing</li>
          <li>CRM, calendar sync, and analytics</li>
        </ul>
        <p style="margin: 12px 0 0; color: #166534; font-size: 13px; font-weight: 600;">After 30 days: $29.99/month. Cancel anytime.</p>
      </div>
      ${ctaButton('Start My Free Trial &rarr;')}
      <p style="color: #6b7280; font-size: 14px; margin: 0;">This is our last reminder. If now isn't the right time, no worries — your account will be here when you're ready.</p>`),
    text: `Hi ${name},\n\nYour Dandee free trial is still waiting. We just need a few more details to get your profile live.\n\nYour free trial includes:\n- Unlimited job matches for 30 days\n- White-label quotes & invoices\n- Built-in payment processing\n- CRM, calendar sync, and analytics\n\nAfter 30 days: $29.99/month. Cancel anytime.\n\nStart your free trial: ${appUrl}\n\nThanks,\nThe Dandee Team`,
  };
}

// GET /api/admin/contractors/unconverted
// Returns all contractors who signed up but haven't completed onboarding
app.get('/api/admin/contractors/unconverted', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase admin client not configured' });
  }

  try {
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });

    if (error) {
      console.error('❌ Error listing users:', error);
      return res.status(500).json({ error: error.message });
    }

    const unconverted = users.filter(
      (u) =>
        u.user_metadata?.user_type === 'contractor' &&
        u.user_metadata?.onboarding_completed !== true &&
        u.user_metadata?.onboarding_completed !== 'true'
    );

    const userIds = unconverted.map((u) => u.id);

    let profileMap = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('contractor_profiles')
        .select('user_id, first_name, last_name, business_name, business_email, created_at')
        .in('user_id', userIds);
      (profiles || []).forEach((p) => (profileMap[p.user_id] = p));
    }

    const now = Date.now();
    const result = unconverted.map((u) => {
      const profile = profileMap[u.id] || {};
      const daysSinceSignup = Math.floor((now - new Date(u.created_at).getTime()) / (1000 * 60 * 60 * 24));
      return {
        id: u.id,
        email: u.email,
        first_name: profile.first_name || u.user_metadata?.name || null,
        business_name: profile.business_name || null,
        business_email: profile.business_email || null,
        signed_up_at: u.created_at,
        days_since_signup: daysSinceSignup,
        has_partial_profile: !!profileMap[u.id],
      };
    });

    result.sort((a, b) => a.days_since_signup - b.days_since_signup);

    res.json({ count: result.length, contractors: result });
  } catch (error) {
    console.error('❌ Exception in unconverted contractors endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/re-engagement/run
// Sends re-engagement emails + push notifications to unconverted contractors.
// Selects the right touch (1, 2, or 3) based on days since signup.
// Skips anyone already contacted in the last 3 days for that touch.
// Pass { dryRun: true } to preview without sending.
// Pass { userId: '...' } to target a single contractor for testing.
app.post('/api/admin/re-engagement/run', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase admin client not configured' });
  }

  const { dryRun = false, userId: targetUserId } = req.body || {};

  try {
    // 1. Get all contractor users
    const { data: { users }, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (usersError) return res.status(500).json({ error: usersError.message });

    let candidates = users.filter(
      (u) =>
        u.user_metadata?.user_type === 'contractor' &&
        u.user_metadata?.onboarding_completed !== true &&
        u.user_metadata?.onboarding_completed !== 'true'
    );

    if (targetUserId) {
      candidates = candidates.filter((u) => u.id === targetUserId);
    }

    if (candidates.length === 0) {
      return res.json({ sent: 0, skipped: 0, message: 'No unconverted contractors found.' });
    }

    // 2. Get partial profiles for names / business emails
    const candidateIds = candidates.map((u) => u.id);
    const { data: profiles } = await supabaseAdmin
      .from('contractor_profiles')
      .select('user_id, first_name, business_email')
      .in('user_id', candidateIds);
    const profileMap = {};
    (profiles || []).forEach((p) => (profileMap[p.user_id] = p));

    // 3. Check which re-engagement notifications have already been sent
    const { data: sentNotifs } = await supabaseAdmin
      .from('notifications')
      .select('user_id, metadata, created_at')
      .in('user_id', candidateIds)
      .eq('type', 'system')
      .filter('metadata->>re_engagement', 'eq', 'true');

    // Build a set: `${userId}:${touch}` for quick lookup
    const alreadySent = new Set();
    (sentNotifs || []).forEach((n) => {
      const touch = n.metadata?.touch;
      const sentAt = new Date(n.created_at).getTime();
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      if (touch && sentAt > threeDaysAgo) {
        alreadySent.add(`${n.user_id}:${touch}`);
      }
    });

    const now = Date.now();
    const results = { sent: 0, skipped: 0, dryRun, details: [] };

    for (const user of candidates) {
      const profile = profileMap[user.id] || {};
      const daysSinceSignup = Math.floor((now - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));

      // Determine which touch to send
      let touch = null;
      if (daysSinceSignup >= 1 && daysSinceSignup <= 2) touch = 1;
      else if (daysSinceSignup >= 3 && daysSinceSignup <= 6) touch = 2;
      else if (daysSinceSignup >= 7 && daysSinceSignup <= 30) touch = 3;

      if (!touch) {
        results.skipped++;
        results.details.push({ userId: user.id, reason: `days_since_signup=${daysSinceSignup} outside drip window` });
        continue;
      }

      if (alreadySent.has(`${user.id}:${touch}`)) {
        results.skipped++;
        results.details.push({ userId: user.id, reason: `touch ${touch} already sent within 3 days` });
        continue;
      }

      const emailAddress = profile.business_email || user.email;
      const firstName = profile.first_name || user.user_metadata?.name || null;
      const template = buildReEngagementEmail(touch, firstName);

      if (dryRun) {
        results.sent++;
        results.details.push({
          userId: user.id,
          email: emailAddress,
          touch,
          subject: template.subject,
          daysSinceSignup,
          dryRun: true,
        });
        continue;
      }

      // 4a. Send email via Resend
      let emailSent = false;
      if (resendClient && emailAddress) {
        try {
          const { error: emailError } = await resendClient.emails.send({
            from: 'Dandee <support@dandeeapp.com>',
            to: [emailAddress],
            subject: template.subject,
            html: template.html,
            text: template.text,
          });
          if (emailError) {
            console.error(`❌ Re-engagement email failed for ${user.id}:`, emailError);
          } else {
            emailSent = true;
            console.log(`📧 Re-engagement touch ${touch} email sent to ${emailAddress}`);
          }
        } catch (e) {
          console.error(`❌ Exception sending re-engagement email for ${user.id}:`, e.message);
        }
      }

      // 4b. Send push notification via OneSignal
      let pushSent = false;
      const pushMessages = {
        1: { title: 'Your profile is almost ready', body: 'Finish setup and start getting matched with homeowners near you.' },
        2: { title: 'Jobs are waiting for you', body: 'Contractors near you are booking jobs on Dandee. Finish your profile today.' },
        3: { title: 'Your free trial is still here', body: 'Complete your profile and start your 30-day free trial — no credit card needed.' },
      };
      if (oneSignalService.isConfigured()) {
        const pushMsg = pushMessages[touch];
        const pushResult = await oneSignalService.sendToUser({
          userId: user.id,
          title: pushMsg.title,
          body: pushMsg.body,
          data: { re_engagement: true, touch },
          url: '/onboarding',
        });
        pushSent = pushResult.success;
        if (!pushResult.success) {
          console.warn(`⚠️  Push failed for ${user.id}:`, pushResult.error);
        }
      }

      // 4c. Log to notifications table so we don't double-send
      if (emailSent || pushSent) {
        await supabaseAdmin.from('notifications').insert({
          user_id: user.id,
          type: 'system',
          title: `Re-engagement touch ${touch}`,
          message: template.subject,
          metadata: { re_engagement: 'true', touch, email_sent: emailSent, push_sent: pushSent },
        });

        results.sent++;
        results.details.push({
          userId: user.id,
          email: emailAddress,
          touch,
          subject: template.subject,
          daysSinceSignup,
          emailSent,
          pushSent,
        });
      } else {
        results.skipped++;
        results.details.push({ userId: user.id, reason: 'email and push both unavailable or failed' });
      }
    }

    console.log(`✅ Re-engagement run complete: ${results.sent} sent, ${results.skipped} skipped`);
    res.json(results);
  } catch (error) {
    console.error('❌ Exception in re-engagement run:', error);
    res.status(500).json({ error: error.message });
  }
});

// Daily cron: automatically run the re-engagement drip
// Fires once per day. Safe to call multiple times — throttling prevents double-sends.
const RE_ENGAGEMENT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runDailyReEngagement() {
  if (!supabaseAdmin || !resendClient) {
    console.log('⏭️  Re-engagement cron: skipping — Supabase or Resend not configured');
    return;
  }
  console.log('⏰ Re-engagement cron: running daily drip...');
  try {
    // Reuse the run logic by making an internal call
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (error) { console.error('❌ Re-engagement cron: failed to list users:', error); return; }

    const unconverted = users.filter(
      (u) =>
        u.user_metadata?.user_type === 'contractor' &&
        u.user_metadata?.onboarding_completed !== true &&
        u.user_metadata?.onboarding_completed !== 'true'
    );

    if (unconverted.length === 0) {
      console.log('✅ Re-engagement cron: no unconverted contractors');
      return;
    }

    const candidateIds = unconverted.map((u) => u.id);
    const { data: profiles } = await supabaseAdmin
      .from('contractor_profiles')
      .select('user_id, first_name, business_email')
      .in('user_id', candidateIds);
    const profileMap = {};
    (profiles || []).forEach((p) => (profileMap[p.user_id] = p));

    const { data: sentNotifs } = await supabaseAdmin
      .from('notifications')
      .select('user_id, metadata, created_at')
      .in('user_id', candidateIds)
      .eq('type', 'system')
      .filter('metadata->>re_engagement', 'eq', 'true');

    const alreadySent = new Set();
    (sentNotifs || []).forEach((n) => {
      const touch = n.metadata?.touch;
      const sentAt = new Date(n.created_at).getTime();
      if (touch && sentAt > Date.now() - 3 * 24 * 60 * 60 * 1000) {
        alreadySent.add(`${n.user_id}:${touch}`);
      }
    });

    const pushMessages = {
      1: { title: 'Your profile is almost ready', body: 'Finish setup and start getting matched with homeowners near you.' },
      2: { title: 'Jobs are waiting for you', body: 'Contractors near you are booking jobs on Dandee. Finish your profile today.' },
      3: { title: 'Your free trial is still here', body: 'Complete your profile and start your 30-day free trial — no credit card needed.' },
    };

    let sent = 0;
    let skipped = 0;
    const now = Date.now();

    for (const user of unconverted) {
      const profile = profileMap[user.id] || {};
      const daysSinceSignup = Math.floor((now - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));

      let touch = null;
      if (daysSinceSignup >= 1 && daysSinceSignup <= 2) touch = 1;
      else if (daysSinceSignup >= 3 && daysSinceSignup <= 6) touch = 2;
      else if (daysSinceSignup >= 7 && daysSinceSignup <= 30) touch = 3;

      if (!touch || alreadySent.has(`${user.id}:${touch}`)) { skipped++; continue; }

      const emailAddress = profile.business_email || user.email;
      const template = buildReEngagementEmail(touch, profile.first_name || user.user_metadata?.name);

      let emailSent = false;
      if (resendClient && emailAddress) {
        try {
          const { error: emailError } = await resendClient.emails.send({
            from: 'Dandee <support@dandeeapp.com>',
            to: [emailAddress],
            subject: template.subject,
            html: template.html,
            text: template.text,
          });
          if (!emailError) emailSent = true;
        } catch (e) {
          console.error(`❌ Cron email error for ${user.id}:`, e.message);
        }
      }

      let pushSent = false;
      if (oneSignalService.isConfigured() && pushMessages[touch]) {
        const p = pushMessages[touch];
        const r = await oneSignalService.sendToUser({ userId: user.id, title: p.title, body: p.body, data: { re_engagement: true, touch }, url: '/onboarding' });
        pushSent = r.success;
      }

      if (emailSent || pushSent) {
        await supabaseAdmin.from('notifications').insert({
          user_id: user.id,
          type: 'system',
          title: `Re-engagement touch ${touch}`,
          message: template.subject,
          metadata: { re_engagement: 'true', touch, email_sent: emailSent, push_sent: pushSent },
        });
        sent++;
      } else {
        skipped++;
      }
    }

    console.log(`✅ Re-engagement cron complete: ${sent} sent, ${skipped} skipped`);
  } catch (err) {
    console.error('❌ Re-engagement cron error:', err);
  }
}

// Start the daily cron — first run after 1 minute, then every 24 hours
setTimeout(() => {
  runDailyReEngagement();
  setInterval(runDailyReEngagement, RE_ENGAGEMENT_INTERVAL_MS);
}, 60 * 1000);

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