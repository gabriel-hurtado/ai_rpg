// static/chat.js

console.log("[Chat] chat.js loaded");

const chatDisplay = document.getElementById('chat-message-list');
const chatContainer = document.getElementById('ai-result-output'); // Use the outer scrollable container

// Basic HTML Escaping Function
function escapeHtml(unsafe) {
    if (!unsafe) return ""; // Handle null/undefined input
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, """)
         .replace(/'/g, "'");
}

// Format a single message object into HTML
function formatChatMessage(message) {
    // Check if message content exists and is a string
    const content = (typeof message.content === 'string') ? message.content : '';
    const escapedContent = escapeHtml(content).replace(/\n/g, '<br>'); // Keep newlines

    // Use 'model' role consistent with Gemini API, but display 'AI'
    const roleClass = message.role === 'user' ? 'user-message' : 'ai-message';
    const roleLabel = message.role === 'user' ? 'You' : 'AI';

    // Only return content if it's not empty after potential escaping/trimming
    if (escapedContent.trim() === '' && message.role === 'model') {
         console.warn("[Chat Format] Skipping empty AI message.");
         return ''; // Don't render empty AI bubbles
    }
     if (escapedContent.trim() === '' && message.role === 'user') {
         console.warn("[Chat Format] Skipping empty User message.");
         return ''; // Don't render empty User bubbles
    }


    return `
        <div class="chat-message ${roleClass} p-2 my-2">
            <strong>${roleLabel}:</strong><p class="m-0">${escapedContent}</p>
        </div>`;
}

// Scroll the chat container to the bottom
function scrollToBottom() {
    if (chatContainer) {
        // console.log("[Chat Scroll] Scrolling to bottom.");
        chatContainer.scrollTop = chatContainer.scrollHeight;
    } else {
        console.warn("[Chat Scroll] Chat container not found for scrolling.");
    }
}

// Load chat history from the backend
async function loadChatHistory() {
    if (!chatDisplay) {
        console.error("[Chat History] Chat display element (#chat-message-list) not found.");
        return;
    }
    console.log("[Chat History] Loading chat history...");
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading history...</p>'; // Loading indicator

    // Use the globally stored access token from auth.js
    const token = window.currentAccessToken;

    if (!window.authClient || !token) {
         console.warn("[Chat History] Cannot load history: Auth client or token not ready.");
         chatDisplay.innerHTML = '<p class="text-danger small text-center initial-chat-prompt">Could not load history (Authentication error).</p>';
         return;
    }

    try {
        const response = await fetch('/api/v1/chat/history', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
            console.error(`[Chat History] Failed to fetch history: ${response.status}`);
            chatDisplay.innerHTML = `<p class="text-danger small text-center initial-chat-prompt">Error loading history (${response.status}).</p>`;
            return;
        }
        const data = await response.json();
        if (data.history && data.history.length > 0) {
            console.log(`[Chat History] Rendering ${data.history.length} messages.`);
            chatDisplay.innerHTML = data.history.map(formatChatMessage).join('');
        } else {
             console.log("[Chat History] No previous chat history found.");
             chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start generating content for your TTRPG!</p>';
        }
        // Add small delay before scrolling to allow rendering
        setTimeout(scrollToBottom, 150);

    } catch (e) {
         console.error("[Chat History] Error fetching or rendering history:", e);
         chatDisplay.innerHTML = '<p class="text-danger small text-center initial-chat-prompt">Error loading history.</p>';
    }
}

// --- Function called by auth.js when user is logged in with credit ---
function initializeChat() {
     if (window.chatInitialized) {
        console.log("[Chat Init] Chat already initialized.");
        return; // Prevent re-initialization
     }
     console.log("[Chat Init] Initializing chat interface.");

     // 1. Load initial history
     loadChatHistory();

     // 2. Setup HTMX event listeners for dynamic updates
     const messageList = document.getElementById('chat-message-list');
     if (messageList) {
         // Listen for content being swapped into the list (beforeend)
         htmx.on(messageList, 'htmx:afterSwap', function(evt) {
             console.log("[Chat HTMX] afterSwap detected on message list, scrolling down.");
             // The new fragment (user + ai message) is now part of the DOM
             scrollToBottom();
             // Clear any persistent errors shown outside the swap target
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = '';
         });

         // Listen specifically for OOB (Out-of-Band) swaps targeting error div
         htmx.on(messageList, 'htmx:afterProcessNode', function(evt) {
             // Check if an OOB swap targeted the error div
             const errorTarget = document.getElementById('chat-error');
             if (evt.target === errorTarget && errorTarget.innerHTML !== '') {
                 console.log("[Chat HTMX] Error message swapped via OOB.");
                 // Optionally scroll down even on error to make it visible
                 // scrollToBottom();
             }
         });

     } else {
         console.error("[Chat Init] Cannot setup HTMX listeners: #chat-message-list not found.");
     }

     const genForm = document.getElementById('ai-generation-form');
     if (genForm) {
          // Clear separate error div before new request
         htmx.on(genForm, 'htmx:beforeRequest', function(evt) {
             console.log("[Chat HTMX] beforeRequest on form.");
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = '';
         });

          // Handle general response errors if needed (backend might return error fragments now though)
         htmx.on(genForm, 'htmx:responseError', function(evt) {
             console.error("[Chat HTMX] Response Error:", evt.detail.xhr.status, evt.detail.xhr.responseText);
             const errorDiv = document.getElementById('chat-error');
             // Avoid showing error if backend handled it with OOB swap already
             if (errorDiv && !errorDiv.innerHTML.includes('alert')) {
                 errorDiv.innerHTML = `<div class="alert alert-danger alert-dismissible fade show my-2" role="alert">Request Error ${evt.detail.xhr.status}. Please try again.<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>`;
             }
         });

        // Reset form after successful request (handled by backend response + hx-swap)
        // Or could use hx-on::after-request="this.reset()" on the form tag in HTML
        htmx.on(genForm, 'htmx:afterRequest', function(evt) {
            if (evt.detail.successful) {
                console.log("[Chat HTMX] Successful request, resetting form.");
                evt.target.reset(); // 'evt.target' should be the form element
            }
            // Re-enable button (belt-and-suspenders for hx-disabled-elt)
            const generateButton = document.getElementById('ai-generate-button');
            if(generateButton) generateButton.disabled = false;
        });


     } else {
          console.error("[Chat Init] Cannot setup HTMX listeners: #ai-generation-form not found.");
     }


     window.chatInitialized = true; // Set flag
}

// Make initializeChat globally accessible for auth.js to call
window.initializeChat = initializeChat;

// --- Signal that chat functions are ready ---
document.dispatchEvent(new CustomEvent('chatScriptReady')); // Dispatch custom event
console.log("[Chat] chat.js setup complete and ready event dispatched.");