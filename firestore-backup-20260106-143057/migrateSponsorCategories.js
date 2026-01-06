const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");

/**
 * Migrate existing sponsors to use new category system
 *
 * This function:
 * 1. Reads all sponsors from Firestore
 * 2. For sponsors without primaryCategory:
 *    - Copies legacy 'category' field to 'primaryCategory'
 *    - Sets default 'other' if no category exists
 *    - Adds empty secondaryCategories array
 *    - Sets categoryVersion to 1
 * 3. Performs batched writes for efficiency
 *
 * Usage: Call this HTTPS function once after deploying indexes
 * curl -X POST https://us-central1-mysteryspot-ef091.cloudfunctions.net/migrateSponsorCategories
 */
exports.migrateSponsorCategories = onRequest({
  timeoutSeconds: 540,
  memory: "512MiB",
}, async (req, res) => {
  const db = getFirestore();

  try {
    logger.info("Starting sponsor category migration...");

    // Get all sponsors
    const sponsorsRef = db.collection("sponsors");
    const snapshot = await sponsorsRef.get();

    logger.info(`Found ${snapshot.size} sponsors to process`);

    if (snapshot.empty) {
      logger.info("No sponsors found");
      return res.status(200).json({
        success: true,
        message: "No sponsors to migrate",
        migrated: 0,
        skipped: 0,
      });
    }

    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    const batchSize = 500;
    let batch = db.batch();
    let operationsInBatch = 0;

    // Process each sponsor
    for (const doc of snapshot.docs) {
      try {
        const data = doc.data();

        // Skip if already has primaryCategory
        if (data.primaryCategory) {
          skipped++;
          logger.debug(`Skipping ${doc.id} - already has primaryCategory`);
          continue;
        }

        // Determine primary category
        // Priority: category field -> default to 'other'
        const primaryCategory = data.category || "other";

        // Prepare update
        const updateData = {
          primaryCategory: primaryCategory,
          secondaryCategories: [],
          categoryVersion: 1,
          updatedAt: FieldValue.serverTimestamp(),
        };

        // Add to batch
        batch.update(doc.ref, updateData);
        operationsInBatch++;
        migrated++;

        logger.debug(`Queued ${doc.id} for migration (category: ${primaryCategory})`);

        // Commit batch if it reaches size limit
        if (operationsInBatch >= batchSize) {
          await batch.commit();
          logger.info(`Committed batch of ${operationsInBatch} updates`);
          batch = db.batch();
          operationsInBatch = 0;
        }
      } catch (error) {
        errors++;
        logger.error(`Error processing sponsor ${doc.id}:`, error);
      }
    }

    // Commit remaining operations
    if (operationsInBatch > 0) {
      await batch.commit();
      logger.info(`Committed final batch of ${operationsInBatch} updates`);
    }

    const result = {
      success: true,
      message: "Migration completed",
      total: snapshot.size,
      migrated,
      skipped,
      errors,
    };

    logger.info("Migration complete:", result);

    return res.status(200).json(result);
  } catch (error) {
    logger.error("Migration failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

/**
 * Validate sponsor categories
 *
 * Checks all sponsors and reports any with invalid category values
 * Useful for auditing data quality after migration
 */
exports.validateSponsorCategories = onRequest({
  timeoutSeconds: 300,
}, async (req, res) => {
  const db = getFirestore();

  const validCategories = [
    "cafe",
    "restaurant",
    "hotel",
    "bakery",
    "bar_pub",
    "grocery",
    "supermarket",
    "gym_fitness",
    "salon_spa",
    "clinic_pharmacy",
    "coworking",
    "shopping",
    "electronics",
    "education",
    "entertainment",
    "travel",
    "other",
  ];

  try {
    const sponsorsRef = db.collection("sponsors");
    const snapshot = await sponsorsRef.get();

    const invalid = [];
    const missing = [];
    const valid = [];

    snapshot.docs.forEach((doc) => {
      const data = doc.data();

      if (!data.primaryCategory) {
        missing.push({
          id: doc.id,
          name: data.name,
          legacyCategory: data.category || null,
        });
      } else if (!validCategories.includes(data.primaryCategory)) {
        invalid.push({
          id: doc.id,
          name: data.name,
          primaryCategory: data.primaryCategory,
        });
      } else {
        valid.push({
          id: doc.id,
          category: data.primaryCategory,
        });
      }
    });

    const result = {
      total: snapshot.size,
      valid: valid.length,
      invalid: invalid.length,
      missing: missing.length,
      invalidSponsors: invalid,
      missingSponsors: missing,
    };

    logger.info("Validation complete:", result);

    return res.status(200).json(result);
  } catch (error) {
    logger.error("Validation failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
