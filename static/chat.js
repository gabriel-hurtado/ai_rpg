// static/chat.js

// --- Imports ---
// Assuming chatUtils.js, chatUI.js, chatApi.js provide these functions
import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';

// --- Constants ---
const CHAT_ZOOM_TOGGLE_NORMAL_ID = 'chat-zoom-toggle-normal';
const CHAT_ZOOM_TOGGLE_FULLSCREEN_ID = 'chat-zoom-toggle-fullscreen';

// --- Global Flags (Use cautiously) ---
let allowClassToggle = true; // Debounce flag for fullscreen toggle

/**
 * ChatManager orchestrates chat state, event wiring, and uses modular helpers for UI and API.
 */
const ChatManager = {
  currentConversationId: null,
  chatInitialized: false,
  isFullscreenActive: false, // Internal state tracker
  contextModalInstance: null,

  // --- CORE INITIALIZATION ---

  /**
   * Initialize the chat system. Called by auth.js when conditions are met.
   * Sets initial state, loads data, and syncs UI.
   */
  initializeChat() {
    // Prevent double initialization
    if (this.chatInitialized) {
      console.log('[Chat] InitializeChat called, but already initialized.');
      return;
    }
    console.log('[Chat] Initializing chat...');

    // Determine initial fullscreen state from body class (could be server-rendered or default CSS)
    this.isFullscreenActive = document.body.classList.contains('chat-fullscreen-active');
    console.log('[Chat] Initial fullscreen state determined as:', this.isFullscreenActive);

    this.loadLatestConversation(); // Load initial conversation data
    this.chatInitialized = true; // Set flag AFTER potentially async load starts
    console.log('[Chat] Chat initialized flag set to true.');

    this._syncUIWithState(); // Ensure UI elements (buttons, sidebar) match the initial state
    this.fetchAndUpdateCreditsDisplay(); // Fetch and display initial credits

    // Adjust textarea and scroll after a brief delay to allow content loading
    setTimeout(() => {
      const promptInput = document.getElementById('ai-prompt-input');
      if (promptInput) setTextareaHeight(promptInput, true);
      scrollToBottom('ai-result-output', false);
    }, 150);
  },

  /**
   * Teardown or reset the chat state. Called by auth.js on logout/credit loss.
   */
  teardownChat() {
      console.log('[Chat] Tearing down chat...');
      const chatDisplay = document.getElementById('chat-message-list');
      const promptInput = document.getElementById('ai-prompt-input');
      const generateButton = document.getElementById('ai-generate-button');
      const modifyContextControls = document.getElementById('chat-context-controls');
      const activeContextDisplay = document.getElementById('active-context-display');

      if (chatDisplay) chatDisplay.innerHTML = '<p class="text-muted small text-center py-5">Please log in and ensure you have credits to use the chat.</p>';
      if (promptInput) {
          promptInput.value = '';
          promptInput.disabled = true;
          setTextareaHeight(promptInput);
      }
      if (generateButton) generateButton.disabled = true;
      if (modifyContextControls) modifyContextControls.style.display = 'none';
      if (activeContextDisplay) activeContextDisplay.innerHTML = ''; // Clear context

      this.currentConversationId = null;
      this.chatInitialized = false; // Reset the flag
      // Note: Fullscreen state (this.isFullscreenActive) might persist visually unless explicitly reset
      // If exiting fullscreen on teardown is desired, call _syncUIWithState after setting isFullscreenActive = false
      console.log('[Chat] Teardown complete.');
  },


  // --- DATA LOADING & DISPLAY ---

  /**
   * Load the user's latest conversation or show the initial state.
   */
  async loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
      console.error('[Chat] loadLatestConversation: chat-message-list not found.');
      return;
    }
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      renderChatError('Authentication error while loading.', chatDisplay); // Use UI helper
      return;
    }
    try {
      const conversations = await fetchConversations(token); // Use API helper
      if (Array.isArray(conversations) && conversations.length > 0) {
        const latestConv = conversations[0];
        console.log('[Chat] Found latest conversation:', latestConv.id);
        // No need to set this.currentConversationId here, loadAndDisplayConversation will do it
        await this.loadAndDisplayConversation(latestConv.id);
      } else {
        console.log('[Chat] No existing conversations found, loading empty state.');
        await this.loadAndDisplayConversation(null); // Load empty/initial state
      }
    } catch (e) {
      console.error('[Chat] Error fetching conversations:', e);
      renderChatError(`Error loading conversations: ${e.message}`, chatDisplay); // Use UI helper
      await this.loadAndDisplayConversation(null); // Fallback to empty state
    }
  },

  /**
   * Load and display a specific conversation by ID, or initial state if ID is null.
   */
  async loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    const modifyContextControls = document.getElementById('chat-context-controls');
    const activeContextDisplay = document.getElementById('active-context-display');

    if (!chatDisplay) {
        console.error('[Chat] loadAndDisplayConversation: chat-message-list not found.');
        return;
    }

    // --- Prepare UI ---
    // Always hide controls and clear context before loading new convo/state
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>'; // Loading indicator

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    // --- Handle Null ID (New/Initial State) ---
    if (!conversationId) {
        console.log('[Chat] loadAndDisplayConversation: No ID, displaying initial prompt.');
        this.currentConversationId = null;
        chatDisplay.innerHTML = ''; // Clear loading message
        removeInitialPrompt(chatDisplay); // Use UI helper
        renderMessage('ai', 'Welcome! Start a New Chat (+) to set up context or select an existing one.', chatDisplay); // Use UI helper
        if (activeContextDisplay) activeContextDisplay.innerHTML = '<span class="text-muted small fst-italic">Start or select a chat</span>';
        scrollToBottom('ai-result-output', false);
        return; // Exit early
    }

    // --- Handle Missing Token ---
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay); // Use UI helper
      if (activeContextDisplay) activeContextDisplay.innerHTML = '<span class="text-muted small fst-italic">Please log in</span>';
      this.currentConversationId = null; // Ensure state is clear
      return; // Exit early
    }

    // --- Fetch and Display Specific Conversation ---
    try {
      console.log(`[Chat] Fetching conversation ID: ${conversationId}`);
      const data = await fetchConversationById(conversationId, token); // Use API helper
      chatDisplay.innerHTML = ''; // Clear loading message
      removeInitialPrompt(chatDisplay); // Use UI helper

      // Check if backend structure is as expected
      const conversation = data?.conversation;
      const messages = data?.messages;
      if (!conversation || !Array.isArray(messages)) {
          console.error('[Chat] Invalid data structure from API for convo:', conversationId, data);
          throw new Error("Received invalid conversation data structure from server.");
      }

      // Render messages
      if (messages.length === 0) {
        renderMessage('ai', 'This conversation is empty. Start typing!', chatDisplay);
      } else {
        messages.forEach((msg, idx) => {
          renderMessage( // Use UI helper
            msg.role === 'user' ? 'user' : 'ai',
            msg.content,
            chatDisplay,
            msg.id || `msg-temp-${idx}`, // Ensure an ID exists for potential deletion
            async (deleteIdx) => { // Pass delete handler callback
              if (confirm('Delete this message and all messages that follow? This cannot be undone.')) {
                  await this.deleteMessageAndAfter(deleteIdx);
              }
            },
            idx // Pass the index for the handler
          );
        });
      }

      // --- Update State and UI on Success ---
      this.currentConversationId = conversationId; // Set the active ID
      console.log('[Chat] Successfully loaded conversation:', conversationId);

      this.updateActiveContextDisplay(conversation.context); // Update context badges

      if (modifyContextControls) modifyContextControls.style.display = 'flex'; // Show context button

    } catch (e) {
      // --- Handle Errors During Fetch/Render ---
      console.error(`[Chat] Error loading conversation ${conversationId}:`, e);
      renderChatError(`Error loading conversation: ${e.message}`, chatDisplay); // Use UI helper
      this.currentConversationId = null; // Clear active ID on error
      // Ensure controls are hidden and context is cleared on error
      if (modifyContextControls) modifyContextControls.style.display = 'none';
      if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    } finally {
      // Ensure scroll happens after render attempt (success or fail)
      setTimeout(() => scrollToBottom('ai-result-output', false), 50);
    }
  },

  // --- CHAT INTERACTION ---

  /**
   * Handle user message submission, call API, display streaming response.
   */
    // --- CHAT INTERACTION ---

  /**
   * Handle user message submission, call API, display streaming response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    const userMessageElement = aiMessageDiv?.previousElementSibling;

    // --- Pre-flight Checks ---
    // (Keep existing pre-flight checks)
    if (!aiMessageDiv || !textareaElement || !generateButton || !loadingIndicator) {
        console.error('[Chat][Submit] Critical UI elements missing.');
        if(textareaElement) textareaElement.disabled = false;
        if(generateButton) generateButton.disabled = false;
        if(loadingIndicator) loadingIndicator.style.display = 'none';
        if(aiMessageDiv) aiMessageDiv.innerHTML = '<span class="text-danger">Internal UI Error. Please refresh.</span>';
        return;
    }
    if (!token) {
      aiMessageDiv.innerHTML = '<span class="text-danger">Error: Authentication token missing.</span>';
      textareaElement.disabled = false;
      generateButton.disabled = false;
      loadingIndicator.style.display = 'none';
      return;
    }

    // --- API Call and Streaming ---
    try {
      const response = await sendChatMessage({
          prompt: userMessage,
          conversationId: this.currentConversationId,
          token
      });

      if (!response.ok) {
          // (Keep existing error handling for non-ok response)
          let errorText = `API Error ${response.status}`;
          try {
              const errorData = await response.json();
              errorText = errorData.detail || errorText;
          } catch (e) { /* Ignore */ }
          console.error('[Chat][Submit] API response error:', response.status, errorText);
          throw new Error(errorText);
      }

      // --- Process Stream ---
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = ''; // Accumulates the final text content
      let streamBuffer = ''; // Buffers chunks to find delimiters
      const markdownDiv = aiMessageDiv.querySelector('.markdown-content');

      if (!markdownDiv) {
          console.error('[Chat][Submit] Markdown display area (.markdown-content) not found.');
          throw new Error('Internal UI Error: Cannot display response.');
      }

      let finalPayload = null;
      const START_DELIMITER = "<!-- FINAL_PAYLOAD:";
      const END_DELIMITER = "-->";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append the decoded chunk to the buffer
        const chunk = decoder.decode(value, { stream: true });
        streamBuffer += chunk;

        // Check if the complete payload delimiter is in the buffer
        const startIndex = streamBuffer.indexOf(START_DELIMITER);
        const endIndex = streamBuffer.indexOf(END_DELIMITER);

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            // Found the payload
            const jsonString = streamBuffer.substring(startIndex + START_DELIMITER.length, endIndex);
            try {
                finalPayload = JSON.parse(jsonString);
                console.log('[Chat] Successfully parsed final payload:', finalPayload);
                // The actual text content is everything BEFORE the start delimiter
                aiResponseContent = streamBuffer.substring(0, startIndex);
                // Render the final text content
                markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
                scrollToBottom('ai-result-output', true);
                // We found the payload, break the loop
                break;
            } catch (e) {
                console.error('[Chat] Error parsing final payload JSON:', e, 'Raw string:', jsonString);
                // Payload format error from backend? Treat remaining buffer as text.
                aiResponseContent = streamBuffer; // Use the whole buffer as text
                markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
                // Continue reading? Or break? Let's break to avoid potential infinite loop on malformed data.
                break;
            }
        } else {
            // Payload not fully received yet, treat the current buffer as text for rendering
            // Note: This renders potentially incomplete text, but updates progressively
            aiResponseContent = streamBuffer; // Update our tracker of text content
            markdownDiv.innerHTML = window.marked ? window.marked.parse(streamBuffer) : escapeHtml(streamBuffer).replace(/\n/g, '<br>');
            scrollToBottom('ai-result-output', true); // Scroll as content streams
        }
      } // End stream reading loop

      // --- Post-Stream Processing ---
      if (finalPayload) {
          // (Keep existing logic for setting IDs and adding delete buttons)
          console.log('[Chat] Processing final payload actions:', finalPayload);
          if (aiMessageDiv) aiMessageDiv.dataset.messageId = finalPayload.aiMessageId;
          if (userMessageElement && userMessageElement.classList.contains('user-message')) {
               userMessageElement.dataset.messageId = finalPayload.userMessageId;
          } else {
               console.warn(`[Chat] Could not reliably find user message element via previousElementSibling to set ID ${finalPayload.userMessageId}. Check DOM structure.`);
          }
          const chatDisplay = document.getElementById('chat-message-list');
          if (chatDisplay) {
               this._addDeleteButtonsToLatestMessages(chatDisplay, finalPayload);
          }
      } else {
          // This log should now only appear if the stream ends *without* the backend sending the delimited payload
          console.warn('[Chat] Stream finished, but no final message ID payload was detected or parsed correctly.');
          // Attempt to add delete buttons anyway (might use temp IDs if real ones aren't set)
           const chatDisplay = document.getElementById('chat-message-list');
           if (chatDisplay) {
               this._addDeleteButtonsToLatestMessages(chatDisplay, null); // Pass null payload
           }
      }

       // Final render pass for safety (unlikely needed if break logic is correct)
       if (markdownDiv && aiResponseContent) { // Render the final accumulated text content
            markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
       }

      await this.fetchAndUpdateCreditsDisplay(); // Update credits display

      // Clear input and reset height on success
      if (textareaElement) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }

    } catch (error) {
      // --- Handle Errors During API/Stream ---
      console.error('[Chat][Submit] Error during API call or streaming:', error);
      if (aiMessageDiv) {
        const errorTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorTarget.innerHTML = `<span class="text-danger">Error: ${escapeHtml(error.message)}</span>`;
      }
    } finally {
      // --- Cleanup ---
      // (Keep existing finally block)
      if (textareaElement) textareaElement.disabled = false;
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      if (textareaElement) setTextareaHeight(textareaElement);
      scrollToBottom('ai-result-output', true);
    }
  },

  /**
   * Delete a message and all subsequent messages by index.
   * @param {number} messageIndex - The 0-based index of the message to delete from.
   */
   async deleteMessageAndAfter(messageIndex) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error('[Chat][Delete] chat-message-list not found.');
        alert("Error: Chat display area not found.");
        return;
    }
    const messages = Array.from(chatDisplay.children);
    if (messageIndex < 0 || messageIndex >= messages.length) {
      console.error('[Chat][Delete] Invalid message index:', messageIndex);
      alert("Error: Cannot delete message at invalid index.");
      return;
    }

    const targetMessageElement = messages[messageIndex];
    const messageIdToDelete = targetMessageElement?.dataset.messageId;

    if (!messageIdToDelete || messageIdToDelete.startsWith('msg-temp-')) {
      alert('Cannot delete message: Missing server ID. Please wait for the message to fully save.');
      console.warn('[Chat][Delete] Missing or temporary message ID on element at index:', messageIndex, targetMessageElement);
      return;
    }

    // Determine prompt for potential regeneration BEFORE API call
    let promptForRegeneration = null;
    if (targetMessageElement.classList.contains('ai-message') && messageIndex > 0) {
        const precedingUserElement = messages[messageIndex - 1];
        if (precedingUserElement?.classList.contains('user-message')) {
            // Extract text content more robustly
            let contentElement = precedingUserElement.querySelector('.markdown-content p') || precedingUserElement.querySelector('.markdown-content') || precedingUserElement;
            promptForRegeneration = contentElement.textContent?.trim() || '';
            console.log('[Chat][Delete] Found preceding user prompt for potential regeneration:', promptForRegeneration);
        }
    }

    const conversationId = this.currentConversationId;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token || !conversationId) {
      alert('Cannot delete message: Missing authentication or conversation context.');
      return;
    }
    console.log(`[Chat][Delete] Attempting delete: Convo ${conversationId}, Msg ${messageIdToDelete} (Index ${messageIndex})`);

    try {
        // --- API Call to Backend ---
        const response = await fetch(`/api/v1/conversations/${conversationId}/messages/${messageIdToDelete}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server failed to delete message(s): ${response.status} ${errorText}`);
        }
        console.log(`[Chat][Delete] API call successful for message ${messageIdToDelete}.`);

        // --- Remove Messages from UI ---
        const messagesToRemove = messages.slice(messageIndex);
        messagesToRemove.forEach(msg => msg.remove());
        console.log(`[Chat][Delete] Removed ${messagesToRemove.length} message elements from UI starting at index ${messageIndex}.`);

        // --- Trigger Regeneration if Applicable ---
        if (promptForRegeneration) {
            console.log('[Chat][Delete] Triggering regeneration for prompt:', promptForRegeneration);
            const textareaElement = document.getElementById('ai-prompt-input');
            const newAiMessageDiv = renderAIPlaceholder(chatDisplay); // Add new placeholder
            const currentGenerateButton = document.getElementById('ai-generate-button');
            const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

            // Disable input while regenerating
            if(textareaElement) textareaElement.disabled = true;
            if(currentGenerateButton) currentGenerateButton.disabled = true;
            if(currentLoadingIndicator) currentLoadingIndicator.style.display = 'inline-block';

            // Call the main submission handler
            await this.handleAPISubmission(promptForRegeneration, newAiMessageDiv, textareaElement);
            console.log('[Chat][Delete] Regeneration submission initiated.');
        } else {
             console.log('[Chat][Delete] No regeneration needed.');
             await this.fetchAndUpdateCreditsDisplay(); // Update credits even if not regenerating
        }

    } catch (error) {
        console.error('[Chat][Delete] Error during message deletion process:', error);
        alert(`Error deleting message: ${error.message}`);
        // Consider how to restore UI state or inform user if deletion fails partially
    }
   },


  // --- UI MANAGEMENT & STATE ---

  /** Fetch and update the user's credits display in the UI. */
  async fetchAndUpdateCreditsDisplay() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return; // Don't try if not logged in

    const navbarCredits = document.getElementById('navbar-user-credits'); // Target specific element
    if (!navbarCredits) return; // Don't proceed if element doesn't exist

    try {
      const resp = await fetch('/api/v1/user/me', { // Use the correct endpoint
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        const credits = (data.credits !== null && data.credits !== undefined) ? data.credits : '-';
        navbarCredits.textContent = `Credits: ${credits}`; // Update UI
        // Update global state if it exists
        if (window.currentUserInfo?.dbUserData) {
             window.currentUserInfo.dbUserData.credits = data.credits;
        }
      } else {
          console.warn('[Chat] Failed to fetch updated credits, status:', resp.status);
          navbarCredits.textContent = 'Credits: Error'; // Indicate error in UI
      }
    } catch (e) {
      console.error('[Chat] Network error fetching updated credits:', e);
      navbarCredits.textContent = 'Credits: Error'; // Indicate error in UI
    }
  },

  /** Toggles fullscreen mode and updates UI elements accordingly. */
  _performFullscreenToggle() {
    if (!allowClassToggle) {
      console.warn("[Chat Toggle] Debounced toggle call.");
      return; // Debounce
    }
    allowClassToggle = false; // Block subsequent calls

    // Toggle internal state FIRST
    this.isFullscreenActive = !this.isFullscreenActive;
    console.log(`[Chat Toggle] Setting internal fullscreen state to: ${this.isFullscreenActive}`);

    this._syncUIWithState(); // Apply changes based on the new state

    // Adjust layout slightly after state change and re-enable toggle
    setTimeout(() => {
      const promptInput = document.getElementById('ai-prompt-input');
      if (promptInput) setTextareaHeight(promptInput, true);
      // Scroll to bottom only when entering fullscreen
      if (this.isFullscreenActive) scrollToBottom('ai-result-output', false);

      allowClassToggle = true; // Re-allow toggling
      console.log("[Chat Toggle] Re-enabled toggling.");
    }, 150);
  },

  /** Syncs UI elements (body class, buttons, sidebar) with the current internal fullscreen state. */
  _syncUIWithState() {
    const isFullscreen = this.isFullscreenActive;
    console.log('[Chat Sync] Syncing UI with internal fullscreen state:', isFullscreen);
    const body = document.body;
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
    const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

    // --- Apply state to elements ---
    body.classList.toggle('chat-fullscreen-active', isFullscreen);

    if (sidebar) {
      sidebar.classList.toggle('d-none', !isFullscreen);
      // Render sidebar content only when making it visible
      if (isFullscreen && !sidebar.classList.contains('d-none')) {
          this.renderSidebarConversations();
      }
    }
    if (normalZoomBtn) normalZoomBtn.classList.toggle('d-none', isFullscreen);
    if (fullscreenZoomBtn) fullscreenZoomBtn.classList.toggle('d-none', !isFullscreen);

    console.log(`[Chat Sync] After sync: Normal visible? ${!normalZoomBtn?.classList.contains('d-none')}, Fullscreen visible? ${!fullscreenZoomBtn?.classList.contains('d-none')}`);
  },

  // --- SIDEBAR & CONVERSATION MANAGEMENT (Called by Fullscreen Toggle/Context Save) ---

  /** Render the conversation list in the fullscreen sidebar. */
  async renderSidebarConversations() {
    const list = document.getElementById('conversation-list');
    const newBtn = document.getElementById('new-conversation-btn'); // Assumes ID exists in sidebar HTML

    if (!list) {
      console.warn('[Chat Sidebar] conversation-list element not found.');
      return;
    }
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    // Handle logged-out state
    if (!token) {
      list.innerHTML = '<li><span class="text-muted small">Please log in</span></li>';
      if (newBtn) newBtn.disabled = true;
      return;
    }

    if (newBtn) newBtn.disabled = false; // Enable if logged in
    list.innerHTML = '<li><span class="text-muted small">Loading...</span></li>'; // Loading state

    try {
      const conversations = await fetchConversations(token); // Use API helper
      list.innerHTML = ''; // Clear loading/previous list

      if (!Array.isArray(conversations) || conversations.length === 0) {
        list.innerHTML = '<li><span class="text-muted small">No conversations yet</span></li>';
      } else {
        conversations.forEach(conv => {
          const li = document.createElement('li');
          li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center'; // Use Bootstrap classes
          li.dataset.conversationId = conv.id;
          li.style.cursor = 'pointer';

          const titleSpan = document.createElement('span');
          titleSpan.textContent = conv.title || 'Untitled Conversation';
          titleSpan.title = conv.title || 'Untitled Conversation';
          titleSpan.className = 'conversation-title text-truncate me-2'; // Allow truncation
          li.appendChild(titleSpan);

          // Activate current conversation
          if (conv.id === this.currentConversationId) {
            li.classList.add('active');
          }

          // --- Action Buttons ---
          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'conversation-actions btn-group btn-group-sm flex-shrink-0'; // Use Bootstrap button group
          actionsDiv.role = "group";

          // Rename Button
          const renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.className = 'btn btn-outline-secondary conversation-rename-btn border-0 px-1 py-0'; // Subtle style
          renameBtn.title = 'Rename Conversation';
          renameBtn.innerHTML = '<i class="bi bi-pencil small"></i>';
          renameBtn.addEventListener('click', (e) => {
              e.stopPropagation(); // Prevent li click
              this.showRenameDialog(conv); // Assume this method exists
          });
          actionsDiv.appendChild(renameBtn);

          // Delete Button
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'btn btn-outline-danger conversation-delete-btn border-0 px-1 py-0'; // Subtle style
          deleteBtn.title = 'Delete Conversation';
          deleteBtn.innerHTML = '<i class="bi bi-trash small"></i>';
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); // Prevent li click
            if (confirm(`Are you sure you want to delete "${conv.title || 'Untitled Conversation'}"?`)) {
              try {
                 await this.deleteConversation(conv.id); // Assume this method exists
                 await this.renderSidebarConversations(); // Refresh list
                 // If deleted convo was active, load latest/default
                 if (conv.id === this.currentConversationId) {
                     await this.loadLatestConversation();
                 }
              } catch (deleteError) { console.error("Error deleting conversation:", deleteError); alert("Failed to delete conversation."); }
            }
          });
          actionsDiv.appendChild(deleteBtn);
          li.appendChild(actionsDiv);
          // --- End Action Buttons ---

          // Click listener for the whole list item
          li.addEventListener('click', async () => {
            if (conv.id !== this.currentConversationId) {
              console.log(`[Chat Sidebar] Switching to conversation ${conv.id}`);
              await this.loadAndDisplayConversation(conv.id);
              // Update active state in sidebar after load finishes
              list.querySelectorAll('li.active').forEach(item => item.classList.remove('active'));
              li.classList.add('active');
            }
          });
          list.appendChild(li);
        });
      }

      // Setup 'New Conversation' button listener if not already done
      // NOTE: This button now triggers the context setup modal via HTMX usually
      if (newBtn && !newBtn.dataset.listenerAttached) {
           newBtn.dataset.listenerAttached = 'true';
           newBtn.addEventListener('click', (e) => {
               e.preventDefault();
               console.log('[Chat Sidebar] "New Conversation" button clicked - should trigger context modal.');
               // The actual modal trigger is likely via data-bs-toggle or hx-get on the button itself.
               // If you need to *programmatically* trigger the NEW context setup:
               // this.startNewChatContextSetup();
           });
      }

    } catch (e) {
      console.error('[Chat Sidebar] Error loading conversations:', e);
      list.innerHTML = '<li><span class="text-danger small">Error loading list</span></li>';
      if (newBtn) newBtn.disabled = true;
    }
  },

  /** Show rename prompt and call API */
  async showRenameDialog(conv) {
    const currentTitle = conv.title || 'Untitled Conversation';
    const newTitle = prompt('Enter new name for conversation:', currentTitle);
    if (newTitle && newTitle.trim() && newTitle.trim() !== currentTitle) {
       try {
            await this.renameConversation(conv.id, newTitle.trim()); // Assume this method exists
            await this.renderSidebarConversations(); // Refresh list
            // Also update the title in the main chat view if it's the current one
            if (conv.id === this.currentConversationId) {
                // Potentially update a title element in the main chat area if one exists
            }
       } catch (renameError) { console.error("Error renaming conversation:", renameError); alert("Failed to rename conversation."); }
    }
  },

  /** Call API to rename a conversation */
  async renameConversation(conversationId, newTitle) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) throw new Error("Authentication required.");
    console.log(`[Chat API] Renaming conversation ${conversationId} to "${newTitle}"`);
    const response = await fetch(`/api/v1/conversations/${conversationId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
     if (!response.ok) {
         const errorData = await response.text();
         throw new Error(`Failed to rename conversation: ${response.status} ${errorData}`);
     }
      console.log(`[Chat API] Rename successful for ${conversationId}.`);
      // No return needed, success is indicated by lack of error
  },

  /** Call API to delete a conversation */
  async deleteConversation(conversationId) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) throw new Error("Authentication required.");
    console.log(`[Chat API] Deleting conversation ${conversationId}`);
    const response = await fetch(`/api/v1/conversations/${conversationId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
     if (!response.ok) {
         const errorData = await response.text();
         throw new Error(`Failed to delete conversation: ${response.status} ${errorData}`);
     }
     console.log(`[Chat API] Delete successful for ${conversationId}.`);
     // No return needed, success is indicated by lack of error (204 status)
  },


  // --- CONTEXT MODAL & HTMX INTEGRATION ---

  /** Initiates the setup process for a NEW chat context via modal. */
  async startNewChatContextSetup() {
    console.log('[Chat Context] Starting NEW context setup.');
    this.currentConversationId = null; // Explicitly clear current convo ID

    const chatDisplay = document.getElementById('chat-message-list');
    const modifyContextControls = document.getElementById('chat-context-controls');
    const activeContextDisplay = document.getElementById('active-context-display');
    const modalContentArea = document.getElementById('modal-content-area');
    const modalElement = document.getElementById('contextModal');
    const sidebarList = document.getElementById('conversation-list');

    // --- Reset Main Chat UI ---
    if (chatDisplay) chatDisplay.innerHTML = '<p class="text-muted small text-center">Setting up new adventure context...</p>';
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    if (sidebarList) { // Deactivate sidebar item if one was active
      sidebarList.querySelectorAll('li.active').forEach(li => li.classList.remove('active'));
    }
    // --- End Reset Main Chat UI ---

    if (!modalContentArea || !modalElement) {
        console.error('[Chat Context] Modal elements not found (#modal-content-area, #contextModal)');
        alert('Error: Cannot open context setup modal.');
        return;
    }

    // Show loading state inside modal
    modalContentArea.innerHTML = `<div class="text-center p-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted small">Loading Setup...</p></div>`;

    // Get/cache Bootstrap modal instance
    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    // Show the modal programmatically (if not already shown by data-bs-toggle)
    this.contextModalInstance.show();

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required.</div>`;
        return; // Keep modal open showing error
    }

    // --- Trigger HTMX Load ---
    try {
        if (window.htmx) {
             console.log('[Chat Context] Triggering HTMX GET for /api/v1/chat/setup/start');
             htmx.ajax('GET', '/api/v1/chat/setup/start', {
                 target: '#modal-content-area', // Target the content area
                 swap: 'innerHTML',             // Replace its content
                 headers: { 'Authorization': `Bearer ${token}` }
             });
        } else {
            throw new Error("HTMX library not found.");
        }
    } catch (error) {
        console.error('[Chat Context] Error triggering HTMX load:', error);
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Failed to load setup form. ${error.message}</div>`;
    }
  },

  /** Initiates editing for the CURRENT chat context via modal. */
  async editCurrentChatContext() {
    console.log('[Chat Context] Starting EDIT context for conversation:', this.currentConversationId);
    if (!this.currentConversationId) {
        alert('No active chat selected to edit context for.');
        return;
    }

    const modalContentArea = document.getElementById('modal-content-area');
    const modalElement = document.getElementById('contextModal');

    if (!modalContentArea || !modalElement) {
        alert('Error: Cannot open context setup modal.');
        return;
    }

    // Show loading state
    modalContentArea.innerHTML = `<div class="text-center p-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted small">Loading Existing Context...</p></div>`;

    // Get/cache modal instance
    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    this.contextModalInstance.show(); // Show modal

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required.</div>`;
        return;
    }

    // --- Trigger HTMX Load ---
    try {
         if (window.htmx) {
             console.log(`[Chat Context] Triggering HTMX GET for /api/v1/chat/setup/edit/${this.currentConversationId}`);
             htmx.ajax('GET', `/api/v1/chat/setup/edit/${this.currentConversationId}`, {
                 target: '#modal-content-area',
                 swap: 'innerHTML',
                 headers: { 'Authorization': `Bearer ${token}` }
             });
         } else {
            throw new Error("HTMX library not found.");
         }
    } catch (error) {
        console.error('[Chat Context] Error triggering HTMX load for edit:', error);
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Failed to load context for editing. ${error.message}</div>`;
    }
  },

  /** Updates the context display area (below input) with badges. */
   updateActiveContextDisplay(contextData) {
       const displayArea = document.getElementById('active-context-display');
       if (!displayArea) return; // Element not found
       // console.log("[Chat Context] Updating context display with:", contextData); // Verbose

       displayArea.innerHTML = ''; // Clear previous content

       // Handle null/empty context
       if (!contextData || Object.keys(contextData).length === 0) {
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Default Context</span>';
           return;
       }

       const badges = [];
       // Define how to display each context key
       const displayMap = {
           goal: { label: "Goal", icon: "bi-bullseye" },
           genre_tone: { label: "Genre/Tone", icon: "bi-masks" },
           game_system: { label: "System", icon: "bi-controller" }, // Changed icon
           key_details: { label: "Details", icon: "bi-info-circle-fill", truncate: 30 } // Changed icon & truncate
       };

       // Generate badges based on available data and map
       for (const key in displayMap) {
           if (contextData[key]) {
               let value = contextData[key];
               const config = displayMap[key];

               // Basic formatting (e.g., replace underscores, capitalize)
               if (key === 'goal') value = value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

               // Handle potential truncation
               const needsTruncation = config.truncate && value.length > config.truncate;
               const displayValue = needsTruncation ? value.substring(0, config.truncate - 3) + "..." : value;
               const titleAttr = needsTruncation ? `title="${escapeHtml(value)}"` : ''; // Add full text as title

               badges.push(
                   `<span class="badge lh-base text-bg-light border me-1 mb-1" ${titleAttr}>` + // Use lighter bg/border
                   `<i class="bi ${config.icon} me-1"></i>${escapeHtml(displayValue)}` +
                   `</span>`
               );
           }
       }

       // Display badges or a default message
       if (badges.length > 0) {
           displayArea.innerHTML = badges.join('');
       } else {
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Context Set (No Preview)</span>';
       }
   },

   /** Handles the response after HTMX saves context (via HX-Trigger header). */
   _handleHtmxSaveResponse(event) {
        const xhr = event.detail.xhr;
        // Check if the response is from the expected save endpoint
        if (!xhr || !xhr.responseURL || !xhr.responseURL.includes('/api/v1/chat/setup/save')) {
            return; // Not the response we're interested in
        }

        console.log('[Chat HTMX] Detected response from /save endpoint.');
        const triggerHeader = xhr.getResponseHeader('HX-Trigger');

        if (!triggerHeader) {
            console.warn('[Chat HTMX] Response from /save but no HX-Trigger header found. Closing modal.');
             if (this.contextModalInstance) this.contextModalInstance.hide();
            return;
        }

        console.log('[Chat HTMX] Found HX-Trigger header:', triggerHeader);
        try {
            const triggers = JSON.parse(triggerHeader);

            // --- Handle New Chat Creation ---
            if (triggers.newChatCreated) {
                console.log('[Chat HTMX] Handling newChatCreated:', triggers.newChatCreated);
                const { id, title, context } = triggers.newChatCreated;

                if (this.contextModalInstance) this.contextModalInstance.hide(); // Hide modal first

                this.currentConversationId = id; // Set new convo as active
                this.renderSidebarConversations(); // Refresh sidebar (will mark new one active)

                // Update main chat UI
                const chatDisplay = document.getElementById('chat-message-list');
                if(chatDisplay) chatDisplay.innerHTML = ''; // Clear "Setting up..."
                renderMessage('ai', `Context set for "${escapeHtml(title)}". What's your first prompt?`, chatDisplay);
                this.updateActiveContextDisplay(context); // Show context badges
                const modifyBtn = document.getElementById('chat-context-controls');
                if(modifyBtn) modifyBtn.style.display = 'flex'; // Show modify button
                scrollToBottom('ai-result-output', false);
                document.getElementById('ai-prompt-input')?.focus(); // Focus input

            // --- Handle Existing Chat Context Update ---
            } else if (triggers.chatContextUpdated) {
                console.log('[Chat HTMX] Handling chatContextUpdated:', triggers.chatContextUpdated);
                const { id, context } = triggers.chatContextUpdated;

                if (this.contextModalInstance) this.contextModalInstance.hide(); // Hide modal

                // Only update UI if the updated context belongs to the currently viewed chat
                if (id === this.currentConversationId) {
                    this.updateActiveContextDisplay(context);
                    console.log(`[Chat Context] Display updated for conversation ${id}`);
                    // Optional: Show a success message/toast
                } else {
                     console.log(`[Chat Context] Context updated for ${id}, but not the current view (${this.currentConversationId}).`);
                     // Refresh sidebar in case title/metadata changed implicitly? Unlikely based on trigger.
                     this.renderSidebarConversations();
                }
            } else {
                console.warn('[Chat HTMX] Unknown trigger in HX-Trigger header:', triggers);
                 if (this.contextModalInstance) this.contextModalInstance.hide(); // Hide modal as fallback
            }
        } catch (e) {
            console.error('[Chat HTMX] Error parsing HX-Trigger JSON:', e, triggerHeader);
            alert("Error processing context save response. Please check console.");
            // Hide modal even on parse error
            if (this.contextModalInstance) this.contextModalInstance.hide();
        }
   },


  // --- EVENT LISTENERS SETUP ---

  /**
   * Set up all event listeners for chat UI elements. Called once on DOM ready.
   * Uses arrow functions for listeners calling internal methods to preserve 'this'.
   */
  setupEventListeners() {
    console.log("[Chat Events] Setting up chat event listeners.");
    const chatForm = document.getElementById('ai-generation-form');
    const promptInput = document.getElementById('ai-prompt-input');
    const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
    const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);
    // Context buttons - Note: New Chat button might be handled by HTMX directly
    const modifyContextButton = document.getElementById('modify-context-button');
    const newContextButton = document.getElementById('new-conversation-btn'); // If triggering programmatically

    // --- Prompt Input ---
    if (promptInput) {
      promptInput.addEventListener('input', () => setTextareaHeight(promptInput, true));
      promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
      promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          chatForm?.requestSubmit(); // Submit form on Enter (if form exists)
        }
      });
      setTextareaHeight(promptInput); // Initial check
    } else { console.warn("[Chat Events] Prompt input #ai-prompt-input not found."); }

    // --- Zoom Buttons ---
    if (normalZoomBtn) {
         normalZoomBtn.addEventListener('click', () => this._performFullscreenToggle());
    } else { console.warn(`[Chat Events] Normal zoom button #${CHAT_ZOOM_TOGGLE_NORMAL_ID} not found.`); }

    if (fullscreenZoomBtn) {
         fullscreenZoomBtn.addEventListener('click', () => this._performFullscreenToggle());
    } else { console.warn(`[Chat Events] Fullscreen zoom button #${CHAT_ZOOM_TOGGLE_FULLSCREEN_ID} not found.`); }

    // --- Chat Form Submit ---
    if (chatForm) {
      chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPromptInput = document.getElementById('ai-prompt-input'); // Re-fetch elements inside handler
        const chatDisplay = document.getElementById('chat-message-list');
        const currentGenerateButton = document.getElementById('ai-generate-button');
        const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

        if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
          console.error("[Chat Events] Form submit: Missing required elements."); return;
        }
        const userMessage = currentPromptInput.value.trim();
        if (!userMessage) return; // Ignore empty submission

        // --- Disable UI ---
        currentPromptInput.disabled = true;
        currentGenerateButton.disabled = true;
        currentLoadingIndicator.style.display = 'inline-block';

        // --- Render User Message ---
        removeInitialPrompt(chatDisplay);
        renderMessage('user', userMessage, chatDisplay, null, // Pass null ID initially
             async (deleteIdx) => { await this.deleteMessageAndAfter(deleteIdx); } // Delete handler
        );
        const aiDiv = renderAIPlaceholder(chatDisplay); // Render AI placeholder
        scrollToBottom('ai-result-output', false); // Scroll user message into view

        // --- Call API Handler ---
        // Pass elements needed by the handler
        await this.handleAPISubmission(userMessage, aiDiv, currentPromptInput);

        // Note: handleAPISubmission re-enables UI in its finally block
      });
    } else { console.warn("[Chat Events] Chat form #ai-generation-form not found."); }

    // --- Context Modal Buttons ---
    // Modify button (in main chat view) should trigger edit modal
    if (modifyContextButton) {
        modifyContextButton.addEventListener('click', (e) => {
            e.preventDefault();
            this.editCurrentChatContext();
            
            console.log("[Chat Events] Modify context modal loaded.");
        });
    } else { console.warn("[Chat Events] Modify context button #modify-context-button not found."); }



    // --- HTMX Response Listener ---
    // Listen on the body for events bubbling up after HTMX swaps content
    console.log("[Chat Events] Setting up HTMX afterOnLoad listener on body.");
    document.body.addEventListener('htmx:afterOnLoad', (event) => {
        // Delegate handling to a dedicated method
        this._handleHtmxSaveResponse(event);
    });

    console.log("[Chat Events] All chat event listeners setup completed.");
  }, // End setupEventListeners


  // --- HELPER METHODS ---

  /**
   * Helper to add delete buttons to the last two messages (user, ai)
   * after a successful AI response, using IDs from payload if available.
   */
  _addDeleteButtonsToLatestMessages(chatDisplay, payload) {
      if (!chatDisplay) return;
      const messages = chatDisplay.children;
      const lastIndex = messages.length - 1;

      // AI message (last element)
      if (lastIndex >= 0) {
          const aiMsgDiv = messages[lastIndex];
          if (aiMsgDiv.classList.contains('ai-message')) {
              // Use payload ID if available, otherwise element might already have one
              const aiId = payload?.aiMessageId || aiMsgDiv.dataset.messageId;
              if (aiId) aiMsgDiv.dataset.messageId = aiId; // Ensure ID is set
              this.addDeleteButtonAndListener(aiMsgDiv, lastIndex);
          }
      }
      // User message (second to last element)
      if (lastIndex >= 1) {
          const userMsgDiv = messages[lastIndex - 1];
          if (userMsgDiv.classList.contains('user-message')) {
              const userId = payload?.userMessageId || userMsgDiv.dataset.messageId;
               if (userId) userMsgDiv.dataset.messageId = userId; // Ensure ID is set
              this.addDeleteButtonAndListener(userMsgDiv, lastIndex - 1);
          }
      }
  },

  /**
   * Helper function to add a delete button and its listener to a message element.
   * Ensures button isn't added twice and uses correct 'this' context.
   * @param {HTMLElement} messageDiv The message div element.
   * @param {number} index The index of this message in the chat list.
   */
   addDeleteButtonAndListener(messageDiv, index) {
    if (!messageDiv || messageDiv.querySelector('.message-delete-btn')) {
      return; // Skip if no div or button already exists
    }
    if (typeof this.deleteMessageAndAfter !== 'function') {
      console.error("[Chat][addDeleteButton] deleteMessageAndAfter method missing.");
      return;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn text-muted'; // Subtle styling
    deleteBtn.title = 'Delete message and following';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.type = 'button';
    deleteBtn.style.opacity = '0.6'; // Make it less prominent initially
    deleteBtn.style.fontSize = '0.8em'; // Smaller icon

    // Hover effect for visibility
    messageDiv.addEventListener('mouseenter', () => deleteBtn.style.opacity = '1');
    messageDiv.addEventListener('mouseleave', () => deleteBtn.style.opacity = '0.6');

    // Use arrow function for listener to keep 'this' as ChatManager
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent message selection/focus
      // Confirmation is now inside the deleteMessageAndAfter call in renderMessage/handleAPISubmission
      // This listener just calls the main delete logic.
      this.deleteMessageAndAfter(index).catch(error => {
           console.error(`[Chat][Delete] Error during delete execution for index ${index}:`, error);
           alert("An error occurred trying to delete messages.");
      });
    });

    // Append to a consistent place within the message div, e.g., a header or actions container if one exists
    // For now, appending directly to the message div
    messageDiv.appendChild(deleteBtn);
  },

}; // ================= End ChatManager Object =================


