const apn = require('node-apn');
const admin = require('firebase-admin');

/**
 * Push Notification Service
 * Handles sending push notifications to iOS (APNs) and Android (FCM)
 */

class PushNotificationService {
  constructor() {
    this.apnProvider = null;
    this.fcmInitialized = false;
    this.initialized = false;
  }

  /**
   * Initialize push notification services
   * Call this on server startup with proper credentials
   */
  initialize(config = {}) {
    console.log('📱 Initializing push notification service...');

    // Initialize APNs (Apple Push Notifications)
    if (config.apns) {
      try {
        const apnsConfig = {
          token: {
            key: config.apns.key, // Path to .p8 file or key string
            keyId: config.apns.keyId,
            teamId: config.apns.teamId,
          },
          production: config.apns.production !== false, // Default to production
        };

        this.apnProvider = new apn.Provider(apnsConfig);
        console.log('✅ APNs provider initialized');
      } catch (error) {
        console.error('❌ Failed to initialize APNs:', error.message);
      }
    } else {
      console.warn('⚠️ APNs not configured - iOS push notifications will not work');
    }

    // Initialize FCM (Firebase Cloud Messaging for Android)
    if (config.fcm && config.fcm.serviceAccountKey) {
      try {
        admin.initializeApp({
          credential: admin.credential.cert(config.fcm.serviceAccountKey),
        });
        this.fcmInitialized = true;
        console.log('✅ FCM (Firebase) initialized');
      } catch (error) {
        console.error('❌ Failed to initialize FCM:', error.message);
      }
    } else {
      console.warn('⚠️ FCM not configured - Android push notifications will not work');
    }

    this.initialized = true;
    return this;
  }

  /**
   * Send push notification to a user
   * @param {Object} params - Notification parameters
   * @param {string} params.deviceToken - Device push token
   * @param {string} params.platform - 'ios' or 'android'
   * @param {string} params.title - Notification title
   * @param {string} params.body - Notification body
   * @param {Object} params.data - Additional data payload
   * @param {string} params.sound - Sound to play (default: 'default')
   * @param {number} params.badge - Badge count for iOS
   */
  async sendPushNotification(params) {
    const { deviceToken, platform, title, body, data = {}, sound = 'default', badge } = params;

    if (!deviceToken) {
      console.error('❌ No device token provided');
      return { success: false, error: 'No device token' };
    }

    if (!title || !body) {
      console.error('❌ Title and body are required');
      return { success: false, error: 'Title and body required' };
    }

    try {
      if (platform === 'ios') {
        return await this.sendApplePush(deviceToken, title, body, data, sound, badge);
      } else if (platform === 'android') {
        return await this.sendAndroidPush(deviceToken, title, body, data, sound);
      } else {
        console.error('❌ Invalid platform:', platform);
        return { success: false, error: 'Invalid platform' };
      }
    } catch (error) {
      console.error('❌ Error sending push notification:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push to iOS device via APNs
   */
  async sendApplePush(deviceToken, title, body, data, sound, badge) {
    if (!this.apnProvider) {
      console.warn('⚠️ APNs not configured, skipping iOS push');
      return { success: false, error: 'APNs not configured' };
    }

    try {
      const notification = new apn.Notification();
      notification.expiry = Math.floor(Date.now() / 1000) + 3600; // Expires in 1 hour
      notification.badge = badge || 1;
      notification.sound = sound;
      notification.alert = {
        title,
        body,
      };
      notification.payload = data;
      notification.topic = 'com.dandee.homeops.app'; // Your iOS bundle ID

      const result = await this.apnProvider.send(notification, deviceToken);

      if (result.failed && result.failed.length > 0) {
        console.error('❌ APNs failed:', result.failed[0].response);
        return { success: false, error: result.failed[0].response.reason };
      }

      console.log('✅ APNs push sent successfully');
      return { success: true, sent: result.sent.length };
    } catch (error) {
      console.error('❌ APNs error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push to Android device via FCM
   */
  async sendAndroidPush(deviceToken, title, body, data, sound) {
    if (!this.fcmInitialized) {
      console.warn('⚠️ FCM not configured, skipping Android push');
      return { success: false, error: 'FCM not configured' };
    }

    try {
      const message = {
        notification: {
          title,
          body,
        },
        data,
        android: {
          notification: {
            sound: sound || 'default',
            channelId: 'dandee_notifications',
          },
          priority: 'high',
        },
        token: deviceToken,
      };

      const response = await admin.messaging().send(message);
      console.log('✅ FCM push sent successfully:', response);
      return { success: true, messageId: response };
    } catch (error) {
      console.error('❌ FCM error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push to multiple users
   * @param {Array} tokens - Array of {deviceToken, platform}
   * @param {Object} notification - {title, body, data, sound, badge}
   */
  async sendBulkPush(tokens, notification) {
    const results = await Promise.allSettled(
      tokens.map(({ deviceToken, platform }) =>
        this.sendPushNotification({
          deviceToken,
          platform,
          ...notification,
        })
      )
    );

    const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - successful;

    console.log(`📊 Bulk push results: ${successful} sent, ${failed} failed`);
    return { successful, failed, total: results.length };
  }

  /**
   * Shutdown push services
   */
  async shutdown() {
    if (this.apnProvider) {
      await this.apnProvider.shutdown();
      console.log('📱 APNs provider shutdown');
    }
  }
}

// Export singleton instance
const pushService = new PushNotificationService();
module.exports = pushService;
