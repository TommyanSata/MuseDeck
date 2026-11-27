import fs from 'fs';
import os from 'os';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { BrowserWindow, session } from 'electron';
import { CliRunner } from './cliRunner';
import { FmcStore } from './store';

export interface FeishuStatusPayload {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  connectedAppId?: string;
  message?: string;
  verified?: boolean;
  lastPing?: {
    text: string;
    senderOpenId: string;
    chatId: string;
    receivedAt: string;
  };
}

export interface FeishuIncomingContext {
  text: string;
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadKey?: string;
  imagePaths?: string[];
}

interface ActiveThreadTarget {
  messageId: string;
  rootId?: string;
  threadKey?: string;
  updatedAt: number;
}

export class FeishuBridge {
  private store: FmcStore;
  private runner: CliRunner;
  private onStatus: (status: FeishuStatusPayload) => void;
  private onStateChanged: () => void;
  private onForwardToMuse: (
    ctx: FeishuIncomingContext
  ) => Promise<{ ok: boolean; message: string }>;
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private activeAppId = '';
  private currentStatus: FeishuStatusPayload = { state: 'disconnected' };
  private seenMessageIds = new Set<string>();
  private chatReplyTargets = new Map<string, ActiveThreadTarget>();
  private knownBotThreads = new Set<string>();

  constructor(
    store: FmcStore,
    runner: CliRunner,
    onStatus: (status: FeishuStatusPayload) => void,
    onStateChanged: () => void,
    onForwardToMuse: (ctx: FeishuIncomingContext) => Promise<{ ok: boolean; message: string }>
  ) {
    this.store = store;
    this.runner = runner;
    this.onStatus = onStatus;
    this.onStateChanged = onStateChanged;
    this.onForwardToMuse = onForwardToMuse;
  }

  getStatus(): FeishuStatusPayload {
    return this.currentStatus;
  }

  private setStatus(next: FeishuStatusPayload): void {
    this.currentStatus = next;
    this.onStatus(next);
  }

