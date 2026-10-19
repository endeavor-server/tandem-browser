import type { Router, Request, Response } from 'express';
import fs from 'fs';
import type { RouteContext } from '../context';
import { handleRouteError } from '../../utils/errors';
import { getErrorMessage } from '../../utils/security';
import { createRateLimitMiddleware } from '../rate-limit';

interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeChatSender(from: unknown): string {
  if (typeof from !== 'string') return 'wingman';
  const normalized = from.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'wingman';
}

function deriveActorLabel(sender: string, explicitLabel: unknown): string | undefined {
  if (typeof explicitLabel === 'string' && explicitLabel.trim()) {
    return explicitLabel.trim().slice(0, 80);
  }
  if (sender === 'user') return undefined;
  const s = sender.toLowerCase();
  if (s === 'codex') return 'Codex';
  if (s === 'claude' || s === 'claude-code') return 'Claude';
  if (s === 'antigravity' || s === 'antigravity-agent') return 'Antigravity';
  if (s === 'opencode' || s === 'open-code') return 'OpenCode';
  if (s === 'openclaw') return 'OpenClaw';
  if (s === 'wingman') return undefined;
  return sender
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .slice(0, 80);
}

function getPrimaryChatAgent(ctx: RouteContext): { id: string; label: string; type: string } | null {
  const paired = ctx.pairingManager
    .listBindings()
    .filter(binding => binding.state === 'paired');
  const local = paired.find(binding => binding.bindingKind === 'local') ?? paired[0];
  if (!local) return null;
  return {
    id: local.id,
    label: local.agentLabel,
    type: local.agentType,
  };
}

function parseChatLimit(rawLimit: unknown): number {
  const limit = parseInt(String(rawLimit ?? ''), 10);
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(limit, 200);
}

function parseSinceId(rawSinceId: unknown): number | null {
  const sinceId = parseInt(String(rawSinceId ?? ''), 10);
  if (!Number.isFinite(sinceId) || sinceId <= 0) return null;
  return sinceId;
}

function renderGooglePhotosAuthPage(opts: { ok: boolean; title: string; message: string; detail?: string }): string {
  return `<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 24px;">
    <h1>${opts.title}</h1>
    <p id="status-message"></p>
    <p id="status-detail"></p>
    <script>
      const tandemAuthPayload = ${JSON.stringify({ type: 'tandem-google-photos-auth', ok: opts.ok })};
      const tandemStatusMessage = ${JSON.stringify(opts.message)};
      const tandemStatusDetail = ${JSON.stringify(opts.detail ?? '')};
      const statusEl = document.getElementById('status-message');
      const detailEl = document.getElementById('status-detail');
      if (statusEl) {
        statusEl.textContent = tandemStatusMessage;
      }
      if (detailEl) {
        detailEl.textContent = tandemStatusDetail;
      }
      if (window.opener) {
        window.opener.postMessage(tandemAuthPayload, '*');
      }
      if (${opts.ok ? 'true' : 'false'}) {
        window.close();
      }
    </script>
  </body>
</html>`;
}

function getScreenshotCurrentUrl(ctx: RouteContext): string {
  return ctx.tabManager.getActiveTab()?.url || 'tandem://window';
}

function parseScreenshotRegion(body: unknown): ScreenshotRegion | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;

  if (![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }

  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
  };
}

/**
 * Register Wingman panel, chat, activity log, audio recording, and draw overlay routes.
 * @param router - Express router to attach routes to
 * @param ctx - shared manager registry and main BrowserWindow
 */
