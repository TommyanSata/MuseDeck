import { clipboard, WebContents } from 'electron';
import { FEISHU_REQUIRED_SCOPES_JSON } from './browserAutoPilot';

export interface FeishuLiveGuideState {
  url: string;
  loggedIn: boolean;
  detectedAppId: string;
  hasBotCapability: boolean;
  onAuthPage: boolean;
  onBaseInfoPage: boolean;
  onEventPage: boolean;
  subscriptionEditExpanded: boolean;
  longConnectionSaved: boolean;
  receiveEventAdded: boolean;
  onVersionPage: boolean;
  versionPublished: boolean;
  openModalKind?: 'create_app' | 'import_json' | 'create_version' | null;
  activeTargetHint: string;
  spotlightEnabled: boolean;
}

interface PageProbeResult {
  url: string;
  loggedIn: boolean;
  detectedAppId: string;
  hasBotCapability: boolean;
  onAuthPage: boolean;
  onBaseInfoPage: boolean;
  onEventPage: boolean;
  subscriptionEditExpanded: boolean;
  longConnectionSaved: boolean;
  receiveEventAdded: boolean;
  onVersionPage: boolean;
  versionPublished: boolean;
  openModalKind: 'create_app' | 'import_json' | 'create_version' | null;
  recentBaseInfoClickMsAgo: number;
  activeTargetHint: string;
}

export class FeishuSpotlightController {
  private wc: WebContents | null = null;
  private timer: NodeJS.Timeout | null = null;
  private spotlightEnabled = true;
  private focusStepOverride: number | null = null;
  private lastClipboardBaseline = '';
  private lastBroadcastSig = '';
  private getBridgeContext: () => {
    hasAppSecret: boolean;
    feishuConnected: boolean;
    feishuVerified: boolean;
  };
  private onGuideState: (state: FeishuLiveGuideState) => void;
  private onCredentialCaptured: (cred: { appId?: string; appSecret?: string }) => void;

  constructor(opts: {
    getBridgeContext: () => {
      hasAppSecret: boolean;
      feishuConnected: boolean;
      feishuVerified: boolean;
    };
    onGuideState: (state: FeishuLiveGuideState) => void;
    onCredentialCaptured: (cred: { appId?: string; appSecret?: string }) => void;
  }) {
    this.getBridgeContext = opts.getBridgeContext;
    this.onGuideState = opts.onGuideState;
    this.onCredentialCaptured = opts.onCredentialCaptured;
  }

  attach(wc: WebContents | null): void {
    this.wc = wc;
    this.lastClipboardBaseline = clipboard.readText().trim();
    if (wc && !this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 850);
      void this.tick();
    } else if (!wc && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  detach(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wc && !this.wc.isDestroyed()) {
      void this.wc
        .executeJavaScript(
          `(() => {
            const root = document.getElementById('fmc-spotlight-root');
            if (root) root.style.display = 'none';
          })()`,
          true
        )
        .catch(() => {});
    }
    this.wc = null;
  }

  setSpotlightEnabled(enabled: boolean): void {
    this.spotlightEnabled = enabled;
    this.lastBroadcastSig = '';
    void this.tick();
  }

  setFocusStep(step: number | null): void {
    this.focusStepOverride = step;
    this.lastBroadcastSig = '';
    void this.tick();
  }

  async jumpToStep(step: number, appIdHint?: string): Promise<{ ok: boolean; message: string }> {
    if (!this.wc || this.wc.isDestroyed()) {
      return { ok: false, message: '飞书开放平台视图尚未打开' };
    }
    this.focusStepOverride = step;
    this.spotlightEnabled = true;
    const curAppId =
      this.wc.getURL().match(/\/app\/(cli_[a-zA-Z0-9]+)/)?.[1] ||
      (/^cli_[a-zA-Z0-9]+$/.test((appIdHint || '').trim()) ? (appIdHint || '').trim() : '');

    if (step === 1 || !curAppId) {
      if (!this.wc.getURL().includes('open.feishu.cn/app')) {
        await this.wc.loadURL('https://open.feishu.cn/app');
      }
      await this.tick();
      return {
        ok: true,
        message: curAppId
          ? '已在左侧为你高亮标记操作位置'
          : '请先在左侧点击高亮的「创建企业自建应用」进入应用后台'
      };
    }

    const stepUrlMap: Record<number, string> = {
      2: `https://open.feishu.cn/app/${curAppId}`,
      3: `https://open.feishu.cn/app/${curAppId}/auth`,
      4: `https://open.feishu.cn/app/${curAppId}/baseinfo`,
      5: `https://open.feishu.cn/app/${curAppId}/event`,
      6: `https://open.feishu.cn/app/${curAppId}/version`
    };
    const targetUrl = stepUrlMap[step];
    if (targetUrl && !this.wc.getURL().startsWith(targetUrl)) {
      await this.wc.loadURL(targetUrl);
    }
    setTimeout(() => {
      void this.tick();
    }, 600);
    return { ok: true, message: `已跳转至第 ${step} 步对应页面并开启实景高亮脉冲指引` };
  }

