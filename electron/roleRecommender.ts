import { DetectedCli } from './cliScanner';
import {
  CliUserConfig,
  DecisionPriorityWeights,
  ReasoningEffort,
  UserProfileConfig
} from './store';

export interface SingleCliRecommendation {
  cliId: string;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  roleWeights: Record<string, number>;
  reason: string;
}

export interface RoleRecommendationPlan {
  summary: string;
  decisionWeights: DecisionPriorityWeights;
  recommendations: SingleCliRecommendation[];
}

function pickBestModel(models: string[], patterns: RegExp[], fallback: string): string {
  for (const re of patterns) {
    const found = models.find((m) => re.test(m));
    if (found) return found;
  }
  return fallback || models[0] || '';
}

export function computeSmartRoleRecommendations(
  profile: UserProfileConfig,
  clis: DetectedCli[]
): RoleRecommendationPlan {
  const prof = (profile.profession || '').trim() || '开发者 / 创作者';
  const purposes = Array.isArray(profile.purposes) ? profile.purposes : [];
  const note = (profile.customNote || '').trim();
  const combinedText = `${prof} ${purposes.join(' ')} ${note}`.toLowerCase();

  const isAcademic = /科研|学术|论文|高校|硕博|研究生|老师|实验|仿真|文献|数据分析/.test(combinedText);
  const isProductDesign = /产品|设计|原型|ui|ux|前端|交互|独立开发/.test(combinedText);
  const isDataQuant = /数据|量化|金融|爬虫|统计|绘图|算法|机器学习|python/.test(combinedText);
  const isOpsOffice = /办公|运营|自媒体|内容|文档|自动化|效率|脚本/.test(combinedText);
  const wantsBudgetSave = /省钱|预算|性价比|低成本/.test(combinedText);

  let decisionWeights: DecisionPriorityWeights = {
    capability: 45,
    price: 25,
    quota: 20,
    speed: 10
  };
  if (isAcademic || isDataQuant) {
    decisionWeights = { capability: 55, price: 20, quota: 15, speed: 10 };
  } else if (isProductDesign) {
    decisionWeights = { capability: 45, price: 20, quota: 20, speed: 15 };
  } else if (isOpsOffice) {
    decisionWeights = { capability: 35, price: 30, quota: 20, speed: 15 };
  }
  if (wantsBudgetSave) {
    decisionWeights = { capability: 30, price: 40, quota: 20, speed: 10 };
  }

  const enabled = clis.filter((c) => c.config.enabled);
  const targets = enabled.length > 0 ? enabled : clis.filter((c) => c.installed);

  const recommendations: SingleCliRecommendation[] = targets.map((cli) => {
    const pool = Array.from(
      new Set([...(cli.config.defaultModel ? [cli.config.defaultModel] : []), ...(cli.models || [])])
    );
    const curModel = cli.config.defaultModel || pool[0] || '';

    if (cli.id === 'claude') {
      const rw: Record<string, number> = {
        架构规划: 5,
        复杂重构: 5,
        代码审查: 5,
        核心编码: 4
      };
      if (isAcademic) {
        rw['论文逻辑与复现审查'] = 5;
        rw['科研绘图与排版'] = 4;
      }
      if (isProductDesign) {
        rw['前端 UI'] = 5;
      }
      if (isOpsOffice) {
        rw['文档调研'] = 4;
      }
      return {
        cliId: cli.id,
        defaultModel: pickBestModel(pool, [/sonnet-4/i, /claude-sonnet/i, /opus/i], curModel),
        reasoningEffort: isAcademic ? 'high' : 'medium',
        roleWeights: rw,
        reason: isAcademic
          ? '长上下文推演与复杂逻辑审校极强，优先承担科研代码架构、论文算法复现审查与精细修改'
          : isProductDesign
            ? '审美与组件拆分出色，优先负责前端 UI 还原、整体架构设计与代码把关'
            : '全局架构把控与复杂重构能力顶尖，作为主力架构师与代码审查官'
      };
    }

    if (cli.id === 'codex') {
      const rw: Record<string, number> = {
        核心编码: 5,
        '修 Bug / 单测': 5,
        代码审查: 4
      };
      if (isAcademic || isDataQuant) {
        rw['数据处理与实验脚本'] = 5;
      }
      if (isOpsOffice) {
        rw['自动化脚本'] = 5;
      }
      return {
        cliId: cli.id,
        defaultModel: pickBestModel(pool, [/codex/i, /gpt-5/i, /o3/i, /o4/i], curModel),
        reasoningEffort: isAcademic || isDataQuant ? 'high' : 'medium',
        roleWeights: rw,
        reason:
          isAcademic || isDataQuant
            ? '终端执行严谨、推理扎实，最适合编写 Python 数据处理/仿真脚本、排查棘手报错与跑通单测'
            : '工具链调用稳健、修 Bug 命中率高，主力承担后端逻辑实现、报错修复与单元测试闭环'
      };
    }

    if (cli.id === 'gemini') {
      const rw: Record<string, number> = {
        文档调研: 5,
        全栈开发: 3
      };
      if (isAcademic) {
        rw['长文献与多模态整理'] = 5;
        rw['前端 UI'] = 3;
      } else if (isProductDesign) {
        rw['前端 UI'] = 4;
        rw['快速原型'] = 5;
      } else {
        rw['修 Bug / 单测'] = 3;
      }
      return {
        cliId: cli.id,
        defaultModel: pickBestModel(pool, [/gemini-2\.5-pro/i, /gemini-3/i, /pro/i, /flash/i], curModel),
        reasoningEffort: 'medium',
        roleWeights: rw,
        reason: isAcademic
          ? '百万级超大上下文窗口，适合一次性通读长篇代码库、实验日志与技术文档归纳'
          : '超长上下文与高性价比兼具，适合大仓库全量检索、文档整理与多模块联动分析'
      };
    }

    if (cli.id === 'antigravity') {
      const rw: Record<string, number> = {
        全栈开发: 5,
        '前端 UI': 5,
        核心编码: 4
      };
      if (isAcademic) {
        rw['科研数据可视化'] = 5;
      }
      return {
        cliId: cli.id,
        defaultModel: curModel,
        reasoningEffort: 'medium',
        roleWeights: rw,
        reason: '多文件协同与端到端全栈交付流畅，适合完整新功能模块、可视化界面与跨文件迭代'
      };
    }

    // Generic / DeepSeek / Kimi / Grok / OpenCode / Pi
    const rw: Record<string, number> = {
      核心编码: 4,
      文档调研: 4,
      '修 Bug / 单测': 3
    };
    if (isOpsOffice) rw['自动化脚本'] = 5;
    if (isAcademic) rw['文献与辅助脚本'] = 4;
    return {
      cliId: cli.id,
      defaultModel: curModel,
      reasoningEffort: 'medium',
      roleWeights: rw,
      reason: '高性价比弹性节点，承担日常脚本编写、文档处理并在主力 CLI 限额冷却时无缝接力'
    };
  });

  const purposeLabel = purposes.length > 0 ? `（核心目标：${purposes.join('、')}）` : '';
  const summary = `已结合你的身份「${prof}」${purposeLabel}，为 ${recommendations.length} 个本地 CLI 完成定制化职能分工与思考等级配置（后续随时可在「应用 / CLI 雷达」或「软件设置」中微调）。`;

  return {
    summary,
    decisionWeights,
    recommendations
  };
}

