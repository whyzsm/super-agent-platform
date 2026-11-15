import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseCliNdjsonLine } from '../../daemon/ndjsonParser';
import type {
  AgentProvider,
  AgentRunnerAdapter,
  NormalizedAgentEvent,
} from '../../protocol';

/**
 * 真实 spawn 的 headless-json 适配器，实现 src/protocol/index.ts 的 AgentRunnerAdapter。
 * 默认命令为 claude -p --output-format stream-json；可用 SUPERAGENT_CLI_COMMAND /
 * SUPERAGENT_CLI_ARGS 指向任意输出 NDJSON 的本地命令（用于链路自检）。
 * stdout 每行先经 parseCliNdjsonLine() 脱敏与危险命令拦截，再归一化。
 */

export interface HeadlessJsonAdapterOptions {
  provider?: AgentProvider;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

const DEFAULT_ARGS = ['-p', '--output-format', 'stream-json', '{prompt}'];

function argsFromEnv(): string[] | undefined {
  const raw = process.env.SUPERAGENT_CLI_ARGS;
  return raw && raw.trim() ? raw.trim().split(/\s+/) : undefined;
}

export function createHeadlessJsonAdapter(
  options: HeadlessJsonAdapterOptions = {},
): AgentRunnerAdapter {
  const provider: AgentProvider = options.provider ?? 'claude-code';
  const sessions = new Map<string, ChildProcessWithoutNullStreams>();
  let listener: ((event: NormalizedAgentEvent) => void) | null = null;
  let seq = 0;

  const emit = (event: NormalizedAgentEvent): void => {
    listener?.(event);
  };

  return {
    provider,
    mode: 'headless-json',

    onEvent(cb) {
      listener = cb;
    },

    async spawn(params) {
      const command =
        options.command ?? process.env.SUPERAGENT_CLI_COMMAND ?? 'claude';
      const argsTemplate = options.args ?? argsFromEnv() ?? DEFAULT_ARGS;
      const args = argsTemplate.map((arg) =>
        arg.replaceAll('{prompt}', params.prompt),
      );

      const child = spawn(command, args, {
        cwd: params.worktreePath,
        env: { ...process.env, ...params.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const sessionId = params.taskId;
      sessions.set(sessionId, child);

      let buffer = '';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = parseCliNdjsonLine(provider, line, ++seq);
          if (parsed.dangerIntercept) {
            emit({
              type: 'thought',
              content: `[blocked] ${parsed.dangerIntercept.reason}`,
              ts: Date.now(),
            });
            child.kill();
            return;
          }
          const detail = parsed.event?.detail ?? parsed.terminalChunk ?? line;
          if (
            parsed.event?.kind === 'file_edit' ||
            parsed.event?.kind === 'tool_call'
          ) {
            emit({ type: 'thought', content: detail, ts: Date.now() });
          } else {
            emit({ type: 'terminal_chunk', stream: 'stdout', data: detail });
          }
        }
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        emit({ type: 'terminal_chunk', stream: 'stderr', data: chunk });
      });

      child.on('error', (err: Error) => {
        emit({
          type: 'completed',
          exitCode: -1,
          summary: `CLI 启动失败: ${err.message}`,
        });
        sessions.delete(sessionId);
      });

      child.on('close', (code: number | null) => {
        emit({
          type: 'completed',
          exitCode: code ?? -1,
          summary: 'CLI 会话结束',
        });
        sessions.delete(sessionId);
      });

      const timer = setTimeout(() => {
        if (sessions.has(sessionId)) child.kill();
      }, options.timeoutMs ?? 60_000);
      timer.unref();

      return { sessionId, pid: child.pid ?? -1 };
    },

    async sendInput(sessionId, text) {
      const child = sessions.get(sessionId);
      if (!child) throw new Error(`会话不存在: ${sessionId}`);
      child.stdin.write(`${text}\n`);
    },

    async approveTool(_sessionId, toolCallId, approved) {
      emit({
        type: 'thought',
        content: `headless-json 无工具审批通道: ${toolCallId} ${approved ? 'approved' : 'rejected'}`,
        ts: Date.now(),
      });
    },

    async terminate(sessionId) {
      const child = sessions.get(sessionId);
      if (!child) return;
      child.kill();
      sessions.delete(sessionId);
    },
  };
}
