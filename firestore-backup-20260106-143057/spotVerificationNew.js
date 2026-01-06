const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

/**
 * ADVANCED SPOT VERIFICATION SYSTEM
 *
 * This Cloud Function automatically verifies submitted spots using a confidence scoring system.
 * It calculates a verification score (0-100) and decides whether to auto-approve, flag for review,
 * or reject the spot based on multiple signals.
 */

/**
 * Configuration constants for verification scoring
 */
const VERIFICATION_CONFIG = {
  // Decision thresholds
  AUTO_APPROVE_THRESHOLD: 80,
  MANUAL_REVIEW_THRESHOLD: 50,

  // Score weights (must total 100)
  WEIGHTS: {
    LOCATION_ACCURACY: 30,
    PHOTO_VERIFICATION: 20,
    DUPLICATE_DETECTION: 20,
    USER_TRUST: 20,
    CONTENT_QUALITY: 10
  },

  // Location accuracy parameters
  LOCATION: {
    EXCELLENT_ACCURACY: 20, // meters
    GOOD_ACCURACY: 50,      // meters
    POOR_ACCURACY: 100,     // meters
    MAX_SPEED_MPS: 50,      // 180 km/h (unrealistic for normal travel)
    TELEPORT_DISTANCE: 10000 // 10km instant movement
  },

  // Rate limiting
  RATE_LIMITS: {
    MAX_SUBMISSIONS_PER_DAY: 3,
    MIN_DISTANCE_BETWEEN_SPOTS: 100, // meters
    MIN_TIME_BETWEEN_SUBMISSIONS: 300000 // 5 minutes in milliseconds
  },

  // Trust score parameters
  TRUST: {
    NEW_USER_GRACE_PERIOD: 7 * 24 * 60 * 60 * 1000, // 7 days
    MIN_SUBMISSIONS_FOR_TRUST: 5,
    SHADOW_BAN_REJECTION_THRESHOLD: 0.7 // 70% rejection rate
  }
};

/**
 * Main verification function - triggered when a new spot is created
 */
exports.verifySpotSubmissionNew = onDocumentCreated(
  {
    document: "spots/{spotId}",
    region: "us-central1"
  },
  async (event) => {
    const spotId = event.params.spotId;
    const spotData = event.data.data();

    if (!spotData) {
      logger.warn(`Spot verification: No data found for spot ${spotId}`);
      return;
    }

    // Skip verification for spots that are already processed
    if (spotData.verificationStatus !== "PENDING") {
      logger.info(`Spot ${spotId} already processed with status: ${spotData.verificationStatus}`);
      return;
    }

    try {
      logger.info(`Starting verification for spot ${spotId} by user ${spotData.createdBy}`);

      const db = getFirestore();
      const verificationResult = await performSpotVerification(db, spotId, spotData);

      // Update spot with verification results
      await updateSpotVerification(db, spotId, verificationResult);

      // Update user trust score and statistics
      await updateUserTrustScore(db, spotData.createdBy, verificationResult);

      // Send admin notification if manual review is needed
      if (verificationResult.status === "PENDING" || verificationResult.status === "FLAGGED") {
        await sendAdminNotification(db, spotId, spotData, verificationResult);
      }

      logger.info(`Spot verification completed for ${spotId}: ${verificationResult.status} (score: ${verificationResult.score})`);

    } catch (error) {
      logger.error(`Spot verification failed for ${spotId}:`, error);

      // Mark as needing manual review on error
      await getFirestore().doc(`spots/${spotId}`).update({
        verificationStatus: "PENDING",
        verificationScore: 0,
        verificationReasons: ["error_during_verification"],
        updatedAt: FieldValue.serverTimestamp()
      });
    }
  }
);

/**
 * Performs comprehensive spot verification analysis
 */
