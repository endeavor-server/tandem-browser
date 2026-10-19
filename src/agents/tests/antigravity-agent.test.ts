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
});
