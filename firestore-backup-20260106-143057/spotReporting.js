const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

/**
 * SPOT REPORTING SYSTEM
 *
 * Allows users to report problematic spots and automatically handles
 * flagging spots based on report volume and patterns.
 */

/**
 * Submit a spot report
 */
exports.reportSpot = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const { spotId, reason, description = "" } = data;

    if (!spotId || !reason) {
      throw new HttpsError("invalid-argument", "Spot ID and reason are required");
    }

    const validReasons = ["FAKE", "WRONG_LOCATION", "SPAM", "OFFENSIVE", "DANGEROUS", "DUPLICATE"];
    if (!validReasons.includes(reason)) {
      throw new HttpsError("invalid-argument", "Invalid report reason");
    }

    const userId = auth.uid;
    const db = getFirestore();

    try {
      // Check if user has already reported this spot
      const existingReport = await db.collection("spotReports")
        .where("spotId", "==", spotId)
        .where("reportedBy", "==", userId)
        .limit(1)
        .get();

      if (!existingReport.empty) {
        throw new HttpsError("already-exists", "You have already reported this spot");
      }

      // Verify spot exists
      const spotDoc = await db.doc(`spots/${spotId}`).get();
      if (!spotDoc.exists) {
        throw new HttpsError("not-found", "Spot not found");
      }

      const spotData = spotDoc.data();

      // Prevent reporting your own spots
      if (spotData.createdBy === userId) {
        throw new HttpsError("permission-denied", "Cannot report your own spot");
      }

      // Create the report
      const reportData = {
        spotId,
        reportedBy: userId,
        reason,
        description: description.substring(0, 500), // Limit description length
        createdAt: FieldValue.serverTimestamp(),
        status: "PENDING",
        reviewedAt: null,
        reviewedBy: null,
        reviewNotes: ""
      };

      const reportRef = await db.collection("spotReports").add(reportData);

      // Check if this spot should be automatically flagged
      await checkSpotForAutoFlag(db, spotId);

      logger.info(`User ${userId} reported spot ${spotId} for reason: ${reason}`);

      return {
        success: true,
        reportId: reportRef.id,
        message: "Report submitted successfully"
      };

    } catch (error) {
      if (error.code) {
        throw error; // Re-throw HttpsError
      }
      logger.error(`Failed to report spot ${spotId}:`, error);
      throw new HttpsError("internal", "Failed to submit report");
    }
  }
);

/**
 * Auto-process new spot reports
 */
exports.processSpotReport = onDocumentCreated(
  {
    document: "spotReports/{reportId}",
    region: "us-central1"
  },
  async (event) => {
    const reportData = event.data.data();
    const reportId = event.params.reportId;

    if (!reportData) {
      logger.warn(`No data found for report ${reportId}`);
      return;
    }

    const db = getFirestore();
    const spotId = reportData.spotId;

    try {
      logger.info(`Processing new report ${reportId} for spot ${spotId}`);

      // Update spot report count
      await updateSpotReportCount(db, spotId);

      // Check for automatic actions based on report patterns
      await analyzeReportPatterns(db, spotId, reportData);

      // Notify admins if needed
      await notifyAdminsOfReport(db, reportData, reportId);

    } catch (error) {
      logger.error(`Failed to process report ${reportId}:`, error);
    }
  }
);

/**
 * Check if spot should be auto-flagged based on report volume
 */
async function checkSpotForAutoFlag(db, spotId) {
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
      await flagSpotForReview(db, spotId, {
        reason: "Multiple user reports",
        reportCount: totalReports,
        recentReportCount: reportCount
      });
    }

  } catch (error) {
    logger.error(`Failed to check auto-flag for spot ${spotId}:`, error);
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
async function flagSpotForReview(db, spotId, flagData) {
  try {
    await db.doc(`spots/${spotId}`).update({
      verificationStatus: "FLAGGED",
      flaggedAt: FieldValue.serverTimestamp(),
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
      createdAt: FieldValue.serverTimestamp(),
      status: "PENDING"
    });

    logger.info(`Spot ${spotId} flagged for review: ${flagData.reason}`);

  } catch (error) {
    logger.error(`Failed to flag spot ${spotId}:`, error);
  }
}

/**
 * Update spot's report count
 */
async function updateSpotReportCount(db, spotId) {
  try {
    const spotRef = db.doc(`spots/${spotId}`);
    await spotRef.update({
      reportCount: FieldValue.increment(1),
      lastReportedAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    logger.error(`Failed to update report count for spot ${spotId}:`, error);
  }
}

/**
 * Analyze report patterns for suspicious activity
 */
async function analyzeReportPatterns(db, spotId, reportData) {
  try {
    const reporterId = reportData.reportedBy;

    // Check if reporter is submitting too many reports (potential abuse)
    const recentReportsByUser = await db.collection("spotReports")
      .where("reportedBy", "==", reporterId)
      .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000))
      .get();

    if (recentReportsByUser.size > 10) { // More than 10 reports in 24h
      logger.warn(`User ${reporterId} may be abusing report system: ${recentReportsByUser.size} reports in 24h`);

      // Flag for admin review
      await db.collection("adminNotifications").add({
        type: "REPORT_ABUSE_SUSPECTED",
        userId: reporterId,
        reportCount: recentReportsByUser.size,
        priority: "MEDIUM",
        createdAt: FieldValue.serverTimestamp(),
        status: "PENDING"
      });
    }

    // Check for coordinated reporting (multiple reports from same IP, similar timing)
    // This would require additional metadata collection from the client
    await checkForCoordinatedReporting(db, spotId, reportData);

  } catch (error) {
    logger.error(`Failed to analyze report patterns for spot ${spotId}:`, error);
  }
}

/**
 * Check for coordinated reporting attacks
 */
async function checkForCoordinatedReporting(db, spotId, reportData) {
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
        logger.warn(`Potential coordinated reporting detected for spot ${spotId}: ${reports.length} reports with same reason in 1 hour`);

        await db.collection("adminNotifications").add({
          type: "COORDINATED_REPORTING_SUSPECTED",
          spotId,
          reportCount: reports.length,
          reason: Array.from(uniqueReasons)[0],
          reporters: Array.from(uniqueReporters),
          priority: "HIGH",
          createdAt: FieldValue.serverTimestamp(),
          status: "PENDING"
        });
      }
    }

  } catch (error) {
    logger.error(`Failed to check coordinated reporting for spot ${spotId}:`, error);
  }
}

