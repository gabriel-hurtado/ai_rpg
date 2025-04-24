// static/auth.js - v11 - Expose token globally for HTMX

console.log("[Auth Start] auth.js loaded.");

// --- Global config variables - Will be fetched ---
let MAX_AI_INTERACTIONS = 100; // Default value
let CREDIT_DURATION_DAYS = 7;  // Default value
let configFetched = false;     // Flag to track if config loaded

// --- Global Auth State ---
let authClient = null; // Variable to hold the client instance
window.authClient = null; // Expose globally for HTMX helper
let currentAccessToken = null; // Store latest token
window.currentAccessToken = null; // Expose globally for HTMX helper

// Get Auth URL from data attribute on body tag
const authUrl = document.body.dataset.authUrl;


if (!authUrl) {
    console.error("[Auth Init Error] PropelAuth URL not found. Auth disabled.");
} else {
    console.log("[Auth Start] Auth URL Found:", authUrl);
    try {
        // Initialize using the global PropelAuth object's createClient function
        authClient = PropelAuth.createClient({
            authUrl: authUrl,
            enableBackgroundTokenRefresh: true,
        });
        window.authClient = authClient; // Assign to global scope
        console.log("[Auth Init] PropelAuth Client Initialized and assigned to window.authClient:", authClient);

        // --- DOM Elements ---
        const authNavLink = document.getElementById('auth-nav-link');

        // --- Helper Functions ---

        // Fetch Configuration Data
        async function fetchConfig() {
            if (configFetched) return true;
            console.log("[Auth Fetch] Fetching app configuration from /api/v1/config...");
            try {
                const response = await fetch('/api/v1/config');
                if (!response.ok) {
                     console.error(`[Auth Fetch] Failed to fetch config: ${response.status}`);
                     configFetched = false; return false;
                }
                const configData = await response.json();
                MAX_AI_INTERACTIONS = configData.max_ai_interactions || MAX_AI_INTERACTIONS;
                CREDIT_DURATION_DAYS = configData.credit_duration_days || CREDIT_DURATION_DAYS;
                configFetched = true;
                console.log(`[Auth Fetch] Config loaded: Max Interactions=${MAX_AI_INTERACTIONS}, Credit Days=${CREDIT_DURATION_DAYS}`);
                return true;
            } catch (e) {
                console.error("[Auth Fetch] Network or other error fetching config:", e);
                configFetched = false; return false;
            }
        }

        // Fetch Combined User Info (fetches Propel and Backend data)
        async function fetchCombinedUserInfo() {
             console.log("[Auth Fetch] Attempting to fetch auth info...");
             if (!authClient) { console.error("[Auth Fetch] Auth client not initialized."); return null; }
            try {
                const authInfo = await authClient.getAuthenticationInfoOrNull();

                if (authInfo && authInfo.user) {
                     console.log("[Auth Fetch] PropelAuth user info obtained:", authInfo.user.email);
                     // ---> Store/Update global token <---
                     currentAccessToken = authInfo.accessToken;
                     window.currentAccessToken = currentAccessToken;

                     if (!currentAccessToken) {
                         console.error("[Auth Fetch] No access token in authInfo despite user object existing.");
                         return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                     }

                     console.log("[Auth Fetch] Fetching backend /api/v1/user/me...");
                     const backendResponse = await fetch('/api/v1/user/me', { headers: { 'Authorization': `Bearer ${currentAccessToken}` }}); // Use stored token
                     if (!backendResponse.ok) {
                         console.error("[Auth Fetch] Failed to fetch backend user details", backendResponse.status);
                         return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                     }
                     const backendUserData = await backendResponse.json();
                     console.log("[Auth Fetch] Backend user details obtained:", backendUserData);
                     return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: backendUserData };
                } else {
                     console.log("[Auth Fetch] User not logged in.");
                     // ---> Clear global token <---
                     currentAccessToken = null;
                     window.currentAccessToken = null;
                     return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
                }
            } catch (e) {
                console.error("[Auth Fetch] Error during fetchCombinedUserInfo:", e);
                 // ---> Clear global token on error <---
                 currentAccessToken = null;
                 window.currentAccessToken = null;
                return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
            }
        }

        // --- Credit Check Helper (Uses Global Config Vars) ---
        function checkCreditValidity(credits, activationTimeStr, interactionsUsed) {
            console.log(`[Auth Helper] Checking credit validity: C=${credits}, Act=${activationTimeStr}, Used=${interactionsUsed}`);
            let hasValidCredit = false;
            if (credits > 0 && activationTimeStr && interactionsUsed < MAX_AI_INTERACTIONS) {
                 try {
                     const activationDate = new Date(activationTimeStr);
                     if (!isNaN(activationDate.getTime())) {
                         const expiryDate = new Date(activationDate);
                         expiryDate.setDate(expiryDate.getDate() + CREDIT_DURATION_DAYS);
                         const now = new Date();
                         if (now < expiryDate) { hasValidCredit = true; console.log("[Auth Helper] Credit check: Valid."); }
                         else { console.log("[Auth Helper] Credit check: Expired."); }
                     } else { console.error("[Auth Helper] Invalid activation date:", activationTimeStr); }
                 } catch(e) { console.error("[Auth Helper] Error parsing date:", activationTimeStr, e); }
            } else { console.log(`[Auth Helper] Credit check: Failed initial conditions (C:${credits}, A:${!!activationTimeStr}, U:${interactionsUsed}/${MAX_AI_INTERACTIONS})`); }
            console.log(`[Auth Helper] checkCreditValidity result: ${hasValidCredit}`);
            return hasValidCredit;
        }


        // --- UI Update Function ---
        async function updateUI() {
            console.log("[Auth UI] updateUI called.");
            if (!authNavLink) { console.error("[Auth UI] Error: #auth-nav-link not found!"); return; }

            const combinedInfo = await fetchCombinedUserInfo(); // This now updates window.currentAccessToken
            authNavLink.innerHTML = ''; // Clear previous

            const isLoggedIn = combinedInfo?.isLoggedIn ?? false;
            const dbUserData = combinedInfo?.dbUserData ?? null;
            const credits = dbUserData?.credits ?? 0;
            const activationTime = dbUserData?.credit_activation_time ?? null;
            const interactionsUsed = dbUserData?.ai_interactions_used ?? 0;
            const hasValidCredit = checkCreditValidity(credits, activationTime, interactionsUsed);

            if (isLoggedIn && combinedInfo.propelUserInfo) {
                const propelUser = combinedInfo.propelUserInfo.user;
                console.log("[Auth UI] User is logged in. Displaying user dropdown.");
                const userName = propelUser.email || propelUser.userId;
                const interactionsRemaining = hasValidCredit ? Math.max(0, MAX_AI_INTERACTIONS - interactionsUsed) : 0;

                // Display user dropdown - Ensure span#credits-display exists here
                 authNavLink.innerHTML = `
                    <li class="nav-item dropdown">
                       <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                         <i class="bi bi-person-circle me-1"></i> ${userName}
                       </a>
                       <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end" aria-labelledby="navbarUserDropdown">
                         <li><span class="dropdown-item-text small text-muted" id="credits-display">Credits: ${credits} (${interactionsRemaining} uses left)</span></li>
                         <li><a class="dropdown-item" href="#">Account (Soon)</a></li>
                         <li><hr class="dropdown-divider"></li>
                         <li><button class="dropdown-item" id="logout-button-dynamic" style="background:none; border:none; padding: 0.25rem 1rem; width:100%; text-align: start; color: var(--bs-dropdown-link-color);">Logout</button></li>
                       </ul>
                     </li>`;

                 // Add logout listener
                 setTimeout(() => {
                     const logoutButton = document.getElementById('logout-button-dynamic');
                     if (logoutButton && !logoutButton.dataset.listenerAttached) {
                         logoutButton.dataset.listenerAttached = 'true';
                         logoutButton.addEventListener('click', (e) => {
                             e.preventDefault();
                             // ---> Clear global token on logout click <---
                             currentAccessToken = null;
                             window.currentAccessToken = null;
                             console.log("[Auth Click] Logout button CLICKED! Cleared token.");
                             if (authClient) authClient.logout(true);
                             else console.error("[Auth Click] authClient not ready for logout");
                         });
                         console.log("[Auth UI] Event listener ADDED to logout button.");
                     } else if (!logoutButton) { console.error("[Auth UI] Could NOT find #logout-button-dynamic!");}
                 }, 50);

            } else {
                console.log("[Auth UI] No token/user info or fetch failed. Displaying login state.");
                 // ---> Ensure token cleared if displaying login state <---
                 currentAccessToken = null;
                 window.currentAccessToken = null;
                displayLoginState();
            }

            // Update payment/tool UI based on final calculated state
            updatePaymentDependentUI(isLoggedIn, hasValidCredit);
            console.log(`[Auth UI] Final UI state: LoggedIn=${isLoggedIn}, HasValidCredit=${hasValidCredit}`);
        }

        function displayLoginState() {
             console.log("[Auth UI] displayLoginState called.");
             if (!authNavLink) { console.error("[Auth UI] Cannot display login state, #auth-nav-link missing."); return; };
             authNavLink.innerHTML = `
                 <a class="nav-link btn btn-sm btn-primary custom-btn" href="#" id="login-button-dynamic">Login / Sign Up</a>`;

             setTimeout(() => {
                 const loginButton = document.getElementById('login-button-dynamic');
                 if (loginButton && !loginButton.dataset.listenerAttached) {
                     loginButton.dataset.listenerAttached = 'true';
                     loginButton.addEventListener('click', (e) => {
                        e.preventDefault(); console.log("[Auth Click] Login button CLICKED!");
                        try {
                             if (authClient) { console.log("[Auth Click] Calling redirectToLoginPage..."); authClient.redirectToLoginPage();}
                             else { console.error("[Auth Click] authClient not available."); }
                        } catch (err) { console.error("[Auth Click] Error calling redirectToLoginPage:", err); }
                     });
                     console.log("[Auth UI] Event listener ADDED to login button.");
                 } else if (!loginButton) { console.error("[Auth UI] Could NOT find #login-button-dynamic!"); }
             }, 100);
        }

        // --- UI Update for Payment Status (Controls form/button visibility/state) ---
        function updatePaymentDependentUI(isLoggedIn, hasValidCredit) {
            console.log(`[Auth UI] updatePaymentDependentUI called with IsLoggedIn: ${isLoggedIn}, HasValidCredit: ${hasValidCredit}`);
            const purchaseButton = document.getElementById('purchase-button');
            const toolAccessArea = document.getElementById('tool-access-area');
            const aiForm = document.getElementById('ai-generation-form');
            const promptInput = document.getElementById('ai-prompt-input');
            const generateButton = document.getElementById('ai-generate-button');

            // Update Purchase Button visibility
            if (purchaseButton) {
                 purchaseButton.style.display = (isLoggedIn && !hasValidCredit) ? 'block' : 'none';
                 purchaseButton.disabled = !isLoggedIn || hasValidCredit;
                 if (!purchaseButton.disabled && purchaseButton.dataset.listenerAttached !== 'true') {
                     setupPurchaseButtonListener();
                 } else if (purchaseButton.disabled) {
                      purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Unlock Builder Access';
                 }
                 console.log(`[Auth UI] Purchase button display set to ${(isLoggedIn && !hasValidCredit) ? 'block' : 'none'}`);
            } else { console.warn("[Auth UI] Purchase button (#purchase-button) not found.");}

            // Update Tool Access Area display
            if (toolAccessArea) {
                const loginPrompt = toolAccessArea.querySelector('.lead');
                const showTool = isLoggedIn && hasValidCredit;

                if (loginPrompt) {
                    loginPrompt.style.display = showTool ? 'none' : 'block';
                    if (!isLoggedIn) {
                        loginPrompt.innerHTML = `Please <a href="#" id="login-link-tool">log in</a> and purchase credit to unleash the AI.`;
                        const loginLinkTool = document.getElementById('login-link-tool');
                        if(loginLinkTool) loginLinkTool.onclick = (e) => { e.preventDefault(); if(authClient) authClient.redirectToLoginPage(); };
                    } else if (!hasValidCredit) {
                         loginPrompt.innerHTML = `Purchase a Build Credit to access the AI tools or renew expired credit.`;
                    }
                } else { console.warn("[Auth UI] Tool login prompt (.lead) not found.");}

                // Control form visibility and disabled state
                if (aiForm) {
                     aiForm.style.display = showTool ? 'block' : 'none';
                     if (promptInput) promptInput.disabled = !showTool;
                     if (generateButton) generateButton.disabled = !showTool;
                     console.log(`[Auth UI] AI Form display: ${showTool ? 'block' : 'none'}, Enabled: ${showTool}`);
                 } else { console.warn("[Auth UI] AI Form (#ai-generation-form) not found."); }

                 console.log(`[Auth UI] Tool access state updated.`);
            } else { console.warn("[Auth UI] Tool access area (#tool-access-area) not found.");}
        }

        // --- Setup Purchase Button Listener ---
         function setupPurchaseButtonListener() {
              const purchaseButton = document.getElementById('purchase-button');
              if (purchaseButton && !purchaseButton.dataset.listenerAttached) {
                  purchaseButton.dataset.listenerAttached = 'true';
                  purchaseButton.addEventListener('click', async () => {
                      console.log("Purchase button clicked - initiating payment...");
                      // Get token right before calling API using the GLOBAL variable now
                      const token = window.currentAccessToken; // Use the globally stored token

                      if (!token) {
                          console.error("Cannot purchase credit: Token unavailable. Please log in again.");
                          alert("Your session might have expired. Please log in again to purchase credit.");
                          // Optionally try to refresh UI or redirect
                          // updateUI();
                          return;
                      }

                      purchaseButton.disabled = true;
                      purchaseButton.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Processing...';
                      try {
                          const response = await fetch('/api/v1/create-checkout-session', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }});
                          if (!response.ok) {
                              const errorData = await response.json(); console.error("Checkout session error:", response.status, errorData);
                              alert(`Error initiating payment: ${errorData.detail || response.statusText}`);
                          } else {
                              const data = await response.json(); if(data.checkout_url) { window.location.href = data.checkout_url; return; }
                              else { console.error("Backend missing checkout_url"); alert("Could not get payment URL."); }
                          }
                      } catch (error) { console.error("Network error creating checkout session:", error); alert("Network error initiating payment."); }
                      // Reset button only if redirect didn't happen
                      const stillLoggedIn = !!(window.authClient && window.currentAccessToken); // Check global token
                      if (stillLoggedIn) { updateUI(); /* Refresh UI to check credit status again */ }
                      else { updateUI(); } // Refresh UI anyway if error occurred
                  });
                  console.log("[Auth Init] Purchase button event listener added.");
             }
         }

        // --- Initialization ---
        console.log("[Auth Init] Setting up initial UI listener and fetching config.");

        document.addEventListener('DOMContentLoaded', async () => {
            console.log('[Auth Init] DOM loaded. Fetching config...');
            await fetchConfig(); // Fetch config first
            console.log('[Auth Init] Config fetch attempt complete. Running initial UI update.');
            updateUI(); // Now run UI update which fetches user state
            setupPurchaseButtonListener(); // Setup listener after initial elements might be ready
        });

        console.log("[Auth Init] Script finished setup.");

    } catch (initError) {
        console.error("[Auth Init] CRITICAL ERROR initializing PropelAuth Client:", initError);
         document.addEventListener('DOMContentLoaded', () => {
             const authNavLink = document.getElementById('auth-nav-link');
             if (authNavLink) authNavLink.innerHTML = `<span class="nav-link text-danger">Auth Error</span>`;
             const purchaseButton = document.getElementById('purchase-button');
             if (purchaseButton) purchaseButton.disabled = true;
         });
    }
} // End of 'if (authUrl)' block