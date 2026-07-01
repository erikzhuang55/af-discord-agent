require("dotenv").config();

const crypto = require("crypto");
const axios = require("axios");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const { Client, GatewayIntentBits } = require("discord.js");

/**
 * 必要环境变量检查
 */
const requiredEnv = [
  "DISCORD_TOKEN",
  "ZHIPU_API_KEY",
  "ZHIPU_MODEL",
  "DINGTALK_WEBHOOK",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

/**
 * 解析监听频道列表（多频道）
 */
const CHANNEL_IDS = new Set(
  (process.env.DISCORD_CHANNEL_IDS || process.env.DISCORD_FAQ_CHANNEL_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (CHANNEL_IDS.size === 0) {
  throw new Error("Please configure DISCORD_CHANNEL_IDS, e.g.: 123,456,789");
}

console.log(`[启动] 监听 ${CHANNEL_IDS.size} 个频道:`, [...CHANNEL_IDS]);

/**
 * Ticket Category 配置
 * 注意：这是 Category ID（分类ID），不是 Channel ID
 * Ticket Tools 会在此分类下动态创建频道
 */
const TICKET_CATEGORY_ID = process.env.DISCORD_TICKET_CATEGORY_ID;
if (TICKET_CATEGORY_ID) {
  console.log(`[启动] Ticket 分类: ${TICKET_CATEGORY_ID}`);
}

const REPLIED_TICKETS_FILE = process.env.REPLIED_TICKETS_FILE || ".replied_tickets.json";

/**
 * 加载已回复的 Ticket 列表
 */
function loadRepliedTickets() {
  try {
    const fs = require("fs");
    if (fs.existsSync(REPLIED_TICKETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPLIED_TICKETS_FILE, "utf-8"));
      console.log(`[启动] 加载 ${data.length} 个已回复 Ticket`);
      return new Set(data);
    }
  } catch (err) {
    console.error("[启动] 加载已回复 Ticket 失败:", err.message);
  }
  return new Set();
}

/**
 * 保存已回复的 Ticket 列表
 */
function saveRepliedTickets() {
  try {
    const fs = require("fs");
    fs.writeFileSync(
      REPLIED_TICKETS_FILE,
      JSON.stringify([...repliedTickets], null, 2)
    );
  } catch (err) {
    console.error("[保存] 写入已回复 Ticket 失败:", err.message);
  }
}

const repliedTickets = loadRepliedTickets();

/**
 * 例外用户列表（始终处理，即使管理员）
 */
const EXCEPTION_USER_IDS = new Set([
  "1521030281597943879",
]);

/**
 * 管理员角色列表
 */
const STAFF_ROLE_NAMES = [
  'Admin', 'Administrator', 'Moderator', 'Mod',
  'Staff', 'Team', 'Support', 'Helper',
  '管理员', '版主', '工作人员'
];

/**
 * P0 关键词矩阵（代码层强匹配）
 */
const P0_KEYWORDS = {
  // 联系方式请求 - 高意向客户，人工介入
  contact: [
    /\bdm\b/i,
    /\bpm\b/i,
    /\bmessage\s*me\b/i,
    /\bcontact\s*me\b/i,
    /\breach\s*out\b/i,
    /\bping\s*me\b/i,
    /\bslide\s*into\s*my\s*dms?\b/i,
    /\badd\s*me\s*on\b/i,
    /\bemail\s*me\b/i,
    /\btext\s*me\b/i,
    /\bcall\s*me\b/i,
    /\blet['']?s\s+(move|take)\s+this\s+private\b/i,
    /\bmy\s+(discord|telegram|tg|whatsapp|email|line)\s+is\b/i,
  ],

  // 支付/资金问题 - 必须立即处理
  payment: [
    /\brefund\b/i,
    /\bdidn['']?t\s+receive\b/i,
    /\bcharge(d)?\s+twice\b/i,
    /\bdouble\s+charge\b/i,
    /\bovercharge\b/i,
    /\bpayment\s+failed\b/i,
    /\bmoney\s+gone\b/i,
    /\bfund(s)?\s+missing\b/i,
    /\bwithdraw(al)?\s+stuck\b/i,
    /\bstuck\s+in\s+pending\b/i,
  ],

  // 账号安全 - 必须立即处理
  account: [
    /\baccount\s+locked\b/i,
    /\baccount\s+hacked\b/i,
    /\bunauthorized\s+access\b/i,
    /\bsomeone\s+else\s+using\b/i,
    /\bcan['']?t\s+login\s*anymore\b/i,
    /\baccount\s+suspended\b/i,
    /\baccount\s+banned\b/i,
  ],

  // 崩溃/阻断性故障
  crash: [
    /\bapp\s+crashed\b/i,
    /\bdata\s+lost\b/i,
    /\bcan['']?t\s+access\b/i,
    /\bservice\s+down\b/i,
    /\bblank\s+screen\b/i,
    /\bfrozen\b/i,
    /\bstuck\s+loading\b/i,
    /\bcritical\s+error\b/i,
  ],
};

/**
 * 检测 P0 关键词
 */
function detectP0Keywords(content) {
  for (const [type, patterns] of Object.entries(P0_KEYWORDS)) {
    if (patterns.some(p => p.test(content))) {
      return {
        priority: 'P0',
        type,
        skipAI: true
      };
    }
  }
  return null;
}

/**
 * AI 分类后的优先级映射矩阵
 */
function mapToPriority(category, severity) {
  const matrix = {
    contact_request: { any: 'P0' },
    payment: { any: 'P0' },
    crash: { any: 'P0' },
    bug: {
      critical: 'P0',
      high: 'P1',
      medium: 'P2',
      low: 'P2'
    },
    account: {
      critical: 'P0',
      high: 'P0',
      medium: 'P1',
      low: 'P1'
    },
    complaint: {
      critical: 'P0',
      high: 'P1',
      medium: 'P1',
      low: 'P2'
    },
    feature_request: { any: 'P2' },
    question: { any: 'P3' },
    noise: { any: 'No' }
  };

  const map = matrix[category];
  if (!map) return 'P2';

  return map[severity] || map.any || 'P2';
}

/**
 * 根据优先级执行动作配置
 */
function getPriorityConfig(priority, classification) {
  const configs = {
    P0: {
      notify: true,
      dingPrefix: '🚨【P0紧急】',
      createTicket: classification?.category !== 'contact_request',
      log: '🚨 P0'
    },
    P1: {
      notify: true,
      dingPrefix: '⚠️【P1高优】',
      createTicket: true,
      log: '⚠️ P1'
    },
    P2: {
      notify: true,
      dingPrefix: '【P2普通】',
      createTicket: false,
      log: 'P2'
    },
    P3: {
      notify: true,
      dingPrefix: '【P3汇总】',
      createTicket: false,
      log: 'P3'
    },
    No: {
      notify: false,
      log: 'Noise (dropped)'
    }
  };

  return configs[priority] || configs.P2;
}

/**
 * 初始化客户端
 */
const aiClient = new OpenAI({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
});

const github = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * JSON 安全解析
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`AI returned invalid JSON: ${text}`);
    }
    return JSON.parse(match[0]);
  }
}