  async quickFill(
    kind: 'app_info' | 'permission_json' | 'version_draft',
    params?: { botName?: string; botDesc?: string }
  ): Promise<{ ok: boolean; message: string }> {
    if (!this.wc || this.wc.isDestroyed()) {
      return { ok: false, message: '飞书视图尚未打开' };
    }
    const wc = this.wc;

    if (kind === 'app_info') {
      const botName = (params?.botName || 'MuseDeck').trim() || 'MuseDeck';
      const botDesc = (params?.botDesc || 'MuseDeck 本地多智能体调度助手').trim();
      const filled = (await wc
        .executeJavaScript(
          `(() => {
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
            if (!modal) return false;
            const fields = Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), textarea'))
              .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
            if (fields.length === 0) return false;
            const setVal = (el, val) => {
              const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const prev = el.value || '';
              if (setter) setter.call(el, val);
              else el.value = val;
              if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
                el._valueTracker.setValue(prev);
              }
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            if (fields[0]) setVal(fields[0], ${JSON.stringify(botName)});
            if (fields[1]) setVal(fields[1], ${JSON.stringify(botDesc)});
            return true;
          })()`,
          true
        )
        .catch(() => false)) as boolean;
      void this.tick();
      return filled
        ? { ok: true, message: '已自动填入应用名称与描述，请点击弹窗右下角高亮的「创建」按钮！' }
        : { ok: false, message: '请先在左侧点击「创建企业自建应用」打开弹窗，再点此一键填入' };
    }

    if (kind === 'permission_json') {
      clipboard.writeText(FEISHU_REQUIRED_SCOPES_JSON);
      this.lastClipboardBaseline = FEISHU_REQUIRED_SCOPES_JSON.trim();
      const injected = (await wc
        .executeJavaScript(
          `(() => {
            const jsonStr = ${JSON.stringify(FEISHU_REQUIRED_SCOPES_JSON)};
            const modal = document.querySelector('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal');
            if (!modal) return false;
            let ok = false;
            if (window.monaco && window.monaco.editor && window.monaco.editor.getModels) {
              const models = window.monaco.editor.getModels();
              if (models.length > 0) {
                models[models.length - 1].setValue(jsonStr);
                ok = true;
              }
            }
            const editorNodes = Array.from(modal.querySelectorAll('.monaco-editor, [class*="monaco"], [class*="editor"]'));
            for (const node of editorNodes) {
              const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
              let cur = fiberKey ? node[fiberKey] : null;
              for (let depth = 0; cur && depth < 15; depth++, cur = cur.return) {
                const inst = cur.stateNode;
                if (inst && inst.editor && typeof inst.editor.setValue === 'function') {
                  inst.editor.setValue(jsonStr);
                  ok = true;
                }
                if (cur.ref && cur.ref.current && cur.ref.current.editor && typeof cur.ref.current.editor.setValue === 'function') {
                  cur.ref.current.editor.setValue(jsonStr);
                  ok = true;
                }
              }
            }
            return ok;
          })()`,
          true
        )
        .catch(() => false)) as boolean;
      void this.tick();
      return injected
        ? {
            ok: true,
            message:
              '✅ 已将 7 项权限 JSON 直接填入左侧弹窗！请点击弹窗右下角高亮的「下一步，确认新增权限」→「申请开通」'
          }
        : {
            ok: true,
            message:
              '📋 已复制 7 项权限 JSON 到剪贴板！请在左侧点击「批量导入/导出权限」→「导入权限」，清空编辑器后按 Ctrl+V 粘贴'
          };
    }

    if (kind === 'version_draft') {
      const filled = (await wc
        .executeJavaScript(
          `(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
              .filter((el) => el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
            const textareas = Array.from(document.querySelectorAll('textarea'))
              .filter((el) => el.getBoundingClientRect().width > 120 && el.getBoundingClientRect().height > 36);
            if (inputs.length === 0 && textareas.length === 0) return false;
            const setVal = (el, val) => {
              const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const prev = el.value || '';
              if (setter) setter.call(el, val);
              else el.value = val;
              if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
                el._valueTracker.setValue(prev);
              }
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            if (inputs[0] && !inputs[0].value) setVal(inputs[0], '1.0.0');
            if (textareas[0] && !textareas[0].value) setVal(textareas[0], 'MuseDeck 飞书机器人初始版本');
            return true;
          })()`,
          true
        )
        .catch(() => false)) as boolean;
      void this.tick();
      return filled
        ? {
            ok: true,
            message: '已填入版本号 1.0.0 与更新说明！请滑到底部点击「保存」，随后点击右上角「申请线上发布」'
          }
        : { ok: false, message: '请先在左侧点击「创建版本」进入版本表单页，再点此一键填入' };
    }

    return { ok: false, message: '未知辅助操作' };
  }

