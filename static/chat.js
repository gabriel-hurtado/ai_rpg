// static/chat.js - v11 - Handles History, Scrolling (Newest at Bottom)

console.log("[Chat] chat.js loaded");

const chatDisplay = document.getElementById('chat-message-list');
const chatContainer = document.getElementById('ai-result-output'); // Use the outer scrollable container

// Basic HTML Escaping Function (Only for user messages if needed)
function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/\"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// Format a single message object into HTML
// ASSUMES Backend /chat/message returns pre-rendered HTML for AI 'content' via markdown
// ASSUMES Backend /chat/history returns 'content' that needs basic escaping for 'user' role
//         and pre-rendered HTML for 'model' role. Adjust if backend format differs.
function formatChatMessage(message) {
    const roleClass = message.role === 'user' ? 'user-message' : 'ai-message';
    const roleLabel = message.role === 'user' ? 'You' : 'AI';
    let formattedContent = "";

    if (typeof message.content === 'string') {
        if (message.role === 'user') {
            // Only escape user content
            formattedContent = `<p class="m-0">${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`;
        } else {
            // Assume AI content is safe HTML (e.g., rendered markdown from backend)
            // Wrap in a div for consistent styling if needed
             formattedContent = `<div class="markdown-content p-0 m-0">${message.content}</div>`;
        }
    } else {
         console.warn("[Chat Format] Message content is not a string:", message.content);
         formattedContent = '<p class="m-0 text-muted small">[Empty Message]</p>'; // Placeholder
    }


    if (formattedContent.trim() === '' && message.role !== 'user') {
         console.warn("[Chat Format] Skipping empty AI message rendering.");
         return ''; // Don't render empty AI bubbles visually
    }

    return `
        <div class="chat-message ${roleClass} p-2 my-2">
            <strong>${roleLabel}:</strong>
            ${formattedContent}
        </div>`;
}

// Scroll the chat container to the bottom
function scrollToBottom() {
    if (chatContainer) {
        setTimeout(() => { // Use timeout to ensure DOM has rendered new content
           chatContainer.scrollTop = chatContainer.scrollHeight;
           // console.log("[Chat Scroll] Scrolled to bottom.");
        }, 50);
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
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading history...</p>';

    const token = window.currentAccessToken; // Use global token set by auth.js

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
            // Render history - Assuming formatChatMessage handles potential HTML from backend AI messages
             chatDisplay.innerHTML = data.history.map(formatChatMessage).join('');
        } else {
             console.log("[Chat History] No previous chat history found.");
             chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start generating content for your TTRPG!</p>';
        }
        scrollToBottom(); // Scroll after loading initial history

    } catch (e) {
         console.error("[Chat History] Error fetching or rendering history:", e);
         chatDisplay.innerHTML = '<p class="text-danger small text-center initial-chat-prompt">Error loading history.</p>';
    }
}

// --- Function called by auth.js when user is logged in with credit ---
function initializeChat() {
     if (window.chatInitialized) {
        // console.log("[Chat Init] Chat already initialized.");
        return;
     }
     console.log("[Chat Init] Initializing chat interface.");

     // 1. Load initial history
     loadChatHistory();

     // 2. Setup HTMX event listeners
     const messageList = document.getElementById('chat-message-list');
     if (messageList) {
         htmx.on(messageList, 'htmx:afterSwap', function(evt) {
             console.log("[Chat HTMX] afterSwap detected, scrolling down.");
             scrollToBottom(); // Scroll after new content appended
             // Clear OOB errors
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = '';
         });

         htmx.on(messageList, 'htmx:afterProcessNode', function(evt) {
             const errorTarget = document.getElementById('chat-error');
             if (evt.target === errorTarget && errorTarget.innerHTML !== '') {
                 console.log("[Chat HTMX] Error message swapped via OOB.");
             }
         });

     } else {
         console.error("[Chat Init] Cannot setup HTMX listeners: #chat-message-list not found.");
     }

     const genForm = document.getElementById('ai-generation-form');
     if (genForm) {
         htmx.on(genForm, 'htmx:beforeRequest', function(evt) {
             console.log("[Chat HTMX] beforeRequest on form.");
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = '';
             const generateButton = document.getElementById('ai-generate-button');
             if(generateButton) generateButton.disabled = true; // Manually disable too
             const loadingIndicator = document.getElementById('ai-loading-indicator');
             if(loadingIndicator) loadingIndicator.style.display = 'inline-block'; // Show manually

         });

         htmx.on(genForm, 'htmx:responseError', function(evt) {
             console.error("[Chat HTMX] Response Error:", evt.detail.xhr.status, evt.detail.xhr.responseText);
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv && !errorDiv.innerHTML.includes('alert')) {
                 errorDiv.innerHTML = `<div class="alert alert-danger alert-dismissible fade show my-2" role="alert">Request Error ${evt.detail.xhr.status}. Please try again.<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>`;
             }
             // Re-enable button on error
             const generateButton = document.getElementById('ai-generate-button');
             if(generateButton) generateButton.disabled = false;
             const loadingIndicator = document.getElementById('ai-loading-indicator');
             if(loadingIndicator) loadingIndicator.style.display = 'none'; // Hide spinner
         });

         htmx.on(genForm, 'htmx:afterRequest', function(evt) {
             // Re-enable button and hide spinner regardless of success/fail
             // (hx-disabled-elt handles disabling during request)
             const generateButton = document.getElementById('ai-generate-button');
             if(generateButton) generateButton.disabled = false;
             const loadingIndicator = document.getElementById('ai-loading-indicator');
             if(loadingIndicator) loadingIndicator.style.display = 'none';
             // Resetting form is now handled by hx-on attribute in HTML
         });

     } else {
          console.error("[Chat Init] Cannot setup HTMX listeners: #ai-generation-form not found.");
     }

     window.chatInitialized = true;
     console.log("[Chat Init] Chat interface initialization complete.");
}

