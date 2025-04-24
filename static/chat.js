// static/chat.js

console.log("[Chat] chat.js loaded");

const chatDisplay = document.getElementById('chat-message-list');
const chatContainer = document.getElementById('ai-result-output'); // Use the outer scrollable container

// Basic HTML Escaping Function
function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, """)
         .replace(/'/g, "'");
}

// Format a single message object into HTML
function formatChatMessage(message) {
    const content = (typeof message.content === 'string') ? message.content : '';
    // Escape basic HTML, but preserve markdown newlines for <br> conversion later
    // For full markdown rendering, the backend should return HTML
    const escapedContent = escapeHtml(content).replace(/\n/g, '<br>');

    const roleClass = message.role === 'user' ? 'user-message' : 'ai-message';
    const roleLabel = message.role === 'user' ? 'You' : 'AI';

    if (escapedContent.trim() === '' && message.role !== 'user') { // Allow empty user prompt but skip empty AI
         console.warn("[Chat Format] Skipping potentially empty AI message.");
         // return ''; // Let backend handle returning empty fragments if needed
    }

    // This structure assumes backend sends pre-rendered markdown HTML within .markdown-content
    // If backend sends plain text, adjust accordingly.
    return `
        <div class="chat-message ${roleClass} p-2 my-2">
            <strong>${roleLabel}:</strong>
            <div class="markdown-content p-0 m-0">${escapedContent}</div> {# Assuming backend sends pre-rendered markdown in 'content' #}
        </div>`;

    // --- If backend sends PLAIN TEXT and you want JS markdown conversion (requires a library like Marked.js) ---
    // Example using a hypothetical 'marked.parse()' function:
    // const renderedMarkdown = message.role === 'model' ? marked.parse(content) : `<p class="m-0">${escapedContent}</p>`;
    // return `
    //     <div class="chat-message ${roleClass} p-2 my-2">
    //         <strong>${roleLabel}:</strong><div class="markdown-content p-0 m-0">${renderedMarkdown}</div>
    //     </div>`;
    // --- End JS Markdown Example ---
}

// Scroll the chat container to the bottom
function scrollToBottom() {
    if (chatContainer) {
        // Small delay allows DOM to render updates before scrolling
        setTimeout(() => {
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
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading history...</p>'; // Loading indicator

    const token = window.currentAccessToken; // Use global token

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
            // Backend needs to send pre-formatted HTML or we render markdown here
            // Assuming backend sends necessary fields, formatChatMessage handles display
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
        // console.log("[Chat Init] Chat already initialized."); // Reduce noise
        return;
     }
     console.log("[Chat Init] Initializing chat interface.");

     // 1. Load initial history
     loadChatHistory();

     // 2. Setup HTMX event listeners (ensure messageList exists)
     const messageList = document.getElementById('chat-message-list');
     if (messageList) {
         // Listen for content being swapped into the list (beforeend)
         htmx.on(messageList, 'htmx:afterSwap', function(evt) {
             console.log("[Chat HTMX] afterSwap detected, scrolling down.");
             scrollToBottom();
             // Clear any OOB errors that might have been added separately
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = '';
         });

         // Listen for OOB swaps targeting the error div
         htmx.on(messageList, 'htmx:afterProcessNode', function(evt) {
             const errorTarget = document.getElementById('chat-error');
             if (evt.target === errorTarget && errorTarget.innerHTML !== '') {
                 console.log("[Chat HTMX] Error message swapped via OOB.");
             }
         });

     } else {
         console.error("[Chat Init] Cannot setup HTMX listeners: #chat-message-list not found.");
     }

     // Setup listeners on the form (ensure form exists)
     const genForm = document.getElementById('ai-generation-form');
     if (genForm) {
          // Clear separate error div before new request
         htmx.on(genForm, 'htmx:beforeRequest', function(evt) {
             console.log("[Chat HTMX] beforeRequest on form.");
             const errorDiv = document.getElementById('chat-error');
             if (errorDiv) errorDiv.innerHTML = ''; // Clear errors shown via OOB
             // Disable button manually as backup
             const generateButton = document.getElementById('ai-generate-button');
             if(generateButton) generateButton.disabled = true;

         });

          // Handle general response errors if needed
         htmx.on(genForm, 'htmx:responseError', function(evt) {
             console.error("[Chat HTMX] Response Error:", evt.detail.xhr.status, evt.detail.xhr.responseText);
             const errorDiv = document.getElementById('chat-error');
             // Avoid showing generic error if backend handled it with OOB swap already
             if (errorDiv && !errorDiv.innerHTML.includes('alert')) {
                  // Only show generic if specific error wasn't placed by OOB swap
                 errorDiv.innerHTML = `<div class="alert alert-danger alert-dismissible fade show my-2" role="alert">Request Error ${evt.detail.xhr.status}. Please try again.<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>`;
             }
             // Ensure button re-enabled on error
             const generateButton = document.getElementById('ai-generate-button');
             if(generateButton) generateButton.disabled = false;
         });

        // Reset form after successful request (now handled by hx-on in HTML)
        // htmx.on(genForm, 'htmx:afterRequest', function(evt) { // Keep for button re-enable
        //     const generateButton = document.getElementById('ai-generate-button');
        //     if(generateButton) generateButton.disabled = false;
        // });


     } else {
          console.error("[Chat Init] Cannot setup HTMX listeners: #ai-generation-form not found.");
     }


     window.chatInitialized = true; // Set flag after setup
     console.log("[Chat Init] Chat interface initialization complete.");
}

// Make initializeChat globally accessible for auth.js to call
window.initializeChat = initializeChat;

// --- Signal that chat functions are ready ---
document.dispatchEvent(new CustomEvent('chatScriptReady'));
console.log("[Chat] chat.js setup complete and ready event dispatched.");