  private async tick(): Promise<void> {
    if (!this.wc || this.wc.isDestroyed() || this.wc.isLoading()) return;
    const ctx = this.getBridgeContext();

    try {
      const probe = (await this.wc.executeJavaScript(
        `(() => {
          const href = location.href;
          const bodyText = (document.body?.innerText || '').replace(/\\u00a0/g, ' ');
          const onPassport = href.includes('accounts.feishu.cn') || href.includes('passport.feishu.cn');
          const appMatch = href.match(/\\/app\\/(cli_[a-zA-Z0-9]+)/);
          const detectedAppId = appMatch ? appMatch[1] : '';
          const loggedIn =
            !onPassport &&
            (Boolean(detectedAppId) ||
              bodyText.includes('企业自建应用') ||
              bodyText.includes('创建企业自建应用') ||
              bodyText.includes('凭证与基础信息'));

          // Install passive click timestamp tracker on /baseinfo so clipboard auto-fill ONLY runs right after user clicks Copy!
          if (!window.__fmcClickTrackerInstalled) {
            window.__fmcClickTrackerInstalled = true;
            window.__fmcLastClickAt = 0;
            document.addEventListener(
              'mousedown',
              () => {
                window.__fmcLastClickAt = Date.now();
              },
              { capture: true, passive: true }
            );
          }
          const recentBaseInfoClickMsAgo =
            href.includes('/baseinfo') && window.__fmcLastClickAt
              ? Date.now() - window.__fmcLastClickAt
              : 999999;

          const menuTexts = Array.from(
            document.querySelectorAll('aside *, nav *, [class*="menu"] *, [class*="sider"] *')
          ).map((el) => (el instanceof HTMLElement ? (el.innerText || '').trim() : ''));
          const hasBotCapability = menuTexts.includes('机器人');

          const onAuthPage = href.includes('/auth');
          const onBaseInfoPage = href.includes('/baseinfo');
          const onEventPage = href.includes('/event');
          const onVersionPage = href.includes('/version');

          // Accurate detection of the 2-step Long-Connection toggle on /event:
          let subscriptionEditExpanded = false;
          let longConnectionSaved = false;
          let receiveEventAdded = false;
          if (onEventPage) {
            const visibleRadios = Array.from(
              document.querySelectorAll('input[type="radio"], .ud__radio, .semi-radio, .arco-radio')
            ).filter((el) => el.getBoundingClientRect().width > 0);
            const saveBtnVisible = Array.from(document.querySelectorAll('button')).some(
              (b) => (b.innerText || '').replace(/\\s+/g, '').trim() === '保存' && b.getBoundingClientRect().width > 0
            );
            subscriptionEditExpanded = visibleRadios.length > 0 && saveBtnVisible;
            const hasUnconfiguredText = /订阅方式[\\s\\S]{0,60}未配置/.test(bodyText);
            longConnectionSaved =
              !subscriptionEditExpanded &&
              !hasUnconfiguredText &&
              (bodyText.includes('使用长连接接收事件') || bodyText.includes('长连接接收事件'));
            receiveEventAdded =
              bodyText.includes('im.message.receive_v1') || bodyText.includes('接收消息 v2.0');
          } else {
            // Preserve previously observed completion flags across tabs on the same appId
            if (window.__fmcSavedAppId !== detectedAppId) {
              window.__fmcSavedAppId = detectedAppId;
              window.__fmcLongConnSaved = false;
              window.__fmcRecvEventAdded = false;
              window.__fmcVerPublished = false;
            }
            longConnectionSaved = Boolean(window.__fmcLongConnSaved);
            receiveEventAdded = Boolean(window.__fmcRecvEventAdded);
          }

          if (onEventPage) {
            window.__fmcSavedAppId = detectedAppId;
            if (longConnectionSaved) window.__fmcLongConnSaved = true;
            if (receiveEventAdded) window.__fmcRecvEventAdded = true;
          }

          let versionPublished = Boolean(window.__fmcVerPublished && window.__fmcSavedAppId === detectedAppId);
          if (onVersionPage) {
            window.__fmcSavedAppId = detectedAppId;
            if (
              bodyText.includes('已发布') ||
              bodyText.includes('当前版本已发布') ||
              bodyText.includes('审核通过')
            ) {
              versionPublished = true;
              window.__fmcVerPublished = true;
            }
          }

          // ==================== LIVE SPOTLIGHT OVERLAY RENDERING ====================
          const spotlightEnabled = ${JSON.stringify(this.spotlightEnabled)};
          const focusOverride = ${JSON.stringify(this.focusStepOverride)};
          const hasAppSecret = ${JSON.stringify(ctx.hasAppSecret)};
          const feishuConnected = ${JSON.stringify(ctx.feishuConnected)};

          let root = document.getElementById('fmc-spotlight-root');
          if (!spotlightEnabled) {
            if (root) root.style.display = 'none';
            return {
              url: href,
              loggedIn,
              detectedAppId,
              hasBotCapability,
              onAuthPage,
              onBaseInfoPage,
              onEventPage,
              subscriptionEditExpanded,
              longConnectionSaved,
              receiveEventAdded,
              onVersionPage,
              versionPublished,
              openModalKind: null,
              recentBaseInfoClickMsAgo,
              activeTargetHint: '已暂停实景高亮框（可随时重新开启）'
            };
          }

          if (!root) {
            root = document.createElement('div');
            root.id = 'fmc-spotlight-root';
            root.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;overflow:hidden;';
            root.innerHTML = \`
              <style>
                @keyframes fmcSpotPulse {
                  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55), 0 0 0 3px rgba(255, 255, 255, 0.9); }
                  70% { box-shadow: 0 0 0 11px rgba(239, 68, 68, 0), 0 0 0 3px rgba(255, 255, 255, 0.9); }
                  100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0), 0 0 0 3px rgba(255, 255, 255, 0.9); }
                }
                @keyframes fmcSpotBounce {
                  0%, 100% { transform: translateY(0px); }
                  50% { transform: translateY(-4px); }
                }
              </style>
              <div id="fmc-spot-banner" style="position:fixed;top:10px;left:50%;transform:translateX(-50%);padding:7px 15px;border-radius:999px;font-size:12.5px;font-weight:600;font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#fff;background:#18181b;box-shadow:0 8px 24px rgba(0,0,0,0.18);pointer-events:none;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;transition:all 0.2s ease;"></div>
              <div id="fmc-spot-ring" style="position:fixed;display:none;border:2.5px solid #ef4444;border-radius:10px;background:rgba(239,68,68,0.08);animation:fmcSpotPulse 1.6s infinite;pointer-events:none;transition:left 0.16s ease,top 0.16s ease,width 0.16s ease,height 0.16s ease;"></div>
              <div id="fmc-spot-tip" style="position:fixed;display:none;padding:6px 12px;border-radius:10px;background:#ef4444;color:#ffffff;font-size:12px;font-weight:600;font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;box-shadow:0 8px 22px rgba(239,68,68,0.35);animation:fmcSpotBounce 1.4s ease-in-out infinite;pointer-events:none;max-width:320px;line-height:1.35;"></div>
            \`;
            document.body.appendChild(root);
          }
          root.style.display = 'block';

          const isVis = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') > 0.05;
          };

          const findSidebarItem = (labels) => {
            const cands = Array.from(
              document.querySelectorAll('aside a, aside li, aside span, nav a, nav li, [class*="menu"] a, [class*="menu"] li, [class*="menu"] span, [class*="sider"] div')
            );
            for (const lbl of labels) {
              const hit = cands.find((el) => {
                if (!(el instanceof HTMLElement) || !isVis(el)) return false;
                const r = el.getBoundingClientRect();
                return r.left < 320 && r.height <= 56 && (el.innerText || '').trim() === lbl;
              });
              if (hit) return hit.closest('li, a, [role="menuitem"]') || hit;
            }
            return null;
          };

          const findBtn = (re, scope = document) => {
            const list = Array.from(scope.querySelectorAll('button, [role="button"], a'));
            return list.find((el) => {
              if (!(el instanceof HTMLElement) || !isVis(el)) return false;
              if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
              const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
              return txt.length > 0 && txt.length < 60 && re.test(txt);
            }) || null;
          };

          const openModals = Array.from(
            document.querySelectorAll('[role="dialog"], .ud__modal, .semi-modal-content, .arco-modal')
          ).filter((m) => m instanceof HTMLElement && isVis(m) && m.getBoundingClientRect().width > 160);
          const topModal = openModals.length > 0 ? openModals[openModals.length - 1] : null;

          let openModalKind = null;
          if (!detectedAppId && topModal && topModal.querySelector('input')) {
            openModalKind = 'create_app';
          } else if (onAuthPage && topModal && topModal.querySelector('.monaco-editor, textarea')) {
            openModalKind = 'import_json';
          } else if (onVersionPage && !findBtn(/^创建版本$/) && document.querySelector('textarea')) {
            openModalKind = 'create_version';
          }

          let targetEl = null;
          let tipText = '';
          let bannerText = '';
          let bannerBg = '#18181b';

          if (!loggedIn) {
            bannerText = '📱 请先用手机飞书扫码登录（确认登录后的右上角企业组织与手机飞书一致）';
            bannerBg = '#b45309';
          } else if (!detectedAppId) {
            // Step 1: App list page
            if (topModal) {
              const inputs = Array.from(topModal.querySelectorAll('input[type="text"], input:not([type]), textarea')).filter(isVis);
              const emptyInp = inputs.find((i) => !(i.value || '').trim());
              if (emptyInp) {
                targetEl = emptyInp;
                tipText = '👆 填写机器人名称与描述（也可点右侧「一键代填名称描述」）';
                bannerText = '第 1 步：填写应用名称与描述后点击「创建」';
              } else {
                targetEl = findBtn(/^(创建|确定|确认)$/, topModal);
                tipText = '👆 点击「创建」进入应用后台';
                bannerText = '第 1 步：点击弹窗右下角「创建」';
              }
            } else {
              targetEl = findBtn(/创建企业自建应用/);
              tipText = '👆 第 1 步：点此「创建企业自建应用」';
              bannerText = '🎯 实景指引 · 第 1 步：先核对右上角企业组织，再点击高亮的「创建企业自建应用」';
            }
          } else {
            // Determine active logical step (1..6) inside /app/cli_xxxx
            let stepNum = focusOverride || 0;
            if (!stepNum) {
              if (!hasBotCapability) stepNum = 2;
              else if (onAuthPage) stepNum = 3;
              else if (!feishuConnected && (!longConnectionSaved || onBaseInfoPage)) stepNum = 4;
              else if (!longConnectionSaved || !receiveEventAdded) stepNum = 5;
              else stepNum = 6;
            }

            if (stepNum === 2) {
              if (hasBotCapability) {
                targetEl = findSidebarItem(['权限管理']);
                tipText = '✅ 机器人能力已开启！点此进入第 3 步「权限管理」';
                bannerText = '✅ 第 2 步已完成：应用已具备「机器人」能力';
                bannerBg = '#065f46';
              } else if (topModal) {
                targetEl = findBtn(/^(添加|确定|确认|保存)$/, topModal);
                tipText = '👆 点击确认添加机器人能力';
                bannerText = '第 2 步：确认启用机器人能力';
              } else {
                // Find the "+ 添加" button specifically inside the "机器人" card
                const cards = Array.from(document.querySelectorAll('div, section, li')).filter((el) => {
                  if (!(el instanceof HTMLElement) || !isVis(el)) return false;
                  const t = (el.innerText || '').trim();
                  const r = el.getBoundingClientRect();
                  return t.includes('机器人') && !(t.includes('网页应用') && t.includes('小程序')) && r.width >= 180 && r.width <= 720 && r.height >= 70 && r.height <= 400;
                }).sort((a, b) => a.innerText.length - b.innerText.length);
                let botBtn = null;
                for (const c of cards) {
                  botBtn = Array.from(c.querySelectorAll('button')).find((b) => {
                    const bt = (b.innerText || '').replace(/\\s+/g, '').trim();
                    return isVis(b) && !/了解|文档|详情/.test(bt) && /^(\\+?添加|添加机器人|启用)$/.test(bt);
                  });
                  if (botBtn) break;
                }
                if (botBtn) {
                  targetEl = botBtn;
                  tipText = '👆 第 2 步：点击「机器人」卡片的「+ 添加」';
                  bannerText = '🎯 第 2 步：在「机器人」卡片右下角点击「+ 添加」';
                } else {
                  targetEl = findSidebarItem(['添加应用能力']);
                  tipText = '👆 第 2 步：点击左侧「添加应用能力」';
                  bannerText = '🎯 第 2 步：点击左侧菜单「添加应用能力」开启机器人';
                }
              }
            } else if (stepNum === 3) {
              if (!onAuthPage) {
                targetEl = findSidebarItem(['权限管理']);
                tipText = '👆 第 3 步：点击左侧「权限管理」';
                bannerText = '🎯 第 3 步：进入「权限管理」批量导入 7 项消息与表情权限';
              } else if (topModal) {
                const mTxt = (topModal.innerText || '').replace(/\\u00a0/g, ' ');
                const importTab = Array.from(topModal.querySelectorAll('div, span, button, [role="tab"]')).find(
                  (el) => el instanceof HTMLElement && isVis(el) && (el.innerText || '').trim() === '导入权限' && el.getBoundingClientRect().height < 48
                );
                const applyBtn = findBtn(/申请开通|确认开通|批量开通|提交申请/, topModal);
                const nextBtn = findBtn(/下一步|确认新增权限|确定导入/, topModal);
                const closeDoneBtn =
                  /暂无新增权限|没有新增权限|已全部开通/.test(mTxt)
                    ? findBtn(/^(取消|关闭|知道了|确定)$/, topModal)
                    : null;

                if (closeDoneBtn) {
                  targetEl = closeDoneBtn;
                  tipText = '✅ 7 项权限均已开通！点此关闭弹窗即可进入第 4 步';
                  bannerText = '✅ 第 3 步：7 项权限已全部开通！';
                  bannerBg = '#065f46';
                } else if (applyBtn) {
                  targetEl = applyBtn;
                  tipText = '👆 点击「申请开通」完成权限导入！';
                  bannerText = '🎯 第 3.3 步：点击高亮的「申请开通」';
                } else if (mTxt.includes('im:message:send_as_bot') && nextBtn) {
                  targetEl = nextBtn;
                  tipText = '👆 JSON 已就绪，点击「下一步，确认新增权限」';
                  bannerText = '🎯 第 3.2 步：点击「下一步，确认新增权限」';
                } else {
                  const ed = topModal.querySelector('.monaco-editor, textarea');
                  if (ed && isVis(ed)) {
                    targetEl = ed;
                    tipText = '👆 点右侧「一键填入 JSON 到弹窗」（或清空后 Ctrl+V 粘贴）';
                    bannerText = '🎯 第 3.2 步：将 7 项权限 JSON 填入此编辑器（右侧支持一键代填）';
                  } else if (importTab) {
                    targetEl = importTab;
                    tipText = '👆 先切换到「导入权限」标签';
                    bannerText = '🎯 第 3.1 步：切换到弹窗顶部的「导入权限」标签';
                  }
                }
              } else {
                targetEl = findBtn(/批量导入/);
                tipText = '👆 第 3.1 步：点击「批量导入/导出权限」';
                bannerText = '🎯 第 3 步：点击「批量导入/导出权限」一键开通 7 项权限';
              }
            } else if (stepNum === 4) {
              if (feishuConnected) {
                targetEl = findSidebarItem(['事件与回调']);
                tipText = '✅ 右侧长连接已在线！点此进入第 5 步「事件与回调」';
                bannerText = '✅ 第 4 步已完成：本地飞书长连接已在线！现在可进入「事件与回调」开启长连接';
                bannerBg = '#065f46';
              } else if (!onBaseInfoPage) {
                targetEl = findSidebarItem(['凭证与基础信息']);
                tipText = '👆 第 4 步：点击「凭证与基础信息」复制 App Secret';
                bannerText = '🎯 第 4 步：进入「凭证与基础信息」复制 App Secret 并在右侧点连接';
              } else if (!hasAppSecret) {
                // Highlight the App Secret row / copy icon!
                const allLeaves = Array.from(document.querySelectorAll('div, span, td, th, label, p'));
                const secretLbl = allLeaves.find(
                  (el) => el instanceof HTMLElement && el.children.length === 0 && isVis(el) && (el.innerText || '').trim() === 'App Secret'
                );
                if (secretLbl) {
                  const row = secretLbl.closest('tr, [class*="row"], [class*="item"], [class*="field"]') || secretLbl.parentElement;
                  const lr = secretLbl.getBoundingClientRect();
                  const icons = row
                    ? Array.from(row.querySelectorAll('button, [role="button"], svg'))
                        .filter((ic) => {
                          const r = ic.getBoundingClientRect();
                          return r.width >= 10 && r.width <= 64 && r.left > lr.right + 8 && Math.abs(r.top - lr.top) < 42;
                        })
                        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
                    : [];
                  // Usually rightmost icon on App Secret row is Copy (or Show + Copy)
                  targetEl = icons.length > 0 ? icons[icons.length - 1] : row || secretLbl;
                  tipText = '👆 第 4 步：点击此处复制 App Secret（右侧将自动识别填入！）';
                  bannerText = '🎯 第 4 步：点击 App Secret 右侧复制图标 → 右侧自动填入后点击「连接飞书长连接」';
                }
              } else {
                bannerText = '👉 App ID 与密钥已填入！请立即点击右侧黑色的「连接飞书长连接」按钮，变绿后再去第 5 步';
                bannerBg = '#b45309';
              }
            } else if (stepNum === 5) {
              if (!onEventPage) {
                targetEl = findSidebarItem(['事件与回调']);
                tipText = '👆 第 5 步：点击左侧「事件与回调」';
                bannerText = '🎯 第 5 步：进入「事件与回调」开启长连接并添加接收消息事件';
              } else if (!longConnectionSaved) {
                if (!subscriptionEditExpanded) {
                  // Screenshot 1: Highlight the pencil edit icon next to "订阅方式"!
                  const hdr = Array.from(document.querySelectorAll('div, span, h3, h4')).find(
                    (el) => el instanceof HTMLElement && el.children.length === 0 && isVis(el) && (el.innerText || '').trim() === '订阅方式'
                  );
                  let pencil = findBtn(/^(编辑|修改|修改订阅方式)$/);
                  if (!pencil && hdr) {
                    const hr = hdr.getBoundingClientRect();
                    pencil =
                      Array.from(document.querySelectorAll('svg, button, [role="button"]')).find((s) => {
                        const sr = s.getBoundingClientRect();
                        return sr.width >= 10 && sr.width <= 44 && Math.abs(sr.top - hr.top) < 28 && sr.left >= hr.right - 4 && sr.left < hr.right + 120;
                      }) || hdr;
                  }
                  targetEl = pencil;
                  tipText = '👆 第 5.1 步：先点击「订阅方式」右侧铅笔图标 ✏️';
                  bannerText = '🎯 第 5.1 步（共两步开启长连接）：点击「订阅方式」旁的蓝色铅笔图标展开选项';
                } else {
                  // Screenshot 2: Edit panel is open! Check if right-hand Feishu WS is online first!
                  if (!feishuConnected) {
                    bannerText = '⚠️ 请先在右侧粘贴 App Secret 并点击「连接飞书长连接」在线后，再点此处「保存」（否则飞书会报错）！';
                    bannerBg = '#b91c1c';
                    const saveBtn = findBtn(/^保存$/);
                    targetEl = saveBtn;
                    tipText = '⚠️ 先在右侧连上飞书长连接，再回来点「保存」';
                  } else {
                    // Check if "使用长连接接收事件" radio is checked
                    const wsRadioLabel = Array.from(document.querySelectorAll('label, [class*="radio"]')).find(
                      (el) => el instanceof HTMLElement && isVis(el) && (el.innerText || '').includes('长连接') && el.getBoundingClientRect().height < 80
                    );
                    const radioInp = wsRadioLabel ? wsRadioLabel.querySelector('input[type="radio"]') : null;
                    const isChecked = radioInp ? Boolean(radioInp.checked) : true;
                    if (!isChecked && wsRadioLabel) {
                      targetEl = wsRadioLabel;
                      tipText = '👆 先点选「使用长连接接收事件」';
                      bannerText = '🎯 第 5.2 步：选择「使用长连接接收事件」并点击「保存」';
                    } else {
                      targetEl = findBtn(/^保存$/);
                      tipText = '👆 第 5.2 步：点击蓝色「保存」开启长连接！';
                      bannerText = '🎯 第 5.2 步：右侧长连接已就绪，点击蓝色「保存」按钮完成开启！';
                      bannerBg = '#1d4ed8';
                    }
                  }
                }
              } else if (!receiveEventAdded) {
                // Long connection IS saved! Now guide user to add im.message.receive_v1
                if (topModal) {
                  const confirmAddBtn = findBtn(/^(确认添加|确定)$/, topModal);
                  const rows = Array.from(topModal.querySelectorAll('label, tr, li, div')).filter(
                    (el) =>
                      el instanceof HTMLElement &&
                      isVis(el) &&
                      ((el.innerText || '').includes('接收消息 v2.0') || (el.innerText || '').includes('im.message.receive_v1')) &&
                      el.getBoundingClientRect().height < 80
                  ).sort((a, b) => a.innerText.length - b.innerText.length);
                  const cbRow = rows[0] || null;
                  const cbInp = cbRow ? cbRow.querySelector('input[type="checkbox"]') : null;
                  const isRowChecked = cbInp
                    ? Boolean(cbInp.checked)
                    : Boolean(cbRow && cbRow.querySelector('[class*="checked"]'));

                  if (isRowChecked && confirmAddBtn) {
                    targetEl = confirmAddBtn;
                    tipText = '👆 已勾选接收消息事件，点击「确认添加」！';
                    bannerText = '🎯 第 5.3 步：点击弹窗右下角「确认添加」';
                  } else if (cbRow) {
                    targetEl = cbRow.querySelector('.ud__checkbox, .semi-checkbox, input[type="checkbox"]') || cbRow;
                    tipText = '👆 勾选「接收消息 v2.0 (im.message.receive_v1)」';
                    bannerText = '🎯 第 5.3 步：勾选「接收消息 v2.0」后再点确认添加';
                  } else {
                    const searchInp = Array.from(topModal.querySelectorAll('input')).find(
                      (i) => i.type !== 'checkbox' && i.type !== 'radio' && isVis(i) && i.getBoundingClientRect().width > 80
                    );
                    targetEl = searchInp;
                    tipText = '👆 粘贴搜索 im.message.receive_v1 并按回车';
                    bannerText = '🎯 第 5.3 步：在搜索框粘贴 im.message.receive_v1 查找「接收消息 v2.0」';
                  }
                } else {
                  targetEl = findBtn(/添加事件/);
                  tipText = '👆 第 5.3 步：长连接已开启！点击「+ 添加事件」';
                  bannerText = '✅ 长连接订阅已开启！接着点击下方「+ 添加事件」订阅 im.message.receive_v1';
                  bannerBg = '#065f46';
                }
              } else {
                targetEl = findSidebarItem(['版本管理与发布']);
                tipText = '✅ 事件配置全部完成！点此进入第 6 步「版本管理与发布」';
                bannerText = '✅ 第 5 步已完成（长连接 + 接收消息事件均已生效）！请进入「版本管理与发布」';
                bannerBg = '#065f46';
              }
            } else if (stepNum === 6) {
              if (versionPublished) {
                bannerText = '🎉 飞书机器人已线上发布！点右侧「一键唤起机器人对话」发一句「你好」即可完成最终验收';
                bannerBg = '#065f46';
              } else if (!onVersionPage) {
                targetEl = findSidebarItem(['版本管理与发布']);
                tipText = '👆 第 6 步：点击左侧「版本管理与发布」';
                bannerText = '🎯 第 6 步：进入「版本管理与发布」创建 1.0.0 版本并申请线上发布';
              } else if (topModal) {
                targetEl = findBtn(/确认发布|申请线上发布|提交|确定|确认/, topModal);
                tipText = '👆 点击确认提交线上发布！';
                bannerText = '🎯 最后确认：点击弹窗中的确认按钮完成线上发布';
              } else {
                const createVerBtn = findBtn(/^创建版本$/);
                const publishBtn = findBtn(/申请线上发布|确认发布/);
                const saveBtn = findBtn(/^保存$/);
                if (createVerBtn) {
                  targetEl = createVerBtn;
                  tipText = '👆 第 6.1 步：点击「创建版本」';
                  bannerText = '🎯 第 6.1 步：点击「创建版本」';
                } else if (publishBtn) {
                  targetEl = publishBtn;
                  tipText = '👆 最后一步：点击「申请线上发布」让机器人正式上线！';
                  bannerText = '🎯 最后一步：点击右上角蓝色「申请线上发布」！';
                  bannerBg = '#1d4ed8';
                } else if (saveBtn) {
                  const verInp = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(
                    (el) => isVis(el) && el.getBoundingClientRect().width > 80
                  );
                  if (verInp && !(verInp.value || '').trim()) {
                    targetEl = verInp;
                    tipText = '👆 填写版本号 1.0.0 与更新说明（或点右侧「一键代填版本信息」）';
                    bannerText = '🎯 第 6.2 步：填写版本号（1.0.0）与更新说明，检查可用范围后点击底部「保存」';
                  } else {
                    targetEl = saveBtn;
                    tipText = '👆 第 6.2 步：点击「保存」，保存后再点右上角「申请线上发布」';
                    bannerText = '🎯 第 6.2 步：先点「保存」，紧接着务必点右上角「申请线上发布」！';
                  }
                }
              }
            }
          }

          const bannerEl = document.getElementById('fmc-spot-banner');
          const ringEl = document.getElementById('fmc-spot-ring');
          const tipEl = document.getElementById('fmc-spot-tip');

          if (bannerEl) {
            if (bannerText) {
              bannerEl.style.display = 'block';
              bannerEl.style.background = bannerBg;
              bannerEl.textContent = bannerText;
            } else {
              bannerEl.style.display = 'none';
            }
          }

          if (targetEl && ringEl && tipEl) {
            const r = targetEl.getBoundingClientRect();
            const pad = 5;
            ringEl.style.display = 'block';
            ringEl.style.left = Math.max(2, r.left - pad) + 'px';
            ringEl.style.top = Math.max(2, r.top - pad) + 'px';
            ringEl.style.width = Math.min(window.innerWidth - 4, r.width + pad * 2) + 'px';
            ringEl.style.height = Math.min(window.innerHeight - 4, r.height + pad * 2) + 'px';

            if (tipText) {
              tipEl.style.display = 'block';
              tipEl.textContent = tipText;
              const placeBelow = r.top < 92 || r.bottom + 54 < window.innerHeight;
              const topPos = placeBelow
                ? Math.min(window.innerHeight - 44, r.bottom + 10)
                : Math.max(46, r.top - 42);
              const leftPos = Math.max(10, Math.min(window.innerWidth - 310, r.left));
              tipEl.style.top = topPos + 'px';
              tipEl.style.left = leftPos + 'px';
            } else {
              tipEl.style.display = 'none';
            }
          } else {
            if (ringEl) ringEl.style.display = 'none';
            if (tipEl) tipEl.style.display = 'none';
          }

          return {
            url: href,
            loggedIn,
            detectedAppId,
            hasBotCapability,
            onAuthPage,
            onBaseInfoPage,
            onEventPage,
            subscriptionEditExpanded,
            longConnectionSaved,
            receiveEventAdded,
            onVersionPage,
            versionPublished,
            openModalKind,
            recentBaseInfoClickMsAgo,
            activeTargetHint: tipText || bannerText
          };
        })()`,
        true
      )) as PageProbeResult;

      // 1. Auto-notify newly detected App ID from Feishu URL
      if (probe.detectedAppId && /^cli_[a-zA-Z0-9]+$/.test(probe.detectedAppId)) {
        this.onCredentialCaptured({ appId: probe.detectedAppId });
      }

      // 2. Smart Clipboard Auto-Capture ONLY when user just clicked Copy on /baseinfo within last 3.5s!
      if (probe.onBaseInfoPage && probe.recentBaseInfoClickMsAgo <= 3500) {
        const clip = clipboard.readText().trim();
        if (clip && clip !== this.lastClipboardBaseline) {
          this.lastClipboardBaseline = clip;
          if (/^cli_[a-zA-Z0-9]+$/.test(clip)) {
            this.onCredentialCaptured({ appId: clip });
          } else if (
            /^[A-Za-z0-9_-]{24,48}$/.test(clip) &&
            /[A-Za-z]/.test(clip) &&
            /\d/.test(clip)
          ) {
            this.onCredentialCaptured({ appSecret: clip });
          }
        }
      }

      // 3. Clear focusStepOverride automatically once the focused step finishes
      if (
        (this.focusStepOverride === 2 && probe.hasBotCapability) ||
        (this.focusStepOverride === 4 && ctx.feishuConnected) ||
        (this.focusStepOverride === 5 && probe.longConnectionSaved && probe.receiveEventAdded) ||
        (this.focusStepOverride === 6 && probe.versionPublished)
      ) {
        this.focusStepOverride = null;
      }

      const guideState: FeishuLiveGuideState = {
        url: probe.url,
        loggedIn: probe.loggedIn,
        detectedAppId: probe.detectedAppId,
        hasBotCapability: probe.hasBotCapability,
        onAuthPage: probe.onAuthPage,
        onBaseInfoPage: probe.onBaseInfoPage,
        onEventPage: probe.onEventPage,
        subscriptionEditExpanded: probe.subscriptionEditExpanded,
        longConnectionSaved: probe.longConnectionSaved,
        receiveEventAdded: probe.receiveEventAdded,
        onVersionPage: probe.onVersionPage,
        versionPublished: probe.versionPublished,
        openModalKind: probe.openModalKind,
        activeTargetHint: probe.activeTargetHint,
        spotlightEnabled: this.spotlightEnabled
      };

      const sig = JSON.stringify(guideState);
      if (sig !== this.lastBroadcastSig) {
        this.lastBroadcastSig = sig;
        this.onGuideState(guideState);
      }
    } catch {
      // ignore transient page reload errors
    }
  }
}
