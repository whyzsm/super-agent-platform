import { DANGER_COMMAND_RULES, REDACTION_RULES } from './rules';

/**
 * 策略求值引擎（S2-9）：对 rules.ts 的声明式规则集求值。
 *
 * 与收敛前（stateMachine.ts 内联实现）行为逐位一致：
 * - 危险命令按规则数组顺序求值，首条命中即返回，`{dangerous, rule, reason}` 形状不变；
 * - 脱敏逐规则串行替换，replacement 中的 $1/$2 捕获组保留，hitCount 累计每次替换。
 */

export interface DangerousCommandVerdict {
  dangerous: boolean;
  rule?: string;
  reason?: string;
}

export function detectDangerousCommand(command: string): DangerousCommandVerdict {
  for (const rule of DANGER_COMMAND_RULES) {
    if (rule.regex.test(command)) {
      return {
        dangerous: true,
        rule: rule.code,
        reason: rule.reason,
      };
    }
  }
  return { dangerous: false };
}

export function redactSecrets(rawLog: string): {
  redacted: string;
  hitCount: number;
} {
  let hitCount = 0;
  let result = rawLog;

  for (const { regex, replacement } of REDACTION_RULES) {
    result = result.replace(regex, (...args) => {
      hitCount += 1;
      // Preserve capture groups when replacement references $1/$2
      let out = replacement;
      if (args.length > 3) {
        out = out.replace(/\$1/g, String(args[1] ?? '')).replace(/\$2/g, String(args[2] ?? ''));
      }
      return out;
    });
  }

  return { redacted: result, hitCount };
}
