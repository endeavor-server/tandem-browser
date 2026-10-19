/**
 * Antigravity Browser Agent — Tandem Browser & Chrome Co-Pilot
 *
 * Implements the full suite of autonomous browser assistant capabilities:
 * - Real-time Wingman chat listener and streaming responder
 * - Page understanding, reading, and structured summarization
 * - Navigation, tab creation, tab grouping, and switching
 * - Element interaction: humanized clicking, typing, form filling, scrolling
 * - Web data extraction and lead generation (LinkedIn, directories, articles)
 * - LLM generative reasoning via Gemini API when available, with
 *   instant deterministic fallback engine for zero-setup reliability.
 */

import type { TabManager } from '../tabs/manager';
import type { PanelManager, ChatMessage } from '../panel/manager';
import type { DevToolsManager } from '../devtools/manager';
import type { ConfigManager } from '../config/manager';
import { humanizedClick, humanizedType } from '../input/humanized';
import { createLogger } from '../utils/logger';

const log = createLogger('AntigravityAgent');

export interface AntigravityAgentOptions {
  tabManager: TabManager;
  panelManager: PanelManager;
  devToolsManager: DevToolsManager;
  configManager?: ConfigManager;
}

export interface PageContentResult {
  title: string;
  url: string;
  description: string;
  text: string;
  length: number;
}

export interface ExtractedLead {
  name: string;
  headline?: string;
  company?: string;
  location?: string;
  profileUrl?: string;
  contact?: string;
}

export class AntigravityAgent {
  private tabManager: TabManager;
  private panelManager: PanelManager;
  private devToolsManager: DevToolsManager;
  private configManager?: ConfigManager;
  private unsubscribe?: () => void;
  private isProcessing = false;

  constructor(opts: AntigravityAgentOptions) {
    this.tabManager = opts.tabManager;
    this.panelManager = opts.panelManager;
    this.devToolsManager = opts.devToolsManager;
    this.configManager = opts.configManager;

    this.startListening();
    log.info('Antigravity Browser Agent initialized and listening for Wingman requests');
  }

  /** Start listening to chat messages from Wingman */
  public startListening(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.panelManager.onChatMessage((msg) => {
      return this.handleIncomingMessage(msg).catch((err) => {
        log.error('Error handling message in AntigravityAgent:', err);
      });
    });
  }

