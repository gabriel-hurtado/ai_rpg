import { escapeHtml, setTextareaHeight, scrollToBottom } from './chatUtils.js';
import { renderMessage, renderAIPlaceholder, renderChatError, removeInitialPrompt } from './chatUI.js';
import { fetchConversations, fetchConversationById, sendChatMessage } from './chatApi.js';

/**
 * ChatManager orchestrates chat state, event wiring, and uses modular helpers for UI and API.
 */
const ChatManager = {
  currentConversationId: null,
  chatInitialized: false,

  /**
   * Load the user's latest conversation or show the new conversation prompt.
   */
  async loadLatestConversation() {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) return;
    chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Finding latest conversation...</p>';
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      renderChatError('You must be logged in to load conversations.', chatDisplay);
      return;
    }
    try {
      const data = await fetchConversations(token);
      if (Array.isArray(data) && data.length > 0) {
        const latestConv = data[0];
        this.currentConversationId = latestConv.id;
        await this.loadAndDisplayConversation(latestConv.id);
      } else {
        await this.loadAndDisplayConversation(null);
      }
    } catch (e) {
      renderChatError('Error processing conversations.', chatDisplay);
      await this.loadAndDisplayConversation(null);
    }
  },

  /**
   * Load and display a specific conversation by ID.
   */
  async loadAndDisplayConversation(conversationId) {
    const chatDisplay = document.getElementById('chat-message-list');
    if (!chatDisplay) return;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!conversationId) {
      chatDisplay.innerHTML = '<p class="text-muted small text-center initial-chat-prompt">Start a new conversation by sending a message.</p>';
      this.currentConversationId = null;
      scrollToBottom('ai-result-output', false);
      return;
    }
    try {
      chatDisplay.innerHTML = '<p class="text-muted small text-center">Loading conversation...</p>';
      const data = await fetchConversationById(conversationId, token);
      if (!data || !Array.isArray(data.messages)) {
        renderChatError('Error loading conversation data.', chatDisplay);
        this.currentConversationId = null;
      } else {
        chatDisplay.innerHTML = '';
        data.messages.forEach((msg) => {
          renderMessage(msg.role === 'user' ? 'user' : 'ai', msg.content, chatDisplay);
        });
        this.currentConversationId = conversationId;
      }
      scrollToBottom('ai-result-output', false);
    } catch (e) {
      renderChatError('Error loading conversation.', chatDisplay);
      this.currentConversationId = null;
      scrollToBottom('ai-result-output', false);
    }
  },

  /**
   * Handle user message submission and display streaming AI response.
   */
  async handleAPISubmission(userMessage, aiMessageDiv, textareaElement) {
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    let success = false;
    const generateButton = document.getElementById('ai-generate-button');
    const loadingIndicator = document.getElementById('ai-loading-indicator');
    if (!token) {
      if (aiMessageDiv) {
        aiMessageDiv.innerHTML = '<span class="text-danger">Error: Not logged in.</span>';
      }
      return;
    }
    try {
      const response = await sendChatMessage({ prompt: userMessage, conversationId: this.currentConversationId, token });
      if (!response.ok) throw new Error(await response.text());
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseContent = '';
      const markdownDiv = aiMessageDiv.querySelector('.markdown-content');
      if (!markdownDiv) throw new Error('Markdown display area not found.');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        aiResponseContent += chunk;
        markdownDiv.innerHTML = window.marked ? marked.parse(aiResponseContent) : escapeHtml(aiResponseContent).replace(/\n/g, '<br>');
        scrollToBottom('ai-result-output', true);
      }
      await this.fetchAndUpdateCreditsDisplay();
      success = true;
      if (textareaElement && success) {
        textareaElement.value = '';
        setTextareaHeight(textareaElement);
      }
      scrollToBottom('ai-result-output', true);
    } catch (error) {
      if (aiMessageDiv) {
        const errorDisplayTarget = aiMessageDiv.querySelector('.markdown-content') || aiMessageDiv;
        errorDisplayTarget.textContent = `Error: ${error.message}`;
        errorDisplayTarget.classList.add('text-danger');
      }
      scrollToBottom('ai-result-output', true);
    } finally {
      if (textareaElement) {
        textareaElement.disabled = false;
        if (success) setTextareaHeight(textareaElement);
      }
      if (generateButton) generateButton.disabled = false;
      if (loadingIndicator) loadingIndicator.style.display = 'none';
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
        const credits = data.credits;
        const navbarCredits = document.getElementById('navbar-user-credits');
        if (navbarCredits) navbarCredits.textContent = `Credits: ${credits}`;
      }
    } catch (e) {
      console.error('Failed to fetch updated credits:', e);
    }
  },

  /**
   * Initialize the chat (load latest conversation, set flag).
   */
  initializeChat() {
    if (ChatManager.chatInitialized) {
      console.log('[Chat] InitializeChat called, but already initialized.');
      return;
    }
    console.log('[Chat] Initializing chat...');
    ChatManager.loadLatestConversation();
    ChatManager.chatInitialized = true;
    console.log('[Chat] Chat initialized flag set to true.');
    setTimeout(() => scrollToBottom('ai-result-output', false), 100);
  },

  /**
   * Render the sidebar conversation list.
   */
  async renderSidebarConversations() {
    const sidebar = document.getElementById('chat-fullscreen-sidebar');
    const list = document.getElementById('conversation-list');
    if (!sidebar || !list) return;
    const token = window.getCurrentAccessToken ? window.getCurrentAccessToken() : null;
    if (!token) {
      list.innerHTML = '<li><span class="text-muted">Not logged in</span></li>';
      return;
    }
    try {
      const conversations = await fetchConversations(token);
      list.innerHTML = '';
      if (!Array.isArray(conversations) || conversations.length === 0) {
        list.innerHTML = '<li><span class="text-muted">No conversations</span></li>';
        return;
      }
      conversations.forEach(conv => {
        const li = document.createElement('li');
        li.textContent = conv.title || 'Untitled';
        li.title = conv.title;
        if (conv.id === this.currentConversationId) li.classList.add('active');
        li.addEventListener('click', async () => {
          if (conv.id !== this.currentConversationId) {
            await this.loadAndDisplayConversation(conv.id);
            await this.renderSidebarConversations();
          }
        });
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li><span class="text-danger">Error loading conversations</span></li>';
    }
  },

  /**
   * Toggle fullscreen UI and sidebar visibility.
   */
  toggleFullscreenUI(isFullscreen) {
    const body = document.body;
    const sidebar = document.getElementById('chat-fullscreen-sidebar'); // Sidebar element

    if (isFullscreen) {
      console.log('[FS Toggle] Entering Fullscreen');
      body.classList.add('chat-fullscreen-active');
      // Remove d-none class - CSS will handle display based on body class
      if (sidebar && sidebar.classList.contains('d-none')) {
          sidebar.classList.remove('d-none');
      }
      this.renderSidebarConversations(); // Render sidebar content

       setTimeout(() => {
            const promptInput = document.getElementById('ai-prompt-input');
            if (promptInput) setTextareaHeight(promptInput);
            scrollToBottom('ai-result-output', false);
          }, 50); // Delay helps with rendering layout changes

    } else {
      console.log('[FS Toggle] Exiting Fullscreen');
      body.classList.remove('chat-fullscreen-active');
      // IMPORTANT: Add d-none back to hide sidebar when NOT fullscreen
      // This ensures it's hidden correctly if CSS doesn't handle it alone
      if (sidebar && !sidebar.classList.contains('d-none')) {
          sidebar.classList.add('d-none');
      }

       setTimeout(() => {
           const promptInput = document.getElementById('ai-prompt-input');
           if (promptInput) setTextareaHeight(promptInput);
           // scrollToBottom('ai-result-output', false); // Scrolling usually not needed when exiting
       }, 50);
    }

    // Update zoom button icon AFTER changing body class
    const zoomButton = document.getElementById('chat-zoom-toggle');
    if (zoomButton) {
        const icon = zoomButton.querySelector('i');
        if(icon) {
             icon.className = isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen';
        }
    }
  },



  /**
   * Set up all event listeners for chat UI.
   */
  setupEventListeners() {
    document.addEventListener('DOMContentLoaded', () => {
      const chatForm = document.getElementById('ai-generation-form');
      const zoomButton = document.getElementById('chat-zoom-toggle');
      const promptInput = document.getElementById('ai-prompt-input');

      // --- Prompt Input Listeners ---
      if (promptInput) {
        promptInput.addEventListener('input', () => {
          setTextareaHeight(promptInput, true);
        });
        promptInput.addEventListener('focus', () => setTextareaHeight(promptInput));
        setTextareaHeight(promptInput); // Initial height check
        promptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const generateButton = document.getElementById('ai-generate-button');
            if (generateButton && !generateButton.disabled) {
              // Find the form and submit it programmatically
              // This is often more reliable than clicking the button
              const form = promptInput.closest('form');
              if (form) {
                  form.requestSubmit(); // Modern way to submit form via JS
              }
            }
          }
        });
      }

      // --- Zoom Button Listener ---
      if (zoomButton) {
        // Keep track of fullscreen state *outside* the listener
        // Initialize based on current body class state (in case of refresh)
        let currentFullscreenState = document.body.classList.contains('chat-fullscreen-active');

        zoomButton.addEventListener('click', () => {
          // Toggle the state
          currentFullscreenState = !currentFullscreenState;
          console.log('[Zoom Click] Toggling fullscreen. New state:', currentFullscreenState);
          // Call the UI toggle function with the NEW state
          ChatManager.toggleFullscreenUI(currentFullscreenState);
        });
      }

      // --- Chat Form Listener ---
      if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const currentPromptInput = document.getElementById('ai-prompt-input');
          const chatDisplay = document.getElementById('chat-message-list');
          const currentGenerateButton = document.getElementById('ai-generate-button');
          const currentLoadingIndicator = document.getElementById('ai-loading-indicator');
          if (!currentPromptInput || !chatDisplay || !currentGenerateButton || !currentLoadingIndicator) {
            console.error("Chat form submit: Missing required elements.");
            return;
          }
          const userMessage = currentPromptInput.value.trim();
          if (!userMessage) {
            return; // Don't submit empty messages
          }
          currentPromptInput.disabled = true;
          currentGenerateButton.disabled = true;
          currentLoadingIndicator.style.display = 'inline-block';
          removeInitialPrompt(chatDisplay);
          renderMessage('user', userMessage, chatDisplay);
          const aiDiv = renderAIPlaceholder(chatDisplay);
          scrollToBottom('ai-result-output', false); // Scroll user msg into view
          ChatManager.handleAPISubmission(userMessage, aiDiv, currentPromptInput);
        });
      }
       console.log("[Chat Events] All chat event listeners setup completed.");
    });
  }
};

window.ChatManager = ChatManager;
window.initializeChat = () => ChatManager.initializeChat();

ChatManager.setupEventListeners();