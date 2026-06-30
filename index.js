require("dotenv").config();

const crypto = require("crypto");
const axios = require("axios");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

/**
 * 检查必要的环境变量
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
    throw new Error(`缺少环境变量：${key}`);
  }
}

/**
 * 解析监听的 Discord 频道列表（支持多个，逗号分隔）
 */
const CHANNEL_IDS = new Set(
  (process.env.DISCORD_CHANNEL_IDS || process.env.DISCORD_FAQ_CHANNEL_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (CHANNEL_IDS.size === 0) {
  throw new Error(
    "请配置 DISCORD_CHANNEL_IDS 环境变量，例如：123456789,987654321"
  );
}

console.log(`[启动] 监听 ${CHANNEL_IDS.size} 个频道`);

/**
 * 智谱 AI 客户端
 * 使用 OpenAI 兼容接口
 */
const aiClient = new OpenAI({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
});

/**
 * GitHub 客户端
 */
const github = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

/**
 * Discord 客户端
 */
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * 从 AI 返回内容中解析 JSON
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error(`AI 没有返回合法 JSON：${text}`);
    }

    return JSON.parse(match[0]);
  }
}

/**
 * 校验 AI 分类结果
 */
function validateClassification(result) {
  const validCategories = [
    "bug",
    "feature_request",
    "question",
    "complaint",
    "account",
    "payment",
    "noise",
  ];

  const validSeverities = [
    "low",
    "medium",
    "high",
    "critical",
  ];

  if (!validCategories.includes(result.category)) {
    throw new Error(`AI 返回了无效分类：${result.category}`);
  }

  if (!validSeverities.includes(result.severity)) {
    throw new Error(`AI 返回了无效严重程度：${result.severity}`);
  }

  if (!result.title || typeof result.title !== "string") {
    throw new Error("AI 未返回有效工单标题");
  }

  if (!result.summary || typeof result.summary !== "string") {
    throw new Error("AI 未返回有效摘要");
  }

  return {
    category: result.category,
    severity: result.severity,
    title: result.title.trim(),
    summary: result.summary.trim(),
    should_notify: result.should_notify === true,
    should_create_ticket:
      result.should_create_ticket === true,
  };
}

/**
 * 调用智谱 AI 对 Discord 消息进行分类
 */
