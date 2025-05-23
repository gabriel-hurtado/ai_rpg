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
const CHAT_CONTEXT_CONTROLS_ID = 'chat-context-controls'; // <-- New constant
// --- Use ChatManager's constants for zoom buttons if needed elsewhere ---
// const CHAT_ZOOM_TOGGLE_NORMAL_ID = 'chat-zoom-toggle-normal'; // Defined in chat.js
// const CHAT_ZOOM_TOGGLE_FULLSCREEN_ID = 'chat-zoom-toggle-fullscreen'; // Defined in chat.js

// This can go in a global script tag in base.html or a utils.js file

/**
 * Shows a Bootstrap confirmation modal and returns a Promise.
 * @param {string} message The message to display in the modal.
 * @param {string} [confirmButtonText='Confirm'] Text for the confirm button.
 * @param {string} [cancelButtonText='Cancel'] Text for the cancel button.
 * @param {string} [title='Confirm Action'] Title for the modal. HTML is allowed.
 * @param {'primary'|'danger'|'warning'|'info'|string} [confirmButtonType='danger'] Determines the style of the confirm button (e.g., 'danger' for custom-btn-danger).
 * @param {'secondary'|'outline-themed'|string} [cancelButtonType='outline-themed'] Determines the style of the cancel button.
 * @returns {Promise<boolean>} A Promise that resolves with true if confirmed, false if cancelled.
 */