  private rememberMessageId(id: string): boolean {
    if (!id) return true;
    if (this.seenMessageIds.has(id)) return false;
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > 500) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return true;
  }

  private async fetchTenantAccessToken(): Promise<string | null> {
    const st = this.store.getState().feishu;
    if (!st.appId || !st.appSecret) return null;
    try {
      const resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: st.appId, app_secret: st.appSecret })
        }
      );
      const json = (await resp.json()) as { code?: number; tenant_access_token?: string };
      return json.code === 0 && json.tenant_access_token ? json.tenant_access_token : null;
    } catch {
      return null;
    }
  }

  /** Instant reaction feedback (👀 OnIt on arrival, ✅ DONE on completion) */
  async addReaction(messageId: string, emojiType: 'OnIt' | 'DONE' | 'Get' = 'OnIt'): Promise<void> {
    if (!this.client || !messageId) return;
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } }
      });
    } catch {
      if (emojiType === 'OnIt') {
        try {
          await this.client.im.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: 'Get' } }
          });
        } catch {
          // non-fatal if reaction scope is absent on older bots
        }
      }
    }
  }

  /** Download user-sent Feishu screenshot(s) via im/v1/messages/:id/resources/:key?type=image */
  private async downloadIncomingImages(
    messageId: string,
    imageKeys: string[]
  ): Promise<string[]> {
    if (!messageId || imageKeys.length === 0) return [];
    const token = await this.fetchTenantAccessToken();
    if (!token) return [];

    const proj = this.store.getState().projects[0];
    let inboxDir = path.join(os.homedir(), '.musedeck-inbox');
    if (proj?.repoPath) {
      try {
        const resolved = path.resolve(proj.repoPath);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          inboxDir = path.join(resolved, '.musedeck', 'feishu-inbox');
        }
      } catch {
        // fallback to home inbox
      }
    }
    fs.mkdirSync(inboxDir, { recursive: true });

    const savedPaths: string[] = [];
    for (const key of imageKeys.slice(0, 4)) {
      try {
        const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
          messageId
        )}/resources/${encodeURIComponent(key)}?type=image`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!resp.ok) continue;
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await resp.arrayBuffer());
        // Cap single image at 10MB
        if (buf.length === 0 || buf.length > 10 * 1024 * 1024) continue;

        let ext = 'png';
        if (ct.includes('jpeg') || ct.includes('jpg') || (buf[0] === 0xff && buf[1] === 0xd8)) {
          ext = 'jpg';
        } else if (ct.includes('webp') || buf.subarray(8, 12).toString('ascii') === 'WEBP') {
          ext = 'webp';
        } else if (ct.includes('gif') || buf.subarray(0, 3).toString('ascii') === 'GIF') {
          ext = 'gif';
        }

        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(-12) || String(Date.now());
        const filePath = path.join(inboxDir, `feishu-${Date.now()}-${safeKey}.${ext}`);
        fs.writeFileSync(filePath, buf);
        savedPaths.push(filePath);
      } catch {
        // continue remaining images
      }
    }
    return savedPaths;
  }

  private parseIncomingContent(
    msgType: string,
    rawContent: string
  ): { text: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    let text = '';

    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      if (msgType === 'image') {
        const ik = String(parsed.image_key || '').trim();
        if (ik) imageKeys.push(ik);
      } else if (msgType === 'post') {
        // Feishu rich-text post: { title, content: [[{ tag: 'text'|'img'|'a'|'code_block', ... }]] }
        const findBlocks = (obj: unknown): { title?: string; content?: unknown[][] } => {
          if (!obj || typeof obj !== 'object') return {};
          const rec = obj as Record<string, unknown>;
          if (Array.isArray(rec.content)) {
            return {
              title: typeof rec.title === 'string' ? rec.title : undefined,
              content: rec.content as unknown[][]
            };
          }
          for (const v of Object.values(rec)) {
            if (v && typeof v === 'object') {
              const nested = findBlocks(v);
              if (nested.content) return nested;
            }
          }
          return {};
        };
        const post = findBlocks(parsed);
        const lines: string[] = [];
        if (post.title?.trim()) lines.push(post.title.trim());
        for (const para of post.content || []) {
          if (!Array.isArray(para)) continue;
          let line = '';
          for (const node of para) {
            if (!node || typeof node !== 'object') continue;
            const n = node as Record<string, unknown>;
            const tag = String(n.tag || '');
            if (tag === 'text' || tag === 'a' || tag === 'code_block' || tag === 'md') {
              line += String(n.text || '');
            } else if (tag === 'img' && typeof n.image_key === 'string') {
              imageKeys.push(n.image_key);
            }
          }
          if (line.trim()) lines.push(line.trim());
        }
        text = lines.join('\n');
      } else if (typeof parsed.text === 'string') {
        text = parsed.text;
      }
    } catch {
      text = rawContent;
    }

    text = text.replace(/@_user_\d+\s*/g, '').trim();
    return { text, imageKeys };
  }

  async connect(appId: string, appSecret: string): Promise<FeishuStatusPayload> {
    this.disconnect();
    const trimmedId = appId.trim();
    const trimmedSecret = appSecret.trim();
    if (!trimmedId || !trimmedSecret) {
      const err: FeishuStatusPayload = {
        state: 'error',
        message: '请填写完整的飞书 App ID 和 App Secret'
      };
      this.setStatus(err);
      return err;
    }

    const prevFeishu = this.store.getState().feishu;
    const credentialsChanged =
      prevFeishu.appId !== trimmedId ||
      prevFeishu.appSecret !== trimmedSecret ||
      (prevFeishu.verified && prevFeishu.verifiedAppId !== trimmedId);

    this.store.update((s) => {
      s.feishu.appId = trimmedId;
      s.feishu.appSecret = trimmedSecret;
      if (credentialsChanged) {
        s.feishu.verified = false;
        s.feishu.verifiedAppId = undefined;
        s.feishu.verifiedAt = undefined;
        s.feishu.lastChatId = undefined;
        s.feishu.lastSenderOpenId = undefined;
        s.feishu.lastPingMessage = undefined;
      }
    });
    this.onStateChanged();

    this.setStatus({
      state: 'connecting',
      connectedAppId: trimmedId,
      verified: false,
      message: '正在建立飞书 WebSocket 长连接...'
    });

    try {
      this.client = new lark.Client({
        appId: trimmedId,
        appSecret: trimmedSecret,
        loggerLevel: lark.LoggerLevel.warn
      });

      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: Record<string, unknown>) => {
          await this.handleIncomingMessage(data);
        }
      });

      this.wsClient = new lark.WSClient({
        appId: trimmedId,
        appSecret: trimmedSecret,
        loggerLevel: lark.LoggerLevel.warn
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.activeAppId = trimmedId;

      const latestFeishu = this.store.getState().feishu;
      const verified = Boolean(
        latestFeishu.verified && latestFeishu.verifiedAppId === trimmedId
      );
      this.setStatus({
        state: 'connected',
        connectedAppId: trimmedId,
        verified,
        message: verified
          ? '飞书长连接在线（当前机器人已完成双向连通验证）'
          : '飞书长连接已建立，请完成事件订阅与版本发布后向该机器人发送「你好」验证连通！'
      });
      return this.currentStatus;
    } catch (err) {
      this.activeAppId = '';
      const msg = err instanceof Error ? err.message : String(err);
      const payload: FeishuStatusPayload = {
        state: 'error',
        verified: false,
        message: `飞书连接失败：${msg}`
      };
      this.setStatus(payload);
      return payload;
    }
  }

  resetVerification(): FeishuStatusPayload {
    this.store.update((s) => {
      s.feishu.verified = false;
      s.feishu.verifiedAppId = undefined;
      s.feishu.verifiedAt = undefined;
      s.feishu.lastChatId = undefined;
      s.feishu.lastSenderOpenId = undefined;
      s.feishu.lastPingMessage = undefined;
    });
    this.onStateChanged();
    const isOnline = this.currentStatus.state === 'connected';
    this.setStatus({
      state: this.currentStatus.state,
      connectedAppId: isOnline ? this.activeAppId : undefined,
      verified: false,
      lastPing: undefined,
      message: isOnline
        ? '验证状态已重置，请在飞书向当前机器人发送「你好」重新验证连通'
        : '验证状态已清空，请连接新机器人后发送消息验证'
    });
    return this.currentStatus;
  }

  disconnect(): void {
    if (this.wsClient) {
      try {
        (this.wsClient as unknown as { close?: () => void }).close?.();
      } catch {
        // ignore close errors
      }
      this.wsClient = null;
    }
    this.client = null;
    this.activeAppId = '';
    const stFeishu = this.store.getState().feishu;
    this.setStatus({
      state: 'disconnected',
      verified: Boolean(stFeishu.verified && stFeishu.verifiedAppId === stFeishu.appId),
      message: '未连接'
    });
  }

  private async handleIncomingMessage(data: Record<string, unknown>): Promise<void> {
    const message = (data.message || {}) as Record<string, unknown>;
    const sender = (data.sender || {}) as Record<string, unknown>;
    if (String(sender.sender_type || '') === 'app') return;

    const messageId = String(message.message_id || '');
    if (!this.rememberMessageId(messageId)) return;

    const chatType = String(message.chat_type || 'p2p');
    const rootId = String(message.root_id || '').trim() || undefined;
    const parentId = String(message.parent_id || '').trim() || undefined;
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];

    // In group chats, only respond when explicitly @mentioned or continuing a thread started with the bot
    if (chatType !== 'p2p' && mentions.length === 0 && (!rootId || !this.knownBotThreads.has(rootId))) {
      return;
    }

    // 1. Instant 0.2s 👀 (OnIt) reaction so mobile user immediately sees receipt!
    if (messageId) {
      void this.addReaction(messageId, 'OnIt');
    }

    const senderId = ((sender.sender_id || {}) as Record<string, string>).open_id || '';
    const chatId = String(message.chat_id || '');
    const msgType = String(message.message_type || 'text').toLowerCase();
    const rawContent = String(message.content || '{}');

    const { text: parsedText, imageKeys } = this.parseIncomingContent(msgType, rawContent);
    const imagePaths = await this.downloadIncomingImages(messageId, imageKeys);

    const text =
      parsedText ||
      (imagePaths.length > 0
        ? '请查看我从飞书发来的截图并帮我分析处理'
        : msgType === 'file'
          ? '[收到文件消息，暂支持直接发送截图或粘贴文本内容]'
          : '');
    if (!text && imagePaths.length === 0) return;

    const threadKey = rootId || parentId || (chatType !== 'p2p' ? messageId : undefined);
    if (threadKey) {
      this.knownBotThreads.add(threadKey);
    }
    if (chatId && messageId) {
      this.chatReplyTargets.set(chatId, {
        messageId,
        rootId: rootId || (chatType !== 'p2p' ? messageId : undefined),
        threadKey,
        updatedAt: Date.now()
      });
    }

    const displayPing =
      imagePaths.length > 0
        ? `${parsedText ? `${parsedText} ` : ''}[附带 ${imagePaths.length} 张截图]`
        : text;
    const now = new Date().toISOString();
    const currentAppId = this.activeAppId || this.store.getState().feishu.appId;
    const prevFeishu = this.store.getState().feishu;
    const wasVerified = Boolean(
      prevFeishu.verified && prevFeishu.verifiedAppId === currentAppId
    );

    this.store.update((s) => {
      s.feishu.verified = true;
      s.feishu.verifiedAppId = currentAppId;
      s.feishu.verifiedAt = now;
      if (chatId) s.feishu.lastChatId = chatId;
      if (senderId) {
        s.feishu.lastSenderOpenId = senderId;
        if (!s.feishu.allowOpenIds.includes(senderId)) {
          s.feishu.allowOpenIds.push(senderId);
        }
      }
      s.feishu.lastPingMessage = displayPing;
    });
    this.onStateChanged();

    this.setStatus({
      state: 'connected',
      connectedAppId: currentAppId,
      verified: true,
      message: `已成功监听到飞书消息：「${displayPing}」，双向通道连通正常！`,
      lastPing: {
        text: displayPing,
        senderOpenId: senderId,
        chatId,
        receivedAt: now
      }
    });

    // If first verification ping, reply confirmation immediately
    if (!wasVerified && chatId) {
      await this.sendText(
        chatId,
        `✅ MuseDeck 桌面总控台已成功收到你的消息：「${displayPing}」\n当前机器人（${currentAppId}）长连接双向验证通过，现在可直接发文字或报错截图指挥 Muse 与本地 CLI！`
      );
      void this.addReaction(messageId, 'DONE');
      return;
    }

    // Parse optional direct CLI slash dispatch: /codex <prompt>, /claude <prompt>, /gemini <prompt>, /pi <prompt>
    const slashMatch = text.match(/^\/(claude|codex|gemini|pi|opencode|antigravity)\s+([\s\S]+)$/i);
    if (slashMatch) {
      const agentId = slashMatch[1].toLowerCase();
      let prompt = slashMatch[2].trim();
      if (imagePaths.length > 0) {
        prompt += `\n\n[附带本地截图文件路径，请直接读取查看图片内容]\n${imagePaths.map((p) => `- ${p}`).join('\n')}`;
      }
      const defaultProj = this.store.getState().projects[0];
      const info = await this.runner.dispatch({
        projectId: defaultProj.id,
        agentId,
        prompt,
        source: 'feishu',
        useWorktree: false
      });
      if (chatId) {
        await this.sendText(
          chatId,
          `🚀 已将任务${imagePaths.length > 0 ? `（含 ${imagePaths.length} 张截图）` : ''}派发给 [${agentId}]（任务 ID: ${info.taskId}），可在电脑 MuseDeck 面板查看实时流式输出。`
        );
      }
      return;
    }

    // Otherwise record into default project timeline AND auto-forward to Muse Supervisor!
    const defaultProj = this.store.getState().projects[0];
    this.store.addMessage({
      projectId: defaultProj.id,
      source: 'feishu',
      role: 'directive',
      title: `来自手机飞书的指令${threadKey ? ` · 话题 #${threadKey.slice(-6)}` : ''}${imagePaths.length > 0 ? ` · 含 ${imagePaths.length} 张图` : ''}`,
      content:
        imagePaths.length > 0
          ? `${text}\n\n[已接收飞书截图并保存至本地]\n${imagePaths.join('\n')}`
          : text,
      status: 'done'
    });
    this.onStateChanged();

    const fwd = await this.onForwardToMuse({
      text,
      chatId,
      messageId,
      rootId,
      parentId,
      threadKey,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined
    });
    if (chatId) {
      if (fwd.ok) {
        await this.sendText(
          chatId,
          `🤖 已将你的${imagePaths.length > 0 ? `截图（${imagePaths.length} 张）与` : ''}指令转交给电脑端 Muse 总管：\n「${text}」\n处理完成后将自动在此${rootId ? '话题串' : '对话'}汇报。`
        );
      } else {
        await this.sendText(
          chatId,
          `⚠️ MuseDeck 已收到指令「${displayPing}」，但自动转发给 Muse 失败：${fwd.message}\n你也可以直接发 /codex <指令> 跳过 Muse 直接调度本地 CLI。`
        );
      }
    }
  }

  private getActiveThreadTarget(chatId: string): ActiveThreadTarget | undefined {
    const ctx = this.chatReplyTargets.get(chatId);
    if (!ctx) return undefined;
    // Keep thread reply context fresh for 45 minutes
    if (Date.now() - ctx.updatedAt > 45 * 60 * 1000) return undefined;
    return ctx;
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: { replyToMessageId?: string; replyInThread?: boolean }
  ): Promise<boolean> {
    if (!this.client || !chatId) return false;
    const threadCtx = this.getActiveThreadTarget(chatId);
    const replyMsgId = opts?.replyToMessageId || (threadCtx?.rootId ? threadCtx.messageId : undefined);
    const replyInThread = opts?.replyInThread ?? Boolean(threadCtx?.rootId);

    if (replyMsgId && replyInThread) {
      try {
        await this.client.im.message.reply({
          path: { message_id: replyMsgId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
            reply_in_thread: true
          }
        });
        return true;
      } catch {
        // fallback to regular chat send
      }
    }

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  private async rasterizeSvgToPng(svgBuf: Buffer): Promise<Buffer | null> {
    let win: BrowserWindow | null = null;
    try {
      win = new BrowserWindow({
        width: 512,
        height: 512,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true, sandbox: true }
      });
      const dataUrl = `data:image/svg+xml;base64,${svgBuf.toString('base64')}`;
      const html = `<!doctype html><html><body style="margin:0;width:512px;height:512px;display:flex;align-items:center;justify-content:center;background:#ffffff;overflow:hidden;"><img src="${dataUrl}" style="width:100%;height:100%;object-fit:contain;" /></body></html>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise((r) => setTimeout(r, 180));
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      return png.length > 0 ? png : null;
    } catch {
      return null;
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  private async loadImageBuffer(
    source: string,
    fallbackDirs: string[] = []
  ): Promise<{ buf: Buffer; mime: string; filename: string } | null> {
    const raw = (source || '').trim();
    if (!raw) return null;

    if (raw.startsWith('data:image/')) {
      const m = raw.match(/^data:(image\/[^;]+);base64,(.+)$/i);
      if (!m) return null;
      const mime = m[1].toLowerCase();
      const buf = Buffer.from(m[2], 'base64');
      if (mime.includes('svg')) {
        const png = await this.rasterizeSvgToPng(buf);
        if (!png) return null;
        return { buf: png, mime: 'image/png', filename: 'image.png' };
      }
      const ext =
        mime.includes('jpeg') || mime.includes('jpg')
          ? 'jpg'
          : mime.includes('webp')
            ? 'webp'
            : mime.includes('gif')
              ? 'gif'
              : 'png';
      return { buf, mime, filename: `image.${ext}` };
    }

    if (/^https?:\/\//i.test(raw)) {
      try {
        let resp: Response;
        try {
          resp = await session.fromPartition('persist:muse').fetch(raw);
        } catch {
          resp = await fetch(raw);
        }
        if (!resp.ok) return null;
        const ct = (resp.headers.get('content-type') || 'image/png')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const buf = Buffer.from(await resp.arrayBuffer());
        if (ct.includes('svg') || raw.toLowerCase().endsWith('.svg')) {
          const png = await this.rasterizeSvgToPng(buf);
          if (!png) return null;
          return { buf: png, mime: 'image/png', filename: 'image.png' };
        }
        const ext =
          ct.includes('jpeg') || ct.includes('jpg')
            ? 'jpg'
            : ct.includes('webp')
              ? 'webp'
              : ct.includes('gif')
                ? 'gif'
                : 'png';
        return { buf, mime: ct.startsWith('image/') ? ct : 'image/png', filename: `image.${ext}` };
      } catch {
        return null;
      }
    }

    const candidates = path.isAbsolute(raw)
      ? [raw]
      : [...fallbackDirs.map((d) => path.resolve(d, raw)), path.resolve(process.cwd(), raw)];
    const found = candidates.find((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!found) return null;
    const ext = path.extname(found).toLowerCase();
    const rawBuf = fs.readFileSync(found);
    if (ext === '.svg') {
      const png = await this.rasterizeSvgToPng(rawBuf);
      if (!png) return null;
      return { buf: png, mime: 'image/png', filename: `${path.basename(found, ext)}.png` };
    }
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/png';
    return { buf: rawBuf, mime, filename: path.basename(found) };
  }

  async sendImage(chatId: string, source: string, fallbackDirs: string[] = []): Promise<boolean> {
    if (!this.client || !chatId) return false;

    try {
      const loaded = await this.loadImageBuffer(source, fallbackDirs);
      if (!loaded || loaded.buf.length === 0) return false;

      const token = await this.fetchTenantAccessToken();
      if (!token) return false;

      const form = new FormData();
      form.append('image_type', 'message');
      form.append(
        'image',
        new Blob([new Uint8Array(loaded.buf)], { type: loaded.mime }),
        loaded.filename
      );
      const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const uploadJson = (await uploadResp.json()) as {
        code?: number;
        data?: { image_key?: string };
      };
      const imageKey = uploadJson.data?.image_key;
      if (uploadJson.code !== 0 || !imageKey) return false;

      const threadCtx = this.getActiveThreadTarget(chatId);
      if (threadCtx?.rootId && threadCtx.messageId) {
        try {
          await this.client.im.message.reply({
            path: { message_id: threadCtx.messageId },
            data: {
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
              reply_in_thread: true
            }
          });
          return true;
        } catch {
          // fallback to create
        }
      }

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey })
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  async sendFile(chatId: string, filePath: string, fallbackDirs: string[] = []): Promise<boolean> {
    if (!this.client || !chatId || !filePath) return false;

    try {
      const raw = filePath.trim();
      const candidates = path.isAbsolute(raw)
        ? [raw]
        : [...fallbackDirs.map((d) => path.resolve(d, raw)), path.resolve(process.cwd(), raw)];
      const found = candidates.find((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (!found) return false;

      const stat = fs.statSync(found);
      if (stat.size <= 0 || stat.size > 30 * 1024 * 1024) return false;

      const token = await this.fetchTenantAccessToken();
      if (!token) return false;

      const ext = path.extname(found).toLowerCase();
      const fileType =
        ext === '.pdf'
          ? 'pdf'
          : ext === '.doc' || ext === '.docx'
            ? 'doc'
            : ext === '.xls' || ext === '.xlsx'
              ? 'xls'
              : ext === '.ppt' || ext === '.pptx'
                ? 'ppt'
                : ext === '.mp4'
                  ? 'mp4'
                  : ext === '.opus'
                    ? 'opus'
                    : 'stream';

      const buf = fs.readFileSync(found);
      const form = new FormData();
      form.append('file_type', fileType);
      form.append('file_name', path.basename(found));
      form.append('file', new Blob([new Uint8Array(buf)]), path.basename(found));

      const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const uploadJson = (await uploadResp.json()) as {
        code?: number;
        data?: { file_key?: string };
      };
      const fileKey = uploadJson.data?.file_key;
      if (uploadJson.code !== 0 || !fileKey) return false;

      const threadCtx = this.getActiveThreadTarget(chatId);
      if (threadCtx?.rootId && threadCtx.messageId) {
        try {
          await this.client.im.message.reply({
            path: { message_id: threadCtx.messageId },
            data: {
              msg_type: 'file',
              content: JSON.stringify({ file_key: fileKey }),
              reply_in_thread: true
            }
          });
          return true;
        } catch {
          // fallback to create
        }
      }

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey })
        }
      });
      return true;
    } catch {
      return false;
    }
  }
}
