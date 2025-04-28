// static/chat.js - v18 FINAL - Flexbox Layout, Minimal JS Resize

console.log("[Chat] chat.js v18 FINAL loaded");

// --- Global State ---
let currentConversationId = null;
// REMOVED: let rafPaddingId = null;

// --- Utilities ---
function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/\"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// --- Function to ONLY Set Textarea Height ---
// Calculates and applies the correct height to the textarea based on content.
function setTextareaHeight(textarea) {
    if (!textarea) return;

    const minHeight = 46; // Match CSS min-height
    const maxHeight = 300; // Match CSS max-height

    // Store current height before changing it
    const initialHeight = textarea.style.height;

    // Reset height to minHeight before calculating scrollHeight for consistency
    textarea.style.height = `${minHeight}px`;

    // Calculate needed height based on content scroll height
    const scrollHeight = textarea.scrollHeight;

    // Determine new height, constrained by min/max
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    const newHeightPx = `${newHeight}px`;

    // Apply the new height only if it actually changed to prevent infinite loops
    if (newHeightPx !== initialHeight) {
        textarea.style.height = newHeightPx;
        // console.log(`[SetHeight] Textarea scrollH: ${scrollHeight}, newH: ${newHeight}`);
    } else {
        // If height didn't change, put back the original style value
        // This can happen if scrollHeight is slightly off but rounds to same constrained height
        textarea.style.height = initialHeight;
    }
    // NO padding adjustment needed here - Flexbox handles layout
}

// REMOVED: adjustChatListPadding()
// REMOVED: requestFullscreenLayoutAdjustment()

// --- Scroll function ---
// Scrolls the specified container smoothly (or instantly) to the bottom.
function scrollToBottom(containerId = 'ai-result-output') {
    const container = document.getElementById(containerId);
    if (container) {
        // Use requestAnimationFrame to scroll after potential DOM updates
        requestAnimationFrame(() => {
             // Use behavior: 'auto' for instant scroll, often better with dynamic content
             container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
        });
    }
}

