// static/auth.js

// Get the Auth URL passed from the backend (or hardcode if needed, but less ideal)
// This assumes your root template context includes 'propelauth_url'
// We need a way to access this value. A common way is to put it in a data attribute
// or a global JS variable set by the template. Let's use a data attribute on the body.

// Modify templates/base.html body tag: <body class="dark-theme" data-auth-url="{{ propelauth_url | default('', true) }}">
const authUrl = document.body.dataset.authUrl;

if (!authUrl) {
    console.error("PropelAuth URL not found in page data. Auth features disabled.");
} else {
    console.log("Initializing PropelAuth with URL:", authUrl);
    const propelauth = new PropelAuth.AuthClient({ authUrl });

    // --- DOM Elements ---
    const authNavLink = document.getElementById('auth-nav-link'); // The <li> containing the auth link/dropdown
    // Note: We dynamically create buttons/dropdowns inside the #auth-nav-link li

    // --- Helper Functions ---
    function getAccessToken() {
        try {
            return propelauth.getAccessToken();
        } catch (e) {
            console.warn("Could not get access token:", e);
            return null;
        }
    }

    async function fetchUserInfo() {
        const token = getAccessToken();
        if (!token) return null;

        try {
            const response = await fetch('/api/v1/user/me', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) {
                console.error("Failed to fetch user info:", response.status, await response.text());
                // Handle token expiry - maybe force logout?
                if (response.status === 401) { // Unauthorized
                     console.log("Unauthorized fetching user info, likely expired token. Logging out.");
                     propelauth.logout(true); // Redirect to logout
                }
                return null;
            }
            return await response.json();
        } catch (e) {
            console.error("Error fetching user info:", e);
            return null;
        }
    }

    // --- UI Update Function ---
    async function updateUI() {
        if (!authNavLink) return; // Element not found

        const token = getAccessToken();
        let userInfo = null;

        authNavLink.innerHTML = ''; // Clear previous content

        if (token) {
            userInfo = await fetchUserInfo(); // Fetch info from our backend

            if (userInfo) {
                // User is logged in AND info fetched successfully
                const userName = userInfo.email || userInfo.propel_user_id; // Display email or ID
                authNavLink.innerHTML = `
                    <li class="nav-item dropdown">
                       <a class="nav-link dropdown-toggle" href="#" id="navbarUserDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                         <i class="bi bi-person-circle me-1"></i> ${userName}
                       </a>
                       <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end" aria-labelledby="navbarUserDropdown">
                         <li><a class="dropdown-item" href="#">Account (Soon)</a></li>
                         <li><hr class="dropdown-divider"></li>
                         <li><button class="dropdown-item" id="logout-button-dynamic">Logout</button></li>
                       </ul>
                     </li>`;

                // Add listener for the dynamically created logout button
                const logoutButton = document.getElementById('logout-button-dynamic');
                if (logoutButton) {
                    logoutButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        console.log("Logging out...");
                        propelauth.logout(true); // true = redirect to logout page hosted by PropelAuth
                    });
                }
                // TODO: Update other parts of the page based on userInfo.has_paid
                updatePaymentDependentUI(userInfo.has_paid);

            } else {
                // Token exists but backend fetch failed (maybe token expired during load?)
                // Show login state, attempt clean logout if needed
                console.warn("Token exists, but user info fetch failed. Displaying login state.");
                displayLoginState();
            }

        } else {
            // User is logged out
            displayLoginState();
            updatePaymentDependentUI(false); // Treat as not paid if logged out
        }
    }

    function displayLoginState() {
         authNavLink.innerHTML = `
             <a class="nav-link btn btn-sm custom-btn btn-primary-outline" href="#" id="login-button-dynamic">Login / Sign Up</a>`; // Changed style slightly

         const loginButton = document.getElementById('login-button-dynamic');
         if (loginButton) {
             loginButton.addEventListener('click', (e) => {
                e.preventDefault();
                console.log("Redirecting to login...");
                propelauth.redirectToLoginPage();
             });
         }
         // Note: Signup redirection is often handled on PropelAuth's hosted page
    }


    // --- UI Update for Payment Status ---
    function updatePaymentDependentUI(hasPaid) {
        const purchaseButton = document.getElementById('purchase-button');
        const toolAccessArea = document.getElementById('tool-access-area'); // Assuming you have this ID

        if (purchaseButton) {
             purchaseButton.style.display = hasPaid ? 'none' : 'block';
             purchaseButton.disabled = hasPaid;
        }

        if (toolAccessArea) {
            const loginPrompt = toolAccessArea.querySelector('.lead'); // The "Please log in..." text
            const toolPlaceholder = toolAccessArea.querySelector('.tool-placeholder'); // The actual tool area

            if (getAccessToken()) { // Only modify if user is logged in
                if (loginPrompt) loginPrompt.style.display = hasPaid ? 'none' : 'block';
                if (toolPlaceholder) {
                    // Here you would enable/disable or show/hide the actual tool inputs
                    toolPlaceholder.style.opacity = hasPaid ? 1 : 0.5;
                    // Example: Disable inputs if not paid (add specific selectors later)
                    // toolPlaceholder.querySelectorAll('textarea, button').forEach(el => el.disabled = !hasPaid);
                    if (!hasPaid && loginPrompt) {
                         loginPrompt.innerHTML = `Please purchase a Build Credit to access the AI tools.`;
                    }
                }
            } else {
                // Logged out state
                 if (loginPrompt) {
                     loginPrompt.style.display = 'block';
                     loginPrompt.innerHTML = `Please <a href="#" id="login-link-tool">log in</a> and purchase credit to unleash the AI.`;
                     // Add listener for this specific login link if needed
                     const loginLinkTool = document.getElementById('login-link-tool');
                     if(loginLinkTool) loginLinkTool.onclick = (e) => { e.preventDefault(); propelauth.redirectToLoginPage(); };
                 }
                 if (toolPlaceholder) toolPlaceholder.style.opacity = 0.5;
            }
        }
    }


    // --- Initialization and Event Handling ---

    // Initial UI update on page load
    updateUI();

    // Handle redirect from login/signup (this runs automatically if user lands back from PropelAuth)
    propelauth.handleRedirectCallback()
        .then(() => {
            console.log("Redirect callback handled.");
            updateUI(); // Refresh UI after login/signup redirect
        })
        .catch((error) => {
            console.error("Redirect callback error:", error);
            updateUI(); // Still update UI even on callback error
        });
} // End of 'if (authUrl)' block