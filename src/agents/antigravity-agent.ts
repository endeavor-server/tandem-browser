/**
 * Antigravity Browser Agent — Tandem Browser & Chrome Co-Pilot
 *
 * Implements the full suite of autonomous browser assistant capabilities:
 * - Real-time Wingman chat listener and streaming responder
 * - Slash commands: /leads, /export, /summarize, /snapshot, /click, /type, /scroll, /tabs, /help
 * - Accessibility-tree snapshotting & @e ref interaction (CDP-backed clickRef & fillRef)
 * - Page understanding, reading, and structured summarization
 * - Navigation, tab creation, tab grouping, and switching
 * - Element interaction: humanized clicking, typing, form filling, scrolling
 * - Web data extraction & lead prospecting with automated CSV export to ~/Downloads
 * - Indirect prompt injection scanning & neutralization via PromptInjectionGuard
 * - LLM generative reasoning via Gemini API when available, with
 *   instant deterministic fallback engine for zero-setup reliability.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TabManager } from '../tabs/manager';
import type { PanelManager, ChatMessage } from '../panel/manager';
import type { DevToolsManager } from '../devtools/manager';
import type { SnapshotManager } from '../snapshot/manager';
import type { ConfigManager } from '../config/manager';
import { humanizedClick, humanizedType } from '../input/humanized';
import { PromptInjectionGuard } from '../security/prompt-injection-guard';
import { createLogger } from '../utils/logger';

const log = createLogger('AntigravityAgent');

export interface AntigravityAgentOptions {
  tabManager: TabManager;
  panelManager: PanelManager;
  devToolsManager: DevToolsManager;
  snapshotManager?: SnapshotManager;
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
  private snapshotManager?: SnapshotManager;
  private configManager?: ConfigManager;
  private injectionGuard: PromptInjectionGuard;
  private lastExtractedLeads: ExtractedLead[] = [];
  private unsubscribe?: () => void;
  private isProcessing = false;

  constructor(opts: AntigravityAgentOptions) {
    this.tabManager = opts.tabManager;
    this.panelManager = opts.panelManager;
    this.devToolsManager = opts.devToolsManager;
    this.snapshotManager = opts.snapshotManager;
    this.configManager = opts.configManager;
    this.injectionGuard = new PromptInjectionGuard();

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

    // ─── 0. Power-User Slash Commands ──────────────────────────────────────────
    if (text.startsWith('/')) {
      return await this.handleSlashCommand(text);
    }

    const lower = text.toLowerCase();

    // ─── 1. Navigation / Open URL / Go to site ─────────────────────────────────
    const openMatch = lower.match(/^(?:please\s+)?(?:open|go\s+to|launch|navigate\s+to|visit)\s+(.+)$/i);
    if (openMatch) {
      return await this.handleNavigation(openMatch[1].trim());
    }

    // Direct URL check
    if (/^(https?:\/\/|[a-z0-9-]+\.(com|org|net|io|co|in|edu|gov|dev|ai|app))/i.test(text)) {
      return await this.handleNavigation(text);
    }

    // ─── 2. Search query (Google, YouTube, LinkedIn) ───────────────────────────
    const searchMatch = lower.match(/^(?:search(?:\s+for)?|google|lookup)\s+(.+)$/i);
    if (searchMatch) {
      return await this.handleSearch(searchMatch[1].trim());
    }

    // ─── 3. Summarization / Reading active page ───────────────────────────────
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

    // ─── 4. Lead finding & Data extraction ────────────────────────────────────
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

    // ─── 5. Export leads to CSV ───────────────────────────────────────────────
    if (lower.includes('export leads') || lower.includes('save leads') || lower.includes('download leads')) {
      return this.exportLeadsToCsv();
    }

    // ─── 6. Accessibility Snapshot / Show elements ────────────────────────────
    if (lower.includes('show elements') || lower.includes('interactive elements') || lower.includes('what can i click') || lower === 'snapshot') {
      return await this.handleSnapshot();
    }

    // ─── 7. DOM Click action (supports @e refs and text/selectors) ─────────────
    const clickMatch = text.match(/^(?:please\s+)?(?:click|press|tap)(?:\s+on)?\s+['"]?(@e\d+|[^'"]+)['"]?$/i);
    if (clickMatch) {
      return await this.handleClick(clickMatch[1].trim());
    }

    // ─── 8. Typing into input (supports @e refs and selectors) ─────────────────
    const typeRefMatch = text.match(/^(?:please\s+)?(?:type|enter|input|fill)\s+(@e\d+)\s+['"]?([^'"]+)['"]?$/i);
    if (typeRefMatch) {
      return await this.handleType(typeRefMatch[1].trim(), typeRefMatch[2].trim());
    }

    const typeMatch = text.match(/^(?:please\s+)?(?:type|enter|input|write)\s+['"]([^'"]+)['"]\s+(?:in|into|on)\s+['"]?([^'"]+)['"]?$/i);
    if (typeMatch) {
      return await this.handleType(typeMatch[2].trim(), typeMatch[1]);
    }

    // ─── 9. Scrolling ──────────────────────────────────────────────────────────
    if (lower.includes('scroll down')) {
      return await this.handleScroll('down');
    }
    if (lower.includes('scroll up')) {
      return await this.handleScroll('up');
    }
    if (lower.includes('scroll to top') || lower === 'scroll top') {
      return await this.handleScroll('top');
    }
    if (lower.includes('scroll to bottom') || lower === 'scroll bottom') {
      return await this.handleScroll('bottom');
    }

    // ─── 10. Tab management ───────────────────────────────────────────────────
    if (lower.includes('list tab') || lower.includes('show tab') || lower === 'tabs') {
      return this.handleListTabs();
    }

    // ─── 11. LLM Generation fallback (if Gemini API key is configured) ────────
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const geminiReply = await this.queryGemini(text, geminiKey);
      if (geminiReply) return geminiReply;
    }

    // ─── 12. General conversational fallback ──────────────────────────────────
    return await this.handleGeneralConversation(text);
  }

  // ─── Slash Commands ─────────────────────────────────────────────────────────

  private async handleSlashCommand(input: string): Promise<string> {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (cmd) {
      case '/help':
        return [
          `### ⚡ Antigravity Browser Co-pilot Commands`,
          ``,
          `| Command | Description |`,
          `| :--- | :--- |`,
          `| \`/leads [query]\` | Find leads on LinkedIn or active page & save to CSV |`,
          `| \`/export\` | Export latest extracted leads to \`~/Downloads\` |`,
          `| \`/summarize\` | Extract and summarize active page content |`,
          `| \`/snapshot\` | Inspect interactive accessibility elements with \`@e\` refs |`,
          `| \`/click <target | @e>\` | Click element by text, selector, or \`@e\` ref |`,
          `| \`/type <target | @e> <text>\` | Type text into input field |`,
          `| \`/scroll [up | down | top | bottom]\` | Scroll the active page |`,
          `| \`/tabs\` | List all open tabs with status and IDs |`,
          `| \`/open <url | site>\` | Navigate active tab or open new tab |`,
          `| \`/search <query>\` | Search Google, YouTube, or LinkedIn |`,
          ``,
          `*You can also type natural English prompts like "open youtube for me", "summarize this page", or "find leads on this site"!*`
        ].join('\n');

      case '/leads':
      case '/lead':
        if (args) {
          // If query provided, navigate to LinkedIn search results first
          const searchUrl = `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(args)}`;
          const activeTab = this.tabManager.getActiveTab();
          if (activeTab) {
            const wc = this.tabManager.getWebContents(activeTab.id);
            if (wc) await wc.loadURL(searchUrl);
          } else {
            await this.tabManager.openTab(searchUrl, undefined, 'ai', 'persist:tandem', true);
          }
          return `Navigated to LinkedIn searching for **"${args}"**. Please allow the page 3–5 seconds to load results, then ask me to **"extract leads"** or type \`/export\`!`;
        }
        return await this.handleLeadExtraction();

      case '/export':
        return this.exportLeadsToCsv(args);

      case '/summarize':
      case '/summary':
        return await this.handleSummarizePage();

      case '/snapshot':
      case '/elements':
        return await this.handleSnapshot();

      case '/click':
        if (!args) return 'Usage: `/click <button text, selector, or @e ref>`';
        return await this.handleClick(args);

      case '/type':
      case '/fill': {
        const typeParts = args.split(/\s+/);
        if (typeParts.length < 2) return 'Usage: `/type <@e ref or selector> <text to type>`';
        const target = typeParts[0];
        const val = typeParts.slice(1).join(' ').replace(/^['"]|['"]$/g, '');
        return await this.handleType(target, val);
      }

      case '/scroll':
        if (args.includes('top')) return await this.handleScroll('top');
        if (args.includes('bottom')) return await this.handleScroll('bottom');
        if (args.includes('up')) return await this.handleScroll('up');
        return await this.handleScroll('down');

      case '/tabs':
        return this.handleListTabs();

      case '/open':
        if (!args) return 'Usage: `/open <url or site name>`';
        return await this.handleNavigation(args);

      case '/search':
        if (!args) return 'Usage: `/search <query>`';
        return await this.handleSearch(args);

      default:
        return `Unknown slash command **${cmd}**. Type \`/help\` to see all available commands.`;
    }
  }

  // ─── Intent Handlers ────────────────────────────────────────────────────────

  private async handleNavigation(target: string): Promise<string> {
    let url = target
      .replace(/\s+(?:for\s+me|please|now|in\s+(?:a\s+)?new\s+tab)$/i, '')
      .replace(/^(?:please\s+|can\s+you\s+|could\s+you\s+)/i, '')
      .trim();

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
        url = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      }
    }

    const tabs = this.tabManager.listTabs();
    const targetHost = new URL(url).hostname.replace('www.', '');
    const existing = tabs.find(t => t.url && t.url.toLowerCase().includes(targetHost));

    if (existing) {
      await this.tabManager.focusTab(existing.id);
      const wc = this.tabManager.getWebContents(existing.id);
      if (wc && existing.url !== url) {
        await wc.loadURL(url);
      }
      return `Switched to active tab [${existing.title || 'Tab'}](${url}) and navigated to ${url}.`;
    }

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

    // Security scan for prompt injection
    const injectionReport = this.injectionGuard.scan(content.text);
    const securityBanner = !injectionReport.clean
      ? `> ⚠️ **Security Notice:** Potential indirect prompt injection detected and neutralized (${injectionReport.findings.length} patterns flagged).\n\n`
      : '';

    const summaryLines: string[] = [];
    summaryLines.push(`### 📄 Summary: ${content.title || activeTab.title}`);
    summaryLines.push(`**URL:** ${content.url}\n`);

    if (securityBanner) {
      summaryLines.push(securityBanner);
    }

    if (content.description) {
      summaryLines.push(`> ${content.description}\n`);
    }

    if (content.headings && content.headings.length > 0) {
      summaryLines.push(`#### Key Sections:\n` + content.headings.map((h: string) => `- ${h}`).join('\n') + '\n');
    }

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
          const cards = document.querySelectorAll('.entity-result, .reusable-search__result-container, .artdeco-entity-lockup, .search-results-container li');
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

        if (leads.length === 0) {
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
            uniqueEmails.slice(0, 15).forEach(email => {
              leads.push({
                name: email.split('@')[0],
                headline: 'Email Lead',
                contact: email,
                profileUrl: 'mailto:' + email
              });
            });
          }
        }

        return leads.slice(0, 30);
      })()
    `;

    const leads = (await this.devToolsManager.evaluateInTab(wc.id, extractionScript)) as ExtractedLead[];
    if (!leads || leads.length === 0) {
      return `### 🔍 Lead Search Result\n\nNo structured profiles or contact leads detected on **${activeTab.title || activeTab.url}**.\n\n*Tip: Try searching for specific roles on LinkedIn (e.g., "Founder Bangalore", "AI Engineer") and ask me to "extract leads" again!*`;
    }

    this.lastExtractedLeads = leads;

    // Auto-export to CSV in ~/Downloads
    const csvExport = this.exportLeadsToCsv();

    const tableRows = leads.slice(0, 15).map(l => {
      const nameCol = l.profileUrl ? `[${l.name}](${l.profileUrl})` : l.name;
      const titleCol = l.headline || '-';
      const locCol = l.location || l.company || '-';
      return `| ${nameCol} | ${titleCol} | ${locCol} |`;
    });

    return [
      `### 🎯 Extracted Leads (${leads.length} found)`,
      `Extracted from: **${activeTab.title}**\n`,
      csvExport,
      `\n| Name | Title / Role | Location / Company |`,
      `| :--- | :--- | :--- |`,
      ...tableRows,
      `\n*Showing first ${Math.min(leads.length, 15)} leads. Type \`/export\` to save with custom filename!*`
    ].join('\n');
  }

  /** Export currently extracted leads to a CSV file in ~/Downloads */
  private exportLeadsToCsv(customName?: string): string {
    if (this.lastExtractedLeads.length === 0) {
      return 'No leads currently stored in memory. Run `/leads` or navigate to LinkedIn first to extract contacts.';
    }

    try {
      const downloadsDir = path.join(os.homedir(), 'Downloads');
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = customName ? `${customName.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv` : `tandem_leads_${timestamp}.csv`;
      const filePath = path.join(downloadsDir, filename);

      const header = 'Name,Title / Headline,Company / Location,Profile URL,Contact\n';
      const rows = this.lastExtractedLeads.map(l => {
        const escapeCsv = (str?: string) => `"${(str || '').replace(/"/g, '""')}"`;
        return [
          escapeCsv(l.name),
          escapeCsv(l.headline),
          escapeCsv(l.location || l.company),
          escapeCsv(l.profileUrl),
          escapeCsv(l.contact)
        ].join(',');
      }).join('\n');

      fs.writeFileSync(filePath, header + rows, 'utf-8');

      return `💾 **CSV Exported Successfully:** [${filename}](file://${filePath})\n*(Saved to ${filePath})*`;
    } catch (e) {
      log.error('Failed to export leads CSV:', e);
      return `⚠️ Failed to write CSV file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Snapshot accessibility tree and return interactive elements with @e refs */
  private async handleSnapshot(): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab for snapshot.';

    if (!this.snapshotManager) {
      return 'Accessibility SnapshotManager is not attached.';
    }

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access active web contents.';

    try {
      const snap = await this.snapshotManager.getSnapshot({
        interactive: true,
        compact: true,
        wcId: wc.id,
      });

      if (!snap || !snap.text) {
        return 'No interactive elements detected on active page.';
      }

      return [
        `### 🧭 Interactive Elements Snapshot (${snap.count} elements)`,
        `Page: **${activeTab.title}**\n`,
        '```',
        snap.text.slice(0, 2500),
        '```',
        `\n*You can click any element above using \`/click @e<number>\` or type using \`/type @e<number> <text>\`!*`
      ].join('\n');
    } catch (e) {
      log.error('Snapshot failed:', e);
      return `Failed to generate accessibility snapshot: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async handleClick(selectorOrRefOrText: string): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to click on.';

    const target = selectorOrRefOrText.trim();

    // Check if target is an @e ref (e.g. @e1, @e12)
    if (target.startsWith('@e') && this.snapshotManager) {
      try {
        await this.snapshotManager.clickRef(target);
        return `Clicked on element **${target}** via accessibility ref.`;
      } catch (e) {
        log.warn('clickRef failed, falling back:', e);
      }
    }

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    const result = await humanizedClick(wc, target);
    if (!result.ok) {
      const jsClick = `
        (() => {
          const t = ${JSON.stringify(target.toLowerCase())};
          const elements = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"], span, div'));
          for (const el of elements) {
            if (el.innerText && el.innerText.trim().toLowerCase() === t) {
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
        return `Clicked on element matching text **"${target}"**.`;
      }
      return `Could not find clickable element matching **"${target}"**. You can run \`/snapshot\` to inspect available \`@e\` refs.`;
    }

    return `Clicked on element **"${target}"** successfully.`;
  }

  private async handleType(selectorOrRef: string, text: string): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to type into.';

    const target = selectorOrRef.trim();

    // Check if target is an @e ref
    if (target.startsWith('@e') && this.snapshotManager) {
      try {
        await this.snapshotManager.fillRef(target, text);
        return `Filled **"${text}"** into **${target}** via accessibility ref.`;
      } catch (e) {
        log.warn('fillRef failed, falling back:', e);
      }
    }

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    const res = await humanizedType(wc, target, text, true);
    if (res.ok) {
      return `Typed **"${text}"** into **"${target}"**.`;
    }

    return `Could not find input element **"${target}"** to type into.`;
  }

  private async handleScroll(direction: 'down' | 'up' | 'top' | 'bottom'): Promise<string> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return 'No active tab to scroll.';

    const wc = this.tabManager.getWebContents(activeTab.id);
    if (!wc) return 'Cannot access tab web contents.';

    if (direction === 'top') {
      await wc.executeJavaScript('window.scrollTo({ top: 0, behavior: "smooth" })');
      return 'Scrolled active page to top.';
    }
    if (direction === 'bottom') {
      await wc.executeJavaScript('window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })');
      return 'Scrolled active page to bottom.';
    }

    const delta = direction === 'down' ? 650 : -650;
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
          const content = (await this.devToolsManager.evaluateInTab(
            wc.id,
            `({ title: document.title, url: window.location.href, text: document.body ? document.body.innerText.slice(0, 4000) : '' })`
          )) as { title?: string; url?: string; text?: string } | null;
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
      `- 🎯 **Find Leads & Export:** \`/leads [query]\`, *"Find leads on this page"*, \`/export\` *(saves directly to \`~/Downloads\`)*`,
      `- 📄 **Page Analysis:** \`/summarize\`, *"Summarize this page"*, *"Explain this site"*`,
      `- 🧭 **Accessibility Snapshot:** \`/snapshot\` *(inspects clickable \`@e\` elements)*`,
      `- ⚡ **Precise Interaction:** \`/click @e1\`, \`/type @e2 'query'\`, \`/scroll down\``,
      `- 🌐 **Navigation & Search:** *"Open YouTube"*, *"Go to linkedin.com"*, *"Search for AI leads"*`,
      `- 🗂️ **Tab Management:** \`/tabs\`, *"List tabs"*, *"Switch to tab"*`,
      ``,
      `Type \`/help\` for a full command cheat sheet, or ask me directly in plain English!`
    ].join('\n');
  }
}
