import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AntigravityAgent } from '../antigravity-agent';

describe('AntigravityAgent Phase 1 Capabilities', () => {
  let mockTabManager: any;
  let mockPanelManager: any;
  let mockDevToolsManager: any;
  let mockSnapshotManager: any;
  let chatListener: ((msg: any) => void) | null = null;

  beforeEach(() => {
    chatListener = null;

    mockTabManager = {
      listTabs: vi.fn().mockReturnValue([
        { id: 'tab-1', url: 'https://www.youtube.com/', title: 'YouTube', active: true }
      ]),
      getActiveTab: vi.fn().mockReturnValue({
        id: 'tab-1',
        url: 'https://www.youtube.com/',
        title: 'YouTube',
        active: true
      }),
      openTab: vi.fn().mockResolvedValue({
        id: 'tab-2',
        url: 'https://www.google.com/',
        title: 'Google',
        active: true
      }),
      focusTab: vi.fn().mockResolvedValue(true),
      getWebContents: vi.fn().mockReturnValue({
        id: 10,
        loadURL: vi.fn().mockResolvedValue(undefined),
        executeJavaScript: vi.fn().mockResolvedValue(undefined)
      })
    };

    mockPanelManager = {
      onChatMessage: vi.fn().mockImplementation((fn) => {
        chatListener = fn;
        return () => { chatListener = null; };
      }),
      addChatMessage: vi.fn(),
      setWingmanTyping: vi.fn()
    };

    mockDevToolsManager = {
      evaluateInTab: vi.fn().mockResolvedValue({
        title: 'YouTube',
        url: 'https://www.youtube.com/',
        text: 'Welcome to YouTube. Enjoy the videos.'
      })
    };

    mockSnapshotManager = {
      getSnapshot: vi.fn().mockResolvedValue({
        text: '@e1 [button] "Search"\n@e2 [textbox] "Search Google"',
        count: 2,
        url: 'https://www.google.com/'
      }),
      clickRef: vi.fn().mockResolvedValue({ ok: true }),
      fillRef: vi.fn().mockResolvedValue({ ok: true })
    };
  });

  it('subscribes to onChatMessage on initialization', () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    expect(mockPanelManager.onChatMessage).toHaveBeenCalled();
    expect(chatListener).not.toBeNull();
  });

  it('handles /help slash command', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 1,
      from: 'user',
      text: '/help',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('/leads'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /snapshot command using SnapshotManager', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 2,
      from: 'user',
      text: '/snapshot',
      targetAgent: 'antigravity'
    });

    expect(mockSnapshotManager.getSnapshot).toHaveBeenCalled();
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('@e1'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /click @e1 ref-based clicking', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 3,
      from: 'user',
      text: '/click @e1',
      targetAgent: 'antigravity'
    });

    expect(mockSnapshotManager.clickRef).toHaveBeenCalledWith('@e1');
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('@e1'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /type @e2 ref-based typing', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 4,
      from: 'user',
      text: "/type @e2 'AI Engineer'",
      targetAgent: 'antigravity'
    });

    expect(mockSnapshotManager.fillRef).toHaveBeenCalledWith('@e2', 'AI Engineer');
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Filled'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles lead extraction with LinkedIn safety shield banner', async () => {
    mockDevToolsManager.evaluateInTab.mockResolvedValueOnce([
      { name: 'Alice Smith', headline: 'VP of AI', location: 'London', profileUrl: 'https://linkedin.com/in/alicesmith' }
    ]);

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 5,
      from: 'user',
      text: '/leads',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('LinkedIn Account Safety'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /enrich command safely with human delays and tab cleanup', async () => {
    mockDevToolsManager.evaluateInTab
      // First call for /leads
      .mockResolvedValueOnce([
        { name: 'Bob Jones', headline: 'CTO', location: 'Bengaluru', profileUrl: 'https://linkedin.com/in/bobjones' }
      ])
      // Second call for profile enrichment
      .mockResolvedValueOnce({
        headline: 'CTO at DeepTech',
        about: 'Passionate AI architect',
        experience: 'DeepTech Systems',
        location: 'Bengaluru, India'
      });

    mockTabManager.openTab.mockResolvedValueOnce({
      id: 'tab-worker-1',
      url: 'https://linkedin.com/in/bobjones'
    });
    mockTabManager.closeTab = vi.fn().mockResolvedValue(true);

    const agent = new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    // Mock safeDelay to be fast during unit tests
    (agent as any).safetyGovernor.safeDelay = vi.fn().mockResolvedValue(undefined);

    // Initial lead extraction
    await chatListener!({
      id: 6,
      from: 'user',
      text: '/leads',
      targetAgent: 'antigravity'
    });

    // Run /enrich
    await chatListener!({
      id: 7,
      from: 'user',
      text: '/enrich 1',
      targetAgent: 'antigravity'
    });

    expect(mockTabManager.openTab).toHaveBeenCalledWith(
      'https://linkedin.com/in/bobjones',
      undefined,
      'ai',
      'persist:tandem',
      false
    );
    expect(mockTabManager.closeTab).toHaveBeenCalledWith('tab-worker-1');
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('LinkedIn Profile Enrichment Complete'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles multi-step compound autonomous goal "open youtube and search for jazz"', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 8,
      from: 'user',
      text: 'open youtube and search for jazz',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Step 1/2'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Autonomous Co-pilot'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /dismiss slash command to auto-sweep overlays', async () => {
    mockDevToolsManager.evaluateInTab.mockResolvedValueOnce({ dismissed: true, target: '#onetrust-accept-btn-handler' });

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 9,
      from: 'user',
      text: '/dismiss',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Auto-Dismissed Overlay'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /extract command to extract structured table data', async () => {
    mockDevToolsManager.evaluateInTab.mockResolvedValueOnce({
      type: 'table',
      items: [
        { Product: 'MacBook Pro', Price: '$2499', Rating: '5 stars' },
        { Product: 'iPad Pro', Price: '$999', Rating: '4.8 stars' }
      ]
    });

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 10,
      from: 'user',
      text: '/extract',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Extracted Structured Data (2 items'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles account creation intent "create one new gmail for me"', async () => {
    mockDevToolsManager.evaluateInTab
      .mockResolvedValueOnce({ dismissed: false }) // autoDismissOverlays
      .mockResolvedValueOnce([                      // form fields inspect
        { type: 'text', label: 'First name' },
        { type: 'text', label: 'Last name' }
      ]);

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 11,
      from: 'user',
      text: 'create one new gmail for me',
      targetAgent: 'antigravity'
    });

    expect(mockTabManager.openTab).toHaveBeenCalledWith(
      'https://accounts.google.com/signup',
      undefined,
      'ai',
      'persist:tandem',
      true
    );
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Navigated to Gmail / Google Account Sign-Up'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles login intent "log in to github"', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 12,
      from: 'user',
      text: 'log in to github',
      targetAgent: 'antigravity'
    });

    expect(mockTabManager.openTab).toHaveBeenCalledWith(
      'https://github.com/login',
      undefined,
      'ai',
      'persist:tandem',
      true
    );
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Navigated to GitHub Login'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles clicking on first search result "click the first result"', async () => {
    mockDevToolsManager.evaluateInTab
      .mockResolvedValueOnce({ dismissed: false }) // autoDismissOverlays
      .mockResolvedValueOnce({ ok: true, text: 'GitHub: Let’s build from here', url: 'https://github.com' });

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 13,
      from: 'user',
      text: 'click the first result',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Clicked on result #1'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /persona command to view and manage persona vault', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 14,
      from: 'user',
      text: '/persona',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Smart Persona Vault'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /autofill command to populate detected form fields', async () => {
    mockDevToolsManager.evaluateInTab
      .mockResolvedValueOnce({ dismissed: false }) // autoDismissOverlays
      .mockResolvedValueOnce({
        filled: [
          { field: 'firstName', value: 'Alex', label: 'firstName' },
          { field: 'lastName', value: 'Mercer', label: 'lastName' }
        ],
        totalInputs: 2
      });

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 15,
      from: 'user',
      text: '/autofill',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('1-Click Form Autofill Complete'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles /compare command for parallel price synthesis', async () => {
    mockDevToolsManager.evaluateInTab
      .mockResolvedValue({ title: 'Apple MacBook Pro M3', price: '$1,599.00', link: 'https://amazon.com/mbp' });

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager,
      snapshotManager: mockSnapshotManager
    });

    await chatListener!({
      id: 16,
      from: 'user',
      text: '/compare macbook pro m3',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Multi-Store Comparison'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('formats visual action breadcrumb trails correctly', () => {
    const trail = AntigravityAgent.formatBreadcrumbs(['🌐 Navigated', '🧹 Swept Overlays', '⚡ Autofilled']);
    expect(trail).toContain('breadcrumb-trail');
    expect(trail).toContain('breadcrumb-step');
    expect(trail).toContain('Action Timeline:');
    expect(trail).toContain('🌐 Navigated');
    expect(trail).toContain('⚡ Autofilled');
  });
});