export function buildMuseRoleRecommendationPrompt(
  baseUrl: string,
  token: string,
  profile: UserProfileConfig,
  clis: DetectedCli[]
): string {
  const enabledList = clis
    .filter((c) => c.config.enabled || c.installed)
    .map((c) => {
      const pool = Array.from(
        new Set([...(c.config.defaultModel ? [c.config.defaultModel] : []), ...(c.models || [])])
      ).slice(0, 18);
      return `- \`${c.id}\` (${c.name}, ${c.config.enabled ? '已启用' : '已安装'}) | 当前默认模型: \`${c.config.defaultModel || 'default'}\` | 可选模型池: ${pool.join(', ') || '默认'}`;
    })
    .join('\n');

  return `【MuseDeck 初始向导 · 请按用户职业与用途智能推荐 CLI 职能配置】
用户的身份与使用场景如下：
- **职业 / 身份**：${profile.profession || '未填写（通用创作者/开发者）'}
- **主要使用目的**：${(profile.purposes || []).join('、') || '日常开发与效率自动化'}
${profile.customNote ? `- **补充说明**：${profile.customNote}\n` : ''}
当前本机可用的 CLI 与模型池：
${enabledList || '- 暂无已启用 CLI'}

请你结合各家大模型与 CLI 的真实工程专长，针对该用户的职业与使用目的，立即携带 \`Authorization: Bearer ${token}\` 调用以下本地接口一键写入你推荐的职能分工、默认模型、思考等级与 100% 决策权重：

\`POST ${baseUrl}/api/v1/clis/apply-recommendations\`
JSON Body 格式：
\`\`\`json
{
  "summary": "用 1~2 句亲切精炼的中文总结你为该用户定制的整体分工思路，并提醒用户后续随时可在 CLI 管理与设置中自由修改",
  "decisionWeights": { "capability": 50, "price": 20, "quota": 20, "speed": 10 },
  "recommendations": [
    {
      "cliId": "codex",
      "defaultModel": "从该 CLI 可选模型池中挑最合适的一个（若不确定则保留原模型）",
      "reasoningEffort": "low | medium | high",
      "roleWeights": { "核心编码": 5, "修 Bug / 单测": 5, "结合用户职业的专属职能标签": 5 },
      "reason": "简短一句话说明为什么让它负责这些职能"
    }
  ]
}
\`\`\`
完成 POST 调用后，在聊天框简短回复一句「已为你完成专属 CLI 职能智能推荐配置，后续可随时按需修改！」即可。`;
}