async function classifyMessage(messageText) {
  const response = await aiClient.chat.completions.create({
    model: process.env.ZHIPU_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: `
You are a user feedback classifier for a software product.

Classify Discord user messages into one of these categories:

- bug
- feature_request
- question
- complaint
- account
- payment
- noise

Severity levels (only these):

- low
- medium
- high
- critical

Classification rules:

1. Bug: Software errors, crashes, failures, or inability to use features.
2. Feature Request: Explicit requests for new features or improvements.
3. Question: Asking how to use the product.
4. Complaint: Expressing dissatisfaction without specific technical failures.
5. Account: Login issues, authentication, permissions, verification codes.
6. Payment: Billing, subscriptions, refunds, payment failures.
7. Noise: Chitchat, emojis, test messages, meaningless content.

Severity guidelines:

- low: Minor impact, workarounds available.
- medium: Affects normal use but not completely blocking.
- high: Core features unavailable, significant impact.
- critical: Data loss, security issues, widespread service outage.

Ticket creation rules (GitHub Issue):

- bug: CREATE
- feature_request: CREATE
- account: CREATE
- payment: CREATE
- complaint: CREATE only if medium/high/critical
- question: DO NOT create
- noise: DO NOT create

DingTalk notification rules:

- noise: DO NOT notify
- contact_request: NOTIFY (handled separately before this classification)
- all others: NOTIFY

Output format:
Return only valid JSON. Do not use markdown code blocks. No explanations.

Example response:
{
  "category": "bug",
  "severity": "high",
  "title": "Short English summary for GitHub issue title",
  "summary": "One sentence summarizing the user feedback",
  "should_notify": true,
  "should_create_ticket": true
}

返回格式：

{
  "category": "bug",
  "severity": "high",
  "title": "适合作为 GitHub Issue 标题的中文摘要",
  "summary": "用中文概括用户反馈",
  "should_notify": true,
  "should_create_ticket": true
}
        `.trim(),
      },
      {
        role: "user",
        content: messageText,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;

  if (!content) {
    throw new Error("智谱 AI 未返回分类结果");
  }

  const parsed = safeJsonParse(content);

  return validateClassification(parsed);
}

/**
 * 创建 GitHub Issue
 */
async function createGithubIssue({
  classification,
  discordMessage,
}) {
  const labelMap = {
    bug: "bug",
    feature_request: "enhancement",
    question: "question",
    complaint: "complaint",
    account: "account",
    payment: "payment",
  };

  const labels = [];

  if (labelMap[classification.category]) {
    labels.push(labelMap[classification.category]);
  }

  labels.push(`severity:${classification.severity}`);

  const body = `
## AI 分类

- 类型：${classification.category}
- 严重程度：${classification.severity}
- 摘要：${classification.summary}

## Discord 来源

- 用户：${discordMessage.author.tag}
- 用户 ID：${discordMessage.author.id}
- 频道：#${discordMessage.channel.name}
- 时间：${discordMessage.createdAt.toISOString()}
- 原消息链接：${discordMessage.url}

## 原始消息

> ${discordMessage.content.replace(/\n/g, "\n> ")}
  `.trim();

  const issueParams = {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    title: `[${classification.category}][${classification.severity}] ${classification.title}`,
    body,
  };

  try {
    const result = await github.issues.create({
      ...issueParams,
      labels,
    });

    return result.data;
  } catch (error) {
    console.warn(
      "带标签创建 Issue 失败，将尝试不带标签创建：",
      error.message
    );

    const fallback = await github.issues.create(issueParams);

    return fallback.data;
  }
}

/**
 * 构建钉钉加签 Webhook 地址
 */
function buildSignedDingTalkUrl() {
  const webhook = process.env.DINGTALK_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;

  if (!secret) {
    return webhook;
  }

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;

  const sign = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64");

  const separator = webhook.includes("?") ? "&" : "?";

  return `${webhook}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(
    sign
  )}`;
}

/**
 * 发送钉钉通知
 */
async function notifyDingTalk({
  classification,
  discordMessage,
  issue,
}) {
  const issueText = issue
    ? `GitHub 工单：#${issue.number}\n${issue.html_url}`
    : "GitHub 工单：未创建";

  const text = `
【Discord 用户反馈】

类型：${classification.category}
严重程度：${classification.severity}
用户：${discordMessage.author.tag}

摘要：
${classification.summary}

原始消息：
${discordMessage.content}

${issueText}

Discord 原消息：
${discordMessage.url}
  `.trim();

  const response = await axios.post(
    buildSignedDingTalkUrl(),
    {
      msgtype: "text",
      text: {
        content: text,
      },
    },
    {
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  console.log("钉钉返回结果：", response.data);

  if (response.data?.errcode !== 0) {
    throw new Error(
      `钉钉发送失败：${response.data?.errcode} ${response.data?.errmsg}`
    );
  }

  return response.data;
}

/**
 * Discord Bot 上线
 */
discord.once("ready", () => {
  console.log(`Discord Bot 已上线：${discord.user.tag}`);
  console.log(`正在监听 ${CHANNEL_IDS.size} 个频道：`, [...CHANNEL_IDS]);
});

/**
 * 例外用户 ID：这些用户的消息始终处理（即使他们是管理员）
 */
const EXCEPTION_USER_IDS = new Set([
  "1521030281597943879", // 特定用户始终处理
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
 * 监听 Discord 消息
 */
discord.on("messageCreate", async (message) => {
  // 忽略机器人消息，防止循环
  if (message.author.bot) return;

  // 检查是否在监听的频道列表中
  if (!CHANNEL_IDS.has(message.channel.id)) {
    return;
  }

  const userId = message.author.id;
  const isExceptionUser = EXCEPTION_USER_IDS.has(userId);

  // 检查用户角色：管理员/版主的消息不处理（内部回复），但例外用户除外
  if (!isExceptionUser) {
    const member = message.member;
    if (member) {
      const isStaff = member.roles.cache.some(role =>
        STAFF_ROLE_NAMES.includes(role.name)
      );

      if (isStaff) {
        console.log(`[RAILWAY-LOG] 跳过管理员消息 | 用户: ${message.author.tag} | ID: ${userId} | 角色: ${member.roles.cache.map(r => r.name).join(', ')}`);
        return;
      }
    }
  } else {
    console.log(`[RAILWAY-LOG] 例外用户处理 | 用户: ${message.author.tag} | ID: ${userId}（尽管可能是管理员，仍强制处理）`);
  }

  const content = message.content.trim();

  // 忽略空消息
  if (!content) return;

  console.log(
    `[${message.channel.name}] 收到消息：${message.author.tag}：${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`
  );

  /**
   * Keyword detection: contact requests
   * These indicate high-intent customers requiring human attention, P0 priority
   */
  const contactKeywords = [
    /\bdm\s*me\b/i,                           // "dm me", "DM me"
    /\bmessage\s*me\b/i,                      // "message me"
    /\bcontact\s*me\b/i,                      // "contact me"
    /\breach\s*out\b/i,                       // "reach out", "reach out to me"
    /\bping\s*me\b/i,                         // "ping me"
    /\bslide\s*into\s*my\s*dms?\b/i,          // "slide into my dm"
    /\badd\s*me\s*on\b/i,                     // "add me on discord/telegram"
    /\bmy\s+(?:discord|telegram|tg|whatsapp|line)\s+is\b/i,  // "my discord is xxx"
    /\b(let['']?s\s+)?(move|take)\s+this\s+(to\s+)?(dm|pm|private)\b/i,  // "let's move this to dm"
  ];

  const isContactRequest = contactKeywords.some(pattern => pattern.test(content));

  if (isContactRequest) {
    console.log("[关键词匹配] 检测到联系方式请求，强制推送钉钉（P0 高优先级）");

    await notifyDingTalk({
      classification: {
        category: "contact_request",
        severity: "high",
        title: "🔥 用户要求私下联系（需人工立即介入）",
        summary: content,
        should_notify: true,
        should_create_ticket: false,  // 人工处理优先于 GitHub Issue
      },
      discordMessage: message,
      issue: null,
    });

    console.log("已同步到钉钉 [contact_request]");
    return; // 跳过 AI 分类，避免误判为 noise
  }

  try {
    const classification =
      await classifyMessage(content);

    console.log("AI 分类结果：", classification);

    let issue = null;

    if (classification.should_create_ticket) {
      issue = await createGithubIssue({
        classification,
        discordMessage: message,
      });

      console.log(
        `已创建 GitHub Issue：${issue.html_url}`
      );
    }

    if (classification.should_notify) {
      await notifyDingTalk({
        classification,
        discordMessage: message,
        issue,
      });

      console.log("已同步到钉钉");
    } else {
      console.log("该消息无需同步到钉钉");
    }
  } catch (error) {
    console.error(
      "处理消息失败：",
      error.response?.data ||
        error.error ||
        error.message ||
        error
    );
  }
});

/**
 * Discord 客户端错误
 */
discord.on("error", (error) => {
  console.error("Discord 客户端错误：", error);
});

/**
 * 未捕获 Promise 异常
 */
process.on("unhandledRejection", (error) => {
  console.error("未处理的 Promise 异常：", error);
});

/**
 * 未捕获同步异常
 */
process.on("uncaughtException", (error) => {
  console.error("未捕获异常：", error);
});

/**
 * 优雅退出
 */
async function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭 Discord Bot`);

  try {
    discord.destroy();
  } catch (error) {
    console.error("关闭 Discord Bot 失败：", error);
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * 登录 Discord
 */
discord.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Discord 登录失败：", error);
  process.exit(1);
});