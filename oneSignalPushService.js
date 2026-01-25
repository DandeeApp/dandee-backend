// OneSignal Push Notification Service for Backend
// Replace Firebase with OneSignal API

const fetch = require('node-fetch');

class OneSignalPushService {
  constructor() {
    // Get from https://app.onesignal.com/ → Settings → Keys & IDs
    this.appId = process.env.ONESIGNAL_APP_ID || '6223290e-02a1-47f3-87e8-8df1d5442ca1';
    this.restApiKey = process.env.ONESIGNAL_REST_API_KEY; // You need to add this
    this.apiUrl = 'https://onesignal.com/api/v1';
  }

  /**
   * Send push notification via OneSignal
   * @param {Object} params - Notification parameters
   * @param {string} params.userId - User's external ID (set in app via oneSignalService.initialize)
   * @param {string} params.title - Notification title
   * @param {string} params.body - Notification message
   * @param {Object} params.data - Additional data payload
   * @param {string} params.url - Deep link URL
   */
  async sendToUser(params) {
    const { userId, title, body, data = {}, url } = params;

    if (!this.restApiKey) {
      console.error('❌ OneSignal REST API Key not configured');
      return { success: false, error: 'OneSignal not configured' };
    }

    if (!userId) {
      console.error('❌ No userId provided');
      return { success: false, error: 'No userId' };
    }

    if (!title || !body) {
      console.error('❌ Title and body are required');
      return { success: false, error: 'Title and body required' };
    }

    try {
      const payload = {
        app_id: this.appId,
        // Target user by external ID (set in app via oneSignalService.initialize(userId))
        include_external_user_ids: [userId],
        headings: { en: title },
        contents: { en: body },
        data: data || {},
      };

      // Add deep link URL if provided
      if (url) {
        payload.url = url;
        payload.web_url = url;
        payload.app_url = url;
      }

      console.log(`📱 Sending OneSignal notification to user: ${userId}`);
      
      const response = await fetch(`${this.apiUrl}/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${this.restApiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('❌ OneSignal API error:', result);
        return { 
          success: false, 
          error: result.errors?.[0] || 'OneSignal API error',
          details: result 
        };
      }

      console.log(`✅ OneSignal notification sent: ${result.id}`);
      return { 
        success: true, 
        id: result.id,
        recipients: result.recipients || 0 
      };
    } catch (error) {
      console.error('❌ Error sending OneSignal notification:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send to multiple users at once
   */
  async sendToUsers(params) {
    const { userIds, title, body, data = {}, url } = params;

    if (!this.restApiKey) {
      console.error('❌ OneSignal REST API Key not configured');
      return { success: false, error: 'OneSignal not configured' };
    }

    if (!userIds || userIds.length === 0) {
      console.error('❌ No userIds provided');
      return { success: false, error: 'No userIds' };
    }

    try {
      const payload = {
        app_id: this.appId,
        include_external_user_ids: userIds,
        headings: { en: title },
        contents: { en: body },
        data: data || {},
      };

      if (url) {
        payload.url = url;
        payload.web_url = url;
        payload.app_url = url;
      }

      console.log(`📱 Sending OneSignal notification to ${userIds.length} users`);
      
      const response = await fetch(`${this.apiUrl}/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${this.restApiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('❌ OneSignal API error:', result);
        return { success: false, error: result.errors?.[0] || 'OneSignal API error' };
      }

      console.log(`✅ OneSignal bulk notification sent: ${result.id}`);
      return { 
        success: true, 
        id: result.id,
        recipients: result.recipients || 0 
      };
    } catch (error) {
      console.error('❌ Error sending OneSignal bulk notification:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return !!this.restApiKey;
  }
}

// Export singleton instance
module.exports = new OneSignalPushService();
