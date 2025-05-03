// static/auth.js - Authentication Logic (Imports UI Functions)

console.log('[Auth] auth.js loaded.');

// --- Import UI functions ---
import { updateNavbarUI, updateToolAccessUI } from './ui.js';

// --- Constants (Define only those needed directly in auth.js) ---
// None needed here if UI handles DOM interaction based on passed state

// --- Global Auth State ---
let authClient = null;
let currentAccessToken = null;
const currentUserInfo = {
  dbUserData: null,
  propelUserInfo: null,
  isLoggedIn: false,
};

// --- Make authClient globally accessible IF needed by ui.js click handlers ---
// This is a common pattern, though module imports/exports are cleaner if possible
window.authClient = authClient; // ui.js purchase handler uses this for token refresh

// --- Global Accessors ---
/**
 * Get the current access token.
 * @returns {string|null} The current access token or null.
 */
window.getCurrentAccessToken = function () {
  return currentAccessToken || null;
};

// --- Configuration ---
const authUrl = document.body.dataset.authUrl;
const API_USER_ME_URL = '/api/v1/user/me'; // Define API endpoint URL

/**
 * Updates the global user info state object.
 * @param {object|null} dbData - Data from the backend API (/user/me).
 * @param {object|null} propelData - User info from PropelAuth.
 */
function updateUserInfoState(dbData, propelData) {
  currentUserInfo.dbUserData = dbData;
  currentUserInfo.propelUserInfo = propelData;
  currentUserInfo.isLoggedIn = !!propelData;
  window.currentUserInfo = currentUserInfo; // Ensure global state is always up to date
  console.log('[Auth State] Updated:', currentUserInfo);
  // Note: No UI updates triggered directly from here anymore
}

/**
 * Fetches combined user info (backend + PropelAuth) and updates global state.
 * @param {boolean} forceRefresh - Whether to force a token refresh check with PropelAuth.
 * @returns {Promise<boolean>} True if user is logged in with a valid token, false otherwise.
 */
async function fetchCombinedUserInfo(forceRefresh = false) {
  if (!authClient) {
    console.error('[Auth Fetch] Auth client not initialized.');
    updateUserInfoState(null, null);
    currentAccessToken = null;
    return false;
  }

  try {
    const authInfo = await authClient.getAuthenticationInfoOrNull(forceRefresh);
    console.log(`[Auth Fetch] PropelAuth info (${forceRefresh ? 'forced' : 'cached'}):`, authInfo);

    if (authInfo?.accessToken && authInfo?.user) {
      currentAccessToken = authInfo.accessToken;
      let dbUserData = null;
      try {
        const response = await fetch(API_USER_ME_URL, {
          headers: { 'Authorization': `Bearer ${currentAccessToken}` }
        });
        if (response.ok) {
          dbUserData = await response.json();
          console.log('[Auth Fetch] Backend user data:', dbUserData);
        } else {
          console.warn(`[Auth Fetch] Failed to fetch backend user info. Status: ${response.status}`);
          if (response.status === 401 || response.status === 403) {
            console.warn('[Auth Fetch] Backend indicates token is invalid. Treating as logged out.');
            updateUserInfoState(null, null);
            currentAccessToken = null;
            return false;
          }
        }
      } catch (e) {
        console.error('[Auth Fetch] Network error fetching backend user info:', e);
      }
      updateUserInfoState(dbUserData, authInfo.user);
      return true;

    } else {
      console.log('[Auth Fetch] No valid auth info found from PropelAuth.');
      updateUserInfoState(null, null);
      currentAccessToken = null;
      return false;
    }
  } catch (e) {
    console.error('[Auth Fetch] Error fetching PropelAuth info:', e);
    updateUserInfoState(null, null);
    currentAccessToken = null;
    return false;
  }
}

/**
 * Check if user has valid credits based on current state.
 * @returns {boolean} True if the user has a positive number of credits.
 */
function checkCreditValidity() {
  const credits = currentUserInfo.dbUserData?.credits;
  const result = typeof credits === 'number' && !isNaN(credits) && credits > 0;
  return result;
}

/**
 * Update the entire UI by calling functions from ui.js.
 */
async function updateUI() {
  console.log('[Auth UI] Updating UI state...');
  const isLoggedIn = await fetchCombinedUserInfo(false);
  const hasCredit = checkCreditValidity();

  updateNavbarUI(isLoggedIn, currentUserInfo.propelUserInfo, currentUserInfo.dbUserData, authUrl);
  updateToolAccessUI(isLoggedIn, hasCredit);
  // This call now uses the corrected logic inside handleChatInitialization
  handleChatInitialization(isLoggedIn, hasCredit);
}

/**
 * Handles the initialization logic for the chat component based on login state and credits.
 * (This logic remains in auth.js as it depends on auth state)
 * @param {boolean} isLoggedIn - Current login status.
 * @param {boolean} hasCredit - Whether the user has valid credits.
 */
