// static/auth.js - v17 - Fix token propagation for chat.js

console.log("[Auth Start] auth.js v17 loaded.");

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

// --- Handler for Auth State Changes ---
async function handleAuthStateChange(authState) {
    console.log("[Auth State Handler] Called. Auth State:", authState);
    window.chatInitialized = false;
    await updateUI();
    // --- Ensure chat reload after login ---
    if (typeof window.ChatManager !== 'undefined' && typeof window.ChatManager.initializeChat === 'function') {
        window.ChatManager.initializeChat();
    }
    console.log("[Auth State Handler] UI Updated after state change.");
}

if (!authUrl) {
    console.error("[Auth Init Error] PropelAuth URL not found. Auth disabled.");
    document.addEventListener('DOMContentLoaded', () => {
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
        authClient = PropelAuth.createClient({
            authUrl: authUrl,
            enableBackgroundTokenRefresh: true,
            onUserLoggedIn: (userContext) => {
                console.log("[Propel Callback] onUserLoggedIn triggered.");
                handleAuthStateChange(userContext);
            },
            onUserLoggedOut: () => {
                console.log("[Propel Callback] onUserLoggedOut triggered.");
                currentAccessToken = null; window.currentAccessToken = null;
                handleAuthStateChange(null);
            }
        });
        window.authClient = authClient;
        console.log("[Auth Init] PropelAuth Client Initialized with callbacks.");

        // --- DOM Elements ---
        const authNavLink = document.getElementById('auth-nav-link');

        // --- Helper: Fetch Combined User Info ---
        async function fetchCombinedUserInfo() {
            if (!authClient) { console.error("[Auth Fetch] Auth client not initialized."); return null; }
            try {
                const authInfo = await authClient.getAuthenticationInfoOrNull(false);
                if (authInfo && authInfo.accessToken && authInfo.user) {
                     currentAccessToken = authInfo.accessToken;
                     window.currentAccessToken = currentAccessToken;
                     // --- Patch: force global token update for chat.js ---
                     if (typeof window.getCurrentAccessToken === 'function') {
                         window.getCurrentAccessToken = function() { return currentAccessToken; };
                     }
                     try {
                         const backendResponse = await fetch('/api/v1/user/me', {
                             headers: { 'Authorization': `Bearer ${currentAccessToken}` }
                         });
                         if (!backendResponse.ok) {
                              console.error("[Auth Fetch] Failed to fetch backend user details:", backendResponse.status, await backendResponse.text());
                              return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                         }
                         const backendUserData = await backendResponse.json();
                         return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: backendUserData };
                     } catch (backendError) {
                          console.error("[Auth Fetch] Network or other error fetching backend user details:", backendError);
                          return { isLoggedIn: true, propelUserInfo: authInfo, dbUserData: null };
                     }
                } else {
                     currentAccessToken = null; window.currentAccessToken = null;
                     if (typeof window.getCurrentAccessToken === 'function') {
                         window.getCurrentAccessToken = function() { return null; };
                     }
                     return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
                }
            } catch (e) {
                console.error("[Auth Fetch] Error during fetchCombinedUserInfo:", e);
                currentAccessToken = null; window.currentAccessToken = null;
                if (typeof window.getCurrentAccessToken === 'function') {
                    window.getCurrentAccessToken = function() { return null; };
                }
                return { isLoggedIn: false, propelUserInfo: null, dbUserData: null };
            }
        }

        // --- Helper: Check Credit Validity ---
        function checkCreditValidity(dbUserData) {
            const credits = dbUserData?.credits ?? 0;
            return credits > 0;
        }

        // --- UI Update Function ---
        async function updateUI() {
            if (!authNavLink) { console.error("[Auth UI] Error: #auth-nav-link not found!"); return; }
            const combinedInfo = await fetchCombinedUserInfo();
            authNavLink.innerHTML = '';
            const isLoggedIn = combinedInfo?.isLoggedIn ?? false;
            const dbUserData = combinedInfo?.dbUserData ?? null;
            const hasValidCredit = checkCreditValidity(dbUserData);
            if (isLoggedIn && combinedInfo.propelUserInfo?.user) {
                const propelUser = combinedInfo.propelUserInfo.user;
                const userName = propelUser.email || propelUser.userId;
                const credits = dbUserData?.credits ?? 'N/A';
                authNavLink.innerHTML = `
                    <li class="nav-item dropdown">
                       <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                         <i class="bi bi-person-circle me-1"></i> ${userName}
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
                setTimeout(() => {
                    const logoutButton = document.getElementById('logout-button-dynamic');
                    if (logoutButton && !logoutButton.dataset.listenerAttached) {
                        logoutButton.dataset.listenerAttached = 'true';
                        logoutButton.addEventListener('click', (e) => {
                            e.preventDefault();
                            currentAccessToken = null; window.currentAccessToken = null;
                            console.log("[Auth Click] Logout initiated.");
                            if (authClient) authClient.logout(true);
                            else console.error("[Auth Click] authClient not ready for logout");
                        });
                    } else if (!logoutButton) { console.error("[Auth UI] Could NOT find #logout-button-dynamic!");}
                }, 50);
            } else {
                displayLoginState();
            }
            updatePaymentDependentUI(isLoggedIn, hasValidCredit);
        }

        // --- Helper: Display Login State ---
        function displayLoginState() {
            if (!authNavLink) return;
            authNavLink.innerHTML = `
                <a class="nav-link btn btn-sm btn-primary custom-btn" href="#" id="login-button-dynamic">Login / Sign Up</a>`;
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

        // --- Helper: Payment/Credit UI ---
        function updatePaymentDependentUI(isLoggedIn, hasValidCredit) {
            const purchaseButton = document.getElementById('purchase-button');
            const toolAccessArea = document.getElementById('tool-access-area');
            const aiForm = document.getElementById('ai-generation-form');
            const promptInput = document.getElementById('ai-prompt-input');
            const generateButton = document.getElementById('ai-generate-button');
            const loginPrompt = toolAccessArea ? toolAccessArea.querySelector('p.lead') : null;
            if (purchaseButton) {
                 const showPurchase = isLoggedIn && !hasValidCredit;
                 purchaseButton.style.display = showPurchase ? 'block' : 'none';
                 purchaseButton.disabled = !showPurchase;
                 if (showPurchase && purchaseButton.dataset.listenerAttached !== 'true') {
                     setupPurchaseButtonListener();
                 }
            }
            if (toolAccessArea) {
                const showTool = isLoggedIn && hasValidCredit;
                if (loginPrompt) {
                    loginPrompt.style.display = showTool ? 'none' : 'block';
                    if (!showTool) {
                        if (!isLoggedIn) {
                            loginPrompt.innerHTML = `Please <a href=\"#\" id=\"login-link-tool\">log in</a> or sign up to get started.`;
                            const loginLink = document.getElementById('login-link-tool');
                            if (loginLink) loginLink.onclick = (e) => { e.preventDefault(); if (authClient) authClient.redirectToLoginPage(); };
                        } else {
                            loginPrompt.innerHTML = `Purchase a Build Credit to access the AI tools.`;
                        }
                    }
                }
                if (aiForm) {
                    aiForm.style.display = showTool ? 'flex' : 'none';
                    if (promptInput) promptInput.disabled = !showTool;
                    if (generateButton) generateButton.disabled = !showTool;
                    if (showTool && !window.chatInitialized) {
                         console.log("[Auth UI] Tool access granted. Checking if chat initialization is needed.");
                         if (typeof window.initializeChat === 'function') {
                             console.log("[Auth UI] Calling window.initializeChat().");
                             window.initializeChat();
                         } else {
                             console.warn("[Auth UI] Tool access granted, but window.initializeChat() not found yet.");
                         }
                    } else if (!showTool) {
                         window.chatInitialized = false;
                    }
                 }
            }
        }

        // --- Setup Purchase Button Listener ---
        function setupPurchaseButtonListener() {
            const purchaseButton = document.getElementById('purchase-button');
            if (purchaseButton && purchaseButton.dataset.listenerAttached !== 'true') {
                purchaseButton.dataset.listenerAttached = 'true';
                purchaseButton.addEventListener('click', async () => {
                    console.log("[Purchase Click] Initiating payment...");
                    let token = window.currentAccessToken;
                    if (!token) {
                        console.warn("[Purchase Click] Token missing, attempting refresh...");
                        const authInfo = authClient ? await authClient.getAuthenticationInfoOrNull(true) : null;
                        token = authInfo?.accessToken;
                        window.currentAccessToken = token;
                        if (!token) {
                            console.error("[Purchase Click] Cannot purchase: Token unavailable after refresh.");
                            alert("Your session may have expired. Please refresh the page or log in again.");
                            updateUI();
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
                                window.location.href = data.checkout_url;
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
                    purchaseButton.disabled = false;
                    purchaseButton.innerHTML = '<i class="bi bi-wallet-fill me-2"></i> Unlock Builder Access';
                });
                console.log("[Auth Init] Purchase button listener attached.");
           }
        }

        // --- Initialization ---
        console.log("[Auth Init] Setting up initial UI.");
        document.addEventListener('DOMContentLoaded', () => {
            console.log('[Auth Init] DOM loaded. Running initial UI update.');
            updateUI();
            setupPurchaseButtonListener();
        });
        console.log("[Auth Init] Script finished setup.");
    } catch (initError) {
        console.error("[Auth Init] CRITICAL ERROR initializing PropelAuth Client:", initError);
        document.addEventListener('DOMContentLoaded', () => {
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