// --- Global Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  console.log("[Chat Main] DOMContentLoaded - Initializing Chat System Setup");

  // Hide context controls initially until a conversation is loaded
  const modifyContextControls = document.getElementById('chat-context-controls');
  if (modifyContextControls) {
      modifyContextControls.style.display = 'none';
  }

  // Expose ChatManager globally for auth.js and potentially debugging
  // This MUST happen before setupEventListeners is called if listeners rely on the global object
  window.ChatManager = ChatManager;
  console.log("[Chat Main] ChatManager exposed on window.");

  document.body.addEventListener('htmx:configRequest', function(evt) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    const requestPath = evt.detail.path; // Get the path being requested

    // Only add auth header if token exists AND path starts with /api/v1/ (or your API prefix)
    // Avoid adding it to external requests or static file requests if HTMX was used for them.
    if (token && requestPath.startsWith('/api/v1/')) {
        evt.detail.headers['Authorization'] = `Bearer ${token}`;
        console.log(`[HTMX Config] Added Auth header to: ${requestPath}`); // More specific log
    } else if (!token && requestPath.startsWith('/api/v1/')) {
         console.warn(`[HTMX Config] No token found for API request: ${requestPath}`);
    }
    // No else needed for non-API paths
});
console.log("[Chat Main] HTMX configRequest listener setup.");

  // Provide the specific initialization function expected by auth.js
  window.initializeChat = () => {
      try {
          console.log("[Chat Main] Global initializeChat() called.");
          ChatManager.initializeChat(); // Call the method on the object
      } catch (e) {
          console.error("[Chat Main] Error executing initializeChat via global function:", e);
          // Display error to user?
          const chatDisplay = document.getElementById('chat-message-list');
          if(chatDisplay) renderChatError("Failed to initialize chat system. Please refresh.", chatDisplay);
      }
  };
   window.teardownChat = () => {
      try {
          console.log("[Chat Main] Global teardownChat() called.");
          ChatManager.teardownChat(); // Call the method on the object
      } catch (e) {
          console.error("[Chat Main] Error executing teardownChat via global function:", e);
      }
  };
  console.log("[Chat Main] Global initializeChat() and teardownChat() functions defined.");


  // Setup ChatManager's internal event listeners now that the DOM is ready and ChatManager exists
  try {
      ChatManager.setupEventListeners();
      console.log("[Chat Main] ChatManager event listeners setup successfully.");
  } catch (e) {
       console.error("[Chat Main] Error calling ChatManager.setupEventListeners:", e);
  }

  // Note: The actual chat initialization (loading data etc.) is deferred
  // It will be triggered by auth.js calling window.initializeChat() when ready.
  console.log("[Chat Main] DOM Ready setup complete. Waiting for auth module to initialize chat.");
});

// Remove standalone call: ChatManager.setupEventListeners(); // This was incorrect
// Remove commented export: // export default ChatManager;