export function showConfirmationModal(
  message,
  confirmButtonText = 'Confirm',
  cancelButtonText = 'Cancel',
  title = 'Confirm Action <i class="bi bi-exclamation-triangle-fill ms-2 text-warning"></i>',
  confirmButtonType = 'danger', // e.g., 'danger', 'primary'
  cancelButtonType = 'outline-themed' // e.g., 'outline-themed', 'secondary'
) {
  return new Promise((resolve) => {
      const modalElement = document.getElementById('confirmationModal');
      if (!modalElement) {
          console.error('Confirmation modal element #confirmationModal not found!');
          // Fallback to ugly, blocking browser confirm if modal HTML is missing
          resolve(window.confirm(message));
          return;
      }

      const modalTitleElement = modalElement.querySelector('#confirmationModalLabel');
      const modalMessageElement = modalElement.querySelector('#confirmationModalMessage');
      const confirmButton = modalElement.querySelector('#confirmationModalConfirm');
      const cancelButton = modalElement.querySelector('#confirmationModalCancel');

      if (!modalTitleElement || !modalMessageElement || !confirmButton || !cancelButton) {
          console.error('One or more #confirmationModal sub-elements not found! Check IDs: confirmationModalLabel, confirmationModalMessage, confirmationModalConfirm, confirmationModalCancel.');
          resolve(window.confirm(message)); // Fallback
          return;
      }

      // Ensure Bootstrap's Modal class is available
      if (typeof bootstrap === 'undefined' || typeof bootstrap.Modal === 'undefined') {
          console.error('Bootstrap Modal class not found. Make sure Bootstrap JS is loaded before this script or that bootstrap is globally available.');
          resolve(window.confirm(message)); // Fallback
          return;
      }

      // Set content
      modalTitleElement.innerHTML = title; // Use innerHTML to allow icons/HTML in title
      modalMessageElement.textContent = message;
      confirmButton.textContent = confirmButtonText;
      cancelButton.textContent = cancelButtonText;


      if (cancelButtonText && cancelButtonText.trim() !== '') {
        cancelButton.textContent = cancelButtonText;
        cancelButton.style.display = ''; // Ensure it's visible
        modalElement.querySelector('.modal-footer').style.justifyContent = 'space-between';
    } else {
        cancelButton.textContent = '';
        cancelButton.style.display = 'none'; // Hide the cancel button
        modalElement.querySelector('.modal-footer').style.justifyContent = 'flex-end';
    }

      // --- Apply CSS Classes for Buttons ---
      let confirmClasses = 'btn custom-btn'; // Base classes
      if (confirmButtonType === 'danger') {
          confirmClasses += ' custom-btn-danger';
      } else if (confirmButtonType === 'primary') {
          confirmClasses += ' custom-btn-primary';
      } else if (confirmButtonType) {
          // For other standard bootstrap types if you ever use them e.g. 'info', 'warning'
          // Ensure you have .custom-btn-info or .custom-btn-warning CSS if you want them themed
          // or let Bootstrap's btn-info / btn-warning apply if no custom variant.
          confirmClasses += ` btn-${confirmButtonType}`; // Standard Bootstrap if no custom variant matches
      }
      confirmButton.className = confirmClasses;

      // --- CORRECTED CANCEL BUTTON CLASS LOGIC ---
      if (cancelButton.style.display !== 'none') { // Only build and apply class if it's visible
          let currentCancelClasses = 'btn custom-btn'; // Start with base classes for the cancel button

          if (cancelButtonType === 'outline-themed') {
              currentCancelClasses += ' custom-btn-outline-themed';
          } else if (cancelButtonType === 'secondary') {
              currentCancelClasses += ' custom-btn-secondary';
          } else if (cancelButtonType) { // For other standard bootstrap types
              currentCancelClasses += ` btn-${cancelButtonType}`;
          }
          cancelButton.className = currentCancelClasses; // Apply the fully constructed class string
      }
      // --- END CORRECTED CANCEL BUTTON CLASS LOGIC ---

      // Get or create a Bootstrap modal instance
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement);

      let hasBeenResolved = false; // Flag to prevent multiple resolves

      // Define handlers
      const onConfirm = () => {
          if (hasBeenResolved) return;
          hasBeenResolved = true;
          cleanupListeners();
          bsModal.hide(); // Hiding will trigger 'hidden.bs.modal'
          resolve(true);
      };

      const onCancel = () => {
          if (hasBeenResolved) return;
          hasBeenResolved = true;
          cleanupListeners();
          bsModal.hide(); // Hiding will trigger 'hidden.bs.modal'
          resolve(false);
      };

      // This handler for hidden.bs.modal ensures that if the modal is dismissed
      // by ESC key (if keyboard=true) or backdrop click (if backdrop is not static),
      // it's treated as a cancel.
      const onModalHidden = () => {
          if (!hasBeenResolved) { // If not already resolved by button click
              hasBeenResolved = true;
              resolve(false); // Treat as cancel
          }
          // Listeners are cleaned up by onConfirm/onCancel, or here if they haven't fired
          cleanupListeners();
      };

      // Function to remove event listeners
      const cleanupListeners = () => {
          confirmButton.removeEventListener('click', onConfirm);
          cancelButton.removeEventListener('click', onCancel);
          modalElement.removeEventListener('hidden.bs.modal', onModalHidden);
      };

      // --- Attach Event Listeners ---
      // It's crucial to remove old listeners if this function can be called multiple times
      // for the same modal. However, since we define handlers inside this scope,
      // they are unique each time. The main concern is multiple 'hidden.bs.modal' listeners.
      // So, we call cleanupListeners first to be absolutely sure.
      cleanupListeners(); // Clean up any stray listeners from a previous, ungraceful close

      confirmButton.addEventListener('click', onConfirm);
      cancelButton.addEventListener('click', onCancel);

      // data-bs-dismiss="modal" on the static cancel button will also trigger hide and then 'hidden.bs.modal'.
      // This event listener handles cases where the modal is dismissed NOT by the explicit cancel button,
      // e.g. if you were to change data-bs-keyboard to true or backdrop to non-static.
      modalElement.addEventListener('hidden.bs.modal', onModalHidden, { once: true });


      // Show the modal
      if (!bsModal._isShown) {
          bsModal.show();
      }
  });
}


/**
 * Update Navbar: Toggle visibility of login button vs user dropdown
 * and update dynamic text content.
 * @param {boolean} isLoggedIn - Current login status.
 * @param {object|null} propelUser - User info from PropelAuth.
 * @param {object|null} dbUser - User info from backend API.
 * @param {string|null} authUrl - The base URL for PropelAuth pages.
 */
