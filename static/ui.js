// static/ui.js - UI Update Functions (Exported)

console.log('[ui.js] loaded.');

// --- Constants (Define IDs needed within this file) ---
const AUTH_NAV_LOGIN_ITEM_ID = 'auth-nav-login-item';
const AUTH_NAV_USER_ITEM_ID = 'auth-nav-user-item';
const NAVBAR_USER_DISPLAY_ID = 'navbar-user-display';
const NAVBAR_USER_CREDITS_ID = 'navbar-user-credits';
const NAVBAR_ACCOUNT_LINK_ID = 'navbar-account-link';
const PURCHASE_BUTTON_ID = 'purchase-button';
const AI_PROMPT_INPUT_ID = 'ai-prompt-input';
const AI_GENERATE_BUTTON_ID = 'ai-generate-button';
const TOOL_ACCESS_PROMPT_ID = 'tool-access-prompt';
const CHAT_INTERFACE_CONTAINER_ID = 'chat-interface-container';

/**
 * Update Navbar: Toggle visibility of login button vs user dropdown
 * and update dynamic text content.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {object|null} propelUser - User info from PropelAuth.
 * @param {object|null} dbUser - User info from backend API.
 * @param {string|null} authUrl - The base URL for PropelAuth pages.
 */
export function updateNavbarUI(isLoggedIn, propelUser, dbUser, authUrl) {
  console.log('[UI] Updating Navbar UI. isLoggedIn:', isLoggedIn);
  const loginItem = document.getElementById(AUTH_NAV_LOGIN_ITEM_ID);
  const userItem = document.getElementById(AUTH_NAV_USER_ITEM_ID);

  if (!loginItem || !userItem) {
    console.error(`[UI] Navbar auth items not found! Missing #${AUTH_NAV_LOGIN_ITEM_ID} or #${AUTH_NAV_USER_ITEM_ID}.`);
    return;
  }

  // Toggle visibility
  loginItem.classList.toggle('d-none', isLoggedIn);
  userItem.classList.toggle('d-none', !isLoggedIn);

  // Update dynamic content if user is logged in and dropdown is visible
  if (isLoggedIn && !userItem.classList.contains('d-none') && propelUser) {
    const userDisplaySpan = document.getElementById(NAVBAR_USER_DISPLAY_ID);
    const userCreditsSpan = document.getElementById(NAVBAR_USER_CREDITS_ID);
    const accountLink = document.getElementById(NAVBAR_ACCOUNT_LINK_ID);

    if (userDisplaySpan) {
      userDisplaySpan.textContent = propelUser.email || propelUser.userId || 'User';
    } else {
      console.warn(`[UI] Element #${NAVBAR_USER_DISPLAY_ID} not found.`);
    }

    if (userCreditsSpan) {
      const credits = dbUser?.credits ?? '--';
      userCreditsSpan.textContent = `Credits: ${credits}`;
    } else {
      console.warn(`[UI] Element #${NAVBAR_USER_CREDITS_ID} not found.`);
    }

    if (accountLink) {
      if (authUrl) {
        accountLink.href = `${authUrl}/account`;
        accountLink.target = '_blank';
        accountLink.style.pointerEvents = '';
        accountLink.style.opacity = '';
      } else {
        console.warn(`[UI] authUrl not available to set account link.`);
        accountLink.href = '#';
        accountLink.target = '';
        accountLink.style.pointerEvents = 'none';
        accountLink.style.opacity = '0.5';
      }
    } else {
      console.warn(`[UI] Element #${NAVBAR_ACCOUNT_LINK_ID} not found.`);
    }
  }
}

/**
 * Update Tool Access Area: Toggle visibility of prompt vs chat interface.
 * Handles purchase button logic.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {boolean} hasCredit - Whether the user has valid credits.
 */
