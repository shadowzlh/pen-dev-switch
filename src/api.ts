import { invoke } from '@tauri-apps/api/core';
import { localeFromStorage, translate } from './i18n';

export type AccountSource = 'desktop' | 'cli';

/** 与 Rust SessionState 对应：只能判断“能否与磁盘会话对上”，不含有效期。 */
export type SessionState = 'ok' | 'unknown' | 'needs_reimport';

/** 与 Rust AccountView 一一对应；plan/额度在拿到真实接口前保持未知。 */
export interface Account {
  id: string;
  email: string;
  alias: string;
  source: AccountSource;
  plan: string | null;
  hasToken: boolean;
  addedAt: number;
  lastSeenAt: number;
  lastVerifiedAt: number | null;
  /** 服务端 `/auth/session-info` 返回 401：会话已被吊销。 */
  revoked: boolean;
  sessionState: SessionState;
  isCurrent: boolean;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

export async function checkUpdates(): Promise<UpdateInfo> {
  if (!isDesktop) {
    throw new Error(translate(localeFromStorage(), 'browserUpdateUnsupported'));
  }
  return call<UpdateInfo>('check_updates');
}

export interface AppStatus {
  penRunning: boolean;
  penExePath: string | null;
  sessionPath: string | null;
  /** 磁盘会话里的邮箱，可能尚未导入到列表。 */
  liveEmail: string | null;
  backendVersion: string;
}

export interface SwitchReport {
  switchedTo: string;
  penRestarted: boolean;
  dryRun: boolean;
  warnings: string[];
}

export interface QuotaFeature {
  key: string;
  name: string;
  unit: string | null;
  used: number | string;
  limit: number | string;
  remaining: number | string;
  binary: boolean;
}

export interface QuotaData {
  plan: string | null;
  billingEnabled: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  resetsAt: string | null;
  features: QuotaFeature[];
}

export interface QuotaView {
  status: 'ok' | 'unavailable';
  reason: string | null;
  quota: QuotaData | null;
}


export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function normalizeError(err: unknown): Error {
  if (typeof err === 'string') return new Error(err);
  if (err && typeof err === 'object' && 'message' in err) {
    return new Error(String((err as { message: unknown }).message));
  }
  return new Error(String(err));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw normalizeError(err);
  }
}

// ---------------------------------------------------------------- 浏览器演示
// `pnpm dev` 直接开浏览器时没有 Tauri IPC，这里提供内存实现，避免白屏。
const demo: { accounts: Account[]; current: string | null } = {
  accounts: [],
  current: null,
};

function demoImport(source: AccountSource): Account {
  const email = source === 'desktop' ? 'demo.desktop@example.com' : 'demo.cli@example.com';
  const existing = demo.accounts.find((a) => a.email === email);
  if (existing) {
    demo.current = existing.id;
    return { ...existing, isCurrent: true };
  }
  const account: Account = {
    id: crypto.randomUUID(),
    email,
    alias: '',
    source,
    plan: null,
    hasToken: true,
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
    lastVerifiedAt: Date.now(),
    revoked: false,
    sessionState: 'ok',
    isCurrent: true,
  };
  demo.accounts.push(account);
  demo.current = account.id;
  return account;
}

function demoView(account: Account): Account {
  const isCurrent = demo.current === account.id;
  return {
    ...account,
    isCurrent,
    sessionState: isCurrent ? 'ok' : 'unknown',
    lastVerifiedAt: isCurrent ? (account.lastVerifiedAt ?? Date.now()) : account.lastVerifiedAt,
  };
}

// ---------------------------------------------------------------- 对外 API
export async function listAccounts(): Promise<Account[]> {
  if (!isDesktop) return demo.accounts.map(demoView);
  return call<Account[]>('account_list');
}

export async function importAccount(source: AccountSource): Promise<Account> {
  if (!isDesktop) return demoView(demoImport(source));
  return call<Account>('account_import', { source });
}

/** 发送邮箱验证码（登录新账号）。 */
export async function requestLoginCode(email: string): Promise<void> {
  if (!isDesktop) throw new Error(translate(localeFromStorage(), 'browserLoginUnsupported'));
  await call<void>('auth_request_code', { email });
}

/** 用验证码登录，成功后账号进入列表。 */
export async function loginWithCode(email: string, code: string): Promise<Account> {
  if (!isDesktop) throw new Error(translate(localeFromStorage(), 'browserLoginUnsupported'));
  return call<Account>('auth_login', { email, code });
}

/**
 * 轮询桌面会话文件，直到出现一个不同于 `excludeEmail` 的新登录并保存。
 * 超时（默认 2 分钟）未检测到新登录时返回 null，不算错误。
 */
export async function watchNewAccount(
  excludeEmail: string,
  timeoutMs = 120_000,
): Promise<Account | null> {
  if (!isDesktop) throw new Error(translate(localeFromStorage(), 'browserWatchUnsupported'));
  return call<Account | null>('account_watch_new', { excludeEmail, timeoutMs });
}

export async function cancelWatch(): Promise<void> {
  if (isDesktop) await call<void>('account_cancel_watch');
}

export async function setAlias(id: string, alias: string): Promise<Account> {
  if (!isDesktop) {
    const account = demo.accounts.find((a) => a.id === id);
    if (!account) throw new Error(translate(localeFromStorage(), 'accountMissing'));
    account.alias = alias;
    return demoView(account);
  }
  return call<Account>('account_set_alias', { id, alias });
}

export async function removeAccount(id: string): Promise<void> {
  if (!isDesktop) {
    if (demo.current === id) throw new Error(translate(localeFromStorage(), 'cannotRemoveCurrent'));
    demo.accounts = demo.accounts.filter((a) => a.id !== id);
    return;
  }
  await call<void>('account_remove', { id });
}

export async function currentAccount(): Promise<Account | null> {
  if (!isDesktop) {
    const account = demo.accounts.find((a) => a.id === demo.current);
    return account ? demoView(account) : null;
  }
  return call<Account | null>('session_current');
}

export async function switchAccount(
  id: string,
  restartPen = true,
  dryRun = false,
): Promise<SwitchReport> {
  if (!isDesktop) {
    const account = demo.accounts.find((a) => a.id === id);
    if (!account) throw new Error(translate(localeFromStorage(), 'accountMissing'));
    demo.current = id;
    return {
      switchedTo: account.email,
      penRestarted: false,
      dryRun: true,
      warnings: ['演示数据：未写入 pen.dev 会话文件。'],
    };
  }
  return call<SwitchReport>('session_switch', { id, restartPen, dryRun });
}

/** 服务端复核所有已保存会话（`/auth/session-info`）；401 会被标记为已吊销。 */
/** 导出诊断文本到 Downloads，返回文件路径。 */
export async function exportDiagnostics(): Promise<string> {
  if (!isDesktop) throw new Error(translate(localeFromStorage(), 'browserExportUnsupported'));
  return call<string>('export_diagnostics');
}

export async function verifySessions(): Promise<Account[]> {
  if (!isDesktop) return listAccounts();
  return call<Account[]>('session_verify');
}

export async function appStatus(): Promise<AppStatus> {
  if (!isDesktop) {
    return {
      penRunning: false,
      penExePath: null,
      sessionPath: null,
      liveEmail: null,
      backendVersion: '0.1.0',
    };
  }
  return call<AppStatus>('app_status');
}

export async function getQuota(id: string, force = false): Promise<QuotaView> {
  if (!isDesktop) {
    return { status: 'unavailable', reason: '演示数据不含额度', quota: null };
  }
  return call<QuotaView>('quota_get', { id, force });
}


