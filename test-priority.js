/**
 * P0-P1-P2-P3 优先级系统测试用例
 * 运行: node test-priority.js
 */

const TEST_CASES = [
  // ============ P0 - Critical ============
  {
    message: "dm me for details",
    expect: { priority: "P0", keywordType: "contact", reason: "直接DM请求" }
  },
  {
    message: "Can you DM me?",
    expect: { priority: "P0", keywordType: "contact", reason: "大写DM+变体" }
  },
  {
    message: "please check dm",
    expect: { priority: "P0", keywordType: "contact", reason: "check dm变体" }
  },
  {
    message: "My discord is erik#1234",
    expect: { priority: "P0", keywordType: "contact", reason: "主动给出联系方式" }
  },
  {
    message: "Let's move this to DM",
    expect: { priority: "P0", keywordType: "contact", reason: "let's move变体" }
  },
  {
    message: "Message me your email",
    expect: { priority: "P0", keywordType: "contact", reason: "message me关键词" }
  },
  {
    message: "was charged twice please help",
    expect: { priority: "P0", keywordType: "payment", reason: "重复扣款" }
  },
  {
    message: "I need a refund",
    expect: { priority: "P0", keywordType: "payment", reason: "退款请求" }
  },
  {
    message: "My money is missing",
    expect: { priority: "P0", keywordType: "payment", reason: "资金缺失" }
  },
  {
    message: "Account was hacked",
    expect: { priority: "P0", keywordType: "account", reason: "账号被盗" }
  },
  {
    message: "Someone unauthorized is using my account",
    expect: { priority: "P0", keywordType: "account", reason: "未授权访问" }
  },
  {
    message: "Account locked can't login",
    expect: { priority: "P0", keywordType: "account", reason: "账号锁定" }
  },
  {
    message: "App crashed and I lost my data",
    expect: { priority: "P0", keywordType: "crash", reason: "崩溃+数据丢失" }
  },
  {
    message: "Service is down",
    expect: { priority: "P0", keywordType: "crash", reason: "服务宕机" }
  },

  // ============ P1 - High ============
  // 需要AI分类为bug+high 或 complaint+high/medium
  {
    message: "This is a major bug, I can't transfer funds",
    expect: { priority: "P1", category: "bug", severity: "high", reason: "重大bug影响核心功能" }
  },
  {
    message: "Very disappointed with this feature",
    expect: { priority: "P1", category: "complaint", severity: "high", reason: "强烈不满投诉" }
  },
  {
    message: "This is terrible, fix it now",
    expect: { priority: "P1", category: "complaint", severity: "high", reason: "紧急投诉语气" }
  },

  // ============ P2 - Medium ============
  {
    message: "Can you add bulk transfer feature?",
    expect: { priority: "P2", category: "feature_request", reason: "功能请求" }
  },
  {
    message: "It would be nice to have dark mode",
    expect: { priority: "P2", category: "feature_request", reason: "体验优化建议" }
  },
  {
    message: "The button is a bit slow",
    expect: { priority: "P2", category: "bug", severity: "medium", reason: "轻微性能问题" }
  },

  // ============ P3 - Low ============
  {
    message: "How do I set gas limit?",
    expect: { priority: "P3", category: "question", reason: "使用疑问" }
  },
  {
    message: "Where can I find the documentation?",
    expect: { priority: "P3", category: "question", reason: "文档问题" }
  },
  {
    message: "What's the best practice for...",
    expect: { priority: "P3", category: "question", reason: "最佳实践咨询" }
  },

  // ============ Noise (Dropped) ============
  {
    message: "lol",
    expect: { priority: "No", category: "noise", reason: "纯笑声" }
  },
  {
    message: "👍👍👍",
    expect: { priority: "No", category: "noise", reason: "纯表情" }
  },
  {
    message: "test",
    expect: { priority: "No", category: "noise", reason: "测试消息" }
  },
  {
    message: "hi",
    expect: { priority: "No", category: "noise", reason: "纯问候" }
  },

  // ============ P0 Override Cases (AI兜底修正) ============
  // AI可能误判，但代码会修正
  {
    message: "just a quick dm",
    expect: { priority: "P0", override: true, reason: "AI可能判noise，但含DM强制修正" }
  },
  {
    message: "dm plz",
    expect: { priority: "P0", override: true, reason: "plz变体" }
  },

  // ============ Edge Cases ============
  {
    message: "ADMIN",  // 管理员用户名，不是角色
    expect: { priority: "P1-P3", note: "取决于实际内容，无关键词则走AI" }
  },
  {
    message: "check my admin panel",  // 含admin但不是角色
    expect: { priority: "P3", category: "question", note: "question类" }
  },
];

