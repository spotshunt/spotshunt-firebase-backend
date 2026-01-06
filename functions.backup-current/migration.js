const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { onCall } = require("firebase-functions/v2/https");

/**
 * MIGRATION SCRIPT FOR VERIFICATION SYSTEM
 *
 * This script migrates existing spots and users to work with the new
 * verification system. It should be run once when deploying the system.
 */

/**
 * Migrate existing spots to the new verification system
 */
exports.migrateExistingSpots = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth } = request;

    // Only allow super admins to run migration
    if (!auth || !auth.token?.superadmin) {
      throw new HttpsError("permission-denied", "Super admin access required");
    }

    const db = getFirestore();
    let migratedCount = 0;
    let errorCount = 0;

    try {
      logger.info("Starting migration of existing spots...");

      // Get all existing spots that don't have verification fields
      const spotsQuery = await db.collection("spots").get();
      const batchSize = 500; // Firestore batch limit
      const batches = [];
      let currentBatch = db.batch();
      let operationCount = 0;

      for (const spotDoc of spotsQuery.docs) {
        const spotData = spotDoc.data();

        // Skip spots that already have verification data
        if (spotData.verificationStatus) {
          continue;
        }

        try {
          // Determine migration strategy based on existing data
          const updates = await determineSpotMigrationData(spotData);

          currentBatch.update(spotDoc.ref, updates);
          operationCount++;

          // Start new batch if current one is full
          if (operationCount >= batchSize) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            operationCount = 0;
          }

          migratedCount++;

        } catch (error) {
          logger.error(`Error preparing migration for spot ${spotDoc.id}:`, error);
          errorCount++;
        }
      }

      // Add the last batch if it has operations
      if (operationCount > 0) {
        batches.push(currentBatch);
      }

      // Execute all batches
      logger.info(`Executing ${batches.length} batches with ${migratedCount} spot updates...`);

      for (let i = 0; i < batches.length; i++) {
        await batches[i].commit();
        logger.info(`Completed batch ${i + 1}/${batches.length}`);
      }

      logger.info(`Spot migration completed: ${migratedCount} migrated, ${errorCount} errors`);

      return {
        success: true,
        migratedSpots: migratedCount,
        errors: errorCount,
        message: `Successfully migrated ${migratedCount} spots with ${errorCount} errors`
      };

    } catch (error) {
      logger.error("Spot migration failed:", error);
      throw new HttpsError("internal", `Migration failed: ${error.message}`);
    }
  }
);

/**
 * Migrate existing users to the new verification system
 */
exports.migrateExistingUsers = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth } = request;

    // Only allow super admins to run migration
    if (!auth || !auth.token?.superadmin) {
      throw new HttpsError("permission-denied", "Super admin access required");
    }

    const db = getFirestore();
    let migratedCount = 0;
    let errorCount = 0;

    try {
      logger.info("Starting migration of existing users...");

      const usersQuery = await db.collection("users").get();
      const batchSize = 500;
      const batches = [];
      let currentBatch = db.batch();
      let operationCount = 0;

      for (const userDoc of usersQuery.docs) {
        const userData = userDoc.data();

        // Skip users that already have trust score data
        if (userData.trustScore !== undefined) {
          continue;
        }

        try {
          const updates = await determineUserMigrationData(db, userDoc.id, userData);

          currentBatch.update(userDoc.ref, updates);
          operationCount++;

          if (operationCount >= batchSize) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            operationCount = 0;
          }

          migratedCount++;

        } catch (error) {
          logger.error(`Error preparing migration for user ${userDoc.id}:`, error);
          errorCount++;
        }
      }

      if (operationCount > 0) {
        batches.push(currentBatch);
      }

      logger.info(`Executing ${batches.length} batches with ${migratedCount} user updates...`);

      for (let i = 0; i < batches.length; i++) {
        await batches[i].commit();
        logger.info(`Completed batch ${i + 1}/${batches.length}`);
      }

      logger.info(`User migration completed: ${migratedCount} migrated, ${errorCount} errors`);

      return {
        success: true,
        migratedUsers: migratedCount,
        errors: errorCount,
        message: `Successfully migrated ${migratedCount} users with ${errorCount} errors`
      };

    } catch (error) {
      logger.error("User migration failed:", error);
      throw new HttpsError("internal", `Migration failed: ${error.message}`);
    }
  }
);

/**
 * Complete migration - runs both spot and user migrations
 */
exports.runCompleteMigration = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth } = request;

    if (!auth || !auth.token?.superadmin) {
      throw new HttpsError("permission-denied", "Super admin access required");
    }

    try {
      logger.info("Starting complete verification system migration...");

      // Run user migration first (spots depend on user trust scores)
      const userResult = await exports.migrateExistingUsers._handler(request);
      logger.info("User migration result:", userResult.data);

      // Then run spot migration
      const spotResult = await exports.migrateExistingSpots._handler(request);
      logger.info("Spot migration result:", spotResult.data);

      // Create initial admin notification about migration completion
      const db = getFirestore();
      await db.collection("adminNotifications").add({
        type: "MIGRATION_COMPLETED",
        message: `Verification system migration completed successfully`,
        metadata: {
          migratedSpots: spotResult.data.migratedSpots,
          migratedUsers: userResult.data.migratedUsers,
          totalErrors: spotResult.data.errors + userResult.data.errors
        },
        priority: "HIGH",
        createdAt: FieldValue.serverTimestamp(),
        status: "PENDING"
      });

      return {
        success: true,
        userMigration: userResult.data,
        spotMigration: spotResult.data,
        message: "Complete migration successful"
      };

    } catch (error) {
      logger.error("Complete migration failed:", error);
      throw new HttpsError("internal", `Complete migration failed: ${error.message}`);
    }
  }
);

