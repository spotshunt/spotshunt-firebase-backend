const functions = require('firebase-functions');
const { firestore, pubsub } = require('firebase-functions/v1');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const geohash = require('ngeohash');
const express = require('express');
const cors = require('cors');

// Import social functions
const socialFunctions = require("./social");

// Import migration function
const { migrateSponsorCategories } = require("./migrateSponsorCategories");

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
    'http://localhost:5175',    // Vite admin dashboard dev alt 2
    'http://localhost:5176',    // Vite sponsor dashboard dev
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
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ================================
// BILLING ROUTES
// ================================

// Helper function to verify Firebase ID token
async function verifyAuthToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No valid authentication token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth verification failed:', error);
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

// Get subscription status for a sponsor
app.post('/billing/get-subscription-status', verifyAuthToken, async (req, res) => {
  try {
    const { sponsorId } = req.body;

    if (!sponsorId) {
      return res.status(400).json({ error: 'sponsorId is required' });
    }

    // Get sponsor document to check subscription
    const sponsorDoc = await db.collection('sponsors').doc(sponsorId).get();

    if (!sponsorDoc.exists) {
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    const sponsorData = sponsorDoc.data();

    // For now, return a basic response structure
    // This can be enhanced with actual Stripe integration later
    const subscriptionStatus = {
      plan: sponsorData.subscriptionPlan || 'free',
      status: sponsorData.subscriptionStatus || 'inactive',
      renewalDate: sponsorData.subscriptionRenewalDate || null,
      trialEndsAt: sponsorData.trialEndsAt || null,
      hasUsedTrial: sponsorData.hasUsedTrial || false,
      features: getFeaturesByPlan(sponsorData.subscriptionPlan || 'free'),
      canUpgrade: true,
      canDowngrade: (sponsorData.subscriptionPlan || 'free') !== 'free'
    };

    res.json(subscriptionStatus);
  } catch (error) {
    console.error('Get subscription status failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to get features by plan
function getFeaturesByPlan(plan) {
  const features = {
    free: ['basic_analytics', 'limited_rewards'],
    trial: ['basic_analytics', '1_reward', 'email_support'],
    basic: ['basic_analytics', '1_reward', 'email_support'],
    pro: ['detailed_analytics', '3_rewards', 'priority_listing', 'custom_branding', 'priority_support'],
    premium: ['full_analytics', 'unlimited_rewards', 'top_featured', '24_7_support', 'advanced_targeting']
  };

  return features[plan] || features.free;
}

// Create Stripe customer (placeholder for future implementation)
app.post('/billing/create-customer', verifyAuthToken, async (req, res) => {
  try {
    const { sponsorId } = req.body;

    if (!sponsorId) {
      return res.status(400).json({ error: 'sponsorId is required' });
    }

    // TODO: Implement Stripe customer creation
    // For now, return a placeholder
    res.json({
      customerId: `cus_placeholder_${sponsorId}`,
      message: 'Customer creation endpoint - Stripe integration pending'
    });
  } catch (error) {
    console.error('Create customer failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create checkout session (placeholder for future implementation)
app.post('/billing/create-checkout-session', verifyAuthToken, async (req, res) => {
  try {
    const { plan, successUrl, cancelUrl } = req.body;

    if (!plan) {
      return res.status(400).json({ error: 'plan is required' });
    }

    // TODO: Implement Stripe checkout session creation
    // For now, return a placeholder
    res.json({
      sessionId: `cs_placeholder_${plan}_${Date.now()}`,
      url: successUrl || 'https://placeholder-checkout.com',
      message: 'Checkout session endpoint - Stripe integration pending'
    });
  } catch (error) {
    console.error('Create checkout session failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create portal session (placeholder for future implementation)
app.post('/billing/create-portal-session', verifyAuthToken, async (req, res) => {
  try {
    const { customerId, returnUrl } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    // TODO: Implement Stripe customer portal session
    // For now, return a placeholder
    res.json({
      url: returnUrl || 'https://placeholder-portal.com',
      message: 'Portal session endpoint - Stripe integration pending'
    });
  } catch (error) {
    console.error('Create portal session failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start trial (placeholder for future implementation)
app.post('/billing/start-trial', verifyAuthToken, async (req, res) => {
  try {
    const { sponsorId } = req.body;

    if (!sponsorId) {
      return res.status(400).json({ error: 'sponsorId is required' });
    }

    // Check if sponsor has already used trial
    const sponsorDoc = await db.collection('sponsors').doc(sponsorId).get();

    if (!sponsorDoc.exists) {
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    const sponsorData = sponsorDoc.data();

    if (sponsorData.hasUsedTrial) {
      return res.status(400).json({ error: 'Trial already used' });
    }

    // Start 14-day trial
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);

    await db.collection('sponsors').doc(sponsorId).update({
      subscriptionPlan: 'trial',
      subscriptionStatus: 'trial',
      trialEndsAt: admin.firestore.Timestamp.fromDate(trialEndDate),
      hasUsedTrial: true,
      trialStartedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      plan: 'trial',
      trialEndsAt: trialEndDate.getTime(),
      message: 'Trial started successfully'
    });
  } catch (error) {
    console.error('Start trial failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Export the API as a Cloud Function
const api = functions.https.onRequest(app);

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Update user challenge progress for a specific activity
 * This is the server-side equivalent of the Android app's updateProgressByActivity
 */
async function updateUserChallengeProgress(userId, activity, data = {}) {
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
    const allChallenges = [];

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
  } catch (error) {
    console.error('Failed to update user challenge progress (server):', error);
    return false;
  }
}

/**
 * Check if activity is relevant to challenge (server-side)
 */
function isActivityRelevantToServerChallenge(activity, challenge, data) {
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
function calculateServerProgressForActivity(activity, challenge, data) {
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
async function updateServerChallengeProgress(userId, challengeId, progress) {
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
  } catch (error) {
    console.error(`Failed to update server challenge progress for ${challengeId}:`, error);
    return false;
  }
}

/**
 * Send challenge completion notification
 */
async function sendChallengeCompletionNotification(userId, challengeTitle, xpReward) {
  try {
    const payload = {
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
  } catch (error) {
    console.error('Error sending challenge completion notification:', error);
  }
}

/**
 * Update challenge completion statistics
 */
async function updateChallengeCompletionStats(challengeId) {
  try {
    console.log(`📊 UPDATING CHALLENGE COMPLETION STATS: challengeId=${challengeId}`);

    await db.collection('challenges').doc(challengeId).update({
      completionCount: admin.firestore.FieldValue.increment(1)
    });

    console.log(`📊 CHALLENGE COMPLETION STATS UPDATED: challengeId=${challengeId}`);
  } catch (error) {
    console.error('Failed to update challenge completion stats:', error);
  }
}

/**
 * Create user notification document
 */
async function createUserNotification(userId, notificationId, payload) {
  const userNotificationData = {
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
async function sendToToken(token, payload) {
  try {
    const message = {
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl && { imageUrl: payload.imageUrl })
      },
      data: payload.data || {},
      token
    };

    await messaging.send(message);
    return { success: true };
  } catch (error) {
    console.error(`Error sending to token ${token}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Send FCM messages to multiple tokens
 */
async function sendToMultipleTokens(tokens, payload) {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [] };
  }

  const message = {
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
async function getActiveUsers() {
  const usersQuery = await db
    .collection('users')
    .where('active', '==', true)
    .get();

  const users = [];

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
async function getUsersByCity(city) {
  const usersQuery = await db
    .collection('users')
    .where('city', '==', city)
    .where('active', '==', true)
    .get();

  const users = [];

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
async function sendSingleNotificationInternal(notificationId, targetUserId, payload) {
  try {
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

  } catch (error) {
    console.error('Error sending single notification:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get specific users by IDs with FCM tokens
 */
async function getUsersByIds(userIds) {
  const users = [];

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



// ================================
// GEOHASH COMPUTATION FUNCTIONS
// ================================

/**
 * Award XP for various user actions
 */
async function awardUserXP(userId, action, amount, metadata = {}) {
  return await db.runTransaction(async (transaction) => {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const userData = userDoc.data();
    const currentXP = userData.xpPoints || 0;
    const newTotalXP = currentXP + amount;

    // Calculate level progression
    const currentLevel = calculateLevel(currentXP);
    const newLevel = calculateLevel(newTotalXP);
    const leveledUp = newLevel > currentLevel;

    // Update user document
    const updates = {
      xpPoints: newTotalXP,
      level: newLevel,
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Update relevant counters
    if (action === 'VISIT_SPOT') {
      updates.spotsDiscovered = (userData.spotsDiscovered || 0) + 1;
    } else if (action === 'COMPLETE_CHALLENGE') {
      updates.challengesCompleted = (userData.challengesCompleted || 0) + 1;
    }

    transaction.update(userRef, updates);

    // Log the XP transaction
    transaction.create(db.collection('xpTransactions').doc(), {
      userId,
      action,
      amount,
      description: metadata.description || `XP for ${action}`,
      previousXP: currentXP,
      newXP: newTotalXP,
      previousLevel: currentLevel,
      newLevel: newLevel,
      leveledUp,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      type: 'AWARD',
      ...metadata
    });

    return { newTotalXP, newLevel, leveledUp };
  });
}

/**
 * Check for duplicate XP awards to prevent cheating
 */
async function checkForDuplicateAward(userId, action, resourceId) {
  const existingAward = await db.collection('xpTransactions')
    .where('userId', '==', userId)
    .where('action', '==', action)
    .where('spotId', '==', resourceId)
    .where('type', '==', 'AWARD')
    .limit(1)
    .get();

  if (!existingAward.empty) {
    const doc = existingAward.docs[0].data();
    return { exists: true, amount: doc.amount };
  }

  return { exists: false };
}

/**
 * Calculate user level based on XP using a progression formula
 */
function calculateLevel(xp) {
  if (xp < 0) return 1;

  // Level progression: Level = floor(sqrt(XP / 100)) + 1
  // This means: Level 1: 0-99 XP, Level 2: 100-399 XP, Level 3: 400-899 XP, etc.
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

/**
 * Calculate user level from total XP (from TypeScript backup)
 * Formula: Level = floor(XP / 500) + 1
 */
function calculateXPLevel(xp) {
  return Math.floor(xp / 500) + 1;
}

/**
 * Create idempotency key to prevent duplicate XP awards
 */
function createIdempotencyKey(userId, action, entityId, timestamp) {
  const entity = entityId || 'global';
  // Round timestamp to nearest second to allow some tolerance
  const roundedTime = Math.floor(timestamp / 1000);
  return `${userId}_${action}_${entity}_${roundedTime}`;
}

/**
 * Check if user is on cooldown for this action
 */
async function checkCooldown(transaction, userId, action, entityId, rule) {
  const cooldownMs = rule.cooldown * 60 * 1000;
  const cutoffTime = admin.firestore.Timestamp.fromMillis(Date.now() - cooldownMs);

  let query = db.collection('users').doc(userId).collection('xpHistory')
    .where('action', '==', action)
    .where('awardedAt', '>', cutoffTime)
    .orderBy('awardedAt', 'desc')
    .limit(1);

  // If entityId provided, check per-entity cooldown
  if (entityId) {
    query = query.where('entityId', '==', entityId);
  }

  const recentHistory = await transaction.get(query);

  if (!recentHistory.empty) {
    const lastAward = recentHistory.docs[0].data();
    const lastAwardTime = lastAward.awardedAt.toMillis();
    const remainingMs = cooldownMs - (Date.now() - lastAwardTime);
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    return {
      allowed: false,
      reason: `Please wait ${timeStr} before earning XP from this action again`,
      remainingSeconds
    };
  }

  return { allowed: true };
}

/**
 * Check if user has reached daily limit for this action
 */
async function checkDailyLimit(transaction, userId, action, rule) {
  // Get start of today (midnight in server timezone)
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoffTime = admin.firestore.Timestamp.fromDate(startOfDay);

  const todayQuery = db.collection('users').doc(userId).collection('xpHistory')
    .where('action', '==', action)
    .where('awardedAt', '>', cutoffTime);

  const todayHistory = await transaction.get(todayQuery);
  const currentCount = todayHistory.size;

  if (currentCount >= rule.maxDaily) {
    return {
      allowed: false,
      reason: `Daily limit reached (${rule.maxDaily} times per day)`,
      currentCount
    };
  }

  return { allowed: true };
}

/**
 * Check and unlock badges for a user based on XP and level
 * Runs asynchronously after XP award to avoid blocking
 */
async function checkAndUnlockBadges(userId, xp, level) {
  try {
    // Get all badge definitions
    const badgeDefsSnapshot = await db.collection('badgeDefinitions').get();

    if (badgeDefsSnapshot.empty) {
      console.log('No badge definitions found');
      return;
    }

    // Get user's existing badges
    const userBadgesSnapshot = await db.collection('users')
      .doc(userId)
      .collection('badges')
      .get();

    const existingBadgeIds = new Set(
      userBadgesSnapshot.docs.map(doc => doc.data().badgeId)
    );

    // Check each badge definition
    const unlockPromises = [];

    for (const badgeDoc of badgeDefsSnapshot.docs) {
      const badge = badgeDoc.data();
      const badgeId = badgeDoc.id;

      // Skip if already unlocked
      if (existingBadgeIds.has(badgeId)) {
        continue;
      }

      // Check unlock conditions
      let shouldUnlock = false;

      if (badge.unlockType === 'xp' && xp >= (badge.requiredXP || 0)) {
        shouldUnlock = true;
      } else if (badge.unlockType === 'level' && level >= (badge.requiredLevel || 0)) {
        shouldUnlock = true;
      } else if (badge.unlockType === 'milestone') {
        // Check milestone conditions
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();

        if (badge.milestoneType === 'spotsDiscovered' &&
            (userData?.spotsDiscovered || 0) >= (badge.requiredCount || 0)) {
          shouldUnlock = true;
        } else if (badge.milestoneType === 'challengesCompleted' &&
                   (userData?.challengesCompleted || 0) >= (badge.requiredCount || 0)) {
          shouldUnlock = true;
        }
      }

      if (shouldUnlock) {
        unlockPromises.push(unlockBadge(userId, badgeId, badge));
      }
    }

    await Promise.all(unlockPromises);

  } catch (error) {
    console.error('Error checking badges:', error);
    // Don't throw - badge unlocking is non-critical
  }
}

/**
 * Unlock a specific badge for a user
 */
async function unlockBadge(userId, badgeId, badgeData) {
  try {
    const badgeRef = db.collection('users').doc(userId).collection('badges').doc(badgeId);

    await badgeRef.set({
      badgeId,
      badgeTitle: badgeData.title || '',
      badgeDescription: badgeData.description || '',
      badgeType: badgeData.type || 'achievement',
      badgeLevel: badgeData.level || 1,
      badgeImageUrl: badgeData.imageUrl || '',
      earnedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`🏆 Badge Unlocked: ${badgeData.title} for user ${userId}`);

    // TODO: Send push notification about badge unlock

  } catch (error) {
    console.error(`Failed to unlock badge ${badgeId} for user ${userId}:`, error);
  }
}

/**
 * Check if user is an admin
 */
async function checkIsAdmin(uid) {
  try {
    // Check adminUsers collection
    const adminDoc = await db.collection('adminUsers').doc(uid).get();
    if (adminDoc.exists) {
      const adminData = adminDoc.data();
      return ['SUPER_ADMIN', 'ADMIN'].includes(adminData.role) && adminData.isActive === true;
    }

    // Check users collection
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      return ['superadmin', 'admin'].includes(userData.role);
    }

    return false;
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

/**
 * Admin function to grant XP (CRITICAL FUNCTION)
 */
const adminGrantXP = functions.https.onCall(async (request) => {
  const data = request.data;
  const auth = request.auth;

  try {
    console.log('adminGrantXP called with data:', data);

    if (!auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { userId, xpAmount, reason } = data;

    if (!userId || !xpAmount || !reason) {
      throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: userId, xpAmount, reason');
    }

    if (typeof xpAmount !== 'number' || xpAmount <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'xpAmount must be a positive number');
    }

    // Update user XP
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const userData = userDoc.data();
    const currentXP = userData.xpPoints || userData.xp || 0;
    const newXP = currentXP + xpAmount;

    await userRef.update({
      xpPoints: newXP,
      xp: newXP,
      lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Granted ${xpAmount} XP to user ${userId}. New total: ${newXP}`);

    return {
      success: true,
      previousXP: currentXP,
      newXP: newXP,
      xpGranted: xpAmount
    };

  } catch (error) {
    console.error('Error in adminGrantXP:', error);
    if (error.code) {
      throw error;
    }
    throw new functions.https.HttpsError('internal', 'Failed to grant XP');
  }
});

// Helper function to generate search tokens for efficient prefix searching
function generateSearchTokens(fields) {
  const tokens = new Set();

  for (const field of fields) {
    if (!field || typeof field !== 'string') continue;

    const cleanField = field.trim().toLowerCase();
    if (cleanField.length === 0) continue;

    // Generate prefixes for the whole field
    for (let i = 1; i <= Math.min(cleanField.length, 20); i++) {
      tokens.add(cleanField.substring(0, i));
    }

    // Generate prefixes for each word in the field
    const words = cleanField.split(/\s+/);
    for (const word of words) {
      if (word.length > 0) {
        for (let i = 1; i <= Math.min(word.length, 20); i++) {
          tokens.add(word.substring(0, i));
        }
      }
    }
  }

  return Array.from(tokens);
}

const generateSearchTokensOnUserUpdate = onDocumentWritten('users/{userId}', (event) => {
  const change = event.data;
  const data = change.after.exists ? change.after.data() : null;

  if (!data) {
    // Document was deleted, nothing to do
    return null;
  }

  const displayName = data.displayName || '';
  const username = data.username || '';
  const email = data.email || '';

  // Generate search tokens
  const searchTokens = generateSearchTokens([displayName, username, email]);

  // Only update if tokens changed
  const existingTokens = data.searchTokens || [];
  if (JSON.stringify(searchTokens.sort()) === JSON.stringify(existingTokens.sort())) {
    return null; // No change needed
  }

  console.log(`[generateSearchTokensOnUserUpdate] Updating search tokens for user ${event.params.userId}`);

  // Update the document with search tokens
  return change.after.ref.update({ searchTokens });
});

// ================================
// TIER 1: CRITICAL MISSING FUNCTIONS
// ================================

/**
 * SPOT VERIFICATION SYSTEM
 * Purpose: Verify spot submissions with anti-cheat and scoring
 * Triggers: Called by admin dashboard or automated systems
 * Collections: spots, verificationLogs, adminActions
 * Transactions: Used for atomic spot status updates
 * Edge cases: Duplicate verification, missing spot, invalid status
 */
const verifySpotSubmission = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { spotId, approved, reason, score } = data;

  if (!spotId || typeof approved !== 'boolean') {
    throw new functions.https.HttpsError('invalid-argument', 'spotId and approved status are required');
  }

  try {
    // Check admin permissions
    const isAdmin = await checkIsAdmin(auth.uid);
    if (!isAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }

    const result = await db.runTransaction(async (transaction) => {
      const spotRef = db.collection('spots').doc(spotId);
      const spotDoc = await transaction.get(spotRef);

      if (!spotDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Spot not found');
      }

      const spotData = spotDoc.data();

      // Prevent duplicate verification
      if (spotData.verificationStatus === 'APPROVED' || spotData.verificationStatus === 'REJECTED') {
        throw new functions.https.HttpsError('already-exists', 'Spot already verified');
      }

      const updateData = {
        verificationStatus: approved ? 'APPROVED' : 'REJECTED',
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        verifiedBy: auth.uid,
        verificationReason: reason || '',
        verificationScore: score || null,
        isActive: approved
      };

      transaction.update(spotRef, updateData);

      // Log verification action
      const logRef = db.collection('verificationLogs').doc();
      transaction.set(logRef, {
        spotId,
        action: approved ? 'APPROVE' : 'REJECT',
        adminId: auth.uid,
        reason: reason || '',
        score: score || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return { spotId, approved, userId: spotData.createdBy };
    });

    console.log(`Spot ${spotId} ${result.approved ? 'approved' : 'rejected'} by admin ${auth.uid}`);

    // Send notification to spot creator
    if (result.approved) {
      await sendSpotApprovalNotificationInternal(result.userId, spotData.title);
    } else {
      await sendSpotRejectionNotificationInternal(result.userId, spotData.title, reason);
    }

    return { success: true, approved: result.approved };

  } catch (error) {
    console.error('Spot verification failed:', error);
    if (error.code) throw error;
    throw new functions.https.HttpsError('internal', 'Verification failed');
  }
});

/**
 * SPOT VERIFICATION UPDATE HANDLER
 * Purpose: Handle automatic actions when spot verification status changes
 * Triggers: Firestore trigger on spots/{spotId} updates
 * Collections: spots, users, notifications
 * Transactions: Used for XP awards
 */
const handleSpotVerificationUpdate = onDocumentWritten('spots/{spotId}', async (event) => {
  const change = event.data;
  const spotId = event.params.spotId;

  if (!change.after.exists) return null;

  const before = change.before.exists ? change.before.data() : null;
  const after = change.after.data();

  // Only process verification status changes
  if (!before || before.verificationStatus === after.verificationStatus) {
    return null;
  }

  try {
    if (after.verificationStatus === 'APPROVED' && before.verificationStatus !== 'APPROVED') {
      console.log(`Spot ${spotId} approved - awarding XP to creator ${after.createdBy}`);

      // Award XP for approved spot (100 XP)
      const userRef = db.collection('users').doc(after.createdBy);
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (userDoc.exists) {
          const userData = userDoc.data();
          const currentXP = userData.xpPoints || userData.xp || 0;
          const newXP = currentXP + 100;

          transaction.update(userRef, {
            xpPoints: newXP,
            xp: newXP,
            spotsDiscovered: admin.firestore.FieldValue.increment(1),
            lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
          });

          // Log XP transaction
          transaction.create(db.collection('xpTransactions').doc(), {
            userId: after.createdBy,
            action: 'SPOT_APPROVED',
            amount: 100,
            spotId: spotId,
            description: 'XP for approved spot submission',
            previousXP: currentXP,
            newXP: newXP,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            type: 'AWARD'
          });
        }
      });
    }

    return null;
  } catch (error) {
    console.error('Error handling spot verification update:', error);
    return null;
  }
});

/**
 * XP ADJUSTMENT SYSTEM
 * Purpose: Adjust user XP for corrections, refunds, or penalties
 * Triggers: Called by admin functions
 * Collections: users, xpTransactions, adminActions
 * Transactions: Used for atomic XP updates
 * Edge cases: Negative XP, missing user, duplicate adjustments
 */
const adjustUserXP = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { userId, xpAmount, reason, type = 'ADJUSTMENT' } = data;

  if (!userId || typeof xpAmount !== 'number' || !reason) {
    throw new functions.https.HttpsError('invalid-argument', 'userId, xpAmount, and reason are required');
  }

  try {
    // Check admin permissions
    const isAdmin = await checkIsAdmin(auth.uid);
    if (!isAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }

    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'User not found');
      }

      const userData = userDoc.data();
      const currentXP = userData.xpPoints || userData.xp || 0;
      const newXP = Math.max(0, currentXP + xpAmount); // Prevent negative XP
      const newLevel = calculateXPLevel(newXP);

      transaction.update(userRef, {
        xpPoints: newXP,
        xp: newXP,
        level: newLevel,
        lastXpUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      // Log adjustment
      transaction.create(db.collection('xpTransactions').doc(), {
        userId,
        action: 'ADMIN_ADJUSTMENT',
        amount: xpAmount,
        description: reason,
        previousXP: currentXP,
        newXP: newXP,
        previousLevel: userData.level || 1,
        newLevel: newLevel,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        type: type,
        adminId: auth.uid
      });

      return { currentXP, newXP, xpAmount };
    });

    console.log(`Admin ${auth.uid} adjusted XP for user ${userId}: ${result.xpAmount} (${result.currentXP} -> ${result.newXP})`);

    return {
      success: true,
      previousXP: result.currentXP,
      newXP: result.newXP,
      adjustment: result.xpAmount
    };

  } catch (error) {
    console.error('XP adjustment failed:', error);
    if (error.code) throw error;
    throw new functions.https.HttpsError('internal', 'XP adjustment failed');
  }
});

// Helper functions for notifications
async function sendSpotApprovalNotificationInternal(userId, spotTitle) {
  try {
    const payload = {
      title: 'Spot Approved! 🎉',
      body: `Your spot "${spotTitle}" has been approved! You earned 100 XP!`,
      data: {
        type: 'spot_approval',
        spotTitle,
        xpAwarded: '100'
      }
    };

    const notificationRef = await db.collection('notifications').add({
      title: payload.title,
      body: payload.body,
      type: 'single',
      targetUserId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    return await sendSingleNotificationInternal(notificationRef.id, userId, payload);
  } catch (error) {
    console.error('Error sending spot approval notification:', error);
  }
}

async function sendSpotRejectionNotificationInternal(userId, spotTitle, reason) {
  try {
    const payload = {
      title: 'Spot Submission Declined 📍',
      body: `Your spot "${spotTitle}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
      data: {
        type: 'spot_rejection',
        spotTitle,
        reason: reason || ''
      }
    };

    const notificationRef = await db.collection('notifications').add({
      title: payload.title,
      body: payload.body,
      type: 'single',
      targetUserId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    return await sendSingleNotificationInternal(notificationRef.id, userId, payload);
  } catch (error) {
    console.error('Error sending spot rejection notification:', error);
  }
}

// ================================
// TIER 1: QR CODE FUNCTIONS
// ================================

/**
 * Calculate user level from XP
 */
function calculateLevel(xp) {
  return Math.floor(xp / 500) + 1; // Every 500 XP = 1 level
}

/**
 * Generate QR data for sponsor (internal helper)
 */
async function generateQRDataForSponsor(sponsorId) {
  try {
    const sponsorDoc = await db.collection('sponsors').doc(sponsorId).get();

    if (!sponsorDoc.exists) {
      return {
        success: false,
        error: 'Sponsor account not found. Please ensure you are logged in as a sponsor.'
      };
    }

    let sponsor = sponsorDoc.data();

    // Initialize QR secret if not present
    if (!sponsor.qrSecret) {
      const crypto = require('crypto');
      const newSecret = crypto.randomBytes(32).toString('hex');
      await db.collection('sponsors').doc(sponsorId).update({
        qrSecret: newSecret,
        qrVersion: 1,
        qrExpiryMinutes: 5,
        qrGeneratedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      sponsor.qrSecret = newSecret;
      sponsor.qrVersion = 1;
      sponsor.qrExpiryMinutes = 5;
    }

    const crypto = require('crypto');

    // Generate QR payload
    const payload = {
      v: sponsor.qrVersion || 1,
      sid: sponsorId,
      ts: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };

    // Create HMAC signature
    const dataToSign = `${payload.v}|${payload.sid}|${payload.ts}|${payload.nonce}`;
    const signature = crypto
      .createHmac('sha256', sponsor.qrSecret)
      .update(dataToSign)
      .digest('hex');

    const fullPayload = { ...payload, sig: signature };

    // Encode as Base64 for compact QR
    const qrData = Buffer.from(JSON.stringify(fullPayload)).toString('base64');

    // Update generation timestamp
    await db.collection('sponsors').doc(sponsorId).update({
      qrGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastQrNonce: payload.nonce
    });

    const expiresIn = (sponsor.qrExpiryMinutes || 5) * 60; // seconds

    return {
      success: true,
      qrData,
      expiresIn,
      generatedAt: payload.ts
    };

  } catch (error) {
    console.error(`[Generate QR Data] ERROR:`, error);
    return {
      success: false,
      error: 'Failed to generate QR code. Please try again.'
    };
  }
}

/**
 * REDEEM REWARD BY SCANNING QR CODE
 * Instant redemption - no approval needed
 */
const redeemByQR = functions.https.onCall(async (request) => {
  try {
    // Authentication check
    if (!request.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Must be authenticated to redeem rewards'
      );
    }

    const userId = request.auth.uid;
    const { qrCode, userLocation } = request.data;

    console.log(`📱 QR redemption request received - User: ${userId}, QR: ${qrCode}`);

    // Validate input
    if (!qrCode || qrCode.trim() === '') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'QR code is required'
      );
    }

    // Extract reward ID from QR code (supports multiple formats)
    let extractedRewardId = null;

    // Format 1: Deep link format "mysteriSpots://reward/{rewardId}"
    const deepLinkMatch = qrCode.match(/mysteriSpots:\/\/reward\/([a-zA-Z0-9_-]+)/);
    if (deepLinkMatch) {
      extractedRewardId = deepLinkMatch[1];
    }

    // Format 2: Legacy format "REWARD_{rewardId}_{timestamp}_{random}"
    if (!extractedRewardId && qrCode.startsWith('REWARD_')) {
      const parts = qrCode.split('_');
      if (parts.length >= 2) {
        extractedRewardId = parts[1];
      }
    }

    // Format 3: Plain reward ID (fallback)
    if (!extractedRewardId && qrCode.match(/^[a-zA-Z0-9_-]{10,}$/)) {
      extractedRewardId = qrCode;
    }

    if (!extractedRewardId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid QR Code. Please scan a valid reward QR code.'
      );
    }

    const rewardId = extractedRewardId;

    // Get reward by ID
    const rewardDoc = await db.collection('rewards').doc(rewardId).get();

    if (!rewardDoc.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'Invalid Reward. This reward no longer exists or has been removed.'
      );
    }

    const reward = rewardDoc.data();
    console.log(`🎁 Found reward: ${reward.title} (${rewardId})`);

    // Check if reward is active
    if (!reward.active) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Reward Inactive. This reward is no longer available for redemption.'
      );
    }

    // Check if reward has expired
    if (reward.expiresAt) {
      let expiryDate;

      // Handle different date formats
      if (typeof reward.expiresAt === 'object' && 'toDate' in reward.expiresAt) {
        expiryDate = reward.expiresAt.toDate();
      } else if (reward.expiresAt instanceof Date) {
        expiryDate = reward.expiresAt;
      } else if (typeof reward.expiresAt === 'string' || typeof reward.expiresAt === 'number') {
        expiryDate = new Date(reward.expiresAt);
      } else {
        expiryDate = new Date(Date.now() + 86400000); // Default to tomorrow (not expired)
      }

      if (expiryDate < new Date()) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Reward Expired. This reward has expired and is no longer valid.'
        );
      }
    }

    // Check if reward has reached max redemptions
    if (reward.maxRedemptions && reward.currentRedemptions >= reward.maxRedemptions) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Reward Sold Out. This reward has reached its maximum redemption limit.'
      );
    }

    // Check if user has already redeemed this reward
    const existingRedemption = await db
      .collection('users')
      .doc(userId)
      .collection('redemptions')
      .where('rewardId', '==', rewardId)
      .where('used', '==', false)
      .limit(1)
      .get();

    if (!existingRedemption.empty) {
      throw new functions.https.HttpsError(
        'already-exists',
        'Already Redeemed. You have already redeemed this reward. Check "My Rewards" to use it.'
      );
    }

    // Get user document
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'User Profile Not Found. Please complete your profile setup.'
      );
    }

    const userData = userDoc.data();
    const currentXP = userData.xp || 0;
    const xpCost = reward.xpRequired || 0;

    // Check if user has sufficient XP
    if (currentXP < xpCost) {
      const needed = xpCost - currentXP;
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Insufficient XP. You need ${needed} more XP points to redeem this reward. Current XP: ${currentXP}, Required: ${xpCost}`
      );
    }

    // Perform atomic transaction for redemption
    const result = await db.runTransaction(async (transaction) => {
      // Re-check user XP within transaction (prevent race conditions)
      const latestUserDoc = await transaction.get(db.collection('users').doc(userId));
      const latestUser = latestUserDoc.data();
      const latestXP = latestUser.xp || 0;

      if (latestXP < xpCost) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Insufficient XP after revalidation'
        );
      }

      // Calculate new XP and level
      const newXP = latestXP - xpCost;
      const newLevel = calculateLevel(newXP);

      // Create redemption record in user's subcollection
      const redemptionRef = db
        .collection('users')
        .doc(userId)
        .collection('redemptions')
        .doc();

      // Generate unique redemption QR code for sponsor validation
      const redemptionQRCode = `mysteriSpots://redemption/${redemptionRef.id}`;

      const redemptionData = {
        rewardId,
        rewardTitle: reward.title,
        sponsorId: reward.sponsorId,
        sponsorName: reward.sponsorName || '',
        xpUsed: xpCost,
        redeemedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingApproval: false, // No approval needed!
        approved: true, // Auto-approved via QR scan
        used: false, // Not yet used
        usedAt: null,
        qrToken: qrCode, // Store the original reward QR code that was scanned
        redemptionQRCode, // QR code for sponsor to scan when validating
        userId: userId,
        location: userLocation || null,
      };

      transaction.set(redemptionRef, redemptionData);

      // Update user's XP and level
      transaction.update(db.collection('users').doc(userId), {
        xp: newXP,
        level: newLevel,
      });

      // Increment reward's currentRedemptions counter
      transaction.update(db.collection('rewards').doc(rewardId), {
        currentRedemptions: admin.firestore.FieldValue.increment(1),
      });

      return {
        redemptionId: redemptionRef.id,
        newXP,
        newLevel,
      };
    });

    console.log(`🎉 Redemption successful: ${result.redemptionId}`);

    // Create notification for user
    await db.collection('users').doc(userId).collection('notifications').add({
      type: 'reward_redeemed',
      title: 'Reward Redeemed!',
      message: `You have successfully redeemed ${reward.title}`,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      data: {
        rewardId,
        redemptionId: result.redemptionId,
      },
    });

    return {
      success: true,
      message: `Successfully redeemed ${reward.title}!`,
      redemptionId: result.redemptionId,
      rewardTitle: reward.title,
      xpDeducted: xpCost,
      newXP: result.newXP,
      newLevel: result.newLevel,
    };
  } catch (error) {
    console.error('❌ Error in QR redemption:', error);

    // Re-throw HttpsError as-is
    if (error.code && error.code.startsWith('functions/')) {
      throw error;
    }

    // Wrap other unexpected errors
    throw new functions.https.HttpsError(
      'internal',
      'Redemption Failed. An unexpected error occurred. Please try scanning the QR code again.'
    );
  }
});

/**
 * VALIDATE QR CODE (without redeeming)
 * Allows users to preview reward details before redeeming
 */
const validateQRCode = functions.https.onCall(async (request) => {
  try {
    if (!request.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const { qrCode } = request.data;

    if (!qrCode) {
      throw new functions.https.HttpsError('invalid-argument', 'QR code is required');
    }

    // Find reward by QR code
    const rewardsQuery = await db
      .collection('rewards')
      .where('qrCode', '==', qrCode)
      .limit(1)
      .get();

    if (rewardsQuery.empty) {
      return {
        valid: false,
        message: 'Invalid QR code',
      };
    }

    const rewardDoc = rewardsQuery.docs[0];
    const reward = rewardDoc.data();

    return {
      valid: true,
      reward: {
        id: rewardDoc.id,
        title: reward.title,
        description: reward.description,
        xpRequired: reward.xpRequired,
        imageUrl: reward.imageUrl,
        active: reward.active,
        expiresAt: reward.expiresAt,
        currentRedemptions: reward.currentRedemptions,
        maxRedemptions: reward.maxRedemptions,
      },
      message: 'Valid reward QR code',
    };
  } catch (error) {
    console.error('❌ Error validating QR code:', error);

    if (error.code && error.code.startsWith('functions/')) {
      throw error;
    }

    throw new functions.https.HttpsError(
      'internal',
      'Failed to validate QR code'
    );
  }
});

/**
 * SPONSOR: VALIDATE AND USE REDEMPTION
 * Sponsors scan user's redemption QR code to mark it as used
 */
const validateRedemption = functions.https.onCall(async (request) => {
  try {
    // Authentication check
    if (!request.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Must be authenticated to validate redemptions'
      );
    }

    const sponsorUserId = request.auth.uid;
    const { redemptionQRCode } = request.data;

    console.log(`🔍 Redemption validation request from sponsor: ${sponsorUserId}`);
    console.log(`   Redemption QR: ${redemptionQRCode}`);

    // Validate input
    if (!redemptionQRCode || redemptionQRCode.trim() === '') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Redemption QR code is required'
      );
    }

    // Extract redemption ID from QR code
    let redemptionId = null;

    // Format 1: Deep link "mysteriSpots://redemption/{redemptionId}"
    const deepLinkMatch = redemptionQRCode.match(/mysteriSpots:\/\/redemption\/([a-zA-Z0-9_-]+)/);
    if (deepLinkMatch) {
      redemptionId = deepLinkMatch[1];
    }

    // Format 2: "{userId}/{redemptionId}"
    if (!redemptionId && redemptionQRCode.includes('/')) {
      const parts = redemptionQRCode.split('/');
      if (parts.length === 2) {
        redemptionId = parts[1];
      }
    }

    if (!redemptionId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid redemption QR code format'
      );
    }

    // Find the redemption in all users' subcollections
    console.log(`🔍 Searching for redemption: ${redemptionId}`);

    const redemptionsQuery = await db
      .collectionGroup('redemptions')
      .limit(100)
      .get();

    // Find matching redemption by document ID
    const redemptionDoc = redemptionsQuery.docs.find(doc => doc.id === redemptionId);

    if (!redemptionDoc) {
      throw new functions.https.HttpsError(
        'not-found',
        'Redemption not found. Invalid QR code.'
      );
    }

    const redemption = redemptionDoc.data();
    const redemptionUserId = redemption.userId;

    console.log(`📄 Found redemption for user: ${redemptionUserId}`);
    console.log(`   Reward: ${redemption.rewardTitle}`);
    console.log(`   Sponsor: ${redemption.sponsorId}`);
    console.log(`   Used: ${redemption.used}`);

    // Verify sponsor owns this reward
    const sponsorDoc = await db.collection('sponsors').doc(redemption.sponsorId).get();

    if (!sponsorDoc.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'Sponsor not found'
      );
    }

    const sponsorData = sponsorDoc.data();
    const sponsorOwnerId = sponsorData.ownerUserId || sponsorData.userId;

    if (sponsorOwnerId !== sponsorUserId) {
      console.error(`❌ Unauthorized: Sponsor ${sponsorUserId} does not own sponsor ${redemption.sponsorId}`);
      throw new functions.https.HttpsError(
        'permission-denied',
        'You are not authorized to validate this redemption'
      );
    }

    console.log(`✅ Sponsor ownership verified`);

    // Check if already used
    if (redemption.used) {
      const usedAt = redemption.usedAt ? redemption.usedAt.toDate().toLocaleString() : 'unknown time';
      throw new functions.https.HttpsError(
        'already-exists',
        `This redemption has already been used on ${usedAt}`
      );
    }

    // Mark redemption as used
    await db
      .collection('users')
      .doc(redemptionUserId)
      .collection('redemptions')
      .doc(redemptionId)
      .update({
        used: true,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        validatedBy: sponsorUserId,
      });

    console.log(`✅ Redemption marked as used successfully`);

    // Send notification to user
    await db
      .collection('users')
      .doc(redemptionUserId)
      .collection('notifications')
      .add({
        type: 'redemption_used',
        title: 'Reward Used!',
        message: `Your reward "${redemption.rewardTitle}" has been validated and used`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        data: {
          redemptionId,
          rewardId: redemption.rewardId,
          sponsorId: redemption.sponsorId,
        },
      });

    return {
      success: true,
      message: 'Redemption validated successfully!',
      redemption: {
        id: redemptionId,
        rewardTitle: redemption.rewardTitle,
        userName: redemptionUserId,
        redeemedAt: redemption.redeemedAt,
        xpUsed: redemption.xpUsed,
      },
    };
  } catch (error) {
    console.error('❌ Error validating redemption:', error);

    if (error.code && error.code.startsWith('functions/')) {
      throw error;
    }

    throw new functions.https.HttpsError(
      'internal',
      error.message || 'Failed to validate redemption'
    );
  }
});

/**
 * Generate a new QR code for sponsor
 */
const generateSponsorQR = functions.https.onCall(async (request) => {
  // Authenticate
  if (!request.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to generate QR codes'
    );
  }

  const sponsorId = request.auth.uid;
  console.log(`[Generate QR] Sponsor ${sponsorId} requesting QR code`);

  const result = await generateQRDataForSponsor(sponsorId);

  if (result.success) {
    console.log(`[Generate QR] SUCCESS: Generated QR for sponsor ${sponsorId}, expires in ${result.expiresIn}s`);
  }

  return result;
});

/**
 * Regenerate QR code (invalidates all previous QR codes)
 */
const regenerateSponsorQR = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to regenerate QR codes'
    );
  }

  const sponsorId = request.auth.uid;

  console.log(`[Regenerate QR] Sponsor ${sponsorId} requesting QR regeneration`);

  try {
    // Increment qrVersion to invalidate all old QR codes
    await db.collection('sponsors').doc(sponsorId).update({
      qrVersion: admin.firestore.FieldValue.increment(1),
      qrRegeneratedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[Regenerate QR] Incremented QR version for sponsor ${sponsorId}`);

    // Generate new QR with incremented version
    return await generateQRDataForSponsor(sponsorId);

  } catch (error) {
    console.error(`[Regenerate QR] ERROR:`, error);
    return {
      success: false,
      error: 'Failed to regenerate QR code. Please try again.'
    };
  }
});

/**
 * Update QR expiry settings for sponsor
 */
const updateQRSettings = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to update QR settings'
    );
  }

  const sponsorId = request.auth.uid;
  const { expiryMinutes } = request.data;

  // Validate expiry range
  if (!expiryMinutes || expiryMinutes < 1 || expiryMinutes > 60) {
    return {
      success: false,
      error: 'Expiry must be between 1 and 60 minutes'
    };
  }

  try {
    await db.collection('sponsors').doc(sponsorId).update({
      qrExpiryMinutes: expiryMinutes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[Update QR Settings] Sponsor ${sponsorId} set expiry to ${expiryMinutes} minutes`);

    return { success: true };

  } catch (error) {
    console.error(`[Update QR Settings] ERROR:`, error);
    return {
      success: false,
      error: 'Failed to update settings'
    };
  }
});

/**
 * Get QR statistics for sponsor
 */
const getQRStats = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to view QR stats'
    );
  }

  const sponsorId = request.auth.uid;

  try {
    // Query redemptions for this sponsor
    const redemptionsSnapshot = await db
      .collectionGroup('redemptions')
      .where('sponsorId', '==', sponsorId)
      .where('redemptionMethod', '==', 'qr')
      .orderBy('redeemedAt', 'desc')
      .limit(100)
      .get();

    const totalRedemptions = redemptionsSnapshot.size;

    // Count redemptions in last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last24Hours = redemptionsSnapshot.docs.filter(doc => {
      const redeemedAt = doc.data().redeemedAt && doc.data().redeemedAt.toDate();
      return redeemedAt && redeemedAt > twentyFourHoursAgo;
    }).length;

    // Get last redemption
    const lastRedemption = redemptionsSnapshot.docs[0] && redemptionsSnapshot.docs[0].data();

    return {
      success: true,
      stats: {
        totalRedemptions,
        last24Hours,
        lastRedemption: lastRedemption ? {
          rewardTitle: lastRedemption.rewardTitle,
          redeemedAt: lastRedemption.redeemedAt,
          xpUsed: lastRedemption.xpUsed
        } : undefined
      }
    };

  } catch (error) {
    console.error(`[QR Stats] ERROR:`, error);
    return {
      success: false,
      error: 'Failed to fetch statistics'
    };
  }
});