export function registerMediaRoutes(router: Router, ctx: RouteContext): void {
  // ═══════════════════════════════════════════════
  // PANEL — Wingman side panel
  // ═══════════════════════════════════════════════

  router.post('/panel/toggle', (req: Request, res: Response) => {
    try {
      const { open } = req.body;
      const isOpen = ctx.panelManager.togglePanel(open);
      res.json({ ok: true, open: isOpen });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  // ═══════════════════════════════════════════════
  // CHAT — Wingman chat messages
  // ═══════════════════════════════════════════════

  /** Get chat messages (supports ?since_id= for polling) */
  /** Get chat messages (supports ?since_id= for polling, ?agent= or ?target_agent= for filtering) */
  const getChatMessages = (req: Request, res: Response) => {
    try {
      const targetAgent = typeof req.query.agent === 'string'
        ? req.query.agent
        : (typeof req.query.target_agent === 'string' ? req.query.target_agent : undefined);
      const sinceId = parseSinceId(req.query.since_id);
      if (sinceId) {
        const messages = targetAgent
          ? ctx.panelManager.getChatMessagesSince(sinceId, targetAgent)
          : ctx.panelManager.getChatMessagesSince(sinceId);
        res.json({ messages });
      } else {
        const limit = parseChatLimit(req.query.limit);
        const messages = targetAgent
          ? ctx.panelManager.getChatMessages(limit, targetAgent)
          : ctx.panelManager.getChatMessages(limit);
        res.json({ messages });
      }
    } catch (e) {
      handleRouteError(res, e);
    }
  };
  router.get('/chat', getChatMessages);
  router.get('/chat/messages', getChatMessages);

  /** Send chat message (default: wingman, 'from' param allows robin/claude, 'targetAgent' allows targeting specific agent) */
  const postChatMessage = (req: Request, res: Response) => {
    const { text, from, image, actorLabel, agentType, targetAgent } = req.body;
    if (!text && !image) { res.status(400).json({ error: 'text or image required' }); return; }
    const primaryAgent = getPrimaryChatAgent(ctx);
    const sender = normalizeChatSender(from ?? primaryAgent?.type);
    const resolvedActorLabel = deriveActorLabel(sender, actorLabel ?? (sender === primaryAgent?.type ? primaryAgent?.label : undefined));
    try {
      let savedImage: string | undefined;
      if (image) {
        savedImage = ctx.panelManager.saveImage(image);
      }
      const msg = ctx.panelManager.addChatMessage(sender, text || '', savedImage, {
        actorLabel: resolvedActorLabel,
        agentType: typeof agentType === 'string' ? agentType : primaryAgent?.type,
        targetAgent: typeof targetAgent === 'string' ? targetAgent : undefined,
      });
      res.json({ ok: true, message: msg });
    } catch (e) {
      handleRouteError(res, e);
    }
  };
  router.post('/chat', postChatMessage);
  router.post('/chat/messages', postChatMessage);

  /** Clear chat messages for the local Tandem chat bus. */
  const deleteChatMessages = (_req: Request, res: Response) => {
    try {
      ctx.panelManager.clearChatMessages();
      res.json({ ok: true, cleared: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  };
  router.delete('/chat', deleteChatMessages);
  router.delete('/chat/messages', deleteChatMessages);

  /** Wait briefly for new chat messages without forcing MCP clients to poll tightly. */
  router.get('/chat/wait', async (req: Request, res: Response) => {
    const targetAgent = typeof req.query.agent === 'string'
      ? req.query.agent
      : (typeof req.query.target_agent === 'string' ? req.query.target_agent : undefined);
    const sinceId = parseSinceId(req.query.since_id) ?? 0;
    const timeoutMs = Math.min(parseInt(String(req.query.timeout_ms ?? '30000'), 10) || 30_000, 30_000);
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < timeoutMs) {
        const messages = ctx.panelManager.getChatMessagesSince(sinceId, targetAgent);
        if (messages.length > 0) {
          res.json({ messages, timedOut: false });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      res.json({ messages: [], timedOut: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /** Local chat bus health/status for renderer backends and agents. */
  router.get('/chat/status', (_req: Request, res: Response) => {
    try {
      const recent = ctx.panelManager.getChatMessages(1);
      const lastMessageId = recent[0]?.id ?? 0;
      const connectedAgents = ctx.pairingManager
        .listBindings()
        .filter(binding => binding.state === 'paired')
        .map(binding => ({
          id: binding.id,
          label: binding.agentLabel,
          type: binding.agentType,
          bindingKind: binding.bindingKind,
          transportModes: binding.transportModes,
          lastUsedAt: binding.lastUsedAt,
        }));
      const primaryAgent = getPrimaryChatAgent(ctx);
      res.json({
        ok: true,
        backend: 'tandem',
        available: true,
        lastMessageId,
        primaryAgent,
        connectedAgents,
      });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /** Serve chat images */
  router.get('/chat/image/:filename', createRateLimitMiddleware({
    bucket: 'media-chat-image',
    windowMs: 60_000,
    max: 120,
    message: 'Too many chat image requests. Retry shortly.',
  }), (req: Request, res: Response) => {
    const filename = req.params.filename as string;
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    const filePath = ctx.panelManager.getImagePath(filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }
    res.sendFile(filePath);
  });

  /** Set Wingman typing indicator */
  router.post('/chat/typing', (req: Request, res: Response) => {
    try {
      const { typing = true } = req.body;
      ctx.panelManager.setWingmanTyping(typing);
      res.json({ ok: true, typing });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  /** Test webhook connectivity */
  router.post('/chat/webhook/test', async (_req: Request, res: Response) => {
    try {
      const config = ctx.configManager.getConfig();
      if (!config.webhook?.enabled || !config.webhook?.url) {
        res.json({ ok: false, error: 'Webhook not configured or disabled' });
        return;
      }

      const url = config.webhook.url.replace(/\/$/, '');
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });

      res.json({
        ok: response.ok,
        status: response.status,
        url: config.webhook.url,
      });
    } catch (e) {
      res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ═══════════════════════════════════════════════
  // VOICE — Speech recognition control
  // ═══════════════════════════════════════════════

  router.post('/voice/start', (_req: Request, res: Response) => {
    try {
      ctx.voiceManager.start();
      res.json({ ok: true, listening: true });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/voice/stop', (_req: Request, res: Response) => {
    try {
      ctx.voiceManager.stop();
      res.json({ ok: true, listening: false });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/voice/status', (_req: Request, res: Response) => {
    try {
      const status = ctx.voiceManager.getStatus();
      res.json(status);
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  // ═══════════════════════════════════════════════
  // AUDIO CAPTURE
  // ═══════════════════════════════════════════════

  router.post('/audio/start', async (_req: Request, res: Response) => {
    try {
      const result = await ctx.videoRecorderManager.startRecording('application');
      res.json(result);
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/audio/stop', async (_req: Request, res: Response) => {
    try {
      const result = await ctx.videoRecorderManager.stopRecording();
      res.json(result);
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/audio/status', (_req: Request, res: Response) => {
    try {
      res.json(ctx.videoRecorderManager.getStatus());
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/audio/recordings', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const recordings = ctx.videoRecorderManager.listRecordings(limit);
      res.json({ recordings });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  // ═══════════════════════════════════════════════
  // DRAW — Annotated screenshots
  // ═══════════════════════════════════════════════

  router.get('/screenshot/annotated', (_req: Request, res: Response) => {
    try {
      const png = ctx.drawManager.getLastScreenshot();
      if (!png) {
        res.status(404).json({ error: 'No annotated screenshot available' });
        return;
      }
      res.type('png').send(png);
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/screenshot/annotated', async (_req: Request, res: Response) => {
    try {
      const activeTab = ctx.tabManager.getActiveTab();
      const wcId = activeTab ? activeTab.webContentsId : null;
      const result = await ctx.drawManager.captureAnnotated(wcId);
      if (result.ok) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/screenshot/application', async (_req: Request, res: Response) => {
    try {
      const result = await ctx.drawManager.captureApplicationScreenshot(getScreenshotCurrentUrl(ctx));
      if (result.ok) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/screenshot/region', async (req: Request, res: Response) => {
    const region = parseScreenshotRegion(req.body);
    if (!region) {
      res.status(400).json({ error: 'x, y, width, and height are required numbers' });
      return;
    }

    try {
      const result = await ctx.drawManager.captureRegionScreenshot(region, getScreenshotCurrentUrl(ctx));
      if (result.ok) {
        res.json(result);
        return;
      }

      const status = result.error === 'Selected region is too small' ? 400 : 500;
      res.status(status).json(result);
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/draw/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      const isEnabled = ctx.drawManager.toggleDrawMode(enabled);
      res.json({ ok: true, drawMode: isEnabled });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/screenshots', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const screenshots = ctx.drawManager.listScreenshots(limit);
      res.json({ screenshots });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/integrations/google-photos/status', (_req: Request, res: Response) => {
    try {
      res.json({
        ...ctx.googlePhotosManager.getStatus(),
        clientId: ctx.googlePhotosManager.getClientId(),
      });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/google-photos/config', (req: Request, res: Response) => {
    try {
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
      const status = ctx.googlePhotosManager.setClientId(clientId);
      res.json({
        ok: true,
        ...status,
        clientId: ctx.googlePhotosManager.getClientId(),
      });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/google-photos/connect', createRateLimitMiddleware({
    bucket: 'media-google-photos-connect',
    windowMs: 60_000,
    max: 10,
    message: 'Too many Google Photos connect requests. Retry shortly.',
  }), (req: Request, res: Response) => {
    try {
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
      if (clientId) {
        ctx.googlePhotosManager.setClientId(clientId);
      }
      const authUrl = ctx.googlePhotosManager.beginAuth();
      res.json({ ok: true, authUrl });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/google-photos/disconnect', (_req: Request, res: Response) => {
    try {
      res.json({
        ok: true,
        ...ctx.googlePhotosManager.disconnect(),
      });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.get('/google-photos/oauth/callback', createRateLimitMiddleware({
    bucket: 'media-google-photos-callback',
    windowMs: 60_000,
    max: 30,
    message: 'Too many Google Photos callback requests. Retry shortly.',
  }), async (req: Request, res: Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const error = typeof req.query.error === 'string' ? req.query.error : undefined;
      await ctx.googlePhotosManager.completeAuth({ code, state, error });
      res.type('html').send(renderGooglePhotosAuthPage({
        ok: true,
        title: 'Google Photos connected',
        message: 'You can close this window and return to Tandem.',
      }));
    } catch (e) {
      const message = getErrorMessage(e, 'Google Photos authorization failed');
      res.status(400).type('html').send(renderGooglePhotosAuthPage({
        ok: false,
        title: 'Google Photos connection failed',
        message: 'Google Photos authorization failed. Review Tandem logs for details.',
        detail: message,
      }));
    }
  });

  // ═══════════════════════════════════════════════
  // WINGMAN STREAM (Activity Streaming to OpenClaw)
  // ═══════════════════════════════════════════════

  router.post('/wingman-stream/toggle', (req: Request, res: Response) => {
    const { enabled } = req.body;
    ctx.wingmanStream.setEnabled(!!enabled);
    res.json({ ok: true, enabled: !!enabled });
  });

  router.get('/wingman-stream/status', (_req: Request, res: Response) => {
    res.json({ ok: true, enabled: ctx.wingmanStream.isEnabled() });
  });
}