/**
 * Notify admins of new report
 */
async function notifyAdminsOfReport(db, reportData, reportId) {
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
        createdAt: FieldValue.serverTimestamp(),
        status: "PENDING"
      });

      logger.info(`Urgent admin notification sent for report ${reportId} (reason: ${reportData.reason})`);
    }

  } catch (error) {
    logger.error(`Failed to notify admins of report ${reportId}:`, error);
  }
}

/**
 * Admin function to review and resolve a report
 */
exports.resolveSpotReport = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    // Check admin permissions
    const isAdmin = await checkAdminPermissions(auth.uid);
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const { reportId, action, notes = "" } = data;

    if (!reportId || !action) {
      throw new HttpsError("invalid-argument", "Report ID and action are required");
    }

    const validActions = ["DISMISS", "REMOVE_SPOT", "WARNING", "EDIT_SPOT"];
    if (!validActions.includes(action)) {
      throw new HttpsError("invalid-argument", "Invalid action");
    }

    const db = getFirestore();

    try {
      const reportRef = db.doc(`spotReports/${reportId}`);
      const reportDoc = await reportRef.get();

      if (!reportDoc.exists) {
        throw new HttpsError("not-found", "Report not found");
      }

      const reportData = reportDoc.data();
      const spotId = reportData.spotId;

      // Update report status
      await reportRef.update({
        status: "REVIEWED",
        action,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: auth.uid,
        reviewNotes: notes
      });

      // Take action on the spot
      await executeReportAction(db, spotId, action, notes, auth.uid);

      // Log the admin action
      await db.collection("adminActionLogs").add({
        type: "REPORT_RESOLVED",
        reportId,
        spotId,
        action,
        notes,
        adminId: auth.uid,
        timestamp: FieldValue.serverTimestamp()
      });

      logger.info(`Admin ${auth.uid} resolved report ${reportId} with action: ${action}`);

      return {
        success: true,
        message: `Report resolved with action: ${action}`
      };

    } catch (error) {
      if (error.code) {
        throw error;
      }
      logger.error(`Failed to resolve report ${reportId}:`, error);
      throw new HttpsError("internal", "Failed to resolve report");
    }
  }
);

/**
 * Execute the action determined by admin review
 */
async function executeReportAction(db, spotId, action, notes, adminId) {
  const spotRef = db.doc(`spots/${spotId}`);

  switch (action) {
    case "REMOVE_SPOT":
      await spotRef.update({
        isActive: false,
        removedAt: FieldValue.serverTimestamp(),
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
          createdAt: FieldValue.serverTimestamp()
        });
      }
      break;

    case "EDIT_SPOT":
      // Mark spot for editing/correction
      await spotRef.update({
        needsCorrection: true,
        correctionNotes: notes,
        markedForCorrectionAt: FieldValue.serverTimestamp(),
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
exports.getSpotReports = onCall(
  {
    region: "us-central1"
  },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    // Check admin permissions
    const isAdmin = await checkAdminPermissions(auth.uid);
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const { status = "PENDING", limit = 20, startAfter = null } = data || {};
    const db = getFirestore();

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
      logger.error(`Failed to get spot reports:`, error);
      throw new HttpsError("internal", "Failed to get reports");
    }
  }
);

/**
 * Check admin permissions
 */
async function checkAdminPermissions(userId) {
  const db = getFirestore();

  try {
    const adminDoc = await db.doc(`admins/${userId}`).get();
    return adminDoc.exists;
  } catch (error) {
    logger.warn(`Admin check failed for user ${userId}:`, error);
    return false;
  }
}