/**
 * Initialize sponsor QR secrets (migration function)
 */
const initializeSponsorQRSecrets = functions.https.onCall(async (request) => {
  // Admin authentication check
  if (!request.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(request.auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  try {
    const crypto = require('crypto');
    const batch = db.batch();
    let count = 0;

    const sponsorsSnapshot = await db.collection('sponsors').get();

    sponsorsSnapshot.docs.forEach(doc => {
      const sponsor = doc.data();

      // Only initialize if qrSecret doesn't exist
      if (!sponsor.qrSecret) {
        const qrSecret = crypto.randomBytes(32).toString('hex');

        batch.update(doc.ref, {
          qrSecret,
          qrVersion: 1,
          qrExpiryMinutes: 5,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
    }

    return {
      success: true,
      message: `Initialized QR secrets for ${count} sponsors`
    };

  } catch (error) {
    console.error('Error initializing sponsor QR secrets:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

/**
 * Check admin permissions
 */
async function checkAdminPermissions(userId) {
  try {
    const adminDoc = await db.doc(`admins/${userId}`).get();
    return adminDoc.exists;
  } catch (error) {
    console.warn(`Admin check failed for user ${userId}:`, error);
    return false;
  }
}

// ================================
// TIER 3: MODERATION AND REPORTS FUNCTIONS
// ================================

/**
 * Submit a spot report
 */
const reportSpot = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { spotId, reason, description = "" } = data;

  if (!spotId || !reason) {
    throw new functions.https.HttpsError("invalid-argument", "Spot ID and reason are required");
  }

  const validReasons = ["FAKE", "WRONG_LOCATION", "SPAM", "OFFENSIVE", "DANGEROUS", "DUPLICATE"];
  if (!validReasons.includes(reason)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid report reason");
  }

  const userId = auth.uid;

  try {
    // Check if user has already reported this spot
    const existingReport = await db.collection("spotReports")
      .where("spotId", "==", spotId)
      .where("reportedBy", "==", userId)
      .limit(1)
      .get();

    if (!existingReport.empty) {
      throw new functions.https.HttpsError("already-exists", "You have already reported this spot");
    }

    // Verify spot exists
    const spotDoc = await db.doc(`spots/${spotId}`).get();
    if (!spotDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Spot not found");
    }

    const spotData = spotDoc.data();

    // Prevent reporting your own spots
    if (spotData.createdBy === userId) {
      throw new functions.https.HttpsError("permission-denied", "Cannot report your own spot");
    }

    // Create the report
    const reportData = {
      spotId,
      reportedBy: userId,
      reason,
      description: description.substring(0, 500), // Limit description length
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "PENDING",
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: ""
    };

    const reportRef = await db.collection("spotReports").add(reportData);

    // Check if this spot should be automatically flagged
    await checkSpotForAutoFlag(spotId);

    console.log(`User ${userId} reported spot ${spotId} for reason: ${reason}`);

    return {
      success: true,
      reportId: reportRef.id,
      message: "Report submitted successfully"
    };

  } catch (error) {
    if (error.code && error.code.startsWith('functions/')) {
      throw error; // Re-throw HttpsError
    }
    console.error(`Failed to report spot ${spotId}:`, error);
    throw new functions.https.HttpsError("internal", "Failed to submit report");
  }
});

/**
 * Auto-process new spot reports
 */
const processSpotReport = onDocumentCreated("spotReports/{reportId}", async (event) => {
  const reportData = event.data.data();
  const reportId = event.params.reportId;

  if (!reportData) {
    console.warn(`No data found for report ${reportId}`);
    return;
  }

  const spotId = reportData.spotId;

  try {
    console.log(`Processing new report ${reportId} for spot ${spotId}`);

    // Update spot report count
    await updateSpotReportCount(spotId);

    // Check for automatic actions based on report patterns
    await analyzeReportPatterns(spotId, reportData);

    // Notify admins if needed
    await notifyAdminsOfReport(reportData, reportId);

  } catch (error) {
    console.error(`Failed to process report ${reportId}:`, error);
  }
});

/**
 * Check if spot should be auto-flagged based on report volume
 */
async function checkSpotForAutoFlag(spotId) {
  try {
    // Count reports for this spot in the last 24 hours
    const recentReports = await db.collection("spotReports")
      .where("spotId", "==", spotId)
      .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000))
      .get();

    const reportCount = recentReports.size;

    // Get all reports to analyze patterns
    const allReports = await db.collection("spotReports")
      .where("spotId", "==", spotId)
      .get();

    const totalReports = allReports.size;

    // Auto-flag criteria
    const shouldFlag =
      reportCount >= 3 || // 3+ reports in 24h
      totalReports >= 5 || // 5+ total reports
      await checkForConsensusReports(allReports.docs); // Multiple reports of same type

    if (shouldFlag) {
      await flagSpotForReview(spotId, {
        reason: "Multiple user reports",
        reportCount: totalReports,
        recentReportCount: reportCount
      });
    }

  } catch (error) {
    console.error(`Failed to check auto-flag for spot ${spotId}:`, error);
  }
}

/**
 * Check if there's consensus among reports
 */
async function checkForConsensusReports(reportDocs) {
  if (reportDocs.length < 2) return false;

  const reasonCounts = {};
  for (const doc of reportDocs) {
    const reason = doc.data().reason;
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  // If 2+ users report the same reason, consider it consensus
  return Object.values(reasonCounts).some(count => count >= 2);
}

/**
 * Flag a spot for manual review
 */
async function flagSpotForReview(spotId, flagData) {
  try {
    await db.doc(`spots/${spotId}`).update({
      verificationStatus: "FLAGGED",
      flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      flagReason: flagData.reason,
      flagMetadata: flagData
    });

    // Create admin notification
    await db.collection("adminNotifications").add({
      type: "SPOT_FLAGGED",
      spotId,
      priority: "HIGH",
      reason: flagData.reason,
      metadata: flagData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "PENDING"
    });

    console.log(`Spot ${spotId} flagged for review: ${flagData.reason}`);

  } catch (error) {
    console.error(`Failed to flag spot ${spotId}:`, error);
  }
}

/**
 * Update spot's report count
 */
async function updateSpotReportCount(spotId) {
  try {
    const spotRef = db.doc(`spots/${spotId}`);
    await spotRef.update({
      reportCount: admin.firestore.FieldValue.increment(1),
      lastReportedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error(`Failed to update report count for spot ${spotId}:`, error);
  }
}

/**
 * Analyze report patterns for suspicious activity
 */
async function analyzeReportPatterns(spotId, reportData) {
  try {
    const reporterId = reportData.reportedBy;

    // Check if reporter is submitting too many reports (potential abuse)
    const recentReportsByUser = await db.collection("spotReports")
      .where("reportedBy", "==", reporterId)
      .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000))
      .get();

    if (recentReportsByUser.size > 10) { // More than 10 reports in 24h
      console.warn(`User ${reporterId} may be abusing report system: ${recentReportsByUser.size} reports in 24h`);

      // Flag for admin review
      await db.collection("adminNotifications").add({
        type: "REPORT_ABUSE_SUSPECTED",
        userId: reporterId,
        reportCount: recentReportsByUser.size,
        priority: "MEDIUM",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "PENDING"
      });
    }

    // Check for coordinated reporting
    await checkForCoordinatedReporting(spotId, reportData);

  } catch (error) {
    console.error(`Failed to analyze report patterns for spot ${spotId}:`, error);
  }
}

/**
 * Check for coordinated reporting attacks
 */
async function checkForCoordinatedReporting(spotId, reportData) {
  try {
    // Get reports for this spot in the last hour
    const recentReports = await db.collection("spotReports")
      .where("spotId", "==", spotId)
      .where("createdAt", ">", new Date(Date.now() - 60 * 60 * 1000))
      .get();

    if (recentReports.size >= 3) { // 3+ reports in 1 hour
      const reports = recentReports.docs.map(doc => doc.data());

      // Check for suspicious patterns
      const reporters = reports.map(r => r.reportedBy);
      const uniqueReporters = new Set(reporters);

      // Check if all reports have same reason (might be coordinated)
      const reasons = reports.map(r => r.reason);
      const uniqueReasons = new Set(reasons);

      if (uniqueReasons.size === 1 && uniqueReporters.size >= 3) {
        console.warn(`Potential coordinated reporting detected for spot ${spotId}: ${reports.length} reports with same reason in 1 hour`);

        await db.collection("adminNotifications").add({
          type: "COORDINATED_REPORTING_SUSPECTED",
          spotId,
          reportCount: reports.length,
          reason: Array.from(uniqueReasons)[0],
          reporters: Array.from(uniqueReporters),
          priority: "HIGH",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: "PENDING"
        });
      }
    }

  } catch (error) {
    console.error(`Failed to check coordinated reporting for spot ${spotId}:`, error);
  }
}

/**
 * Notify admins of new report
 */
async function notifyAdminsOfReport(reportData, reportId) {
  try {
    // Only notify for serious reasons or high-priority spots
    const highPriorityReasons = ["DANGEROUS", "OFFENSIVE"];
    const shouldNotifyImmediately = highPriorityReasons.includes(reportData.reason);

    if (shouldNotifyImmediately) {
      await db.collection("adminNotifications").add({
        type: "URGENT_SPOT_REPORT",
        spotId: reportData.spotId,
        reportId,
        reason: reportData.reason,
        description: reportData.description,
        reportedBy: reportData.reportedBy,
        priority: "URGENT",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "PENDING"
      });

      console.log(`Urgent admin notification sent for report ${reportId} (reason: ${reportData.reason})`);
    }

  } catch (error) {
    console.error(`Failed to notify admins of report ${reportId}:`, error);
  }
}

/**
 * Admin function to review and resolve a report
 */
const resolveSpotReport = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { reportId, action, notes = "" } = data;

  if (!reportId || !action) {
    throw new functions.https.HttpsError("invalid-argument", "Report ID and action are required");
  }

  const validActions = ["DISMISS", "REMOVE_SPOT", "WARNING", "EDIT_SPOT"];
  if (!validActions.includes(action)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid action");
  }

  try {
    const reportRef = db.doc(`spotReports/${reportId}`);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Report not found");
    }

    const reportData = reportDoc.data();
    const spotId = reportData.spotId;

    // Update report status
    await reportRef.update({
      status: "REVIEWED",
      action,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: auth.uid,
      reviewNotes: notes
    });

    // Take action on the spot
    await executeReportAction(spotId, action, notes, auth.uid);

    // Log the admin action
    await db.collection("adminActionLogs").add({
      type: "REPORT_RESOLVED",
      reportId,
      spotId,
      action,
      notes,
      adminId: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Admin ${auth.uid} resolved report ${reportId} with action: ${action}`);

    return {
      success: true,
      message: `Report resolved with action: ${action}`
    };

  } catch (error) {
    if (error.code && error.code.startsWith('functions/')) {
      throw error;
    }
    console.error(`Failed to resolve report ${reportId}:`, error);
    throw new functions.https.HttpsError("internal", "Failed to resolve report");
  }
});

/**
 * Execute the action determined by admin review
 */
async function executeReportAction(spotId, action, notes, adminId) {
  const spotRef = db.doc(`spots/${spotId}`);

  switch (action) {
    case "REMOVE_SPOT":
      await spotRef.update({
        isActive: false,
        removedAt: admin.firestore.FieldValue.serverTimestamp(),
        removedBy: adminId,
        removalReason: notes || "Removed due to user reports"
      });
      break;

    case "WARNING":
      // Add warning to spot creator
      const spotDoc = await spotRef.get();
      if (spotDoc.exists) {
        const creatorId = spotDoc.data().createdBy;
        await db.collection("userWarnings").add({
          userId: creatorId,
          spotId,
          reason: notes || "Spot content violation",
          issuedBy: adminId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      break;

    case "EDIT_SPOT":
      // Mark spot for editing/correction
      await spotRef.update({
        needsCorrection: true,
        correctionNotes: notes,
        markedForCorrectionAt: admin.firestore.FieldValue.serverTimestamp(),
        markedBy: adminId
      });
      break;

    case "DISMISS":
      // No action needed - report was invalid
      break;
  }
}

/**
 * Get reports for admin dashboard
 */
const getSpotReports = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { status = "PENDING", limit = 20, startAfter = null } = data || {};

  try {
    let query = db.collection("spotReports")
      .where("status", "==", status)
      .orderBy("createdAt", "desc")
      .limit(limit);

    if (startAfter) {
      const startAfterDoc = await db.doc(`spotReports/${startAfter}`).get();
      query = query.startAfter(startAfterDoc);
    }

    const reportsSnapshot = await query.get();
    const reports = [];

    for (const doc of reportsSnapshot.docs) {
      const reportData = doc.data();

      // Get spot information
      const spotDoc = await db.doc(`spots/${reportData.spotId}`).get();
      const spotData = spotDoc.exists ? spotDoc.data() : null;

      reports.push({
        id: doc.id,
        ...reportData,
        spot: spotData ? {
          title: spotData.title,
          verificationStatus: spotData.verificationStatus,
          reportCount: spotData.reportCount || 0
        } : null
      });
    }

    return {
      reports,
      hasMore: reportsSnapshot.size === limit
    };

  } catch (error) {
    console.error(`Failed to get spot reports:`, error);
    throw new functions.https.HttpsError("internal", "Failed to get reports");
  }
});

// ================================
// TIER 4: NOTIFICATIONS FUNCTIONS
// ================================

/**
 * Send broadcast notification to all users
 */
const sendBroadcastNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { title, body, data: notificationData = {} } = data;

  if (!title || !body) {
    throw new functions.https.HttpsError("invalid-argument", "Title and body are required");
  }

  try {
    // Create broadcast notification document
    const notificationRef = await db.collection('notifications').add({
      title,
      body,
      data: notificationData,
      type: 'broadcast',
      createdBy: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    // Send to all users with FCM tokens
    const usersSnapshot = await db.collection('users').where('fcmToken', '!=', null).get();
    const tokens = [];

    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      if (userData.fcmToken && userData.isActive !== false) {
        tokens.push(userData.fcmToken);
      }
    });

    if (tokens.length > 0) {
      const payload = { notification: { title, body }, data: notificationData };
      await admin.messaging().sendMulticast({ tokens, ...payload });
    }

    // Mark as sent
    await notificationRef.update({ sent: true, sentCount: tokens.length });

    return { success: true, sentTo: tokens.length };
  } catch (error) {
    console.error('Broadcast notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send broadcast notification');
  }
});

/**
 * Send notification to users in a specific city
 */
const sendCityNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { title, body, city, data: notificationData = {} } = data;

  if (!title || !body || !city) {
    throw new functions.https.HttpsError("invalid-argument", "Title, body, and city are required");
  }

  try {
    // Create city notification document
    const notificationRef = await db.collection('notifications').add({
      title,
      body,
      data: notificationData,
      type: 'city',
      targetCity: city,
      createdBy: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    // Send to users in the specified city
    const usersSnapshot = await db.collection('users')
      .where('city', '==', city)
      .where('fcmToken', '!=', null)
      .get();

    const tokens = [];
    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      if (userData.fcmToken && userData.isActive !== false) {
        tokens.push(userData.fcmToken);
      }
    });

    if (tokens.length > 0) {
      const payload = { notification: { title, body }, data: notificationData };
      await admin.messaging().sendMulticast({ tokens, ...payload });
    }

    // Mark as sent
    await notificationRef.update({ sent: true, sentCount: tokens.length });

    return { success: true, sentTo: tokens.length };
  } catch (error) {
    console.error('City notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send city notification');
  }
});

/**
 * Send notification to a single user
 */
const sendSingleNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { title, body, targetUserId, data: notificationData = {} } = data;

  if (!title || !body || !targetUserId) {
    throw new functions.https.HttpsError("invalid-argument", "Title, body, and targetUserId are required");
  }

  try {
    const notificationRef = await db.collection('notifications').add({
      title,
      body,
      data: notificationData,
      type: 'single',
      targetUserId,
      createdBy: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    return await sendSingleNotificationInternal(notificationRef.id, targetUserId, { title, body, data: notificationData });
  } catch (error) {
    console.error('Single notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send notification');
  }
});

/**
 * Internal helper to send notification to single user
 */
async function sendSingleNotificationInternal(notificationId, userId, payload) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      throw new Error('User not found');
    }

    const userData = userDoc.data();

    if (!userData.fcmToken) {
      await db.collection('notifications').doc(notificationId).update({
        sent: true,
        error: 'No FCM token'
      });
      return { success: false, error: 'User has no FCM token' };
    }

    await admin.messaging().send({
      token: userData.fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: payload.data || {}
    });

    await db.collection('notifications').doc(notificationId).update({ sent: true });

    return { success: true };
  } catch (error) {
    console.error('Send single notification internal failed:', error);
    await db.collection('notifications').doc(notificationId).update({
      sent: true,
      error: error.message
    });
    throw error;
  }
}

/**
 * Send custom notification with advanced targeting
 */
const sendCustomNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const {
    title,
    body,
    criteria = {},
    data: notificationData = {}
  } = data;

  if (!title || !body) {
    throw new functions.https.HttpsError("invalid-argument", "Title and body are required");
  }

  try {
    // Build query based on criteria
    let query = db.collection('users').where('fcmToken', '!=', null);

    if (criteria.city) {
      query = query.where('city', '==', criteria.city);
    }
    if (criteria.minLevel) {
      query = query.where('level', '>=', criteria.minLevel);
    }
    if (criteria.hasVerifiedSpots) {
      query = query.where('verifiedSpotCount', '>', 0);
    }

    const usersSnapshot = await query.get();
    const tokens = [];

    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      if (userData.fcmToken && userData.isActive !== false) {
        tokens.push(userData.fcmToken);
      }
    });

    if (tokens.length > 0) {
      const payload = { notification: { title, body }, data: notificationData };
      await admin.messaging().sendMulticast({ tokens, ...payload });
    }

    // Create notification record
    await db.collection('notifications').add({
      title,
      body,
      data: notificationData,
      type: 'custom',
      criteria,
      createdBy: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: true,
      sentCount: tokens.length
    });

    return { success: true, sentTo: tokens.length };
  } catch (error) {
    console.error('Custom notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send custom notification');
  }
});

/**
 * Send spot approval notification
 */
const sendSpotApprovalNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { userId, spotTitle } = data;

  if (!userId || !spotTitle) {
    throw new functions.https.HttpsError("invalid-argument", "userId and spotTitle are required");
  }

  try {
    return await sendSpotApprovalNotificationInternal(userId, spotTitle);
  } catch (error) {
    console.error('Spot approval notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send spot approval notification');
  }
});

/**
 * Send reward approval notification
 */
const sendRewardApprovalNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { userId, rewardTitle } = data;

  if (!userId || !rewardTitle) {
    throw new functions.https.HttpsError("invalid-argument", "userId and rewardTitle are required");
  }

  try {
    const payload = {
      title: 'Reward Approved! 🎁',
      body: `Your reward "${rewardTitle}" has been approved and is now available!`,
      data: {
        type: 'reward_approval',
        rewardTitle
      }
    };

    const notificationRef = await db.collection('notifications').add({
      title: payload.title,
      body: payload.body,
      type: 'single',
      targetUserId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    return await sendSingleNotificationInternal(notificationRef.id, userId, payload);
  } catch (error) {
    console.error('Reward approval notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send reward approval notification');
  }
});

/**
 * Send spot rejection notification
 */
const sendSpotRejectionNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { userId, spotTitle, reason } = data;

  if (!userId || !spotTitle) {
    throw new functions.https.HttpsError("invalid-argument", "userId and spotTitle are required");
  }

  try {
    return await sendSpotRejectionNotificationInternal(userId, spotTitle, reason);
  } catch (error) {
    console.error('Spot rejection notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send spot rejection notification');
  }
});

/**
 * Send reward rejection notification
 */
const sendRewardRejectionNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { userId, rewardTitle, reason } = data;

  if (!userId || !rewardTitle) {
    throw new functions.https.HttpsError("invalid-argument", "userId and rewardTitle are required");
  }

  try {
    const payload = {
      title: 'Reward Submission Update 📋',
      body: `Your reward "${rewardTitle}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
      data: {
        type: 'reward_rejection',
        rewardTitle,
        reason: reason || ''
      }
    };

    const notificationRef = await db.collection('notifications').add({
      title: payload.title,
      body: payload.body,
      type: 'single',
      targetUserId: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    return await sendSingleNotificationInternal(notificationRef.id, userId, payload);
  } catch (error) {
    console.error('Reward rejection notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send reward rejection notification');
  }
});

/**
 * Send new city content notification
 */
const sendNewCityContentNotification = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  const { city, contentType, count = 1 } = data;

  if (!city || !contentType) {
    throw new functions.https.HttpsError("invalid-argument", "city and contentType are required");
  }

  try {
    const title = 'New Content in Your City! 🏙️';
    const body = `${count} new ${contentType}${count > 1 ? 's' : ''} added in ${city}. Check them out!`;

    const payload = {
      title,
      body,
      data: {
        type: 'new_city_content',
        city,
        contentType,
        count: count.toString()
      }
    };

    const notificationRef = await db.collection('notifications').add({
      title,
      body,
      type: 'city',
      targetCity: city,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      sent: false
    });

    // Send to users in the city
    const usersSnapshot = await db.collection('users')
      .where('city', '==', city)
      .where('fcmToken', '!=', null)
      .get();

    const tokens = [];
    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      if (userData.fcmToken && userData.isActive !== false) {
        tokens.push(userData.fcmToken);
      }
    });

    if (tokens.length > 0) {
      await admin.messaging().sendMulticast({
        tokens,
        notification: { title, body },
        data: payload.data
      });
    }

    await notificationRef.update({ sent: true, sentCount: tokens.length });

    return { success: true, sentTo: tokens.length };
  } catch (error) {
    console.error('New city content notification failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send new city content notification');
  }
});

/**
 * Clean up invalid FCM tokens
 */
const cleanupInvalidTokens = functions.https.onCall(async (request) => {
  const { auth } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  try {
    const usersSnapshot = await db.collection('users').where('fcmToken', '!=', null).get();
    let cleanedCount = 0;
    const batch = db.batch();

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();

      if (userData.fcmToken) {
        try {
          // Test if token is valid by sending a test message
          await admin.messaging().send({
            token: userData.fcmToken,
            data: { test: 'true' },
            dryRun: true // Don't actually send, just validate
          });
        } catch (error) {
          if (error.code === 'messaging/registration-token-not-registered' ||
              error.code === 'messaging/invalid-registration-token') {
            // Remove invalid token
            batch.update(userDoc.ref, { fcmToken: admin.firestore.FieldValue.delete() });
            cleanedCount++;
          }
        }
      }
    }

    if (cleanedCount > 0) {
      await batch.commit();
    }

    return { success: true, cleanedCount };
  } catch (error) {
    console.error('Token cleanup failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to cleanup tokens');
  }
});

// ================================
// TIER 5: ANALYTICS & CLEANUP FUNCTIONS
// ================================

/**
 * Trigger: When a reward is redeemed
 */
const onRewardRedeemed = firestore.document('redemptions/{redemptionId}').onCreate(async (snapshot) => {
  try {
    const redemptionData = snapshot.data();
    const { userId, sponsorId, rewardId, xpCost } = redemptionData;

    console.log(`Reward redeemed: User ${userId} redeemed reward ${rewardId} from sponsor ${sponsorId} for ${xpCost} XP`);

    // Update sponsor stats
    await db.collection('sponsors').doc(sponsorId).update({
      'stats.totalRedemptions': admin.firestore.FieldValue.increment(1),
      'stats.totalXPAwarded': admin.firestore.FieldValue.increment(xpCost),
      lastRedemptionAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update global analytics
    await db.collection('analytics').doc('global').update({
      'totalRedemptions': admin.firestore.FieldValue.increment(1),
      'totalXPRedeemed': admin.firestore.FieldValue.increment(xpCost),
      'lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });

    return null;
  } catch (error) {
    console.error('Error processing reward redemption:', error);
    return null;
  }
});

/**
 * Trigger: When a spot is written/updated
 */
const onSpotWrite = firestore.document('spots/{spotId}').onWrite(async (change) => {
  try {
    const spotId = change.after.id;
    const newData = change.after.data();
    const oldData = change.before.data();

    // Only process if document exists
    if (!newData) return null;

    // Check if this is a new spot creation
    if (!oldData) {
      console.log(`New spot created: ${spotId} by user ${newData.createdBy}`);

      // Update user's spot count
      await db.collection('users').doc(newData.createdBy).update({
        'stats.spotsSubmitted': admin.firestore.FieldValue.increment(1)
      });

      // Update global analytics
      await db.collection('analytics').doc('global').update({
        'totalSpots': admin.firestore.FieldValue.increment(1),
        'lastUpdated': admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Check if verification status changed to approved
    if (oldData && oldData.verificationStatus !== 'VERIFIED' && newData.verificationStatus === 'VERIFIED') {
      console.log(`Spot verified: ${spotId}`);

      // Update user's verified spots count
      await db.collection('users').doc(newData.createdBy).update({
        'stats.verifiedSpotCount': admin.firestore.FieldValue.increment(1)
      });

      // Send approval notification
      await sendSpotApprovalNotificationInternal(newData.createdBy, newData.title || 'Your spot');
    }

    // Check if verification status changed to rejected
    if (oldData && oldData.verificationStatus !== 'REJECTED' && newData.verificationStatus === 'REJECTED') {
      console.log(`Spot rejected: ${spotId}`);

      // Send rejection notification
      await sendSpotRejectionNotificationInternal(
        newData.createdBy,
        newData.title || 'Your spot',
        newData.rejectionReason || ''
      );
    }

    return null;
  } catch (error) {
    console.error('Error processing spot write:', error);
    return null;
  }
});

/**
 * Migrate existing spots to include geohashes
 */
const migrateSpotGeohashes = functions.https.onCall(async (request) => {
  const { auth } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  try {
    const geohash = require('ngeohash');
    let migrated = 0;
    let processed = 0;

    // Process spots in batches
    const batchSize = 100;
    const spotsRef = db.collection('spots');
    let query = spotsRef.limit(batchSize);

    while (true) {
      const spotsSnapshot = await query.get();

      if (spotsSnapshot.empty) break;

      const batch = db.batch();
      let hasUpdates = false;

      for (const spotDoc of spotsSnapshot.docs) {
        const spotData = spotDoc.data();
        processed++;

        // Check if geohash is missing but coordinates exist
        if (!spotData.geohash && spotData.latitude && spotData.longitude) {
          const lat = spotData.latitude;
          const lng = spotData.longitude;

          if (typeof lat === 'number' && typeof lng === 'number' &&
              lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {

            const spotGeohash = geohash.encode(lat, lng, 7);
            batch.update(spotDoc.ref, { geohash: spotGeohash });
            migrated++;
            hasUpdates = true;
          }
        }
      }

      if (hasUpdates) {
        await batch.commit();
      }

      // Continue with next batch
      if (spotsSnapshot.size === batchSize) {
        const lastDoc = spotsSnapshot.docs[spotsSnapshot.docs.length - 1];
        query = spotsRef.startAfter(lastDoc).limit(batchSize);
      } else {
        break;
      }
    }

    return { success: true, processed, migrated };
  } catch (error) {
    console.error('Geohash migration failed:', error);
    throw new functions.https.HttpsError('internal', 'Migration failed');
  }
});

/**
 * Get nearby spots using geohash
 */
const getNearbySpots = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { latitude, longitude, radius = 10 } = data;

  if (!latitude || !longitude) {
    throw new functions.https.HttpsError("invalid-argument", "Latitude and longitude are required");
  }

  try {
    const geohash = require('ngeohash');

    // Calculate geohash neighbors for the search area
    const centerHash = geohash.encode(latitude, longitude, 6);
    const neighbors = geohash.neighbors(centerHash);
    const searchHashes = [centerHash, ...Object.values(neighbors)];

    // Query spots with matching geohash prefixes
    const spotsPromises = searchHashes.map(hash =>
      db.collection('spots')
        .where('geohash', '>=', hash)
        .where('geohash', '<', hash + '~')
        .where('verificationStatus', '==', 'VERIFIED')
        .where('isActive', '==', true)
        .limit(50)
        .get()
    );

    const results = await Promise.all(spotsPromises);
    const spotsMap = new Map();

    // Combine results and remove duplicates
    results.forEach(snapshot => {
      snapshot.forEach(doc => {
        if (!spotsMap.has(doc.id)) {
          const spotData = doc.data();

          // Calculate actual distance
          const distance = calculateDistance(
            latitude, longitude,
            spotData.latitude, spotData.longitude
          );

          if (distance <= radius) {
            spotsMap.set(doc.id, {
              id: doc.id,
              ...spotData,
              distance: Math.round(distance * 100) / 100 // Round to 2 decimals
            });
          }
        }
      });
    });

    // Convert to array and sort by distance
    const nearbySpots = Array.from(spotsMap.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20); // Limit to 20 spots

    return { spots: nearbySpots, count: nearbySpots.length };
  } catch (error) {
    console.error('Get nearby spots failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get nearby spots');
  }
});

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
}

/**
 * Award XP to user
 */
const awardXP = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { userId, amount, reason, metadata = {} } = data;

  if (!userId || !amount || !reason) {
    throw new functions.https.HttpsError("invalid-argument", "userId, amount, and reason are required");
  }

  if (typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError("invalid-argument", "Amount must be a positive number");
  }

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      const currentXP = userData.xp || 0;
      const newXP = currentXP + amount;
      const newLevel = calculateLevel(newXP);
      const oldLevel = calculateLevel(currentXP);

      // Update user XP
      transaction.update(userRef, {
        xp: newXP,
        level: newLevel,
        lastXPUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      // Create XP history record
      const xpHistoryRef = db.collection('xpHistory').doc();
      transaction.set(xpHistoryRef, {
        userId,
        amount,
        reason,
        metadata,
        previousXP: currentXP,
        newXP,
        awardedBy: auth.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        previousXP: currentXP,
        newXP,
        awardedAmount: amount,
        leveledUp: newLevel > oldLevel,
        newLevel
      };
    });

    return result;
  } catch (error) {
    console.error('Award XP failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to award XP');
  }
});


/**
 * Create secure reward
 */
const createRewardSecure = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check if user is a sponsor
  const sponsorDoc = await db.collection('sponsors').doc(auth.uid).get();
  if (!sponsorDoc.exists) {
    throw new functions.https.HttpsError("permission-denied", "Only sponsors can create rewards");
  }

  const {
    title,
    description,
    xpCost,
    category = 'general',
    isLimited = false,
    limitCount = 0,
    expiryDate = null
  } = data;

  if (!title || !description || !xpCost) {
    throw new functions.https.HttpsError("invalid-argument", "Title, description, and xpCost are required");
  }

  if (typeof xpCost !== 'number' || xpCost <= 0) {
    throw new functions.https.HttpsError("invalid-argument", "XP cost must be a positive number");
  }

  try {
    const sponsorData = sponsorDoc.data();

    const rewardData = {
      title: title.substring(0, 100),
      description: description.substring(0, 500),
      xpCost,
      category,
      sponsorId: auth.uid,
      sponsorName: sponsorData.name || 'Unknown Sponsor',
      isLimited,
      limitCount: isLimited ? limitCount : 0,
      redeemedCount: 0,
      isActive: true,
      verificationStatus: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiryDate: expiryDate ? new Date(expiryDate) : null
    };

    const rewardRef = await db.collection('rewards').add(rewardData);

    return {
      success: true,
      rewardId: rewardRef.id,
      message: 'Reward created successfully and pending approval'
    };
  } catch (error) {
    console.error('Create reward failed:', error);
    throw new functions.https.HttpsError('internal', 'Failed to create reward');
  }
});

/**
 * Legacy reward redemption function
 */
const redeemRewardLegacy = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { rewardId } = data;

  if (!rewardId) {
    throw new functions.https.HttpsError("invalid-argument", "Reward ID is required");
  }

  try {
    // Use the existing redemption logic but with legacy handling
    return await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(auth.uid);
      const rewardRef = db.collection('rewards').doc(rewardId);

      const [userDoc, rewardDoc] = await Promise.all([
        transaction.get(userRef),
        transaction.get(rewardRef)
      ]);

      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      if (!rewardDoc.exists) {
        throw new Error('Reward not found');
      }

      const userData = userDoc.data();
      const rewardData = rewardDoc.data();

      // Validate reward is active and verified
      if (!rewardData.isActive || rewardData.verificationStatus !== 'VERIFIED') {
        throw new Error('Reward is not available for redemption');
      }

      // Check user has enough XP
      const userXP = userData.xp || 0;
      if (userXP < rewardData.xpCost) {
        throw new Error('Insufficient XP');
      }

      // Check if reward is limited and still available
      if (rewardData.isLimited && rewardData.redeemedCount >= rewardData.limitCount) {
        throw new Error('Reward limit reached');
      }

      // Check if reward has expired
      if (rewardData.expiryDate && rewardData.expiryDate.toDate() < new Date()) {
        throw new Error('Reward has expired');
      }

      // Create redemption record
      const redemptionRef = db.collection('redemptions').doc();
      transaction.set(redemptionRef, {
        userId: auth.uid,
        rewardId,
        sponsorId: rewardData.sponsorId,
        xpCost: rewardData.xpCost,
        rewardTitle: rewardData.title,
        status: 'PENDING',
        redeemedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Deduct XP from user
      transaction.update(userRef, {
        xp: admin.firestore.FieldValue.increment(-rewardData.xpCost)
      });

      // Update reward redeemed count
      transaction.update(rewardRef, {
        redeemedCount: admin.firestore.FieldValue.increment(1),
        lastRedeemedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        redemptionId: redemptionRef.id,
        xpDeducted: rewardData.xpCost,
        message: 'Reward redeemed successfully'
      };
    });
  } catch (error) {
    console.error('Legacy reward redemption failed:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Redemption failed');
  }
});

/**
 * Search users function
 */
const searchUsers = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { query, limit = 20 } = data;

  if (!query || query.length < 2) {
    throw new functions.https.HttpsError("invalid-argument", "Query must be at least 2 characters");
  }

  try {
    const searchQuery = query.toLowerCase();

    // Search by search tokens (for partial matching)
    const usersSnapshot = await db.collection('users')
      .where('searchTokens', 'array-contains-any', [searchQuery, searchQuery.substring(0, 3)])
      .where('isActive', '==', true)
      .limit(limit)
      .get();

    const users = [];
    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      users.push({
        id: doc.id,
        username: userData.username,
        displayName: userData.displayName || userData.username,
        profilePicture: userData.profilePicture || null,
        level: userData.level || 1,
        city: userData.city || 'Unknown'
      });
    });

    return { users, count: users.length };
  } catch (error) {
    console.error('User search failed:', error);
    throw new functions.https.HttpsError('internal', 'Search failed');
  }
});

