// static/chat.js

// static/chat.js
let allowClassToggle = true; // Global flag

// Assuming chatUtils.js, chatUI.js, chatApi.js are correctly imported or available
// Make sure imports point to the correct helper files if they exist separately
import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';

// --- Constants for Zoom Buttons (Used within ChatManager) ---
const CHAT_ZOOM_TOGGLE_NORMAL_ID = 'chat-zoom-toggle-normal';
const CHAT_ZOOM_TOGGLE_FULLSCREEN_ID = 'chat-zoom-toggle-fullscreen';

/**
 * ChatManager orchestrates chat state, event wiring, and uses modular helpers for UI and API.
 */
const ChatManager = {
  currentConversationId: null,
  chatInitialized: false,
  // Keep track of fullscreen state internally within ChatManager
  isFullscreenActive: false,

  /**
   * Load the user's latest conversation or show the new conversation prompt.
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
      renderChatError('You must be logged in to load conversations.', chatDisplay); // Assumes renderChatError is available
      return;
    }
    try {
      const data = await fetchConversations(token); // Assumes fetchConversations is available
      if (Array.isArray(data) && data.length > 0) {
        const latestConv = data[0];
        console.log('[Chat] Found latest conversation:', latestConv.id);
        this.currentConversationId = latestConv.id;
        await this.loadAndDisplayConversation(latestConv.id);
      } else {
        console.log('[Chat] No existing conversations found, loading empty state.');
        await this.loadAndDisplayConversation(null); // Load empty/initial state
      }
    } catch (e) {
      console.error('[Chat] Error processing conversations:', e);
      renderChatError('Error processing conversations.', chatDisplay);
      await this.loadAndDisplayConversation(null); // Load empty/initial state on error
    }
  },

  /**
   * Load and display a specific conversation by ID, or initial state if ID is null.
   */
  async loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error('[Chat] loadAndDisplayConversation: chat-message-list not found.');
        return;
    }
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Loading conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    // Handle null conversationId (new/initial state)
    if (!conversationId) {
        console.log('[Chat] loadAndDisplayConversation: No conversation ID provided, displaying initial prompt.');
        this.currentConversationId = null;
        chatDisplay.innerHTML = ''; // Clear loading message
        removeInitialPrompt(chatDisplay); // Ensure any previous prompt/error is gone
        renderMessage('ai', 'Welcome! How can I help you create today?', chatDisplay); // Display initial AI message
        scrollToBottom('ai-result-output', false);
        return; // Exit early
    }

    // Proceed if conversationId exists and user is logged in
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      return;
    }

    // Fetch and display the specific conversation
    try {
      console.log(`[Chat] Fetching conversation ID: ${conversationId}`);
      const conversation = await fetchConversationById(conversationId, token); // Assumes fetchConversationById is available
      chatDisplay.innerHTML = ''; // Clear loading message/previous content
      removeInitialPrompt(chatDisplay); // Clear any lingering initial prompt

      if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
        console.warn('[Chat] Conversation loaded but has no messages:', conversationId);
        renderMessage('ai', 'This conversation is empty. Start typing to add a message!', chatDisplay);
      } else {
        console.log(`[Chat] Rendering ${conversation.messages.length} messages for conversation ${conversationId}`);
        conversation.messages.forEach((msg, idx) => {
          renderMessage( // Assumes renderMessage is available
            msg.role === 'user' ? 'user' : 'ai',
            msg.content,
            chatDisplay,
            msg.id || `temp-${idx}`, // Provide a temporary ID if missing
            async (deleteIdx) => { // Pass the delete handler callback
              if (confirm('Delete this message and all after?')) {
                await ChatManager.deleteMessageAndAfter(deleteIdx);
              }
            },
            idx // Pass the original index
          );
        });
      }
      this.currentConversationId = conversationId;
      console.log('[Chat] Successfully loaded and displayed conversation:', conversationId);
    }
    catch (e) {
      console.error(`[Chat] Error loading conversation ${conversationId}:`, e);
      renderChatError(`Error loading conversation: ${e.message}`, chatDisplay);
      this.currentConversationId = null;
    }
    // Ensure scrolling happens after content is potentially rendered
    setTimeout(() => scrollToBottom('ai-result-output', false), 50); // Allow a tick for rendering
  },

  /**
   * Handle user message submission and display streaming AI response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let success = false;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    const userMessageElement = aiMessageDiv ? aiMessageDiv.previousElementSibling : null; // Get user message element BEFORE API call

    if (!token) {
      if (aiMessageDiv) {
        aiMessageDiv.innerHTML = '<span class="text-danger">Error: Not logged in.</span>';
      } else {
        console.error('[Chat][handleAPISubmission] Cannot display error: aiMessageDiv is missing.');
      }
      // Re-enable inputs immediately if not logged in
      if (textareaElement) textareaElement.disabled = false;
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
      return;
    }
    try {
      const response = await sendChatMessage({ prompt: userMessage, conversationId: this.currentConversationId, token }); // Assumes sendChatMessage is available

      if (!response.ok) {
          let errorText = `API Error ${response.status}`;
          try {
              const errorData = await response.json();
              errorText = errorData.detail || errorText;
          } catch (e) { /* Ignore if response is not JSON */ }
          console.error('[Chat][handleAPISubmission] API response not OK:', response.status, errorText);
          throw new Error(errorText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = '';
      const markdownDiv = aiMessageDiv.querySelector('.markdown-content'); // Target the inner div for markdown

      if (!markdownDiv) {
          console.error('[Chat][handleAPISubmission] Markdown display area (.markdown-content) not found in aiMessageDiv.');
          throw new Error('Internal UI Error: Markdown display area not found.');
      }

      let finalPayload = null; // Store the payload when found

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunk = decoder.decode(value, { stream: true });

        // --- Efficient Payload Check ---
        const jsonMarker = '"userMessageId":';
        const potentialJsonStart = chunk.lastIndexOf(jsonMarker);

        if (potentialJsonStart !== -1 && chunk.trim().endsWith('}')) {
            const jsonStringCandidate = chunk.substring(potentialJsonStart - 1); // Include the opening '{'
            try {
                const parsed = JSON.parse(jsonStringCandidate);
                if (parsed.userMessageId && parsed.aiMessageId) {
                    finalPayload = parsed;
                    chunk = chunk.substring(0, potentialJsonStart - 1);
                }
            } catch (e) { /* Ignore parse error, treat as text */ }
        }
        // --- End Payload Check ---

        if (chunk) {
             aiResponseContent += chunk;
             markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
             scrollToBottom('ai-result-output', true);
        }
        if (finalPayload) break; // Exit loop once payload is found

      } // End while loop

      // --- Process Final Payload ---
      if (finalPayload) {
          console.log('[Chat] Processing final message IDs:', finalPayload);
          if (aiMessageDiv) aiMessageDiv.dataset.messageId = finalPayload.aiMessageId;
          if (userMessageElement) {
               userMessageElement.dataset.messageId = finalPayload.userMessageId;
               console.log(`[Chat] Set user message element ID (via previousElementSibling) to ${finalPayload.userMessageId}`);
          } else {
               console.warn(`[Chat] Could not find user message element (via previousElementSibling) to set ID ${finalPayload.userMessageId}`);
               // Fallback search in DOM
               const messages = document.getElementById('chat-message-list')?.children;
               if (messages && messages.length >= 2) {
                   const potentialUserMsg = messages[messages.length - 2];
                   if (potentialUserMsg && potentialUserMsg.classList.contains('user-message') && !potentialUserMsg.dataset.messageId) {
                       potentialUserMsg.dataset.messageId = finalPayload.userMessageId;
                       console.log(`[Chat] Set user message element ID (fallback DOM search) to ${finalPayload.userMessageId}`);
                   }
               }
          }
          // Add Delete Buttons
          const chatDisplay = document.getElementById('chat-message-list');
          if (chatDisplay) {
              const messages = chatDisplay.children;
              const aiMessageIndex = messages.length - 1;
              const userMessageIndex = messages.length - 2;
              if (aiMessageIndex >= 0 && messages[aiMessageIndex] === aiMessageDiv) {
                  this.addDeleteButtonAndListener(aiMessageDiv, aiMessageIndex);
              }
              if (userMessageIndex >= 0) {
                  const userMsgDiv = messages[userMessageIndex];
                  if (userMsgDiv && userMsgDiv.classList.contains('user-message') && userMsgDiv.dataset.messageId === finalPayload.userMessageId) {
                      this.addDeleteButtonAndListener(userMsgDiv, userMessageIndex);
                  }
              }
          }
      } else {
          console.warn('[Chat] Stream finished but no final payload with IDs received.');
      }
      // --- End Process Final Payload ---

       if (markdownDiv) { // Final render pass
            markdownDiv.innerHTML = window.marked ? window.marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
       }

      await this.fetchAndUpdateCreditsDisplay();
      success = true;
      if (textareaElement) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }
      scrollToBottom('ai-result-output', true); // Final scroll

    } catch (error) {
      console.error('[Chat][handleAPISubmission] Error during API call or streaming:', error);
      if (aiMessageDiv) {
        const errorDisplayTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorDisplayTarget.innerHTML = `<span class="text-danger">Error: ${escapeHtml(error.message)}</span>`;
      }
      scrollToBottom('ai-result-output', true);
    } finally {
      // Always re-enable inputs and hide loading indicator
      if (textareaElement) textareaElement.disabled = false;
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
       if (textareaElement) setTextareaHeight(textareaElement);
    }
  },

  /**
   * Fetch and update the user's credits display in the UI.
   */
  async fetchAndUpdateCreditsDisplay() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) return;
    try {
      const resp = await fetch('/api/v1/user/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        const credits = data.credits !== null && data.credits !== undefined ? data.credits : '--';
        const navbarCredits = document.getElementById('navbar-user-credits'); // Use constant if available
        if (navbarCredits) navbarCredits.textContent = `Credits: ${credits}`;
        if (window.currentUserInfo && window.currentUserInfo.dbUserData) {
             window.currentUserInfo.dbUserData.credits = data.credits;
             // console.log('[Chat] Updated global credits state:', window.currentUserInfo.dbUserData.credits); // Verbose log
        }
      } else {
          console.warn('[Chat] Failed to fetch updated credits, status:', resp.status);
      }
    } catch (e) {
      console.error('[Chat] Network error fetching updated credits:', e);
    }
  },

  /**
   * Initialize the chat (load latest conversation, set flag).
   */
