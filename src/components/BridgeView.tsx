import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Cloud,
  Copy,
  Crosshair,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Unplug,
  X,
  XCircle
} from 'lucide-react';
import {
  FeishuAutoStepReport,
  FeishuLiveGuideState,
  FeishuStatusEvent,
  FmcState,
  TunnelStatusEvent
} from '../types';
import { FeishuSetupGuide } from './FeishuSetupGuide';

interface BridgeViewProps {
  state: FmcState;
  feishuStatus: FeishuStatusEvent;
}

export const BridgeView: React.FC<BridgeViewProps> = ({ state, feishuStatus }) => {
  const [appId, setAppId] = useState(state.feishu.appId);
  const [appSecret, setAppSecret] = useState(state.feishu.appSecret);
  const [tunnelUrl, setTunnelUrl] = useState(state.controlApi.tunnelUrl);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatusEvent>({ state: 'stopped' });
  const [briefText, setBriefText] = useState('');
  const [copied, setCopied] = useState('');
  const [testMsg, setTestMsg] = useState('你好，这是来自 MuseDeck 桌面端的飞书测试推送！');
  const [showGuide, setShowGuide] = useState(false);
  const [botNameDraft, setBotNameDraft] = useState('MuseDeck');
  const [autoRunning, setAutoRunning] = useState(false);
  const [museCoPilotRunning, setMuseCoPilotRunning] = useState(false);
  const [autoTip, setAutoTip] = useState('');
  const [autoStepReport, setAutoStepReport] = useState<FeishuAutoStepReport[]>([]);
  const [liveGuide, setLiveGuide] = useState<FeishuLiveGuideState | null>(null);

  useEffect(() => {
    setAppId(state.feishu.appId || '');
    setAppSecret(state.feishu.appSecret || '');
  }, [state.feishu.appId, state.feishu.appSecret]);

  useEffect(() => {
    void window.fmc.getTunnelStatus().then((st) => {
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    });
    const off = window.fmc.onEvent('tunnel:status', (payload) => {
      const st = payload as TunnelStatusEvent;
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    });
    const offAuto = window.fmc.onEvent('autopilot:feishuProgress', (payload) => {
      const p = payload as { message?: string };
      if (p?.message) setAutoTip(p.message);
    });
    const offGuide = window.fmc.onEvent('feishuGuide:state', (payload) => {
      setLiveGuide(payload as FeishuLiveGuideState);
    });
    const offCred = window.fmc.onEvent('feishuGuide:credentialCaptured', (payload) => {
      const c = payload as { appId?: string; appSecret?: string };
      if (c.appId) setAppId(c.appId);
      if (c.appSecret) {
        setAppSecret(c.appSecret);
        setAutoTip('✨ 已自动识别填入你刚复制的 App Secret，请点击下方「连接此新机器人」按钮！');
      }
    });
    return () => {
      off();
      offAuto();
      offGuide();
      offCred();
    };
  }, []);

  const handleToggleTunnel = async () => {
    if (tunnelStatus.state === 'running' || tunnelStatus.state === 'starting') {
      const st = await window.fmc.stopTunnel();
      setTunnelStatus(st);
    } else {
      setTunnelStatus({
        state: 'starting',
        mode: 'tailscale',
        message: '正在启动内嵌 Tailscale 永久域名...'
      });
      const st = await window.fmc.startTailscaleTunnel();
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    }
  };

  const refreshBrief = async () => {
    const text = await window.fmc.getMuseBrief();
    setBriefText(text);
  };

  useEffect(() => {
    void refreshBrief();
  }, [state.controlApi.token, state.controlApi.tunnelUrl, state.cliConfigs]);

  const copy = async (key: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  const apiBase = state.controlApi.tunnelUrl.trim() || `http://127.0.0.1:${state.controlApi.port}`;
  const trimmedAppId = appId.trim();
  const trimmedAppSecret = appSecret.trim();
  const isCurrentFeishuSaved =
    Boolean(trimmedAppId) &&
    trimmedAppId === (state.feishu.appId || '').trim() &&
    trimmedAppSecret === (state.feishu.appSecret || '').trim();
  const hasUnsavedFeishuDraft =
    Boolean(trimmedAppId || trimmedAppSecret) && !isCurrentFeishuSaved;
  const isFeishuConnected =
    isCurrentFeishuSaved &&
    feishuStatus.state === 'connected' &&
    (!feishuStatus.connectedAppId || feishuStatus.connectedAppId === trimmedAppId);
  const isFeishuVerified = Boolean(
    isCurrentFeishuSaved &&
      state.feishu.verified &&
      state.feishu.verifiedAppId === trimmedAppId
  );
  const feishuBotAppLink = /^cli_[a-zA-Z0-9]+$/.test(trimmedAppId)
    ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(trimmedAppId)}`
    : '';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Slim Top Header */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
        <h2 className="text-[13.5px] font-semibold text-[#111827]">飞书 & Muse 桥接</h2>
        <div className="flex items-center gap-2 text-[11.5px]">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[#f4f4f5] px-2 py-0.5 font-medium text-[#52525b]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                feishuStatus.state === 'connected' ? 'bg-emerald-500' : 'bg-[#a1a1aa]'
              }`}
            />
            飞书 {feishuStatus.state === 'connected' ? '在线' : '未连接'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[#f4f4f5] px-2 py-0.5 font-medium text-[#52525b]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                tunnelStatus.state === 'running'
                  ? 'bg-emerald-500'
                  : tunnelStatus.state === 'starting'
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-[#a1a1aa]'
              }`}
            />
            Tailscale {tunnelStatus.state === 'running' ? '443 在线' : '未开启'}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto grid max-w-[1120px] grid-cols-12 gap-5">
          {/* Left Column: Feishu + Control API & Tailscale */}
          <div className="col-span-12 space-y-5 lg:col-span-5">
            {/* Feishu WebSocket Card */}
            <section className="rounded-2xl border border-[#eaecef] bg-white p-5">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-[#111827]">飞书 WebSocket 长连接</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowGuide(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#e4e4e7] bg-[#fafafa] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f1f1f3] hover:text-[#111827]"
                  >
                    <BookOpen className="h-3 w-3" />
                    权限配置指引
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#52525b]">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        hasUnsavedFeishuDraft
                          ? 'bg-amber-500'
                          : isFeishuConnected
                            ? 'bg-emerald-500'
                            : feishuStatus.state === 'error'
                              ? 'bg-red-500'
                              : 'bg-[#d4d4d8]'
                      }`}
                    />
                    {hasUnsavedFeishuDraft
                      ? '新凭证待连接'
                      : isFeishuConnected
                        ? '长连接在线'
                        : feishuStatus.state}
                  </span>
                </div>
              </div>

              <div className="space-y-3 text-[12.5px]">
                {/* Live Spotlight Guide Launcher (Primary Recommended) */}
                <div className="rounded-xl border border-[#18181b] bg-[#fafafa] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11.5px] font-semibold text-[#111827]">
                      🎯 飞书开放平台 6 步实景高亮跟做指引（推荐 · 稳妥零出错）
                    </div>
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 ring-1 ring-red-200">
                      动态脉冲框提示
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-[#52525b]">
                    打开飞书开放平台窗口并自动用<strong>红色呼吸脉冲框 + 气泡</strong>标出每一步点击位置（含长连接「点铅笔图标 ✏️ → 点保存」两步校验与复制密钥自动填入）。
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        setShowGuide(true);
                        await window.fmc.jumpFeishuGuideStep(1, trimmedAppId || undefined);
                      }}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#18181b] px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-[#27272a]"
                    >
                      <Crosshair className="h-3.5 w-3.5 text-red-400" />
                      打开飞书后台 + 6 步实景高亮指引
                    </button>
                  </div>
                  {autoTip && (
                    <div className="mt-2 rounded-lg border border-[#eaecef] bg-white px-2.5 py-2 text-[11px] leading-relaxed text-[#3f3f46]">
                      <div className="font-medium text-[#111827]">{autoTip}</div>
                      {autoStepReport.length > 0 && (
                        <ul className="mt-1.5 space-y-1 border-t border-[#eaecef] pt-1.5">
                          {autoStepReport.map((it, idx) => (
                            <li key={idx} className="flex items-start gap-1">
                              <span className="shrink-0">
                                {it.status === 'ok' ? '✅' : it.status === 'warn' ? '⚠️' : '👉'}
                              </span>
                              <span>
                                <strong>{it.step}：</strong>
                                {it.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block font-medium text-[#3f3f46]">App ID</label>
                  <input
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="cli_a1b2c3..."
                    className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="font-medium text-[#3f3f46]">App Secret</label>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await window.fmc.readClipboardCredential();
                        if (res.appSecret) setAppSecret(res.appSecret);
                        else if (res.appId) setAppId(res.appId);
                        else if (res.raw) setAppSecret(res.raw);
                      }}
                      className="inline-flex items-center gap-1 rounded bg-[#f4f4f5] px-1.5 py-0.5 text-[10.5px] font-medium text-[#111827] hover:bg-[#e4e4e7]"
                    >
                      <ClipboardPaste className="h-3 w-3" />
                      粘贴剪贴板密钥
                    </button>
                  </div>
                  <input
                    type="password"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder="在飞书凭证页点复制图标后自动填入或粘贴"
                    className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                  />
                </div>

                {/^cli_[a-zA-Z0-9]+$/.test(trimmedAppId) && !trimmedAppSecret && (
                  <div className="flex items-start gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-950">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span>
                      <strong>提醒：请粘贴 App Secret 密钥！</strong>请在飞书「凭证与基础信息」页点击 App Secret 旁的复制图标（或点上方「粘贴剪贴板密钥」），随后点击下方连接按钮。
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={() => void window.fmc.connectFeishu(appId, appSecret)}
                    className="flex-1 rounded-xl bg-[#18181b] px-3 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
                  >
                    {hasUnsavedFeishuDraft ? '连接此新机器人' : '连接 / 重连飞书'}
                  </button>
                  {feishuBotAppLink && (
                    <button
                      onClick={() => void window.fmc.openExternal(feishuBotAppLink)}
                      className="rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[12px] font-medium text-[#111827] transition-colors hover:bg-[#f4f4f5]"
                      title="在飞书客户端中直接打开此机器人的聊天窗口（需先发布应用版本）"
                    >
                      打开机器人会话
                    </button>
                  )}
                  <button
                    onClick={() => void window.fmc.disconnectFeishu()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5]"
                  >
                    <Unplug className="h-3.5 w-3.5" />
                    断开
                  </button>
                </div>

                {hasUnsavedFeishuDraft && (
                  <p className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11.5px] text-amber-900">
                    已填写新的飞书凭证，请点击「连接此新机器人」切换连接（旧机器人的绑定会话与验通状态将自动清空）。
                  </p>
                )}

                {isFeishuVerified && state.feishu.lastChatId && (
                  <div className="mt-3 border-t border-[#f1f1f3] pt-3">
                    <div className="mb-2 flex items-center justify-between gap-2 text-[11.5px] font-medium text-emerald-700">
                      <span className="inline-flex items-center gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        当前机器人已验通会话：{state.feishu.lastChatId}
                        {state.feishu.lastPingMessage ? `（收到：「${state.feishu.lastPingMessage}」）` : ''}
                      </span>
                      <button
                        onClick={() => void window.fmc.resetFeishuVerification()}
                        className="text-[11px] text-[#71717a] underline hover:text-[#111827]"
                      >
                        重置验证
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={testMsg}
                        onChange={(e) => setTestMsg(e.target.value)}
                        className="flex-1 rounded-xl border border-[#e4e4e7] px-2.5 py-1.5 text-[12px] outline-none focus:border-[#18181b]"
                      />
                      <button
                        onClick={() => void window.fmc.sendFeishuTest(testMsg)}
                        className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-[#fafafa] px-3 py-1.5 text-[12px] font-medium text-[#111827] transition-colors hover:bg-[#f1f1f3]"
                      >
                        <Send className="h-3 w-3" />
                        推送测试
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Control API & Embedded Tailscale Card */}
            <section className="rounded-2xl border border-[#eaecef] bg-white p-5">
              <h3 className="mb-3.5 text-[13.5px] font-semibold text-[#111827]">
                本地控制 API 与内嵌 Tailscale
              </h3>
              <div className="space-y-3.5 text-[12.5px]">
                <div>
                  <label className="mb-1 block font-medium text-[#3f3f46]">API 地址</label>
                  <div className="flex items-center gap-2 rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2 font-mono text-[11.5px] text-[#3f3f46]">
                    <span className="flex-1 truncate">{apiBase}</span>
                    <button
                      onClick={() => void copy('api', apiBase)}
                      className="text-[11.5px] font-sans font-medium text-[#111827] hover:underline"
                    >
                      {copied === 'api' ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-[#3f3f46]">Bearer Token</label>
                  <div className="flex items-center gap-2 rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2 font-mono text-[11.5px] text-[#3f3f46]">
                    <KeyRound className="h-3.5 w-3.5 shrink-0 text-[#8a8f98]" />
                    <span className="flex-1 truncate">{state.controlApi.token}</span>
                    <button
                      onClick={() => void copy('token', state.controlApi.token)}
                      className="text-[11.5px] font-sans font-medium text-[#111827] hover:underline"
                    >
                      {copied === 'token' ? '已复制' : '复制'}
                    </button>
                    <button
                      onClick={() => void window.fmc.updateControlApi({ regenerateToken: true })}
                      className="text-[#8a8f98] transition-colors hover:text-[#111827]"
                      title="重新生成 Token"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="font-medium text-[#3f3f46]">公网永久域名 (Tailscale Funnel)</label>
                    {tunnelStatus.state === 'running' && (
                      <span className="text-[11px] font-medium text-emerald-600">永久域名在线</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={tunnelUrl}
                      onChange={(e) => setTunnelUrl(e.target.value)}
                      placeholder="https://fmc-hub.tailxxxx.ts.net"
                      className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 font-mono text-[11.5px] text-[#111827] outline-none focus:border-[#18181b]"
                    />
                    <button
                      onClick={() => void window.fmc.updateControlApi({ tunnelUrl })}
                      className="rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => void handleToggleTunnel()}
                      disabled={tunnelStatus.state === 'starting'}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12px] font-medium text-white transition-colors disabled:opacity-60 ${
                        tunnelStatus.state === 'running'
                          ? 'bg-red-600 hover:bg-red-700'
                          : 'bg-[#18181b] hover:bg-[#27272a]'
                      }`}
                      title="纯用户态内嵌 Tailscale，免装客户端、永久固定 443 域名"
                    >
                      {tunnelStatus.state === 'starting' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : tunnelStatus.state === 'running' ? (
                        <XCircle className="h-3.5 w-3.5" />
                      ) : (
                        <Cloud className="h-3.5 w-3.5" />
                      )}
                      {tunnelStatus.state === 'starting'
                        ? '启动中'
                        : tunnelStatus.state === 'running'
                          ? '停止'
                          : '启动永久域名'}
                    </button>
                  </div>

                  {tunnelStatus.authUrl && tunnelStatus.state === 'starting' && (
                    <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11.5px] text-amber-950">
                      <div className="font-semibold">正在等待浏览器完成一次性 Tailscale 网页授权：</div>
                      <button
                        onClick={() => void window.fmc.openExternal(tunnelStatus.authUrl!)}
                        className="mt-1 break-all text-left font-mono text-[11px] font-medium text-[#111827] underline"
                      >
                        {tunnelStatus.authUrl}
                      </button>
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-amber-900">
                        <li>
                          <strong>设备绑定页面（/a/...）</strong>：使用 Google / GitHub / Microsoft 登录免费账号，点击页面上的 <strong>Connect（连接设备）</strong> 按钮。
                        </li>
                        <li>
                          <strong>开启 Funnel 公网转发（/f/funnel）</strong>：若随后再次弹出开启 Funnel 页面，点击 <strong>Enable Funnel</strong> 即可（如提示需先开 HTTPS，点击进入{' '}
                          <button
                            type="button"
                            onClick={() => void window.fmc.openExternal('https://login.tailscale.com/admin/dns')}
                            className="font-medium underline"
                          >
                            DNS 设置页
                          </button>{' '}
                          开启 MagicDNS 与 <strong>Enable HTTPS</strong>）。
                        </li>
                        <li>完成后无需手动复制，MuseDeck 会在几秒内自动获取并填入永久 <code>https://...ts.net</code> 域名。</li>
                      </ol>
                    </div>
                  )}

                  {tunnelStatus.state !== 'running' && !tunnelStatus.authUrl && (
                    <div className="mt-2 rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2 text-[11px] leading-relaxed text-[#52525b]">
                      首次点击「启动永久域名」会自动打开 Tailscale 网页：① 登录后点 <strong>Connect</strong> 绑定本机虚拟节点 → ② 若弹出 Funnel 确认页再点 <strong>Enable Funnel</strong> → ③ 自动生成永久 443 域名（免装客户端，以后静默秒连）。
                    </div>
                  )}

                  {tunnelStatus.message && (
                    <p
                      className={`mt-1.5 text-[11.5px] ${
                        tunnelStatus.state === 'error'
                          ? 'text-red-600'
                          : tunnelStatus.state === 'running'
                            ? 'text-emerald-700'
                            : 'text-[#71717a]'
                      }`}
                    >
                      {tunnelStatus.message}
                    </p>
                  )}

                  <div className="mt-3 border-t border-[#f1f1f3] pt-3 text-[11.5px] text-[#52525b]">
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={state.controlApi.autoStartTunnel !== false}
                        onChange={(e) =>
                          void window.fmc.updateControlApi({ autoStartTunnel: e.target.checked })
                        }
                        className="accent-[#18181b]"
                      />
                      启动 MuseDeck 时自动挂起内嵌 Tailscale 永久域名（退出应用自动关闭）
                    </label>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column: MUSE_BRIEF.md */}
          <section className="col-span-12 flex flex-col rounded-2xl border border-[#eaecef] bg-white p-5 lg:col-span-7">
            <div className="mb-3.5 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13.5px] font-semibold text-[#111827]">
                  Muse 监督接入协议（MUSE_BRIEF.md）
                </h3>
                <p className="mt-0.5 text-[11.5px] text-[#71717a]">
                  复制发给 Muse 总管，即可让 Muse 读取项目组、按需建组并监督所有已启用 CLI。
                </p>
              </div>
              <button
                onClick={() => void copy('brief', briefText)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#18181b] px-3.5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a]"
              >
                {copied === 'brief' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === 'brief' ? '已复制' : '复制全文'}
              </button>
            </div>

            <pre className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap rounded-xl border border-[#f1f1f3] bg-[#fafafa] p-4 font-mono text-[11.5px] leading-relaxed text-[#27272a]">
              {briefText || '正在生成协议...'}
            </pre>
          </section>
        </div>
      </div>

      {/* Interactive Feishu Permission & Long-Connection Setup Guide Modal */}
      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]">
          <div className="flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#e4e4e7] bg-white shadow-popover">
            <div className="flex items-center justify-between border-b border-[#eaecef] px-5 py-3.5">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-[#111827]" />
                <h3 className="text-[14px] font-semibold text-[#111827]">飞书机器人权限与事件配置指引</h3>
              </div>
              <button
                onClick={() => setShowGuide(false)}
                className="rounded-lg p-1 text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <FeishuSetupGuide
                feishuConnected={isFeishuConnected}
                feishuVerified={isFeishuVerified}
                appId={appId}
                appSecret={appSecret}
                botName={botNameDraft}
                liveGuide={liveGuide}
              />
            </div>
            <div className="flex justify-end border-t border-[#eaecef] px-5 py-3">
              <button
                onClick={() => setShowGuide(false)}
                className="rounded-xl bg-[#18181b] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#27272a]"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
