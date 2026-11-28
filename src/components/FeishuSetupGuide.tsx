import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  ExternalLink,
  HelpCircle,
  MessageSquarePlus,
  Wand2
} from 'lucide-react';
import { FeishuLiveGuideState } from '../types';

export const FEISHU_PERMISSION_JSON = JSON.stringify(
  {
    scopes: {
      tenant: [
        'im:message',
        'im:message:send_as_bot',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message.reactions:write_only',
        'im:chat:readonly',
        'im:resource'
      ],
      user: []
    }
  },
  null,
  2
);

const SCOPE_DETAILS = [
  { key: 'im:message', desc: '获取与发送单聊、群组消息（基础总权限）' },
  { key: 'im:message:send_as_bot', desc: '以机器人身份向你推送汇报与验收消息' },
  { key: 'im:message.p2p_msg:readonly', desc: '读取你私聊发给机器人的指令' },
  { key: 'im:message.group_at_msg:readonly', desc: '读取群聊中 @机器人的指令' },
  { key: 'im:message.reactions:write_only', desc: '收到指令后 0.2 秒贴 👀「已收到」表情确认' },
  { key: 'im:chat:readonly', desc: '读取会话基础信息' },
  { key: 'im:resource', desc: '双向收发图片、报错截图与本地文档附件' }
];

interface FeishuSetupGuideProps {
  feishuConnected?: boolean;
  feishuVerified?: boolean;
  appId?: string;
  appSecret?: string;
  botName?: string;
  liveGuide?: FeishuLiveGuideState | null;
  onNavigateFeishuUrl?: (url: string) => void;
  onHelperMessage?: (msg: string) => void;
  compact?: boolean;
}

