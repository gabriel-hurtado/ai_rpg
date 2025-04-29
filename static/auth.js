// auth.js - Authentication & UI Toggling (Static Elements + JS Toggling/Text Updates)

console.log('[Auth] auth.js loaded.');

// --- Constants for DOM Elements ---
// Navbar Auth States
const AUTH_NAV_LOGIN_ITEM_ID = 'auth-nav-login-item';
const AUTH_NAV_USER_ITEM_ID = 'auth-nav-user-item';
// Dynamic parts within User Dropdown
const NAVBAR_USER_DISPLAY_ID = 'navbar-user-display';
const NAVBAR_USER_CREDITS_ID = 'navbar-user-credits';
const NAVBAR_ACCOUNT_LINK_ID = 'navbar-account-link';
// Main Content Area
const PURCHASE_BUTTON_ID = 'purchase-button';
const AI_PROMPT_INPUT_ID = 'ai-prompt-input';
const AI_GENERATE_BUTTON_ID = 'ai-generate-button';
const TOOL_ACCESS_PROMPT_ID = 'tool-access-prompt';
const CHAT_INTERFACE_CONTAINER_ID = 'chat-interface-container';

// --- Global Auth State ---
let authClient = null;
let currentAccessToken = null;
const currentUserInfo = { // Centralized state object
  dbUserData: null,
  propelUserInfo: null,
  isLoggedIn: false,
};

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
  currentUserInfo.isLoggedIn = !!propelData; // User is logged in if propelData exists
  console.log('[Auth State] Updated:', currentUserInfo);
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
    // Use cached token info by default (false) unless forced
    const authInfo = await authClient.getAuthenticationInfoOrNull(forceRefresh);
    console.log(`[Auth Fetch] PropelAuth info (${forceRefresh ? 'forced' : 'cached'}):`, authInfo);

    if (authInfo?.accessToken && authInfo?.user) {
      currentAccessToken = authInfo.accessToken; // Update global token
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
            updateUserInfoState(null, null); // Clear state
            currentAccessToken = null;
            return false; // Return false as backend validation failed
          }
        }
      } catch (e) {
        console.error('[Auth Fetch] Network error fetching backend user info:', e);
      }
      updateUserInfoState(dbUserData, authInfo.user); // Update state
      return true; // User is logged in according to PropelAuth

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
    // Ensure credits is a number and greater than 0
    const result = typeof credits === 'number' && !isNaN(credits) && credits > 0;
    // console.log(`[Debug Credits Check] Value: ${credits}, Result: ${result}`); // Optional debug log
    return result;
}


/**
 * Update the entire UI based on the latest fetched user state.
 */
async function updateUI() {
  console.log('[Auth UI] Updating UI state...');
  // Fetch user info (usually using cached token unless forced elsewhere)
  const isLoggedIn = await fetchCombinedUserInfo(false);
  const hasCredit = checkCreditValidity(); // Check based on potentially updated state

  // Update UI parts based on fetched state
  updateNavbarUI(isLoggedIn, currentUserInfo.propelUserInfo, currentUserInfo.dbUserData);
  updateToolAccessUI(isLoggedIn, hasCredit);
  handleChatInitialization(isLoggedIn, hasCredit);
}

/**
 * Update Navbar: Toggle visibility of login button vs user dropdown
 * and update dynamic text content.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {object|null} propelUser - User info from PropelAuth.
 * @param {object|null} dbUser - User info from backend API.
 */
