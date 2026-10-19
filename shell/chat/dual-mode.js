/**
 * DualMode — Sends messages to both backends simultaneously (Fase 5)
 *
 * Features:
 * - @claude → only ClaudeActivityBackend
 * - @wingman → only OpenClawBackend
 * - No @-mention in "both" mode → both backends
 * - Answers labeled per source (source: 'openclaw' | 'claude')
 * - Each answer arrives independently and is shown separately
 */
class DualMode {
  constructor(router) {
    this._router = router;
    this._enabled = false;
    this._messageCallbacks = [];
    this._typingCallbacks = [];

    // Wire up message forwarding from both backends in dual mode
    for (const backend of router.getAllBackends()) {
      backend.onMessage((msg, type) => {
        if (this._enabled) {
          for (const cb of this._messageCallbacks) cb(msg, type, backend.id);
        }
      });

      backend.onTyping((typing) => {
        if (this._enabled) {
          for (const cb of this._typingCallbacks) cb(typing, backend.id);
        }
      });
    }
  }

  /**
   * Enable or disable dual mode.
   */
  setEnabled(enabled) {
    this._enabled = enabled;
  }

  isEnabled() {
    return this._enabled;
  }

  /**
   * Parse @-mention from message text.
   * Returns { target: string, cleanText: string }
   * e.g. @antigravity, @claude, @opencode, @wingman, @all
   */
  static parseMention(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^@([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
    if (match) {
      const targetName = match[1].toLowerCase();
      const cleanText = (match[2] || '').trim();
      if (targetName === 'both' || targetName === 'all') {
        return { target: 'all', cleanText };
      }
      if (targetName === 'wingman' || targetName === 'openclaw') {
        return { target: 'openclaw', cleanText };
      }
      return { target: targetName, cleanText };
    }

    return { target: 'all', cleanText: trimmed };
  }

  /**
   * Send a message with @-mention routing.
   * - @openclaw / @wingman → only openclaw backend
   * - @<agent> (e.g. @antigravity, @claude, @opencode) → routed to that specific agent
   * - no mention or @all → broadcast to all connected backends/agents
   */
  async sendMessage(text) {
    if (!text) return;

    const { target, cleanText } = DualMode.parseMention(text);
    if (!cleanText) return;

    if (target === 'openclaw') {
      const backend = this._router.getBackend('openclaw');
      if (backend && backend.isConnected()) {
        await backend.sendMessage(cleanText);
      }
    } else if (target && target !== 'all') {
      const tandemBackend = this._router.getBackend('tandem');
      if (tandemBackend && tandemBackend.isConnected()) {
        await tandemBackend.sendMessage(cleanText, { targetAgent: target });
      } else {
        const backend = this._router.getBackend(target);
        if (backend && backend.isConnected()) {
          await backend.sendMessage(cleanText);
        }
      }
    } else {
      // Send to all connected backends/agents
      const promises = [];
      const openclaw = this._router.getBackend('openclaw');
      if (openclaw && openclaw.isConnected()) {
        promises.push(
          openclaw.sendMessage(cleanText).catch((e) => {
            console.warn('[DualMode] Failed to send to openclaw:', e.message);
          })
        );
      }
      const tandem = this._router.getBackend('tandem');
      if (tandem && tandem.isConnected()) {
        promises.push(
          tandem.sendMessage(cleanText, { targetAgent: 'all' }).catch((e) => {
            console.warn('[DualMode] Failed to send to tandem:', e.message);
          })
        );
      }
      await Promise.all(promises);
    }
  }

  onMessage(cb) { this._messageCallbacks.push(cb); }
  onTyping(cb) { this._typingCallbacks.push(cb); }
}

// Classic-script global export — consumed by shell/js/wingman/chat.js (ES module) via window.
window.DualMode = DualMode;
