// static/auth.js - v14 - Use correct onUserLoggedIn/onUserLoggedOut callbacks

console.log("[Auth Start] auth.js v14 loaded.");

// --- Global Auth State ---
let authClient = null;
window.authClient = null;
let currentAccessToken = null;
window.currentAccessToken = null;
window.chatInitialized = false;

// Utility: Get current access token
window.getCurrentAccessToken = function() {
    return window.currentAccessToken || null;
};

// Get Auth URL from data attribute
const authUrl = document.body.dataset.authUrl;

// --- NEW: Handler function for Auth State Changes ---
// This function will be called by PropelAuth callbacks
async function handleAuthStateChange(authState) {
    console.log("[Auth State Handler] Called. Auth State:", authState);
    // Update token based on the provided state (if available)
    // Note: The authState object might vary slightly depending on the callback,
    // but fetching combined info is the most reliable way to get the current state.
    // We primarily use this handler to trigger a UI refresh.

    // Clear the chat flag whenever auth state might have changed
    window.chatInitialized = false;

    // Reliable way to update everything: Fetch combined info and update UI
    await updateUI();
    console.log("[Auth State Handler] UI Updated after state change.");
}
// --- End Handler Function ---


if (!authUrl) {
    console.error("[Auth Init Error] PropelAuth URL not found. Auth disabled.");
    // Disable interactive elements if auth fails early
    document.addEventListener('DOMContentLoaded', () => {
        // ... (keep the error handling UI disabling logic) ...
        const purchaseButton = document.getElementById('purchase-button');
        if (purchaseButton) purchaseButton.disabled = true;
        const promptInput = document.getElementById('ai-prompt-input');
        if(promptInput) promptInput.disabled = true;
        const generateButton = document.getElementById('ai-generate-button');
        if(generateButton) generateButton.disabled = true;
        const toolAccessArea = document.getElementById('tool-access-area');
        if (toolAccessArea) {
             const loginPrompt = toolAccessArea.querySelector('.lead');
             if (loginPrompt) loginPrompt.innerHTML = '<span class="text-danger">Authentication service unavailable.</span>';
        }
    });
} else {
    console.log("[Auth Start] Auth URL Found:", authUrl);
    try {
        // --- Initialize PropelAuth Client WITH Callbacks ---
        authClient = PropelAuth.createClient({
            authUrl: authUrl,
            enableBackgroundTokenRefresh: true,

            // Callbacks to handle auth state changes:
            onUserLoggedIn: (userContext) => {
                console.log("[Propel Callback] onUserLoggedIn triggered.");
                handleAuthStateChange(userContext); // Trigger our handler
            },
            onUserLoggedOut: () => {
                console.log("[Propel Callback] onUserLoggedOut triggered.");
                 currentAccessToken = null; // Explicitly clear token on logout
                 window.currentAccessToken = null;
                handleAuthStateChange(null); // Trigger our handler (with null state)
            },
            // Optional: Handle initial load if needed, often covered by DOMContentLoaded + updateUI
            // onUserLoaded: (userContext) => {
            //     console.log("[Propel Callback] onUserLoaded triggered.");
            //     // Initial load might already be handled by DOMContentLoaded updateUI,
            //     // but calling again ensures consistency if load happens later.
            //     handleAuthStateChange(userContext);
            // }
        });
        window.authClient = authClient;
        console.log("[Auth Init] PropelAuth Client Initialized with callbacks.");
        // --- End Initialization ---


        // --- DOM Elements ---
        const authNavLink = document.getElementById('auth-nav-link');

        // --- Helper Functions (fetchCombinedUserInfo, checkCreditValidity, displayLoginState) ---
        // Keep these functions exactly as they were in the previous version (v13)
        // ...
        // Fetch Combined User Info (Propel + Backend /user/me)
        async function fetchCombinedUserInfo() {
            // console.log("[Auth Fetch] Attempting to fetch combined user info...");
            if (!authClient) { console.error("[Auth Fetch] Auth client not initialized."); return null; }
            try {
                // Use getAuthenticationInfoOrNull - it now manages the state via callbacks
                const authInfo = await authClient.getAuthenticationInfoOrNull(false);

                if (authInfo && authInfo.accessToken && authInfo.user) {
                     currentAccessToken = authInfo.accessToken;
                     window.currentAccessToken = currentAccessToken;
                    //  console.log("[Auth Fetch] PropelAuth user info obtained:", authInfo.user.email);

                     try {
                        //  console.log("[Auth Fetch] Fetching backend /api/v1/user/me...");
                         const backendResponse = await fetch('/api/v1/user/me', {
                             headers: { 'Authorization': `Bearer ${currentAccessToken}` }
                         });

                         if (!backendResponse.ok) {
                              console.error("[Auth Fetch] Failed to fetch backend user details:", backendResponse.status, await backendResponse.text());
                              return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                         }
                         const backendUserData = await backendResponse.json();
                        //  console.log("[Auth Fetch] Backend user details obtained:", backendUserData);
                         return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: backendUserData };

                     } catch (backendError) {
                          console.error("[Auth Fetch] Network or other error fetching backend user details:", backendError);
                          return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                     }

                } else {
                    //  console.log("[Auth Fetch] User not logged in via PropelAuth.");
                     currentAccessToken = null; window.currentAccessToken = null;
                     return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
                }
            } catch (e) {
                console.error("[Auth Fetch] Error during fetchCombinedUserInfo:", e);
                currentAccessToken = null; window.currentAccessToken = null;
                return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
            }
        }

        // --- Simplified Credit Check Helper ---
        function checkCreditValidity(dbUserData) {
            const credits = dbUserData?.credits ?? 0;
            const hasValidCredit = credits > 0;
            // console.log(`[Auth Helper] Checking credit validity: Credits=${credits}. Result: ${hasValidCredit}`);
            return hasValidCredit;
        }
        // ...

        // --- UI Update Function ---
        // Keep this function exactly as it was in the previous version (v13)
        // (Including the inner displayLoginState call and the updatePaymentDependentUI call)
        // ...
        async function updateUI() {
            // console.log("[Auth UI] updateUI called.");
            if (!authNavLink) { console.error("[Auth UI] Error: #auth-nav-link not found!"); return; }

            const combinedInfo = await fetchCombinedUserInfo(); // Fetches user state and updates global token

            authNavLink.innerHTML = ''; // Clear previous state

            const isLoggedIn = combinedInfo?.isLoggedIn ?? false;
            const dbUserData = combinedInfo?.dbUserData ?? null;
            const hasValidCredit = checkCreditValidity(dbUserData); // Use simplified check

            if (isLoggedIn && combinedInfo.propelUserInfo?.user) {
                const propelUser = combinedInfo.propelUserInfo.user;
                const userName = propelUser.email || propelUser.userId; // Use email or ID
                const credits = dbUserData?.credits ?? 'N/A'; // Get credits or show N/A

                // Display user dropdown with simplified credit info
                 authNavLink.innerHTML = `
                    <li class="nav-item dropdown">
                       <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                         <i class="bi bi-person-circle me-1"></i> ${userName} <!-- No escapeHtml needed -->
                       </a>
                       <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end" aria-labelledby="navbarUserDropdown">
                         <li><span class="dropdown-item-text small text-muted" id="credits-display">Credits: ${credits}</span></li>
                         <li><a class="dropdown-item" href="${authUrl}/account" target="_blank">Account</a></li>
                         <li><hr class="dropdown-divider"></li>
                         <li><button class="dropdown-item" id="logout-button-dynamic" style="background:none; border:none; padding: 0.25rem 1rem; width:100%; text-align: start; color: var(--bs-dropdown-link-color);">Logout</button></li>
                       </ul>
                     </li>`;

                // Update header credits display as well
                const headerCredits = document.getElementById('header-user-credits');
                const dropdownCredits = document.getElementById('credits-display');
                if (headerCredits) headerCredits.textContent = credits;
                if (dropdownCredits) dropdownCredits.textContent = 'Credits: ' + credits;

                 // Add logout listener robustly
                 setTimeout(() => {
                     const logoutButton = document.getElementById('logout-button-dynamic');
                     if (logoutButton && !logoutButton.dataset.listenerAttached) {
                         logoutButton.dataset.listenerAttached = 'true';
                         logoutButton.addEventListener('click', (e) => {
                             e.preventDefault();
                             currentAccessToken = null; window.currentAccessToken = null; // Clear token
                             console.log("[Auth Click] Logout initiated.");
                             if (authClient) authClient.logout(true); // Redirect to logout endpoint
                             else console.error("[Auth Click] authClient not ready for logout");
                         });
                     } else if (!logoutButton) { console.error("[Auth UI] Could NOT find #logout-button-dynamic!");}
                 }, 50);

            } else {
                 currentAccessToken = null; window.currentAccessToken = null; // Ensure token cleared
                displayLoginState(); // Show the login button
            }

            // Update other UI elements based on login and credit status
            updatePaymentDependentUI(isLoggedIn, hasValidCredit);
        }

        function displayLoginState() {
             // console.log("[Auth UI] displayLoginState called.");
             if (!authNavLink) return;
             authNavLink.innerHTML = `
                 <a class="nav-link btn btn-sm btn-primary custom-btn" href="#" id="login-button-dynamic">Login / Sign Up</a>`;

             // Add listener robustly
             setTimeout(() => {
                 const loginButton = document.getElementById('login-button-dynamic');
                 if (loginButton && !loginButton.dataset.listenerAttached) {
                     loginButton.dataset.listenerAttached = 'true';
                     loginButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        console.log("[Auth Click] Login button clicked!");
                        if (authClient) authClient.redirectToLoginPage();
                        else console.error("[Auth Click] authClient not available for login redirect.");
                     });
                 } else if (!loginButton) { console.error("[Auth UI] Could NOT find #login-button-dynamic!"); }
             }, 50);
        }
        // ...

        // --- Update UI elements dependent on payment/credit status ---
        // Keep this function exactly as it was in the previous version (v13)
        // (Including the logic for purchase button, tool access, and triggering initializeChat)
        // ...
        function updatePaymentDependentUI(isLoggedIn, hasValidCredit) {
            // console.log(`[Auth UI] Updating payment dependent UI: LoggedIn=${isLoggedIn}, HasValidCredit=${hasValidCredit}`);
            const purchaseButton = document.getElementById('purchase-button');
            const toolAccessArea = document.getElementById('tool-access-area');
            const aiForm = document.getElementById('ai-generation-form');
            const promptInput = document.getElementById('ai-prompt-input');
            const generateButton = document.getElementById('ai-generate-button');
            const loginPrompt = toolAccessArea ? toolAccessArea.querySelector('p.lead') : null;

            // --- Purchase Button ---
            if (purchaseButton) {
                 const showPurchase = isLoggedIn && !hasValidCredit;
                 purchaseButton.style.display = showPurchase ? 'block' : 'none';
                 purchaseButton.disabled = !showPurchase; // Disable if not needed or not logged in
                 if (showPurchase && purchaseButton.dataset.listenerAttached !== 'true') {
                     setupPurchaseButtonListener(); // Attach listener only when needed
                 }
            }

            // --- Tool Access Area (Form, Prompt, Login Message) ---
            if (toolAccessArea) {
                const showTool = isLoggedIn && hasValidCredit;

                // Show/hide login/purchase prompt
                if (loginPrompt) {
                    loginPrompt.style.display = showTool ? 'none' : 'block';
                    if (!showTool) {
                        if (!isLoggedIn) {
                            loginPrompt.innerHTML = `Please <a href="#" id="login-link-tool">log in</a> or sign up to get started.`;
                            const loginLink = document.getElementById('login-link-tool');
                            if (loginLink) loginLink.onclick = (e) => { e.preventDefault(); if (authClient) authClient.redirectToLoginPage(); };
                        } else { // Logged in but no credit
                            loginPrompt.innerHTML = `Purchase a Build Credit to access the AI tools.`;
                        }
                    }
                }

                // Show/hide and enable/disable the chat form itself
                if (aiForm) {
                    aiForm.style.display = showTool ? 'flex' : 'none'; // Use flex for alignment
                    if (promptInput) promptInput.disabled = !showTool;
                    if (generateButton) generateButton.disabled = !showTool;

                    // --- Initialize Chat when tool becomes active ---
                    if (showTool && !window.chatInitialized) {
                         console.log("[Auth UI] Tool access granted. Checking if chat initialization is needed.");
                         if (typeof window.initializeChat === 'function') {
                             console.log("[Auth UI] Calling window.initializeChat().");
                             window.initializeChat();
                         } else {
                             console.warn("[Auth UI] Tool access granted, but window.initializeChat() not found yet.");
                         }
                    } else if (!showTool) {
                         window.chatInitialized = false; // Reset flag if tool gets hidden
                    }
                    // --- End Chat Init Trigger ---
                 }
            }
        }
        // ...


        // --- Setup Purchase Button Listener ---
        // Keep this function exactly as it was in the previous version (v13)
        // ...
         function setupPurchaseButtonListener() {
            const purchaseButton = document.getElementById('purchase-button');
            if (purchaseButton && purchaseButton.dataset.listenerAttached !== 'true') {
                purchaseButton.dataset.listenerAttached = 'true'; // Mark as attached
                purchaseButton.addEventListener('click', async () => {
                    console.log("[Purchase Click] Initiating payment...");
                    let token = window.currentAccessToken; // Use stored token

                    if (!token) {
                        console.warn("[Purchase Click] Token missing, attempting refresh...");
                        const authInfo = authClient ? await authClient.getAuthenticationInfoOrNull(true) : null; // Force refresh
                        token = authInfo?.accessToken;
                        window.currentAccessToken = token; // Update global store
                        if (!token) {
                            console.error("[Purchase Click] Cannot purchase: Token unavailable after refresh.");
                            alert("Your session may have expired. Please refresh the page or log in again.");
                            updateUI(); // Refresh UI to show login state
                            return;
                        }
                    }

                    purchaseButton.disabled = true;
                    purchaseButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Processing...';

                    try {
                        const response = await fetch('/api/v1/payment/create-checkout-session', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });

                        if (!response.ok) {
                            let errorMsg = `Error: ${response.status}`;
                            try { errorMsg = (await response.json()).detail || errorMsg; } catch(e){}
                            console.error("[Purchase Click] Checkout session creation failed:", errorMsg);
                            alert(`Could not initiate payment: ${errorMsg}`);
                        } else {
                            const data = await response.json();
                            if (data.checkout_url) {
                                console.log("[Purchase Click] Redirecting to Stripe:", data.checkout_url);
                                window.location.href = data.checkout_url; // Redirect user
                                return;
                            } else {
                                console.error("[Purchase Click] No checkout_url received from backend.");
                                alert("Payment setup error. Please try again later.");
                            }
                        }
                    } catch (error) {
                        console.error("[Purchase Click] Network error during checkout:", error);
                        alert("A network error occurred while trying to initiate payment. Please check your connection and try again.");
                    }

                    // Reset button only if redirection didn't happen
                    purchaseButton.disabled = false;
                    purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Unlock Builder Access';
                });
                console.log("[Auth Init] Purchase button listener attached.");
           }
        }
        // ...


        // --- Initialization ---
        console.log("[Auth Init] Setting up initial UI.");

        // Initial UI setup on DOM load
        document.addEventListener('DOMContentLoaded', () => {
            console.log('[Auth Init] DOM loaded. Running initial UI update.');
            updateUI(); // Fetch initial user state and update UI
            setupPurchaseButtonListener(); // Attach purchase listener if needed
        });

        // --- REMOVED the incorrect authClient.onAuthStateChange listener ---

        console.log("[Auth Init] Script finished setup.");

    } catch (initError) {
        console.error("[Auth Init] CRITICAL ERROR initializing PropelAuth Client:", initError);
        // Keep the error handling UI disabling logic
         document.addEventListener('DOMContentLoaded', () => {
            // ... (keep the error handling UI disabling logic) ...
             const authNavLink = document.getElementById('auth-nav-link');
             if (authNavLink) authNavLink.innerHTML = `<span class="nav-link text-danger small">Auth Error</span>`;
             const purchaseButton = document.getElementById('purchase-button');
             if (purchaseButton) { purchaseButton.style.display = 'none'; purchaseButton.disabled = true; }
             const toolAccessArea = document.getElementById('tool-access-area');
             if (toolAccessArea) {
                 const loginPrompt = toolAccessArea.querySelector('p.lead');
                 if(loginPrompt) loginPrompt.innerHTML = `<span class="text-danger">App initialization failed. Please refresh.</span>`;
                 const aiForm = document.getElementById('ai-generation-form');
                 if(aiForm) aiForm.style.display = 'none';
             }
         });
    }
} // End of 'if (authUrl)' block