function updateNavbarUI(isLoggedIn, propelUser, dbUser) {
  const loginItem = document.getElementById(AUTH_NAV_LOGIN_ITEM_ID);
  const userItem = document.getElementById(AUTH_NAV_USER_ITEM_ID);

  // Ensure both elements are found before proceeding
  if (!loginItem || !userItem) {
    console.error(`[Auth UI] Navbar auth items not found! Missing #${AUTH_NAV_LOGIN_ITEM_ID} or #${AUTH_NAV_USER_ITEM_ID}. Cannot update navbar.`);
    return; // Stop this function if elements aren't present
  }

  // Toggle visibility based on login state
  loginItem.classList.toggle('d-none', isLoggedIn); // Show login button IF NOT logged in
  userItem.classList.toggle('d-none', !isLoggedIn); // Show user dropdown IF logged in

  // If logged in, update the dynamic content within the user dropdown
  if (isLoggedIn && !userItem.classList.contains('d-none') && propelUser) {
    const userDisplaySpan = document.getElementById(NAVBAR_USER_DISPLAY_ID);
    const userCreditsSpan = document.getElementById(NAVBAR_USER_CREDITS_ID);
    const accountLink = document.getElementById(NAVBAR_ACCOUNT_LINK_ID);

    // Update User Name/Email
    if (userDisplaySpan) {
      userDisplaySpan.textContent = propelUser.email || propelUser.userId || 'User';
    } else {
      console.warn(`[Auth UI] Element #${NAVBAR_USER_DISPLAY_ID} not found.`);
    }

    // Update Credits
    if (userCreditsSpan) {
      const credits = dbUser?.credits ?? '--'; // Default to '--' if null/undefined
      userCreditsSpan.textContent = `Credits: ${credits}`;
    } else {
      console.warn(`[Auth UI] Element #${NAVBAR_USER_CREDITS_ID} not found.`);
    }

    // Update Account Link href (using authUrl from global scope)
    if (accountLink) {
        if (authUrl) {
             accountLink.href = `${authUrl}/account`;
             // Restore defaults in case they were previously disabled
             accountLink.target = '_blank';
             accountLink.style.pointerEvents = '';
             accountLink.style.opacity = '';
        } else {
            console.warn(`[Auth UI] authUrl not available to set account link.`);
            accountLink.href = '#'; // Fallback href
            accountLink.target = ''; // Remove target
            accountLink.style.pointerEvents = 'none'; // Disable click
            accountLink.style.opacity = '0.5'; // Dim link
        }
    } else {
         console.warn(`[Auth UI] Element #${NAVBAR_ACCOUNT_LINK_ID} not found.`);
    }
  }
}

/**
 * Update Tool Access Area: Toggle visibility of prompt vs chat interface.
 * Relies on CSS classes (e.g., 'd-none') being present in the HTML structure.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {boolean} hasCredit - Whether the user has valid credits.
 */
function updateToolAccessUI(isLoggedIn, hasCredit) {
  const purchaseButton = document.getElementById(PURCHASE_BUTTON_ID);
  const aiPromptInput = document.getElementById(AI_PROMPT_INPUT_ID);
  const aiGenerateButton = document.getElementById(AI_GENERATE_BUTTON_ID);
  const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
  const chatContainer = document.getElementById(CHAT_INTERFACE_CONTAINER_ID);

  const canUseAI = isLoggedIn && hasCredit;

  // --- Purchase Button ---
  if (purchaseButton) {
    const showPurchaseButton = isLoggedIn && !hasCredit;
    purchaseButton.classList.toggle('d-none', !showPurchaseButton);
    purchaseButton.disabled = !showPurchaseButton;
  } else {
      // Don't warn if it's intentionally missing
      // console.warn(`[Auth UI Warn] Purchase button #${PURCHASE_BUTTON_ID} not found.`);
  }

  // --- Chat Interface vs. Prompt ---
  if (chatContainer) {
     chatContainer.classList.toggle('d-none', !canUseAI);
  } else {
      console.warn(`[Auth UI Warn] Chat container #${CHAT_INTERFACE_CONTAINER_ID} not found.`);
  }

  if (accessPrompt) {
      accessPrompt.classList.toggle('d-none', canUseAI);
      // Update prompt text only if it's supposed to be visible
      if (!canUseAI) {
         if (!isLoggedIn) {
             accessPrompt.innerHTML = `Please <a href="#" data-action="login" class="link-primary">Login or Sign Up</a> to use the AI tools.`;
         } else {
             accessPrompt.textContent = 'You need credits to use the AI tools. Please purchase credits.';
         }
      } else {
          accessPrompt.textContent = ''; // Clear text when prompt is hidden
      }
  } else {
       console.warn(`[Auth UI Warn] Access prompt #${TOOL_ACCESS_PROMPT_ID} not found.`);
  }

  // --- Enable/Disable Chat Inputs ---
  if (aiPromptInput) aiPromptInput.disabled = !canUseAI;
  if (aiGenerateButton) aiGenerateButton.disabled = !canUseAI;

  console.log(`[Auth UI] Tool access updated. Can use AI: ${canUseAI}`);
}

/**
 * Handles the initialization logic for the chat component based on login state and credits.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {boolean} hasCredit - Whether the user has valid credits.
 */
