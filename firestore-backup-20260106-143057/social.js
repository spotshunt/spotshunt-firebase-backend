const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {
  onDocumentCreated,
  onDocumentDeleted,
} = require("firebase-functions/v2/firestore");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

// Note: firebase-admin should already be initialized in index.js
const db = getFirestore();

/**
 * Cloud Function to handle follow/unfollow operations
 * Ensures atomic transactions and prevents race conditions
 */
const toggleFollow = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {targetUserId} = request.data;
  const currentUserId = request.auth.uid;

  // Validate input
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required");
  }

  // Prevent self-follow
  if (currentUserId === targetUserId) {
    throw new HttpsError("invalid-argument", "Cannot follow yourself");
  }

  try {
    // Execute atomic transaction
    const result = await db.runTransaction(async (transaction) => {
      // Document references
      const followerDoc = db.collection("users")
          .doc(currentUserId)
          .collection("following")
          .doc(targetUserId);

      const followingDoc = db.collection("users")
          .doc(targetUserId)
          .collection("followers")
          .doc(currentUserId);

      const currentUserDoc = db.collection("users").doc(currentUserId);
      const targetUserDoc = db.collection("users").doc(targetUserId);

      // Read current states
      const [
        followerData,
        currentUserData,
        targetUserData,
      ] = await Promise.all([
        transaction.get(followerDoc),
        transaction.get(currentUserDoc),
        transaction.get(targetUserDoc),
      ]);

      // Validate target user exists and is active
      if (!targetUserData.exists) {
        throw new Error("Target user does not exist");
      }

      const targetIsActive = targetUserData.get("isActive") || true;
      if (!targetIsActive) {
        throw new Error("Cannot follow inactive user");
      }

      const isCurrentlyFollowing = followerData.exists;

      // Get current counts
      const currentUserStats = currentUserData.get("stats") || {};
      const targetUserStats = targetUserData.get("stats") || {};

      const currentFollowingCount = currentUserStats.followingCount || 0;
      const targetFollowersCount = targetUserStats.followersCount || 0;

      if (isCurrentlyFollowing) {
        // UNFOLLOW: Remove both documents and decrement counters
        transaction.delete(followerDoc);
        transaction.delete(followingDoc);

        const newCurrentFollowingCount = Math.max(
            0, currentFollowingCount - 1);
        const newTargetFollowersCount = Math.max(
            0, targetFollowersCount - 1);

        // Update counters
        transaction.update(currentUserDoc, {
          "stats.followingCount": newCurrentFollowingCount,
        });

        transaction.update(targetUserDoc, {
          "stats.followersCount": newTargetFollowersCount,
        });

        return {
          success: true,
          isNowFollowing: false,
          newFollowersCount: newTargetFollowersCount,
          message: "Unfollowed successfully",
        };
      } else {
        // FOLLOW: Create both documents and increment counters
        const followData = {
          followedAt: FieldValue.serverTimestamp(),
          isActive: true,
        };

        const followerData = {
          followedAt: FieldValue.serverTimestamp(),
          isActive: true,
        };

        transaction.set(followerDoc, followData);
        transaction.set(followingDoc, followerData);

        const newCurrentFollowingCount = currentFollowingCount + 1;
        const newTargetFollowersCount = targetFollowersCount + 1;

        // Update counters
        transaction.update(currentUserDoc, {
          "stats.followingCount": newCurrentFollowingCount,
        });

        transaction.update(targetUserDoc, {
          "stats.followersCount": newTargetFollowersCount,
        });

        return {
          success: true,
          isNowFollowing: true,
          newFollowersCount: newTargetFollowersCount,
          message: "Followed successfully",
        };
      }
    });

    return result;
  } catch (error) {
    console.error("Follow operation failed:", error);
    throw new HttpsError(
        "internal", error.message || "Follow operation failed");
  }
});

/**
 * Cloud Function to handle like/unlike operations on spots
 * Ensures atomic transactions and prevents race conditions
 */
const toggleLike = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {spotId} = request.data;
  const currentUserId = request.auth.uid;

  // Validate input
  if (!spotId || typeof spotId !== "string") {
    throw new HttpsError("invalid-argument", "spotId is required");
  }

  try {
    // Execute atomic transaction
    const result = await db.runTransaction(async (transaction) => {
      // Document references
      const spotDoc = db.collection("spots").doc(spotId);
      const likeDoc = spotDoc.collection("likes").doc(currentUserId);

      // Read current states
      const [spotData, likeData] = await Promise.all([
        transaction.get(spotDoc),
        transaction.get(likeDoc),
      ]);

      // Validate spot exists and is active
      if (!spotData.exists) {
        throw new Error("Spot does not exist");
      }

      const spotIsActive = spotData.get("isActive") ||
        spotData.get("active") || true;
      if (!spotIsActive) {
        throw new Error("Cannot like inactive spot");
      }

      const isCurrentlyLiked = likeData.exists;
      const currentLikeCount = spotData.get("likeCount") || 0;

      if (isCurrentlyLiked) {
        // UNLIKE: Remove like document and decrement counter
        transaction.delete(likeDoc);

        const newLikeCount = Math.max(0, currentLikeCount - 1);
        transaction.update(spotDoc, {
          likeCount: newLikeCount,
        });

        return {
          success: true,
          isNowLiked: false,
          newLikeCount: newLikeCount,
          message: "Unliked successfully",
        };
      } else {
        // LIKE: Create like document and increment counter
        const likeData = {
          userId: currentUserId,
          likedAt: FieldValue.serverTimestamp(),
          isActive: true,
        };

        transaction.set(likeDoc, likeData);

        const newLikeCount = currentLikeCount + 1;
        transaction.update(spotDoc, {
          likeCount: newLikeCount,
        });

        return {
          success: true,
          isNowLiked: true,
          newLikeCount: newLikeCount,
          message: "Liked successfully",
        };
      }
    });

    return result;
  } catch (error) {
    console.error("Like operation failed:", error);
    throw new HttpsError("internal", error.message || "Like operation failed");
  }
});