/**
 * Generate search tokens for existing users
 */
const generateSearchTokensForExistingUsers = functions.https.onCall(async (request) => {
  const { auth } = request;

  if (!auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }

  try {
    let processed = 0;
    let updated = 0;

    // Process users in batches
    const batchSize = 100;
    const usersRef = db.collection('users');
    let query = usersRef.limit(batchSize);

    while (true) {
      const usersSnapshot = await query.get();

      if (usersSnapshot.empty) break;

      const batch = db.batch();
      let hasUpdates = false;

      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        processed++;

        // Generate search tokens if missing or empty
        if (!userData.searchTokens || userData.searchTokens.length === 0) {
          const searchTokens = generateSearchTokens(userData.username || '', userData.displayName || '');
          batch.update(userDoc.ref, { searchTokens });
          updated++;
          hasUpdates = true;
        }
      }

      if (hasUpdates) {
        await batch.commit();
      }

      // Continue with next batch
      if (usersSnapshot.size === batchSize) {
        const lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
        query = usersRef.startAfter(lastDoc).limit(batchSize);
      } else {
        break;
      }
    }

    return { success: true, processed, updated };
  } catch (error) {
    console.error('Search tokens generation failed:', error);
    throw new functions.https.HttpsError('internal', 'Token generation failed');
  }
});


