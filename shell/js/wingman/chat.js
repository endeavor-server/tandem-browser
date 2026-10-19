/**
 * Wingman chat — multi-backend router orchestration, backend selector UI,
 * send + input handlers, image paste, connection status.
 *
 * Loaded from: shell/js/wingman/index.js
 * window exports: chatRouter — set by index.js from initChat() return.
 *   (Kept as window binding for classic scripts and main-process IPC.)
 *
 * External globals used (loaded via classic <script> tags in shell/index.html
 * BEFORE this module): window.ChatRouter, window.TandemLocalBackend,
 * window.OpenClawBackend, window.ClaudeActivityBackend, window.DualMode.
 * They are not ES modules; their files export onto window.
 *
 * initChat() return shape matches prior `chatRouter` object:
 *   { ensureConnected, disconnect, router, dualMode, sendMessage }
 *
 * Notes on return shape:
 *   - `sendMessage(text)` is a raw programmatic send (no image-paste plumbing,
 *     no input-field clearing, no typing-indicator toggle). It's used by
 *     main-process inject flows and the chat-inject IPC handler. For the
 *     interactive send path, see the internal `sendMessage` wired to the
 *     input field's Enter handler and the send button click.
 *   - `router` and `dualMode` are exposed so external code (classic scripts,
 *     IPC handlers) can observe or drive the underlying state without
 *     going through the UI. Treat both as read-mostly; mutating router
 *     state from outside will desync the selector UI.
 */

import { createStreamingRenderer } from './chat-streaming.js';

