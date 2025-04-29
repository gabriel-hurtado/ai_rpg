// auth.js - Authentication and user state management (Refactored)

console.log('[Auth] auth.js loaded.');

// --- Constants for DOM Elements ---
const AUTH_NAV_LINK_ID = 'auth-nav-link';
const PURCHASE_BUTTON_ID = 'purchase-button';
const AI_PROMPT_INPUT_ID = 'ai-prompt-input';
const AI_GENERATE_BUTTON_ID = 'ai-generate-button';
const TOOL_ACCESS_AREA_ID = 'tool-access-area';

// --- Global Auth State ---
let authClient = null;
let currentAccessToken = null;
const currentUserInfo = {
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
const API_USER_ME_URL = '/api/v1/user/me';

/**
 * Updates the global user info state object.
 * @param {object|null} dbData - Data from the backend API (/user/me).
 * @param {object|null} propelData - User info from PropelAuth.
 */
function updateUserInfoState(dbData, propelData) {
  currentUserInfo.dbUserData = dbData;
  currentUserInfo.propelUserInfo = propelData;
  currentUserInfo.isLoggedIn = !!propelData;
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
  return typeof credits === 'number' && credits > 0;
}

/**
 * Update the entire UI based on the latest fetched user state.
 */
async function updateUI() {
  const isLoggedIn = await fetchCombinedUserInfo(false);
  const hasCredit = checkCreditValidity();

  displayLoginState(isLoggedIn, currentUserInfo.propelUserInfo, currentUserInfo.dbUserData);
  updatePaymentDependentUI(isLoggedIn, hasCredit);
  handleChatInitialization(isLoggedIn);
}

/**
 * Display login state in the navbar.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {object|null} propelUser - User info from PropelAuth.
 * @param {object|null} dbUser - User info from backend API.
 */
function displayLoginState(isLoggedIn, propelUser, dbUser) {
  const authNavLink = document.getElementById(AUTH_NAV_LINK_ID);
  if (!authNavLink) {
    console.error(`[Auth UI] Auth nav link container #${AUTH_NAV_LINK_ID} not found!`);
    return;
  }

  authNavLink.innerHTML = '';

  if (isLoggedIn && propelUser) {
    const credits = dbUser?.credits ?? 0;
    const userDisplay = propelUser.email || propelUser.userId || 'User';
    authNavLink.innerHTML = `
      <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
        <i class="bi bi-person-circle me-1"></i> ${userDisplay} <span class="small ms-2 text-warning">Credits: ${credits}</span>
      </a>
      <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end" aria-labelledby="navbarUserDropdown">
        <li><a class="dropdown-item" href="${authUrl}/account" target="_blank">Account</a></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item" data-action="logout" style="/* Styles for consistency */">Logout</button></li>
      </ul>`;
  } else {
    authNavLink.innerHTML = `<a class="nav-link btn btn-sm btn-primary custom-btn" href="#" data-action="login">Login / Sign Up</a>`;
  }
}

/**
 * Update UI elements that depend on login status and credits.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {boolean} hasCredit - Whether the user has valid credits.
 */
function updatePaymentDependentUI(isLoggedIn, hasCredit) {
  const purchaseButton = document.getElementById(PURCHASE_BUTTON_ID);
  const aiPromptInput = document.getElementById(AI_PROMPT_INPUT_ID);
  const aiGenerateButton = document.getElementById(AI_GENERATE_BUTTON_ID);
  const toolAccessArea = document.getElementById(TOOL_ACCESS_AREA_ID);
  const loginPrompt = toolAccessArea?.querySelector('p.lead');
  const aiForm = document.getElementById('ai-generation-form');

  const canUseAI = isLoggedIn && hasCredit;

  if (purchaseButton) {
    purchaseButton.disabled = !isLoggedIn;
    purchaseButton.style.display = isLoggedIn && !hasCredit ? '' : 'none';
  }

  if (aiPromptInput) aiPromptInput.disabled = !canUseAI;
  if (aiGenerateButton) aiGenerateButton.disabled = !canUseAI;

  if (toolAccessArea) {
    if (canUseAI || !isLoggedIn || (isLoggedIn && !hasCredit)) {
      toolAccessArea.style.display = '';
    } else {
      toolAccessArea.style.display = 'none';
    }

    if (aiForm) {
      aiForm.style.display = canUseAI ? '' : 'none';
    }

    if (loginPrompt) {
      if (canUseAI) {
        loginPrompt.style.display = 'none';
        loginPrompt.textContent = '';
      } else {
        loginPrompt.style.display = '';
        if (!isLoggedIn) {
          loginPrompt.innerHTML = `Please <a href="#" data-action="login">Login or Sign Up</a> to use the AI tools.`;
        } else {
          loginPrompt.textContent = 'You need credits to use the AI tools. Please purchase credits.';
        }
      }
    }
  } else {
    if (aiForm) {
      aiForm.style.display = canUseAI ? '' : 'none';
    }
    console.warn("[Auth UI] Tool Access Area not found, controlling form directly.");
  }
}

/**
 * Handles the initialization logic for the chat component based on login state.
 * @param {boolean} isLoggedIn - Current login status.
 */
function handleChatInitialization(isLoggedIn) {
  const initializeChatFunction = window.ChatManager?.initializeChat;

  if (isLoggedIn && typeof initializeChatFunction === 'function') {
    console.log('[Auth] User logged in, initializing chat.');
    try {
      initializeChatFunction();
    } catch (error) {
      console.error('[Auth] Error during ChatManager.initializeChat():', error);
    }
  } else if (!isLoggedIn) {
    const teardownChatFunction = window.ChatManager?.teardownChat;
    if (typeof teardownChatFunction === 'function') {
      console.log('[Auth] User logged out, tearing down chat.');
      try {
        teardownChatFunction();
      } catch (error) {
        console.error('[Auth] Error during ChatManager.teardownChat():', error);
      }
    }
  }
}

/**
 * Handles delegated click events for login/logout actions.
 * @param {Event} e - The click event object.
 */
function handleAuthActionClick(e) {
  const targetButton = e.target.closest('[data-action]');
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
    updateUserInfoState(null, null);
    authClient.logout(true);
  }
}

