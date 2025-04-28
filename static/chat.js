// static/chat.js - v12 - Handles Conversation ID, Loads Latest Conversation

console.log("[Chat] chat.js v12 loaded");

// --- Global State ---
let currentConversationId = null; // Track the active conversation

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

// Auto-resize textarea to fit content
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto'; // Reset height first
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 46), 300); // Use scrollHeight, respect CSS min/max
    textarea.style.height = newHeight + 'px';

    // --- Adjustments for Fullscreen ---
    const form = document.getElementById('ai-generation-form');
    const chatList = document.getElementById('chat-message-list');
    const isFullscreen = document.body.classList.contains('chat-fullscreen-active');

    if (isFullscreen && form && chatList) {
        const formHeight = newHeight + 35; // Approx padding
        form.style.height = formHeight + 'px';
        const basePadding = 80;
        const extraPadding = Math.max(0, newHeight - 46);
        const totalPadding = basePadding + extraPadding;
        chatList.style.paddingBottom = totalPadding + 'px';
    }
    // --- End Fullscreen Adjustments ---
}

// Scroll chat container to the bottom
function scrollToBottom(containerId = 'ai-result-output') {
    const container = document.getElementById(containerId);
    if (container) {
        // Use setTimeout to ensure DOM updates are rendered before scrolling
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
            // console.log(`[Scroll] Scrolled ${containerId} to bottom: ${container.scrollHeight}`);
        }, 50); // Small delay might be needed
         // Maybe a second attempt
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
        }, 200);
    } else {
        console.warn(`[Scroll] Container #${containerId} not found.`);
    }
}


// --- NEW: Load and Display Messages for a Specific Conversation ---
async function loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error("[Chat Load] Chat display element not found.");
        return;
    }
    if (!conversationId) {
         console.log("[Chat Load] No specific conversation ID provided. Displaying initial prompt.");
         chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start a new conversation!</p>';
         currentConversationId = null; // Ensure state is null
         return;
    }

    console.log(`[Chat Load] Loading messages for conversation ID: ${conversationId}...`);
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        console.warn("[Chat Load] Cannot load conversation: No auth token.");
        chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Please log in.</p>';
        return;
    }

    try {
        const response = await fetch(`/api/v1/conversations/${conversationId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 404) {
             console.log(`[Chat Load] Conversation ${conversationId} not found or not accessible.`);
             chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Conversation not found. Start a new one!</p>';
             currentConversationId = null; // Reset state if conversation doesn't exist
             return;
        }
        if (!response.ok) {
            console.error(`[Chat Load] Failed to fetch conversation ${conversationId}: ${response.status}`);
            chatDisplay.innerHTML = '<p class="text-danger small text-center">Error loading conversation.</p>';
            return;
        }

        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            console.log(`[Chat Load] Received ${data.messages.length} messages for conversation ${conversationId}.`);
            let historyHTML = '';
            data.messages.forEach(message => {
                const isUser = message.role === 'user';
                const roleClass = isUser ? 'user-message' : 'ai-message';
                const roleLabel = isUser ? 'You' : 'AI';
                let content = message.content || ''; // Handle potentially missing content

                // Render user messages safely, AI messages with markdown
                if (isUser) {
                    content = `<p class="m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
                } else if (window.marked) {
                    // Render markdown for AI, ensure basic safety (though Marked does some)
                    content = `<div class="markdown-content p-0 m-0">${marked.parse(content)}</div>`;
                } else {
                     content = `<div class="markdown-content p-0 m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`; // Fallback
                }

                historyHTML += `
                    <div class="chat-message ${roleClass} p-2 my-2">
                        <strong>${roleLabel}:</strong>
                        ${content}
                    </div>`;
            });
            chatDisplay.innerHTML = historyHTML;
            currentConversationId = conversationId; // Set the active conversation ID
            console.log(`[Chat Load] Set currentConversationId = ${currentConversationId}`);
        } else {
            console.log(`[Chat Load] Conversation ${conversationId} has no messages.`);
            // If the conversation exists but is empty, allow user to start typing
            chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Conversation started. Send your first message!</p>';
            currentConversationId = conversationId; // Set the active conversation ID
             console.log(`[Chat Load] Set currentConversationId = ${currentConversationId} (empty conversation)`);
        }

        scrollToBottom();

    } catch (e) {
        console.error(`[Chat Load] Error fetching or rendering conversation ${conversationId}:`, e);
        chatDisplay.innerHTML = '<p class="text-danger small text-center">Error loading conversation.</p>';
    }
}

