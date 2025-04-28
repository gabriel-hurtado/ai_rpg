// ui.js - Auth & Credits UI helpers

console.log('[ui.js] loaded. window.AuthManager:', window.AuthManager);

/**
 * Show an authentication error prominently in the UI.
 */
export function showAuthError(message) {
    const toolAccessArea = document.getElementById('tool-access-area');
    if (toolAccessArea) {
        toolAccessArea.innerHTML = `<span class="text-danger">${message}</span>`;
    }
}

/**
 * Display the login state in the navbar.
 */
export function displayLoginState() {
    const authNavLink = document.getElementById('auth-nav-link');
    if (!authNavLink) return;
    authNavLink.innerHTML = `
        <a class="nav-link btn btn-sm btn-primary custom-btn" href="#" id="login-button-dynamic">Login / Sign Up</a>`;
    setTimeout(() => {
        const loginButton = document.getElementById('login-button-dynamic');
        if (loginButton && !loginButton.dataset.listenerAttached) {
            loginButton.dataset.listenerAttached = 'true';
            loginButton.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.AuthManager && window.AuthManager.authClient) {
                    window.AuthManager.authClient.redirectToLoginPage();
                } else {
                    console.error("[Auth Click] authClient not available for login redirect.");
                }
            });
        } else if (!loginButton) {
            console.error("[Auth UI] Could NOT find #login-button-dynamic!");
        }
    }, 50);
}

/**
 * Update the credits display in the navbar and dropdown.
 */
export function updateCreditsUI(credits) {
    const headerEl = document.getElementById('header-user-credits');
    const dropdownEl = document.getElementById('credits-display');
    if (headerEl) headerEl.textContent = credits;
    if (dropdownEl) dropdownEl.textContent = 'Credits: ' + credits;
}

/**
 * Update UI elements that depend on payment/credit state.
 * Shows/hides chat tool, disables form if needed, etc.
 */
export function updatePaymentDependentUI(isLoggedIn, hasValidCredit) {
    const purchaseButton = document.getElementById('purchase-button');
    const toolAccessArea = document.getElementById('tool-access-area');
    const aiForm = document.getElementById('ai-generation-form');
    const promptInput = document.getElementById('ai-prompt-input');
    const generateButton = document.getElementById('ai-generate-button');
    const loginPrompt = toolAccessArea ? toolAccessArea.querySelector('p.lead') : null;

    // --- Purchase Button ---
    if (purchaseButton) {
        purchaseButton.style.display = isLoggedIn && !hasValidCredit ? 'inline-block' : 'none';
    }

    // --- Tool Access Area ---
    if (toolAccessArea) {
        if (!isLoggedIn) {
            toolAccessArea.classList.add('tool-access-locked');
            if (loginPrompt) loginPrompt.style.display = 'block';
        } else {
            toolAccessArea.classList.remove('tool-access-locked');
            if (loginPrompt) loginPrompt.style.display = 'none';
        }
    }

    // --- AI Form ---
    const showTool = isLoggedIn && hasValidCredit;
    if (aiForm) {
        aiForm.style.display = showTool ? 'flex' : 'none';
        if (promptInput) promptInput.disabled = !showTool;
        if (generateButton) generateButton.disabled = !showTool;
        if (showTool && !window.chatInitialized) {
            if (typeof window.initializeChat === 'function') {
                window.initializeChat();
            }
        } else if (!showTool) {
            window.chatInitialized = false;
        }
    }
}