// ================================
// CRITICAL MISSING FUNCTIONS
// ================================

/**
 * BUSINESS CRITICAL: Send challenge reminder notifications for active challenges
 * Scheduled function that runs daily at 10:00 AM UTC
 */
const sendChallengeReminders = pubsub.schedule('0 10 * * *').onRun(async (context) => {
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

        const payload = {
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
  } catch (error) {
    console.error('Error sending challenge reminders:', error);
    return null;
  }
});

/**
 * BUSINESS CRITICAL: Auto-flag inappropriate spot ratings
 * Content moderation for spot reviews
 */
const autoFlagSpotRating = firestore
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
    } catch (error) {
      console.error('Error in autoFlagSpotRating:', error);
    }
  });

/**
 * BUSINESS CRITICAL: Auto-flag inappropriate sponsor ratings
 * Content moderation for sponsor reviews
 */
const autoFlagSponsorRating = firestore
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
    } catch (error) {
      console.error('Error in autoFlagSponsorRating:', error);
    }
  });

/**
 * Helper function to check for inappropriate content
 */
function containsInappropriateContent(text) {
  if (!text) return { flagged: false };

  const lowerText = text.toLowerCase();

  // List of profanity and inappropriate words to flag
  const PROFANITY_LIST = [
    'fuck', 'shit', 'damn', 'bitch', 'asshole', 'bastard', 'crap',
    'scam', 'fake', 'fraud', 'spam', 'worthless', 'terrible'
  ];

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
 * BUSINESS CRITICAL: Firestore trigger - Notify users when new rewards are added
 * Boosts user engagement and reward redemption rates
 */
const onNewRewardCreated = firestore
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

      const payload = {
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

        const userNotificationData = {
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

    } catch (error) {
      console.error('Error sending new reward notification:', error);
      return null;
    }
  });

