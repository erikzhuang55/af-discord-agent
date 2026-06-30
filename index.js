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
你是一个软件产品的用户反馈分拣助手。

请把 Discord 用户消息分类为以下一种：

bug
feature_request
question
complaint
account
payment
noise

严重程度只能是：

low
medium
high
critical

分类规则：

1. 明确的软件异常、报错、崩溃、无法使用，归类为 bug。
2. 明确提出新增功能或优化建议，归类为 feature_request。
3. 单纯询问产品如何使用，归类为 question。
4. 明显表达不满，但没有具体故障，归类为 complaint。
5. 登录、账号、权限、验证码相关问题，归类为 account。
6. 付费、订阅、扣费、退款相关问题，归类为 payment。
7. 闲聊、表情、测试消息、无意义内容，归类为 noise。

严重程度规则：

- low：影响轻微，有替代方案。
- medium：影响正常使用，但不是核心功能全面不可用。
- high：核心功能不可用、影响较大。
- critical：数据丢失、安全问题、大范围服务不可用。

创建工单规则：

- bug：创建
- feature_request：创建
- account：创建
- payment：创建
- complaint：仅 medium、high 或 critical 创建
- question：不创建
- noise：不创建

钉钉播报规则：

- noise：不播报
- 其他类别：播报

只返回合法 JSON，不要添加 Markdown，不要添加解释，不要使用代码块。

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
 * 监听 Discord 消息
 */
discord.on("messageCreate", async (message) => {
  // 忽略机器人消息，防止循环
  if (message.author.bot) return;

  // 检查是否在监听的频道列表中
  if (!CHANNEL_IDS.has(message.channel.id)) {
    // 可选：调试时取消注释下面这行
    // console.log(`[跳过] 频道不在监听列表: ${message.channel.name} (${message.channel.id})`);
    return;
  }

  const content = message.content.trim();

  // 忽略空消息
  if (!content) return;

  console.log(
    `[${message.channel.name}] 收到消息：${message.author.tag}：${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`
  );

  /**
   * 敏感词检测：联系方式请求
   * 这类消息代表高意向客户，必须人工介入，优先级 P0
   */
  const contactKeywords = [
    /(?:dm|私信|私聊)\s*(?:我)?/i,           // "dm我", "私信我", "私聊"
    /加我\s*(?:微信|好友|line|qq|电报)?/i,   // "加我", "加我微信"
    /联系我|找我|发邮件给我|reach\s*out/i,   // "联系我", "找我"
    /(?:我的|添加我的?)\s*(?:微信|line|telegram|tg)/i,  // "我的微信", "添加我的微信"
  ];

  const isContactRequest = contactKeywords.some(pattern => pattern.test(content));

  if (isContactRequest) {
    console.log("[关键词触发] 检测到联系方式请求，强制推送钉钉（高优先级）");

    await notifyDingTalk({
      classification: {
        category: "contact_request",
        severity: "high",
        title: "用户要求私下联系（需人工介入）",
        summary: content,
        should_notify: true,
        should_create_ticket: false,  // 不创建工单，但需要人工处理
      },
      discordMessage: message,
      issue: null,
    });

    console.log("已同步到钉钉 [contact_request]");
    return; // 跳过后续 AI 分类，直接处理完毕
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