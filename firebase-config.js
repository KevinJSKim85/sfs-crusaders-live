// Firebase configuration. Replace the REPLACE_ME values after creating
// your Firebase project (see FIREBASE-SETUP.md).
//
// While the values still contain "REPLACE_ME", the dashboard runs without
// Firebase: lunch shows CTAs only and Clubs falls back to SFS scrape.

window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAJn9zVU7Cnql992b4T88z1j9fTq9LrZkE",
  authDomain:        "sfs-crusader-hub.firebaseapp.com",
  projectId:         "sfs-crusader-hub",
  storageBucket:     "sfs-crusader-hub.firebasestorage.app",
  messagingSenderId: "487005554267",
  appId:             "1:487005554267:web:b07f27b5f456154466617e"
};

// Emails allowed to sign in to admin.html and write data.
// Add the staff/student-leader Google accounts that should manage content.
window.ADMIN_EMAILS = [
  "sfsdashboard@gmail.com"
];

window.isFirebaseConfigured = function() {
  var c = window.FIREBASE_CONFIG;
  return !!(c && c.apiKey && c.apiKey.indexOf("REPLACE") === -1 && c.projectId && c.projectId.indexOf("REPLACE") === -1);
};
