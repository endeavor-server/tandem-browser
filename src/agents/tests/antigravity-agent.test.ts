import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AntigravityAgent } from '../antigravity-agent';

describe('AntigravityAgent', () => {
  let mockTabManager: any;
  let mockPanelManager: any;
  let mockDevToolsManager: any;
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
  });

  it('subscribes to onChatMessage on initialization', () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager
    });

    expect(mockPanelManager.onChatMessage).toHaveBeenCalled();
    expect(chatListener).not.toBeNull();
  });

  it('ignores messages from non-user senders', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager
    });

    await chatListener!({ id: 1, from: 'antigravity', text: 'Hello', targetAgent: 'antigravity' });
    expect(mockPanelManager.setWingmanTyping).not.toHaveBeenCalled();
    expect(mockPanelManager.addChatMessage).not.toHaveBeenCalled();
  });

  it('handles navigation requests like "open youtube for me"', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager
    });

    await chatListener!({
      id: 2,
      from: 'user',
      text: 'open youtube for me',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.setWingmanTyping).toHaveBeenCalledWith(true);
    expect(mockPanelManager.setWingmanTyping).toHaveBeenCalledWith(false);
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('YouTube'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity', agentType: 'antigravity-agent' })
    );
  });

  it('handles "summarize this page"', async () => {
    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager
    });

    await chatListener!({
      id: 3,
      from: 'user',
      text: 'summarize this page',
      targetAgent: 'antigravity'
    });

    expect(mockDevToolsManager.evaluateInTab).toHaveBeenCalled();
    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Summary'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });

  it('handles lead extraction requests', async () => {
    mockDevToolsManager.evaluateInTab.mockResolvedValueOnce([
      { name: 'John Doe', headline: 'AI Founder', location: 'San Francisco', profileUrl: 'https://linkedin.com/in/johndoe' }
    ]);

    new AntigravityAgent({
      tabManager: mockTabManager,
      panelManager: mockPanelManager,
      devToolsManager: mockDevToolsManager
    });

    await chatListener!({
      id: 4,
      from: 'user',
      text: 'find leads on this page',
      targetAgent: 'antigravity'
    });

    expect(mockPanelManager.addChatMessage).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Extracted Leads'),
      undefined,
      expect.objectContaining({ actorLabel: 'Antigravity' })
    );
  });
});