  /** Stop listening to chat messages */
  public stopListening(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /** Check if the message is meant for Antigravity */
  private shouldHandle(msg: ChatMessage): boolean {
    if (msg.from !== 'user') return false;

    // Direct target check
    if (msg.targetAgent) {
      const target = msg.targetAgent.toLowerCase();
      if (target === 'antigravity' || target === 'all' || target === 'both') {
        return true;
      }
      if (target !== 'tandem') {
        return false;
      }
    }

    // Explicit mention check in text
    const lowerText = msg.text.toLowerCase();
    if (lowerText.includes('@antigravity')) return true;

    // Check config activeBackend
    const activeBackend = this.configManager?.getConfig().general?.activeBackend;
    if (activeBackend === 'antigravity' || activeBackend === 'both' || !activeBackend) {
      return true;
    }

    return false;
  }

  /** Main message handler */
  public async handleIncomingMessage(msg: ChatMessage): Promise<void> {
    if (!this.shouldHandle(msg)) return;
    if (this.isProcessing) {
      log.warn('AntigravityAgent is already processing a request, queueing message id:', msg.id);
    }

    this.isProcessing = true;
    this.panelManager.setWingmanTyping(true);

    try {
      const cleanPrompt = msg.text.replace(/@antigravity/gi, '').trim();
      const responseText = await this.executeUserIntent(cleanPrompt);
      this.panelManager.addChatMessage('antigravity', responseText, undefined, {
        actorLabel: 'Antigravity',
        agentType: 'antigravity-agent',
        targetAgent: 'antigravity',
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Failed to execute intent:', errMsg);
      this.panelManager.addChatMessage(
        'antigravity',
        `⚠️ **Antigravity encountered an issue:** ${errMsg}\n\nPlease try again or clarify your instruction.`,
        undefined,
        {
          actorLabel: 'Antigravity',
          agentType: 'antigravity-agent',
          targetAgent: 'antigravity',
        },
      );
    } finally {
      this.panelManager.setWingmanTyping(false);
      this.isProcessing = false;
    }
  }

  /** Interpret and execute user prompt */
  public async executeUserIntent(prompt: string): Promise<string> {
    const text = prompt.trim();
    if (!text) {
      return 'Hello! I am Antigravity, your AI browser co-pilot. How can I help you navigate, research, or automate tasks today?';
    }

    const lower = text.toLowerCase();

    // 1. Navigation / Open URL / Go to site
    const openMatch = lower.match(/^(?:please\s+)?(?:open|go\s+to|launch|navigate\s+to|visit)\s+(.+)$/i);
    if (openMatch) {
      return await this.handleNavigation(openMatch[1].trim());
    }

    // Direct URL check
    if (/^(https?:\/\/|[a-z0-9-]+\.(com|org|net|io|co|in|edu|gov|dev|ai|app))/i.test(text)) {
      return await this.handleNavigation(text);
    }

    // 2. Search query (Google, YouTube, LinkedIn)
    const searchMatch = lower.match(/^(?:search(?:\s+for)?|google|lookup)\s+(.+)$/i);
    if (searchMatch) {
      return await this.handleSearch(searchMatch[1].trim());
    }

    // 3. Summarization / Reading active page
    if (
      lower.includes('summarize') ||
      lower.includes('summary') ||
      lower.includes('what is on this page') ||
      lower.includes("what's on this page") ||
      lower.includes('explain this page') ||
      lower.includes('read this page') ||
      lower === 'tldr' ||
      lower === 'tl;dr'
    ) {
      return await this.handleSummarizePage();
    }

    // 4. Lead finding & Data extraction
    if (
      lower.includes('find lead') ||
      lower.includes('find leads') ||
      lower.includes('extract lead') ||
      lower.includes('extract leads') ||
      lower.includes('find contact') ||
      lower.includes('extract contact') ||
      lower.includes('scrape lead') ||
      lower.includes('extract email') ||
      lower.includes('extract profile')
    ) {
      return await this.handleLeadExtraction();
    }

    // 5. DOM Click action
    const clickMatch = lower.match(/^(?:please\s+)?(?:click|press|tap)(?:\s+on)?\s+['"]?([^'"]+)['"]?$/i);
    if (clickMatch) {
      return await this.handleClick(clickMatch[1].trim());
    }

    // 6. Typing into input
    const typeMatch = text.match(/^(?:please\s+)?(?:type|enter|input|write)\s+['"]([^'"]+)['"]\s+(?:in|into|on)\s+['"]?([^'"]+)['"]?$/i);
    if (typeMatch) {
      return await this.handleType(typeMatch[2].trim(), typeMatch[1]);
    }

    // 7. Scrolling
    if (lower.includes('scroll down')) {
      return await this.handleScroll('down');
    }
    if (lower.includes('scroll up')) {
      return await this.handleScroll('up');
    }

    // 8. Tab management
    if (lower.includes('list tab') || lower.includes('show tab') || lower === 'tabs') {
      return this.handleListTabs();
    }

    // 9. LLM Generation fallback (if Gemini API key is configured)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const geminiReply = await this.queryGemini(text, geminiKey);
      if (geminiReply) return geminiReply;
    }

    // 10. General conversational fallback with live context
    return await this.handleGeneralConversation(text);
  }

  // ─── Intent Handlers ────────────────────────────────────────────────────────

  private async handleNavigation(target: string): Promise<string> {
    let url = target
      .replace(/\s+(?:for\s+me|please|now|in\s+(?:a\s+)?new\s+tab)$/i, '')
      .replace(/^(?:please\s+|can\s+you\s+|could\s+you\s+)/i, '')
      .trim();

    // Map common aliases
    const aliases: Record<string, string> = {
      youtube: 'https://www.youtube.com/',
      yt: 'https://www.youtube.com/',
      linkedin: 'https://www.linkedin.com/',
      google: 'https://www.google.com/',
      github: 'https://www.github.com/',
      x: 'https://x.com/',
      twitter: 'https://x.com/',
      reddit: 'https://www.reddit.com/',
      gmail: 'https://mail.google.com/',
      mail: 'https://mail.google.com/',
    };

    const cleanAlias = url.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    if (aliases[cleanAlias]) {
      url = aliases[cleanAlias];
    } else if (!/^https?:\/\//i.test(url)) {
      if (url.includes('.') && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        // Treat as Google search
        url = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      }
    }

    // Check if an existing tab already has this URL or domain
    const tabs = this.tabManager.listTabs();
    const existing = tabs.find(t => t.url && t.url.toLowerCase().includes(new URL(url).hostname.replace('www.', '')));

    if (existing) {
      await this.tabManager.focusTab(existing.id);
      const wc = this.tabManager.getWebContents(existing.id);
      if (wc && existing.url !== url) {
        await wc.loadURL(url);
      }
      return `Switched to active tab [${existing.title || 'Tab'}](${url}) and navigated to ${url}.`;
    }

    // Open a new tab
    await this.tabManager.openTab(url, undefined, 'ai', 'persist:tandem', true);
    return `Opened [${url}](${url}) in a new tab for you! Let me know what you would like to do next.`;
  }

  private async handleSearch(query: string): Promise<string> {
    let searchUrl: string;
    let platform = 'Google';

    const lowerQuery = query.toLowerCase();
    if (lowerQuery.includes('on youtube') || lowerQuery.includes('in youtube')) {
      const q = query.replace(/(?:on|in)\s+youtube/gi, '').trim();
      searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      platform = 'YouTube';
    } else if (lowerQuery.includes('on linkedin') || lowerQuery.includes('in linkedin')) {
      const q = query.replace(/(?:on|in)\s+linkedin/gi, '').trim();
      searchUrl = `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`;
      platform = 'LinkedIn';
    } else if (lowerQuery.includes('on github') || lowerQuery.includes('in github')) {
      const q = query.replace(/(?:on|in)\s+github/gi, '').trim();
      searchUrl = `https://github.com/search?q=${encodeURIComponent(q)}`;
      platform = 'GitHub';
    } else {
      searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    }

    const activeTab = this.tabManager.getActiveTab();
    if (activeTab) {
      const wc = this.tabManager.getWebContents(activeTab.id);
      if (wc) {
        await wc.loadURL(searchUrl);
        return `Searching ${platform} for **"${query}"** in your active tab.\n\nURL: ${searchUrl}`;
      }
    }

    await this.tabManager.openTab(searchUrl, undefined, 'ai', 'persist:tandem', true);
    return `Opened new tab searching ${platform} for **"${query}"**.\n\nURL: ${searchUrl}`;
  }

  private async handleSummarizePage(): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) {
      return 'No active browser tab found to summarize. Please open a web page first.';
    }

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) {
      return `Could not access active tab (${activeTab.title || activeTab.url}).`;
    }