// ============ 测试执行 ============

const P0_KEYWORDS = {
  contact: [/\bdm\b/i, /\bpm\b/i, /\bmessage\s*me\b/i, /\bcontact\s*me\b/i, /\breach\s*out\b/i, /\bping\s*me\b/i, /\bslide\s*into\s*my\s*dms?\b/i, /\badd\s*me\s*on\b/i, /\bemail\s*me\b/i, /\btext\s*me\b/i, /\bcall\s*me\b/i, /\blet['']?s\s+(move|take)\s+this\s+private\b/i, /\bmy\s+(discord|telegram|tg|whatsapp|email|line)\s+is\b/i],
  payment: [/\brefund\b/i, /\bdidn['']?t\s+receive\b/i, /\bcharge(d)?\s+twice\b/i, /\bdouble\s+charge\b/i, /\bovercharge\b/i, /\bpayment\s+failed\b/i, /\bmoney\s+gone\b/i, /\bfund(s)?\s+missing\b/i, /\bwithdraw(al)?\s+stuck\b/i, /\bstuck\s+in\s+pending\b/i],
  account: [/\baccount\s+locked\b/i, /\baccount\s+hacked\b/i, /\bunauthorized\s+access\b/i, /\bsomeone\s+else\s+using\b/i, /\bcan['']?t\s+login\s*anymore\b/i, /\baccount\s+suspended\b/i, /\baccount\s+banned\b/i],
  crash: [/\bapp\s+crashed\b/i, /\bdata\s+lost\b/i, /\bcan['']?t\s+access\b/i, /\bservice\s+down\b/i, /\bblank\s+screen\b/i, /\bfrozen\b/i, /\bstuck\s+loading\b/i, /\bcritical\s+error\b/i]
};

function detectP0(content) {
  for (const [type, patterns] of Object.entries(P0_KEYWORDS)) {
    if (patterns.some(p => p.test(content))) {
      return type;
    }
  }
  return null;
}

console.log("=".repeat(60));
console.log("P0-P1-P2-P3 Priority System Test Cases");
console.log("=".repeat(60));
console.log();

let pass = 0;
let fail = 0;

for (const test of TEST_CASES) {
  const p0Type = detectP0(test.message);
  const expectedP0 = test.expect.priority === "P0";
  const detectedP0 = !!p0Type;

  // 检查P0匹配是否符合预期
  const p0Match = expectedP0 === detectedP0;
  const p0TypeMatch = test.expect.keywordType ? p0Type === test.expect.keywordType : true;

  const status = p0Match && p0TypeMatch ? "✅ PASS" : "❌ FAIL";

  if (p0Match && p0TypeMatch) pass++;
  else fail++;

  console.log(`\nMessage: "${test.message}"`);
  console.log(`Expected: ${test.expect.priority} ${test.expect.keywordType ? `(${test.expect.keywordType})` : ""}`);
  console.log(`Detected: ${detectedP0 ? `P0 (${p0Type})` : "Not P0 (needs AI classification)"}`);
  console.log(`Reason: ${test.expect.reason}`);
  console.log(`Status: ${status}`);
}

console.log("\n" + "=".repeat(60));
console.log(`Results: ${pass} passed, ${fail} failed, ${TEST_CASES.length} total`);
console.log("=".repeat(60));

// 汇总P0触发词
console.log("\n📋 P0 Trigger Words by Category:");
console.log("-".repeat(40));
for (const [type, patterns] of Object.entries(P0_KEYWORDS)) {
  console.log(`\n${type.toUpperCase()}:`);
  const examples = {
    contact: ["dm me", "check dm", "email me", "contact me", "my discord is..."],
    payment: ["refund", "charged twice", "money missing", "withdrawal stuck"],
    account: ["account hacked", "unauthorized access", "account locked"],
    crash: ["app crashed", "data lost", "service down", "blank screen"]
  };
  examples[type].forEach(e => console.log(`  - "${e}"`));
}