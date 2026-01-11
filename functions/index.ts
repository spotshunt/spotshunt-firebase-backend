import * as functions from 'firebase-functions';
import { firestore, pubsub } from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as geohash from 'ngeohash';
import express from 'express';
import cors from 'cors';

// Import billing API endpoints
import billingEndpoints from './api/billing.endpoints';
import webhookEndpoints from './api/webhook.endpoints';
import adminBillingEndpoints from './api/admin.billing.endpoints';
import invoiceEndpoints from './api/invoice.endpoints';
import refundEndpoints from './api/refund.endpoints';
import adminUserEndpoints from './api/admin.user.endpoints';

// Import scheduled jobs
import { processSubscriptionStateTransitions } from './jobs/stateTransitions.job';
import { processExpiredTrials, sendTrialExpirationWarnings } from './jobs/trialExpiration.job';

// Import standalone functions
import { deleteUserAuth } from './deleteUser';

// Initialize Firebase Admin
admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// ================================
// BILLING API ROUTES (PHASE 1)
// ================================

/**
 * Main API endpoint for billing operations
 * Handles all Stripe-related operations for sponsors
 */
const app = express();

// Configure CORS for development and production
const corsOptions = {
  origin: [
    'http://localhost:3000',    // Next.js website dev
    'http://localhost:3001',    // Next.js website dev alt
    'http://localhost:5173',    // Vite admin dashboard dev
    'http://localhost:5174',    // Vite admin dashboard dev alt
    'https://mysterispot-ef091.web.app',           // Firebase hosting
    'https://mysterispot-ef091.firebaseapp.com',   // Firebase hosting
    'https://spotshunt.com',                       // Production domain
    'https://www.spotshunt.com',                   // Production domain with www
    'https://admin.spotshunt.com',                 // Admin subdomain
    /\.spotshunt\.com$/,                          // Any spotshunt.com subdomain
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Configure body parsing
// Stripe webhook needs raw body for signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
// All other endpoints use JSON parsing
app.use(express.json());

// Mount billing routes
app.use('/billing', billingEndpoints);
app.use('/billing', webhookEndpoints);

// Mount admin billing routes (superadmin only)
app.use('/admin-billing', adminBillingEndpoints);

// Mount admin user management routes (admin only)
app.use('/admin', adminUserEndpoints);

// Mount invoice routes (Phase 4)
app.use('/api/invoice', invoiceEndpoints);

// Mount refund routes (Phase 4 - superadmin only)
app.use('/api/refund', refundEndpoints);

// Export the API as a Cloud Function
export const api = functions.https.onRequest(app);

// ================================
// TYPES AND INTERFACES
// ================================

interface FCMPayload {
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}

interface SendBroadcastNotificationRequest {
  notificationId: string;
  payload: FCMPayload;
}

interface SendCityNotificationRequest {
  notificationId: string;
  city: string;
  payload: FCMPayload;
}

interface SendSingleNotificationRequest {
  notificationId: string;
  targetUserId: string;
  payload: FCMPayload;
}

interface SendCustomNotificationRequest {
  notificationId: string;
  userIds: string[];
  payload: FCMPayload;
}

interface NotificationDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
  deliveredCount?: number;
  failedCount?: number;
  results?: {
    userId: string;
    success: boolean;
    error?: string;
  }[];
}

interface UserNotificationData {
  title: string;
  body: string;
  read: boolean;
  timestamp: admin.firestore.FieldValue;
  notificationId?: string;
  imageUrl?: string;
}

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Update user challenge progress for a specific activity
 * This is the server-side equivalent of the Android app's updateProgressByActivity
 */
async function updateUserChallengeProgress(userId: string, activity: string, data: Record<string, any> = {}): Promise<boolean> {
  try {
    console.log(`=== CHALLENGE PROGRESS UPDATE (SERVER) ===`);
    console.log(`Activity: ${activity}, Data: ${JSON.stringify(data)}, UserId: ${userId}`);

    // Get all active challenges for user
    const userChallengesSnapshot = await db
      .collection('user_challenges')
      .where('userId', '==', userId)
      .where('started', '==', true)
      .where('completed', '==', false)
      .get();

    console.log(`Found ${userChallengesSnapshot.docs.length} user challenge progress documents`);

    const challengeIds = userChallengesSnapshot.docs.map(doc => {
      const progress = doc.data();
      console.log(`User progress doc: ${doc.id} -> challengeId: ${progress.challengeId}, started: ${progress.started}, completed: ${progress.completed}`);
      return progress.challengeId;
    });

    console.log(`Challenge IDs to check: ${challengeIds}`);

    if (challengeIds.length === 0) {
      console.log('No active challenges found for user');
      return true;
    }

    // Get challenge details for active challenges (handle batch limits)
    const allChallenges: any[] = [];

    // Process in batches of 10 (Firestore 'in' query limit)
    for (let i = 0; i < challengeIds.length; i += 10) {
      const batch = challengeIds.slice(i, i + 10);
      const challengesSnapshot = await db
        .collection('challenges')
        .where(admin.firestore.FieldPath.documentId(), 'in', batch)
        .get();

      challengesSnapshot.docs.forEach(doc => {
        const challenge = doc.data();
        challenge.id = doc.id;
        allChallenges.push(challenge);
      });
    }

    console.log(`Found ${allChallenges.length} challenge documents`);

    const relevantChallenges = allChallenges.filter(challenge => {
      const isRelevant = isActivityRelevantToServerChallenge(activity, challenge, data);
      console.log(`Challenge ${challenge.title} (type: ${challenge.type}) relevant to ${activity}: ${isRelevant}`);
      return isRelevant;
    });

    console.log(`Relevant challenges: ${relevantChallenges.length}`);

    // Update progress for relevant challenges
    for (const challenge of relevantChallenges) {
      const progressValue = calculateServerProgressForActivity(activity, challenge, data);
      console.log(`Progress value for ${challenge.title}: ${progressValue}`);

      if (progressValue > 0) {
        const success = await updateServerChallengeProgress(userId, challenge.id, progressValue);
        console.log(`Update challenge ${challenge.title} progress: ${success}`);
      }
    }

    console.log(`=== CHALLENGE PROGRESS UPDATE COMPLETE (SERVER) ===`);
    return true;
  } catch (error: any) {
    console.error('Failed to update user challenge progress (server):', error);
    return false;
  }
}

/**
 * Check if activity is relevant to challenge (server-side)
 */
function isActivityRelevantToServerChallenge(activity: string, challenge: any, data: Record<string, any>): boolean {
  console.log(`Checking if activity '${activity}' is relevant to challenge '${challenge.title}' (type: '${challenge.type}')`);

  const isRelevant = (() => {
    switch (activity) {
      case 'SPOT_DISCOVERED':
        return challenge.type?.includes('DISCOVERY') ||
               challenge.type?.includes('EXPLORATION') ||
               challenge.type?.includes('ACHIEVEMENT') ||
               challenge.type?.includes('COLLECTION') ||
               challenge.type?.includes('STREAK');

      case 'SOCIAL_SHARE':
        return challenge.type?.includes('SOCIAL');

      case 'DAILY_LOGIN':
        return challenge.isDailyChallenge || challenge.type?.includes('STREAK');

      case 'CATEGORY_COMPLETION':
        const category = data.category;
        return category && challenge.requiredCategories?.includes(category);

      default:
        return false;
    }
  })();

  console.log(`Activity '${activity}' relevant to challenge '${challenge.title}': ${isRelevant}`);
  return isRelevant;
}

/**
 * Calculate progress value for activity (server-side)
 */
function calculateServerProgressForActivity(activity: string, challenge: any, data: Record<string, any>): number {
  // Simple implementation - could be enhanced based on challenge difficulty, etc.
  switch (activity) {
    case 'SPOT_DISCOVERED':
      return 1;
    case 'SOCIAL_SHARE':
      return 1;
    case 'DAILY_LOGIN':
      return 1;
    case 'CATEGORY_COMPLETION':
      return 1;
    default:
      return 0;
  }
}

/**
 * Update specific challenge progress (server-side)
 */
async function updateServerChallengeProgress(userId: string, challengeId: string, progress: number): Promise<boolean> {
  try {
    const progressDocId = `${userId}_${challengeId}`;

    // Get current challenge info
    const challengeDoc = await db.collection('challenges').doc(challengeId).get();
    if (!challengeDoc.exists) {
      console.error(`Challenge ${challengeId} not found`);
      return false;
    }

    const challenge = challengeDoc.data();
    if (!challenge) {
      console.error(`Challenge ${challengeId} has no data`);
      return false;
    }
    challenge.id = challengeDoc.id;

    // Get or create user progress document
    const progressRef = db.collection('user_challenges').doc(progressDocId);
    const currentProgressDoc = await progressRef.get();

    const currentProgress = currentProgressDoc.exists
      ? currentProgressDoc.data() || {}
      : {
          id: progressDocId,
          userId: userId,
          challengeId: challengeId,
          currentProgress: 0,
          targetValue: challenge.targetValue,
          started: true,
          completed: false,
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          difficulty: challenge.difficulty
        };

    // Update progress
    const newProgress = Math.min((currentProgress.currentProgress || 0) + progress, challenge.targetValue);
    const isCompleted = newProgress >= challenge.targetValue;

    const updatedProgress = {
      ...currentProgress,
      currentProgress: newProgress,
      progressPercentage: Math.min((newProgress / challenge.targetValue) * 100, 100),
      completed: isCompleted,
      lastProgressAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(isCompleted && !(currentProgress.completed) && {
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        xpEarned: challenge.xpReward
      })
    };

    await progressRef.set(updatedProgress);

    // If challenge was just completed, send completion notification and award XP
    if (isCompleted && !(currentProgress.completed)) {
      console.log(`🏆 CHALLENGE COMPLETED! Awarding ${challenge.xpReward} XP for: ${challenge.title}`);

      // Award XP to user
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const currentXp = userData?.xpPoints || userData?.xp || 0;
        const newXp = currentXp + challenge.xpReward;

        await userRef.update({
          xpPoints: newXp,
          xp: newXp,
          lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Awarded ${challenge.xpReward} XP to user ${userId} for challenge completion. New XP: ${newXp}`);
      }

      // Send challenge completion notification
      await sendChallengeCompletionNotification(userId, challenge.title, challenge.xpReward);

      // Update challenge completion stats
      await updateChallengeCompletionStats(challengeId);
    }

    console.log(`Updated challenge progress: ${challengeId}, progress: ${newProgress}/${challenge.targetValue}, completed: ${isCompleted}`);
    return true;
  } catch (error: any) {
    console.error(`Failed to update server challenge progress for ${challengeId}:`, error);
    return false;
  }
}

/**
 * Send challenge completion notification
 */
async function sendChallengeCompletionNotification(userId: string, challengeTitle: string, xpReward: number): Promise<void> {
  try {
    const payload: FCMPayload = {
      title: 'Challenge Complete! 🏆',
      body: `You completed "${challengeTitle}" and earned ${xpReward} XP!`,
      data: {
        type: 'challenge_completed',
        challengeTitle: challengeTitle,
        xpReward: xpReward.toString()
      }
    };

    // Create notification record
    const notificationRef = await db.collection('notifications').add({
      title: payload.title,
      body: payload.body,
      type: 'single',
      targetUserId: userId,
      city: null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    // Send the notification
    const result = await sendSingleNotificationInternal(notificationRef.id, userId, payload);

    // Mark as sent if successful
    if (result.success) {
      await notificationRef.update({ sent: true });
      console.log(`✓ Challenge completion notification sent successfully to user ${userId}`);
    } else {
      console.error(`✗ Challenge completion notification failed to send to user ${userId}: ${result.error}`);
      await notificationRef.update({
        sent: false,
        error: result.error
      });
    }

    console.log(`Challenge completion notification triggered for user: ${userId}, challenge: ${challengeTitle}`);
  } catch (error: any) {
    console.error('Error sending challenge completion notification:', error);
  }
}

/**
 * Update challenge completion statistics
 */
async function updateChallengeCompletionStats(challengeId: string): Promise<void> {
  try {
    console.log(`📊 UPDATING CHALLENGE COMPLETION STATS: challengeId=${challengeId}`);

    await db.collection('challenges').doc(challengeId).update({
      completionCount: admin.firestore.FieldValue.increment(1)
    });

    console.log(`📊 CHALLENGE COMPLETION STATS UPDATED: challengeId=${challengeId}`);
  } catch (error: any) {
    console.error('Failed to update challenge completion stats:', error);
  }
}

/**
 * Create user notification document
 */
async function createUserNotification(
  userId: string,
  notificationId: string,
  payload: FCMPayload
): Promise<void> {
  const userNotificationData: UserNotificationData = {
    title: payload.title,
    body: payload.body,
    read: false,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    notificationId,
    ...(payload.imageUrl && { imageUrl: payload.imageUrl })
  };

  await db
    .collection('users')
    .doc(userId)
    .collection('notifications')
    .add(userNotificationData);
}

/**
 * Send FCM message to a single token
 */
async function sendToToken(
  token: string,
  payload: FCMPayload
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`🔵 [sendToToken] CALLED with payload:`, JSON.stringify(payload));

    const message: admin.messaging.Message = {
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl && { imageUrl: payload.imageUrl })
      },
      data: payload.data || {},
      token
    };

    console.log(`🔵 [sendToToken] FCM message object:`, JSON.stringify(message));
    console.log(`🔵 [sendToToken] About to call messaging.send()...`);

    await messaging.send(message);

    console.log(`✅ [sendToToken] messaging.send() completed successfully`);
    return { success: true };
  } catch (error: any) {
    console.error(`❌ [sendToToken] Error sending to token ${token}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Send FCM messages to multiple tokens
 */
async function sendToMultipleTokens(
  tokens: string[],
  payload: FCMPayload
): Promise<{ successCount: number; failureCount: number; responses: any[] }> {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [] };
  }

  const message: admin.messaging.MulticastMessage = {
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.imageUrl && { imageUrl: payload.imageUrl })
    },
    data: payload.data || {},
    tokens
  };

  const response = await messaging.sendEachForMulticast(message);
  return response;
}

/**
 * Get active users with FCM tokens
 */
async function getActiveUsers(): Promise<{ id: string; fcmToken: string; }[]> {
  const usersQuery = await db
    .collection('users')
    .where('active', '==', true)
    .get();

  const users: { id: string; fcmToken: string; }[] = [];

  usersQuery.docs.forEach(doc => {
    const data = doc.data();
    if (data.fcmToken) {
      users.push({
        id: doc.id,
        fcmToken: data.fcmToken
      });
    }
  });

  return users;
}

/**
 * Get users by city with FCM tokens
 */
async function getUsersByCity(city: string): Promise<{ id: string; fcmToken: string; }[]> {
  const usersQuery = await db
    .collection('users')
    .where('city', '==', city)
    .where('active', '==', true)
    .get();

  const users: { id: string; fcmToken: string; }[] = [];

  usersQuery.docs.forEach(doc => {
    const data = doc.data();
    if (data.fcmToken) {
      users.push({
        id: doc.id,
        fcmToken: data.fcmToken
      });
    }
  });

  return users;
}

/**
 * Internal function to send single notification (for use within other functions)
 */
async function sendSingleNotificationInternal(
  notificationId: string,
  targetUserId: string,
  payload: FCMPayload
): Promise<NotificationDeliveryResult> {
  try {
    console.log(`🟢 [sendSingleNotificationInternal] CALLED - notificationId: ${notificationId}, userId: ${targetUserId}`);
    console.log(`🟢 [sendSingleNotificationInternal] Payload:`, JSON.stringify(payload));

    // Get the target user
    const userDoc = await db.collection('users').doc(targetUserId).get();

    if (!userDoc.exists) {
      console.log(`⚠️ [sendSingleNotificationInternal] User not found: ${targetUserId}`);
      return {
        success: false,
        error: 'User not found'
      };
    }

    const userData = userDoc.data();

    if (!userData || !userData.active) {
      console.log(`⚠️ [sendSingleNotificationInternal] User is not active: ${targetUserId}`);
      return {
        success: false,
        error: 'User is not active'
      };
    }

    if (!userData.fcmToken) {
      console.log(`⚠️ [sendSingleNotificationInternal] User has no FCM token: ${targetUserId}`);
      return {
        success: false,
        error: 'User has no FCM token'
      };
    }

    console.log(`🟢 [sendSingleNotificationInternal] Calling sendToToken...`);
    // Send FCM message
    const fcmResult = await sendToToken(userData.fcmToken, payload);
    console.log(`🟢 [sendSingleNotificationInternal] sendToToken completed:`, fcmResult);

    console.log(`🟢 [sendSingleNotificationInternal] Creating user notification document...`);
    // Create user notification document
    await createUserNotification(targetUserId, notificationId, payload);
    console.log(`🟢 [sendSingleNotificationInternal] User notification document created`);

    return {
      success: fcmResult.success,
      error: fcmResult.error,
      deliveredCount: fcmResult.success ? 1 : 0,
      failedCount: fcmResult.success ? 0 : 1
    };

  } catch (error: any) {
    console.error('❌ [sendSingleNotificationInternal] Error sending single notification:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get specific users by IDs with FCM tokens
 */
async function getUsersByIds(userIds: string[]): Promise<{ id: string; fcmToken: string; }[]> {
  const users: { id: string; fcmToken: string; }[] = [];

  // Firestore 'in' queries are limited to 10 items, so we batch them
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) {
    chunks.push(userIds.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const usersQuery = await db
      .collection('users')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .where('active', '==', true)
      .get();

    usersQuery.docs.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken) {
        users.push({
          id: doc.id,
          fcmToken: data.fcmToken
        });
      }
    });
  }

  return users;
}

// ================================
// CLOUD FUNCTIONS
// ================================

/**
 * Send broadcast notification to all users
 */
export const sendBroadcastNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<SendBroadcastNotificationRequest>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      console.log('Firebase Function received data:', JSON.stringify(data, null, 2));

      const { notificationId, payload } = data;

      console.log('Extracted notificationId:', notificationId);
      console.log('Extracted payload:', JSON.stringify(payload, null, 2));

      if (!payload) {
        return {
          success: false,
          error: 'Payload is undefined'
        };
      }

      if (!payload.title) {
        return {
          success: false,
          error: `Payload title is undefined. Payload: ${JSON.stringify(payload)}`
        };
      }

      // Get all active users with FCM tokens
      const users = await getActiveUsers();

      if (users.length === 0) {
        return {
          success: false,
          error: 'No users with FCM tokens found'
        };
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents for all users
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId,
          imageUrl: payload.imageUrl
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      return {
        success: true,
        deliveredCount: fcmResult.successCount,
        failedCount: fcmResult.failureCount
      };

    } catch (error: any) {
      console.error('Error sending broadcast notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send notification to users in a specific city
 */
export const sendCityNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<SendCityNotificationRequest>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { notificationId, city, payload } = data;

      // Get users in the specified city with FCM tokens
      const users = await getUsersByCity(city);

      if (users.length === 0) {
        return {
          success: false,
          error: `No users with FCM tokens found in ${city}`
        };
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId,
          imageUrl: payload.imageUrl
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      return {
        success: true,
        deliveredCount: fcmResult.successCount,
        failedCount: fcmResult.failureCount
      };

    } catch (error: any) {
      console.error('Error sending city notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send notification to a single user
 */
export const sendSingleNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<SendSingleNotificationRequest>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { notificationId, targetUserId, payload } = data;

      // Get the target user
      const userDoc = await db.collection('users').doc(targetUserId).get();

      if (!userDoc.exists) {
        return {
          success: false,
          error: 'User not found'
        };
      }

      const userData = userDoc.data();

      if (!userData || !userData.active) {
        return {
          success: false,
          error: 'User is not active'
        };
      }

      if (!userData.fcmToken) {
        return {
          success: false,
          error: 'User has no FCM token'
        };
      }

      // Send FCM message
      const fcmResult = await sendToToken(userData.fcmToken, payload);

      // Create user notification document
      await createUserNotification(targetUserId, notificationId, payload);

      return {
        success: fcmResult.success,
        error: fcmResult.error,
        deliveredCount: fcmResult.success ? 1 : 0,
        failedCount: fcmResult.success ? 0 : 1
      };

    } catch (error: any) {
      console.error('Error sending single notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send notification to a custom list of users
 */
export const sendCustomNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<SendCustomNotificationRequest>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { notificationId, userIds, payload } = data;

      if (!userIds || userIds.length === 0) {
        return {
          success: false,
          error: 'No user IDs provided'
        };
      }

      // Get the specified users with FCM tokens
      const users = await getUsersByIds(userIds);

      if (users.length === 0) {
        return {
          success: false,
          error: 'No users with FCM tokens found from the provided list'
        };
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId,
          imageUrl: payload.imageUrl
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      return {
        success: true,
        deliveredCount: fcmResult.successCount,
        failedCount: fcmResult.failureCount
      };

    } catch (error: any) {
      console.error('Error sending custom notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send spot approval notification to specific user and award 100 XP
 */
export const sendSpotApprovalNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ userId: string; spotTitle: string }>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { userId, spotTitle } = data;

      // Award 100 XP to the user for spot approval
      const SPOT_APPROVAL_XP = 100;

      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const currentXp = userData?.xpPoints || userData?.xp || 0;
        const newXp = currentXp + SPOT_APPROVAL_XP;

        // Update user XP (using xpPoints to match Android app)
        await userRef.update({
          xpPoints: newXp,
          xp: newXp, // Also update xp for backwards compatibility
          lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Awarded ${SPOT_APPROVAL_XP} XP to user ${userId} for spot approval. New XP: ${newXp}`);
      } else {
        console.warn(`User ${userId} not found, cannot award XP`);
      }

      // IMPORTANT: Update challenge progress for spot discovery
      // This is critical to ensure challenges complete when spots are approved
      console.log(`🎯 Updating challenge progress for user ${userId} - SPOT_DISCOVERED activity`);
      await updateUserChallengeProgress(userId, 'SPOT_DISCOVERED', {
        spotTitle: spotTitle
      });

      // Create notification record first to get the ID
      const notificationRef = await db.collection('notifications').add({
        title: 'Spot Approved! 🎉',
        body: `Your spot "${spotTitle}" has been approved! You earned ${SPOT_APPROVAL_XP} XP!`,
        type: 'single',
        targetUserId: userId,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Create payload with notificationId included
      const payload: FCMPayload = {
        title: 'Spot Approved! 🎉',
        body: `Your spot "${spotTitle}" has been approved! You earned ${SPOT_APPROVAL_XP} XP!`,
        data: {
          type: 'spot_approval',
          spotTitle,
          xpAwarded: SPOT_APPROVAL_XP.toString(),
          notificationId: notificationRef.id  // Include notification ID to prevent duplicates
        }
      };

      // Send the notification
      const result = await sendSingleNotificationInternal(notificationRef.id, userId, payload);

      // Mark as sent if successful
      if (result.success) {
        await notificationRef.update({ sent: true });
        console.log(`✓ Spot approval notification sent successfully to user ${userId}`);
      } else {
        console.error(`✗ Spot approval notification failed to send to user ${userId}: ${result.error}`);
        await notificationRef.update({
          sent: false,
          error: result.error
        });
      }

      return result;

    } catch (error: any) {
      console.error('Error sending spot approval notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send reward approval notification to specific user
 */
export const sendRewardApprovalNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ userId: string; rewardTitle: string }>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { userId, rewardTitle } = data;

      const payload: FCMPayload = {
        title: 'Reward Approved! 🎁',
        body: `Your reward redemption for "${rewardTitle}" has been approved!`,
        data: {
          type: 'reward_approval',
          rewardTitle
        }
      };

      // Create notification record
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'single',
        targetUserId: userId,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Send the notification
      const result = await sendSingleNotificationInternal(notificationRef.id, userId, payload);

      // Mark as sent if successful
      if (result.success) {
        await notificationRef.update({ sent: true });
      }

      return result;

    } catch (error: any) {
      console.error('Error sending reward approval notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Clean up invalid FCM tokens (triggered by FCM token errors)
 */
export const cleanupInvalidTokens = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ invalidTokens: string[] }>): Promise<{ success: boolean; cleanedCount: number }> => {
    const data = request.data;
    try {
      const { invalidTokens } = data;

      if (!invalidTokens || invalidTokens.length === 0) {
        return { success: true, cleanedCount: 0 };
      }

      const batch = db.batch();
      let cleanedCount = 0;

      // Find users with these invalid tokens and remove them
      for (const token of invalidTokens) {
        const usersQuery = await db
          .collection('users')
          .where('fcmToken', '==', token)
          .get();

        usersQuery.docs.forEach(doc => {
          batch.update(doc.ref, { fcmToken: admin.firestore.FieldValue.delete() });
          cleanedCount++;
        });
      }

      await batch.commit();

      return { success: true, cleanedCount };

    } catch (error: any) {
      console.error('Error cleaning up invalid tokens:', error);
      return { success: false, cleanedCount: 0 };
    }
  }
);

/**
 * Firestore trigger for reward redemption - notifies sponsor when user redeems reward
 */
export const onRewardRedeemed = firestore
  .document('users/{userId}/redemptions/{redemptionId}')
  .onCreate(async (snap, context) => {
    try {
      const redemption = snap.data();
      const userId = context.params.userId;
      const redemptionId = context.params.redemptionId;

      console.log(`Reward redemption detected: ${redemptionId} by user: ${userId}`);

      // Get user details
      const userDoc = await db.collection('users').doc(userId).get();
      const user = userDoc.data();

      if (!user) {
        console.error(`User not found: ${userId}`);
        return;
      }

      // Get sponsor ID from redemption
      const sponsorId = redemption.sponsorId;
      if (!sponsorId) {
        console.log('No sponsor ID found for redemption, skipping sponsor notification');
        return;
      }

      // Create notification for sponsor/admin
      const payload: FCMPayload = {
        title: 'New Reward Redemption! 🎁',
        body: `${user.username || user.email} redeemed "${redemption.rewardTitle}"`,
        data: {
          type: 'reward_redeemed',
          redemptionId: redemptionId,
          userId: userId,
          rewardTitle: redemption.rewardTitle
        }
      };

      // Create notification record
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'reward_redemption',
        targetSponsorId: sponsorId,
        userId: userId,
        redemptionId: redemptionId,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      console.log(`Created notification record: ${notificationRef.id} for redemption: ${redemptionId}`);

    } catch (error: any) {
      console.error('Error handling reward redemption:', error);
    }
  });

/**
 * Send spot rejection notification
 */
export const sendSpotRejectionNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ userId: string; spotTitle: string; reason?: string }>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    console.log(`🟡 [sendSpotRejectionNotification] FUNCTION CALLED - Request data:`, JSON.stringify(data));

    try {
      const { userId, spotTitle, reason } = data;

      console.log(`🟡 [sendSpotRejectionNotification] Creating notification record in database...`);
      // Create notification record first to get the ID
      const notificationRef = await db.collection('notifications').add({
        title: 'Spot Submission Declined 📍',
        body: `Your spot "${spotTitle}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
        type: 'single',
        targetUserId: userId,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Create payload with notificationId included
      const payload: FCMPayload = {
        title: 'Spot Submission Declined 📍',
        body: `Your spot "${spotTitle}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
        data: {
          type: 'spot_rejection',
          spotTitle,
          reason: reason || '',
          notificationId: notificationRef.id  // Include notification ID to prevent duplicates
        }
      };

      console.log(`🔍 DEBUG: Notification ID = ${notificationRef.id}`);
      console.log(`🔍 DEBUG: Payload data =`, JSON.stringify(payload.data));

      // Send the notification
      const result = await sendSingleNotificationInternal(notificationRef.id, userId, payload);

      // Mark as sent if successful
      if (result.success) {
        await notificationRef.update({ sent: true });
      }

      return result;

    } catch (error: any) {
      console.error('Error sending spot rejection notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send reward rejection notification
 */
export const sendRewardRejectionNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ userId: string; rewardTitle: string; reason?: string }>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { userId, rewardTitle, reason } = data;

      const payload: FCMPayload = {
        title: 'Reward Redemption Declined 🎁',
        body: `Your redemption for "${rewardTitle}" was declined.${reason ? ` Reason: ${reason}` : ''}`,
        data: {
          type: 'reward_rejection',
          rewardTitle,
          reason: reason || ''
        }
      };

      // Create notification record
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'single',
        targetUserId: userId,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Send the notification
      const result = await sendSingleNotificationInternal(notificationRef.id, userId, payload);

      // Mark as sent if successful
      if (result.success) {
        await notificationRef.update({ sent: true });
      }

      return result;

    } catch (error: any) {
      console.error('Error sending reward rejection notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send new city content notification (when new spots/rewards are added to a city)
 */
export const sendNewCityContentNotification = functions.https.onCall(
  async (request: functions.https.CallableRequest<{ city: string; contentType: 'spots' | 'rewards' | 'challenges'; count: number }>): Promise<NotificationDeliveryResult> => {
    const data = request.data;
    try {
      const { city, contentType, count } = data;

      const contentLabels = {
        spots: 'mystery spots',
        rewards: 'rewards',
        challenges: 'challenges'
      };

      const payload: FCMPayload = {
        title: `New ${contentLabels[contentType]} in ${city}! 🗺️`,
        body: `${count} new ${contentLabels[contentType]} have been added to ${city}. Check them out!`,
        data: {
          type: 'new_city_content',
          city,
          contentType,
          count: count.toString()
        }
      };

      // Create notification record
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'city',
        targetUserId: null,
        city: city,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Send to city-specific users
      const result = await sendCityNotificationInternal(notificationRef.id, city, payload);

      // Mark as sent if successful
      if (result.success) {
        await notificationRef.update({ sent: true });
      }

      return result;

    } catch (error: any) {
      console.error('Error sending new city content notification:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
);

/**
 * Send challenge reminder notifications for active challenges
 */
export const sendChallengeReminders = pubsub.schedule('0 10 * * *').onRun(async (context) => {
  try {
    console.log('Starting challenge reminder job...');

    // Get active challenges that are ending soon (within 3 days)
    const threeDaysFromNow = admin.firestore.Timestamp.fromMillis(Date.now() + (3 * 24 * 60 * 60 * 1000));

    const challengesSnapshot = await db
      .collection('challenges')
      .where('isActive', '==', true)
      .where('isTimeLimited', '==', true)
      .where('endDate', '<=', threeDaysFromNow)
      .get();

    for (const challengeDoc of challengesSnapshot.docs) {
      const challenge = challengeDoc.data();

      // Get users with active progress on this challenge
      const progressSnapshot = await db
        .collection('user_challenges')
        .where('challengeId', '==', challengeDoc.id)
        .where('started', '==', true)
        .where('completed', '==', false)
        .get();

      for (const progressDoc of progressSnapshot.docs) {
        const progress = progressDoc.data();
        const userId = progress.userId;

        const payload: FCMPayload = {
          title: 'Challenge Ending Soon! ⏰',
          body: `"${challenge.title}" ends soon. Complete it now to earn ${challenge.xpReward} XP!`,
          data: {
            type: 'challenge_reminder',
            challengeId: challengeDoc.id,
            challengeTitle: challenge.title
          }
        };

        // Send individual notification
        await sendSingleNotificationInternal(`reminder_${challengeDoc.id}_${userId}`, userId, payload);
      }
    }

    console.log(`Sent reminders for ${challengesSnapshot.size} ending challenges`);
    return null;
  } catch (error: any) {
    console.error('Error sending challenge reminders:', error);
    return null;
  }
});

// ================================
// BILLING SCHEDULED JOBS (PHASE 3)
// ================================

/**
 * Automated state transitions for subscriptions
 * Runs daily at midnight UTC to:
 * - Expire trials that have ended
 * - Expire past_due subscriptions after 3 days
 * - Expire cancelled subscriptions that reached period end
 */
export const scheduledStateTransitions = pubsub
  .schedule('0 0 * * *') // Daily at midnight UTC
  .timeZone('UTC')
  .onRun(async (context) => {
    try {
      await processSubscriptionStateTransitions();
      return null;
    } catch (error: any) {
      console.error('Scheduled state transitions failed:', error);
      return null;
    }
  });

// Helper function for city notification (needed for new city content)
async function sendCityNotificationInternal(notificationId: string, city: string, payload: FCMPayload): Promise<NotificationDeliveryResult> {
  try {
    // Get users in the specified city
    const usersQuery = db.collection('users').where('city', '==', city);
    const usersSnapshot = await usersQuery.get();

    if (usersSnapshot.empty) {
      return {
        success: false,
        error: 'No users found in specified city',
        deliveredCount: 0,
        failedCount: 0
      };
    }

    const results: { userId: string; success: boolean; error?: string }[] = [];
    let deliveredCount = 0;
    let failedCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const user = userDoc.data();
      const userId = userDoc.id;
      const fcmToken = user.fcmToken;

      try {
        // Create user notification record
        await createUserNotification(userId, notificationId, payload);

        // Send FCM if token exists
        if (fcmToken) {
          const fcmResult = await sendToToken(fcmToken, payload);
          if (fcmResult.success) {
            deliveredCount++;
            results.push({ userId, success: true });
          } else {
            failedCount++;
            results.push({ userId, success: false, error: fcmResult.error });
          }
        } else {
          // Still create notification record even if no FCM token
          deliveredCount++;
          results.push({ userId, success: true });
        }
      } catch (error: any) {
        failedCount++;
        results.push({ userId, success: false, error: error.message });
      }
    }

    return {
      success: deliveredCount > 0,
      deliveredCount,
      failedCount,
      results
    };
  } catch (error: any) {
    console.error('Error in sendCityNotificationInternal:', error);
    return {
      success: false,
      error: error.message,
      deliveredCount: 0,
      failedCount: 0
    };
  }
}

/**
 * Firestore trigger: Notify users when new rewards are added
 */
export const onNewRewardCreated = firestore
  .document('rewards/{rewardId}')
  .onCreate(async (snap, context) => {
    try {
      const reward = snap.data();
      const rewardId = context.params.rewardId;

      console.log(`New reward created: ${rewardId} - ${reward.title}`);

      // Only notify for active rewards (admin dashboard uses 'active' field)
      if (!reward.active) {
        console.log('Reward is not active, skipping notification');
        return;
      }

      const payload: FCMPayload = {
        title: 'New Reward Available! 🎁',
        body: `Check out the new reward: "${reward.title}" - ${reward.xpRequired} XP`,
        data: {
          type: 'new_reward',
          rewardId: rewardId,
          rewardTitle: reward.title,
          xpRequired: reward.xpRequired.toString()
        }
      };

      // Create notification record for tracking
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'broadcast',
        targetUserId: null,
        city: null,
        imageUrl: reward.imageUrl,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Get all active users with FCM tokens
      const users = await getActiveUsers();

      if (users.length === 0) {
        console.log('No users with FCM tokens found');
        return;
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents for all users
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId: notificationRef.id,
          imageUrl: reward.imageUrl
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      // Mark as sent
      await notificationRef.update({ sent: true });

      console.log(`New reward notification sent to ${fcmResult.successCount} users, failed: ${fcmResult.failureCount}`);
      return null;

    } catch (error: any) {
      console.error('Error sending new reward notification:', error);
      return null;
    }
  });

/**
 * Firestore trigger: Notify users when new sponsors are added
 */
export const onNewSponsorCreated = firestore
  .document('sponsors/{sponsorId}')
  .onCreate(async (snap, context) => {
    try {
      const sponsor = snap.data();
      const sponsorId = context.params.sponsorId;

      console.log(`New sponsor created: ${sponsorId} - ${sponsor.name}`);

      // Only notify for active sponsors
      if (!sponsor.active) {
        console.log('Sponsor is not active, skipping notification');
        return;
      }

      const payload: FCMPayload = {
        title: 'New Sponsor Added! 🏪',
        body: `Check out the new sponsor: "${sponsor.name}" - ${sponsor.deal}`,
        data: {
          type: 'new_sponsor',
          sponsorId: sponsorId,
          sponsorName: sponsor.name,
          deal: sponsor.deal
        }
      };

      // Create notification record for tracking
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'broadcast',
        targetUserId: null,
        city: null,
        imageUrl: sponsor.logoUrl,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Get all active users with FCM tokens
      const users = await getActiveUsers();

      if (users.length === 0) {
        console.log('No users with FCM tokens found');
        return;
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents for all users
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId: notificationRef.id,
          imageUrl: sponsor.logoUrl
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      // Mark as sent
      await notificationRef.update({ sent: true });

      console.log(`New sponsor notification sent to ${fcmResult.successCount} users, failed: ${fcmResult.failureCount}`);
      return null;

    } catch (error: any) {
      console.error('Error sending new sponsor notification:', error);
      return null;
    }
  });

/**
 * Firestore trigger: Notify users when new challenges are added
 */
export const onNewChallengeCreated = firestore
  .document('challenges/{challengeId}')
  .onCreate(async (snap, context) => {
    try {
      const challenge = snap.data();
      const challengeId = context.params.challengeId;

      console.log(`New challenge created: ${challengeId} - ${challenge.title}`);

      // Only notify for active global challenges
      if (!challenge.active || !challenge.global) {
        console.log('Challenge is not active or not global, skipping notification');
        return;
      }

      const difficultyEmojis: Record<string, string> = {
        'EASY': '🟢',
        'MEDIUM': '🟡',
        'HARD': '🔴',
        'EXPERT': '🟣'
      };

      const payload: FCMPayload = {
        title: 'New Challenge Available! 🏆',
        body: `${difficultyEmojis[challenge.difficulty] || '⭐'} "${challenge.title}" - Earn ${challenge.xpReward} XP!`,
        data: {
          type: 'new_challenge',
          challengeId: challengeId,
          challengeTitle: challenge.title,
          challengeDescription: challenge.description || '',
          xpReward: challenge.xpReward.toString(),
          difficulty: challenge.difficulty
        }
      };

      // Create notification record for tracking
      const notificationRef = await db.collection('notifications').add({
        title: payload.title,
        body: payload.body,
        type: 'broadcast',
        targetUserId: null,
        city: null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        sent: false
      });

      // Get all active users with FCM tokens
      const users = await getActiveUsers();

      if (users.length === 0) {
        console.log('No users with FCM tokens found');
        return;
      }

      // Extract tokens
      const tokens = users.map(user => user.fcmToken);

      // Send FCM messages
      const fcmResult = await sendToMultipleTokens(tokens, payload);

      // Create user notification documents for all users
      const batch = db.batch();

      users.forEach(user => {
        const userNotificationRef = db
          .collection('users')
          .doc(user.id)
          .collection('notifications')
          .doc();

        const userNotificationData: UserNotificationData = {
          title: payload.title,
          body: payload.body,
          read: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          notificationId: notificationRef.id
        };

        batch.set(userNotificationRef, userNotificationData);
      });

      await batch.commit();

      // Mark as sent
      await notificationRef.update({ sent: true });

      console.log(`New challenge notification sent to ${fcmResult.successCount} users, failed: ${fcmResult.failureCount}`);
      return null;

    } catch (error: any) {
      console.error('Error sending new challenge notification:', error);
      return null;
    }
  });

// ================================
// GEOHASH COMPUTATION FUNCTIONS
// ================================

/**
 * Automatically compute and store geohash when spots are created or updated
 */
export const onSpotWrite = firestore
  .document('spots/{spotId}')
  .onWrite(async (change, context) => {
    try {
      const spotId = context.params.spotId;

      // Skip if document was deleted
      if (!change.after.exists) {
        console.log(`Spot ${spotId} was deleted, skipping geohash computation`);
        return;
      }

      const spotData = change.after.data();

      // Check if spotData exists
      if (!spotData) {
        console.log(`Spot ${spotId} has no data, skipping geohash computation`);
        return;
      }

      // Extract location coordinates
      let latitude: number | null = null;
      let longitude: number | null = null;

      // Handle different location formats
      if (spotData.location) {
        // Handle GeoPoint format
        if (spotData.location.latitude !== undefined && spotData.location.longitude !== undefined) {
          latitude = spotData.location.latitude;
          longitude = spotData.location.longitude;
        }
        // Handle internal Firebase GeoPoint format
        else if (spotData.location._latitude !== undefined && spotData.location._longitude !== undefined) {
          latitude = spotData.location._latitude;
          longitude = spotData.location._longitude;
        }
      }
      // Fallback to separate latitude/longitude fields
      else if (spotData.latitude !== undefined && spotData.longitude !== undefined) {
        latitude = spotData.latitude;
        longitude = spotData.longitude;
      }

      // Validate coordinates
      if (latitude === null || longitude === null ||
          latitude === 0 && longitude === 0 ||
          Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        console.log(`Spot ${spotId} has invalid coordinates: lat=${latitude}, lng=${longitude}`);
        return;
      }

      // Generate geohash
      const geohashValue = geohash.encode(latitude, longitude, 12);

      // Check if geohash already exists and is correct
      if (spotData.geohash === geohashValue) {
        console.log(`Spot ${spotId} already has correct geohash: ${geohashValue}`);
        return;
      }

      // Update document with geohash
      const updateData: any = {
        geohash: geohashValue,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Also ensure standard location fields are present
      if (!spotData.latitude || !spotData.longitude) {
        updateData.latitude = latitude;
        updateData.longitude = longitude;
      }

      await change.after.ref.update(updateData);

      console.log(`Updated spot ${spotId} with geohash: ${geohashValue} (lat: ${latitude}, lng: ${longitude})`);

    } catch (error: any) {
      console.error('Error computing geohash for spot:', error);
    }
  });

/**
 * Migrate existing spots to add geohash field
 */
export const migrateSpotGeohashes = functions.https.onCall(
  async (request: functions.https.CallableRequest<{
    batchSize?: number;
    dryRun?: boolean;
    startAfter?: string
  }>): Promise<{
    success: boolean;
    processed: number;
    updated: number;
    errors: number;
    lastProcessedId?: string;
    errorDetails?: string[];
  }> => {
    const { batchSize = 100, dryRun = false, startAfter } = request.data || {};

    try {
      console.log(`Starting spot geohash migration - batch size: ${batchSize}, dry run: ${dryRun}`);

      let query = db.collection('spots').limit(batchSize);

      // Support pagination with startAfter
      if (startAfter) {
        const startAfterDoc = await db.collection('spots').doc(startAfter).get();
        if (startAfterDoc.exists) {
          query = query.startAfter(startAfterDoc);
        }
      }

      const spotsSnapshot = await query.get();

      if (spotsSnapshot.empty) {
        return {
          success: true,
          processed: 0,
          updated: 0,
          errors: 0
        };
      }

      let processed = 0;
      let updated = 0;
      let errors = 0;
      const errorDetails: string[] = [];
      let lastProcessedId: string | undefined;

      const batch = db.batch();
      let batchOperations = 0;

      for (const spotDoc of spotsSnapshot.docs) {
        try {
          processed++;
          lastProcessedId = spotDoc.id;

          const spotData = spotDoc.data();

          // Skip if geohash already exists
          if (spotData.geohash && !dryRun) {
            console.log(`Spot ${spotDoc.id} already has geohash: ${spotData.geohash}`);
            continue;
          }

          // Extract coordinates
          let latitude: number | null = null;
          let longitude: number | null = null;

          // Handle different location formats
          if (spotData.location) {
            if (spotData.location.latitude !== undefined && spotData.location.longitude !== undefined) {
              latitude = spotData.location.latitude;
              longitude = spotData.location.longitude;
            } else if (spotData.location._latitude !== undefined && spotData.location._longitude !== undefined) {
              latitude = spotData.location._latitude;
              longitude = spotData.location._longitude;
            }
          } else if (spotData.latitude !== undefined && spotData.longitude !== undefined) {
            latitude = spotData.latitude;
            longitude = spotData.longitude;
          }

          // Validate coordinates
          if (latitude === null || longitude === null ||
              latitude === 0 && longitude === 0 ||
              Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            const errorMsg = `Spot ${spotDoc.id} has invalid coordinates: lat=${latitude}, lng=${longitude}`;
            errorDetails.push(errorMsg);
            errors++;
            continue;
          }

          // Generate geohash
          const geohashValue = geohash.encode(latitude, longitude, 12);

          if (dryRun) {
            console.log(`[DRY RUN] Would update spot ${spotDoc.id} with geohash: ${geohashValue}`);
            updated++;
          } else {
            // Add to batch
            const updateData: any = {
              geohash: geohashValue,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Ensure standard location fields
            if (!spotData.latitude || !spotData.longitude) {
              updateData.latitude = latitude;
              updateData.longitude = longitude;
            }

            batch.update(spotDoc.ref, updateData);
            batchOperations++;
            updated++;

            console.log(`Added to batch - Spot ${spotDoc.id}: geohash ${geohashValue}`);
          }

        } catch (error: any) {
          errors++;
          const errorMsg = `Error processing spot ${spotDoc.id}: ${error.message}`;
          errorDetails.push(errorMsg);
          console.error(errorMsg);
        }
      }

      // Commit batch if not dry run
      if (!dryRun && batchOperations > 0) {
        await batch.commit();
        console.log(`Committed batch with ${batchOperations} operations`);
      }

      const result = {
        success: true,
        processed,
        updated,
        errors,
        lastProcessedId,
        errorDetails: errorDetails.length > 0 ? errorDetails.slice(0, 10) : undefined // Limit error details
      };

      console.log(`Migration batch completed:`, result);
      return result;

    } catch (error: any) {
      console.error('Error in spot geohash migration:', error);
      return {
        success: false,
        processed: 0,
        updated: 0,
        errors: 1,
        errorDetails: [error.message]
      };
    }
  }
);

/**
 * Migrate users to add geohash field based on their location
 */
export const migrateUserGeohashes = functions.https.onCall(
  async (request: functions.https.CallableRequest<{
    batchSize?: number;
    dryRun?: boolean;
    startAfter?: string
  }>): Promise<{
    success: boolean;
    processed: number;
    updated: number;
    errors: number;
    lastProcessedId?: string;
    errorDetails?: string[];
  }> => {
    const { batchSize = 100, dryRun = false, startAfter } = request.data || {};

    try {
      console.log(`Starting user geohash migration - batch size: ${batchSize}, dry run: ${dryRun}`);

      let query = db.collection('users').limit(batchSize);

      if (startAfter) {
        const startAfterDoc = await db.collection('users').doc(startAfter).get();
        if (startAfterDoc.exists) {
          query = query.startAfter(startAfterDoc);
        }
      }

      const usersSnapshot = await query.get();

      if (usersSnapshot.empty) {
        return {
          success: true,
          processed: 0,
          updated: 0,
          errors: 0
        };
      }

      let processed = 0;
      let updated = 0;
      let errors = 0;
      const errorDetails: string[] = [];
      let lastProcessedId: string | undefined;

      const batch = db.batch();
      let batchOperations = 0;

      for (const userDoc of usersSnapshot.docs) {
        try {
          processed++;
          lastProcessedId = userDoc.id;

          const userData = userDoc.data();

          // Skip if geohash already exists or no location
          if (userData.geohash && !dryRun) {
            continue;
          }

          // Extract coordinates
          let latitude: number | null = null;
          let longitude: number | null = null;

          if (userData.location) {
            if (userData.location.latitude !== undefined && userData.location.longitude !== undefined) {
              latitude = userData.location.latitude;
              longitude = userData.location.longitude;
            } else if (userData.location._latitude !== undefined && userData.location._longitude !== undefined) {
              latitude = userData.location._latitude;
              longitude = userData.location._longitude;
            }
          }

          // Skip users without valid location
          if (latitude === null || longitude === null ||
              Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            continue;
          }

          // Generate geohash
          const geohashValue = geohash.encode(latitude, longitude, 12);

          if (dryRun) {
            console.log(`[DRY RUN] Would update user ${userDoc.id} with geohash: ${geohashValue}`);
            updated++;
          } else {
            batch.update(userDoc.ref, {
              geohash: geohashValue,
              locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            batchOperations++;
            updated++;
          }

        } catch (error: any) {
          errors++;
          const errorMsg = `Error processing user ${userDoc.id}: ${error.message}`;
          errorDetails.push(errorMsg);
        }
      }

      // Commit batch if not dry run
      if (!dryRun && batchOperations > 0) {
        await batch.commit();
      }

      return {
        success: true,
        processed,
        updated,
        errors,
        lastProcessedId,
        errorDetails: errorDetails.length > 0 ? errorDetails.slice(0, 10) : undefined
      };

    } catch (error: any) {
      console.error('Error in user geohash migration:', error);
      return {
        success: false,
        processed: 0,
        updated: 0,
        errors: 1,
        errorDetails: [error.message]
      };
    }
  }
);

/**
 * Get spots near a location using geohash bounds
 */
export const getNearbySpots = functions.https.onCall(
  async (request: functions.https.CallableRequest<{
    latitude: number;
    longitude: number;
    radiusKm: number;
    limit?: number;
  }>): Promise<{
    success: boolean;
    spots: any[];
    count: number;
    error?: string;
  }> => {
    try {
      const { latitude, longitude, radiusKm, limit = 50 } = request.data;

      // Validate inputs
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return {
          success: false,
          spots: [],
          count: 0,
          error: 'Invalid coordinates'
        };
      }

      if (radiusKm <= 0 || radiusKm > 1000) {
        return {
          success: false,
          spots: [],
          count: 0,
          error: 'Invalid radius (must be between 0 and 1000 km)'
        };
      }

      // Generate geohash bounds for the search area
      const centerGeohash = geohash.encode(latitude, longitude, 12);

      // Calculate approximate geohash precision based on radius
      let precision = 12;
      if (radiusKm > 100) precision = 6;
      else if (radiusKm > 50) precision = 7;
      else if (radiusKm > 20) precision = 8;
      else if (radiusKm > 10) precision = 9;
      else if (radiusKm > 5) precision = 10;
      else if (radiusKm > 1) precision = 11;

      const geohashPrefix = centerGeohash.substring(0, precision);

      // Query spots with geohash prefix
      const spotsQuery = await db
        .collection('spots')
        .where('geohash', '>=', geohashPrefix)
        .where('geohash', '<', geohashPrefix + '\uf8ff')
        .where('isActive', '==', true)
        .limit(limit * 2) // Get extra to account for distance filtering
        .get();

      const nearbySpots: any[] = [];

      spotsQuery.docs.forEach(doc => {
        const spotData = doc.data();
        const spotLat = spotData.latitude || spotData.location?.latitude;
        const spotLng = spotData.longitude || spotData.location?.longitude;

        if (spotLat && spotLng) {
          // Calculate actual distance
          const distance = calculateDistance(latitude, longitude, spotLat, spotLng);

          if (distance <= radiusKm) {
            nearbySpots.push({
              id: doc.id,
              ...spotData,
              distance: Math.round(distance * 100) / 100 // Round to 2 decimal places
            });
          }
        }
      });

      // Sort by distance and limit results
      nearbySpots.sort((a, b) => a.distance - b.distance);
      const limitedSpots = nearbySpots.slice(0, limit);

      return {
        success: true,
        spots: limitedSpots,
        count: limitedSpots.length
      };

    } catch (error: any) {
      console.error('Error getting nearby spots:', error);
      return {
        success: false,
        spots: [],
        count: 0,
        error: error.message
      };
    }
  }
);

/**
 * Calculate distance between two points using Haversine formula
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Batch compute geohashes for any collection with location data
 */
export const computeCollectionGeohashes = functions.https.onCall(
  async (request: functions.https.CallableRequest<{
    collection: string;
    batchSize?: number;
    dryRun?: boolean;
    startAfter?: string;
  }>): Promise<{
    success: boolean;
    processed: number;
    updated: number;
    errors: number;
    lastProcessedId?: string;
    errorDetails?: string[];
  }> => {
    const { collection: collectionName, batchSize = 100, dryRun = false, startAfter } = request.data;

    // Validate collection name
    const allowedCollections = ['spots', 'users', 'sponsors', 'rewards', 'challenges'];
    if (!allowedCollections.includes(collectionName)) {
      return {
        success: false,
        processed: 0,
        updated: 0,
        errors: 1,
        errorDetails: [`Collection '${collectionName}' is not allowed. Allowed: ${allowedCollections.join(', ')}`]
      };
    }

    try {
      console.log(`Starting geohash computation for collection: ${collectionName}`);

      let query = db.collection(collectionName).limit(batchSize);

      if (startAfter) {
        const startAfterDoc = await db.collection(collectionName).doc(startAfter).get();
        if (startAfterDoc.exists) {
          query = query.startAfter(startAfterDoc);
        }
      }

      const snapshot = await query.get();

      if (snapshot.empty) {
        return {
          success: true,
          processed: 0,
          updated: 0,
          errors: 0
        };
      }

      let processed = 0;
      let updated = 0;
      let errors = 0;
      const errorDetails: string[] = [];
      let lastProcessedId: string | undefined;

      const batch = db.batch();
      let batchOperations = 0;

      for (const doc of snapshot.docs) {
        try {
          processed++;
          lastProcessedId = doc.id;

          const data = doc.data();

          // Skip if geohash already exists
          if (data.geohash && !dryRun) {
            continue;
          }

          // Extract coordinates based on collection type
          let latitude: number | null = null;
          let longitude: number | null = null;

          if (data.location) {
            if (data.location.latitude !== undefined && data.location.longitude !== undefined) {
              latitude = data.location.latitude;
              longitude = data.location.longitude;
            } else if (data.location._latitude !== undefined && data.location._longitude !== undefined) {
              latitude = data.location._latitude;
              longitude = data.location._longitude;
            }
          } else if (data.latitude !== undefined && data.longitude !== undefined) {
            latitude = data.latitude;
            longitude = data.longitude;
          }

          // Skip documents without valid coordinates
          if (latitude === null || longitude === null ||
              Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            continue;
          }

          // Generate geohash
          const geohashValue = geohash.encode(latitude, longitude, 12);

          if (dryRun) {
            console.log(`[DRY RUN] Would update ${doc.id} with geohash: ${geohashValue}`);
            updated++;
          } else {
            batch.update(doc.ref, {
              geohash: geohashValue,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            batchOperations++;
            updated++;
          }

        } catch (error: any) {
          errors++;
          const errorMsg = `Error processing ${doc.id}: ${error.message}`;
          errorDetails.push(errorMsg);
        }
      }

      // Commit batch if not dry run
      if (!dryRun && batchOperations > 0) {
        await batch.commit();
      }

      return {
        success: true,
        processed,
        updated,
        errors,
        lastProcessedId,
        errorDetails: errorDetails.length > 0 ? errorDetails.slice(0, 10) : undefined
      };

    } catch (error: any) {
      console.error(`Error computing geohashes for collection ${collectionName}:`, error);
      return {
        success: false,
        processed: 0,
        updated: 0,
        errors: 1,
        errorDetails: [error.message]
      };
    }
  }
);

// ================================
// RATINGS AUTO-MODERATION
// ================================

/**
 * List of profanity and inappropriate words to flag
 */
const PROFANITY_LIST = [
  'fuck', 'shit', 'damn', 'bitch', 'asshole', 'bastard', 'crap',
  'scam', 'fake', 'fraud', 'spam', 'worthless', 'terrible'
];

/**
 * Check if text contains profanity or inappropriate content
 */
function containsInappropriateContent(text: string): { flagged: boolean; reason?: string } {
  if (!text) return { flagged: false };

  const lowerText = text.toLowerCase();

  // Check for profanity
  for (const word of PROFANITY_LIST) {
    if (lowerText.includes(word)) {
      return {
        flagged: true,
        reason: `Contains inappropriate language: "${word}"`
      };
    }
  }

  // Check for repeated characters (spam indicator)
  if (/(.)\1{5,}/.test(text)) {
    return {
      flagged: true,
      reason: 'Possible spam: Repeated characters detected'
    };
  }

  // Check for excessive caps (shouting/spam)
  const capsPercentage = (text.match(/[A-Z]/g) || []).length / text.length;
  if (text.length > 20 && capsPercentage > 0.7) {
    return {
      flagged: true,
      reason: 'Possible spam: Excessive use of capital letters'
    };
  }

  // Check for URLs (potential spam)
  if (/https?:\/\/|www\./i.test(text)) {
    return {
      flagged: true,
      reason: 'Contains URLs - requires manual review'
    };
  }

  return { flagged: false };
}

/**
 * Auto-flag inappropriate spot ratings
 */
export const autoFlagSpotRating = firestore
  .document('spots/{spotId}/ratings/{userId}')
  .onWrite(async (change, context) => {
    try {
      // Skip if rating is being deleted
      if (!change.after.exists) {
        return;
      }

      const ratingData = change.after.data();
      const feedback = ratingData?.feedback;

      // Skip if no feedback or already flagged
      if (!feedback || ratingData?.flagged) {
        return;
      }

      // Check for inappropriate content
      const moderationResult = containsInappropriateContent(feedback);

      if (moderationResult.flagged) {
        await change.after.ref.update({
          flagged: true,
          flagReason: moderationResult.reason,
          flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
          autoFlagged: true
        });

        console.log(
          `Auto-flagged spot rating ${context.params.userId} for spot ${context.params.spotId}: ${moderationResult.reason}`
        );
      }
    } catch (error: any) {
      console.error('Error in autoFlagSpotRating:', error);
    }
  });

/**
 * Auto-flag inappropriate sponsor ratings
 */
export const autoFlagSponsorRating = firestore
  .document('sponsors/{sponsorId}/ratings/{userId}')
  .onWrite(async (change, context) => {
    try {
      // Skip if rating is being deleted
      if (!change.after.exists) {
        return;
      }

      const ratingData = change.after.data();
      const feedback = ratingData?.feedback;

      // Skip if no feedback or already flagged
      if (!feedback || ratingData?.flagged) {
        return;
      }

      // Check for inappropriate content
      const moderationResult = containsInappropriateContent(feedback);

      if (moderationResult.flagged) {
        await change.after.ref.update({
          flagged: true,
          flagReason: moderationResult.reason,
          flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
          autoFlagged: true
        });

        console.log(
          `Auto-flagged sponsor rating ${context.params.userId} for sponsor ${context.params.sponsorId}: ${moderationResult.reason}`
        );
      }
    } catch (error: any) {
      console.error('Error in autoFlagSponsorRating:', error);
    }
  });

// ================================
// ADMIN USER MANAGEMENT
// ================================

/**
 * Delete Firebase Auth user account (Admin only)
 * Callable function for admin dashboard
 */
export { deleteUserAuth };

// ================================
// XP & BADGE MANAGEMENT
// ================================

/**
 * Award XP to users securely with server-side validation
 * Handles cooldowns, daily limits, idempotency, and badge unlocking
 */
export { awardXP, adminGrantXP } from './xp/xpManager.function';

/**
 * Initialize badge definitions (one-time setup)
 * SUPERADMIN ONLY
 */
export { initializeBadgeDefinitions } from './admin/initBadges.function';

// ================================
// SECURE SUBSCRIPTION ENFORCEMENT
// ================================

/**
 * CRITICAL BUSINESS PROTECTION
 * Secure server-side reward creation with subscription validation
 * PREVENTS revenue loss from client-side bypass
 */
export {
  createRewardSecure,
  validateImageUploadSecure,
  getSubscriptionLimits
} from './api/rewards.secure.endpoints';

// ================================
// TRIAL EXPIRATION MANAGEMENT
// ================================

/**
 * SCHEDULED FUNCTION: Process expired trials
 * Runs daily at 02:00 UTC to check and expire trials
 * Automatically reverts expired trials to free plan
 */
export const processTrialExpirations = pubsub.schedule('0 2 * * *').onRun(async (context) => {
  try {
    console.log('🔄 Starting scheduled trial expiration job...');

    const result = await processExpiredTrials();

    console.log(`✅ Trial expiration job completed:`, {
      processed: result.processed,
      expired: result.expired,
      errors: result.errors.length
    });

    if (result.errors.length > 0) {
      console.error('❌ Errors during trial expiration:', result.errors);
    }

    return { success: true, ...result };
  } catch (error: any) {
    console.error('💥 Fatal error in trial expiration job:', error);
    return { success: false, error: error.message };
  }
});

/**
 * SCHEDULED FUNCTION: Send trial expiration warnings
 * Runs daily at 10:00 UTC to send warning emails
 * Sends notifications 3 days, 1 day, and 1 hour before expiration
 */
export const sendTrialWarnings = pubsub.schedule('0 10 * * *').onRun(async (context) => {
  try {
    console.log('📨 Starting scheduled trial warning job...');

    const result = await sendTrialExpirationWarnings();

    console.log(`✅ Trial warning job completed:`, {
      warnings3Days: result.warnings3Days,
      warnings1Day: result.warnings1Day,
      warnings1Hour: result.warnings1Hour,
      errors: result.errors.length
    });

    if (result.errors.length > 0) {
      console.error('❌ Errors during trial warnings:', result.errors);
    }

    return { success: true, ...result };
  } catch (error: any) {
    console.error('💥 Fatal error in trial warning job:', error);
    return { success: false, error: error.message };
  }
});

// ================================
// REWARD REDEMPTION SYSTEM
// ================================

/**
 * LEGACY REWARD REDEMPTION
 * Traditional approval-based redemption flow with server-side XP deduction
 *
 * Features:
 * - Server-side XP validation and deduction
 * - Atomic Firestore transactions
 * - Duplicate redemption prevention
 * - Pending approval workflow
 */
export {
  redeemRewardLegacy
} from './api/rewards.legacy.endpoints';

/**
 * QR-BASED INSTANT REDEMPTION
 * Simple QR-based redemption with no admin approval
 *
 * Features:
 * - Sponsor creates reward with unique QR code
 * - User scans QR code to redeem instantly
 * - Automatic XP deduction
 * - No approval process needed
 */
export {
  redeemByQR,
  validateQRCode,
  validateRedemption
} from './api/rewards.qr.endpoints';

/**
 * LEGACY: Complex QR-based redemption with HMAC signatures
 * (Kept for backwards compatibility)
 */
export {
  redeemRewardViaQR
} from './api/rewards.instant.endpoints';

/**
 * Sponsor QR code generation and management
 *
 * Features:
 * - Generate time-limited QR codes for sponsors
 * - Regenerate QR (invalidates old ones)
 * - Update QR settings (expiry duration)
 * - Get QR redemption statistics
 */
export {
  generateSponsorQR,
  regenerateSponsorQR,
  updateQRSettings,
  getQRStats
} from './api/sponsor.qr.endpoints';

/**
 * QR SYSTEM MIGRATION FUNCTIONS
 * Admin-only functions to migrate existing data to QR system
 *
 * Usage:
 * 1. Initialize sponsor QR secrets:
 *    firebase functions:call initializeSponsorQRSecrets
 *
 * 2. Enable QR for all rewards:
 *    firebase functions:call enableQRForAllRewards
 */
export {
  initializeSponsorQRSecrets,
  enableQRForAllRewards
} from './admin/migrateQRSystem.function';

/**
 * SPONSOR PRIORITY SYSTEM
 * Automatically calculates and updates sponsor listing priority
 *
 * Features:
 * - Auto-updates priority when subscription changes
 * - Considers plan, rating, reviews, verification
 * - Batch update function for all sponsors
 *
 * Usage:
 * - Automatic: Triggers on sponsor document changes
 * - Manual batch: firebase functions:call batchUpdateSponsorPriorities
 */
export {
  updateSponsorPriority
} from './triggers/sponsorPriority.trigger';

// ================================
// DAILY ANALYTICS AGGREGATION
// ================================

/**
 * DAILY ANALYTICS AGGREGATION
 * Real-time stats aggregation for cost-efficient analytics
 *
 * Features:
 * - Updates daily stats on each redemption (99.9% cost reduction!)
 * - Tracks hourly distribution for peak hours analysis
 * - Backfill function for historical data
 *
 * Usage:
 * - Automatic: Triggers on redemption creation
 * - Backfill: firebase functions:call backfillDailyStats --data '{"sponsorId":"xxx"}'
 */
export {
  updateDailyStatsOnRedemption,
  updateDailyStatsOnView,
  backfillDailyStats
} from './aggregation/dailyStats.trigger';

/**
 * DAILY ROLLOVER JOBS
 * Scheduled functions for daily stats management
 *
 * Features:
 * - Initialize daily stats at midnight for all Premium sponsors
 * - Archive old stats for Free/Basic sponsors (90 days)
 *
 * Schedule:
 * - Initialize: Daily at 00:05 UTC
 * - Archive: Every Sunday at 01:00 UTC
 */
export {
  initializeDailyStats,
  archiveOldStats
} from './aggregation/dailyRollover.job';

// ================================
// ADMIN BATCH OPERATIONS
// ================================

/**
 * BATCH ADMIN OPERATIONS
 * Bulk operations for system maintenance
 *
 * Features:
 * - Batch update all sponsor priorities (SUPERADMIN only)
 * - Batch expire old rewards (SUPERADMIN only)
 *
 * Usage:
 * - firebase functions:call batchUpdateSponsorPriorities
 * - firebase functions:call batchUpdateRewardStatuses
 */
export {
  batchUpdateSponsorPriorities,
  batchUpdateRewardStatuses
} from './admin/batchOperations.endpoints';

// ================================
// ACTIVE USERS TRACKING
// ================================

/**
 * ACTIVE USERS TRACKING SYSTEM
 * Real-time user activity tracking for Premium analytics
 *
 * Features:
 * - Track user activity (viewing, visiting, redeeming)
 * - 5-minute activity window
 * - Get active user counts for sponsor dashboards
 *
 * Usage:
 * - From mobile app: updateUserActivity({ sponsorId, activityType })
 * - From dashboard: getActiveUsersCount({ sponsorId })
 */
export {
  updateUserActivity,
  getActiveUsersCount
} from './tracking/activeUsers.endpoints';

/**
 * CLEANUP SCHEDULED JOBS
 * Automated data cleanup for performance
 *
 * Features:
 * - Clean up expired active user records (every 5 minutes)
 * - Clean up old rate limit records (daily)
 * - Clean up old audit logs (weekly, non-critical only)
 *
 * Schedule:
 * - Active users: Every 5 minutes
 * - Rate limits: Daily at 02:00 UTC
 * - Audit logs: Every Sunday at 03:00 UTC
 */
export {
  cleanupExpiredActiveUsers,
  cleanupOldRateLimits,
  cleanupOldAuditLogs
} from './tracking/cleanup.job';