async function performSpotVerification(db, spotId, spotData) {
  const scores = {
    locationAccuracy: 0,
    photoVerification: 0,
    duplicateDetection: 0,
    userTrust: 0,
    contentQuality: 0
  };

  const reasons = [];
  let flags = [];

  // 1. Check Location Accuracy (30 points)
  const locationScore = await checkLocationAccuracy(db, spotData);
  scores.locationAccuracy = locationScore.score;
  reasons.push(...locationScore.reasons);
  flags.push(...locationScore.flags);

  // 2. Photo Verification (20 points)
  const photoScore = await checkPhotoVerification(db, spotData);
  scores.photoVerification = photoScore.score;
  reasons.push(...photoScore.reasons);
  flags.push(...photoScore.flags);

  // 3. Duplicate Detection (20 points)
  const duplicateScore = await checkDuplicateSpots(db, spotData);
  scores.duplicateDetection = duplicateScore.score;
  reasons.push(...duplicateScore.reasons);
  flags.push(...duplicateScore.flags);

  // 4. User Trust Score (20 points)
  const trustScore = await checkUserTrust(db, spotData.createdBy);
  scores.userTrust = trustScore.score;
  reasons.push(...trustScore.reasons);
  flags.push(...trustScore.flags);

  // 5. Content Quality (10 points)
  const contentScore = checkContentQuality(spotData);
  scores.contentQuality = contentScore.score;
  reasons.push(...contentScore.reasons);
  flags.push(...contentScore.flags);

  // Calculate weighted total score
  const totalScore = Math.round(
    (scores.locationAccuracy * VERIFICATION_CONFIG.WEIGHTS.LOCATION_ACCURACY +
     scores.photoVerification * VERIFICATION_CONFIG.WEIGHTS.PHOTO_VERIFICATION +
     scores.duplicateDetection * VERIFICATION_CONFIG.WEIGHTS.DUPLICATE_DETECTION +
     scores.userTrust * VERIFICATION_CONFIG.WEIGHTS.USER_TRUST +
     scores.contentQuality * VERIFICATION_CONFIG.WEIGHTS.CONTENT_QUALITY) / 100
  );

  // Determine verification status
  let status = "PENDING";
  if (flags.length > 0) {
    status = "FLAGGED";
  } else if (totalScore >= VERIFICATION_CONFIG.AUTO_APPROVE_THRESHOLD) {
    status = "AUTO_APPROVED";
  } else if (totalScore < VERIFICATION_CONFIG.MANUAL_REVIEW_THRESHOLD) {
    status = "PENDING"; // Requires manual review
  } else {
    status = "PENDING"; // Borderline - manual review recommended
  }

  return {
    status,
    score: totalScore,
    reasons: reasons.filter(r => r), // Remove empty reasons
    flags,
    detailedScores: scores
  };
}

/**
 * Check location accuracy and movement patterns
 */