document.addEventListener('click', handleAuthActionClick, true);

/**
 * Sets up the initial state and listeners.
 */
async function initializeAuthentication() {
  if (!authUrl) {
    console.error('[Auth Init] PropelAuth URL not found (data-auth-url attribute missing?). Auth disabled.');
    document.addEventListener('DOMContentLoaded', () => {
      displayLoginState(false, null, null);
      updatePaymentDependentUI(false, false);
      const toolAccessArea = document.getElementById(TOOL_ACCESS_AREA_ID);
      const loginPrompt = toolAccessArea?.querySelector('.lead');
      if (loginPrompt) loginPrompt.textContent = 'Authentication service unavailable.';
    });
    return;
  }

  console.log('[Auth Init] Auth URL Found:', authUrl);
  try {
    authClient = PropelAuth.createClient({
      authUrl,
      enableBackgroundTokenRefresh: true,
    });

    document.addEventListener('DOMContentLoaded', () => {
      const authNavContainer = document.getElementById(AUTH_NAV_LINK_ID);
      if (authNavContainer) {
        authNavContainer.addEventListener('click', handleAuthActionClick);
        console.log('[Auth Init] Delegated click listener attached to #' + AUTH_NAV_LINK_ID);
      } else {
        console.error('[Auth Init] Could not find #' + AUTH_NAV_LINK_ID + ' to attach delegated listener.');
      }

      console.log('[Auth Init] DOM Loaded. Performing initial auth check and UI update.');
      updateUI();
    });

    console.log('[Auth Init] PropelAuth Client Initialized.');
  } catch (err) {
    console.error('[Auth Init] Failed to initialize PropelAuth client:', err);
    document.addEventListener('DOMContentLoaded', () => {
      displayLoginState(false, null, null);
      updatePaymentDependentUI(false, false);
      const toolAccessArea = document.getElementById(TOOL_ACCESS_AREA_ID);
      const loginPrompt = toolAccessArea?.querySelector('.lead');
      if (loginPrompt) loginPrompt.textContent = 'Error initializing authentication.';
      const authNavLink = document.getElementById(AUTH_NAV_LINK_ID);
      if (authNavLink) authNavLink.innerHTML = `<span class="nav-link text-danger small">Auth Error</span>`;
    });
  }
}

initializeAuthentication();