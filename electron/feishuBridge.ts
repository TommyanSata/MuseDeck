import fs from 'fs';
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

export class FeishuBridge {
  private store: FmcStore;
  private runner: CliRunner;
  private onStatus: (status: FeishuStatusPayload) => void;
  private onStateChanged: () => void;
  private onForwardToMuse: (text: string, chatId: string) => Promise<{ ok: boolean; message: string }>;
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private activeAppId = '';
  private currentStatus: FeishuStatusPayload = { state: 'disconnected' };

  constructor(
    store: FmcStore,
    runner: CliRunner,
    onStatus: (status: FeishuStatusPayload) => void,
    onStateChanged: () => void,
    onForwardToMuse: (text: string, chatId: string) => Promise<{ ok: boolean; message: string }>
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
    const senderId = ((sender.sender_id || {}) as Record<string, string>).open_id || '';
    const chatId = String(message.chat_id || '');
    const messageId = String(message.message_id || '');
    const rawContent = String(message.content || '{}');

    let text = rawContent;
    try {
      const parsed = JSON.parse(rawContent) as { text?: string };
      if (parsed.text) text = parsed.text.replace(/@_user_\d+\s*/g, '').trim();
    } catch {
      // keep raw text
    }

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
      s.feishu.lastPingMessage = text;
    });
    this.onStateChanged();

    this.setStatus({
      state: 'connected',
      connectedAppId: currentAppId,
      verified: true,
      message: `已成功监听到飞书消息：「${text}」，双向通道连通正常！`,
      lastPing: {
        text,
        senderOpenId: senderId,
        chatId,
        receivedAt: now
      }
    });

    // React with Get emoji (inspired by hjuyam/muse-feishu-bridge)
    if (this.client && messageId) {
      try {
        await this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: 'Get' } }
        });
      } catch {
        // non-fatal if reaction scope wasn't granted
      }
    }

    // If first verification ping, reply confirmation immediately
    if (!wasVerified && chatId) {
      await this.sendText(
        chatId,
        `✅ MuseDeck 桌面总控台已成功收到你的消息：「${text}」\n当前机器人（${currentAppId}）长连接双向验证通过，可返回电脑继续下一步配置！`
      );
      return;
    }

    // Parse optional direct CLI slash dispatch: /codex <prompt>, /claude <prompt>, /gemini <prompt>, /pi <prompt>
    const slashMatch = text.match(/^\/(claude|codex|gemini|pi|opencode|antigravity)\s+([\s\S]+)$/i);
    if (slashMatch) {
      const agentId = slashMatch[1].toLowerCase();
      const prompt = slashMatch[2].trim();
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
          `🚀 已将任务派发给 [${agentId}]（任务 ID: ${info.taskId}），可在电脑 FMC 面板查看实时流式输出。`
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
      title: '来自手机飞书的指令（已转交 Muse）',
      content: text,
      status: 'done'
    });
    this.onStateChanged();

    const fwd = await this.onForwardToMuse(text, chatId);
    if (chatId) {
      if (fwd.ok) {
        await this.sendText(
          chatId,
          `🤖 已将你的指令转交给电脑端 Muse 总管处理：\n「${text}」\n任务完成后会自动汇报到这里。`
        );
      } else {
        await this.sendText(
          chatId,
          `⚠️ FMC 已收到指令「${text}」，但自动转发给 Muse 失败：${fwd.message}\n你也可以直接发 /codex <指令> 跳过 Muse 直接调度本地 CLI。`
        );
      }
    }
  }

  async sendText(chatId: string, text: string): Promise<boolean> {
    if (!this.client || !chatId) return false;
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
      let buf = Buffer.from(m[2], 'base64');
      if (mime.includes('svg')) {
        const png = await this.rasterizeSvgToPng(buf);
        if (!png) return null;
        return { buf: png, mime: 'image/png', filename: 'image.png' };
      }
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png';
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
        const ct = (resp.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
        const buf = Buffer.from(await resp.arrayBuffer());
        if (ct.includes('svg') || raw.toLowerCase().endsWith('.svg')) {
          const png = await this.rasterizeSvgToPng(buf);
          if (!png) return null;
          return { buf: png, mime: 'image/png', filename: 'image.png' };
        }
        const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'png';
        return { buf, mime: ct.startsWith('image/') ? ct : 'image/png', filename: `image.${ext}` };
      } catch {
        return null;
      }
    }

    // Local file path (absolute or relative to workspace / project dirs)
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
    const st = this.store.getState().feishu;
    if (!st.appId || !st.appSecret) return false;

    try {
      const loaded = await this.loadImageBuffer(source, fallbackDirs);
      if (!loaded || loaded.buf.length === 0) return false;

      // 1. Obtain tenant_access_token
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: st.appId, app_secret: st.appSecret })
        }
      );
      const tokenJson = (await tokenResp.json()) as { code?: number; tenant_access_token?: string };
      if (tokenJson.code !== 0 || !tokenJson.tenant_access_token) return false;

      // 2. Upload image to Feishu im/v1/images
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', new Blob([new Uint8Array(loaded.buf)], { type: loaded.mime }), loaded.filename);
      const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenJson.tenant_access_token}` },
        body: form
      });
      const uploadJson = (await uploadResp.json()) as {
        code?: number;
        data?: { image_key?: string };
      };
      const imageKey = uploadJson.data?.image_key;
      if (uploadJson.code !== 0 || !imageKey) return false;

      // 3. Send image message to chatId
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
    const st = this.store.getState().feishu;
    if (!st.appId || !st.appSecret) return false;

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
      // Feishu im/v1/files max file size is 30MB
      if (stat.size <= 0 || stat.size > 30 * 1024 * 1024) return false;

      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: st.appId, app_secret: st.appSecret })
        }
      );
      const tokenJson = (await tokenResp.json()) as { code?: number; tenant_access_token?: string };
      if (tokenJson.code !== 0 || !tokenJson.tenant_access_token) return false;

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
        headers: { Authorization: `Bearer ${tokenJson.tenant_access_token}` },
        body: form
      });
      const uploadJson = (await uploadResp.json()) as {
        code?: number;
        data?: { file_key?: string };
      };
      const fileKey = uploadJson.data?.file_key;
      if (uploadJson.code !== 0 || !fileKey) return false;

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
