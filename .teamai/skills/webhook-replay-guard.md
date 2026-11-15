---
name: "sop-webhook-replay-guard"
triggers: ["webhook", "wecom", "feishu", "hmac"]
scope: "team"
version: 2
---

# Webhook 签名校验与防重放规范
1. 使用 `timingSafeEqual` 防止时序侧信道攻击。
2. 强制校验 300s 时间戳重放窗口。