// --- Load and Display Messages for a Specific Conversation ---
async function loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) { console.error("[Chat Load] Chat display element not found."); return; }

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    // Handle displaying initial prompt if no conversation ID is provided
    if (!conversationId) {
         console.log("[Chat Load] No specific conversation ID. Displaying initial prompt.");
         chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start a new conversation!</p>';
         currentConversationId = null;
         return;
    }

    // Handle case where user isn't logged in
    if (!token) {
        console.warn("[Chat Load] Cannot load conversation: No auth token.");
        chatDisplay.innerHTML = '<p class="text-danger small text-center initial-chat-prompt">Please log in to load conversation.</p>';
        return;
    }

    console.log(`[Chat Load] Loading messages for conversation ID: ${conversationId}...`);
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';

    try {
        const response = await fetch(`/api/v1/conversations/${conversationId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 404) {
             console.log(`[Chat Load] Conversation ${conversationId} not found or not accessible.`);
             chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Conversation not found. Start a new one!</p>';
             currentConversationId = null; // Reset state
             return;
        }
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Chat Load] Failed to fetch conversation ${conversationId}: ${response.status}`, errorText);
            chatDisplay.innerHTML = '<p class="text-danger small text-center">Error loading conversation.</p>';
            return;
        }

        const data = await response.json();

        // Validate response structure
        if (data.conversation && data.messages && Array.isArray(data.messages)) {
            if (data.messages.length > 0) {
                console.log(`[Chat Load] Received ${data.messages.length} messages for conversation ${conversationId}.`);
                let historyHTML = '';
                // Build HTML for messages
                data.messages.forEach(message => {
                    const isUser = message.role === 'user';
                    const roleClass = isUser ? 'user-message' : 'ai-message';
                    const roleLabel = isUser ? 'You' : 'AI';
                    let content = message.content || '';

                    if (isUser) {
                        content = `<p class="m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
                    } else if (window.marked) {
                        content = `<div class="markdown-content p-0 m-0">${marked.parse(content)}</div>`;
                    } else {
                        content = `<div class="markdown-content p-0 m-0">${escapeHtml(content).replace(/\n/g, '<br>')}</div>`; // Fallback
                    }
                    const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : ''; // Optional timestamp display
                    historyHTML += `<div class="chat-message ${roleClass}" title="${timestamp}"><strong>${roleLabel}</strong>${content}</div>`;
                });
                chatDisplay.innerHTML = historyHTML;
            } else {
                 // Conversation exists but is empty
                 console.log(`[Chat Load] Conversation ${conversationId} exists but has no messages.`);
                 chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Conversation started. Send your first message!</p>';
            }
            currentConversationId = conversationId; // Set the active conversation ID
            console.log(`[Chat Load] Set currentConversationId = ${currentConversationId}`);
        } else {
             console.error("[Chat Load] Invalid data structure received for conversation details:", data);
             chatDisplay.innerHTML = '<p class="text-danger small text-center">Error loading conversation data.</p>';
             currentConversationId = null; // Reset ID if data is bad
        }

        scrollToBottom(); // Scroll after rendering messages

    } catch (e) {
        console.error(`[Chat Load] Error fetching or rendering conversation ${conversationId}:`, e);
        chatDisplay.innerHTML = '<p class="text-danger small text-center">Error loading conversation.</p>';
        currentConversationId = null; // Reset ID on error
    }
}

// --- Load the User's Most Recent Conversation ---
async function loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error("[Chat Load] Cannot load latest: Chat display element not found.");
        return;
    }

    console.log("[Chat Load] Attempting to load the latest conversation...");
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    console.log(`[Chat Load] Token check before fetching conversations: ${token ? 'Token Present' : 'Token MISSING'}`);
    if (!token) {
        console.warn("[Chat Load] Cannot load latest conversation: No auth token available.");
         chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Please log in to load conversations.</p>';
        return;
    }

    try {
        const response = await fetch('/api/v1/conversations', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`[Chat Load] Fetch conversations response status: ${response.status}`);

        if (!response.ok) {
            console.error(`[Chat Load] Failed to fetch conversations list: ${response.status}, Body:`, await response.text());
            chatDisplay.innerHTML = '<p class="text-danger small text-center">Error finding conversations.</p>';
            return;
        }

        const data = await response.json(); // Expecting an array directly
        console.log("[Chat Load] Received conversations data (should be an array):", data);

        // Check if 'data' itself is a non-empty array
        if (data && Array.isArray(data) && data.length > 0) {
            console.log(`[Chat Load] Found ${data.length} conversations in the response array.`);
            const firstConversation = data[0]; // Latest is first
            console.log("[Chat Load] First conversation object (latest):", firstConversation);

            // Check if the latest conversation has a valid ID
            if (firstConversation && typeof firstConversation.id === 'number') {
                 const latestConversationId = firstConversation.id;
                 console.log(`[Chat Load] Extracted latest conversation ID: ${latestConversationId}`);
                 await loadAndDisplayConversation(latestConversationId); // Load messages
            } else {
                console.error("[Chat Load] ERROR: First conversation object is missing a valid 'id' property. Data:", data);
                 await loadAndDisplayConversation(null); // Fallback to no conversation
            }
        } else {
            // No conversations found or invalid data
            console.log("[Chat Load] No existing conversations found or data is not a non-empty array. Data:", data);
            await loadAndDisplayConversation(null); // Display initial prompt
        }

    } catch (e) {
        console.error("[Chat Load] Error during fetch or processing conversations list:", e);
        chatDisplay.innerHTML = '<p class="text-danger small text-center">Error processing conversations.</p>';
        await loadAndDisplayConversation(null); // Fallback on error
    }
}


// --- API Submission (with finally block, calls only setTextareaHeight) ---
async function handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let success = false; // Flag to track successful stream completion
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');

    // Handle missing token case
    if (!token) {
        console.error("[Chat Submit] Cannot send message: No auth token.");
        if (aiMessageDiv) {
             const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
             if (markdownDiv) { markdownDiv.innerHTML = '<span class="text-danger">Authentication error. Please log in again.</span>'; }
        }
        // Re-enable form immediately if no token
        if (textareaElement) textareaElement.disabled = false;
        if (generateButton) generateButton.disabled = false;
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        return;
    }

    try {
        // --- Setup Request ---
        const formData = new FormData();
        formData.append('prompt', userMessage);
        if (currentConversationId !== null) {
            formData.append('conversation_id', currentConversationId);
        }
        const headers = { 'Authorization': `Bearer ${token}` };

        // --- Fetch Call ---
        const response = await fetch('/api/v1/chat/message', { method: 'POST', body: formData, headers: headers });

        // --- Handle New Conversation ID ---
        const newConvIdHeader = response.headers.get('X-Conversation-ID');
        if (newConvIdHeader) {
            const newId = parseInt(newConvIdHeader, 10);
            if (!isNaN(newId)) {
                 currentConversationId = newId;
                 console.log(`[Chat Submit] Received and set NEW currentConversationId = ${currentConversationId}`);
             }
        }

        // --- Handle HTTP Errors ---
        if (!response.ok) {
            let errorDetail = `Request failed with status: ${response.status}`;
            try { const errorJson = await response.json(); errorDetail = errorJson.detail || errorDetail; } catch (e) { /* Ignore if not JSON */ }
            throw new Error(errorDetail);
        }

        // --- Handle Missing Stream Body ---
        if (!response.body) { throw new Error('Server response does not support streaming or body is missing.'); }

        // --- Process Stream ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiResponseContent = '';
        const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
        if (!markdownDiv) {
            console.error("[Chat Submit] Markdown display area (.markdown-content) not found in AI message div.");
            aiMessageDiv.innerHTML += '<br><span class="text-warning">(Display error)</span> '; // Indicate issue
        } else {
            markdownDiv.innerHTML = ''; // Clear spinner only if div exists
        }

        while (true) {
            const { value, done } = await reader.read();
            if (done) break; // Exit loop when stream ends

            const chunk = decoder.decode(value, { stream: true });
            aiResponseContent += chunk; // Accumulate full response

            // Update display progressively
            const displayTarget = markdownDiv || aiMessageDiv; // Fallback target
            if (window.marked) { displayTarget.innerHTML = marked.parse(aiResponseContent); }
            else { displayTarget.textContent = aiResponseContent; } // Use textContent for safety if marked fails

            scrollToBottom(); // Scroll as content arrives
        }

        // --- Final Checks ---
        if (aiResponseContent.startsWith("Error:")) {
             console.warn("[Chat Submit] AI stream completed but contained an error message:", aiResponseContent);
        } else if (aiResponseContent.trim() === "") {
             console.warn("[Chat Submit] AI stream completed with empty content.");
             if(markdownDiv) markdownDiv.innerHTML = '<span class="text-muted small">(Empty response received)</span>';
        } else {
            success = true; // Mark as successful only if stream finished without internal error and had content
        }

    } catch (error) {
        // --- Handle Fetch/Stream Errors ---
        console.error('[Chat Submit] API error:', error);
        if (aiMessageDiv) { // Display error in the message bubble
            const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
            const errorDisplayTarget = markdownDiv || aiMessageDiv; // Use markdownDiv or fallback to whole bubble
            // Use textContent for error messages to prevent potential HTML injection
            errorDisplayTarget.textContent = `Error: ${error.message}`;
            errorDisplayTarget.classList.add('text-danger'); // Add error styling
        }
        // Error handled, proceed to finally block

    } finally {
        // --- Always Re-enable Form & Set Textarea Height ---
        if (textareaElement) {
            textareaElement.disabled = false;
            if (success) {
                textareaElement.value = ''; // Clear input only on success
            }
            // Set height immediately based on final content
            setTextareaHeight(textareaElement); // ONLY call this
        }
        if (generateButton) { generateButton.disabled = false; }
        if (loadingIndicator) { loadingIndicator.style.display = 'none'; }
        // console.log("[Chat Submit] Finally block: Form re-enabled and resized.");
    }
}


// --- DOMContentLoaded Event Listener ---
document.addEventListener('DOMContentLoaded', function() {
    console.log('[Chat] DOMContentLoaded');

    // Get elements needed for event listeners
    const chatForm = document.getElementById('ai-generation-form');
    const zoomButton = document.getElementById('chat-zoom-toggle');
    const promptInput = document.getElementById('ai-prompt-input');

    // Setup auto-resize listeners for the textarea
    if (promptInput) {
        // On input: Trigger height setting directly.
        promptInput.addEventListener('input', () => {
            setTextareaHeight(promptInput);
        });
        // On focus: Also trigger height setting directly.
        promptInput.addEventListener('focus', () => {
             setTextareaHeight(promptInput);
        });
        // Initial size calculation on load
        setTextareaHeight(promptInput);

        // Enter key listener for submission
        promptInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) { // Enter submits, Shift+Enter makes newline
                e.preventDefault(); // Prevent newline on Enter
                const generateButton = document.getElementById('ai-generate-button');
                // Trigger form submission only if button isn't disabled
                if (generateButton && !generateButton.disabled) {
                    // chatForm.requestSubmit(generateButton); // Not universally supported
                    generateButton.click(); // Simulate click on the button
                }
            }
        });
    }

    // Fullscreen Toggle Listener
    if (zoomButton) {
        zoomButton.addEventListener('click', function() {
            const body = document.body;
            const icon = this.querySelector('i');
            body.classList.toggle('chat-fullscreen-active'); // Toggle the class on body
            const isFullscreen = body.classList.contains('chat-fullscreen-active');
            console.log(`[Chat Zoom] Toggled fullscreen. Active: ${isFullscreen}`);

            // Update the button icon
            if (icon) {
                icon.className = isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';
            }

            // Recalculate layout adjustments after CSS has likely been applied
            // Use timeout to allow potential CSS transitions start/finish
            setTimeout(() => {
                if (promptInput) {
                    setTextareaHeight(promptInput); // Recalculate height which might affect form H
                }
                scrollToBottom(); // Ensure view is scrolled correctly after layout change
            }, 50); // Small delay
        });
    }

    // Form Submission Listener
    if (chatForm) {
        chatForm.addEventListener('submit', function(e) {
             e.preventDefault(); // Prevent standard form submission

             // Re-get elements inside listener to ensure they exist
             const currentPromptInput = document.getElementById('ai-prompt-input');
             const chatDisplay = document.getElementById('chat-message-list');
             const currentGenerateButton = document.getElementById('ai-generate-button');
             const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

             // Ensure all required elements are present
             if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
                 console.error("[Chat Submit] One or more required chat elements not found on submit.");
                 return;
             }

             const userMessage = currentPromptInput.value.trim();
             // Don't submit empty messages
             if (!userMessage) {
                 console.log("[Chat Submit] Empty prompt submitted.");
                 return;
             }

             // Disable form elements during submission
             currentPromptInput.disabled = true;
             currentGenerateButton.disabled = true;
             currentLoadingIndicator.style.display = 'inline-block'; // Show spinner

             // Clear any initial "Start conversation" prompt
             const placeholder = chatDisplay.querySelector('.initial-chat-prompt');
             if (placeholder) { placeholder.remove(); }

             // Display User Message immediately
             const userDiv = document.createElement('div');
             userDiv.className = 'chat-message user-message'; // Use specific class
             // Ensure content wraps correctly and respects newlines
             userDiv.innerHTML = `<strong>You:</strong><p class="m-0">${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>`;
             chatDisplay.appendChild(userDiv);

             // Create placeholder for AI response
             const aiDiv = document.createElement('div');
             aiDiv.className = 'chat-message ai-message'; // Use specific class
             // Include spinner inside the markdown container
             aiDiv.innerHTML = `<strong>AI:</strong><div class="markdown-content"><span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span><span class="visually-hidden">Generating...</span></div>`;
             chatDisplay.appendChild(aiDiv);

             // Scroll down after adding messages
             scrollToBottom();

             // Call the async function to handle the API request and streaming
             handleAPISubmission(userMessage, aiDiv, currentPromptInput);
        });
    }

    // --- Chat Initialization Function (called by auth.js) ---
    function initializeChat() {
        // Prevent multiple initializations
        if (window.chatInitialized) {
            // console.log("[Chat Init] Chat already initialized.");
            return;
        }
        console.log("[Chat Init] Initializing chat interface...");

        // Load the latest conversation for the user
        loadLatestConversation();

        window.chatInitialized = true; // Set flag
        console.log("[Chat Init] Chat interface initialized.");
    }
    // Expose initializeChat globally for auth.js to call
    window.initializeChat = initializeChat;

    // Initial state check message - Rely on auth.js to call initializeChat
    console.log("[Chat] chat.js setup complete. Waiting for auth trigger.");

}); // End DOMContentLoaded