export function updateNavbarUI(isLoggedIn, propelUser, dbUser, authUrl) {
  // console.log('[UI] Updating Navbar UI. isLoggedIn:', isLoggedIn); // Verbose
  const loginItem = document.getElementById(AUTH_NAV_LOGIN_ITEM_ID);
  const userItem = document.getElementById(AUTH_NAV_USER_ITEM_ID);

  if (!loginItem || !userItem) {
    console.error(`[UI] Navbar auth items not found!`);
    return;
  }

  loginItem.classList.toggle('d-none', isLoggedIn);
  userItem.classList.toggle('d-none', !isLoggedIn);

  if (isLoggedIn && !userItem.classList.contains('d-none') && propelUser) {
    const userDisplaySpan = document.getElementById(NAVBAR_USER_DISPLAY_ID);
    const userCreditsSpan = document.getElementById(NAVBAR_USER_CREDITS_ID);
    const accountLink = document.getElementById(NAVBAR_ACCOUNT_LINK_ID);

    if (userDisplaySpan) userDisplaySpan.textContent = propelUser.email || propelUser.userId || 'User';
    if (userCreditsSpan) userCreditsSpan.textContent = `Credits: ${dbUser?.credits ?? '--'}`;
    if (accountLink) {
      if (authUrl) {
        accountLink.href = `${authUrl}/account`;
        accountLink.target = '_blank';
        accountLink.style.pointerEvents = '';
        accountLink.style.opacity = '';
      } else {
        accountLink.href = '#';
        accountLink.target = '';
        accountLink.style.pointerEvents = 'none';
        accountLink.style.opacity = '0.5';
      }
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
  // console.log('[UI] Updating Tool Access UI. isLoggedIn:', isLoggedIn, 'hasCredit:', hasCredit); // Verbose
  const purchaseButton = document.getElementById(PURCHASE_BUTTON_ID);
  const aiPromptInput = document.getElementById(AI_PROMPT_INPUT_ID);
  const aiGenerateButton = document.getElementById(AI_GENERATE_BUTTON_ID);
  const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
  const chatContainer = document.getElementById(CHAT_INTERFACE_CONTAINER_ID);
  const chatContextControls = document.getElementById(CHAT_CONTEXT_CONTROLS_ID); // <-- Get the element

  const canUseAI = isLoggedIn && hasCredit;

  // --- Purchase Button Logic ---
  if (purchaseButton) {
    const showPurchaseButton = true; // Always show for now

    purchaseButton.classList.toggle('d-none', !showPurchaseButton);
    purchaseButton.disabled = !showPurchaseButton; // Should likely check if user *already* has credits here?

    // --- Attach Listener (ONLY ONCE) ---
    if (showPurchaseButton && purchaseButton.dataset.listenerAttached !== 'true') {
      // console.log('[UI] Attaching purchase button click listener'); // Verbose
      purchaseButton.dataset.listenerAttached = 'true';
      purchaseButton.addEventListener('click', async () => {
        // console.log('[Purchase Button Click] Initiated.'); // Verbose
        if (purchaseButton.disabled) return;
        if (!window.currentUserInfo || !window.currentUserInfo.isLoggedIn) {
          console.log('[Purchase Button Click] User not logged in...');
          if (window.authClient?.redirectToLoginPage) { window.authClient.redirectToLoginPage(); }
          else {
            const loginLink = document.querySelector('[data-action="login"]');
            if (loginLink) { loginLink.click(); } else { alert('Please login or sign up.'); }
          }
          return;
        }

        purchaseButton.disabled = true;
        purchaseButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Processing...';
        let token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

        if (!token && window.authClient) {
          console.warn("[Purchase Click] Token missing, attempting refresh...");
          try {
            const authInfo = await window.authClient.getAuthenticationInfoOrNull(true);
            token = authInfo?.accessToken;
            // if (token) console.log("[Purchase Click] Token refreshed."); // Verbose
          } catch (refreshError) { console.error("[Purchase Click] Error refreshing token:", refreshError); token = null; }
        }
        if (!token) {
          console.error("[Purchase Click] Token unavailable.");
          alert("Session invalid. Please refresh or log in again.");
          purchaseButton.disabled = false;
          purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Buy credits';
          return;
        }
        try {
          const response = await fetch('/api/v1/payment/create-checkout-session', {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!response.ok) {
            let errorMsg = `Error: ${response.status}`;
            try { errorMsg = (await response.json()).detail || errorMsg; } catch (e) {}
            console.error("[Purchase Click] Checkout session creation failed:", errorMsg);
            alert(`Could not initiate payment: ${errorMsg}`);
          } else {
            const data = await response.json();
            if (data.checkout_url) {
              // console.log("[Purchase Click] Redirecting to Stripe:", data.checkout_url); // Verbose
              window.location.href = data.checkout_url;
              return; // Stop processing
            } else {
              console.error("[Purchase Click] No checkout_url received.");
              alert("Payment setup error. Please try again later.");
            }
          }
        } catch (error) {
          console.error("[Purchase Click] Network error:", error);
          alert("A network error occurred.");
        }
        // console.log("[Purchase Click] Resetting button state."); // Verbose
        purchaseButton.disabled = false;
        purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Buy credits';
      });
    }
    // Optional cleanup part removed for simplicity
  } else {
    console.warn(`[UI] Purchase button #${PURCHASE_BUTTON_ID} not found.`);
  }

  // --- Chat Interface vs. Prompt Visibility ---
  if (chatContainer) {
    chatContainer.classList.toggle('d-none', !canUseAI);
  } else {
    console.warn(`[UI] Chat container #${CHAT_INTERFACE_CONTAINER_ID} not found.`);
  }

  // --- ADDED: Hide/Show Context Controls ---
  if (chatContextControls) {
    if (!canUseAI) {
      console.log(`[UI] Hiding chat context controls.`);
      chatContextControls.style.display = 'none';
    }
    else {
      console.log(`[UI] Showing chat context controls.`);
      chatContextControls.style.display = 'flex';
    }
     } else {
    // It's okay if this isn't found initially, chat.js manages it later when loading a convo
    // console.warn(`[UI] Chat context controls #${CHAT_CONTEXT_CONTROLS_ID} not found during UI update.`);
  }
  // --- End Added ---


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


// --- Event Listener Setup on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', function () {
    console.log('[UI] DOMContentLoaded - Setting up UI listeners.');

    // --- REMOVED: Zoom Button Listener Setup (Handled by chat.js) ---


    // --- Setup handler for 'Start Creating Now' button ---
    const startCreatingBtn = document.querySelector('#hero a.btn.custom-btn-warning'); // Adjust selector if needed

    if (startCreatingBtn && startCreatingBtn.textContent.includes('Start Creating Now')) {
        console.log('[UI] Found "Start Creating Now" button, adding listener.');
        startCreatingBtn.addEventListener('click', function (e) {
            console.log('[UI] "Start Creating Now" button clicked.');
            if (window.currentUserInfo && window.currentUserInfo.isLoggedIn && window.currentUserInfo.dbUserData && window.currentUserInfo.dbUserData.credits > 0) {
                console.log('[UI] User logged in with credits. Activating chat.');
                e.preventDefault(); // Prevent scroll

                // Show chat interface
                const chatContainer = document.getElementById(CHAT_INTERFACE_CONTAINER_ID);
                if (chatContainer) chatContainer.classList.remove('d-none');
                const accessPrompt = document.getElementById(TOOL_ACCESS_PROMPT_ID);
                if (accessPrompt) accessPrompt.classList.add('d-none');

                // --- Click the NORMAL button using its ID ---
                // This ID needs to match the constant defined in chat.js
                const CHAT_ZOOM_TOGGLE_NORMAL_ID_IN_UI = 'chat-zoom-toggle-normal'; // Explicitly define here
                const normalZoomBtnForClick = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID_IN_UI);

                if (normalZoomBtnForClick && !document.body.classList.contains('chat-fullscreen-active')) {
                    console.log('[UI] Clicking normal zoom button to enter fullscreen.');
                    // This click will trigger the handler set up in chat.js
                    normalZoomBtnForClick.click();
                } else if (document.body.classList.contains('chat-fullscreen-active')) {
                     console.log('[UI] Already in fullscreen mode.');
                } else {
                     console.warn('[UI] Normal zoom button not found for click simulation.');
                }

                // Focus input after potential transition
                setTimeout(() => {
                    const promptInput = document.getElementById(AI_PROMPT_INPUT_ID);
                    if (promptInput && !promptInput.disabled) {
                        console.log('[UI] Focusing prompt input.');
                        promptInput.focus();
                    }
                }, 100);

            } else {
                 console.log('[UI] User not logged in or no credits. Allowing default button behavior.');
            }
        });
    } else {
        console.log('[UI] "Start Creating Now" button not found.');
    }

}); // End DOMContentLoaded