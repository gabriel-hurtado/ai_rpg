// static/chat.js

// --- Imports ---
// Assuming chatUtils.js, chatUI.js, chatApi.js provide these functions
import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';
import { showConfirmationModal } from './ui.js';

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
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    if (!conversationId) {
        console.log('[Chat] loadAndDisplayConversation: No ID, displaying initial prompt.');
        this.currentConversationId = null;
        chatDisplay.innerHTML = '';
        removeInitialPrompt(chatDisplay);
        renderMessage('ai', 'Welcome! Start a New Chat (+) to set up context or select an existing one.', chatDisplay);
        if (activeContextDisplay) activeContextDisplay.innerHTML = '<span class="text-muted small fst-italic">Start or select a chat</span>';
        scrollToBottom('ai-result-output', false);
        return;
    }

    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      if (activeContextDisplay) activeContextDisplay.innerHTML = '<span class="text-muted small fst-italic">Please log in</span>';
      this.currentConversationId = null;
      return;
    }

    try {
      console.log(`[Chat] Fetching conversation ID: ${conversationId}`);
      const data = await fetchConversationById(conversationId, token);
      chatDisplay.innerHTML = '';
      removeInitialPrompt(chatDisplay);

      const conversation = data?.conversation;
      const messages = data?.messages;
      if (!conversation || !Array.isArray(messages)) {
          console.error('[Chat] Invalid data structure from API for convo:', conversationId, data);
          throw new Error("Received invalid conversation data structure from server.");
      }

      if (messages.length === 0) {
        renderMessage('ai', 'This conversation is empty. Start typing!', chatDisplay);
      } else {
        messages.forEach((msg, idx) => {
          // The delete callback for messages loaded from history
          const deleteCallback = async (deleteIdxFromUI) => {
            try {
              // It's good practice to log the index received from UI vs expected
              console.log(`[Chat][Delete CB Load] Invoked for historical message. Index from UI: ${deleteIdxFromUI}, Original index: ${idx}`);
              await this.deleteMessageAndAfter(deleteIdxFromUI); // Use the index from UI callback
            } catch (e) {
              console.error(`[Chat][Delete CB Load] Error in delete callback for historical msg index ${idx}:`, e);
              alert("An error occurred while trying to delete the message.");
            }
          };
          renderMessage(
            msg.role === 'user' ? 'user' : 'ai',
            msg.content,
            chatDisplay,
            msg.id || `msg-temp-${idx}`,
            deleteCallback, // Pass the enhanced callback
            idx // Pass the original index for chatUI to use
          );
        });
      }

      this.currentConversationId = conversationId;
      console.log('[Chat] Successfully loaded conversation:', conversationId);
      this.updateActiveContextDisplay(conversation.context);
      if (modifyContextControls) modifyContextControls.style.display = 'flex';

    } catch (e) {
      console.error(`[Chat] Error loading conversation ${conversationId}:`, e);
      renderChatError(`Error loading conversation: ${e.message}`, chatDisplay);
      this.currentConversationId = null;
      if (modifyContextControls) modifyContextControls.style.display = 'none';
      if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    } finally {
      setTimeout(() => scrollToBottom('ai-result-output', false), 50);
    }
  },

  // --- CHAT INTERACTION ---

  /**
   * Handle user message submission, call API, display streaming response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    const userMessageElement = aiMessageDiv?.previousElementSibling;

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

    try {
      const response = await sendChatMessage({
          prompt: userMessage,
          conversationId: this.currentConversationId,
          token
      });

      if (!response.ok) {
          let errorText = `API Error ${response.status}`;
          try {
              const errorData = await response.json();
              errorText = errorData.detail || errorText;
          } catch (e) { /* Ignore */ }
          console.error('[Chat][Submit] API response error:', response.status, errorText);
          throw new Error(errorText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = '';
      let streamBuffer = '';
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

        const chunk = decoder.decode(value, { stream: true });
        streamBuffer += chunk;

        const startIndex = streamBuffer.indexOf(START_DELIMITER);
        const endIndex = streamBuffer.indexOf(END_DELIMITER);

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            const jsonString = streamBuffer.substring(startIndex + START_DELIMITER.length, endIndex);
            try {
                finalPayload = JSON.parse(jsonString);
                console.log('[Chat] Successfully parsed final payload:', finalPayload);
                aiResponseContent = streamBuffer.substring(0, startIndex);
                markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
                scrollToBottom('ai-result-output', true);
                break;
            } catch (e) {
                console.error('[Chat] Error parsing final payload JSON:', e, 'Raw string:', jsonString);
                aiResponseContent = streamBuffer;
                markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
                break;
            }
        } else {
            aiResponseContent = streamBuffer;
            markdownDiv.innerHTML = window.marked ? window.marked.parse(streamBuffer) : escapeHtml(streamBuffer).replace(/\n/g, '<br>');
            scrollToBottom('ai-result-output', true);
        }
      }

      if (finalPayload) {
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
          console.warn('[Chat] Stream finished, but no final message ID payload was detected or parsed correctly.');
           const chatDisplay = document.getElementById('chat-message-list');
           if (chatDisplay) {
               this._addDeleteButtonsToLatestMessages(chatDisplay, null);
           }
      }

       if (markdownDiv && aiResponseContent) {
            markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
       }

      await this.fetchAndUpdateCreditsDisplay();

      if (textareaElement) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }

    } catch (error) {
      console.error('[Chat][Submit] Error during API call or streaming:', error);
      if (aiMessageDiv) {
        const errorTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorTarget.innerHTML = `<span class="text-danger">Error: ${escapeHtml(error.message)}</span>`;
      }
    } finally {
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

    // Use a distinct variable name for the snapshot of messages
    const currentMessages = Array.from(chatDisplay.children);

    // --- Enhanced Logging & Initial Validation ---
    console.log(`[Chat][Delete] Attempting delete for messageIndex: ${messageIndex}. Current messages count: ${currentMessages.length}`);
    if (messageIndex < 0 || messageIndex >= currentMessages.length) {
      console.error(`[Chat][Delete] Invalid messageIndex: ${messageIndex} for currentMessages.length: ${currentMessages.length}.`);
      // Log available messages for debugging if helpful
      // currentMessages.forEach((el, i) => console.log(`[Chat][Delete] Message[${i}]: ${el.outerHTML.substring(0, 70)}...`));
      alert("Error: Cannot delete message, index is out of bounds.");
      return;
    }
    console.log(`[Chat][Delete] messageIndex ${messageIndex} is within bounds [0, ${currentMessages.length - 1}]`);

    const targetMessageElement = currentMessages[messageIndex];

    // --- CRITICAL GUARD ---
    if (!targetMessageElement) {
        console.error(`[Chat][Delete] CRITICAL: targetMessageElement is UNDEFINED for valid index ${messageIndex}.`);
        console.error('[Chat][Delete] Current messages snapshot:', currentMessages.map(el => el.outerHTML ? el.outerHTML.substring(0,70) : String(el) ));
        alert("Internal error: Could not find the message element to delete. Please refresh and try again.");
        return;
    }
    console.log(`[Chat][Delete] targetMessageElement successfully retrieved for index ${messageIndex}.`);
    // Now we are sure targetMessageElement is an HTMLElement.

    const messageIdToDelete = targetMessageElement.dataset.messageId;

    // --- BRANCH 1: Handle messages with missing or temporary IDs ---
    if (!messageIdToDelete || messageIdToDelete.startsWith('msg-temp-')) {
      console.log(`[Chat][Delete] Branch 1: Handling message with temp/missing ID at index ${messageIndex}. ID: ${messageIdToDelete}`);
      // Check if it's an AI message and has a preceding user message, eligible for regeneration prompt
      if (targetMessageElement.classList.contains('ai-message') && messageIndex > 0) {
        const precedingUserElement = currentMessages[messageIndex - 1]; // Use currentMessages
        if (precedingUserElement?.classList.contains('user-message')) {
          let contentElement = precedingUserElement.querySelector('.markdown-content p') ||
                               precedingUserElement.querySelector('.markdown-content') ||
                               precedingUserElement;
          const userPromptText = contentElement.textContent?.trim() || '';

          if (userPromptText) {
            const confirmedRegeneration = await showConfirmationModal(
                'This AI message appears unsaved or has a temporary ID. Would you like to remove it and try regenerating the response from the previous user prompt?',
                'Regenerate', // Confirm button text
                'Cancel',     // Cancel button text
                'Unsaved AI Message <i class="bi bi-lightbulb-fill ms-1 text-info"></i>', // Modal Title
                'primary'     // Confirm button type (e.g., 'primary' or 'info')
            );

            if (confirmedRegeneration) {
                console.log('[Chat][Delete/Regen] User opted to regenerate unsaved AI message. Prompt:', userPromptText);

                const messagesToRemoveFromUI = currentMessages.slice(messageIndex);
                messagesToRemoveFromUI.forEach(msg => msg.remove());
                console.log(`[Chat][Delete/Regen] Removed ${messagesToRemoveFromUI.length} message elements from UI starting at index ${messageIndex}.`);

                const textareaElement = document.getElementById('ai-prompt-input');
                const currentChatDisplay = document.getElementById('chat-message-list');
                const newAiMessageDiv = renderAIPlaceholder(currentChatDisplay);

                const currentGenerateButton = document.getElementById('ai-generate-button');
                const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

                if(textareaElement) textareaElement.disabled = true;
                if(currentGenerateButton) currentGenerateButton.disabled = true;
                if(currentLoadingIndicator) currentLoadingIndicator.style.display = 'inline-block';

                await this.handleAPISubmission(userPromptText, newAiMessageDiv, textareaElement);
                console.log('[Chat][Delete/Regen] Regeneration submission for unsaved AI message initiated.');
                return; // Exit after attempting regeneration
            } else {
                console.log('[Chat][Delete/Regen] User cancelled regeneration for unsaved AI message.');
                // No further action needed if cancelled here, the original "Cannot delete" will show below if applicable
            }
          }
          // END OF MODIFIED PART
        }
      }

      // If not an AI message eligible for regeneration, or user declined the regen prompt,
      // or userPromptText was empty, show original error.
      // You might also want to replace this alert with a nicer notification.
      await showConfirmationModal( // Example of using it for an "alert"
        'Cannot delete message: Missing server ID. Please wait for the message to fully save or ensure there was a preceding user prompt for regeneration.',
        'OK', // Confirm button text
        null, // No cancel button, or hide it
        'Error <i class="bi bi-x-octagon-fill ms-1 text-danger"></i>', // Modal Title
        'secondary' // Confirm button type
      );
      // Old alert: alert('Cannot delete message: Missing server ID. Please wait for the message to fully save.');
      console.warn('[Chat][Delete] Missing or temporary message ID on element at index:', messageIndex, targetMessageElement.outerHTML.substring(0,100));
      return;
    }

    // --- BRANCH 2: Handle messages with valid server IDs ---
    console.log(`[Chat][Delete] Branch 2: Handling message with valid ID: ${messageIdToDelete} at index ${messageIndex}`);
    const confirmedDeletionOfSaved = await showConfirmationModal(
        'Delete this message and all messages that follow? This cannot be undone.',
        'Delete',
        'Cancel',
        'Confirm Deletion',
        'danger'
    );

    if (!confirmedDeletionOfSaved) {
        console.log('[Chat][Delete] User cancelled deletion for message ID:', messageIdToDelete);
        return; // User cancelled
    }

    let promptForRegenerationAfterDelete = null;
    if (targetMessageElement.classList.contains('ai-message') && messageIndex > 0) {
        const precedingUserElement = currentMessages[messageIndex - 1]; // Use currentMessages
        if (precedingUserElement?.classList.contains('user-message')) {
            let contentElement = precedingUserElement.querySelector('.markdown-content p') ||
                               precedingUserElement.querySelector('.markdown-content') ||
                               precedingUserElement;
            promptForRegenerationAfterDelete = contentElement.textContent?.trim() || '';
            if (promptForRegenerationAfterDelete) {
                console.log('[Chat][Delete] Identified preceding user prompt for potential post-delete regeneration:', promptForRegenerationAfterDelete);
            }
        }
    }

    const conversationId = this.currentConversationId;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token || !conversationId) {
      alert('Cannot delete message: Missing authentication or conversation context.');
      return;
    }
    console.log(`[Chat][Delete] Attempting backend delete: Convo ${conversationId}, Msg ${messageIdToDelete} (Index ${messageIndex})`);

    try {
        const response = await fetch(`/api/v1/conversations/${conversationId}/messages/${messageIdToDelete}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server failed to delete message(s): ${response.status} ${errorText}`);
        }
        console.log(`[Chat][Delete] API call successful for message ${messageIdToDelete}.`);

        const messagesToRemove = currentMessages.slice(messageIndex);
        messagesToRemove.forEach(msg => msg.remove());
        console.log(`[Chat][Delete] Removed ${messagesToRemove.length} message elements from UI starting at index ${messageIndex}.`);

        if (promptForRegenerationAfterDelete) {
            console.log('[Chat][Delete] Triggering post-delete regeneration for prompt:', promptForRegenerationAfterDelete);
            const textareaElement = document.getElementById('ai-prompt-input');
            const newAiMessageDiv = renderAIPlaceholder(chatDisplay);
            const currentGenerateButton = document.getElementById('ai-generate-button');
            const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

            if(textareaElement) textareaElement.disabled = true;
            if(currentGenerateButton) currentGenerateButton.disabled = true;
            if(currentLoadingIndicator) currentLoadingIndicator.style.display = 'inline-block';

            await this.handleAPISubmission(promptForRegenerationAfterDelete, newAiMessageDiv, textareaElement);
            console.log('[Chat][Delete] Post-delete regeneration submission initiated.');
        } else {
             console.log('[Chat][Delete] No post-delete regeneration needed.');
             await this.fetchAndUpdateCreditsDisplay();
        }

    } catch (error) {
        console.error('[Chat][Delete] Error during message deletion process (for valid ID):', error);
        alert(`Error deleting message: ${error.message}`);
    }
   },


  // --- UI MANAGEMENT & STATE ---

  /** Fetch and update the user's credits display in the UI. */
  async fetchAndUpdateCreditsDisplay() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;

    const navbarCredits = document.getElementById('navbar-user-credits');
    if (!navbarCredits) return;

    try {
      const resp = await fetch('/api/v1/user/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        const credits = (data.credits !== null && data.credits !== undefined) ? data.credits : '-';
        navbarCredits.textContent = `Credits: ${credits}`;
        if (window.currentUserInfo?.dbUserData) {
             window.currentUserInfo.dbUserData.credits = data.credits;
        }
      } else {
          console.warn('[Chat] Failed to fetch updated credits, status:', resp.status);
          navbarCredits.textContent = 'Credits: Error';
      }
    } catch (e) {
      console.error('[Chat] Network error fetching updated credits:', e);
      navbarCredits.textContent = 'Credits: Error';
    }
  },

  /** Toggles fullscreen mode and updates UI elements accordingly. */
  _performFullscreenToggle() {
    if (!allowClassToggle) {
      console.warn("[Chat Toggle] Debounced toggle call.");
      return;
    }
    allowClassToggle = false;

    this.isFullscreenActive = !this.isFullscreenActive;
    console.log(`[Chat Toggle] Setting internal fullscreen state to: ${this.isFullscreenActive}`);

    this._syncUIWithState();

    setTimeout(() => {
      const promptInput = document.getElementById('ai-prompt-input');
      if (promptInput) setTextareaHeight(promptInput, true);
      if (this.isFullscreenActive) scrollToBottom('ai-result-output', false);
      allowClassToggle = true;
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

    body.classList.toggle('chat-fullscreen-active', isFullscreen);

    if (sidebar) {
      sidebar.classList.toggle('d-none', !isFullscreen);
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
    const newBtn = document.getElementById('new-conversation-btn');

    if (!list) {
      console.warn('[Chat Sidebar] conversation-list element not found.');
      return;
    }
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    if (!token) {
      list.innerHTML = '<li><span class="text-muted small">Please log in</span></li>';
      if (newBtn) newBtn.disabled = true;
      return;
    }

    if (newBtn) newBtn.disabled = false;
    list.innerHTML = '<li><span class="text-muted small">Loading...</span></li>';

    try {
      const conversations = await fetchConversations(token);
      list.innerHTML = '';

      if (!Array.isArray(conversations) || conversations.length === 0) {
        list.innerHTML = '<li><span class="text-muted small">No conversations yet</span></li>';
      } else {
        conversations.forEach(conv => {
          const li = document.createElement('li');
          li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
          li.dataset.conversationId = conv.id;
          li.style.cursor = 'pointer';

          const titleSpan = document.createElement('span');
          titleSpan.textContent = conv.title || 'Untitled Conversation';
          titleSpan.title = conv.title || 'Untitled Conversation';
          titleSpan.className = 'conversation-title text-truncate me-2';
          li.appendChild(titleSpan);

          if (conv.id === this.currentConversationId) {
            li.classList.add('active');
          }

          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'conversation-actions btn-group btn-group-sm flex-shrink-0';
          actionsDiv.role = "group";

          const renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.className = 'btn btn-outline-secondary conversation-rename-btn border-0 px-1 py-0';
          renameBtn.title = 'Rename Conversation';
          renameBtn.innerHTML = '<i class="bi bi-pencil small"></i>';
          renameBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this.showRenameDialog(conv);
          });
          actionsDiv.appendChild(renameBtn);

          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'btn btn-outline-danger conversation-delete-btn border-0 px-1 py-0';
          deleteBtn.title = 'Delete Conversation';
          deleteBtn.innerHTML = '<i class="bi bi-trash small"></i>';
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            
                        // MODIFIED PART:
                        const confirmed = await showConfirmationModal(
                          `Are you sure you want to delete "${conv.title || 'Untitled Conversation'}"? This action cannot be undone.`,
                          'Delete', // Confirm button text
                          'Cancel', // Cancel button text
                          'Confirm Deletion', // Modal Title
                          'danger' // Confirm button type
                      );
          
                      if (confirmed)
                        {
              try {
                 await this.deleteConversation(conv.id);
                 await this.renderSidebarConversations();
                 if (conv.id === this.currentConversationId) {
                     await this.loadLatestConversation();
                 }
              } catch (deleteError) { console.error("Error deleting conversation:", deleteError); alert("Failed to delete conversation."); }
            }
          });
          actionsDiv.appendChild(deleteBtn);
          li.appendChild(actionsDiv);

          li.addEventListener('click', async () => {
            if (conv.id !== this.currentConversationId) {
              console.log(`[Chat Sidebar] Switching to conversation ${conv.id}`);
              await this.loadAndDisplayConversation(conv.id);
              list.querySelectorAll('li.active').forEach(item => item.classList.remove('active'));
              li.classList.add('active');
            }
          });
          list.appendChild(li);
        });
      }

      if (newBtn && !newBtn.dataset.listenerAttached) {
           newBtn.dataset.listenerAttached = 'true';
           newBtn.addEventListener('click', (e) => {
               e.preventDefault();
               console.log('[Chat Sidebar] "New Conversation" button clicked - should trigger context modal.');
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
            await this.renameConversation(conv.id, newTitle.trim());
            await this.renderSidebarConversations();
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
  },


  // --- CONTEXT MODAL & HTMX INTEGRATION ---

  /** Initiates the setup process for a NEW chat context via modal. */
  async startNewChatContextSetup() {
    console.log('[Chat Context] Starting NEW context setup.');
    this.currentConversationId = null;

    const chatDisplay = document.getElementById('chat-message-list');
    const modifyContextControls = document.getElementById('chat-context-controls');
    const activeContextDisplay = document.getElementById('active-context-display');
    const modalContentArea = document.getElementById('modal-content-area');
    const modalElement = document.getElementById('contextModal');
    const sidebarList = document.getElementById('conversation-list');

    if (chatDisplay) chatDisplay.innerHTML = '<p class="text-muted small text-center">Setting up new adventure context...</p>';
    if (modifyContextControls) modifyContextControls.style.display = 'none';
    if (activeContextDisplay) activeContextDisplay.innerHTML = '';
    if (sidebarList) {
      sidebarList.querySelectorAll('li.active').forEach(li => li.classList.remove('active'));
    }

    if (!modalContentArea || !modalElement) {
        console.error('[Chat Context] Modal elements not found (#modal-content-area, #contextModal)');
        alert('Error: Cannot open context setup modal.');
        return;
    }

    modalContentArea.innerHTML = `<div class="text-center p-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted small">Loading Setup...</p></div>`;

    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    this.contextModalInstance.show();

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required.</div>`;
        return;
    }

    try {
        if (window.htmx) {
             console.log('[Chat Context] Triggering HTMX GET for /api/v1/chat/setup/start');
             htmx.ajax('GET', '/api/v1/chat/setup/start', {
                 target: '#modal-content-area',
                 swap: 'innerHTML',
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

    modalContentArea.innerHTML = `<div class="text-center p-5"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted small">Loading Existing Context...</p></div>`;

    if (!this.contextModalInstance) {
        this.contextModalInstance = new bootstrap.Modal(modalElement);
    }
    this.contextModalInstance.show();

    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
        modalContentArea.innerHTML = `<div class="alert alert-danger m-3">Authentication required.</div>`;
        return;
    }

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
       if (!displayArea) return;

       displayArea.innerHTML = '';

       if (!contextData || Object.keys(contextData).length === 0) {
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Default Context</span>';
           return;
       }

       const badges = [];
       const displayMap = {
           goal: { label: "Goal", icon: "bi-bullseye" },
           genre_tone: { label: "Genre/Tone", icon: "bi-masks" },
           game_system: { label: "System", icon: "bi-controller" },
           key_details: { label: "Details", icon: "bi-info-circle-fill", truncate: 30 }
       };

       for (const key in displayMap) {
           if (contextData[key]) {
               let value = contextData[key];
               const config = displayMap[key];

               if (key === 'goal') value = value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

               const needsTruncation = config.truncate && value.length > config.truncate;
               const displayValue = needsTruncation ? value.substring(0, config.truncate - 3) + "..." : value;
               const titleAttr = needsTruncation ? `title="${escapeHtml(value)}"` : '';

               badges.push(
                   `<span class="badge lh-base text-bg-light border me-1 mb-1" ${titleAttr}>` +
                   `<i class="bi ${config.icon} me-1"></i>${escapeHtml(displayValue)}` +
                   `</span>`
               );
           }
       }

       if (badges.length > 0) {
           displayArea.innerHTML = badges.join('');
       } else {
           displayArea.innerHTML = '<span class="text-muted small fst-italic">Context Set (No Preview)</span>';
       }
   },

   /** Handles the response after HTMX saves context (via HX-Trigger header). */
   _handleHtmxSaveResponse(event) {
    const xhr = event.detail.xhr;
    if (!xhr || !xhr.responseURL || !xhr.responseURL.includes('/api/v1/chat/setup/save')) {
        return;
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

        if (triggers.newChatCreated) {
            console.log('[Chat HTMX] Handling newChatCreated:', triggers.newChatCreated);
            const { id, title, context, initialMessagesGenerated } = triggers.newChatCreated;

            if (this.contextModalInstance) this.contextModalInstance.hide();

            this.currentConversationId = id;
            this.renderSidebarConversations();

            if (initialMessagesGenerated) {
                console.log('[Chat HTMX] Initial messages were generated. Loading conversation view.');
                this.loadAndDisplayConversation(id).then(() => {
                     document.getElementById('ai-prompt-input')?.focus();
                     this.fetchAndUpdateCreditsDisplay();
                });
            } else {
                console.log('[Chat HTMX] No initial messages generated. Displaying setup confirmation.');
                const chatDisplay = document.getElementById('chat-message-list');
                if(chatDisplay) chatDisplay.innerHTML = '';
                renderMessage('ai', `Context set for "${escapeHtml(title)}". What's your first prompt?`, chatDisplay);
                this.updateActiveContextDisplay(context);
                const modifyBtn = document.getElementById('chat-context-controls');
                if(modifyBtn) modifyBtn.style.display = 'flex';
                scrollToBottom('ai-result-output', false);
                document.getElementById('ai-prompt-input')?.focus();
                 this.fetchAndUpdateCreditsDisplay();
            }

        } else if (triggers.chatContextUpdated) {
            console.log('[Chat HTMX] Handling chatContextUpdated:', triggers.chatContextUpdated);
            const { id, context } = triggers.chatContextUpdated;
            if (this.contextModalInstance) this.contextModalInstance.hide();
            if (id === this.currentConversationId) {
                this.updateActiveContextDisplay(context);
                console.log(`[Chat Context] Display updated for conversation ${id}`);
            } else {
                 console.log(`[Chat Context] Context updated for ${id}, but not the current view (${this.currentConversationId}).`);
                 this.renderSidebarConversations();
            }
             this.fetchAndUpdateCreditsDisplay();
        } else {
            console.warn('[Chat HTMX] Unknown trigger in HX-Trigger header:', triggers);
             if (this.contextModalInstance) this.contextModalInstance.hide();
        }
    } catch (e) {
        console.error('[Chat HTMX] Error parsing HX-Trigger JSON:', e, triggerHeader);
        alert("Error processing context save response. Please check console.");
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
    const modifyContextButton = document.getElementById('modify-context-button');
    // const newContextButton = document.getElementById('new-conversation-btn'); // If needed programmatically

    if (promptInput) {
      promptInput.addEventListener('input', () => setTextareaHeight(promptInput, true));
      promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
      promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          chatForm?.requestSubmit();
        }
      });
      setTextareaHeight(promptInput);
    } else { console.warn("[Chat Events] Prompt input #ai-prompt-input not found."); }

    if (normalZoomBtn) {
         normalZoomBtn.addEventListener('click', () => this._performFullscreenToggle());
    } else { console.warn(`[Chat Events] Normal zoom button #${CHAT_ZOOM_TOGGLE_NORMAL_ID} not found.`); }

    if (fullscreenZoomBtn) {
         fullscreenZoomBtn.addEventListener('click', () => this._performFullscreenToggle());
    } else { console.warn(`[Chat Events] Fullscreen zoom button #${CHAT_ZOOM_TOGGLE_FULLSCREEN_ID} not found.`); }

    if (chatForm) {
      chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPromptInput = document.getElementById('ai-prompt-input');
        const chatDisplay = document.getElementById('chat-message-list');
        const currentGenerateButton = document.getElementById('ai-generate-button');
        const currentLoadingIndicator = document.getElementById('ai-loading-indicator');

        if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
          console.error("[Chat Events] Form submit: Missing required elements."); return;
        }
        const userMessage = currentPromptInput.value.trim();
        if (!userMessage) return;

        currentPromptInput.disabled = true;
        currentGenerateButton.disabled = true;
        currentLoadingIndicator.style.display = 'inline-block';

        removeInitialPrompt(chatDisplay);

        const userMessageIndex = chatDisplay.children.length;

        const userMessageDeleteCallback = async (deleteIdxFromUI) => {
          try {
            console.log(`[Chat][Delete CB Submit] Invoked for new user message. Index from UI: ${deleteIdxFromUI}, Calculated index: ${userMessageIndex}`);
            await this.deleteMessageAndAfter(deleteIdxFromUI);
          } catch (e) {
            console.error(`[Chat][Delete CB Submit] Error in delete callback for new user msg (calc index ${userMessageIndex}):`, e);
            alert("An error occurred while trying to delete your message.");
          }
        };

        renderMessage('user', userMessage, chatDisplay, null,
             userMessageDeleteCallback,
             userMessageIndex
        );
        const aiDiv = renderAIPlaceholder(chatDisplay);
        scrollToBottom('ai-result-output', false);

        await this.handleAPISubmission(userMessage, aiDiv, currentPromptInput);
      });
    } else { console.warn("[Chat Events] Chat form #ai-generation-form not found."); }

    if (modifyContextButton) {
        modifyContextButton.addEventListener('click', (e) => {
            e.preventDefault();
            this.editCurrentChatContext();
            console.log("[Chat Events] Modify context modal loaded.");
        });
    } else { console.warn("[Chat Events] Modify context button #modify-context-button not found."); }

    console.log("[Chat Events] Setting up HTMX afterOnLoad listener on body.");
    document.body.addEventListener('htmx:afterOnLoad', (event) => {
        this._handleHtmxSaveResponse(event);
    });

    console.log("[Chat Events] All chat event listeners setup completed.");
  },


  // --- HELPER METHODS ---

  _addDeleteButtonsToLatestMessages(chatDisplay, payload) {
    if (!chatDisplay) return;
    const messages = Array.from(chatDisplay.children); // Re-fetch current messages
    const lastIndex = messages.length - 1;

    // AI message (last element)
    if (lastIndex >= 0) {
        const aiMsgDiv = messages[lastIndex];
        if (aiMsgDiv && aiMsgDiv.classList.contains('ai-message')) {
            const aiId = payload?.aiMessageId || aiMsgDiv.dataset.messageId;
            if (aiId) aiMsgDiv.dataset.messageId = aiId; // Ensure ID is set

            // Call the updated helper for the AI message
            this.addOrUpdateActionButtons(aiMsgDiv, lastIndex, 'ai');
        }
    }
    // User message (second to last element)
    if (lastIndex >= 1) {
        const userMsgDiv = messages[lastIndex - 1];
        if (userMsgDiv && userMsgDiv.classList.contains('user-message')) {
            const userId = payload?.userMessageId || userMsgDiv.dataset.messageId;
            if (userId) userMsgDiv.dataset.messageId = userId; // Ensure ID is set

            // Call the updated helper for the User message
            this.addOrUpdateActionButtons(userMsgDiv, lastIndex - 1, 'user');
        }
    }
},