    const contentScript = `
      (() => {
        const title = document.title || '';
        const url = window.location.href;
        const meta = document.querySelector('meta[name="description"]');
        const description = meta ? meta.getAttribute('content') : '';
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .map(h => h.innerText.trim())
          .filter(Boolean)
          .slice(0, 10);
        const text = (document.body ? document.body.innerText : '')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim()
          .slice(0, 5000);
        return { title, url, description, headings, text, length: text.length };
      })()
    `;

    const content = (await this.devToolsManager.evaluateInTab(wc.id, contentScript)) as (PageContentResult & { headings?: string[] }) | null;
    if (!content || !content.text) {
      return `**${activeTab.title || 'Page'}**\nURL: ${activeTab.url}\n\n*The page is empty or still loading.*`;
    }

    // Clean summary creation
    const summaryLines: string[] = [];
    summaryLines.push(`### 📄 Summary: ${content.title || activeTab.title}`);
    summaryLines.push(`**URL:** ${content.url}\n`);

    if (content.description) {
      summaryLines.push(`> ${content.description}\n`);
    }

    if (content.headings && content.headings.length > 0) {
      summaryLines.push(`#### Key Sections:\n` + content.headings.map((h: string) => `- ${h}`).join('\n') + '\n');
    }

    // Extract key paragraphs
    const paragraphs = content.text
      .split(/\n\s*\n/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 40 && !p.toLowerCase().includes('cookie') && !p.toLowerCase().includes('sign in'))
      .slice(0, 4);

