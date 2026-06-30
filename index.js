require("dotenv").config();

const crypto = require("crypto");
const axios = require("axios");
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

const requiredEnv = [
  "DISCORD_TOKEN",
  "DISCORD_FAQ_CHANNEL_ID",
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

async function classifyMessage(messageText) {
  const response = await aiClient.chat.completions.create({
    model: process.env.ZHIPU_MODEL,
    temperature: 0.1,
    response_format: {
      type: "json_object",
    },
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

判断规则：

1. 明确的软件异常、报错、无法使用，归类为 bug。
2. 明确提出新增或优化功能，归类为 feature_request。
3. 单纯询问如何使用，归类为 question。
4. 明显表达不满但没有具体故障，归类为 complaint。
5. 登录、权限、账号问题，归类为 account。
6. 付费、订阅、退款问题，归类为 payment。
7. 闲聊、表情、无意义内容，归类为 noise。

创建工单规则：

- bug：创建
- feature_request：创建
- account：创建
- payment：创建
- complaint：仅 medium 以上创建
- question：不创建
- noise：不创建

钉钉播报规则：

- noise：不播报
- 其他类别：播报

只返回 JSON，不要返回任何额外文字：

{
  "category": "bug",
  "severity": "high",
  "title": "适合作为工单标题的中文摘要",
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
    throw new Error("AI 未返回分类结果");
  }

  return safeJsonParse(content);
}

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
    /*
     * 如果仓库里还没有对应标签，GitHub 可能拒绝创建。
     * 此时退化为不带标签创建，确保主流程不中断。
     */
    const fallback = await github.issues.create({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      title: `[${classification.category}][${classification.severity}] ${classification.title}`,
      body,
    });

    return fallback.data;
  }
}

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

  return `${webhook}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

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