/**
 * Helper function to check if user is following another user
 */
const checkFollowStatus = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {targetUserId} = request.data;
  const currentUserId = request.auth.uid;

  if (!targetUserId) {
    throw new HttpsError("invalid-argument", "targetUserId is required");
  }

  try {
    const followDoc = await db.collection("users")
        .doc(currentUserId)
        .collection("following")
        .doc(targetUserId)
        .get();

    return {
      isFollowing: followDoc.exists,
    };
  } catch (error) {
    console.error("Check follow status failed:", error);
    throw new HttpsError("internal", "Failed to check follow status");
  }
});

/**
 * Helper function to check if user has liked a spot
 */
const checkLikeStatus = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {spotId} = request.data;
  const currentUserId = request.auth.uid;

  if (!spotId) {
    throw new HttpsError("invalid-argument", "spotId is required");
  }

  try {
    const likeDoc = await db.collection("spots")
        .doc(spotId)
        .collection("likes")
        .doc(currentUserId)
        .get();

    return {
      isLiked: likeDoc.exists,
    };
  } catch (error) {
    console.error("Check like status failed:", error);
    throw new HttpsError("internal", "Failed to check like status");
  }
});

/**
 * Batch check follow status for multiple users
 */
const batchCheckFollowStatus = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {userIds} = request.data;
  const currentUserId = request.auth.uid;

  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new HttpsError("invalid-argument", "userIds array is required");
  }

  if (userIds.length > 50) {
    throw new HttpsError("invalid-argument", "Maximum 50 users per batch");
  }

  try {
    const statusMap = {};

    // Use Promise.all to check all users in parallel
    const promises = userIds.map(async (userId) => {
      const doc = await db.collection("users")
          .doc(currentUserId)
          .collection("following")
          .doc(userId)
          .get();
      return {userId, isFollowing: doc.exists};
    });

    const results = await Promise.all(promises);

    // Convert to object map
    results.forEach(({userId, isFollowing}) => {
      statusMap[userId] = isFollowing;
    });

    return {statusMap};
  } catch (error) {
    console.error("Batch check follow status failed:", error);
    throw new HttpsError("internal", "Failed to batch check follow status");
  }
});

/**
 * Batch check like status for multiple spots
 */
const batchCheckLikeStatus = onCall(async (request) => {
  // Verify authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const {spotIds} = request.data;
  const currentUserId = request.auth.uid;

  if (!Array.isArray(spotIds) || spotIds.length === 0) {
    throw new HttpsError("invalid-argument", "spotIds array is required");
  }

  if (spotIds.length > 50) {
    throw new HttpsError("invalid-argument", "Maximum 50 spots per batch");
  }

  try {
    const statusMap = {};

    // Use Promise.all to check all spots in parallel
    const promises = spotIds.map(async (spotId) => {
      const doc = await db.collection("spots")
          .doc(spotId)
          .collection("likes")
          .doc(currentUserId)
          .get();
      return {spotId, isLiked: doc.exists};
    });

    const results = await Promise.all(promises);

    // Convert to object map
    results.forEach(({spotId, isLiked}) => {
      statusMap[spotId] = isLiked;
    });

    return {statusMap};
  } catch (error) {
    console.error("Batch check like status failed:", error);
    throw new HttpsError("internal", "Failed to batch check like status");
  }
});

/**
 * Triggered when a follow relationship is created
 * Can be used for notifications or other side effects
 */
const onFollowCreated = onDocumentCreated(
    "users/{userId}/followers/{followerId}",
    (event) => {
      const followerId = event.params.followerId;
      const userId = event.params.userId;

      console.log(`User ${followerId} followed user ${userId}`);

      // Here you could trigger notifications, update analytics, etc.
      // Example: Send notification to the followed user

      return Promise.resolve();
    });

/**
 * Triggered when a follow relationship is deleted
 * Can be used for cleanup or analytics
 */
const onFollowDeleted = onDocumentDeleted(
    "users/{userId}/followers/{followerId}",
    (event) => {
      const followerId = event.params.followerId;
      const userId = event.params.userId;

      console.log(`User ${followerId} unfollowed user ${userId}`);

      return Promise.resolve();
    });

/**
 * Triggered when a like is created
 * Can be used for notifications or analytics
 */
const onLikeCreated = onDocumentCreated(
    "spots/{spotId}/likes/{userId}",
    (event) => {
      const userId = event.params.userId;
      const spotId = event.params.spotId;

      console.log(`User ${userId} liked spot ${spotId}`);

      // Here you could trigger notifications, update trending algorithms, etc.

      return Promise.resolve();
    });

/**
 * Triggered when a like is deleted
 * Can be used for analytics
 */
const onLikeDeleted = onDocumentDeleted(
    "spots/{spotId}/likes/{userId}",
    (event) => {
      const userId = event.params.userId;
      const spotId = event.params.spotId;

      console.log(`User ${userId} unliked spot ${spotId}`);

      return Promise.resolve();
    });

// Export only the social functions
module.exports = {
  // Callable functions
  toggleFollow,
  toggleLike,
  checkFollowStatus,
  checkLikeStatus,
  batchCheckFollowStatus,
  batchCheckLikeStatus,
  // Trigger functions
  onFollowCreated,
  onFollowDeleted,
  onLikeCreated,
  onLikeDeleted,
};