export function initChat() {
  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const typingEl = document.getElementById('typing-indicator');
  const wsDot = document.getElementById('ws-dot');
  const wsStatusText = document.getElementById('ws-status-text');
  const backendSelector = document.getElementById('chat-backend-selector');

  // Safety check
  if (!messagesEl || !inputEl || !sendBtn || !typingEl || !wsDot || !wsStatusText) {
    console.error('[chatRouter] Missing required DOM elements, chat will not initialize');
    return { ensureConnected() { }, disconnect() { } };
  }



  const renderer = createStreamingRenderer({ messagesEl });
  const {
    appendMessage,
    handleRouterMessage,
    handleDualMessage,
    clear: clearStreaming,
  } = renderer;

  async function persistChatMessage(from, text, image, notifyWebhook = false) {
    if (!window.tandem?.persistChatMessage) return false;
    try {
      const result = await window.tandem.persistChatMessage({ from, text, image, notifyWebhook });
      return Boolean(result?.ok);
    } catch {
      return false;
    }
  }

  // ── Router setup ──
  // Router/backends are classic scripts (shell/chat/*.js) exporting on window.

  const router = new window.ChatRouter();
  const tandemBackend = new window.TandemLocalBackend();
  const openclawBackend = new window.OpenClawBackend();
  const claudeBackend = new window.ClaudeActivityBackend();

  router.register(tandemBackend);
  router.register(openclawBackend);
  router.register(claudeBackend);

  // ── DualMode setup (Fase 5) ──
  // Must happen AFTER backends are registered — the DualMode constructor
  // iterates router.getAllBackends().
  const dualMode = new window.DualMode(router);
  let currentMode = 'tandem'; // 'tandem' | 'openclaw' | 'claude' | 'both'

  // ── Backend selector UI (Dynamic agent discovery) ──

  function isChannelConnected(id) {
    if (id === 'openclaw') return openclawBackend.isConnected();
    if (id === 'both') {
      return tandemBackend.isConnected() || openclawBackend.isConnected();
    }
    return tandemBackend.isConnected();
  }

  function getAvailableChannels() {
    const agents = tandemBackend.getConnectedAgents?.() || [];
    const primary = tandemBackend.getPrimaryAgent?.();
    const channels = [];

    const matchesKey = (agent, key) => {
      const type = (agent.type || '').toLowerCase();
      const label = (agent.label || '').toLowerCase();
      return type.includes(key) || label.includes(key);
    };

    // Antigravity agent
    const antigravityAgent = agents.find((a) => matchesKey(a, 'antigravity'));
    if (antigravityAgent) {
      channels.push({
        id: 'antigravity',
        label: antigravityAgent.label || 'Antigravity',
        title: 'Chat with Antigravity',
      });
    }

    // Claude agent
    const claudeAgent = agents.find((a) => matchesKey(a, 'claude'));
    if (claudeAgent) {
      channels.push({
        id: 'claude',
        label: claudeAgent.label || 'Claude',
        title: 'Chat with Claude',
      });
    }

    // OpenCode agent
    const opencodeAgent = agents.find((a) => matchesKey(a, 'opencode'));
    if (opencodeAgent) {
      channels.push({
        id: 'opencode',
        label: opencodeAgent.label || 'OpenCode',
        title: 'Chat with OpenCode',
      });
    }

    // Any other custom connected agents
    for (const a of agents) {
      if (
        !matchesKey(a, 'antigravity') &&
        !matchesKey(a, 'claude') &&
        !matchesKey(a, 'opencode') &&
        !matchesKey(a, 'openclaw')
      ) {
        const id = (a.type || a.label || a.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (id && !channels.some((c) => c.id === id)) {
          channels.push({
            id,
            label: a.label || id,
            title: `Chat with ${a.label || id}`,
          });
        }
      }
    }

    // OpenClaw (if configured or connected)
    const hasOpenClaw = agents.some((a) => matchesKey(a, 'openclaw')) || openclawBackend.isConnected();
    if (hasOpenClaw) {
      channels.push({
        id: 'openclaw',
        label: 'OpenClaw',
        title: 'Use the local OpenClaw gateway',
      });
    }

    // If no agents are connected, provide Tandem fallback
    if (channels.length === 0) {
      channels.push({
        id: 'tandem',
        label: primary?.label || 'Tandem',
        title: "Use Tandem's built-in MCP/API chat",
      });
    }

    // If 2 or more channels are available, add "All" mode
    if (channels.length >= 2) {
      channels.push({
        id: 'both',
        label: 'All',
        title: 'Send to every connected backend / agent',
      });
    }

    return channels;
  }

  function getChannelLabel(id) {
    if (id === 'both') return 'All Agents';
    if (id === 'openclaw') return 'OpenClaw';
    if (id === 'antigravity') return 'Antigravity';
    if (id === 'claude') return 'Claude';
    if (id === 'opencode') return 'OpenCode';
    if (id === 'tandem') return 'Tandem Wingman';
    const found = getAvailableChannels().find((c) => c.id === id);
    return found ? found.label : id;
  }

  function renderBackendSelector() {
    if (!backendSelector) return;
    const channels = getAvailableChannels();

    backendSelector.replaceChildren();

    for (const ch of channels) {
      const btn = document.createElement('button');
      btn.className = `backend-option ${currentMode === ch.id ? 'active' : ''}`;
      btn.id = `btn-backend-${ch.id}`;
      btn.title = ch.title;
      btn.dataset.channelId = ch.id;

      const dot = document.createElement('span');
      dot.className = `backend-dot ${isChannelConnected(ch.id) ? 'connected' : ''}`;
      dot.id = `dot-${ch.id}`;

      const text = document.createElement('span');
      text.textContent = ch.label;

      btn.append(dot, text);
      btn.addEventListener('click', () => switchBackend(ch.id));
      backendSelector.appendChild(btn);
    }

    backendSelector.style.display = channels.length > 0 ? 'flex' : 'none';

    if (!channels.some((c) => c.id === currentMode)) {
      const fallback = channels[0]?.id || 'tandem';
      switchBackend(fallback);
    }
  }

  function updateBackendUI(activeId) {
    if (backendSelector) {
      for (const btn of backendSelector.querySelectorAll('.backend-option')) {
        const chId = btn.dataset.channelId;
        btn.classList.toggle('active', chId === activeId);
        const dot = btn.querySelector('.backend-dot');
        if (dot) {
          dot.classList.toggle('connected', isChannelConnected(chId));
        }
      }
    }

    const connected = isChannelConnected(activeId);
    wsDot.style.background = connected ? 'var(--success)' : 'var(--accent)';

    const label = getChannelLabel(activeId);
    if (activeId === 'both') {
      wsStatusText.textContent = connected ? 'All Agents Connected' : 'Agents Disconnected';
      inputEl.placeholder = 'Message to all connected agents... (@agent for specific)';
    } else {
      wsStatusText.textContent = connected ? `${label} Connected` : `${label} Disconnected`;
      inputEl.placeholder = `Message to ${label}... (@agent for specific)`;
    }

    // Update typing indicator text
    const typingText = typingEl.querySelector('span:last-child');
    if (typingText) {
      if (activeId === 'both') {
        typingText.textContent = 'Agents are thinking...';
      } else {
        typingText.textContent = `${label} is typing...`;
      }
    }
  }

  function switchBackend(id) {
    // Store any locally typed user messages before clearing
    const localRobinMessages = [];
    for (const child of messagesEl.children) {
      if (child.classList.contains('user') && child.dataset.localMessage === 'true') {
        localRobinMessages.push({
          role: 'user',
          text: child.querySelector('.msg-text').textContent,
          timestamp: child.querySelector('.msg-time').textContent,
          source: 'user',
        });
      }
    }

    currentMode = id;
    clearStreaming();

    if (id === 'both') {
      // In "both" mode, enable dualMode and target all
      dualMode.setEnabled(true);
      tandemBackend.setTargetAgent('all');
      tandemBackend.loadHistory((msgs) => {
        for (const m of msgs) {
          const el = appendMessage(m.role, m.text, m.timestamp, m.source, m.image, m.actorLabel);
          el.dataset.fromHistory = 'true';
        }
        for (const localMsg of localRobinMessages) {
          const el = appendMessage(localMsg.role, localMsg.text, localMsg.timestamp, localMsg.source, localMsg.image);
          el.dataset.localMessage = 'true';
        }
      });
    } else if (id === 'openclaw') {
      dualMode.setEnabled(false);
      router.setActive('openclaw');
      openclawBackend.loadHistory((msgs) => {
        for (const m of msgs) {
          const el = appendMessage(m.role, m.text, m.timestamp, m.source, m.image, m.actorLabel);
          el.dataset.fromHistory = 'true';
        }
        for (const localMsg of localRobinMessages) {
          const el = appendMessage(localMsg.role, localMsg.text, localMsg.timestamp, localMsg.source, localMsg.image);
          el.dataset.localMessage = 'true';
        }
      });
    } else {
      dualMode.setEnabled(false);
      const targetAgent = id === 'tandem' ? null : id;
      tandemBackend.setTargetAgent(targetAgent);
      router.setActive('tandem');
      tandemBackend.loadHistory((msgs) => {
        for (const m of msgs) {
          const el = appendMessage(m.role, m.text, m.timestamp, m.source, m.image, m.actorLabel);
          el.dataset.fromHistory = 'true';
        }
        for (const localMsg of localRobinMessages) {
          const el = appendMessage(localMsg.role, localMsg.text, localMsg.timestamp, localMsg.source, localMsg.image);
          el.dataset.localMessage = 'true';
        }
      });
    }

    updateBackendUI(id);

    // Persist choice to config
    fetch('http://localhost:8765/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ general: { activeBackend: id } }),
    }).catch(() => { });
  }

  // ── Connection status listeners ──

  router.onConnectionChange(() => {
    updateBackendUI(currentMode);
  });

  tandemBackend.onAgentsChanged(() => {
    renderBackendSelector();
    updateBackendUI(currentMode);
  });

  // Render initial selector state
  renderBackendSelector();

  // ── Message handling ──

  router.onMessage((msg, type, backendId) => {
    handleRouterMessage(msg, type, backendId, { currentMode, persistChatMessage });
  });

  dualMode.onMessage((msg, type, backendId) => {
    handleDualMessage(msg, type, backendId, { persistChatMessage });
  });

  router.onTyping((typing) => {
    if (currentMode !== 'both') {
      typingEl.classList.toggle('active', typing);
    }
  });

  dualMode.onTyping((typing, backendId) => {
    // In dual mode, show typing if any backend is typing
    typingEl.classList.toggle('active', typing);
    const typingText = typingEl.querySelector('span:last-child');
    if (typingText && typing) {
      let name = 'AI';
      if (backendId === 'openclaw') name = 'Wingman';
      else if (backendId === 'antigravity') name = 'Antigravity';
      else if (backendId === 'claude') name = 'Claude';
      else if (backendId === 'opencode') name = 'OpenCode';
      typingText.textContent = `${name} is typing...`;
    }
  });

  router.onSwitch((id) => {
    if (currentMode !== 'both') {
      updateBackendUI(id);
    }
  });

  // ── Image paste/drop support ──

  let pendingImage = null; // base64 data URL
  const imagePreviewEl = document.getElementById('chat-image-preview');

  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          pendingImage = reader.result;
          showImagePreview(pendingImage);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });

  inputEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  inputEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        pendingImage = reader.result;
        showImagePreview(pendingImage);
      };
      reader.readAsDataURL(file);
    }
  });

  function showImagePreview(dataUrl) {
    imagePreviewEl.replaceChildren();
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Preview';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-preview';
    removeBtn.title = 'Remove image';
    removeBtn.textContent = '✕';
    imagePreviewEl.append(img, removeBtn);
    imagePreviewEl.style.display = 'block';
    removeBtn.addEventListener('click', () => {
      clearImagePreview();
    });
  }

  function clearImagePreview() {
    pendingImage = null;
    imagePreviewEl.innerHTML = '';
    imagePreviewEl.style.display = 'none';
  }

  // ── Send message (input + button) ──

  async function sendMessage() {
    const text = inputEl.value.trim();

    // Image paste: send via IPC (before text-only check)
    if (pendingImage) {
      const imageData = pendingImage;
      clearImagePreview();
      inputEl.value = '';
      inputEl.style.height = '';

      // Show local preview immediately
      const robinMsg = appendMessage('user', text || '', Date.now(), 'user');
      robinMsg.dataset.localMessage = 'true';
      const msgText = robinMsg.querySelector('.msg-text');
      const img = document.createElement('img');
      img.src = imageData;
      img.className = 'chat-msg-image';
      img.addEventListener('click', () => window.open(imageData, '_blank'));
      msgText.appendChild(img);

      // Send to main process via IPC
      if (window.tandem?.sendChatImage) {
        window.tandem.sendChatImage(text, imageData);
      }
      return;
    }

    if (!text) return;

    inputEl.value = '';
    inputEl.style.height = '';

    if (currentMode === 'both') {
      // Dual/All mode: parse @-mentions, send to appropriate backends
      const { cleanText } = window.DualMode.parseMention(text);
      if (!cleanText) return;

      // Show user message (display original text with @-mention for clarity)
      const robinMsg = appendMessage('user', text, Date.now(), 'user');
      robinMsg.dataset.localMessage = 'true';

      await dualMode.sendMessage(text);
    } else {
      // Single backend mode
      const activeId = currentMode;

      // OpenClaw: send through the official gateway chat path.
      if (activeId === 'openclaw') {
        const robinMsg = appendMessage('user', text, Date.now(), 'user');
        robinMsg.dataset.localMessage = 'true';
        const sentViaGateway = await router.sendMessage(text);
        if (sentViaGateway) {
          void persistChatMessage('user', text);
        } else {
          appendMessage('assistant', '⚠️ Wingman could not reach OpenClaw.', Date.now(), 'wingman');
        }
      } else {
        if (!tandemBackend.isConnected()) return;
        const { target, cleanText } = window.DualMode.parseMention(text);
        if (target && target !== 'all' && target !== activeId) {
          await tandemBackend.sendMessage(cleanText, { targetAgent: target });
        } else {
          await tandemBackend.sendMessage(text, { targetAgent: activeId === 'tandem' ? undefined : activeId });
        }
      }
    }
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = '';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });
  sendBtn.addEventListener('click', sendMessage);

  // Quick Action Chips listener
  document.querySelectorAll('.w-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cmd = chip.dataset.cmd;
      if (cmd) {
        inputEl.value = cmd;
        sendMessage();
      }
    });
  });

  // ── Voice Dictation (🎙️ Speak-to-Browse) ──
  const micBtn = document.getElementById('chat-mic-btn');
  let recognition = null;
  let isListening = false;

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (micBtn && SpeechRec) {
    recognition = new SpeechRec();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('listening');
      inputEl.placeholder = '🎙️ Listening... speak your command';
    };

    recognition.onresult = (e) => {
      let transcript = '';
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        transcript += e.results[i][0].transcript;
      }
      inputEl.value = transcript;
      inputEl.style.height = '';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
    };

    recognition.onerror = (e) => {
      console.warn('[VoiceDictation] Error:', e.error);
      isListening = false;
      micBtn.classList.remove('listening');
      inputEl.placeholder = 'Message to Wingman or type /...';
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.classList.remove('listening');
      inputEl.placeholder = 'Message to Wingman or type /...';
      inputEl.focus();
    };

    micBtn.addEventListener('click', () => {
      if (!isListening) {
        try {
          recognition.start();
        } catch (err) {
          console.warn('[VoiceDictation] Start error:', err);
        }
      } else {
        recognition.stop();
      }
    });
  } else if (micBtn) {
    micBtn.addEventListener('click', () => {
      alert('Speech recognition is not supported in this view.');
    });
  }

  // ── Initialize ──

  // Load saved backend from config.
  router.connectAll();
  fetch('http://localhost:8765/config')
    .then((r) => r.json())
    .then((cfg) => {
      const saved = cfg.general && cfg.general.activeBackend;
      if (saved) {
        switchBackend(saved);
      } else {
        switchBackend('tandem');
      }
    })
    .catch(() => switchBackend('tandem'));

  // Listen for incoming Wingman messages pushed via POST /chat API
  if (window.tandem && window.tandem.onChatMessage) {
    window.tandem.onChatMessage((msg) => {
      // msg: {id, from, text, timestamp, image}
      // Skip user messages — already shown optimistically in the UI
      if (msg.clear) {
        clearStreaming();
        return;
      }
      if (msg.from === 'user') return;
      const source = msg.from; // 'wingman' or 'claude'
      appendMessage('assistant', msg.text, msg.timestamp, source, msg.image, msg.actorLabel);
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  return {
    ensureConnected() { router.connectAll(); },
    disconnect() { router.disconnectAll(); },
    router,
    dualMode,
    sendMessage(text) {
      if (currentMode === 'both') return dualMode.sendMessage(text);
      return router.sendMessage(text);
    }
  };
}