function handleChatInitialization(isLoggedIn, hasCredit) {
  const chatManagerInstance = window.ChatManager; // Get the instance once

  if (isLoggedIn && hasCredit) {
    // Check if the instance and the method exist
    if (chatManagerInstance && typeof chatManagerInstance.initializeChat === 'function') {
      console.log('[Auth] Conditions met, checking initialization status.');
      try {
        // Check the flag ON THE INSTANCE
        if (!chatManagerInstance.chatInitialized) {
          console.log('[Auth] Initializing chat...');
          // Call the method DIRECTLY ON THE INSTANCE
          chatManagerInstance.initializeChat(); // Correct call
        } else {
          console.log('[Auth] ChatManager indicates chat already initialized, skipping call.');
        }
      } catch (error) {
        // Catch errors specifically from the initializeChat call
        console.error('[Auth] Error during ChatManager.initializeChat() execution:', error);
      }
    } else {
      // Log if ChatManager or its method isn't ready
      console.warn('[Auth] window.ChatManager or window.ChatManager.initializeChat not found or not ready.');
    }
  } else {
    // Handle teardown
    console.log('[Auth] Conditions not met for chat initialization (isLoggedIn:', isLoggedIn, 'hasCredit:', hasCredit, ')');
    // Check if the instance and the method exist
    if (chatManagerInstance && typeof chatManagerInstance.teardownChat === 'function') {
      // Check the flag ON THE INSTANCE before tearing down
      if (chatManagerInstance.chatInitialized) {
        console.log('[Auth] Tearing down chat.');
        try {
          // Call the method DIRECTLY ON THE INSTANCE
          chatManagerInstance.teardownChat(); // Correct call
        } catch (error) {
          console.error('[Auth] Error tearing down chat:', error);
        }
      } else {
          console.log('[Auth] Chat not initialized, no teardown needed.'); // Optional log
      }
    } else {
        console.warn('[Auth] window.ChatManager or window.ChatManager.teardownChat not found.'); // Optional log
    }
  }
}

/**
 * Handles delegated click events for login/logout actions from Navbar or inline links.
 * (This logic remains in auth.js as it interacts with authClient)
 * @param {Event} e - The click event object.
 */
function handleAuthActionClick(e) {
  const targetButton = e.target.closest('[data-action="login"], [data-action="logout"]');
  if (!targetButton) return;

  const action = targetButton.dataset.action;
  e.preventDefault();

  if (!authClient) {
    console.error('[Auth Click] Auth client not ready.');
    return;
  }

  if (action === 'login') {
    console.log('[Auth Click] Redirecting to login...');
    authClient.redirectToLoginPage();
  } else if (action === 'logout') {
    console.log('[Auth Click] Logging out...');
    currentAccessToken = null;
    updateUserInfoState(null, null); // Clear state immediately
    authClient.logout(true); // Redirects, page reload will trigger updateUI
  }
}

/**
 * Sets up the initial state and listeners.
 */
async function initializeAuthentication() {
  if (!authUrl) {
    console.error('[Auth Init] PropelAuth URL not found (data-auth-url attribute missing?). Auth disabled.');
    document.addEventListener('DOMContentLoaded', () => {
      // Call UI functions to set initial logged-out state
      updateNavbarUI(false, null, null, null); // No authUrl available
      updateToolAccessUI(false, false);
      const accessPrompt = document.getElementById('tool-access-prompt'); // Use constant TOOL_ACCESS_PROMPT_ID ?
      if (accessPrompt) accessPrompt.textContent = 'Authentication service unavailable.';
    });
    return;
  }

  console.log('[Auth Init] Auth URL Found:', authUrl);
  try {
    authClient = PropelAuth.createClient({
      authUrl,
      enableBackgroundTokenRefresh: true,
    });
    window.authClient = authClient; // Make globally accessible for ui.js

    // Setup listeners AFTER the DOM is loaded
    document.addEventListener('DOMContentLoaded', () => {
      document.body.addEventListener('click', handleAuthActionClick);
      console.log('[Auth Init] Delegated auth action click listener attached to body.');

      console.log('[Auth Init] DOM Loaded. Performing initial auth check and UI update.');
      updateUI(); // Fetch initial state and call UI update functions
    });

    console.log('[Auth Init] PropelAuth Client Initialized.');

  } catch (err) {
    console.error('[Auth Init] Failed to initialize PropelAuth client:', err);
    document.addEventListener('DOMContentLoaded', () => {
      updateNavbarUI(false, null, null, null); // Show login button state
      updateToolAccessUI(false, false); // Show prompt, hide chat
      const accessPrompt = document.getElementById('tool-access-prompt');
      if (accessPrompt) accessPrompt.textContent = 'Error initializing authentication.';

      // Display an error in the navbar login button spot
      const loginItem = document.getElementById(AUTH_NAV_LOGIN_ITEM_ID); // Use constant
      const userItem = document.getElementById(AUTH_NAV_USER_ITEM_ID);   // Use constant
      if (loginItem) {
        loginItem.classList.remove('d-none');
        loginItem.innerHTML = `<span class="nav-link text-danger small px-2 py-1" title="${err.message || 'Unknown auth init error'}"><i class="bi bi-exclamation-triangle-fill me-1"></i> Auth Error</span>`;
      }
      if (userItem) {
        userItem.classList.add('d-none');
      }
    });
  }
}

// --- Start the authentication setup ---
initializeAuthentication();