function handleChatInitialization(isLoggedIn, hasCredit) {
  // Only initialize chat if the user is logged in AND has credits
  if (isLoggedIn && hasCredit) {
      const initializeChatFunction = window.ChatManager?.initializeChat;
      if (typeof initializeChatFunction === 'function') {
          console.log('[Auth] Conditions met, initializing chat.');
          try {
              if (window.ChatManager && !window.ChatManager.chatInitialized) {
                   initializeChatFunction();
              } else {
                   console.log('[Auth] ChatManager indicates chat already initialized, skipping call.');
              }
          } catch (error) { console.error('[Auth] Error during ChatManager.initializeChat():', error); }
      } else { console.warn('[Auth] ChatManager.initializeChat function not found or not ready.'); }
  } else {
       console.log('[Auth] Conditions not met for chat initialization (isLoggedIn:', isLoggedIn, 'hasCredit:', hasCredit, ')');
       const teardownChatFunction = window.ChatManager?.teardownChat;
       if (typeof teardownChatFunction === 'function') {
           if (window.ChatManager && window.ChatManager.chatInitialized) {
               console.log('[Auth] Tearing down chat.');
               try { teardownChatFunction(); } catch (error) { console.error('[Auth] Error tearing down chat:', error); }
           }
       }
  }
}


/**
 * Handles delegated click events for login/logout actions from Navbar or inline links.
 * @param {Event} e - The click event object.
 */
function handleAuthActionClick(e) {
  // Find the closest element with data-action="login" or data-action="logout"
  const targetButton = e.target.closest('[data-action="login"], [data-action="logout"]');
  if (!targetButton) return; // Click was not on a relevant action element

  const action = targetButton.dataset.action;
  e.preventDefault(); // Prevent default link/button behavior for these actions

  if (!authClient) {
    console.error('[Auth Click] Auth client not ready.');
    return;
  }

  if (action === 'login') {
    console.log('[Auth Click] Redirecting to login...');
    authClient.redirectToLoginPage();
  } else if (action === 'logout') {
    console.log('[Auth Click] Logging out...');
    currentAccessToken = null; // Clear token immediately
    updateUserInfoState(null, null); // Clear state immediately (navbar update happens in updateUI after reload)
    authClient.logout(true); // Redirects, page reload will trigger updateUI
  }
}

/**
 * Sets up the initial state and listeners.
 */
async function initializeAuthentication() {
  if (!authUrl) {
    console.error('[Auth Init] PropelAuth URL not found (data-auth-url attribute missing?). Auth disabled.');
    // Update UI to reflect disabled state on DOM load
    document.addEventListener('DOMContentLoaded', () => {
        updateNavbarUI(false, null, null); // Show login button state initially
        updateToolAccessUI(false, false); // Show prompt, hide chat
        const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
        if (accessPrompt) accessPrompt.textContent = 'Authentication service unavailable.';
    });
    return; // Stop initialization
  }

  console.log('[Auth Init] Auth URL Found:', authUrl);
  try {
    authClient = PropelAuth.createClient({
      authUrl,
      enableBackgroundTokenRefresh: true,
    });

    // Setup listeners AFTER the DOM is loaded
    document.addEventListener('DOMContentLoaded', () => {
      // Attach delegated listener for login/logout clicks anywhere on the body
      document.body.addEventListener('click', handleAuthActionClick);
      console.log('[Auth Init] Delegated auth action click listener attached to body.');

      // Perform initial UI update after DOM is ready and listeners are attached
      console.log('[Auth Init] DOM Loaded. Performing initial auth check and UI update.');
      updateUI(); // Fetch initial state and update UI classes/state
    });

    console.log('[Auth Init] PropelAuth Client Initialized.');

  } catch (err) {
    console.error('[Auth Init] Failed to initialize PropelAuth client:', err);
    // Update UI to reflect error state on DOM load
    document.addEventListener('DOMContentLoaded', () => {
      updateNavbarUI(false, null, null); // Show login button state
      updateToolAccessUI(false, false); // Show prompt, hide chat
      const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
      if (accessPrompt) accessPrompt.textContent = 'Error initializing authentication.';
      // Display an error in the navbar login button spot
      const loginItem = document.getElementById(AUTH_NAV_LOGIN_ITEM_ID);
      const userItem = document.getElementById(AUTH_NAV_USER_ITEM_ID);
      if(loginItem) {
          loginItem.classList.remove('d-none'); // Make sure it's visible
          // More robust error display
          loginItem.innerHTML = `<span class="nav-link text-danger small px-2 py-1" title="${err.message || 'Unknown auth init error'}"><i class="bi bi-exclamation-triangle-fill me-1"></i> Auth Error</span>`;
      }
      if (userItem) {
          userItem.classList.add('d-none'); // Hide user dropdown spot
      }
    });
  }
}

// --- Start the authentication setup ---
initializeAuthentication();