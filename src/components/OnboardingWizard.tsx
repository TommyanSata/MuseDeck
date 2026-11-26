import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  Loader2,
  Radio,
  Send,
  XCircle
} from 'lucide-react';
import {
  CliUserConfig,
  DetectedCli,
  FeishuStatusEvent,
  FmcState,
  TunnelStatusEvent
} from '../types';
import { CliManagerView } from './CliManagerView';
import { EmbeddedBrowserSlot } from './EmbeddedBrowserSlot';
import { FeishuSetupGuide } from './FeishuSetupGuide';

interface OnboardingWizardProps {
  state: FmcState;
  clis: DetectedCli[];
  scanning: boolean;
  feishuStatus: FeishuStatusEvent;
  onRescanClis: () => void;
  onSaveCliConfig: (cliId: string, config: CliUserConfig) => Promise<void>;
  onComplete: () => Promise<void>;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  state,
  clis,
  scanning,
  feishuStatus,
  onRescanClis,
  onSaveCliConfig,
  onComplete
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [appId, setAppId] = useState(state.feishu.appId || '');
  const [appSecret, setAppSecret] = useState(state.feishu.appSecret || '');
  const [museUrl, setMuseUrl] = useState(state.muse.webUrl || 'https://muse.ai');
  const [tunnelUrl, setTunnelUrl] = useState(state.controlApi.tunnelUrl || '');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatusEvent>({ state: 'stopped' });
  const [copiedKey, setCopiedKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncingBrief, setSyncingBrief] = useState(false);
  const [syncTip, setSyncTip] = useState('');

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
    return () => off();
  }, []);

  const handleToggleTunnel = async () => {
    if (tunnelStatus.state === 'running' || tunnelStatus.state === 'starting') {
      const st = await window.fmc.stopTunnel();
      setTunnelStatus(st);
    } else {
      setTunnelStatus({
        state: 'starting',
        mode: 'tailscale',
        message: '正在启动内嵌 Tailscale 永久 443 域名...'
      });
      const st = await window.fmc.startTailscaleTunnel();
      setTunnelStatus(st);
      if (st.url) setTunnelUrl(st.url);
    }
  };

  const isVerified = Boolean(feishuStatus.verified || state.feishu.verified);
  const enabledCount = clis.filter((c) => c.config.enabled).length;

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 2000);
  };

  const handleConnectFeishu = async () => {
    setConnecting(true);
    try {
      await window.fmc.connectFeishu(appId, appSecret);
    } finally {
      setConnecting(false);
    }
  };

  const handleCopyBrief = async () => {
    await window.fmc.updateControlApi({ tunnelUrl });
    const brief = await window.fmc.getMuseBrief();
    await copyText('brief', brief);
  };

  const handleSyncBriefDirect = async () => {
    if (syncingBrief) return;
    setSyncingBrief(true);
    setSyncTip('正在同步...');
    try {
      await window.fmc.updateControlApi({ tunnelUrl });
      const res = await window.fmc.syncTunnelToMuse();
      setSyncTip(res.message);
      setTimeout(() => setSyncTip(''), 3500);
    } finally {
      setSyncingBrief(false);
    }
  };

  const goStep = (next: 1 | 2 | 3) => {
    void window.fmc.hideEmbeddedViews();
    setStep(next);
  };

  const steps = [
    { num: 1 as const, label: '飞书桥接', done: isVerified },
    { num: 2 as const, label: '本地 CLI', done: enabledCount > 0 },
    { num: 3 as const, label: 'Muse 与隧道', done: tunnelStatus.state === 'running' }
  ];

  return (
    <div className="flex h-screen flex-col bg-white text-[#111827] select-none">
      {/* Unified Minimalist Codex Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[#eaecef] bg-white px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#18181b] text-[12px] font-bold text-white">
            M
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold tracking-tight text-[#111827]">
              MuseDeck
            </span>
            <span className="rounded-md bg-[#f4f4f5] px-2 py-0.5 text-[11px] font-medium text-[#71717a]">
              初始配置
            </span>
          </div>
        </div>

        {/* Segmented Stepper */}
        <div className="flex items-center rounded-xl bg-[#f4f4f5] p-1 text-[12px]">
          {steps.map((item) => {
            const active = step === item.num;
            return (
              <button
                key={item.num}
                onClick={() => goStep(item.num)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-all ${
                  active
                    ? 'bg-white text-[#111827] shadow-2xs'
                    : 'text-[#71717a] hover:text-[#111827]'
                }`}
              >
                {item.done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                      active ? 'bg-[#18181b] text-white' : 'bg-[#e4e4e7] text-[#52525b]'
                    }`}
                  >
                    {item.num}
                  </span>
                )}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => void onComplete()}
          className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#71717a] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
        >
          跳过向导
        </button>
      </header>

      {/* Main Edge-to-Edge Content */}
      <div className="min-h-0 flex-1 overflow-hidden select-text">
        {step === 1 && (
          <div className="grid h-full grid-cols-12">
            {/* Left: Embedded Feishu Browser */}
            <div className="col-span-7 h-full border-r border-[#eaecef]">
              <EmbeddedBrowserSlot
                target="feishu"
                initialUrl="https://open.feishu.cn/app"
                visible={step === 1}
                presets={[
                  { label: '飞书开放平台', url: 'https://open.feishu.cn/app' },
                  { label: '飞书网页版', url: 'https://www.feishu.cn/messenger/' }
                ]}
              />
            </div>

            {/* Right: Clean Guided Setup + Credentials */}
            <div className="col-span-5 flex h-full flex-col overflow-hidden bg-[#fafafa]">
              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {/* Credentials & Live Status Card */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-[13.5px] font-semibold text-[#111827]">飞书机器人凭证</h2>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#52525b]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isVerified
                            ? 'bg-emerald-500'
                            : feishuStatus.state === 'connected'
                              ? 'animate-pulse bg-amber-500'
                              : 'bg-[#d4d4d8]'
                        }`}
                      />
                      {isVerified
                        ? '已验通'
                        : feishuStatus.state === 'connected'
                          ? '长连接监听中'
                          : '未连接'}
                    </span>
                  </div>

                  <div className="space-y-2.5 text-[12.5px]">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[11.5px] font-medium text-[#52525b]">
                          App ID
                        </label>
                        <input
                          value={appId}
                          onChange={(e) => setAppId(e.target.value)}
                          placeholder="cli_a1b2c3..."
                          className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11.5px] font-medium text-[#52525b]">
                          App Secret
                        </label>
                        <input
                          type="password"
                          value={appSecret}
                          onChange={(e) => setAppSecret(e.target.value)}
                          placeholder="粘贴 App Secret"
                          className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] text-[#111827] outline-none transition-colors focus:border-[#18181b]"
                        />
                      </div>
                    </div>

                    <button
                      onClick={() => void handleConnectFeishu()}
                      disabled={connecting}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                    >
                      {connecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Radio className="h-3.5 w-3.5" />
                      )}
                      连接飞书长连接并监听验证
                    </button>

                    {/* Live Verification Banner */}
                    <div
                      className={`rounded-xl border px-3 py-2.5 text-[11.5px] transition-colors ${
                        isVerified
                          ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                          : feishuStatus.state === 'connected'
                            ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                            : feishuStatus.state === 'error'
                              ? 'border-red-200 bg-red-50/70 text-red-800'
                              : 'border-[#f1f1f3] bg-[#fafafa] text-[#71717a]'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {isVerified ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            连通验证通过！已收到你的飞书测试消息
                          </>
                        ) : feishuStatus.state === 'connected' ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
                            长连接已就绪：现在给飞书机器人发一句「你好」即可自动验通
                          </>
                        ) : (
                          <>
                            <Radio className="h-3.5 w-3.5 shrink-0 text-[#a1a1aa]" />
                            {feishuStatus.message || '等待填入 App ID / Secret 后点击连接'}
                          </>
                        )}
                      </div>
                      {(feishuStatus.lastPing?.text || state.feishu.lastPingMessage) && (
                        <div className="mt-1.5 rounded-lg bg-white/80 px-2.5 py-1 text-[11px] text-[#3f3f46]">
                          收到内容：「{feishuStatus.lastPing?.text || state.feishu.lastPingMessage}」
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {/* Auto-Detect Interactive 6-Step Guide */}
                <FeishuSetupGuide
                  feishuConnected={feishuStatus.state === 'connected'}
                  feishuVerified={isVerified}
                  appId={appId}
                  appSecret={appSecret}
                  onNavigateFeishuUrl={(url) => void window.fmc.navigateEmbeddedView('feishu', url)}
                />
              </div>

              {/* Sticky Footer */}
              <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-5 py-3">
                <button
                  onClick={() => goStep(2)}
                  className="text-[12px] text-[#8a8f98] transition-colors hover:text-[#111827]"
                >
                  暂跳过飞书
                </button>
                <button
                  onClick={() => goStep(2)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
                >
                  下一步：配置本地 CLI
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex h-full flex-col bg-white">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-[940px]">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-[15px] font-semibold text-[#111827]">
                      选择并启用本地 AI 编程 CLI
                    </h2>
                    <p className="mt-0.5 text-[12px] text-[#71717a]">
                      支持一键安装、检测更新与配置独立职能权重；所有配置均保存在 FMC 沙箱中，不修改本机原配置。
                    </p>
                  </div>
                </div>
                <CliManagerView
                  clis={clis}
                  scanning={scanning}
                  onRescan={onRescanClis}
                  onSaveConfig={onSaveCliConfig}
                  compact
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-6 py-3">
              <button
                onClick={() => goStep(1)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </button>
              <div className="flex items-center gap-3">
                <span className="text-[12px] text-[#71717a]">
                  已启用 <strong className="text-[#111827]">{enabledCount}</strong> 个 CLI 节点
                </span>
                <button
                  onClick={() => goStep(3)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
                >
                  下一步：登录 Muse 与隧道
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="grid h-full grid-cols-12">
            {/* Left: Embedded Muse Browser */}
            <div className="col-span-7 h-full border-r border-[#eaecef]">
              <EmbeddedBrowserSlot
                target="muse"
                initialUrl={museUrl}
                visible={step === 3}
                presets={[
                  { label: 'Meta Muse', url: 'https://muse.ai' },
                  { label: '飞书网页版', url: 'https://www.feishu.cn/messenger/' }
                ]}
              />
            </div>

            {/* Right: Tunnel & Protocol Sync */}
            <div className="col-span-5 flex h-full flex-col overflow-hidden bg-[#fafafa]">
              <div className="flex-1 space-y-4 overflow-y-auto p-5 text-[12.5px]">
                {/* Card 1: Muse Portal */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <h2 className="text-[13.5px] font-semibold text-[#111827]">1. 登录左侧 Muse 账号</h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[#71717a]">
                    在左侧完成一次登录，登录态会持久保存在本地独立分区中，后续在主界面即可使用原生对话窗与动态形象。
                  </p>
                  <div className="mt-2.5 flex items-start gap-1.5 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                    <span className="shrink-0">🌐</span>
                    <span>
                      <strong>网络提示：</strong>Meta Muse（muse.ai）目前在国内直连网络环境下无法使用。如果左侧网页白屏、一直转圈或加载失败，请先开启 VPN / 代理（推荐开启系统代理或 TUN 模式）后点击刷新。
                    </span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={museUrl}
                      onChange={(e) => setMuseUrl(e.target.value)}
                      className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 font-mono text-[11.5px] text-[#111827] outline-none focus:border-[#18181b]"
                    />
                    <button
                      onClick={() => {
                        void window.fmc.updateMuseConfig({ webUrl: museUrl });
                        void window.fmc.navigateEmbeddedView('muse', museUrl);
                      }}
                      className="rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
                    >
                      打开
                    </button>
                  </div>
                </section>

                {/* Card 2: Embedded Tailscale Permanent 443 Domain */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[13.5px] font-semibold text-[#111827]">
                      2. 开启内嵌 Tailscale 永久 443 域名
                    </h2>
                    {tunnelStatus.state === 'running' && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        在线
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[#71717a]">
                    免装客户端、重启不换域名，云端 Muse 只需批准一次「总是允许此站点」即可永久直连本机。
                  </p>

                  <div className="mt-3 space-y-2">
                    <input
                      value={tunnelUrl}
                      onChange={(e) => setTunnelUrl(e.target.value)}
                      placeholder="https://fmc-hub.tailxxxx.ts.net"
                      className="w-full rounded-xl border border-[#e4e4e7] bg-white px-3 py-1.5 font-mono text-[11.5px] text-[#111827] outline-none focus:border-[#18181b]"
                    />

                    <button
                      onClick={() => void handleToggleTunnel()}
                      disabled={tunnelStatus.state === 'starting'}
                      className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-medium text-white transition-colors disabled:opacity-60 ${
                        tunnelStatus.state === 'running'
                          ? 'bg-red-600 hover:bg-red-700'
                          : 'bg-[#18181b] hover:bg-[#27272a]'
                      }`}
                    >
                      {tunnelStatus.state === 'starting' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : tunnelStatus.state === 'running' ? (
                        <XCircle className="h-3.5 w-3.5" />
                      ) : (
                        <Cloud className="h-3.5 w-3.5" />
                      )}
                      {tunnelStatus.state === 'starting'
                        ? '正在建立永久域名...'
                        : tunnelStatus.state === 'running'
                          ? '停止内嵌 Tailscale 域名'
                          : '一键启动内嵌 Tailscale 永久域名'}
                    </button>

                    {tunnelStatus.authUrl && tunnelStatus.state === 'starting' && (
                      <div className="rounded-xl border border-[#e4e4e7] bg-[#fafafa] p-2.5 text-[11px] text-[#3f3f46]">
                        <div>请在浏览器完成一次性 Tailscale 授权：</div>
                        <button
                          onClick={() => void window.fmc.openExternal(tunnelStatus.authUrl!)}
                          className="mt-1 break-all font-mono text-[#111827] underline"
                        >
                          {tunnelStatus.authUrl}
                        </button>
                      </div>
                    )}

                    {tunnelStatus.message && (
                      <p
                        className={`text-[11px] ${
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
                  </div>
                </section>

                {/* Card 3: Sync Protocol to Muse */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <h2 className="text-[13.5px] font-semibold text-[#111827]">
                    3. 将调度协议同步给 Muse
                  </h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[#71717a]">
                    包含本地 API 地址、Token、各 CLI 职能权重及自动闭环规则；后续任何配置修改都会自动同步给 Muse。
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void handleSyncBriefDirect()}
                      disabled={syncingBrief}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#18181b] px-3.5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#27272a] disabled:opacity-50"
                    >
                      {syncingBrief ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      {syncTip || '一键发送给左侧 Muse'}
                    </button>
                    <button
                      onClick={() => void handleCopyBrief()}
                      className="inline-flex items-center gap-1 rounded-xl border border-[#e4e4e7] bg-white px-3 py-2 text-[12px] font-medium text-[#3f3f46] transition-colors hover:bg-[#f4f4f5]"
                    >
                      {copiedKey === 'brief' ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copiedKey === 'brief' ? '已复制' : '复制'}
                    </button>
                  </div>
                </section>
                {/* Card 4: Quick Tour of Key Controls in Settings */}
                <section className="rounded-2xl border border-[#eaecef] bg-white p-4">
                  <h2 className="text-[13.5px] font-semibold text-[#111827]">
                    4. 进入后可在「软件设置」自由调控的核心能力
                  </h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-[#71717a]">
                    完成引导后，你可以随时在左下角「软件设置」与左侧项目右键菜单中精细定制：
                  </p>
                  <div className="mt-2.5 grid grid-cols-1 gap-2 text-[11.5px]">
                    <div className="rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2">
                      <div className="font-medium text-[#111827]">两段式前置审批 + 用户习惯学习</div>
                      <div className="mt-0.5 text-[#71717a]">
                        先确认项目归属，再确认执行方案；支持「用户习惯自适应 / 总是审批 / 直接执行」三档切换。
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2">
                      <div className="font-medium text-[#111827]">项目模型与分工决策 + 100% 优先级权重</div>
                      <div className="mt-0.5 text-[#71717a]">
                        每日自动拉取权威评测榜单，按「能力 / 价格 / 剩余额度 / 速度」百分比权重为子任务匹配最擅长模型，不达标时递进升档省预算。
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2">
                      <div className="font-medium text-[#111827]">右键项目管理 & 本地 CLI 历史续聊</div>
                      <div className="mt-0.5 text-[#71717a]">
                        右键任意项目可独立限定可用 CLI、编辑简介、导入 Codex/Claude 本地历史并原生 --resume 远程续开发。
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#f1f1f3] bg-[#fafafa] px-3 py-2">
                      <div className="font-medium text-[#111827]">一键同步 Muse 形象为桌面图标</div>
                      <div className="mt-0.5 text-[#71717a]">
                        在「外观与字体」中可随时将当前 Muse 造型裁剪为无留白桌面与托盘图标。
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              {/* Sticky Footer */}
              <div className="flex shrink-0 items-center justify-between border-t border-[#eaecef] bg-white px-5 py-3">
                <button
                  onClick={() => goStep(2)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#e4e4e7] bg-white px-3.5 py-2 text-[12.5px] font-medium text-[#52525b] transition-colors hover:bg-[#f4f4f5] hover:text-[#111827]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  上一步
                </button>
                <button
                  onClick={() => void onComplete()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#18181b] px-5 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
                >
                  完成配置，进入工作台
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