// Make initializeChat globally accessible for auth.js to call
window.initializeChat = initializeChat;

// --- STREAMING AI RESPONSE HANDLER ---
// Requires: <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script> in your HTML
async function streamAIResponse(formElement, chatDisplay) {
    // Get user input before sending
    const promptInput = formElement.querySelector('textarea[name="prompt"]');
    const userMessage = promptInput ? promptInput.value : '';

    if (userMessage.trim()) {
        // Format and append user message to chat
        const userDiv = document.createElement('div');
        userDiv.className = 'chat-message user-message p-2 my-2';
        userDiv.innerHTML = `<strong>You:</strong><p class="m-0">${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>`;
        chatDisplay.appendChild(userDiv);
        scrollToBottom();
    }

    // AI message bubble with spinner initially
    let aiMessageDiv = document.createElement('div');
    aiMessageDiv.className = 'chat-message ai-message p-2 my-2';
    aiMessageDiv.innerHTML = '<strong>AI:</strong><div class="markdown-content"><span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span></div>';
    let markdownContentDiv = aiMessageDiv.querySelector('.markdown-content');
    chatDisplay.appendChild(aiMessageDiv);
    scrollToBottom();

    const formData = new FormData(formElement);
    // Get the current access token from auth.js utility
    const accessToken = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    const fetchHeaders = { 'HX-Request': 'true' };
    if (accessToken) fetchHeaders['Authorization'] = `Bearer ${accessToken}`;
    const response = await fetch(formElement.action, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders
    });
    if (!response.body) {
        markdownContentDiv.innerHTML = '<span class="text-danger">Streaming not supported by server.</span>';
        return;
    }
    const reader = response.body.getReader();
    let decoder = new TextDecoder();
    let buffer = '';
    let firstChunk = true;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Try to split by newlines for chunked markdown (optional)
        let lines = buffer.split(/(?<=\n)/g);
        buffer = '';
        for (let line of lines) {
            if (line.trim() === '') continue;
            if (firstChunk) {
                // Remove spinner on first chunk
                markdownContentDiv.innerHTML = '';
                firstChunk = false;
            }
            // Always use marked.parse for markdown rendering
            markdownContentDiv.innerHTML += window.marked ? marked.parse(line) : line;
            scrollToBottom();
        }
    }
    // Remove spinner if still present
    if (firstChunk) markdownContentDiv.innerHTML = '<span class="text-danger">No AI response received.</span>';

    // Clear and blur the input after the fetch completes
    if (promptInput) {
        promptInput.value = '';
        promptInput.blur(); // Optionally remove focus for better UX
    }
}

// --- Patch form submit to use streaming ---
document.addEventListener('DOMContentLoaded', function() {
    const chatForm = document.getElementById('ai-generation-form');
    if (chatForm) {
        chatForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const chatDisplay = document.getElementById('chat-message-list');
            if (chatDisplay) {
                await streamAIResponse(chatForm, chatDisplay);
            }
        });
    }
});

// --- Signal that chat functions are ready ---
// Dispatch event AFTER all functions are defined and window.initializeChat is set
document.dispatchEvent(new CustomEvent('chatScriptReady'));
console.log("[Chat] chat.js setup complete and ready event dispatched.");