/**
 * 校验 AI 分类结果
 */
function validateClassification(result) {
  const validCategories = [
    "bug", "feature_request", "question", "complaint",
    "account", "payment", "crash", "contact_request", "noise"
  ];

  const validSeverities = ["low", "medium", "high", "critical"];

  if (!validCategories.includes(result.category)) {
    result.category = "question";
  }

  if (!validSeverities.includes(result.severity)) {
    result.severity = "medium";
  }

  return {
    category: result.category,
    severity: result.severity,
    title: (result.title || "用户反馈").trim().slice(0, 100),
    summary: (result.summary || result.title || "").trim().slice(0, 500),
    should_notify: result.should_notify !== false,
    should_create_ticket: result.should_create_ticket === true,
  };
}

/**
 * AI 分类消息（含 P0 兜底）
 */
async function classifyMessage(messageText) {
  const response = await aiClient.chat.completions.create({
    model: process.env.ZHIPU_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a feedback classifier for a software product.

PRIORITY RULES (Critical):
Messages requesting private/off-platform contact are ALWAYS high priority:
- Contains: dm, pm, email, contact, message, reach out, ping me, let's talk, chat privately, add me on, follow up
- User shares contact: "my discord is", "email me at"
- User asks for YOUR contact info
→ Classify as: category="contact_request", severity="high"

Categories:
- crash: App crashes, data loss, service down (severity: critical/high)
- payment: Billing, refunds, double charges, stuck withdrawals (severity: any)
- account: Login issues, hacks, locks, unauthorized access (severity: high/critical)
- bug: Software errors, failures (severity based on impact)
- complaint: Dissatisfaction (severity based on tone)
- feature_request: New features (severity: any)
- question: How-to (severity: any)
- contact_request: Private contact requests (severity: high)
- noise: Spam, emojis, tests

IMPORTANT: 用户主要使用中文，所有输出必须是中文。

返回 JSON（所有字符串值为中文）：
{
  "category": "string",
  "severity": "low|medium|high|critical",
  "title": "简短中文标题，概括核心问题（20字以内）",
  "summary": "一句话中文摘要，说明用户反馈内容",
  "should_notify": true,
  "should_create_ticket": true
}`.trim()
      },
      { role: "user", content: messageText.slice(0, 2000) },
    ]
  });

  let content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("AI returned no content");
  }

  let parsed = safeJsonParse(content);

  // P0 兜底：含 contact 关键词但 AI 没判对
  if (/\b(dm|pm|email|contact|message me|ping me)\b/i.test(messageText) &&
      (parsed.category === 'noise' || parsed.category === 'question')) {
    console.log("[P0兜底] 检测到联系方式关键词，强制修正为 contact_request");
    parsed = {
      category: "contact_request",
      severity: "high",
      title: "Contact request detected",
      summary: parsed.summary || messageText.slice(0, 100),
      should_notify: true,
      should_create_ticket: false,
      _ai_corrected: true
    };
  }

  // P0 兜底：支付/账号关键词
  const hasPayment = /\b(refund|charge|payment|money missing|withdraw)\b/i.test(messageText);
  const hasAccount = /\b(hacked|locked|unauthorized|can't login|suspended)\b/i.test(messageText);

  if (hasPayment && parsed.category !== 'payment') {
    parsed.category = 'payment';
    parsed.severity = 'high';
  }
  if (hasAccount && parsed.category !== 'account') {
    parsed.category = 'account';
    parsed.severity = 'high';
  }

  return validateClassification(parsed);
}

/**
 * 创建 GitHub Issue
 */
async function createGithubIssue({ classification, discordMessage }) {
  const labelMap = {
    bug: "bug",
    crash: "crash",
    payment: "payment",
    account: "account",
    feature_request: "enhancement",
    question: "question",
    complaint: "complaint",
    contact_request: "contact-request",
  };

  const labels = [];
  if (labelMap[classification.category]) {
    labels.push(labelMap[classification.category]);
  }
  if (classification.severity) {
    labels.push(`priority:${classification.severity}`);
  }

  const body = `## AI Classification
- Type: ${classification.category}
- Severity: ${classification.severity}
- Summary: ${classification.summary}

## Source
- User: ${discordMessage.author.tag}
- User ID: ${discordMessage.author.id}
- Channel: #${discordMessage.channel.name}
- Time: ${discordMessage.createdAt.toISOString()}
- URL: ${discordMessage.url}

## Original Message
> ${discordMessage.content.replace(/\n/g, "\n> ")}
`.trim();

  try {
    const result = await github.issues.create({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      title: `[${classification.category}][${classification.severity}] ${classification.title}`,
      body,
      labels,
    });
    return result.data;
  } catch (error) {
    console.warn("[GitHub] 创建Issue失败，尝试不带标签重试:", error.message);
    const fallback = await github.issues.create({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      title: `[${classification.category}][${classification.severity}] ${classification.title}`,
      body,
    });
    return fallback.data;
  }
}

/**
 * 钉钉加签 URL
 */
function buildSignedDingTalkUrl() {
  const webhook = process.env.DINGTALK_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;

  if (!secret) return webhook;

  const timestamp = Date.now();
  const sign = crypto.createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");

  const sep = webhook.includes("?") ? "&" : "?";
  return `${webhook}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

/**
 * 钉钉通知（带优先级前缀）
 */
async function notifyDingTalk({ priority, classification, discordMessage, issue, ticketReplySent = false }) {
  const prefixMap = {
    'P0': '🚨【P0紧急】',
    'P1': '⚠️【P1高优】',
    'P2': '【P2普通】',
    'P3': '【P3汇总】'
  };
  const prefix = prefixMap[priority] || '';

  const categoryName = {
    'contact': '📱 联系方式',
    'payment': '💰 支付问题',
    'account': '🔐 账号安全',
    'crash': '💥 崩溃故障',
    'bug': '🐛 Bug',
    'feature_request': '✨ 功能建议',
    'complaint': '😤 用户投诉',
    'question': '❓ 使用问题',
    'noise': '🔇 噪音'
  }[classification.category] || classification.category;

  const severityName = {
    'critical': '致命',
    'high': '高',
    'medium': '中',
    'low': '低'
  }[classification.severity] || classification.severity;

  const issueText = issue
    ? `📋 GitHub工单: #${issue.number}\n${issue.html_url}`
    : "📋 工单: 未创建";

  const isTicketChannel = TICKET_CATEGORY_ID && discordMessage.channel.parentId === TICKET_CATEGORY_ID;
  const ticketText = ticketReplySent
    ? `✅ 已自动回复用户 (Ticket)`
    : (isTicketChannel ? `⏳ Ticket待处理` : "");

  const text = `
${prefix} ${categoryName}

👤 用户: ${discordMessage.author.tag}
📢 严重程度: ${severityName}
💬 摘要: ${classification.summary}
${ticketText ? `\n🎫 ${ticketText}` : ""}

📝 原始消息:
${discordMessage.content.slice(0, 300)}${discordMessage.content.length > 300 ? "..." : ""}

${issueText}

🔗 Discord原消息: ${discordMessage.url}
`.trim();

  const response = await axios.post(
    buildSignedDingTalkUrl(),
    { msgtype: "text", text: { content: text } },
    { timeout: 10000, headers: { "Content-Type": "application/json" } }
  );

  if (response.data?.errcode !== 0) {
    throw new Error(`钉钉发送失败: ${response.data?.errmsg}`);
  }
  return response.data;
}

/**
 * Ticket 自动回复模板（Discord Embed 风格）
 */
const TICKET_REPLY_TEMPLATES = {
  bug: {
    color: 0xED4245, // Red
    title: "🐛 Issue Received",
    description: "We've logged your bug report. Our team will investigate and follow up if more details are needed.",
    fields: [
      { name: "📋 What happens next?", value: "We'll review and may request screenshots or steps to reproduce.", inline: false },
      { name: "⏱️ Response Time", value: "Usually within 24-48 hours", inline: true }
    ]
  },
  payment: {
    color: 0xFEE75C, // Yellow
    title: "💰 Payment Issue Noted",
    description: "Your payment-related inquiry has been received. For security, avoid sharing sensitive details here.",
    fields: [
      { name: "🔒 Security Note", value: "Staff will never ask for your password or private keys.", inline: false },
      { name: "⏱️ Response Time", value: "Within 12-24 hours", inline: true }
    ]
  },
  account: {
    color: 0xF04747, // Orange-Red
    title: "🔐 Account Issue Logged",
    description: "We've received your account security report. This type of request is prioritized.",
    fields: [
      { name: "🚨 Important", value: "If your account is compromised, also check your email for any unauthorized changes.", inline: false },
      { name: "⏱️ Response Time", value: "As soon as possible", inline: true }
    ]
  },
  crash: {
    color: 0xED4245, // Red
    title: "💥 Critical Issue Reported",
    description: "Your crash/ service disruption report has been flagged for immediate attention.",
    fields: [
      { name: "📊 System Status", value: "Check [status page](https://status.example.com) for known incidents", inline: false },
      { name: "⏱️ Response Time", value: "Within 2-4 hours", inline: true }
    ]
  },
  feature_request: {
    color: 0x5865F2, // Blurple
    title: "✨ Suggestion Recorded",
    description: "Thanks for sharing your idea! We regularly review feature requests to guide our roadmap.",
    fields: [
      { name: "💡 Pro Tip", value: "Upvote existing requests on our [feedback board](https://feedback.example.com)", inline: false },
      { name: "⏱️ Updates", value: "Quarterly roadmap reviews", inline: true }
    ]
  },
  question: {
    color: 0x57F287, // Green
    title: "❓ Question Received",
    description: "We've got your question. Here's where to find answers while you wait:",
    fields: [
      { name: "📚 Resources", value: "[Documentation](https://docs.example.com) • [FAQ](https://faq.example.com)", inline: false },
      { name: "⏱️ Response Time", value: "Usually 24-48 hours", inline: true }
    ]
  },
  complaint: {
    color: 0xEB459E, // Pink
    title: "😤 Feedback Noted",
    description: "We're sorry to hear about your experience. Your feedback helps us improve.",
    fields: [
      { name: "📢 What's next?", value: "A team member will review and reach out to understand your concerns better.", inline: false },
      { name: "⏱️ Response Time", value: "Within 24 hours", inline: true }
    ]
  },
  contact_request: {
    color: 0x23272A, // Dark
    title: "📱 Contact Request Logged",
    description: "We received your request for direct contact. A team member will reach out to you shortly.",
    fields: [
      { name: "📩 Note", value: "Please keep an eye on your DMs and email for our message.", inline: false },
      { name: "⏱️ Response Time", value: "Within 6-12 hours", inline: true }
    ]
  },
  default: {
    color: 0x5865F2,
    title: "📨 Ticket Received",
    description: "Your message has been received. Our support team will review and respond shortly.",
    fields: [
      { name: "👍 Thanks for your patience!", value: "No further action needed from you at this time.", inline: false }
    ]
  }
};

/**
 * 发送 Ticket 自动回复
 * @param {Message} message - Discord 消息对象
 * @param {Object} classification - AI 分类结果
 * @returns {Promise<boolean>} 是否成功发送
 */
async function sendTicketAutoReply(message, classification) {
  // 检查是否属于 Ticket 分类（使用 parentId 检测）
  if (!TICKET_CATEGORY_ID || message.channel.parentId !== TICKET_CATEGORY_ID) {
    return false;
  }

  // 检查是否已回复过
  if (repliedTickets.has(message.channel.id)) {
    return false;
  }

  const template = TICKET_REPLY_TEMPLATES[classification.category] || TICKET_REPLY_TEMPLATES.default;

  const embed = {
    color: template.color,
    title: template.title,
    description: template.description,
    fields: [
      ...template.fields,
      { name: "​", value: `Ticket ID: \`${message.channel.id.slice(-8)}\``, inline: false }
    ],
    footer: {
      text: "This is an automated response. A staff member will reply soon."
    },
    timestamp: new Date().toISOString()
  };

  try {
    await message.channel.send({ embeds: [embed] });
    repliedTickets.add(message.channel.id);
    saveRepliedTickets();
    console.log(`[Ticket] 已发送自动回复 | Channel: ${message.channel.id} | Category: ${classification.category}`);
    return true;
  } catch (err) {
    console.error(`[Ticket] 发送自动回复失败:`, err.message);
    return false;
  }
}

/**
 * Discord Bot 启动
 */
discord.once("ready", () => {
  console.log(`[启动成功] Discord Bot 已上线: ${discord.user.tag}`);
  console.log(`[配置] 监听 ${CHANNEL_IDS.size} 个频道:`, [...CHANNEL_IDS]);
});

/**
 * 消息处理主逻辑
 */
discord.on("messageCreate", async (message) => {
  // 忽略机器人
  if (message.author.bot) return;

  // 检查是否属于 Ticket 分类
  const isTicketChannel = TICKET_CATEGORY_ID && message.channel.parentId === TICKET_CATEGORY_ID;

  // 频道过滤：监听列表中的频道 或 Ticket 分类下的频道
  if (!CHANNEL_IDS.has(message.channel.id) && !isTicketChannel) return;

  const userId = message.author.id;
  const isException = EXCEPTION_USER_IDS.has(userId);

  // 管理员过滤（例外用户除外）
  if (!isException) {
    const member = message.member;
    if (member?.roles.cache.some(r => STAFF_ROLE_NAMES.includes(r.name))) {
      console.log(`[跳过] 管理员消息 | ${message.author.tag} | ${userId}`);
      return;
    }
  } else {
    console.log(`[例外] 例外用户处理 | ${message.author.tag} | ${userId}`);
  }

  const content = message.content.trim();
  if (!content) return;

  const channelType = isTicketChannel ? "[Ticket]" : "[Channel]";
  console.log(`${channelType}[${message.channel.name}] 收到: ${message.author.tag}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

  try {
    let classification;
    let issue = null;
    let priority;

    // ========== 第一层：P0 关键词强匹配 ==========
    const p0Result = detectP0Keywords(content);

    if (p0Result) {
      console.log(`[P0检测] 类型: ${p0Result.type === 'contact' ? '联系方式' : p0Result.type === 'payment' ? '支付问题' : p0Result.type === 'account' ? '账号安全' : '崩溃故障'}`);

      priority = 'P0';
      classification = {
        category: p0Result.type,
        severity: 'high',
        title: p0Result.type === 'contact' ? 'Contact request (P0)' :
               p0Result.type === 'payment' ? 'Payment issue (P0)' :
               p0Result.type === 'account' ? 'Account security (P0)' :
               'Critical issue (P0)',
        summary: content.slice(0, 100),
        should_notify: true,
        should_create_ticket: p0Result.type !== 'contact'
      };

    } else {
      // ========== 第二层：AI 分类 ==========
      classification = await classifyMessage(content);

      // ========== 第三层：映射优先级 ==========
      priority = mapToPriority(classification.category, classification.severity);

      console.log(`[AI分类] ${classification.category} | ${classification.severity} → Priority ${priority}`);
    }

    // ========== 获取优先级配置 ==========
    const config = getPriorityConfig(priority, classification);
    console.log(`[${config.log}] ${classification.title || 'Processing'}`);

    // ========== 创建 GitHub Issue (P0, P1, P2 才创建) ==========
    if (config.createTicket && classification.should_create_ticket) {
      issue = await createGithubIssue({ classification, discordMessage: message });
      console.log(`[GitHub] Created #${issue.number}`);
    }

    // ========== Ticket 自动回复 ==========
    let ticketReplySent = false;
    if (TICKET_CATEGORY_ID && message.channel.parentId === TICKET_CATEGORY_ID) {
      ticketReplySent = await sendTicketAutoReply(message, classification);
    }

    // ========== 钉钉通知 ==========
    if (config.notify && classification.should_notify) {
      await notifyDingTalk({ priority, classification, discordMessage: message, issue, ticketReplySent });
      console.log(`[DingTalk] ${priority} notified${ticketReplySent ? " (含Ticket状态)" : ""}`);
    } else {
      console.log(`[Skip] ${priority} no notification`);
    }

  } catch (error) {
    console.error("[Error]", error.response?.data || error.message);
  }
});

// 错误处理
discord.on("error", console.error);
process.on("unhandledRejection", console.error);

discord.login(process.env.DISCORD_TOKEN);