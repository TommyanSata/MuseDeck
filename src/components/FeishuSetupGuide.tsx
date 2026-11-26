import React, { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink
} from 'lucide-react';

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
  { key: 'im:message.reactions:write_only', desc: '收到指令后自动回复「已收到」表情确认' },
  { key: 'im:chat:readonly', desc: '读取会话基础信息' },
  { key: 'im:resource', desc: '上传并向飞书发送图片、截图与本地文档附件' }
];

interface FeishuSetupGuideProps {
  feishuConnected?: boolean;
  feishuVerified?: boolean;
  appId?: string;
  appSecret?: string;
  onNavigateFeishuUrl?: (url: string) => void;
  compact?: boolean;
}

export const FeishuSetupGuide: React.FC<FeishuSetupGuideProps> = ({
  feishuConnected = false,
  feishuVerified = false,
  onNavigateFeishuUrl,
  compact = false
}) => {
  const [manualChecked, setManualChecked] = useState<Record<number, boolean>>({});
  const [copiedKey, setCopiedKey] = useState('');
  const [showScopeList, setShowScopeList] = useState(false);

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 2000);
  };

  const openPortal = () => {
    const url = 'https://open.feishu.cn/app';
    if (onNavigateFeishuUrl) {
      onNavigateFeishuUrl(url);
    } else {
      void window.fmc.openExternal(url);
    }
  };

  // Manual confirmation for config steps; only objectively verifiable connection/ping auto-checks
  const stepDone: Record<number, boolean> = {
    1: Boolean(manualChecked[1]),
    2: Boolean(manualChecked[2]),
    3: Boolean(manualChecked[3]),
    4: Boolean(feishuConnected || manualChecked[4]),
    5: Boolean(feishuVerified || manualChecked[5]),
    6: Boolean(feishuVerified || manualChecked[6])
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
        title={done ? '已完成（点击可取消勾选）' : '完成此步后点此手动打勾确认'}
      >
        {done ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : isCurrent ? (
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#18181b] text-[10px] font-semibold text-white">
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
      return 'rounded-xl border border-[#18181b] bg-white p-3.5 shadow-2xs transition-all';
    }
    if (done) {
      return 'rounded-xl border border-emerald-200/70 bg-emerald-50/25 p-3.5 transition-all';
    }
    return 'rounded-xl border border-[#eaecef] bg-white p-3.5 transition-all';
  };

  const renderConfirmPill = (num: number) => {
    const done = stepDone[num];
    return (
      <button
        type="button"
        onClick={() => toggleManual(num)}
        className={`mt-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
          done
            ? 'bg-emerald-100/80 text-emerald-800 hover:bg-emerald-100'
            : 'border border-[#e4e4e7] bg-[#fafafa] text-[#52525b] hover:border-[#18181b] hover:text-[#111827]'
        }`}
      >
        <Check className="h-3 w-3" />
        {done ? '已确认完成' : '我已完成此步'}
      </button>
    );
  };

  return (
    <div className="space-y-3 text-[12px] text-[#3f3f46]">
      {/* Header + Manual Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-[#111827]">
              飞书机器人 6 步详细配置指引
            </h4>
            <p className="mt-0.5 text-[11px] text-[#71717a]">
              按顺序逐项操作并点击「我已完成此步」手动确认（第 4 步连接成功与第 6 步验通会自动打勾） · 进度 {completedCount}/6
            </p>
          </div>
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f1f1f3]">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
            style={{ width: `${Math.round((completedCount / 6) * 100)}%` }}
          />
        </div>
      </div>

      <div className="space-y-2.5">
        {/* Step 1 */}
        <div className={stepCardClass(1)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(1)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 1 步：创建企业自建应用</span>
                <button
                  type="button"
                  onClick={openPortal}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#e4e4e7] bg-[#fafafa] px-2 py-0.5 text-[11px] font-medium text-[#111827] hover:bg-[#f1f1f3]"
                >
                  <ExternalLink className="h-3 w-3" />
                  打开开放平台
                </button>
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在左侧飞书开放平台登录你的飞书账号（个人可免费注册一个测试企业）。</li>
                <li>点击页面上的「<strong>创建企业自建应用</strong>」，填写应用名称（如 <code className="rounded bg-[#f4f4f5] px-1">MuseDeck</code>）与描述。</li>
                <li>点击「确定」进入该应用的管理后台。</li>
              </ol>
              {renderConfirmPill(1)}
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className={stepCardClass(2)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(2)}
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-[#111827]">第 2 步：添加「机器人」能力</span>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧菜单栏点击「<strong>添加应用能力</strong>」。</li>
                <li>找到「<strong>机器人</strong>」卡片，点击右下角的「<strong>+ 添加</strong>」即可启用机器人身份。</li>
              </ol>
              {renderConfirmPill(2)}
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className={stepCardClass(3)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(3)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 3 步：一键批量导入 7 项消息与文件权限</span>
                <button
                  type="button"
                  onClick={() => void copy('json', FEISHU_PERMISSION_JSON)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#18181b] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#27272a]"
                >
                  {copiedKey === 'json' ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === 'json' ? '已复制 JSON' : '复制权限 JSON'}
                </button>
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧菜单栏点击「<strong>权限管理</strong>」。</li>
                <li>点击右上角「<strong>批量导入/导出权限</strong>」按钮，切换到「<strong>导入权限</strong>」标签。</li>
                <li>清空输入框后粘贴上方复制的 JSON，点击「<strong>下一步，确认新增权限</strong>」→「<strong>申请开通</strong>」。</li>
              </ol>

              <button
                type="button"
                onClick={() => setShowScopeList((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[#52525b] hover:text-[#111827]"
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
              <div>{renderConfirmPill(3)}</div>
            </div>
          </div>
        </div>

        {/* Step 4 */}
        <div className={stepCardClass(4)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(4)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 4 步：复制凭证并先在 MuseDeck 点「连接」</span>
                {feishuConnected && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                    长连接已在线
                  </span>
                )}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧点击「<strong>凭证与基础信息</strong>」，复制 <code className="rounded bg-[#f4f4f5] px-1">App ID</code> 与 <code className="rounded bg-[#f4f4f5] px-1">App Secret</code>。</li>
                <li>粘贴到本页上方的输入框中，点击「<strong>连接飞书长连接</strong>」，等待状态变为绿色「在线」。</li>
              </ol>
              {!compact && !stepDone[4] && (
                <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50/80 px-2.5 py-1.5 text-[11px] text-amber-900 ring-1 ring-amber-200/70">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    顺序很关键：必须先在 MuseDeck 连上长连接，再去第 5 步点保存，否则飞书会提示「未检测到在线长连接客户端」。
                  </span>
                </div>
              )}
              {renderConfirmPill(4)}
            </div>
          </div>
        </div>

        {/* Step 5 */}
        <div className={stepCardClass(5)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(5)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 5 步：配置长连接并订阅「接收消息」事件</span>
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
                  {copiedKey === 'event' ? '已复制事件名' : '复制事件名'}
                </button>
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧点击「<strong>事件与回调</strong>」→「<strong>事件配置</strong>」。</li>
                <li>订阅方式选择「<strong>使用长连接接收事件</strong>」，点击「<strong>保存</strong>」。</li>
                <li>点击下方「<strong>添加事件</strong>」，搜索并勾选 <code className="rounded bg-[#f4f4f5] px-1">im.message.receive_v1</code>（接收消息 v2.0），点击「<strong>确认添加</strong>」。</li>
              </ol>
              {renderConfirmPill(5)}
            </div>
          </div>
        </div>

        {/* Step 6 */}
        <div className={stepCardClass(6)}>
          <div className="flex items-start gap-2.5">
            {renderCheckbox(6)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#111827]">第 6 步：发布应用版本并私聊验证</span>
                {feishuVerified && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                    已收到消息验通
                  </span>
                )}
              </div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed text-[#52525b]">
                <li>在应用后台左侧点击「<strong>版本管理与发布</strong>」→「<strong>创建版本</strong>」。</li>
                <li>填写版本号（如 <code className="rounded bg-[#f4f4f5] px-1">1.0.0</code>）和更新说明，点击「<strong>保存</strong>」→「<strong>确认发布</strong>」（测试企业通常秒过审）。</li>
                <li>打开手机或电脑飞书，搜索你刚创建的机器人名称，私聊发送一句「<strong>你好</strong>」；收到 MuseDeck 自动回复即代表双向打通！</li>
              </ol>
              {renderConfirmPill(6)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