/**
 * BUSINESS CRITICAL: Firestore trigger - Notify users when new sponsors are added
 * Improves sponsor visibility and user engagement
 */
const onNewSponsorCreated = firestore
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

      const payload = {
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

        const userNotificationData = {
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

    } catch (error) {
      console.error('Error sending new sponsor notification:', error);
      return null;
    }
  });

/**
 * BUSINESS CRITICAL: Firestore trigger - Notify users when new challenges are added
 * Boosts challenge participation and user engagement
 */
const onNewChallengeCreated = firestore
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

      const difficultyEmojis = {
        'EASY': '🟢',
        'MEDIUM': '🟡',
        'HARD': '🔴',
        'EXPERT': '🟣'
      };

      const payload = {
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

        const userNotificationData = {
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

    } catch (error) {
      console.error('Error sending new challenge notification:', error);
      return null;
    }
  });

/**
 * CRITICAL DATA MIGRATION: Migrate users to add geohash field based on their location
 */
const migrateUserGeohashes = functions.https.onCall(async (request) => {
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
    const errorDetails = [];
    let lastProcessedId;

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
        let latitude = null;
        let longitude = null;

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

      } catch (error) {
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

  } catch (error) {
    console.error('Error in user geohash migration:', error);
    return {
      success: false,
      processed: 0,
      updated: 0,
      errors: 1,
      errorDetails: [error.message]
    };
  }
});