/**
 * Helper function to add/update action buttons (copy for AI, delete for all)
 * to a message element. Ensures the .message-actions container exists.
 * @param {HTMLElement} messageDiv The message div element.
 * @param {number} index The index of this message in the chat list.
 * @param {'user'|'ai'} senderType The type of sender for this message.
 */
addOrUpdateActionButtons(messageDiv, index, senderType) {
  if (!messageDiv) {
    console.warn('[Chat][Actions] MessageDiv not provided.');
    return;
  }
  if (typeof this.deleteMessageAndAfter !== 'function') {
    console.error("[Chat][Actions] deleteMessageAndAfter method missing on ChatManager.");
    return;
  }

  // Find or create the actions container
  let actionsDiv = messageDiv.querySelector('.message-actions');
  if (!actionsDiv) {
      actionsDiv = document.createElement('div');
      actionsDiv.className = 'message-actions d-flex align-items-center ms-2';
      // Append it after the message-content-wrapper if it exists, or just to messageDiv
      const contentWrapper = messageDiv.querySelector('.message-content-wrapper');
      if (contentWrapper && contentWrapper.nextSibling) {
          messageDiv.insertBefore(actionsDiv, contentWrapper.nextSibling);
      } else {
          messageDiv.appendChild(actionsDiv);
      }
  }
  // Clear existing buttons inside actionsDiv to prevent duplicates if called multiple times
  // actionsDiv.innerHTML = ''; // Or more selectively remove only specific button types

  // --- Add Copy Button (only for AI messages) ---
  if (senderType === 'ai') {
      // Check if a copy button already exists to avoid duplicates
      if (!actionsDiv.querySelector('.message-copy-btn')) {
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn btn-link btn-sm p-0 message-copy-btn'; // Match chatUI.js
          copyBtn.title = 'Copy AI response text';
          copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
          copyBtn.type = 'button'; // Important for forms

          copyBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const markdownContentDiv = messageDiv.querySelector('.markdown-content');
              if (markdownContentDiv) {
                  try {
                      const textToCopy = markdownContentDiv.textContent || '';
                      await navigator.clipboard.writeText(textToCopy.trim());
                      copyBtn.innerHTML = '<i class="bi bi-check-lg text-success"></i>'; // Feedback
                      setTimeout(() => {
                          copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
                      }, 1500);
                  } catch (err) {
                      console.error('[Chat][Actions] Failed to copy AI message content:', err);
                      // alert('Failed to copy text.'); // Avoid alert here, too intrusive
                  }
              }
          });
          actionsDiv.appendChild(copyBtn); // Add to our actions container
      }
  }

  // --- Add Delete Button (for all messages) ---
  // Check if a delete button already exists
  if (!actionsDiv.querySelector('.message-delete-btn')) {
      const deleteBtn = document.createElement('button');
      // Add ms-2 class IF a copy button is also present, for spacing
      const spacingClass = actionsDiv.querySelector('.message-copy-btn') ? ' ms-2' : '';
      deleteBtn.className = `btn btn-link btn-sm p-0 message-delete-btn${spacingClass}`; // Match chatUI.js
      deleteBtn.title = 'Delete message and following';
      deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
      deleteBtn.type = 'button'; // Important for forms

      // Hover effect for opacity (can be done in CSS too)
      // For simplicity, we assume CSS handles this based on .chat-message:hover .message-actions

      deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteMessageAndAfter(index).catch(error => {
              console.error(`[Chat][Actions][Delete] Error during delete for index ${index}:`, error);
              // alert("An error occurred trying to delete messages."); // Avoid alert
          });
      });
      actionsDiv.appendChild(deleteBtn); // Add to our actions container
  }

  // Ensure actionsDiv is only present if it has children
  if (!actionsDiv.hasChildNodes()) {
      actionsDiv.remove();
  }
},
   addDeleteButtonAndListener(messageDiv, index) {
    if (!messageDiv || messageDiv.querySelector('.message-delete-btn')) {
      return;
    }
    if (typeof this.deleteMessageAndAfter !== 'function') {
      console.error("[Chat][addDeleteButton] deleteMessageAndAfter method missing.");
      return;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn text-muted';
    deleteBtn.title = 'Delete message and following';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.type = 'button';
    deleteBtn.style.opacity = '0.6';
    deleteBtn.style.fontSize = '0.8em';

    messageDiv.addEventListener('mouseenter', () => deleteBtn.style.opacity = '1');
    messageDiv.addEventListener('mouseleave', () => deleteBtn.style.opacity = '0.6');

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteMessageAndAfter(index).catch(error => {
           console.error(`[Chat][Delete] Error during delete execution for index ${index}:`, error);
           alert("An error occurred trying to delete messages.");
      });
    });
    messageDiv.appendChild(deleteBtn);
  },

}; // ================= End ChatManager Object =================


