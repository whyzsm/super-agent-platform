#!/usr/bin/env node
/**
 * MCP stdio 传输桥：把 stdin 的 JSON-RPC 报文转发到本地运行中的 SuperAgent 控制面，
 * 再把响应写回 stdout。这样任意 MCP 客户端（Claude Desktop / Codex / Cursor 等）
 * 都能用标准 stdio 方式接入，而协议实现只有服务端一份。
 *
 * 用法:
 *   node scripts/mcp-stdio.mjs
 *   SUPERAGENT_MCP_URL=http://localhost:3000/api/mcp node scripts/mcp-stdio.mjs
 *
 * 客户端配置示例（claude_desktop_config.json）:
 *   {
 *     "mcpServers": {
 *       "superagent": {
 *         "command": "node",
 *         "args": ["<repo>/scripts/mcp-stdio.mjs"],
 *         "env": { "SUPERAGENT_MCP_URL": "http://localhost:3000/api/mcp" }
 *       }
 *     }
 *   }
 *
 * 约束：
 *   - stdout 只输出协议报文（日志一律走 stderr），否则会污染 MCP 帧；
 *   - 请求串行化，保证响应顺序与请求一致（stdio 是单通道）；
 *   - 桥接失败按 JSON-RPC -32603 回错误，不让客户端干等。
 */

import readline from 'node:readline';

const ENDPOINT = process.env.SUPERAGENT_MCP_URL ?? 'http://localhost:3000/api/mcp';
const TIMEOUT_MS = Number(process.env.SUPERAGENT_MCP_TIMEOUT_MS ?? 30000);

function writeMessage(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function internalError(message, id = null) {
  return { jsonrpc: '2.0', id, error: { code: -32603, message } };
}

async function forward(line) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // stdio 桥本身承载的是一个本地开发身份；服务端仍按四级 ACL 收敛可见范围。
        'x-superagent-user': process.env.SUPERAGENT_USER ?? 'mcp-stdio',
        'x-superagent-team': process.env.SUPERAGENT_TEAM ?? 'team-local',
        'x-superagent-roles': process.env.SUPERAGENT_ROLES ?? 'viewer',
      },
      body: line,
      signal: ac.signal,
    });

    // 202 = 纯通知，按规范无回包
    if (res.status === 202) return;

    const text = await res.text();
    if (!text) return;
    // 服务端已返回合法规程报文；原样透传（含批量数组），不再二次序列化。
    process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeMessage(internalError(`桥接失败：${message}`));
  } finally {
    clearTimeout(timer);
  }
}

const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const line = queue.shift();
    await forward(line);
  }
  draining = false;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue.push(trimmed);
  drain().catch((err) => {
    process.stderr.write(`[mcp-stdio] drain error: ${err}\n`);
  });
});

rl.on('close', () => {
  // 等待队列排空后再退出，避免丢掉最后的响应。
  const wait = setInterval(() => {
    if (queue.length === 0 && !draining) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 20);
});