// static/chat.js (Inside ChatManager object)

  /**
   * Initialize the chat (load latest conversation, set flag).
   * Modified to explicitly use ChatManager instead of 'this' for robustness.
   */
  initializeChat() {
    // Use ChatManager.chatInitialized instead of this.chatInitialized
    if (ChatManager.chatInitialized) {
      console.log('[Chat] InitializeChat called, but already initialized.');
      return;
    }
    console.log('[Chat] Initializing chat...');

    // Explicitly use ChatManager.isFullscreenActive instead of this.isFullscreenActive
    ChatManager.isFullscreenActive = document.body.classList.contains('chat-fullscreen-active');

    // Explicitly call methods on ChatManager
    ChatManager.loadLatestConversation();

    // Explicitly set property on ChatManager
    ChatManager.chatInitialized = true;
    console.log('[Chat] Chat initialized flag set to true.');

    // Explicitly call method on ChatManager
    ChatManager._syncUIWithState();

    setTimeout(() => scrollToBottom('ai-result-output', false), 150);
  }, // End initializeChat

  /**
   * Render the sidebar conversation list.
   */
  async renderSidebarConversations() {
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const list = document.getElementById('conversation-list');
    const newBtn = document.getElementById('new-conversation-btn'); // Assuming this ID exists

    if (!sidebar || !list) {
      console.warn('[Chat] renderSidebarConversations: Sidebar or list element not found.');
      return;
    }
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;

    if (!token) {
      list.innerHTML = '<li><span class="text-muted small">Please log in</span></li>';
      if (newBtn) newBtn.disabled = true;
      return;
    }

    if (newBtn) newBtn.disabled = false; // Enable if logged in

    try {
      const conversations = await fetchConversations(token); // Assumes fetchConversations is available
      list.innerHTML = ''; // Clear previous list

      if (!Array.isArray(conversations) || conversations.length === 0) {
        list.innerHTML = '<li><span class="text-muted small">No conversations yet</span></li>';
      } else {
        conversations.forEach(conv => {
          const li = document.createElement('li');
          li.textContent = conv.title || 'Untitled Conversation';
          li.title = conv.title || 'Untitled Conversation';
          li.dataset.conversationId = conv.id; // Store ID for easy access

          if (conv.id === this.currentConversationId) {
            li.classList.add('active');
          }

          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'conversation-actions';
          actionsDiv.style.cssText = 'display: inline-flex; align-items: center; margin-left: auto; gap: 0.25rem;'; // Use flex for alignment

          const renameBtn = document.createElement('button');
          renameBtn.className = 'btn btn-link btn-sm p-0 conversation-rename-btn'; // Removed ms-* for flex gap
          renameBtn.title = 'Rename Conversation';
          renameBtn.innerHTML = '<i class="bi bi-pencil"></i>';
          renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showRenameDialog(conv); });
          actionsDiv.appendChild(renameBtn);

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn btn-link btn-sm p-0 conversation-delete-btn'; // Removed ms-* for flex gap
          deleteBtn.title = 'Delete Conversation';
          deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete "${conv.title || 'Untitled Conversation'}"?`)) {
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
          // Make list item itself flex to push actions to the right
          li.style.display = 'flex';
          li.style.alignItems = 'center';
          li.style.justifyContent = 'space-between';


          li.addEventListener('click', async () => {
            if (conv.id !== this.currentConversationId) {
              console.log(`[Chat] Sidebar: Switching to conversation ${conv.id}`);
              await this.loadAndDisplayConversation(conv.id);
              list.querySelectorAll('li').forEach(item => item.classList.remove('active'));
              li.classList.add('active');
            }
          });
          list.appendChild(li);
        });
      }

      // Attach 'New Conversation' listener only once
      if (newBtn && !newBtn.dataset.listenerAttached) {
        newBtn.dataset.listenerAttached = 'true';
        newBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          console.log('[Chat] "New Conversation" button clicked.');
           try {
                await this.createNewConversation();
                await this.renderSidebarConversations();
                await this.loadLatestConversation();
           } catch (createError) { console.error("Error creating new conversation:", createError); alert("Failed to create new conversation."); }
        });
      }

    } catch (e) {
      console.error('[Chat] Error loading conversations for sidebar:', e);
      list.innerHTML = '<li><span class="text-danger small">Error loading</span></li>';
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
            await this.renderSidebarConversations(); // Refresh list to show new name
       } catch (renameError) { console.error("Error renaming conversation:", renameError); alert("Failed to rename conversation."); }
    }
  },

  /** Call API to create a new conversation */
  async createNewConversation() {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) throw new Error("Authentication required.");
    const response = await fetch('/api/v1/conversations', { // Assumes API endpoint
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
     if (!response.ok) {
         const errorData = await response.text();
         throw new Error(`Failed to create conversation: ${response.status} ${errorData}`);
     }
     console.log('[Chat] New conversation created via API.');
  },

  /** Call API to rename a conversation */
  async renameConversation(conversationId, newTitle) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) throw new Error("Authentication required.");
    const response = await fetch(`/api/v1/conversations/${conversationId}`, { // Assumes API endpoint
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
     if (!response.ok) {
         const errorData = await response.text();
         throw new Error(`Failed to rename conversation: ${response.status} ${errorData}`);
     }
      console.log(`[Chat] Conversation ${conversationId} renamed to "${newTitle}" via API.`);
  },

  /** Call API to delete a conversation */
  async deleteConversation(conversationId) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) throw new Error("Authentication required.");
    const response = await fetch(`/api/v1/conversations/${conversationId}`, { // Assumes API endpoint
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
     if (!response.ok) {
         const errorData = await response.text();
         throw new Error(`Failed to delete conversation: ${response.status} ${errorData}`);
     }
     console.log(`[Chat] Conversation ${conversationId} deleted via API.`);
  },

  /** Delete a message and all subsequent messages */
  async deleteMessageAndAfter(messageIndex) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) {
        console.error('[Chat][Delete] chat-message-list not found.');
        return;
    }
    const messages = Array.from(chatDisplay.children);
    if (messageIndex < 0 || messageIndex >= messages.length) {
      console.error('[Chat][Delete] Invalid message index:', messageIndex);
      return;
    }

    const targetMessageElement = messages[messageIndex];
    if (!targetMessageElement || !targetMessageElement.dataset.messageId) {
      alert('Cannot delete message: Missing message ID on the target element.');
      console.error('[Chat][Delete] Target message element or its data-message-id not found at index:', messageIndex);
      return;
    }
    const messageIdToDelete = targetMessageElement.dataset.messageId; // ID of the first message to delete

    // Check for preceding user prompt for potential regeneration
    let promptForRegeneration = null;
    if (targetMessageElement.classList.contains('ai-message') && messageIndex > 0) {
        const precedingUserElement = messages[messageIndex - 1];
        if (precedingUserElement && precedingUserElement.classList.contains('user-message')) {
            let contentElement = precedingUserElement.querySelector('.markdown-content p') || precedingUserElement.querySelector('.markdown-content') || precedingUserElement;
            promptForRegeneration = contentElement.textContent || contentElement.innerText || '';
            promptForRegeneration = promptForRegeneration.replace(/^User\s*/, '').trim();
            // console.log('[Chat][Delete] Found preceding user prompt for regeneration:', promptForRegeneration);
        } else {
            // console.warn('[Chat][Delete] Target is AI message, but preceding element is not a user message.');
        }
    }

    const conversationId = this.currentConversationId;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token || !conversationId) {
      alert('Cannot delete message: Missing authentication or conversation context.');
      return;
    }
    console.log(`[Chat][Delete] Attempting to delete message ${messageIdToDelete} and subsequent messages in conversation ${conversationId}`);

    try {
        const response = await fetch(`/api/v1/conversations/${conversationId}/messages/${messageIdToDelete}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete message(s): ${response.status} ${errorText}`);
        }
        console.log(`[Chat][Delete] API call successful for message ${messageIdToDelete}.`);

        // Remove messages from UI
        const messagesToRemove = Array.from(chatDisplay.children).slice(messageIndex);
        messagesToRemove.forEach(msg => msg.remove());
        console.log(`[Chat][Delete] Removed ${messagesToRemove.length} message elements from UI.`);

        // Trigger Regeneration if applicable
        if (promptForRegeneration && promptForRegeneration.length > 0) {
            console.log('[Chat][Delete] Triggering regeneration for prompt:', promptForRegeneration);
            const textareaElement = document.getElementById('ai-prompt-input');
            const newAiMessageDiv = renderAIPlaceholder(chatDisplay);
            if (typeof this.handleAPISubmission === 'function') {
                 await this.handleAPISubmission(promptForRegeneration, newAiMessageDiv, textareaElement);
                 console.log('[Chat][Delete] Regeneration submission initiated.');
            } else {
                 console.error('[Chat][Delete] handleAPISubmission function not found on ChatManager.');
                 renderChatError('Failed to start regeneration.', chatDisplay);
            }
        } else {
             console.log('[Chat][Delete] No regeneration needed or prompt not found.');
        }
        await this.fetchAndUpdateCreditsDisplay();

    } catch (error) {
        console.error('[Chat][Delete] Error during message deletion process:', error);
        alert(`Error deleting message: ${error.message}`);
    }
  },

// static/chat.js (Inside ChatManager object)

_performFullscreenToggle() {
  // Check the global flag
  if (!allowClassToggle) {
      console.warn("[Chat Toggle] Debounced/Blocked duplicate toggle call.");
      return; // Prevent rapid re-toggling if something is firing multiple events
  }
  allowClassToggle = false; // Block subsequent calls temporarily
  console.log("[Chat Toggle] Entered performFullscreenToggle (Blocking further calls)");


  const body = document.body;
  const sidebar = document.getElementById('chat-fullscreen-sidebar');
  const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
  const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

  // --- Log state BEFORE modification attempt ---
  console.log(`[Chat Toggle Debug] State BEFORE toggle logic: isFullscreenActive=${this.isFullscreenActive}, Normal has d-none? ${normalZoomBtn?.classList.contains('d-none')}, Fullscreen has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);


  // Toggle the internal state
  this.isFullscreenActive = !this.isFullscreenActive;
  const isFullscreen = this.isFullscreenActive; // Use the new state

  console.log(`[Chat Toggle] Setting internal fullscreen state to: ${isFullscreen}`);

  // Toggle body class
  body.classList.toggle('chat-fullscreen-active', isFullscreen);

  // Toggle sidebar panel visibility
  if (sidebar) {
      sidebar.classList.toggle('d-none', !isFullscreen);
  } else { console.warn('[Chat Toggle] Sidebar element not found.'); }

  // Toggle button visibility
  if (normalZoomBtn) normalZoomBtn.classList.toggle('d-none', isFullscreen);
  if (fullscreenZoomBtn) fullscreenZoomBtn.classList.toggle('d-none', !isFullscreen);

   // --- Log state AFTER modification attempt ---
  console.log(`[Chat Toggle Debug] State AFTER toggle logic: isFullscreenActive=${this.isFullscreenActive}, Normal has d-none? ${normalZoomBtn?.classList.contains('d-none')}, Fullscreen has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);


  // Actions specific to entering/exiting fullscreen
  if (isFullscreen) {
    this.renderSidebarConversations();
  }

  // Adjust layout elements slightly after state change
  setTimeout(() => {
      const promptInput = document.getElementById('ai-prompt-input');
      if (promptInput) setTextareaHeight(promptInput, true);
      if (isFullscreen) scrollToBottom('ai-result-output', false);
      // Re-allow toggling after a short delay
      allowClassToggle = true;
      console.log("[Chat Toggle] Re-enabled toggling.");
  }, 150); // Increased delay slightly for debounce
},

  // static/chat.js (Inside ChatManager object)

  /** Syncs UI element visibility (buttons, sidebar) with the current internal fullscreen state. Useful on init. */
  _syncUIWithState() {
    const isFullscreen = this.isFullscreenActive; // Use the current state determined in initializeChat
    console.log('[Chat Sync] Syncing UI with internal fullscreen state:', isFullscreen);
    const body = document.body;
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
    const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

    // Apply body class FIRST
    body.classList.toggle('chat-fullscreen-active', isFullscreen);

    // --- Explicitly set visibility based on state ---
    if (sidebar) {
        if (isFullscreen) {
            sidebar.classList.remove('d-none'); // Ensure visible
            this.renderSidebarConversations(); // Render content if entering fullscreen
        } else {
            sidebar.classList.add('d-none'); // Ensure hidden
        }
    }
    if (normalZoomBtn) {
        if (isFullscreen) {
            normalZoomBtn.classList.add('d-none'); // Ensure hidden
        } else {
            normalZoomBtn.classList.remove('d-none'); // Ensure visible
        }
    }
    if (fullscreenZoomBtn) {
        if (isFullscreen) {
            fullscreenZoomBtn.classList.remove('d-none'); // Ensure visible
        } else {
            fullscreenZoomBtn.classList.add('d-none'); // Ensure hidden
        }
    }

    console.log(`[Chat Sync] After sync: Normal btn has d-none? ${normalZoomBtn?.classList.contains('d-none')}. Fullscreen btn has d-none? ${fullscreenZoomBtn?.classList.contains('d-none')}`);

  }, // End _syncUIWithState



 // static/chat.js (Inside ChatManager object)

  /**
   * Set up all event listeners for chat UI elements.
   */
  setupEventListeners() {
    document.addEventListener('DOMContentLoaded', () => {
      console.log("[Chat Events] DOMContentLoaded - Setting up chat event listeners.");
      const chatForm = document.getElementById('ai-generation-form');
      const promptInput = document.getElementById('ai-prompt-input');
      const normalZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_NORMAL_ID);
      const fullscreenZoomBtn = document.getElementById(CHAT_ZOOM_TOGGLE_FULLSCREEN_ID);

      // --- Prompt Input Listeners ---
      if (promptInput) {
        // console.log("[Chat Events] Setting up prompt input listeners."); // Verbose
        promptInput.addEventListener('input', () => setTextareaHeight(promptInput, true));
        promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
        setTextareaHeight(promptInput); // Initial height check
        promptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const generateButton = document.getElementById('ai-generate-button');
            if (generateButton && !generateButton.disabled) {
              const form = promptInput.closest('form');
              if (form) {
                  // console.log("[Chat Events] Enter pressed, submitting form."); // Verbose
                  form.requestSubmit();
              } else { console.warn("[Chat Events] Enter pressed, but couldn't find parent form."); }
            } // else { console.log("[Chat Events] Enter pressed, but generate button is disabled."); } // Verbose
          }
        });
      } else { console.warn("[Chat Events] Prompt input element not found."); }

      // --- Zoom Button Listeners (Using Arrow Function for 'this') ---
      if (normalZoomBtn) {
           console.log('[Chat Events] Adding listener to normal zoom button.');
           // Use arrow function to ensure 'this' refers to ChatManager
           normalZoomBtn.addEventListener('click', () => {
               console.log("[Chat Events] Normal zoom clicked.");
               this._performFullscreenToggle(); // 'this' should be ChatManager here
           });
      } else { console.warn(`[Chat Events] Normal zoom button #${CHAT_ZOOM_TOGGLE_NORMAL_ID} not found.`); }

      if (fullscreenZoomBtn) {
           console.log('[Chat Events] Adding listener to fullscreen zoom button.');
           // Use arrow function to ensure 'this' refers to ChatManager
           fullscreenZoomBtn.addEventListener('click', () => {
                console.log("[Chat Events] Fullscreen zoom clicked.");
               this._performFullscreenToggle(); // 'this' should be ChatManager here
           });
      } else { console.warn(`[Chat Events] Fullscreen zoom button #${CHAT_ZOOM_TOGGLE_FULLSCREEN_ID} not found.`); }


      // --- Chat Form Submit Listener ---
      if (chatForm) {
        // console.log("[Chat Events] Setting up chat form submit listener."); // Verbose
        // Use arrow function here too for consistency, though not strictly needed if not using 'this'
        chatForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          // console.log("[Chat Events] Chat form submitted."); // Verbose
          const currentPromptInput = document.getElementById('ai-prompt-input');
          const chatDisplay = document.getElementById('chat-message-list');
          const currentGenerateButton = document.getElementById('ai-generate-button');
          const currentLoadingIndicator = document.getElementById('ai-loading-indicator');
          if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
            console.error("[Chat Events] Form submit: Missing required elements.");
            return;
          }
          const userMessage = currentPromptInput.value.trim();
          if (!userMessage) {
            // console.log("[Chat Events] Form submit: Empty message, ignoring."); // Verbose
            return;
          }
          currentPromptInput.disabled = true;
          currentGenerateButton.disabled = true;
          currentLoadingIndicator.style.display = 'inline-block';
          removeInitialPrompt(chatDisplay);
          renderMessage('user', userMessage, chatDisplay);
          const aiDiv = renderAIPlaceholder(chatDisplay);
          scrollToBottom('ai-result-output', false);
          // Call the API handling logic using 'this' - arrow function doesn't have its own 'this'
          // We need to ensure 'this' refers to ChatManager when handleAPISubmission is called
          // The submit handler itself doesn't need 'this', but handleAPISubmission likely does
          ChatManager.handleAPISubmission(userMessage, aiDiv, currentPromptInput); // Call statically if 'this' is an issue
          // OR ensure 'this' context if handleAPISubmission uses internal 'this':
          // this.handleAPISubmission(userMessage, aiDiv, currentPromptInput); // Requires 'this' to be bound correctly for the submit listener
        });
      } else { console.warn("[Chat Events] Chat form element not found."); }

       console.log("[Chat Events] All chat event listeners setup completed.");
    }); // End DOMContentLoaded
  },

  /**
   * Helper function to add a delete button and its listener to a message element.
   * Ensures button isn't added twice.
   * @param {HTMLElement} messageDiv The message div element.
   * @param {number} index The index of this message in the chat list.
   */
   addDeleteButtonAndListener(messageDiv, index) {
    if (!messageDiv) {
      console.warn(`[Chat][addDeleteButton] Skipping for index ${index}: Target div is null.`);
      return;
    }
    if (messageDiv.querySelector('.message-delete-btn')) {
      // console.log(`[Chat][addDeleteButton] Skipping for index ${index}: Delete button already exists.`);
      return;
    }
    if (typeof this.deleteMessageAndAfter !== 'function') {
      console.error("[Chat][addDeleteButton] deleteMessageAndAfter function not found on ChatManager");
      return;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-link btn-sm p-0 ms-2 message-delete-btn';
    deleteBtn.title = 'Delete message and all subsequent messages';
    deleteBtn.innerHTML = '<i class="bi bi-x-circle"></i>';
    deleteBtn.type = 'button';

    // Ensure 'this' context is correct using an arrow function for the listener
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this message and all messages that follow? This cannot be undone.')) {
        // 'this' inside arrow function refers to ChatManager instance
        this.deleteMessageAndAfter(index).catch(error => {
             console.error(`[Chat][Delete] Error during deleteMessageAndAfter execution for index ${index}:`, error);
             alert("An error occurred while trying to delete the message.");
        });
      }
    });
    messageDiv.appendChild(deleteBtn);
    // console.log(`[Chat][addDeleteButton] Successfully appended delete button to message at index ${index}`);
  },

}; // End ChatManager Object

// Expose ChatManager and initialization function to the global scope
window.ChatManager = ChatManager;
window.initializeChat = () => ChatManager.initializeChat();

// Set up event listeners defined within ChatManager
ChatManager.setupEventListeners();

// export default ChatManager; // Uncomment if using ES modules elsewhere