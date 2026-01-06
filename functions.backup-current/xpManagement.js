const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");

/**
 * XP MANAGEMENT SYSTEM WITH VERIFICATION INTEGRATION
 *
 * Manages XP awarding with verification states:
 * - XP is held in pending state until spot is approved
 * - XP is released when spot is auto-approved or manually approved
 * - XP is denied when spot is rejected
 * - Prevents duplicate XP awards and manipulation
 */

/**
 * Release pending XP when spot verification status changes
 */
exports.handleSpotVerificationUpdate = onDocumentUpdated(
  {
    document: "spots/{spotId}",
    region: "us-central1"
  },
  async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    const spotId = event.params.spotId;

    // Only process if verification status changed
    if (beforeData.verificationStatus === afterData.verificationStatus) {
      return;
    }

    const newStatus = afterData.verificationStatus;
    const userId = afterData.createdBy;
    const xpAmount = afterData.xpReward || 100;

    logger.info(`Spot ${spotId} verification status changed to: ${newStatus}`);

    const db = getFirestore();

    try {
      if (newStatus === "AUTO_APPROVED" || newStatus === "APPROVED") {
        // Release XP to user
        await releaseSpotXP(db, userId, spotId, xpAmount, `Spot approved: ${afterData.title}`);

        // Mark spot as XP released
        await db.doc(`spots/${spotId}`).update({
          xpReleased: true,
          xpReleasedAt: FieldValue.serverTimestamp()
        });

        logger.info(`Released ${xpAmount} XP to user ${userId} for approved spot ${spotId}`);

      } else if (newStatus === "REJECTED") {
        // Deny XP - log the denial
        await logXPDenial(db, userId, spotId, xpAmount, "Spot rejected during verification");

        // Update spot to mark XP as denied
        await db.doc(`spots/${spotId}`).update({
          xpDenied: true,
          xpDeniedAt: FieldValue.serverTimestamp(),
          xpDenialReason: "Spot verification failed"
        });

        logger.info(`Denied ${xpAmount} XP to user ${userId} for rejected spot ${spotId}`);
      }

    } catch (error) {
      logger.error(`Failed to handle XP for spot ${spotId}:`, error);
    }
  }
);

/**
 * Secure XP awarding function - callable from client
 */
exports.awardXP = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const { action, amount, metadata = {} } = data;
    const userId = auth.uid;

    if (!action || !amount || amount <= 0) {
      throw new HttpsError("invalid-argument", "Invalid XP award parameters");
    }

    // Validate XP amount limits
    const MAX_XP_AMOUNTS = {
      "VISIT_SPOT": 50,
      "RATE_SPOT": 25,
      "COMPLETE_CHALLENGE": 200,
      "DAILY_LOGIN": 10,
      "SHARE_SPOT": 15,
      "PHOTO_UPLOAD": 30
    };

    if (amount > (MAX_XP_AMOUNTS[action] || 100)) {
      throw new HttpsError("invalid-argument", `XP amount exceeds maximum for action: ${action}`);
    }

    const db = getFirestore();

    try {
      // Check for duplicate awards (idempotency)
      if (metadata.spotId || metadata.challengeId) {
        const duplicateCheck = await checkForDuplicateAward(
          db,
          userId,
          action,
          metadata.spotId || metadata.challengeId
        );

        if (duplicateCheck.exists) {
          logger.warn(`Duplicate XP award prevented for user ${userId}, action ${action}`);
          return { success: false, reason: "Already awarded", xp: duplicateCheck.amount };
        }
      }

      // Award XP immediately for approved actions
      const result = await awardUserXP(db, userId, action, amount, metadata);

      logger.info(`Awarded ${amount} XP to user ${userId} for action: ${action}`);

      return {
        success: true,
        xpAwarded: amount,
        totalXP: result.newTotalXP,
        newLevel: result.newLevel,
        leveledUp: result.leveledUp
      };

    } catch (error) {
      logger.error(`XP award failed for user ${userId}:`, error);
      throw new HttpsError("internal", "Failed to award XP");
    }
  }
);

/**
 * Release pending XP for approved spots
 */
async function releaseSpotXP(db, userId, spotId, amount, description) {
  return await db.runTransaction(async (transaction) => {
    const userRef = db.doc(`users/${userId}`);
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const userData = userDoc.data();
    const currentXP = userData.xpPoints || 0;
    const pendingXP = userData.xpPending || 0;
    const newTotalXP = currentXP + amount;
    const newPendingXP = Math.max(0, pendingXP - amount);

    // Calculate level progression
    const currentLevel = calculateLevel(currentXP);
    const newLevel = calculateLevel(newTotalXP);
    const leveledUp = newLevel > currentLevel;

    // Update user document
    transaction.update(userRef, {
      xpPoints: newTotalXP,
      xpPending: newPendingXP,
      level: newLevel,
      lastActiveAt: FieldValue.serverTimestamp()
    });

    // Log the XP transaction
    transaction.create(db.collection("xpTransactions").doc(), {
      userId,
      action: "SPOT_APPROVED",
      amount,
      description,
      spotId,
      previousXP: currentXP,
      newXP: newTotalXP,
      previousLevel: currentLevel,
      newLevel: newLevel,
      leveledUp,
      timestamp: FieldValue.serverTimestamp(),
      type: "AWARD"
    });

    return { newTotalXP, newLevel, leveledUp };
  });
}

/**
 * Award XP for various user actions
 */