// --- Load the User's Most Recent Conversation (Corrected) ---
async function loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error("[Chat Load] Cannot load latest: Chat display element not found.");
        return; // Exit if display area doesn't exist
    }

    console.log("[Chat Load] Attempting to load the latest conversation...");
    // Initial loading message
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';

    // Get token safely
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    // Log token status before fetch
    console.log(`[Chat Load] Token check before fetching conversations: ${token ? 'Token Present' : 'Token MISSING'}`);
    if (!token) {
        console.warn("[Chat Load] Cannot load latest conversation: No auth token available.");
         chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Please log in to load conversations.</p>';
        return; // Exit if no token
    }

    try {
        // Fetch the list of conversations
        const response = await fetch('/api/v1/conversations', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // Log the response status
        console.log(`[Chat Load] Fetch conversations response status: ${response.status}`);

        if (!response.ok) {
            console.error(`[Chat Load] Failed to fetch conversations list: ${response.status}, Body:`, await response.text());
            chatDisplay.innerHTML = '<p class="text-danger small text-center">Error finding conversations.</p>';
            return; // Exit on fetch error
        }

        // Parse the JSON response - 'data' should be the array itself
        const data = await response.json();
        // Log the received data structure
        console.log("[Chat Load] Received conversations data (should be an array):", data);

        // --- CORRECTED CONDITION ---
        // Check if 'data' itself is an array and has items
        if (data && Array.isArray(data) && data.length > 0) {
            // Log number of conversations found
            console.log(`[Chat Load] Found ${data.length} conversations in the response array.`);

            // Access the first conversation directly from 'data' (index 0)
            const firstConversation = data[0];
            // Log the first conversation object to inspect its structure
            console.log("[Chat Load] First conversation object (latest):", firstConversation);

            // Check if the first conversation object exists and has a valid 'id' property
            if (firstConversation && typeof firstConversation.id === 'number') { // Check type too
                 const latestConversationId = firstConversation.id;
                 // Log the extracted ID
                 console.log(`[Chat Load] Extracted latest conversation ID: ${latestConversationId}`);
                 // Proceed to load messages for this specific conversation
                 await loadAndDisplayConversation(latestConversationId);
            } else {
                // Log an error if the structure is unexpected (missing 'id' or wrong type)
                console.error("[Chat Load] ERROR: First conversation object is missing a valid 'id' property. Data:", data);
                 // Fallback to showing no specific conversation
                 await loadAndDisplayConversation(null);
            }
        } else {
            // Log if the response was not an array or was empty
            console.log("[Chat Load] Response data is not a non-empty array, or no conversations found. Data:", data);
            // Display the initial "start new" prompt
            await loadAndDisplayConversation(null);
        }
        // --- END CORRECTED CONDITION ---

    } catch (e) {
        // Catch errors during fetch or JSON parsing
        console.error("[Chat Load] Error during fetch or processing conversations list:", e);
        chatDisplay.innerHTML = '<p class="text-danger small text-center">Error processing conversations.</p>';
    }
}

// Ensure you also have the 'loadAndDisplayConversation' function defined elsewhere in chat.js
// async function loadAndDisplayConversation(conversationId) { ... }