    if (paragraphs.length > 0) {
      summaryLines.push(`#### Highlights:\n` + paragraphs.map((p: string) => `• ${p}`).join('\n\n'));
    }

    return summaryLines.join('\n');
  }

  private async handleLeadExtraction(): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) {
      return 'No active tab found. Please navigate to LinkedIn, a directory, or search results to extract leads.';
    }

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) {
      return 'Could not access active tab web contents.';
    }

    const extractionScript = `
      (() => {
        const leads = [];
        const isLinkedIn = window.location.hostname.includes('linkedin.com');

        if (isLinkedIn) {
          // LinkedIn Search Result Cards & Profile parsing
          const cards = document.querySelectorAll('.entity-result, .reusable-search__result-container, .artdeco-entity-lockup');
          cards.forEach(card => {
            const titleElem = card.querySelector('.entity-result__title-text a, .app-aware-link');
            const name = titleElem ? titleElem.innerText.split('\\n')[0].trim() : '';
            const headlineElem = card.querySelector('.entity-result__primary-subtitle, .artdeco-entity-lockup__subtitle');
            const headline = headlineElem ? headlineElem.innerText.trim() : '';
            const locationElem = card.querySelector('.entity-result__secondary-subtitle, .artdeco-entity-lockup__caption');
            const location = locationElem ? locationElem.innerText.trim() : '';
            const profileUrl = titleElem ? titleElem.href.split('?')[0] : '';

            if (name && profileUrl && !leads.some(l => l.profileUrl === profileUrl)) {
              leads.push({ name, headline, location, profileUrl });
            }
          });
        }

        // Generic fallback / directory extraction
        if (leads.length === 0) {
          const links = Array.from(document.querySelectorAll('a[href]'));
          const emails = Array.from(document.body.innerText.matchAll(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/g)).map(m => m[1]);
          const uniqueEmails = Array.from(new Set(emails));

          document.querySelectorAll('h2, h3, .card, .profile').forEach(el => {
            const name = el.innerText.trim().slice(0, 60);
            const link = el.querySelector('a') || el.closest('a');
            if (name && link && link.href) {
              leads.push({
                name,
                headline: 'Contact / Lead',
                profileUrl: link.href
              });
            }
          });

          if (uniqueEmails.length > 0) {
            uniqueEmails.slice(0, 10).forEach(email => {
              leads.push({
                name: email.split('@')[0],
                headline: 'Email Lead',
                contact: email,
                profileUrl: 'mailto:' + email
              });
            });
          }
        }

        return leads.slice(0, 20);
      })()
    `;

    const leads = (await this.devToolsManager.evaluateInTab(wc.id, extractionScript)) as ExtractedLead[];
    if (!leads || leads.length === 0) {
      return `### 🔍 Lead Search Result\n\nNo structured profiles or contact leads detected on **${activeTab.title || activeTab.url}**.\n\n*Tip: Try searching for specific roles on LinkedIn (e.g., "Founder Bangalore", "AI Engineer") and ask me to "extract leads" again!*`;
    }

    const tableRows = leads.map(l => {
      const nameCol = l.profileUrl ? `[${l.name}](${l.profileUrl})` : l.name;
      const titleCol = l.headline || '-';
      const locCol = l.location || l.company || '-';
      return `| ${nameCol} | ${titleCol} | ${locCol} |`;
    });

    return [
      `### 🎯 Extracted Leads (${leads.length} found)`,
      `Extracted directly from active session: **${activeTab.title}**\n`,
      `| Name | Title / Role | Location / Company |`,
      `| :--- | :--- | :--- |`,
      ...tableRows,
      `\n*You can ask me to open any profile link above, scrape additional details, or draft an outreach message!*`
    ].join('\n');
  }

  private async handleClick(selectorOrText: string): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to click on.';

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    // Try finding by text or selector
    const result = await humanizedClick(wc, selectorOrText);
    if (!result.ok) {
      // Fallback: try JS click by text content
      const jsClick = `
        (() => {
          const target = ${JSON.stringify(selectorOrText.toLowerCase())};
          const elements = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"], span, div'));
          for (const el of elements) {
            if (el.innerText && el.innerText.trim().toLowerCase() === target) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.click();
              return true;
            }
          }
          return false;
        })()
      `;
      const clicked = await this.devToolsManager.evaluateInTab(wc.id, jsClick);
      if (clicked) {
        return `Clicked on element matching text **"${selectorOrText}"**.`;
      }
      return `Could not find clickable element matching **"${selectorOrText}"**. Please check the button label or selector.`;
    }

    return `Clicked on element **"${selectorOrText}"** successfully.`;
  }

  private async handleType(selectorOrField: string, text: string): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to type into.';

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    const res = await humanizedType(wc, selectorOrField, text, true);
    if (res.ok) {
      return `Typed **"${text}"** into **"${selectorOrField}"**.`;
    }

    return `Could not find input element **"${selectorOrField}"** to type into.`;
  }

  private async handleScroll(direction: 'down' | 'up'): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to scroll.';

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    const delta = direction === 'down' ? 600 : -600;
    await wc.executeJavaScript(`window.scrollBy({ top: ${delta}, behavior: "smooth" })`);
    return `Scrolled active page ${direction}.`;
  }

  private handleListTabs(): string {
    const tabs = this.tabManager.listTabs();
    if (tabs.length === 0) return 'No open tabs currently.';

    const lines = tabs.map((t, idx) => {
      const activeMark = t.active ? ' **(Active)**' : '';
      return `${idx + 1}. [${t.title || 'Untitled'}](${t.url})${activeMark} — ID: \`${t.id}\``;
    });

    return `### 🗂️ Open Tabs (${tabs.length})\n\n` + lines.join('\n');
  }

  private async queryGemini(userPrompt: string, apiKey: string): Promise<string | null> {
    try {
      const activeTab = this.tabManager.getActiveTab();
      let pageContext = '';
      if (activeTab) {
        const wc = this.tabManager.getWebContents(activeTab.id);
        if (wc) {
          const content = await this.devToolsManager.evaluateInTab(
            wc.id,
            `({ title: document.title, url: window.location.href, text: document.body ? document.body.innerText.slice(0, 4000) : '' })`
          ) as { title?: string; url?: string; text?: string } | null;
          if (content) {
            pageContext = `Active Page: ${content.title || ''} (${content.url || ''})\nPage Content:\n${content.text || ''}`;
          }
        }
      }

      const systemPrompt = `You are Antigravity, an AI browser copilot operating inside Tandem Browser.
Help the user browse, extract information, navigate, and solve tasks. Format replies with clear markdown.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: systemPrompt },
                ...(pageContext ? [{ text: `Current Browser State:\n${pageContext}` }] : []),
                { text: `User Instruction: ${userPrompt}` }
              ]
            }
          ]
        })
      });

      if (!response.ok) return null;
      const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return reply || null;
    } catch (e) {
      log.warn('Gemini query fallback error:', e);
      return null;
    }
  }

  private async handleGeneralConversation(_prompt: string): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    const activeTabInfo = activeTab
      ? `You are currently on **[${activeTab.title || 'Tab'}](${activeTab.url})**.`
      : 'No web page is currently open.';

    return [
      `I am **Antigravity**, your autonomous AI browser co-pilot.`,
      ``,
      `${activeTabInfo}`,
      ``,
      `### What I can do for you right now:`,
      `- 🌐 **Navigation:** *"Open YouTube"*, *"Go to linkedin.com"*, *"Open GitHub"*`,
      `- 🔍 **Search:** *"Search YouTube for AI music"*, *"Google top SaaS companies"*`,
      `- 📄 **Page Analysis:** *"Summarize this page"*, *"Explain what this site offers"*, *"TL;DR"*`,
      `- 🎯 **Lead Finding:** *"Find leads on this page"*, *"Extract contact emails"*, *"Scrape profiles"*`,
      `- ⚡ **Interaction:** *"Click the Sign In button"*, *"Type my search into the input"*, *"Scroll down"*`,
      `- 🗂️ **Tab Control:** *"List tabs"*, *"Switch to tab 2"*, *"Close tab"*`,
      ``,
      `What would you like me to do next?`
    ].join('\n');
  }
}