// --- Global Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  console.log("[Chat Main] DOMContentLoaded - Initializing Chat System Setup");

  const modifyContextControls = document.getElementById('chat-context-controls');
  if (modifyContextControls) {
      modifyContextControls.style.display = 'none';
  }

  window.ChatManager = ChatManager;
  console.log("[Chat Main] ChatManager exposed on window.");

  document.body.addEventListener('htmx:configRequest', function(evt) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let requestPath = evt.detail.path;
    const targetElement = evt.detail.elt;

    let isApiRequest = false;
    try {
        const url = new URL(requestPath, window.location.origin);
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/v1/')) {
            isApiRequest = true;
            requestPath = url.pathname + url.search + url.hash;
        } else if (!requestPath.includes('://') && requestPath.startsWith('/api/v1/')) {
            isApiRequest = true;
        }
    } catch (e) {
        if (requestPath.startsWith('/api/v1/')) {
            isApiRequest = true;
        }
    }

    // console.log(`[HTMX Config] Processing request to: ${evt.detail.path}. Relative path for API check: ${requestPath}. Is API: ${isApiRequest}. Triggered by:`, targetElement);
    // console.log(`[HTMX Config] Current Access Token: ${token ? 'Token Present' : 'NO TOKEN'}`);

    if (token && isApiRequest) {
        evt.detail.headers['Authorization'] = `Bearer ${token}`;
        // console.log(`[HTMX Config] Added Auth header to: ${evt.detail.path}`);
    } else if (!token && isApiRequest) {
         console.warn(`[HTMX Config] No token found for API request: ${evt.detail.path}. Request will likely fail with 401.`);
    } else {
        // console.log(`[HTMX Config] No Auth header added (isApiRequest: ${isApiRequest}, tokenPresent: ${!!token}) for: ${evt.detail.path}`);
    }
  });
  console.log("[Chat Main] HTMX configRequest listener setup.");

  window.initializeChat = () => {
      try {
          console.log("[Chat Main] Global initializeChat() called.");
          ChatManager.initializeChat();
      } catch (e) {
          console.error("[Chat Main] Error executing initializeChat via global function:", e);
          const chatDisplay = document.getElementById('chat-message-list');
          if(chatDisplay) renderChatError("Failed to initialize chat system. Please refresh.", chatDisplay);
      }
  };
   window.teardownChat = () => {
      try {
          console.log("[Chat Main] Global teardownChat() called.");
          ChatManager.teardownChat();
      } catch (e) {
          console.error("[Chat Main] Error executing teardownChat via global function:", e);
      }
  };
  console.log("[Chat Main] Global initializeChat() and teardownChat() functions defined.");

  try {
      ChatManager.setupEventListeners();
      console.log("[Chat Main] ChatManager event listeners setup successfully.");
  } catch (e) {
       console.error("[Chat Main] Error calling ChatManager.setupEventListeners:", e);
  }

  console.log("[Chat Main] DOM Ready setup complete. Waiting for auth module to initialize chat.");
});


if (typeof window.toggleOtherFieldVisibility !== 'function') {
  window.toggleOtherFieldVisibility = function(selectElementId, otherWrapperId, otherInputId) {
      const selectElement = document.getElementById(selectElementId);
      const otherWrapper = document.getElementById(otherWrapperId);
      // const otherInput = document.getElementById(otherInputId);

      if (!selectElement || !otherWrapper) {
          return;
      }

      if (selectElement.value === 'other') {
          otherWrapper.classList.remove('d-none');
      } else {
          otherWrapper.classList.add('d-none');
      }
  };
}