// --- API submission and streaming (MODIFIED) ---
async function handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        console.error("[Chat Submit] Cannot send message: No auth token.");
        aiMessageDiv.querySelector('.markdown-content').innerHTML =
            '<span class="text-danger">Authentication error. Please log in again.</span>';
        return;
    }

    try {
        // Setup form data - ADD conversation_id IF IT EXISTS
        const formData = new FormData();
        formData.append('prompt', userMessage);
        if (currentConversationId !== null) { // Check if we have an active conversation ID
            formData.append('conversation_id', currentConversationId);
            console.log(`[Chat Submit] Sending message for conversation ID: ${currentConversationId}`);
        } else {
            console.log("[Chat Submit] Sending message to start a NEW conversation.");
        }

        const headers = {
            // HTMX header not needed for fetch 'HX-Request': 'true',
            'Authorization': `Bearer ${token}`
             // 'Accept': 'text/plain' // Might help ensure streaming
        };

        console.log('[Chat Submit] Sending API request to /api/v1/chat/message');
        const response = await fetch('/api/v1/chat/message', {
            method: 'POST',
            body: formData,
            headers: headers
        });

        // --- Check for new conversation ID in headers ---
        const newConvIdHeader = response.headers.get('X-Conversation-ID');
        if (newConvIdHeader) {
            const newId = parseInt(newConvIdHeader, 10);
            if (!isNaN(newId)) {
                currentConversationId = newId;
                console.log(`[Chat Submit] Received and set NEW currentConversationId = ${currentConversationId}`);
                 // Optionally display the title too:
                 // const newConvTitle = response.headers.get('X-Conversation-Title');
                 // console.log(`[Chat Submit] New conversation title: ${newConvTitle}`);
            }
        }
        // --- End Header Check ---

        if (!response.ok) {
            // Try to get error detail from backend
            let errorDetail = `Request failed with status: ${response.status}`;
            try {
                const errorJson = await response.json();
                errorDetail = errorJson.detail || errorDetail;
            } catch (e) { /* Ignore if response is not json */ }
            throw new Error(errorDetail);
        }

        if (!response.body) {
            throw new Error('Server response does not support streaming.');
        }

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiResponseContent = ''; // Accumulate full response text
        let firstChunk = true;
        const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
        markdownDiv.innerHTML = ''; // Clear spinner immediately

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            aiResponseContent += chunk; // Accumulate text

            // Render the accumulated text as markdown progressively
             if (window.marked) {
                 // Use marked.parse for progressive rendering
                 markdownDiv.innerHTML = marked.parse(aiResponseContent);
             } else {
                 markdownDiv.textContent += chunk; // Fallback: simple text append
             }

            // Scroll as content arrives
            scrollToBottom();
        }

        // Final processing of the buffer is implicitly handled by accumulating aiResponseContent

        console.log(`[Chat Submit] Stream finished. Full AI response length: ${aiResponseContent.length}`);

        // Re-enable form, clear input AFTER stream finishes
        if (textareaElement) {
             textareaElement.value = '';
             autoResizeTextarea(textareaElement); // Reset height
        }
        const generateButton = document.getElementById('ai-generate-button');
         if(generateButton) generateButton.disabled = false;
         const loadingIndicator = document.getElementById('ai-loading-indicator');
         if(loadingIndicator) loadingIndicator.style.display = 'none';


    } catch (error) {
        console.error('[Chat Submit] API error:', error);
        const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
         if (markdownDiv) { // Ensure div exists before setting error
             markdownDiv.innerHTML = `<span class="text-danger"><strong>Error:</strong> ${escapeHtml(error.message)}</span>`;
         }
         // Re-enable form even on error
          if (textareaElement) textareaElement.disabled = false;
          const generateButton = document.getElementById('ai-generate-button');
          if(generateButton) generateButton.disabled = false;
          const loadingIndicator = document.getElementById('ai-loading-indicator');
         if(loadingIndicator) loadingIndicator.style.display = 'none';
    }
}


