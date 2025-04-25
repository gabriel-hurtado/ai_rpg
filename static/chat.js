// static/chat.js - v11 - Handles History, Scrolling (Newest at Bottom)

console.log("[Chat] chat.js loaded");

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

// Wait for document to be ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('[Chat] Initializing chat components');
    
    // -- Elements --
    const chatForm = document.getElementById('ai-generation-form');
    const zoomButton = document.getElementById('chat-zoom-toggle');
    const chatDisplay = document.getElementById('chat-message-list');
    
    // Improve scrolling in fullscreen mode
    function scrollToBottom() {
        const container = document.getElementById('ai-result-output');
        const messagesList = document.getElementById('chat-message-list');
        
        if (container && messagesList) {
            // Get the last message
            const messages = messagesList.querySelectorAll('.chat-message');
            if (messages.length > 0) {
                console.log('[Chat] Scrolling to bottom, messages:', messages.length);
                
                // Force scroll to bottom with a slight delay
                setTimeout(() => {
                    container.scrollTop = container.scrollHeight;
                    console.log('[Chat] Scrolled to:', container.scrollTop, 'of', container.scrollHeight);
                    
                    // Double-check scroll position after a short delay
                    setTimeout(() => {
                        // Try to ensure we're actually at the bottom
                        container.scrollTop = container.scrollHeight;
                    }, 300);
                }, 100);
            }
        }
    }
    
    // Toggle fullscreen mode with better scrolling and visibility control
    if (zoomButton) {
        zoomButton.addEventListener('click', function() {
            // Toggle the class
            document.body.classList.toggle('chat-fullscreen-active');
            console.log('[Chat] Toggled fullscreen mode');
            
            // Get all sections that need to be hidden in fullscreen
            const otherSections = document.querySelectorAll('section:not(#ai-tool)');
            const container = document.getElementById('ai-result-output');
            const form = document.getElementById('ai-generation-form');
            
            // Get fullscreen state
            const isFullscreen = document.body.classList.contains('chat-fullscreen-active');
            
            // Toggle sections visibility
            otherSections.forEach(section => {
                section.style.display = isFullscreen ? 'none' : '';
            });
            
            // Update icon and visibility
            const icon = this.querySelector('i');
            if (icon) {
                if (isFullscreen) {
                    // ENTERING FULLSCREEN
                    icon.className = 'bi bi-fullscreen-exit';
                    
                    // Hide heading elements
                    const headings = document.querySelectorAll('#ai-tool h2, #ai-tool > .container > p');
                    headings.forEach(el => el.style.display = 'none');
                    
                    // Make container and form fully visible
                    if (container) {
                        container.style.visibility = 'visible';
                        container.style.display = 'block';
                    }
                    
                    if (form) {
                        form.style.visibility = 'visible';
                        form.style.display = 'flex';
                        form.style.maxWidth = '95%'; // Ensure wide form in fullscreen
                        
                        // Make textarea wider in fullscreen
                        const textarea = form.querySelector('#ai-prompt-input');
                        if (textarea) {
                            textarea.style.flex = '1 1 auto';
                            textarea.style.width = '100%';
                            textarea.style.maxWidth = 'none';
                        }
                        
                        // Make form div wider
                        const formDiv = form.querySelector('div');
                        if (formDiv) {
                            formDiv.style.width = '100%';
                        }
                    }
                    
                    // Force scroll to bottom after transition
                    setTimeout(() => {
                        scrollToBottom();
                        console.log('[Chat] Forced scroll after fullscreen toggle');
                    }, 300);
                } else {
                    // EXITING FULLSCREEN
                    icon.className = 'bi bi-arrows-fullscreen';
                    
                    // Restore heading elements
                    const headings = document.querySelectorAll('#ai-tool h2, #ai-tool > .container > p');
                    headings.forEach(el => el.style.display = '');
                    
                    // Keep form width consistent
                    if (form) {
                        form.style.maxWidth = '90%';
                    }
                    
                    // Force scroll to bottom after transition
                    setTimeout(() => {
                        scrollToBottom();
                        console.log('[Chat] Forced scroll after fullscreen toggle');
                    }, 300);
                }
            }
        });
    }
    
    // Better form submit handling
    if (chatForm) {
        chatForm.addEventListener('submit', function(e) {
            e.preventDefault();
            console.log('[Chat] Form submitted');
            
            // Get user input
            const textarea = this.querySelector('textarea');
            if (!textarea) return;
            
            const userMessage = textarea.value.trim();
            if (!userMessage) return;
            
            console.log('[Chat] User message:', userMessage);
            
            // Remove placeholder if it exists
            const placeholder = chatDisplay.querySelector('.initial-chat-prompt');
            if (placeholder) placeholder.remove();
            
            // Create & add user message
            const userDiv = document.createElement('div');
            userDiv.className = 'chat-message user-message p-2 my-2';
            userDiv.innerHTML = `<strong>You:</strong><p class="m-0">${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>`;
            chatDisplay.appendChild(userDiv);
            
            // Create & add AI message with spinner
            const aiDiv = document.createElement('div');
            aiDiv.className = 'chat-message ai-message p-2 my-2';
            aiDiv.innerHTML = '<strong>AI:</strong><div class="markdown-content"><span class="ai-loading-spinner spinner-border spinner-border-sm" role="status"></span></div>';
            chatDisplay.appendChild(aiDiv);
            
            // Explicitly scroll to bottom AFTER adding messages
            scrollToBottom();
            
            // Submit to API
            handleAPISubmission(userMessage, aiDiv, textarea);
        });
    }
    
    // -- API submission and streaming --
    async function handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
        try {
            // Setup form data
            const formData = new FormData();
            formData.append('prompt', userMessage);
            
            // Headers
            const headers = { 'HX-Request': 'true' };
            if (window.currentAccessToken) {
                headers['Authorization'] = `Bearer ${window.currentAccessToken}`;
            }
            
            // Fetch
            console.log('[Chat] Sending API request');
            const response = await fetch('/api/v1/chat/message', {
                method: 'POST',
                body: formData,
                headers: headers
            });
            
            if (!response.ok) {
                throw new Error('Response status: ' + response.status);
            }
            
            if (!response.body) {
                aiMessageDiv.querySelector('.markdown-content').innerHTML = 
                    '<span class="text-danger">Server does not support streaming responses.</span>';
                return;
            }
            
            // Handle streaming
            const reader = response.body.getReader();
            let decoder = new TextDecoder();
            let buffer = '';
            let firstChunk = true;
            
            const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                
                // Process buffer
                let lines = buffer.split('\n');
                
                // Keep last potentially incomplete line in buffer
                buffer = lines.pop() || '';
                
                for (let line of lines) {
                    if (!line.trim()) continue;
                    
                    if (firstChunk) {
                        markdownDiv.innerHTML = '';
                        firstChunk = false;
                    }
                    
                    // Add line as markdown
                    markdownDiv.innerHTML += window.marked ? marked.parse(line) : line;
                    
                    // Scroll
                    const container = markdownDiv.closest('.chat-container');
                    if (container) container.scrollTop = container.scrollHeight;
                }
            }
            
            // Process any remaining buffer
            if (buffer.trim()) {
                if (firstChunk) {
                    markdownDiv.innerHTML = '';
                    firstChunk = false;
                }
                markdownDiv.innerHTML += window.marked ? marked.parse(buffer) : buffer;
            }
            
            // Clear input after success
            if (textareaElement) textareaElement.value = '';
            
            console.log('[Chat] API request complete');
            
        } catch (error) {
            console.error('[Chat] API error:', error);
            const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
            markdownDiv.innerHTML = '<span class="text-danger">Error: ' + error.message + '</span>';
        }
    }
    
    // RESTORE HISTORY LOADING
    async function loadChatHistory() {
        const chatDisplay = document.getElementById('chat-message-list');
        
        if (!chatDisplay) {
            console.error("[Chat History] Chat display element not found.");
            return;
        }
        
        console.log("[Chat History] Loading chat history...");
        chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading history...</p>';
        
        const token = window.currentAccessToken;
        
        if (!token) {
            console.warn("[Chat History] Cannot load history: No token available.");
            chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Chat history will appear here.</p>';
            return;
        }
        
        try {
            const response = await fetch('/api/v1/chat/history', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) {
                console.error(`[Chat History] Failed to fetch history: ${response.status}`);
                chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Chat history will appear here.</p>';
                return;
            }
            
            const data = await response.json();
            
            if (data.history && data.history.length > 0) {
                console.log(`[Chat History] Received ${data.history.length} messages.`);
                let historyHTML = '';
                
                // Format history messages
                data.history.forEach(message => {
                    const isUser = message.role === 'user';
                    const roleClass = isUser ? 'user-message' : 'ai-message';
                    const roleLabel = isUser ? 'You' : 'AI';
                    let content = '';
                    
                    if (typeof message.content === 'string') {
                        if (isUser) {
                            content = `<p class="m-0">${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`;
                        } else {
                            content = `<div class="markdown-content p-0 m-0">${message.content}</div>`;
                        }
                    }
                    
                    historyHTML += `
                        <div class="chat-message ${roleClass} p-2 my-2">
                            <strong>${roleLabel}:</strong>
                            ${content}
                        </div>`;
                });
                
                chatDisplay.innerHTML = historyHTML;
            } else {
                console.log("[Chat History] No previous chat history found.");
                chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start a new conversation!</p>';
            }
            
            scrollToBottom();
        } catch (e) {
            console.error("[Chat History] Error fetching or rendering history:", e);
            chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Error loading history.</p>';
        }
    }
    
    // RESTORE INIT FUNCTION FOR AUTH.JS
    function initializeChat() {
        console.log("[Chat Init] Initializing chat interface.");
        loadChatHistory();
        
        // Add any other initialization here
        
        console.log("[Chat Init] Chat interface initialized.");
    }
    
    // Make function globally available
    window.initializeChat = initializeChat;
    
    // Try to load history on page load if already logged in
    if (window.currentAccessToken) {
        loadChatHistory();
    }
});