// ================================
// ADMIN DASHBOARD FUNCTIONS
// ================================

/**
 * Get recent activities for admin dashboard
 */
const getRecentActivities = functions.https.onCall(async (request) => {
  const { auth } = request;

  if (!auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  try {
    const activities = [];

    // Get recent spots (last 10)
    const spotsSnapshot = await db.collection('spots')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();

    spotsSnapshot.forEach(doc => {
      const data = doc.data();
      activities.push({
        id: doc.id,
        type: 'spot',
        action: 'created',
        title: data.title,
        user: data.createdBy,
        timestamp: data.createdAt,
        status: data.verificationStatus || 'PENDING'
      });
    });

    // Get recent rewards (last 5)
    const rewardsSnapshot = await db.collection('rewards')
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    rewardsSnapshot.forEach(doc => {
      const data = doc.data();
      activities.push({
        id: doc.id,
        type: 'reward',
        action: 'created',
        title: data.title,
        sponsor: data.sponsorId,
        timestamp: data.createdAt,
        status: data.verificationStatus || 'PENDING'
      });
    });

    // Sort all activities by timestamp
    activities.sort((a, b) => {
      const aTime = a.timestamp?.toMillis ? a.timestamp.toMillis() : a.timestamp;
      const bTime = b.timestamp?.toMillis ? b.timestamp.toMillis() : b.timestamp;
      return bTime - aTime;
    });

    return { activities: activities.slice(0, 15) };

  } catch (error) {
    console.error('Error fetching recent activities:', error);
    throw new functions.https.HttpsError('internal', 'Failed to fetch recent activities');
  }
});

/**
 * Get dashboard statistics and data
 */
const getDashboardData = functions.https.onCall(async (request) => {
  const { auth } = request;

  if (!auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  // Check admin permissions
  const isAdmin = await checkAdminPermissions(auth.uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  try {
    const stats = {
      users: 0,
      spots: 0,
      rewards: 0,
      pendingSpots: 0,
      pendingRewards: 0,
      totalXP: 0
    };

    // Count users
    const usersSnapshot = await db.collection('users').count().get();
    stats.users = usersSnapshot.data().count;

    // Count spots
    const spotsSnapshot = await db.collection('spots').count().get();
    stats.spots = spotsSnapshot.data().count;

    // Count pending spots
    const pendingSpotsSnapshot = await db.collection('spots')
      .where('verificationStatus', 'in', ['PENDING', 'FLAGGED'])
      .count()
      .get();
    stats.pendingSpots = pendingSpotsSnapshot.data().count;

    // Count rewards
    const rewardsSnapshot = await db.collection('rewards').count().get();
    stats.rewards = rewardsSnapshot.data().count;

    // Count pending rewards
    const pendingRewardsSnapshot = await db.collection('rewards')
      .where('verificationStatus', 'in', ['PENDING', 'FLAGGED'])
      .count()
      .get();
    stats.pendingRewards = pendingRewardsSnapshot.data().count;

    // Get analytics data if it exists
    const analyticsDoc = await db.collection('analytics').doc('global').get();
    if (analyticsDoc.exists) {
      const analyticsData = analyticsDoc.data();
      stats.totalXP = analyticsData.totalXPAwarded || 0;
    }

    return { stats };

  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    throw new functions.https.HttpsError('internal', 'Failed to fetch dashboard data');
  }
});

/**
 * Update user login source (for analytics)
 */
const updateUserLoginSource = functions.https.onCall(async (request) => {
  const { auth, data } = request;

  if (!auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { loginSource } = data;

  if (!loginSource) {
    throw new functions.https.HttpsError('invalid-argument', 'loginSource is required');
  }

  try {
    // Update user document with login source
    await db.collection('users').doc(auth.uid).update({
      lastLoginSource: loginSource,
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true };

  } catch (error) {
    console.error('Error updating login source:', error);
    // Don't throw error for this non-critical operation
    return { success: false, message: error.message };
  }
});

// Export all functions to make them deployable
module.exports = {
  ...socialFunctions,
  migrateSponsorCategories,
  // API
  api,
  // TIER 1: Critical Functions
  verifySpotSubmission,
  adjustUserXP,
  // QR Code Functions
  redeemByQR,
  validateQRCode,
  validateRedemption,
  generateSponsorQR,
  regenerateSponsorQR,
  updateQRSettings,
  getQRStats,
  initializeSponsorQRSecrets,
  // TIER 3: Moderation and Reports Functions
  reportSpot,
  processSpotReport,
  resolveSpotReport,
  getSpotReports,
  // Notifications
  sendBroadcastNotification,
  sendCityNotification,
  sendSingleNotification,
  sendCustomNotification,
  sendSpotApprovalNotification,
  sendRewardApprovalNotification,
  sendSpotRejectionNotification,
  sendRewardRejectionNotification,
  sendNewCityContentNotification,
  cleanupInvalidTokens,
  // Triggers
  onRewardRedeemed,
  onSpotWrite,
  // Geolocation
  migrateSpotGeohashes,
  getNearbySpots,
  // XP Management
  awardXP,
  adminGrantXP,
  // Rewards
  createRewardSecure,
  redeemRewardLegacy,
  // Search
  searchUsers,
  generateSearchTokensForExistingUsers,
  generateSearchTokensOnUserUpdate,
  // Admin Dashboard
  getRecentActivities,
  getDashboardData,
  updateUserLoginSource,
};