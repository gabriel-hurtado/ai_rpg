// auth.js - Authentication and UI Toggling (Jinja/SSR Focused)

console.log('[Auth] auth.js loaded.');

// --- Constants for DOM Elements ---
const AUTH_NAV_LINK_ID = 'auth-nav-link';
const PURCHASE_BUTTON_ID = 'purchase-button';
const AI_PROMPT_INPUT_ID = 'ai-prompt-input';
const AI_GENERATE_BUTTON_ID = 'ai-generate-button';
const TOOL_ACCESS_PROMPT_ID = 'tool-access-prompt'; // ID for the prompt paragraph
const CHAT_INTERFACE_CONTAINER_ID = 'chat-interface-container'; // ID for the chat UI wrapper

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
  // Consider adding future logic here if needed, e.g., proactive refresh check
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
          // Handle backend fetch errors specifically
          console.warn(`[Auth Fetch] Failed to fetch backend user info. Status: ${response.status}`);
          // If backend token is invalid (401/403), treat as logged out for app features?
          if (response.status === 401 || response.status === 403) {
            console.warn('[Auth Fetch] Backend indicates token is invalid. Treating as logged out.');
            // Optionally force a logout if the backend rejects the token
            // authClient.logout(true);
            updateUserInfoState(null, null); // Clear state even if Propel thinks user is logged in
            currentAccessToken = null;
            return false; // Return false as backend validation failed
          }
          // For other errors, we might still have Propel info, but backend data is missing
        }
      } catch (e) {
        console.error('[Auth Fetch] Network error fetching backend user info:', e);
        // Keep Propel info but acknowledge backend data is missing
      }
      // Update state with potentially partial data (Propel user + null/failed DB data)
      updateUserInfoState(dbUserData, authInfo.user);
      return true; // User is logged in according to PropelAuth

    } else {
      // Not logged in according to PropelAuth
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
    // --- DETAILED DEBUG LOGGING ---
    console.log(`[Debug Credits Check] --- Start ---`);
    const dbDataExists = !!currentUserInfo.dbUserData;
    console.log(`[Debug Credits Check] currentUserInfo.dbUserData exists: ${dbDataExists}`);

    // Log the raw value from the state object
    const creditsRaw = currentUserInfo.dbUserData?.credits;
    console.log(`[Debug Credits Check] Raw credits value from state: ${creditsRaw} (type: ${typeof creditsRaw})`);

    // Perform the checks step-by-step
    const isNumber = typeof creditsRaw === 'number';
    console.log(`[Debug Credits Check] Check 1: typeof === 'number'? ${isNumber}`);

    const isNotNaNValue = !isNaN(creditsRaw); // isNaN(null) is false -> !isNaN(null) is true. isNaN(undefined) is true -> !isNaN(undefined) is false.
    console.log(`[Debug Credits Check] Check 2: !isNaN()? ${isNotNaNValue}`);

    const isPositive = creditsRaw > 0;
    console.log(`[Debug Credits Check] Check 3: > 0? ${isPositive}`);

    // Final combined result
    const result = isNumber && isNotNaNValue && isPositive;
    console.log(`[Debug Credits Check] Final Result: ${result}`);
    console.log(`[Debug Credits Check] --- End ---`);
    // --- END DEBUG LOGGING ---

    // Original logic (simplified):
    const credits = currentUserInfo.dbUserData?.credits;
    return typeof credits === 'number' && !isNaN(credits) && credits > 0;

    // Note: The detailed logging result should match this simplified return line's logic
    // If they don't match, there's a logic error in the debug logs themselves!
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
  updateToolAccessUI(isLoggedIn, hasCredit); // Use the new function for visibility toggling
  handleChatInitialization(isLoggedIn, hasCredit); // Pass hasCredit too
}

/**
 * Update Navbar: Display Login button or User dropdown.
 * (Minimal innerHTML injection is kept here for simplicity)
 * @param {boolean} isLoggedIn - Current login status.
 * @param {object|null} propelUser - User info from PropelAuth.
 * @param {object|null} dbUser - User info from backend API.
 */