async function checkLocationAccuracy(db, spotData) {
  let score = 0;
  const reasons = [];
  const flags = [];

  try {
    // Check if user's recent submissions show realistic movement
    const recentSubmissions = await db.collection("spots")
      .where("createdBy", "==", spotData.createdBy)
      .where("createdAt", ">", Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    if (!recentSubmissions.empty) {
      const submissions = recentSubmissions.docs.map(doc => doc.data());
      const movementAnalysis = analyzeMovementPattern(submissions, spotData);

      if (movementAnalysis.suspicious) {
        flags.push("suspicious_movement");
        score = 0;
        reasons.push("unrealistic_movement_detected");
      } else {
        score = 80; // Good movement pattern
        reasons.push("movement_pattern_ok");
      }
    } else {
      score = 60; // First submission - neutral
      reasons.push("first_submission");
    }

    // Check for mock location indicators (would be passed from client)
    if (spotData.locationMetadata?.isMockLocation) {
      flags.push("mock_location_detected");
      score = Math.min(score, 10);
      reasons.push("mock_location_detected");
    }

    // Check GPS accuracy
    const accuracy = spotData.locationMetadata?.accuracy || 999;
    if (accuracy <= VERIFICATION_CONFIG.LOCATION.EXCELLENT_ACCURACY) {
      score = Math.min(100, score + 20);
      reasons.push("excellent_gps_accuracy");
    } else if (accuracy <= VERIFICATION_CONFIG.LOCATION.GOOD_ACCURACY) {
      score = Math.min(100, score + 10);
      reasons.push("good_gps_accuracy");
    } else if (accuracy > VERIFICATION_CONFIG.LOCATION.POOR_ACCURACY) {
      score = Math.max(0, score - 20);
      reasons.push("poor_gps_accuracy");
    }

  } catch (error) {
    logger.warn("Location accuracy check failed:", error);
    score = 50; // Neutral score on error
    reasons.push("location_check_error");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, flags };
}

/**
 * Analyze movement patterns to detect teleportation/unrealistic travel
 */
function analyzeMovementPattern(submissions, newSpot) {
  if (submissions.length === 0) return { suspicious: false };

  const lastSubmission = submissions[0];
  const timeDiff = newSpot.createdAt - lastSubmission.createdAt;

  if (timeDiff < 60000) { // Less than 1 minute
    return { suspicious: true, reason: "too_fast_submission" };
  }

  // Calculate distance between submissions
  const distance = getDistance(
    lastSubmission.latitude, lastSubmission.longitude,
    newSpot.latitude, newSpot.longitude
  );

  // Check for teleportation (>10km in <5 minutes)
  if (distance > VERIFICATION_CONFIG.LOCATION.TELEPORT_DISTANCE && timeDiff < 300000) {
    return { suspicious: true, reason: "teleportation_detected" };
  }

  // Check for unrealistic speed
  const speedMPS = (distance / (timeDiff / 1000));
  if (speedMPS > VERIFICATION_CONFIG.LOCATION.MAX_SPEED_MPS) {
    return { suspicious: true, reason: "unrealistic_speed" };
  }

  return { suspicious: false };
}

/**
 * Check photo verification and metadata
 */
async function checkPhotoVerification(db, spotData) {
  let score = 0;
  const reasons = [];
  const flags = [];

  try {
    // Check if photo exists
    if (!spotData.primaryImageUrl && (!spotData.imageUrls || spotData.imageUrls.length === 0)) {
      score = 20; // No photo penalty but not zero
      reasons.push("no_photo_provided");
      return { score, reasons, flags };
    }

    score = 60; // Base score for having a photo
    reasons.push("photo_provided");

    // Check for duplicate images (simplified - would need image hashing in production)
    const imageHash = spotData.photoMetadata?.hash;
    if (imageHash) {
      const duplicateImages = await db.collection("spots")
        .where("photoMetadata.hash", "==", imageHash)
        .where("id", "!=", spotData.id)
        .limit(1)
        .get();

      if (!duplicateImages.empty) {
        flags.push("duplicate_image");
        score = 0;
        reasons.push("duplicate_image_detected");
        return { score, reasons, flags };
      }

      score += 20;
      reasons.push("unique_image");
    }

    // Check EXIF data if available
    const exifData = spotData.photoMetadata?.exif;
    if (exifData) {
      // Check photo timestamp vs submission time
      const photoTime = exifData.dateTimeOriginal;
      const submissionTime = spotData.createdAt;

      if (photoTime && Math.abs(photoTime - submissionTime) < 3600000) { // Within 1 hour
        score += 10;
        reasons.push("recent_photo");
      }

      // Check GPS coordinates in EXIF vs spot location
      if (exifData.gpsLatitude && exifData.gpsLongitude) {
        const exifDistance = getDistance(
          exifData.gpsLatitude, exifData.gpsLongitude,
          spotData.latitude, spotData.longitude
        );

        if (exifDistance < 100) { // Within 100m
          score += 10;
          reasons.push("exif_location_match");
        } else {
          score -= 10;
          reasons.push("exif_location_mismatch");
        }
      }
    }

  } catch (error) {
    logger.warn("Photo verification check failed:", error);
    score = 40; // Neutral-low score on error
    reasons.push("photo_check_error");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, flags };
}

/**
 * Check for duplicate spots in the same area
 */
async function checkDuplicateSpots(db, spotData) {
  let score = 80; // Default good score
  const reasons = [];
  const flags = [];

  try {
    // Check for nearby spots (within 100m)
    const nearbySpots = await db.collection("spots")
      .where("latitude", ">=", spotData.latitude - 0.001) // ~111m
      .where("latitude", "<=", spotData.latitude + 0.001)
      .where("longitude", ">=", spotData.longitude - 0.001)
      .where("longitude", "<=", spotData.longitude + 0.001)
      .get();

    let duplicatesFound = 0;

    for (const doc of nearbySpots.docs) {
      if (doc.id === spotData.id) continue; // Skip self

      const existingSpot = doc.data();
      const distance = getDistance(
        existingSpot.latitude, existingSpot.longitude,
        spotData.latitude, spotData.longitude
      );

      if (distance < 50) { // Very close spots
        duplicatesFound++;

        // Check title similarity
        const titleSimilarity = calculateTextSimilarity(
          spotData.title.toLowerCase(),
          existingSpot.title.toLowerCase()
        );

        if (titleSimilarity > 0.8) { // 80% similar titles
          flags.push("potential_duplicate");
          score = 0;
          reasons.push("duplicate_spot_detected");
          break;
        } else if (distance < 25) {
          score -= 30;
          reasons.push("very_close_spot_exists");
        }
      } else if (distance < 100) {
        score -= 10;
        reasons.push("nearby_spot_exists");
      }
    }

    if (duplicatesFound === 0) {
      reasons.push("no_nearby_duplicates");
    }

  } catch (error) {
    logger.warn("Duplicate detection check failed:", error);
    score = 60; // Neutral score on error
    reasons.push("duplicate_check_error");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, flags };
}

/**
 * Check user trust score and submission history
 */
async function checkUserTrust(db, userId) {
  let score = 50; // Default neutral score
  const reasons = [];
  const flags = [];

  try {
    const userDoc = await db.doc(`users/${userId}`).get();

    if (!userDoc.exists) {
      score = 30; // New user penalty
      reasons.push("new_user_account");
      return { score, reasons, flags };
    }

    const userData = userDoc.data();

    // Check if shadow banned
    if (userData.isShadowBanned) {
      flags.push("shadow_banned_user");
      score = 0;
      reasons.push("shadow_banned_user");
      return { score, reasons, flags };
    }

    // Use existing trust score
    const trustScore = userData.trustScore || 1.0;
    score = Math.round(trustScore * 100);

    // Account age bonus
    const accountAge = Date.now() - userData.createdAt;
    if (accountAge > VERIFICATION_CONFIG.TRUST.NEW_USER_GRACE_PERIOD) {
      score += 10;
      reasons.push("established_account");
    }

    // Submission history analysis
    const totalSubmissions = userData.spotSubmissions || 0;
    const approvedCount = userData.spotApprovedCount || 0;
    const rejectedCount = userData.spotRejectedCount || 0;

    if (totalSubmissions > 0) {
      const approvalRate = approvedCount / totalSubmissions;

      if (approvalRate > 0.8) { // > 80% approval rate
        score += 15;
        reasons.push("high_approval_rate");
      } else if (approvalRate < 0.3) { // < 30% approval rate
        score -= 20;
        reasons.push("low_approval_rate");

        // Check for shadow ban threshold
        if (approvalRate < VERIFICATION_CONFIG.TRUST.SHADOW_BAN_REJECTION_THRESHOLD && totalSubmissions >= 5) {
          flags.push("shadow_ban_candidate");
        }
      }
    }

    // Rate limiting check
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todaySubmissions = await db.collection("spots")
      .where("createdBy", "==", userId)
      .where("createdAt", ">=", todayStart.getTime())
      .get();

    if (todaySubmissions.size >= VERIFICATION_CONFIG.RATE_LIMITS.MAX_SUBMISSIONS_PER_DAY) {
      flags.push("rate_limit_exceeded");
      score = Math.min(score, 20);
      reasons.push("too_many_submissions_today");
    }

  } catch (error) {
    logger.warn("User trust check failed:", error);
    score = 40; // Neutral-low score on error
    reasons.push("trust_check_error");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, flags };
}

/**
 * Check content quality (title, description, category appropriateness)
 */
function checkContentQuality(spotData) {
  let score = 70; // Default good score
  const reasons = [];
  const flags = [];

  // Title checks
  const title = (spotData.title || "").trim();
  if (title.length < 5) {
    score -= 30;
    reasons.push("title_too_short");
  } else if (title.length > 100) {
    score -= 10;
    reasons.push("title_too_long");
  } else {
    reasons.push("title_length_ok");
  }

  // Check for obvious spam patterns
  const spamPatterns = [
    /(.)\1{5,}/, // Repeated characters
    /[0-9]{10,}/, // Long numbers
    /www\.|http|\.com/i, // URLs
    /buy|sale|cheap|free|win|prize/i // Commercial terms
  ];

  const titleLower = title.toLowerCase();
  for (const pattern of spamPatterns) {
    if (pattern.test(titleLower)) {
      score -= 20;
      reasons.push("spam_detected_in_title");
      break;
    }
  }

  // Description checks
  const description = (spotData.description || "").trim();
  if (description.length < 10) {
    score -= 15;
    reasons.push("description_too_short");
  } else if (description.length > 500) {
    score -= 5;
    reasons.push("description_too_long");
  } else {
    reasons.push("description_length_ok");
  }

  // Check for profanity (simplified check)
  const profanityWords = ["spam", "test", "fake"]; // Would use a proper profanity filter in production
  const fullText = (title + " " + description).toLowerCase();

  for (const word of profanityWords) {
    if (fullText.includes(word)) {
      score -= 15;
      reasons.push("inappropriate_content");
      break;
    }
  }

  // Category validation
  const validCategories = ["CAFE", "VIEWPOINT", "ART", "PARK", "HISTORICAL", "HIDDEN_GEM"];
  if (!validCategories.includes(spotData.category)) {
    score -= 10;
    reasons.push("invalid_category");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, flags };
}

/**
 * Update spot document with verification results
 */
async function updateSpotVerification(db, spotId, verificationResult) {
  const updateData = {
    verificationStatus: verificationResult.status,
    verificationScore: verificationResult.score,
    verificationReasons: verificationResult.reasons,
    verificationFlags: verificationResult.flags || [],
    verificationTimestamp: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  // If auto-approved, release XP
  if (verificationResult.status === "AUTO_APPROVED") {
    updateData.xpReleased = true;
  }

  await db.doc(`spots/${spotId}`).update(updateData);

  // Log verification for audit
  await db.collection("verificationLogs").add({
    spotId,
    status: verificationResult.status,
    score: verificationResult.score,
    reasons: verificationResult.reasons,
    flags: verificationResult.flags || [],
    detailedScores: verificationResult.detailedScores,
    timestamp: FieldValue.serverTimestamp()
  });
}

/**
 * Update user trust score based on verification result
 */
async function updateUserTrustScore(db, userId, verificationResult) {
  const userRef = db.doc(`users/${userId}`);

  try {
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        logger.warn(`User ${userId} not found for trust score update`);
        return;
      }

      const userData = userDoc.data();
      const currentTrust = userData.trustScore || 1.0;
      const submissions = userData.spotSubmissions || 0;
      const approved = userData.spotApprovedCount || 0;
      const rejected = userData.spotRejectedCount || 0;

      let newApproved = approved;
      let newRejected = rejected;
      let newTrust = currentTrust;

      // Update counts based on verification result
      if (verificationResult.status === "AUTO_APPROVED") {
        newApproved += 1;
        newTrust = Math.min(1.0, currentTrust + 0.02); // Small boost
      } else if (verificationResult.status === "REJECTED") {
        newRejected += 1;
        newTrust = Math.max(0.0, currentTrust - 0.05); // Larger penalty
      }
      // PENDING doesn't immediately affect trust score

      const updates = {
        spotSubmissions: submissions + 1,
        spotApprovedCount: newApproved,
        spotRejectedCount: newRejected,
        trustScore: newTrust,
        lastActiveAt: FieldValue.serverTimestamp()
      };

      // Check for shadow ban condition
      const totalAfterUpdate = submissions + 1;
      if (totalAfterUpdate >= 5) {
        const rejectionRate = newRejected / totalAfterUpdate;
        if (rejectionRate >= VERIFICATION_CONFIG.TRUST.SHADOW_BAN_REJECTION_THRESHOLD) {
          updates.isShadowBanned = true;
          logger.info(`User ${userId} shadow banned due to high rejection rate: ${rejectionRate}`);
        }
      }

      transaction.update(userRef, updates);
    });

  } catch (error) {
    logger.error(`Failed to update user trust score for ${userId}:`, error);
  }
}

/**
 * Send notification to admins for manual review
 */
async function sendAdminNotification(db, spotId, spotData, verificationResult) {
  try {
    await db.collection("adminNotifications").add({
      type: "SPOT_REVIEW_REQUIRED",
      spotId,
      spotTitle: spotData.title,
      userId: spotData.createdBy,
      verificationScore: verificationResult.score,
      flags: verificationResult.flags || [],
      reasons: verificationResult.reasons,
      priority: verificationResult.flags?.length > 0 ? "HIGH" : "NORMAL",
      createdAt: FieldValue.serverTimestamp(),
      status: "PENDING"
    });

    logger.info(`Admin notification sent for spot ${spotId} (score: ${verificationResult.score})`);

  } catch (error) {
    logger.error(`Failed to send admin notification for spot ${spotId}:`, error);
  }
}

/**
 * Utility functions
 */

/**
 * Calculate distance between two points in meters using Haversine formula
 */
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

/**
 * Calculate text similarity using simple character-based comparison
 */
function calculateTextSimilarity(str1, str2) {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}