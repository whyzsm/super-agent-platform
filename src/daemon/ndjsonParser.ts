import { detectDangerousCommand, redactSecrets } from '../engine/stateMachine';
import type {
  AgentProvider,
  AgentReasoningEvent,
  DaemonEnvelope,
} from '../protocol';

export interface ParsedCliOutput {
  event?: AgentReasoningEvent;
  terminalChunk?: string;
  dangerIntercept?: {
    rule: string;
    reason: string;
    command: string;
  };
}

export function parseCliNdjsonLine(
  provider: AgentProvider,
  rawLine: string,
  seq: number,
  nowTs: string = new Date().toTimeString().slice(0, 8),
): ParsedCliOutput {
  const trimmed = rawLine.trim();
  if (!trimmed) return {};

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const { redacted } = redactSecrets(trimmed);
    return { terminalChunk: redacted };
  }

  const rawType = String(parsed.type ?? parsed.event ?? 'message');
  const rawDetail = String(
    parsed.command ??
      parsed.text ??
      parsed.content ??
      parsed.path ??
      JSON.stringify(parsed),
  );
  const { redacted, hitCount } = redactSecrets(rawDetail);

  // Check shell commands against ACP Danger Gate rules
  if (
    rawType.includes('shell') ||
    rawType.includes('command') ||
    rawType.includes('bash') ||
    typeof parsed.command === 'string'
  ) {
    const cmd = String(parsed.command ?? rawDetail);
    const danger = detectDangerousCommand(cmd);
    if (danger.dangerous) {
      return {
        dangerIntercept: {
          rule: danger.rule ?? 'DANGER_COMMAND',
          reason: danger.reason ?? '拦截高危命令',
          command: cmd,
        },
        event: {
          id: `ev-${seq}`,
          ts: nowTs,
          seq,
          kind: 'acp_intercept',
          title: `ACP 拦截高危指令 (${danger.rule})`,
          detail: redactSecrets(cmd).redacted,
          status: 'blocked',
          redactedHits: hitCount,
        },
        terminalChunk: `[${provider}] [acp-guard] BLOCKED: ${redactSecrets(cmd).redacted}`,
      };
    }
  }

  const kind: AgentReasoningEvent['kind'] = rawType.includes('edit') || rawType.includes('write')
    ? 'file_edit'
    : rawType.includes('tool') || rawType.includes('call')
      ? 'tool_call'
      : rawType.includes('verify') || rawType.includes('test')
        ? 'verifier_check'
        : 'thought';

  const title =
    typeof parsed.title === 'string'
      ? parsed.title
      : `[${provider}] ${rawType}`;

  return {
    event: {
      id: `ev-${seq}`,
      ts: nowTs,
      seq,
      kind,
      title,
      detail: redacted,
      status: parsed.ok === false ? 'failed' : 'ok',
      redactedHits: hitCount,
    },
    terminalChunk: `[${provider}] ${redacted}`,
  };
}

export class OfflineSeqQueue {
  private buffer: DaemonEnvelope[] = [];
  private lastAckSeq = 0;

  constructor(initialAckSeq = 0) {
    this.lastAckSeq = initialAckSeq;
  }

  enqueue(envelope: DaemonEnvelope): void {
    if (envelope.seq <= this.lastAckSeq) return;
    if (!this.buffer.some((e) => e.seq === envelope.seq)) {
      this.buffer.push(envelope);
      this.buffer.sort((a, b) => a.seq - b.seq);
    }
  }

  ackUpTo(seq: number): void {
    if (seq > this.lastAckSeq) {
      this.lastAckSeq = seq;
    }
    this.buffer = this.buffer.filter((e) => e.seq > this.lastAckSeq);
  }

  replayFrom(remoteLastAckSeq: number): DaemonEnvelope[] {
    return this.buffer.filter((e) => e.seq > remoteLastAckSeq);
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}