function updateNavbarUI(isLoggedIn, propelUser, dbUser) {
  const authNavLink = document.getElementById(AUTH_NAV_LINK_ID);
  if (!authNavLink) {
    console.error(`[Auth UI] Auth nav link container #${AUTH_NAV_LINK_ID} not found!`);
    return;
  }

  authNavLink.innerHTML = ''; // Clear previous content

  if (isLoggedIn && propelUser) {
    const credits = dbUser?.credits ?? 0; // Safely access credits, default to 0
    const userDisplay = propelUser.email || propelUser.userId || 'User'; // Fallback display name
    // Inject the dropdown HTML
    authNavLink.innerHTML = `
      <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
        <i class="bi bi-person-circle me-1"></i> ${userDisplay} <span class="small ms-2 text-warning">Credits: ${credits}</span>
      </a>
      <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end" aria-labelledby="navbarUserDropdown">
        <li><a class="dropdown-item" href="${authUrl}/account" target="_blank">Account</a></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item" data-action="logout">Logout</button></li>
      </ul>`;
  } else {
    // Inject the login button HTML
    authNavLink.innerHTML = `<a class="nav-link btn btn-sm btn-primary custom-btn" href="#" data-action="login">Login / Sign Up</a>`;
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
    // Show if logged in but no credits, hide otherwise
    const showPurchaseButton = isLoggedIn && !hasCredit;
    purchaseButton.classList.toggle('d-none', !showPurchaseButton);
    purchaseButton.disabled = !showPurchaseButton; // Also disable if hidden
  }

  // --- Chat Interface vs. Prompt ---
  if (chatContainer) {
     // Hide chat container if cannot use AI, show otherwise
     chatContainer.classList.toggle('d-none', !canUseAI);
  }
  if (accessPrompt) {
      // Hide prompt if CAN use AI, show otherwise
      accessPrompt.classList.toggle('d-none', canUseAI);

      // Update prompt text only if it's supposed to be visible
      if (!canUseAI) {
         if (!isLoggedIn) {
             // Ensure link has data-action for the listener
             accessPrompt.innerHTML = `Please <a href="#" data-action="login" class="link-primary">Login or Sign Up</a> to use the AI tools.`;
         } else { // Logged in but no credits
             accessPrompt.textContent = 'You need credits to use the AI tools. Please purchase credits.';
         }
      }
  }

  // --- Enable/Disable Chat Inputs ---
  // Ensure elements exist before trying to set disabled property
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
      // Use optional chaining and type check for robustness
      const initializeChatFunction = window.ChatManager?.initializeChat;
      if (typeof initializeChatFunction === 'function') {
          console.log('[Auth] Conditions met, initializing chat.');
          try {
              // Check if chat.js's internal state thinks it's already initialized
              // This avoids re-running loadLatestConversation if not needed.
              // Assumes ChatManager exposes 'chatInitialized' or similar property.
              if (window.ChatManager && !window.ChatManager.chatInitialized) {
                   initializeChatFunction(); // Call chat.js initialization
              } else {
                   console.log('[Auth] ChatManager indicates chat already initialized, skipping call.');
              }
          } catch (error) {
              console.error('[Auth] Error during ChatManager.initializeChat():', error);
          }
      } else {
          console.warn('[Auth] ChatManager.initializeChat function not found or not ready.');
      }
  } else {
       console.log('[Auth] Conditions not met for chat initialization (isLoggedIn:', isLoggedIn, 'hasCredit:', hasCredit, ')');
       // Optional: Call a teardown function if user logs out or loses credits
       const teardownChatFunction = window.ChatManager?.teardownChat;
       if (typeof teardownChatFunction === 'function') {
           // Optionally check if chat WAS initialized before tearing down
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
    // Optionally provide user feedback, e.g., alert('Authentication service is not available.');
    return;
  }

  if (action === 'login') {
    console.log('[Auth Click] Redirecting to login...');
    authClient.redirectToLoginPage();
  } else if (action === 'logout') {
    console.log('[Auth Click] Logging out...');
    currentAccessToken = null; // Clear token immediately
    updateUserInfoState(null, null); // Clear state immediately
    // Redirect to logout endpoint (true = redirect after logout)
    // This will cause a page reload, after which updateUI will run again.
    authClient.logout(true);
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
        updateNavbarUI(false, null, null); // Show login button
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
      // Removed onUserLoggedIn/onUserLoggedOut callbacks for simpler flow
    });

    // Setup listeners AFTER the DOM is loaded
    document.addEventListener('DOMContentLoaded', () => {
      // Attach delegated listener for login/logout clicks anywhere on the body
      // This covers navbar buttons and inline links like in the prompt.
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
      updateNavbarUI(false, null, null); // Show login button
      updateToolAccessUI(false, false); // Show prompt, hide chat
      const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
      if (accessPrompt) accessPrompt.textContent = 'Error initializing authentication.';
      const authNavLink = document.getElementById(AUTH_NAV_LINK_ID);
      // Display a clearer error in the navbar instead of just the login button
      if (authNavLink) authNavLink.innerHTML = `<span class="nav-link text-danger small" title="${err.message || 'Unknown auth init error'}">Auth Error</span>`;
    });
  }
}

// --- Start the authentication setup ---
initializeAuthentication();