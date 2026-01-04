const {initializeApp} = require("firebase-admin/app");

// Initialize Firebase Admin (if not already done)
initializeApp();

// Import and re-export social functions
const socialFunctions = require("./social");

// Export social functions to make them deployable
module.exports = {
  ...socialFunctions,
};
