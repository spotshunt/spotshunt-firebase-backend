const {initializeApp} = require("firebase-admin/app");

// Initialize Firebase Admin (if not already done)
initializeApp();

// Import and re-export social functions
const socialFunctions = require("./social");

// Import migration function
const { migrateSponsorCategories } = require("./migrateSponsorCategories");

// Import verification system functions
const verificationFunctions = require("./spotVerification");
const xpFunctions = require("./xpManagement");
const reportingFunctions = require("./spotReporting");
const migrationFunctions = require("./migration");

// Export all functions to make them deployable
module.exports = {
  ...socialFunctions,
  migrateSponsorCategories,
  ...verificationFunctions,
  ...xpFunctions,
  ...reportingFunctions,
  ...migrationFunctions,
};