document.addEventListener('DOMContentLoaded', function() {
    console.log('[Chat] DOMContentLoaded');

    // -- Elements --
    const chatForm = document.getElementById('ai-generation-form');
    const zoomButton = document.getElementById('chat-zoom-toggle');
    const chatDisplay = document.getElementById('chat-message-list');
    const promptInput = document.getElementById('ai-prompt-input');
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');


    // Setup auto-resize for textarea
    if (promptInput) {
        autoResizeTextarea(promptInput); // Initial size
        promptInput.addEventListener('input', () => autoResizeTextarea(promptInput));
        promptInput.addEventListener('focus', () => autoResizeTextarea(promptInput)); // Resize on focus too
         // Handle Shift+Enter for new line, Enter for submit
         promptInput.addEventListener('keydown', function(e) {
             if (e.key === 'Enter' && !e.shiftKey) {
                 e.preventDefault(); // Prevent default Enter behavior (new line)
                 if (!generateButton.disabled) { // Check if button is enabled
                     chatForm.requestSubmit(); // Trigger form submission
                 }
             }
         });
    }

    // Fullscreen Toggle
    if (zoomButton) {
        zoomButton.addEventListener('click', function() {
            document.body.classList.toggle('chat-fullscreen-active');
            console.log('[Chat] Toggled fullscreen mode');
            const isFullscreen = document.body.classList.contains('chat-fullscreen-active');
            const icon = this.querySelector('i');
            if (icon) icon.className = isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';

            // Ensure elements are correctly displayed/hidden and sized
            document.querySelectorAll('section:not(#ai-tool)').forEach(s => s.style.display = isFullscreen ? 'none' : '');
            document.querySelectorAll('#ai-tool h2, #ai-tool > .container > p.lead').forEach(h => h.style.display = isFullscreen ? 'none' : '');

            // Re-apply textarea resize logic after mode change (affects form height in fullscreen)
            if(promptInput) autoResizeTextarea(promptInput);
            // Scroll to bottom after layout potentially changes
            scrollToBottom();
        });
    }

    // Form Submission Handling
    if (chatForm) {
        chatForm.addEventListener('submit', function(e) {
            e.preventDefault();
            console.log('[Chat] Form submit event triggered.');

            if (!promptInput || !chatDisplay || !generateButton || !loadingIndicator) {
                 console.error("[Chat Submit] Required chat elements not found.");
                 return;
            }

            const userMessage = promptInput.value.trim();
            if (!userMessage) {
                console.log("[Chat Submit] Empty prompt submitted.");
                return; // Don't submit empty messages
            }

            // Disable form during submission
            promptInput.disabled = true;
            generateButton.disabled = true;
            loadingIndicator.style.display = 'inline-block';

            console.log('[Chat Submit] User message:', userMessage);

            // Clear placeholder if it exists
            const placeholder = chatDisplay.querySelector('.initial-chat-prompt');
            if (placeholder) placeholder.remove();

            // --- Display User Message ---
            const userDiv = document.createElement('div');
            userDiv.className = 'chat-message user-message p-2 my-2';
            // Render markdown-like line breaks from textarea
            userDiv.innerHTML = `<strong>You:</strong><p class="m-0">${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>`;
            chatDisplay.appendChild(userDiv);
            scrollToBottom(); // Scroll after adding user message

            // --- Prepare AI Response Placeholder ---
            const aiDiv = document.createElement('div');
            aiDiv.className = 'chat-message ai-message p-2 my-2';
            // Use a container for markdown content
            aiDiv.innerHTML = `<strong>AI:</strong><div class="markdown-content"><span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span><span class="visually-hidden">Generating...</span></div>`;
            chatDisplay.appendChild(aiDiv);
            scrollToBottom(); // Scroll after adding placeholder

            // --- Call API Handler ---
            // Pass elements needed for feedback (AI div, textarea)
            handleAPISubmission(userMessage, aiDiv, promptInput);
        });
    }


    // --- Chat Initialization Function (called by auth.js) ---
    function initializeChat() {
        if (window.chatInitialized) {
            console.log("[Chat Init] Chat already initialized.");
            return;
        }
        console.log("[Chat Init] Initializing chat interface...");

        // Load the latest conversation instead of old global history
        loadLatestConversation();

        window.chatInitialized = true; // Set flag
        console.log("[Chat Init] Chat interface initialized.");

        // Dispatch event for auth.js if needed (optional, depends on auth.js implementation)
        // document.dispatchEvent(new CustomEvent('chatScriptReady'));
    }

    // Make function globally available for auth.js
    window.initializeChat = initializeChat;

    // --- Initial State Check ---
    // If the user might already be logged in when this script runs,
    // try initializing. auth.js will call it again if needed.
    // This helps if chat.js loads slightly after auth.js determines login state.
    // Add a small delay to increase chances auth.js has set the token.
    setTimeout(() => {
        if (window.getCurrentAccessToken && window.getCurrentAccessToken()) {
             console.log("[Chat Init] Token found on load, attempting initial chat load.");
             initializeChat();
         } else {
             console.log("[Chat Init] No token found on load, waiting for auth.js trigger.");
             // Display initial prompt if no token yet
             const chatDisplay = document.getElementById('chat-message-list');
             if (chatDisplay && !chatDisplay.hasChildNodes()) { // Only if empty
                chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Log in to start chatting.</p>';
             }
         }
    }, 200); // 200ms delay

}); // End DOMContentLoaded