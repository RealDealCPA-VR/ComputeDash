import type { SparkConfig, SparkRole } from "../api/types";

export type AddStep = 0 | 1 | 2;

export type AddSparkDraft = Omit<SparkConfig, "id">;

/**
 * Why the Connect step cannot advance, or null when it can. A stable code rather than text, so the
 * dialog translates it (devices.json `addValidation.*`) and this stays a pure, testable function.
 */
export type ConnectIssue = "lanIpRequired" | "passwordRequired";

/** Why the Role step cannot advance, or null when it can. */
export type RoleIssue = "nameRequired";

export function validateConnect(config: AddSparkDraft): ConnectIssue | null {
  if (!config.isLocal && !config.lanIp.trim()) return "lanIpRequired";
  if (!config.isLocal && config.ssh.auth === "pass" && !config.ssh.password) return "passwordRequired";
  return null;
}

export function validateRole(config: AddSparkDraft): RoleIssue | null {
  return config.name.trim() ? null : "nameRequired";
}

/** Whether the "Next" / "Add" button for `step` should be enabled. */
export function canAdvance(step: AddStep, config: AddSparkDraft): boolean {
  if (step === 0) return validateConnect(config) === null;
  if (step === 1) return validateRole(config) === null;
  return validateConnect(config) === null && validateRole(config) === null;
}

/** Role patch that keeps role, workerNode and llmMonitoring consistent. */
export function rolePatch(role: SparkRole): Partial<AddSparkDraft> {
  return { role, workerNode: role === "worker", llmMonitoring: role !== "worker" };
}

/** Comma-separated LLM ports -> valid ports only (1-65535, integers). */
export function parsePorts(text: string): number[] {
  return text
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}

export function slugifyId(name: string, now: number = Date.now()): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `spark-${now}`;
}

/** localStorage key for the SSH user of the last unit added successfully. */
export const LAST_SSH_USER_KEY = "sparkdashLastSshUser";

/** The SSH user remembered from the last successful add, or "" (storage can throw or be empty). */
export function readLastSshUser(): string {
  try {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_SSH_USER_KEY) : null;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** Remember the SSH user of a unit that was just added (ignored when storage is unavailable). */
export function rememberSshUser(user: string): void {
  const value = user.trim();
  if (!value) return;
  try {
    localStorage.setItem(LAST_SSH_USER_KEY, value);
  } catch {
    /* storage unavailable: the next dialog starts empty */
  }
}