async function awardUserXP(db, userId, action, amount, metadata = {}) {
  return await db.runTransaction(async (transaction) => {
    const userRef = db.doc(`users/${userId}`);
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
      lastActiveAt: FieldValue.serverTimestamp()
    };

    // Update relevant counters
    if (action === "VISIT_SPOT") {
      updates.spotsDiscovered = (userData.spotsDiscovered || 0) + 1;
    } else if (action === "COMPLETE_CHALLENGE") {
      updates.challengesCompleted = (userData.challengesCompleted || 0) + 1;
    }

    transaction.update(userRef, updates);

    // Log the XP transaction
    transaction.create(db.collection("xpTransactions").doc(), {
      userId,
      action,
      amount,
      description: metadata.description || `XP for ${action}`,
      previousXP: currentXP,
      newXP: newTotalXP,
      previousLevel: currentLevel,
      newLevel: newLevel,
      leveledUp,
      timestamp: FieldValue.serverTimestamp(),
      type: "AWARD",
      ...metadata
    });

    return { newTotalXP, newLevel, leveledUp };
  });
}

/**
 * Log XP denial for rejected spots
 */
async function logXPDenial(db, userId, spotId, amount, reason) {
  await db.collection("xpTransactions").add({
    userId,
    action: "SPOT_REJECTED",
    amount: -amount, // Negative to show it was denied
    description: reason,
    spotId,
    timestamp: FieldValue.serverTimestamp(),
    type: "DENIAL"
  });
}

/**
 * Check for duplicate XP awards to prevent cheating
 */
async function checkForDuplicateAward(db, userId, action, resourceId) {
  const existingAward = await db.collection("xpTransactions")
    .where("userId", "==", userId)
    .where("action", "==", action)
    .where("spotId", "==", resourceId)
    .where("type", "==", "AWARD")
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
 * Calculate XP needed for next level
 */
function getXPForNextLevel(currentLevel) {
  const nextLevel = currentLevel + 1;
  return Math.pow(nextLevel - 1, 2) * 100;
}

/**
 * Get user's XP progress information
 */
exports.getXPProgress = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const userId = auth.uid;
    const db = getFirestore();

    try {
      const userDoc = await db.doc(`users/${userId}`).get();

      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found");
      }

      const userData = userDoc.data();
      const currentXP = userData.xpPoints || 0;
      const pendingXP = userData.xpPending || 0;
      const currentLevel = userData.level || 1;

      const nextLevelXP = getXPForNextLevel(currentLevel);
      const currentLevelXP = currentLevel === 1 ? 0 : getXPForNextLevel(currentLevel - 1);
      const progressInLevel = currentXP - currentLevelXP;
      const xpNeededForNext = nextLevelXP - currentXP;

      return {
        currentXP,
        pendingXP,
        totalXP: currentXP + pendingXP,
        currentLevel,
        nextLevel: currentLevel + 1,
        progressInLevel,
        xpNeededForNext: Math.max(0, xpNeededForNext),
        progressPercentage: Math.min(100, (progressInLevel / (nextLevelXP - currentLevelXP)) * 100)
      };

    } catch (error) {
      logger.error(`Failed to get XP progress for user ${userId}:`, error);
      throw new HttpsError("internal", "Failed to get XP progress");
    }
  }
);

/**
 * Admin function to manually adjust user XP
 */
exports.adjustUserXP = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    // Check if user is admin (you would implement proper admin checking)
    const isAdmin = await checkAdminPermissions(auth.uid);
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const { userId, adjustment, reason } = data;

    if (!userId || !adjustment || !reason) {
      throw new HttpsError("invalid-argument", "Missing required parameters");
    }

    const db = getFirestore();

    try {
      const result = await db.runTransaction(async (transaction) => {
        const userRef = db.doc(`users/${userId}`);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new HttpsError("not-found", "User not found");
        }

        const userData = userDoc.data();
        const currentXP = userData.xpPoints || 0;
        const newXP = Math.max(0, currentXP + adjustment);
        const newLevel = calculateLevel(newXP);

        transaction.update(userRef, {
          xpPoints: newXP,
          level: newLevel
        });

        // Log the adjustment
        transaction.create(db.collection("xpTransactions").doc(), {
          userId,
          action: "ADMIN_ADJUSTMENT",
          amount: adjustment,
          description: reason,
          adminId: auth.uid,
          previousXP: currentXP,
          newXP: newXP,
          timestamp: FieldValue.serverTimestamp(),
          type: "ADMIN"
        });

        return { previousXP: currentXP, newXP, newLevel };
      });

      logger.info(`Admin ${auth.uid} adjusted XP for user ${userId}: ${adjustment} (${reason})`);

      return {
        success: true,
        previousXP: result.previousXP,
        newXP: result.newXP,
        newLevel: result.newLevel
      };

    } catch (error) {
      logger.error(`Failed to adjust XP for user ${userId}:`, error);
      throw new HttpsError("internal", "Failed to adjust XP");
    }
  }
);

/**
 * Check if user has admin permissions (implement based on your admin system)
 */
async function checkAdminPermissions(userId) {
  // This is a placeholder - implement your admin checking logic
  // Could check a separate admin collection, custom claims, etc.
  const db = getFirestore();

  try {
    const adminDoc = await db.doc(`admins/${userId}`).get();
    return adminDoc.exists;
  } catch (error) {
    logger.warn(`Admin check failed for user ${userId}:`, error);
    return false;
  }
}