export function updateToolAccessUI(isLoggedIn, hasCredit) {
  console.log('[UI] Updating Tool Access UI. isLoggedIn:', isLoggedIn, 'hasCredit:', hasCredit);
  const purchaseButton = document.getElementById(PURCHASE_BUTTON_ID);
  const aiPromptInput = document.getElementById(AI_PROMPT_INPUT_ID);
  const aiGenerateButton = document.getElementById(AI_GENERATE_BUTTON_ID);
  const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
  const chatContainer = document.getElementById(CHAT_INTERFACE_CONTAINER_ID);

  const canUseAI = isLoggedIn && hasCredit;

  // --- Purchase Button Logic ---
  if (purchaseButton) {
    const showPurchaseButton = true;

    // --- Visibility Control (Assumes HTML might have d-none initially) ---
    purchaseButton.classList.toggle('d-none', !showPurchaseButton);

    // --- Disabled State ---
    purchaseButton.disabled = !showPurchaseButton;

    // --- Attach Listener (ONLY ONCE when button should be active) ---
    if (showPurchaseButton && purchaseButton.dataset.listenerAttached !== 'true') {
      console.log('[UI] Attaching purchase button click listener');
      purchaseButton.dataset.listenerAttached = 'true'; // Mark as attached
      purchaseButton.addEventListener('click', async () => {
        console.log('[Purchase Button Click] Initiated.');
        if (purchaseButton.disabled) {
          console.log('[Purchase Button Click] Aborted, button is disabled.');
          return;
        }

        // Check login state before proceeding
        if (!window.currentUserInfo || !window.currentUserInfo.isLoggedIn) {
          console.log('[Purchase Button Click] User not logged in, redirecting to login/signup.');
          if (window.authClient && typeof window.authClient.redirectToLoginPage === 'function') {
            window.authClient.redirectToLoginPage();
          } else {
            // Fallback: try to click the login link if present
            const loginLink = document.querySelector('[data-action="login"]');
            if (loginLink) {
              loginLink.click();
            } else {
              alert('Please login or sign up to purchase credits.');
            }
          }
          return;
        }

        purchaseButton.disabled = true;
        purchaseButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Processing...';

        let token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null; // Assumes getCurrentAccessToken is globally available from auth.js

        // Attempt refresh if token is missing (optional, assumes authClient is global or accessible)
        if (!token && window.authClient) {
          console.warn("[Purchase Click] Token missing, attempting refresh via window.authClient...");
          try {
            const authInfo = await window.authClient.getAuthenticationInfoOrNull(true);
            token = authInfo?.accessToken;
            if (token) console.log("[Purchase Click] Token refreshed successfully.");
            // Note: Doesn't update auth.js state here, only gets token for this action
          } catch (refreshError) {
            console.error("[Purchase Click] Error refreshing token:", refreshError);
            token = null;
          }
        }

        if (!token) {
          console.error("[Purchase Click] Cannot purchase: Token unavailable.");
          alert("Your session may have expired or is invalid. Please refresh the page or log in again.");
          purchaseButton.disabled = false; // Re-enable
          purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Buy credits';
          // Consider triggering a full UI refresh from auth.js if possible
          // Or simply reload: window.location.reload();
          return;
        }

        // Proceed with fetch
        try {
          const response = await fetch('/api/v1/payment/create-checkout-session', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!response.ok) {
            let errorMsg = `Error: ${response.status}`;
            try { errorMsg = (await response.json()).detail || errorMsg; } catch (e) {}
            console.error("[Purchase Click] Checkout session creation failed:", errorMsg);
            alert(`Could not initiate payment: ${errorMsg}`);
          } else {
            const data = await response.json();
            if (data.checkout_url) {
              console.log("[Purchase Click] Redirecting to Stripe:", data.checkout_url);
              window.location.href = data.checkout_url;
              return; // Stop processing, navigating away
            } else {
              console.error("[Purchase Click] No checkout_url received.");
              alert("Payment setup error. Please try again later.");
            }
          }
        } catch (error) {
          console.error("[Purchase Click] Network error:", error);
          alert("A network error occurred. Please check your connection.");
        }

        // Re-enable button ONLY if not redirected
        console.log("[Purchase Click] Resetting button state.");
        purchaseButton.disabled = false;
        purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Buy credits';
      });
    } else if (!showPurchaseButton && purchaseButton.dataset.listenerAttached === 'true') {
      // Optional: Cleanup logic if needed
      console.log('[UI] Purchase button hidden, listener could be removed.');
      // delete purchaseButton.dataset.listenerAttached; // Reset if removing/re-adding
    }
  } else {
    /* Warn if button expected */
  }

  // --- Chat Interface vs. Prompt Visibility ---
  if (chatContainer) {
    chatContainer.classList.toggle('d-none', !canUseAI);
  } else {
    console.warn(`[UI] Chat container #${CHAT_INTERFACE_CONTAINER_ID} not found.`);
  }

  if (accessPrompt) {
    accessPrompt.classList.toggle('d-none', canUseAI);
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
    console.warn(`[UI] Access prompt #${TOOL_ACCESS_PROMPT_ID} not found.`);
  }

  // --- Enable/Disable Chat Inputs ---
  if (aiPromptInput) aiPromptInput.disabled = !canUseAI;
  if (aiGenerateButton) aiGenerateButton.disabled = !canUseAI;
}

// --- Add handler for 'Start Creating Now' button ---
document.addEventListener('DOMContentLoaded', function () {
  // Find the hero button by text or class
  const heroButtons = Array.from(document.querySelectorAll('a.btn, button.btn'));
  const startCreatingBtn = heroButtons.find(
    btn => btn.textContent && btn.textContent.trim().includes('Start Creating Now')
  );
  if (startCreatingBtn) {
    startCreatingBtn.addEventListener('click', function (e) {
      // Check login/credit status from global user info
      if (window.currentUserInfo && window.currentUserInfo.isLoggedIn && window.currentUserInfo.dbUserData && window.currentUserInfo.dbUserData.credits > 0) {
        // Prevent default anchor scroll
        e.preventDefault();
        // Show chat interface if hidden
        const chatContainer = document.getElementById('chat-interface-container');
        if (chatContainer && chatContainer.classList.contains('d-none')) {
          chatContainer.classList.remove('d-none');
        }
        // Click the fullscreen button if not already fullscreen
        const zoomBtn = document.getElementById('chat-zoom-toggle');
        if (zoomBtn && !document.body.classList.contains('chat-fullscreen-active')) {
          zoomBtn.click();
        }
        // Optionally focus the prompt input
        const promptInput = document.getElementById('ai-prompt-input');
        if (promptInput) promptInput.focus();
      }
      // Otherwise, let default behavior (scroll to pricing) occur
    });
  }
});