export const FeishuSetupGuide: React.FC<FeishuSetupGuideProps> = ({
  feishuConnected = false,
  feishuVerified = false,
  appId = '',
  appSecret = '',
  botName = 'MuseDeck',
  liveGuide = null,
  onNavigateFeishuUrl,
  onHelperMessage,
  compact = false
}) => {
  const [manualChecked, setManualChecked] = useState<Record<number, boolean>>({});
  const [copiedKey, setCopiedKey] = useState('');
  const [showScopeList, setShowScopeList] = useState(false);
  const [showNotFoundHelp, setShowNotFoundHelp] = useState(false);
  const [spotlightOn, setSpotlightOn] = useState(true);
  const [localTip, setLocalTip] = useState('');

  const trimmedAppId = (appId || liveGuide?.detectedAppId || '').trim();
  const validCliAppId = /^cli_[a-zA-Z0-9]+$/.test(trimmedAppId) ? trimmedAppId : '';
  const botAppLink = validCliAppId
    ? `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(validCliAppId)}`
    : '';

  useEffect(() => {
    setManualChecked({});
  }, [trimmedAppId]);

  useEffect(() => {
    if (liveGuide && typeof liveGuide.spotlightEnabled === 'boolean') {
      setSpotlightOn(liveGuide.spotlightEnabled);
    }
  }, [liveGuide?.spotlightEnabled]);

  const notifyTip = (msg: string) => {
    setLocalTip(msg);
    onHelperMessage?.(msg);
  };

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 2000);
  };

  const handleToggleSpotlight = async () => {
    const next = !spotlightOn;
    setSpotlightOn(next);
    await window.fmc.setFeishuSpotlightEnabled(next);
  };

  const handleLocateStep = async (stepNum: number) => {
    if (stepNum === 1 && onNavigateFeishuUrl && !validCliAppId) {
      onNavigateFeishuUrl('https://open.feishu.cn/app');
    }
    const res = await window.fmc.jumpFeishuGuideStep(stepNum, validCliAppId || undefined);
    if (res.message) notifyTip(res.message);
  };

  const handleQuickFill = async (kind: 'app_info' | 'permission_json' | 'version_draft') => {
    const res = await window.fmc.quickFillFeishuStep(kind, { botName });
    if (kind === 'permission_json') {
      setCopiedKey('json');
      setTimeout(() => setCopiedKey(''), 2200);
    }
    if (res.message) notifyTip(res.message);
  };

  const hasCompleteCreds = Boolean(validCliAppId && appSecret.trim());
  const step5AutoDone = Boolean(
    (liveGuide?.longConnectionSaved && liveGuide?.receiveEventAdded) ||
      (hasCompleteCreds && feishuVerified)
  );
  const step6AutoDone = Boolean(
    liveGuide?.versionPublished || (hasCompleteCreds && feishuVerified)
  );

  const stepDone: Record<number, boolean> = {
    1: Boolean(validCliAppId || manualChecked[1]),
    2: Boolean(liveGuide?.hasBotCapability || manualChecked[2]),
    3: Boolean(manualChecked[3] || step5AutoDone),
    4: Boolean((hasCompleteCreds && feishuConnected) || manualChecked[4]),
    5: Boolean(step5AutoDone || manualChecked[5]),
    6: Boolean(step6AutoDone || manualChecked[6])
  };

  const completedCount = [1, 2, 3, 4, 5, 6].filter((n) => stepDone[n]).length;
  const activeStep = [1, 2, 3, 4, 5, 6].find((n) => !stepDone[n]) || 0;

  const toggleManual = (n: number) => {
    setManualChecked((prev) => ({ ...prev, [n]: !prev[n] }));
  };

  const renderCheckbox = (num: number) => {
    const done = stepDone[num];
    const isCurrent = activeStep === num;
    return (
      <button
        type="button"
        onClick={() => toggleManual(num)}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-all"
        title={done ? '已完成（点击可切换手动标记）' : '完成此步后可点此打勾确认'}
      >
        {done ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : isCurrent ? (
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-semibold text-white shadow-2xs">
            {num}
          </span>
        ) : (
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[#d4d4d8] bg-white text-[10px] font-medium text-[#71717a]">
            {num}
          </span>
        )}
      </button>
    );
  };

  const stepCardClass = (num: number) => {
    const done = stepDone[num];
    const isCurrent = activeStep === num;
    if (isCurrent) {
      return 'rounded-xl border-2 border-[#18181b] bg-white p-3.5 shadow-2xs transition-all';
    }
    if (done) {
      return 'rounded-xl border border-emerald-200/80 bg-emerald-50/25 p-3.5 transition-all';
    }
    return 'rounded-xl border border-[#eaecef] bg-white p-3.5 transition-all';
  };

  const renderStepFooter = (num: number, extraBtn?: React.ReactNode) => {
    const done = stepDone[num];
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void handleLocateStep(num)}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50/80 px-2 py-0.5 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100"
          title="在左侧飞书后台跳转并用红色脉冲框高亮标记本步点击位置"
        >
          <Crosshair className="h-3 w-3" />
          在左侧高亮定位此步
        </button>
        {extraBtn}
        <button
          type="button"
          onClick={() => toggleManual(num)}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
            done
              ? 'bg-emerald-100/80 text-emerald-800 hover:bg-emerald-100'
              : 'border border-[#e4e4e7] bg-[#fafafa] text-[#52525b] hover:border-[#18181b] hover:text-[#111827]'
          }`}
        >
          <Check className="h-3 w-3" />
          {done ? '已完成' : '标记已完成'}
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-3 text-[12px] text-[#3f3f46]">
      {/* Spotlight Header + Live Progress Bar */}
      <div className="rounded-2xl border border-[#eaecef] bg-white p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <h4 className="text-[13px] font-semibold text-[#111827]">
                🎯 飞书 6 步实景高亮跟做指引
              </h4>
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10.5px] font-semibold text-red-700 ring-1 ring-red-200">
                进度 {completedCount}/6
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[#71717a]">
              左侧网页已自动为你套上<strong>红色呼吸脉冲框 + 浮动气泡</strong>，跟着高亮位置手动点击最稳妥零出错！
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleToggleSpotlight()}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              spotlightOn
                ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                : 'border-[#e4e4e7] bg-[#fafafa] text-[#52525b] hover:bg-[#f4f4f5]'
            }`}
          >
            {spotlightOn ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {spotlightOn ? '实景高亮：已开启' : '实景高亮：已关闭'}
          </button>
        </div>

        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#f1f1f3]">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
            style={{ width: `${Math.round((completedCount / 6) * 100)}%` }}
          />
        </div>

        {(liveGuide?.activeTargetHint || localTip) && (
          <div className="mt-2.5 rounded-lg border border-[#eaecef] bg-[#fafafa] px-2.5 py-1.5 text-[11px] font-medium text-[#111827]">
            {localTip || liveGuide?.activeTargetHint}
          </div>
        )}
      </div>

      <div className="space-y-2.5">
        {/* Step 1 */}
        <div className={stepCardClass(1)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(1)}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">
                  第 1 步：扫码登录并创建「企业自建应用」
                </span>
                {validCliAppId ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800">
                    已识别 {validCliAppId}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (onNavigateFeishuUrl) onNavigateFeishuUrl('https://open.feishu.cn/app');
                      else void window.fmc.openExternal('https://open.feishu.cn/app');
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#e4e4e7] bg-[#fafafa] px-2 py-0.5 text-[11px] font-medium text-[#111827] hover:bg-[#f1f1f3]"
                  >
                    <ExternalLink className="h-3 w-3" />
                    刷新开放平台首页
                  </button>
                )}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>
                  用手机飞书扫码登录左侧页面，<strong>核对右上角头像旁的「企业/团队名称」与你手机飞书左上角一致</strong>（个人号可免费建一个个人测试团队，自己当管理员免审秒过）。
                </li>
                <li>
                  点击左侧红色高亮的「<strong>创建企业自建应用</strong>」，填入名称与描述（可点下方一键代填），点击「<strong>创建</strong>」。
                </li>
              </ol>
              {renderStepFooter(
                1,
                !validCliAppId ? (
                  <button
                    type="button"
                    onClick={() => void handleQuickFill('app_info')}
                    className="inline-flex items-center gap-1 rounded-md border border-[#e4e4e7] bg-white px-2 py-0.5 text-[11px] font-medium text-[#111827] hover:bg-[#f4f4f5]"
                  >
                    <Wand2 className="h-3 w-3 text-amber-500" />
                    一键代填名称描述
                  </button>
                ) : null
              )}
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className={stepCardClass(2)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(2)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 2 步：开启「机器人」能力</span>
                {liveGuide?.hasBotCapability && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                    已开启机器人能力
                  </span>
                )}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧菜单点击高亮的「<strong>添加应用能力</strong>」。</li>
                <li>找到「<strong>机器人</strong>」卡片，点击卡片右下角的「<strong>+ 添加</strong>」。</li>
              </ol>
              {renderStepFooter(2)}
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className={stepCardClass(3)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(3)}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">
                  第 3 步：批量导入 7 项消息与图片文件权限
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleQuickFill('permission_json')}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                    title="同时复制到剪贴板，并在你打开「导入权限」弹窗时直接一键写入左侧编辑器"
                  >
                    {copiedKey === 'json' ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Wand2 className="h-3 w-3 text-amber-400" />
                    )}
                    {copiedKey === 'json' ? '已复制/填入 JSON' : '复制并填入权限 JSON'}
                  </button>
                </div>
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在左侧菜单点击「<strong>权限管理</strong>」→ 点击页面上的「<strong>批量导入/导出权限</strong>」。</li>
                <li>
                  确保切在「<strong>导入权限</strong>」标签，点击上方黑色「<strong>复制并填入权限 JSON</strong>」（或清空输入框按 <code className="rounded bg-[#f4f4f5] px-1">Ctrl+V</code> 粘贴）。
                </li>
                <li>点击弹窗右下角「<strong>下一步，确认新增权限</strong>」→「<strong>申请开通</strong>」。</li>
              </ol>

              <button
                type="button"
                onClick={() => setShowScopeList((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#52525b] hover:text-[#111827]"
              >
                {showScopeList ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showScopeList ? '收起权限明细' : '查看 7 条权限明细'}
              </button>

              {showScopeList && (
                <div className="mt-2 space-y-1 rounded-lg bg-[#fafafa] p-2.5 ring-1 ring-[#f1f1f3]">
                  {SCOPE_DETAILS.map((s) => (
                    <div key={s.key} className="flex flex-col gap-0.5 text-[11px]">
                      <code className="font-mono font-medium text-[#111827]">{s.key}</code>
                      <span className="text-[#71717a]">{s.desc}</span>
                    </div>
                  ))}
                </div>
              )}
              {renderStepFooter(3)}
            </div>
          </div>
        </div>

        {/* Step 4 */}
        <div className={stepCardClass(4)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(4)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">
                  第 4 步：复制 App Secret 密钥并先在上方点「连接」
                </span>
                {feishuConnected ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                    长连接已在线
                  </span>
                ) : !appSecret.trim() ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                    待粘贴密钥
                  </span>
                ) : null}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>
                  点击左侧菜单「<strong>凭证与基础信息</strong>」：<code className="rounded bg-[#f4f4f5] px-1">App ID</code> 会自动填入，请你<strong>点击 <code className="rounded bg-[#f4f4f5] px-1">App Secret</code> 右侧的复制图标</strong>。
                </li>
                <li>
                  复制后上方密钥框会<strong>自动捕获填入</strong>（若未自动填入，请手动粘贴到上方 <code className="rounded bg-[#f4f4f5] px-1">App Secret</code> 输入框），然后点击「<strong>连接飞书长连接</strong>」直到状态显示<strong>在线</strong>！
                </li>
              </ol>
              {!compact && !stepDone[4] && (
                <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50/80 px-2.5 py-1.5 text-[11px] text-amber-900 ring-1 ring-amber-200/70">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    <strong>顺序关键：</strong>必须先在上方填好密钥并连上长连接，第 5 步在飞书后台点「保存」才会通过校验！
                  </span>
                </div>
              )}
              {renderStepFooter(4)}
            </div>
          </div>
        </div>

        {/* Step 5 — Explicit Two-Step Long-Connection Toggle + Event Subscription */}
        <div className={stepCardClass(5)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(5)}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">
                  第 5 步：两步开启长连接 + 订阅「接收消息」事件
                </span>
                <button
                  type="button"
                  onClick={() => void copy('event', 'im.message.receive_v1')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#e4e4e7] bg-[#fafafa] px-2 py-0.5 text-[11px] font-medium text-[#3f3f46] hover:bg-[#f1f1f3]"
                >
                  {copiedKey === 'event' ? (
                    <Check className="h-3 w-3 text-emerald-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === 'event' ? '已复制事件名' : '复制 im.message.receive_v1'}
                </button>
              </div>

              {/* Live Sub-Step Verification Pills */}
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10.5px]">
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${
                    liveGuide?.longConnectionSaved
                      ? 'bg-emerald-100 text-emerald-800'
                      : liveGuide?.subscriptionEditExpanded
                        ? 'bg-blue-50 text-blue-800 ring-1 ring-blue-200'
                        : 'bg-[#f4f4f5] text-[#52525b]'
                  }`}
                >
                  {liveGuide?.longConnectionSaved
                    ? '✅ 1. 长连接订阅方式：已成功打开'
                    : liveGuide?.subscriptionEditExpanded
                      ? '👉 1. 已展开选项，请点蓝色「保存」'
                      : '⏳ 1. 长连接订阅：待开启（点✏️→保存）'}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${
                    liveGuide?.receiveEventAdded
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-[#f4f4f5] text-[#52525b]'
                  }`}
                >
                  {liveGuide?.receiveEventAdded
                    ? '✅ 2. 接收消息事件：已订阅'
                    : '⏳ 2. 接收消息事件：待添加'}
                </span>
              </div>

              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在左侧菜单点击「<strong>事件与回调</strong>」（默认进入「事件配置」标签）。</li>
                <li>
                  <strong>【开启长连接的两个动作】</strong>：① 先点击「<strong>订阅方式</strong>」右侧的<strong>蓝色铅笔图标 ✏️</strong> 展开编辑区 → ② 确认选中「<strong>使用长连接接收事件</strong>」，点击下方蓝色「<strong>保存</strong>」按钮（页面不再显示「未配置」即代表成功打开！）。
                </li>
                <li>
                  点击页面下方「<strong>+ 添加事件</strong>」，搜索并勾选 <code className="rounded bg-[#f4f4f5] px-1">im.message.receive_v1</code>（<strong>接收消息 v2.0</strong>），点击「<strong>确认添加</strong>」。
                </li>
              </ol>
              {renderStepFooter(5)}
            </div>
          </div>
        </div>

        {/* Step 6 */}
        <div className={stepCardClass(6)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(6)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">
                  第 6 步：保存并申请线上发布 → 一键唤起对话验收
                </span>
                {(feishuVerified || liveGuide?.versionPublished) && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                    {feishuVerified ? '双向消息已验通' : '版本已发布'}
                  </span>
                )}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1.5 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>左侧点击「<strong>版本管理与发布</strong>」→「<strong>创建版本</strong>」。</li>
                <li>
                  填写版本号（如 <code className="rounded bg-[#f4f4f5] px-1">1.0.0</code>）与更新说明（可点下方一键代填），确认「<strong>可用范围</strong>」已包含你自己。
                </li>
                <li>
                  先点页面底部「<strong>保存</strong>」，<strong>紧接着必须再点右上角蓝色的「申请线上发布 / 确认发布」</strong>，直到版本状态变为绿色「<strong>已发布</strong>」！
                </li>
                <li>
                  发布成功后，点击下方黑色按钮<strong>直接唤起飞书机器人聊天窗</strong>，发送一句「<strong>你好</strong>」收到回执即大功告成！
                </li>
              </ol>

              {botAppLink ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-[#e4e4e7] bg-[#fafafa] p-2.5">
                  <button
                    type="button"
                    onClick={() => void window.fmc.openExternal(botAppLink)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#18181b] px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[#27272a]"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    一键在飞书中打开该机器人对话框
                  </button>
                  <button
                    type="button"
                    onClick={() => void copy('applink', botAppLink)}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#e4e4e7] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[#3f3f46] hover:bg-[#f4f4f5]"
                  >
                    {copiedKey === 'applink' ? (
                      <Check className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copiedKey === 'applink' ? '已复制唤起链接' : '复制链接到手机飞书打开'}
                  </button>
                </div>
              ) : null}

              {/* Troubleshooting Box */}
              <div className="mt-2.5 rounded-lg border border-amber-200/80 bg-amber-50/60 p-2.5 text-[11px] text-amber-950">
                <button
                  type="button"
                  onClick={() => setShowNotFoundHelp((v) => !v)}
                  className="flex w-full items-center justify-between text-left font-semibold text-amber-950"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <HelpCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    排查：为什么飞书里搜不到新建的机器人？
                  </span>
                  {showNotFoundHelp ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  )}
                </button>
                {showNotFoundHelp && (
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed text-amber-900">
                    <li>
                      <strong>企业组织不一致（最常见）</strong>：检查飞书客户端左上角头像当前选中的企业，是否与飞书开放平台右上角显示的企业相同。
                    </li>
                    <li>
                      <strong>只点了保存未点「申请线上发布」</strong>：确认「版本管理与发布」中状态已是绿色「已发布」。
                    </li>
                    <li>
                      <strong>搜索索引延迟</strong>：直接点击上方「一键在飞书中打开该机器人对话框」即可免搜索直达私聊。
                    </li>
                  </ul>
                )}
              </div>

              {renderStepFooter(
                6,
                <button
                  type="button"
                  onClick={() => void handleQuickFill('version_draft')}
                  className="inline-flex items-center gap-1 rounded-md border border-[#e4e4e7] bg-white px-2 py-0.5 text-[11px] font-medium text-[#111827] hover:bg-[#f4f4f5]"
                >
                  <Wand2 className="h-3 w-3 text-amber-500" />
                  一键代填 1.0.0 版本信息
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
