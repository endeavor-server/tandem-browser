/**
 * TandemLocalBackend - Wingman chat over Tandem's own HTTP API.
 *
 * This keeps the Wingman panel useful without a local OpenClaw install. Agents
 * can read Robin's messages through MCP/HTTP and reply back into the same
 * local chat history.
 */
class TandemLocalBackend {
  constructor() {
    this.id = 'tandem';
    this.name = 'Tandem Local';
    this.icon = 'T';

    this._connected = false;
    this._pollTimer = null;
    this._pollInterval = 1500;
    this._lastSeenId = 0;
    this._apiBase = window.tandemApi?.baseUrl() || window.__TANDEM_API_BASE__ || 'http://127.0.0.1:8765';
    this._primaryAgent = null;
    this._connectedAgents = [];
    this._targetAgent = null;
    this._statusPollCounter = 0;

    this._messageCallbacks = [];
    this._typingCallbacks = [];
    this._connectionCallbacks = [];
    this._agentsCallbacks = [];
  }

  async connect() {
    try {
      const res = await fetch(`${this._apiBase}/chat/status`);
      if (!res.ok) {
        this._setConnected(false);
        return;
      }
      const status = await res.json();
      this._applyStatus(status);
      for (const cb of this._agentsCallbacks) cb(this._connectedAgents);
      this._setConnected(true);
      await this._loadHistory();
      this._startPolling();
    } catch (e) {
      console.warn('[TandemLocalBackend] API not reachable:', e.message);
      this._setConnected(false);
    }
  }

  async disconnect() {
    this._stopPolling();
    this._setConnected(false);
  }

  isConnected() {
    return this._connected;
  }

  setTargetAgent(agent) {
    this._targetAgent = agent || null;
  }

  getTargetAgent() {
    return this._targetAgent;
  }

  onAgentsChanged(cb) {
    this._agentsCallbacks.push(cb);
  }

  async sendMessage(text, options = {}) {
    if (!text) return false;
    try {
      const targetAgent = options.targetAgent !== undefined ? options.targetAgent : this._targetAgent;
      const body = { text, from: 'user' };
      if (targetAgent && targetAgent !== 'tandem') {
        body.targetAgent = targetAgent;
      }
      const res = await fetch(`${this._apiBase}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) return false;
      const data = await res.json();
      const msg = data.message || {};
      this._trackSeen(msg);
      this._emit('message', this._toUiMessage(msg));
      return true;
    } catch (e) {
      console.warn('[TandemLocalBackend] Send failed:', e.message);
      this._setConnected(false);
      return false;
    }
  }

  onMessage(cb) { this._messageCallbacks.push(cb); }
  onTyping(cb) { this._typingCallbacks.push(cb); }
  onConnectionChange(cb) { this._connectionCallbacks.push(cb); }

  async loadHistory(onMessages) {
    const messages = await this._fetchHistory(50);
    if (typeof onMessages === 'function') {
      onMessages(messages);
    }
  }

  getPrimaryAgent() {
    return this._primaryAgent;
  }

  getConnectedAgents() {
    return [...this._connectedAgents];
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._poll(), this._pollInterval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      this._statusPollCounter = (this._statusPollCounter || 0) + 1;
      if (this._statusPollCounter % 5 === 0) {
        fetch(`${this._apiBase}/chat/status`)
          .then((r) => (r.ok ? r.json() : null))
          .then((status) => {
            if (status) {
              this._applyStatus(status);
              for (const cb of this._agentsCallbacks) cb(this._connectedAgents);
            }
          })
          .catch(() => {});
      }

      const res = await fetch(`${this._apiBase}/chat/messages?since_id=${this._lastSeenId}`);
      if (!res.ok) {
        this._setConnected(false);
        return;
      }
      if (!this._connected) this._setConnected(true);

      const data = await res.json();
      const messages = data.messages || [];
      for (const msg of messages) {
        this._trackSeen(msg);
        if (msg.from !== 'user') {
          this._emit('message', this._toUiMessage(msg));
        }
      }
    } catch {
      this._setConnected(false);
    }
  }

  async _loadHistory() {
    const messages = await this._fetchHistory(50);
    if (messages.length > 0) {
      this._emit('historyReload', messages);
    }
  }

  async _fetchHistory(limit) {
    try {
      const res = await fetch(`${this._apiBase}/chat/messages?limit=${limit}`);
      if (!res.ok) return [];
      const data = await res.json();
      const messages = data.messages || [];
      const parsed = [];
      for (const msg of messages) {
        this._trackSeen(msg);
        parsed.push(this._toUiMessage(msg));
      }
      return parsed;
    } catch (e) {
      console.warn('[TandemLocalBackend] History load failed:', e.message);
      return [];
    }
  }

  _toUiMessage(msg) {
    const from = msg?.from || 'wingman';
    let source;
    let actorLabel = msg?.actorLabel;

    if (from === 'user') {
      source = 'user';
    } else {
      const checkStr = `${from} ${actorLabel || ''}`.toLowerCase();
      if (checkStr.includes('antigravity')) {
        source = 'antigravity';
        actorLabel = actorLabel || 'Antigravity';
      } else if (checkStr.includes('claude')) {
        source = 'claude';
        actorLabel = actorLabel || 'Claude';
      } else if (checkStr.includes('opencode')) {
        source = 'opencode';
        actorLabel = actorLabel || 'OpenCode';
      } else if (checkStr.includes('codex')) {
        source = 'codex';
        actorLabel = actorLabel || 'Codex';
      } else if (from === 'wingman' && this._primaryAgent) {
        source = this._primaryAgent.type || 'wingman';
        actorLabel = actorLabel || this._primaryAgent.label;
      } else {
        source = from;
        actorLabel = actorLabel || (from === 'wingman' ? this._primaryAgent?.label : from);
      }
    }

    return {
      id: msg?.id?.toString?.() || crypto.randomUUID(),
      role: from === 'user' ? 'user' : 'assistant',
      text: msg?.text || '',
      source,
      actorLabel,
      timestamp: msg?.timestamp || Date.now(),
      image: msg?.image,
      targetAgent: msg?.targetAgent
    };
  }

  _applyStatus(status) {
    this._connectedAgents = Array.isArray(status?.connectedAgents)
      ? status.connectedAgents.filter((agent) => agent && typeof agent.type === 'string')
      : [];

    const primary = status?.primaryAgent;
    if (primary && typeof primary.label === 'string' && primary.label.trim()) {
      this._primaryAgent = {
        id: primary.id || null,
        label: primary.label.trim(),
        type: primary.type || 'agent'
      };
      this.name = this._primaryAgent.label;
    } else {
      this._primaryAgent = null;
      this.name = 'Tandem Local';
    }
  }

  _trackSeen(msg) {
    if (typeof msg?.id === 'number' && msg.id > this._lastSeenId) {
      this._lastSeenId = msg.id;
    }
  }

  _setConnected(connected) {
    if (this._connected !== connected) {
      this._connected = connected;
      for (const cb of this._connectionCallbacks) cb(connected);
    }
  }

  _emit(type, data) {
    if (type === 'message' || type === 'historyReload') {
      for (const cb of this._messageCallbacks) cb(data, type);
    } else if (type === 'typing') {
      for (const cb of this._typingCallbacks) cb(data);
    }
  }
}

// Classic-script global export — consumed by shell/js/wingman/chat.js (ES module) via window.
window.TandemLocalBackend = TandemLocalBackend;
