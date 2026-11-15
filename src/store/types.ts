import type { PlatformState } from '../data/seed';

/**
 * append-only 命令日志中的一条记录。
 * 状态由 save() 以原子快照落盘；命令日志只用于重放与幂等判定，重放不会二次写 state。
 */
export interface CommandRecord {
  commandId: string;
  appliedSeq: number;
  ts: string;
  kind: string;
  payload: unknown;
}

/** 可插拔状态存储契约：文件系统实现与未来的 Postgres 实现共用此接口，业务侧不感知底层。 */
export interface StateStore {
  /** 读取快照；文件不存在返回 null；损坏数据抛 Error，禁止静默回退 seed。 */
  load(): PlatformState | null;
  /** 原子写快照：同目录临时文件 + rename 覆盖，目标绝不半写。 */
  save(state: PlatformState): void;
  /** append-only 追加命令；commandId 去重；appliedSeq 每次从日志真实 max 递增。 */
  appendCommand(
    commandId: string,
    kind: string,
    payload: unknown,
  ): { accepted: boolean; duplicate: boolean; reason?: string };
  /** 按 appliedSeq 升序返回合法命令；跳过损坏/缺字段行；纯读，不改写日志。 */
  replayCommands(): CommandRecord[];
  /** 日志中最后一条合法记录的 appliedSeq；日志不存在或全损坏返回 0。 */
  lastAppliedSeq(): number;
}

export interface FileStateStoreOptions {
  statePath: string;
  logPath: string;
}