/**
 * Determine migration data for a spot
 */
async function determineSpotMigrationData(spotData) {
  const updates = {
    // Set default verification fields
    verificationStatus: "APPROVED", // Existing spots are considered approved
    verificationScore: 85, // Give existing spots a good score
    verificationReasons: ["legacy_spot", "pre_verification_system"],
    verificationFlags: [],
    verificationTimestamp: FieldValue.serverTimestamp(),
    xpReleased: true, // Existing spots have already awarded XP
    xpPending: 0,
    reportCount: 0,

    // Ensure required fields exist
    updatedAt: spotData.updatedAt || FieldValue.serverTimestamp()
  };

  // Add createdBy if missing (fallback)
  if (!spotData.createdBy) {
    updates.createdBy = "legacy_user";
    updates.verificationReasons.push("missing_creator");
  }

  // Ensure XP reward is set
  if (!spotData.xpReward || spotData.xpReward <= 0) {
    updates.xpReward = 100; // Default XP for legacy spots
  }

  // If spot was previously flagged as inactive or problematic
  if (spotData.isActive === false) {
    updates.verificationStatus = "REJECTED";
    updates.verificationScore = 0;
    updates.verificationReasons = ["legacy_inactive"];
    updates.xpReleased = false;
  }

  return updates;
}

/**
 * Determine migration data for a user
 */
async function determineUserMigrationData(db, userId, userData) {
  const updates = {
    // Initialize trust score based on existing data
    trustScore: 1.0, // Start with perfect trust for existing users
    spotSubmissions: 0,
    spotApprovedCount: 0,
    spotRejectedCount: 0,
    isShadowBanned: false,
    xpPending: 0
  };

  try {
    // Count user's existing spots to set submission stats
    const userSpotsQuery = await db.collection("spots")
      .where("createdBy", "==", userId)
      .get();

    updates.spotSubmissions = userSpotsQuery.size;
    updates.spotApprovedCount = userSpotsQuery.size; // All existing spots are considered approved

    // Adjust trust score based on activity
    if (userSpotsQuery.size > 0) {
      // Users with approved spots get bonus trust
      updates.trustScore = Math.min(1.0, 1.0 + (userSpotsQuery.size * 0.01)); // Small bonus per spot
    }

    // Check if user account seems problematic (has been inactive for long time)
    const accountAge = Date.now() - (userData.createdAt || 0);
    const lastActive = userData.lastActiveAt || userData.createdAt || 0;
    const inactivityPeriod = Date.now() - lastActive;

    // If account is very old but has been inactive for 6+ months, lower trust slightly
    if (accountAge > 180 * 24 * 60 * 60 * 1000 && inactivityPeriod > 180 * 24 * 60 * 60 * 1000) {
      updates.trustScore = Math.max(0.7, updates.trustScore - 0.1);
    }

  } catch (error) {
    logger.warn(`Error calculating stats for user ${userId}:`, error);
    // Use defaults if calculation fails
  }

  return updates;
}

/**
 * Cleanup function to remove migration data (for testing)
 */
exports.cleanupMigration = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth } = request;

    if (!auth || !auth.token?.superadmin) {
      throw new HttpsError("permission-denied", "Super admin access required");
    }

    const db = getFirestore();

    try {
      logger.info("Starting migration cleanup...");

      // Remove verification fields from spots (for re-testing migration)
      const spotsQuery = await db.collection("spots").get();
      const spotBatch = db.batch();

      spotsQuery.docs.forEach(doc => {
        spotBatch.update(doc.ref, {
          verificationStatus: FieldValue.delete(),
          verificationScore: FieldValue.delete(),
          verificationReasons: FieldValue.delete(),
          verificationFlags: FieldValue.delete(),
          verificationTimestamp: FieldValue.delete(),
          xpReleased: FieldValue.delete(),
          xpPending: FieldValue.delete(),
          reportCount: FieldValue.delete()
        });
      });

      await spotBatch.commit();

      // Remove trust score fields from users
      const usersQuery = await db.collection("users").get();
      const userBatch = db.batch();

      usersQuery.docs.forEach(doc => {
        userBatch.update(doc.ref, {
          trustScore: FieldValue.delete(),
          spotSubmissions: FieldValue.delete(),
          spotApprovedCount: FieldValue.delete(),
          spotRejectedCount: FieldValue.delete(),
          isShadowBanned: FieldValue.delete(),
          xpPending: FieldValue.delete()
        });
      });

      await userBatch.commit();

      logger.info("Migration cleanup completed");

      return {
        success: true,
        message: "Migration data cleaned up successfully"
      };

    } catch (error) {
      logger.error("Migration cleanup failed:", error);
      throw new HttpsError("internal", `Cleanup failed: ${error.message}`);
    }
  }
);