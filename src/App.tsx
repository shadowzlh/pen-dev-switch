import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Copy, Download, EllipsisVertical, Info, LockKeyhole, LogIn, PanelLeft, PenTool, Play, RefreshCw, ScanLine, Terminal, Users, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  appStatus,
  cancelWatch,
  checkUpdates,
  currentAccount,
  exportDiagnostics,
  getQuota,
  importAccount,
  loginWithCode,
  requestLoginCode,
  listAccounts,
  removeAccount,
  setAlias as saveAlias,
  switchAccount,
  verifySessions,
  watchNewAccount,
  type Account,
  type AppStatus,
  type QuotaFeature,
  type QuotaView,
  type UpdateInfo,
} from './api';
import './App.css';

type Filter = '全部' | 'desktop' | 'cli';
type Method = 'current' | 'cli' | 'login';
type LoginMode = 'watch' | 'code';

const WATCH_TIMEOUT_MS = 180_000;
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const METHODS: { id: Method; title: string; desc: string }[] = [
  { id: 'current', title: '导入当前登录', desc: '直接保存 pen.dev 现在登录的账号；已在列表中的账号无需重复导入。' },
  { id: 'login', title: '登录一个新账号', desc: '在 pen.dev 退出并登录新账号，工具自动捕获新会话。' },
  { id: 'cli', title: '从 CLI 会话导入', desc: '先在终端运行 pen login，再读取 CLI 会话。' },
];

function WatchTimer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="elapsed" aria-label={`已监听 ${clock(elapsed)}`}>{clock(elapsed)}</span>;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function qty(value: number | string | undefined): string {
  if (value === undefined) return '—';
  if (value === 'unlimited') return '不限';
  if (typeof value === 'number') return value.toLocaleString('en-US');
  return value;
}

function featureOf(view: QuotaView | undefined, key: string): QuotaFeature | undefined {
  return view?.quota?.features.find((feature) => feature.key === key);
}

function quotaNote(view: QuotaView | undefined): string {
  if (view?.quota?.resetsAt) {
    const date = new Date(view.quota.resetsAt).toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
    });
    return `本周期至 ${date}`;
  }
  return view?.reason ?? '额度未知';
}

function quotaCell(label: string, feature: QuotaFeature | undefined, note: string) {
  const limit = feature?.limit;
  const unlimited = limit === 'unlimited';
  const usd = feature?.unit === 'USD';
  const prefix = usd ? '$' : '';
  const value = !feature
    ? '—'
    : unlimited
      ? '不限'
      : `${prefix}${qty(feature.used)} / ${prefix}${qty(limit as number | string | undefined)}`;
  const pct =
    feature && typeof limit === 'number' && limit > 0
      ? Math.min(100, (Number(feature.used) / limit) * 100)
      : 0;

  return (
    <div className="quota" title={feature?.name}>
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <progress className={pct >= 80 ? 'warning' : ''} value={pct} max="100" />
      <small>{note}</small>
    </div>
  );
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [online, setOnline] = useState<Account | null>(null);
  const [filter, setFilter] = useState<Filter>('全部');
  const [modal, setModal] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<Account | null>(null);
  const [switchError, setSwitchError] = useState('');
  const [accountAction, setAccountAction] = useState<{ kind: 'rename' | 'remove'; account: Account } | null>(null);
  const [actionAlias, setActionAlias] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [method, setMethod] = useState<Method>('current');
  const [alias, setAlias] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode>('watch');
  const [watching, setWatching] = useState(false);
  const [watchResult, setWatchResult] = useState<Account | null>(null);
  const [watchTimedOut, setWatchTimedOut] = useState(false);
  const [watchOrigin, setWatchOrigin] = useState<Account | null>(null);
  // 关闭弹窗或取消后忽略过期结果，同时通知后端停止轮询。
  const watchToken = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState('');
  const [menu, setMenu] = useState('');
  const [sync, setSync] = useState('尚未同步');
  const [loading, setLoading] = useState(true);
  const [quotas, setQuotas] = useState<Record<string, QuotaView>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const switchDialog = useRef<HTMLDialogElement>(null);
  const actionDialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const loadQuotas = useCallback(async (list: Account[]) => {
    const targets = list.filter((account) => account.hasToken);
    const entries = await Promise.all(
      targets.map(async (account) => {
        try {
          return [account.id, await getQuota(account.id)] as const;
        } catch {
          return [
            account.id,
            { status: 'unavailable', reason: '额度获取失败', quota: null } as QuotaView,
          ] as const;
        }
      }),
    );
    setQuotas(Object.fromEntries(entries));
  }, []);

  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [list, statusView, live] = await Promise.all([
        listAccounts(),
        appStatus(),
        currentAccount(),
      ]);
      if (sequence !== refreshSequence.current) return;
      setAccounts(list);
      setStatus(statusView);
      setOnline(live);
      setSync('刚刚同步');
      // 先出本地结果，再异步做服务端复核，避免启动被网络拖住。
      void verifySessions()
        .then((verified) => {
          if (sequence !== refreshSequence.current) return;
          setAccounts(verified);
          setSync('刚刚校对');
        })
        .catch(() => {
          /* 离线时保留本地状态 */
        });
      void loadQuotas(list);
    } catch (err) {
      if (sequence === refreshSequence.current) setToast(messageOf(err));
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [loadQuotas]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (modal && !element.open) element.showModal();
    if (!modal && element.open) element.close();
  }, [modal]);

  useEffect(() => {
    const element = switchDialog.current;
    if (!element) return;
    if (switchTarget && !element.open) element.showModal();
    if (!switchTarget && element.open) element.close();
  }, [switchTarget]);

  useEffect(() => {
    const element = actionDialog.current;
    if (!element) return;
    if (accountAction && !element.open) element.showModal();
    if (!accountAction && element.open) element.close();
  }, [accountAction]);

  function closeAccountAction() {
    if (actionBusy) return;
    setAccountAction(null);
    setActionError('');
  }

  function closeSwitchDialog() {
    if (busy) return;
    setSwitchTarget(null);
    setSwitchError('');
  }

  function closeModal() {
    watchToken.current++;
    if (watching) void cancelWatch();
    setWatching(false);
    setModal(false);
    setError('');
  }

  function openModal() {
    setAlias('');
    setMethod('login');
    setError('');
    setLoginEmail('');
    setLoginCode('');
    setCodeSent(false);
    setLoginMode('watch');
    setWatching(false);
    setWatchResult(null);
    setWatchOrigin(null);
    setWatchTimedOut(false);
    setModal(true);
  }

  async function handleSwitch(account: Account) {
    setBusy(account.id);
    setSwitchError('');
    try {
      const report = await switchAccount(account.id, true);
      setSwitchTarget(null);
      await refresh();
      const detail = report.warnings.length ? ` · ${report.warnings.join(' · ')}` : '';
      setToast(
        report.penRestarted
          ? `已切换并重启 pen.dev：${report.switchedTo}${detail}`
          : `已切换到 ${report.switchedTo}${detail}`,
      );
    } catch (err) {
      setSwitchError(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function startWatch() {
    const token = ++watchToken.current;
    setError('');
    setWatchTimedOut(false);
    setWatchResult(null);
    try {
      await cancelWatch();
      if (token !== watchToken.current) return;
      // 第 1 步：确保原账号已在列表里，后面才能切回去。
      let original = online;
      if (!original && liveEmail) original = await importAccount('desktop');
      if (!original) {
        setError('没有检测到当前登录的账号，请先在 pen.dev 登录一次');
        return;
      }
      if (token !== watchToken.current) return;
      setWatchOrigin(original);
      setWatching(true);
      const account = await watchNewAccount(original.email, WATCH_TIMEOUT_MS);
      if (token !== watchToken.current) return;
      setWatching(false);
      if (!account) {
        setWatchTimedOut(true);
        return;
      }
      setWatchResult(account);
      if (alias.trim()) await saveAlias(account.id, alias.trim());
      // 第 3 步：新账号已保存，切回原来的账号。
      await switchAccount(original.id, true);
      closeModal();
      await refresh();
      setToast(`已保存 ${account.email}，并切回 ${original.email}`);
    } catch (err) {
      if (token !== watchToken.current) return;
      setWatching(false);
      setError(messageOf(err));
    }
  }

  function stopWatch() {
    watchToken.current++;
    void cancelWatch();
    setWatching(false);
  }

  async function handleImport(event: FormEvent) {
    event.preventDefault();
    if (method === 'login' && loginMode === 'watch') {
      if (!watching) await startWatch();
      return;
    }
    if (method === 'login') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.trim())) {
        setError('请输入有效的邮箱地址');
        return;
      }
      if (!codeSent) {
        await sendLoginCode();
        return;
      }
      if (!loginCode.trim()) {
        setError('请输入验证码');
        return;
      }
      setBusy('login');
      setError('');
      try {
        const account = await loginWithCode(loginEmail.trim(), loginCode.trim());
        if (alias.trim()) await saveAlias(account.id, alias.trim());
        closeModal();
        await refresh();
        setToast(`已添加 ${account.email}，切换后会使用它登录`);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy('');
      }
      return;
    }
    setBusy('add');
    setError('');
    try {
      const account = await importAccount(method === 'cli' ? 'cli' : 'desktop');
      if (alias.trim()) await saveAlias(account.id, alias.trim());
      closeModal();
      await refresh();
      setToast(`已导入 ${account.email}`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function sendLoginCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.trim())) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setBusy('login');
    setError('');
    try {
      await requestLoginCode(loginEmail.trim());
      setCodeSent(true);
      setToast(`验证码已发送到 ${loginEmail.trim()}`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  function openAccountAction(kind: 'rename' | 'remove', account: Account) {
    setMenu('');
    setActionAlias(account.alias);
    setActionError('');
    setAccountAction({ kind, account });
  }

  async function submitAccountAction(event: FormEvent) {
    event.preventDefault();
    if (!accountAction || actionBusy) return;
    const { kind, account } = accountAction;
    setActionBusy(true);
    setActionError('');
    try {
      if (kind === 'rename') {
        await saveAlias(account.id, actionAlias.trim());
        setToast('备注已保存');
      } else {
        await removeAccount(account.id);
        setToast('账号已移除');
      }
      setAccountAction(null);
      await refresh();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setActionBusy(false);
    }
  }


  async function handleQuickImport() {
    setBusy('sync');
    try {
      const account = await importAccount('desktop');
      await refresh();
      setToast(`已导入 ${account.email}`);
    } catch (err) {
      setToast(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function handleCheckUpdates() {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    setUpdateError('');
    setUpdateInfo(null);
    try {
      setUpdateInfo(await checkUpdates());
    } catch (err) {
      setUpdateError(messageOf(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleExport() {
    try {
      const path = await exportDiagnostics();
      setToast(`诊断已导出：${path}`);
    } catch (err) {
      setToast(messageOf(err));
    }
  }

  async function handleRefresh() {
    setBusy('sync');
    await refresh();
    setBusy('');
    setToast('已重新读取本机会话');
  }

  const liveEmail = status?.liveEmail ?? null;
  const unknownLive =
    liveEmail && !accounts.some((account) => account.email.toLowerCase() === liveEmail.toLowerCase())
      ? liveEmail
      : null;

  const stateText = (account: Account) =>
    account.sessionState === 'ok'
      ? account.isCurrent
        ? '当前登录'
        : '可用'
      : account.sessionState === 'needs_reimport'
        ? '需重新导入'
        : '待确认';

  const selected = accounts.find((account) => account.isCurrent) ?? null;
  const divergent = Boolean(selected && selected.email !== online?.email);

  const visible =
    filter === '全部' ? accounts : accounts.filter((account) => account.source === filter);
  const countOf = (value: Filter) =>
    value === '全部' ? accounts.length : accounts.filter((a) => a.source === value).length;

  return (
    <div className={'shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
      <aside>
        <div className="brand">
          <PenTool className="brand-mark" size={16} aria-hidden="true" />
          <span className="brand-name">pen.dev</span>
          <button className="brand-collapse" type="button"
            aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}>
            <PanelLeft size={15} aria-hidden="true" />
          </button>
        </div>
        <button className="nav active"><Users size={15} aria-hidden="true" /> <span>账号</span></button>
        <div className="sidebar-bottom">
          <small>v{status?.backendVersion ?? '0.1.0'}</small>
          <button className="diagnostics-button" onClick={() => void handleCheckUpdates()} disabled={checkingUpdates}>
            <RefreshCw size={15} className={checkingUpdates ? 'spinning' : undefined} aria-hidden="true" />
            <span>{checkingUpdates ? '正在检查…' : '检查更新'}</span>
          </button>
          {updateInfo && (
            <div className="update-feedback" role="status">
              {updateInfo.updateAvailable ? (
                <>
                  <span>发现新版本 v{updateInfo.latestVersion}</span>
                  {updateInfo.releaseUrl && (
                    <button type="button" onClick={() => void openUrl(updateInfo.releaseUrl!).catch((err: unknown) => setUpdateError(messageOf(err)))}>
                      查看发布页 ↗
                    </button>
                  )}
                </>
              ) : updateInfo.latestVersion ? '已是最新版本' : '暂无正式版本发布'}
            </div>
          )}
          {updateError && <div className="update-feedback update-error" role="alert">{updateError}</div>}
          <button className="diagnostics-button" onClick={() => void handleExport()} title="导出诊断日志">
            <Download size={15} aria-hidden="true" />
            <span>导出诊断日志</span>
          </button>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <h1>账号</h1>
            <p>管理 pen.dev 登录账号，查看额度并快速切换。</p>
          </div>
          <button className="primary" ref={addButton} onClick={openModal}>
            ＋ 添加账号
          </button>
        </header>

        <div className="mock-note">
          LOCAL <span>账号来自本机 pen.dev 会话，token 存入系统凭据管理器（Windows 凭据 / macOS 钥匙串）。</span>
        </div>

        {unknownLive && (
          <div className="mock-note">
            NEW <span>检测到未导入的账号：{unknownLive}</span>
            <button className="primary" disabled={!!busy} onClick={() => void handleQuickImport()}>
              导入
            </button>
          </div>
        )}

        <section className="current">
          <span className="dot" />
          <span>当前登录</span>
          <strong>{online?.email ?? liveEmail ?? '未导入'}</strong>
          <span className="badge">
            {online ? (quotas[online.id]?.quota?.plan ?? '未知') : liveEmail ? '未导入' : '—'}
          </span>
          <span className="current-usage">
            {online
              ? `来源 ${online.source === 'desktop' ? '桌面会话' : 'CLI 会话'}`
              : liveEmail
                ? '尚未导入到列表'
                : '—'}
          </span>
          {divergent && selected && (
            <small title="应用内已选择，但尚未写入 pen.dev 会话文件">
              应用内已选：{selected.email}（未写入）
            </small>
          )}
          <button
            className={busy === 'sync' ? 'spinning icon' : 'icon'}
            title="重新读取本机会话"
            disabled={!!busy}
            onClick={handleRefresh}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </section>

        <div className="filters">
          <div className="segments">
            {(['全部', 'desktop', 'cli'] as Filter[]).map((value) => (
              <button
                key={value}
                className={filter === value ? 'selected' : ''}
                onClick={() => setFilter(value)}
              >
                {value === '全部' ? '全部' : value === 'desktop' ? '桌面会话' : 'CLI 会话'}
                <span>{countOf(value)}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <small>{sync}</small>
          </div>
        </div>

        <section className="accounts" aria-label="账号列表">
          {loading && <div className="empty">正在读取本机账号…</div>}
          {!loading && accounts.length === 0 && (
            <div className="empty">还没有导入账号，点击右上角「添加账号」读取本机会话。</div>
          )}
          {!loading &&
            visible.map((account, index) => (
              <article
                className={'account ' + (account.isCurrent ? 'is-current' : '')}
                key={account.id}
              >
                <div className={'avatar color-' + (index % 4)}>{account.email.slice(0, 1)}</div>
                <div className="identity">
                  <div>
                    <strong title={account.email}>{account.email}</strong>
                    <span className="badge">{quotas[account.id]?.quota?.plan ?? account.plan ?? '未知'}</span>
                  </div>
                  <small>
                    {account.alias || (account.hasToken ? '会话已保存' : '需要重新导入')}
                    {' · '}
                    {account.source === 'desktop' ? '桌面会话' : 'CLI 会话'}
                    {account.lastVerifiedAt
                      ? ` · 确认于 ${new Date(account.lastVerifiedAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`
                      : ''}
                  </small>
                </div>
                <div className="quotas">
                  {quotaCell(
                    'Agent 天数',
                    featureOf(quotas[account.id], 'mcp_usage_days'),
                    quotaNote(quotas[account.id]),
                  )}
                  {quotaCell(
                    '图像 / SVG',
                    featureOf(quotas[account.id], 'image_generations'),
                    quotaNote(quotas[account.id]),
                  )}
                  {quotaCell(
                    '托管模型',
                    featureOf(quotas[account.id], 'pen_inference_budget_usd'),
                    quotaNote(quotas[account.id]),
                  )}
                </div>
                <div className="actions">
                  <span
                    className={
                      'status ' +
                      (account.sessionState === 'ok'
                        ? 'green'
                        : account.sessionState === 'needs_reimport'
                          ? 'amber'
                          : '')
                    }
                    title={
                      account.sessionState === 'ok'
                        ? account.isCurrent
                          ? '与磁盘上的 pen.dev 会话一致，且服务端已确认'
                          : '服务端已确认该会话有效'
                        : account.sessionState === 'needs_reimport'
                          ? account.revoked
                            ? '服务端返回 401，该会话已失效，请重新导入'
                            : '没有可用会话，请重新导入'
                          : '尚未与服务端核对（离线或未检测）'
                    }
                  >
                    ● {stateText(account)}
                  </span>
                  <button
                    className="play"
                    aria-label={`切换到 ${account.email}`}
                    title={account.isCurrent ? '当前登录' : '切换账号'}
                    disabled={
                      !!busy ||
                      account.isCurrent ||
                      !account.hasToken ||
                      account.sessionState === 'needs_reimport'
                    }
                    onClick={() => { setSwitchError(''); setSwitchTarget(account); }}
                  >
                    {busy === account.id ? <RefreshCw size={13} className="spinning" aria-hidden="true" /> : <Play size={12} fill="currentColor" aria-hidden="true" />}
                  </button>
                  <div className="menu-wrap">
                    <button
                      className="icon"
                      aria-label={`管理 ${account.email}`}
                      onClick={() => setMenu(menu === account.id ? '' : account.id)}
                    >
                      <EllipsisVertical size={15} aria-hidden="true" />
                    </button>
                    {menu === account.id && (
                      <div className="menu">
                        <button onClick={() => openAccountAction('rename', account)}>修改备注</button>
                        <button
                          disabled={account.isCurrent}
                          onClick={() => openAccountAction('remove', account)}
                        >
                          移除账号
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
          {!loading && accounts.length > 0 && visible.length === 0 && (
            <div className="empty">暂无该来源的账号</div>
          )}
          <footer>
            ⓘ 切换使用目标账号的独立额度，不会重置原账号的用量。额度与套餐来自 pen.dev 官方接口，缓存 5 分钟。
          </footer>
        </section>
      </main>

      <dialog
        className="account-action-dialog"
        ref={actionDialog}
        aria-labelledby="account-action-title"
        onCancel={(event) => {
          if (actionBusy) event.preventDefault();
          else closeAccountAction();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeAccountAction();
        }}
      >
        <form onSubmit={(event) => void submitAccountAction(event)}>
          <div className="switch-dialog-head">
            <div>
              <span className="switch-eyebrow">账号管理</span>
              <h2 id="account-action-title">{accountAction?.kind === 'rename' ? '修改账号备注' : '移除这个账号？'}</h2>
              <p>{accountAction?.kind === 'rename' ? '给账号一个容易辨认的名字。' : '此操作只移除本工具保存的账号信息。'}</p>
            </div>
            <button type="button" className="icon" aria-label="关闭" onClick={closeAccountAction} disabled={actionBusy}><X size={16} aria-hidden="true" /></button>
          </div>
          <div className="account-action-body">
            <div className="action-account" title={accountAction?.account.email}>{accountAction?.account.email}</div>
            {accountAction?.kind === 'rename' ? (
              <label className="field" htmlFor="account-alias">备注名
                <input id="account-alias" value={actionAlias} maxLength={60} autoFocus
                  placeholder="例如：备用账号" onChange={(event) => setActionAlias(event.target.value)} disabled={actionBusy} />
              </label>
            ) : (
              <div className="switch-notice"><Info size={16} aria-hidden="true" />
                <span>会删除本工具保存的会话凭据和备注，不会注销 pen.dev 账号，也不会清除当前正在使用的 pen.dev 会话。</span>
              </div>
            )}
            {actionError && <p className="switch-error" role="alert">{actionError}</p>}
          </div>
          <div className="switch-dialog-footer">
            <button type="button" onClick={closeAccountAction} disabled={actionBusy}>取消</button>
            <button type="submit" className={accountAction?.kind === 'remove' ? 'destructive' : 'primary'} disabled={actionBusy}>
              {actionBusy ? '处理中…' : accountAction?.kind === 'rename' ? '保存备注' : '移除账号'}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        className="switch-dialog"
        ref={switchDialog}
        aria-labelledby="switch-dialog-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else closeSwitchDialog();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSwitchDialog();
        }}
      >
        <div className="switch-dialog-head">
          <div>
            <span className="switch-eyebrow">切换账号</span>
            <h2 id="switch-dialog-title">确认切换登录账号？</h2>
            <p>将使用目标账号的独立额度继续工作。</p>
          </div>
          <button type="button" className="icon" aria-label="关闭" onClick={closeSwitchDialog} disabled={!!busy}><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="switch-dialog-body">
          <div className="switch-route">
            <div className="switch-identity">
              <span className="switch-caption">当前登录</span>
              <strong title={online?.email ?? status?.liveEmail ?? undefined}>{online?.email ?? status?.liveEmail ?? '未导入'}</strong>
            </div>
            <ArrowRight size={18} className="switch-arrow" aria-hidden="true" />
            <div className="switch-identity target">
              <span className="switch-caption">切换到</span>
              <strong title={switchTarget?.email}>{switchTarget?.email}</strong>
            </div>
          </div>
          <div className="switch-notice">
            <Info size={16} aria-hidden="true" />
            <span>{status?.penRunning
              ? '切换时会先退出 pen.dev，写入目标会话后自动重新打开。请先保存正在进行的工作。'
              : '切换将写入目标账号的会话，并尝试打开 pen.dev。请先保存正在进行的工作。'}
              <br />原账号的额度和用量不会重置。</span>
          </div>
          {switchError && <p className="switch-error" role="alert">切换失败：{switchError}</p>}
        </div>
        <div className="switch-dialog-footer">
          <button type="button" onClick={closeSwitchDialog} disabled={!!busy}>取消</button>
          <button type="button" className="primary" disabled={!!busy || !switchTarget}
            onClick={() => switchTarget && void handleSwitch(switchTarget)}>
            {busy ? '正在切换…' : '确认切换'}
          </button>
        </div>
      </dialog>

      <dialog
        ref={dialog}
        onCancel={closeModal}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeModal();
        }}
      >
        <div className="dialog-head">
          <div>
            <h2>添加 pen.dev 账号</h2>
            <p>
              {method === 'login'
                ? '退出当前账号并用新邮箱登录，工具会自动捕获新会话。'
                : '从本机已登录的会话导入，账号资料只保存在这台电脑。'}
            </p>
          </div>
          <button className="icon" aria-label="关闭" onClick={closeModal}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleImport}>
          <div className="dialog-body">
            <div className="mock-note">
              LOCAL{' '}
              <span>
                {method === 'login'
                  ? '不会读取密码，只在检测到新登录后复制会话文件里的邮箱与 token。'
                  : '不会读取密码或验证码，只复制现有会话文件里的邮箱与 token。'}
              </span>
            </div>
            {METHODS.map((item) => (
              <div className={'method-group ' + (method === item.id ? 'chosen' : '')} key={item.id}>
              <label className="option">
                <input
                  type="radio"
                  name="method"
                  value={item.id}
                  checked={method === item.id}
                  disabled={watching || !!busy}
                  onChange={() => {
                    setMethod(item.id);
                    setError('');
                  }}
                />
                <span>
                  <strong className="method-title">
                    {item.id === 'current' ? <ScanLine size={14} /> : item.id === 'login' ? <LogIn size={14} /> : <Terminal size={14} />}
                    {item.title}
                    {item.id === 'login' && <em className="recommended">推荐</em>}
                  </strong>
                  <small>{item.desc}</small>
                </span>
              </label>
            {item.id === 'login' && method === 'login' && loginMode === 'watch' && (
              <div className="watch-flow">
                <ol className="watch-steps">
                  <li className={watchOrigin || online ? 'done' : ''}>
                    已保存当前账号 {watchOrigin?.email ?? online?.email ?? liveEmail ?? '（待检测）'}
                  </li>
                  <li>退出当前账号，在 pen.dev 里用新邮箱登录（验证码或密码）</li>
                  <li className={watchResult ? 'done' : ''}>检测到新登录后保存，并切回原来的账号</li>
                </ol>
                <div className="watching-bar" role={watching ? 'status' : undefined}>
                  <span className={watching ? 'pulse' : 'idle-dot'} />
                  <span className="watching-label">
                    {watching ? '正在监听 ~/.pencil/session-desktop.json' : '点击开始监听后，等待 pen.dev 登录新账号'}
                  </span>
                  {watching ? <WatchTimer /> : <span className="elapsed">0:00</span>}
                  {watching && <button type="button" onClick={stopWatch}>取消监听</button>}
                </div>
                {watchTimedOut && (
                  <p className="error" role="alert">
                    超过 {clock(Math.floor(WATCH_TIMEOUT_MS / 1000))} 没有检测到新登录，可以重试或改用验证码登录。
                  </p>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={watching}
                  onClick={() => {
                    setLoginMode('code');
                    setError('');
                    setWatchTimedOut(false);
                  }}
                >
                  改用验证码登录
                </button>
              </div>
            )}
            {item.id === 'login' && method === 'login' && loginMode === 'code' && (
              <div className="code-flow">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setLoginMode('watch');
                    setError('');
                  }}
                >
                  改用自动捕获登录
                </button>
                <label className="field">
                  邮箱
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(event) => {
                      setLoginEmail(event.target.value);
                      setCodeSent(false);
                    }}
                    placeholder="name@example.com"
                    autoFocus
                  />
                </label>
                {codeSent && (
                  <label className="field">
                    验证码
                    <input
                      value={loginCode}
                      onChange={(event) => setLoginCode(event.target.value)}
                      placeholder="邮件里的 6 位验证码"
                      autoFocus
                    />
                  </label>
                )}
                {codeSent && (
                  <button type="button" onClick={() => void sendLoginCode()} disabled={busy === 'login'}>
                    重新发送验证码
                  </button>
                )}
              </div>
            )}
            {item.id === 'cli' && (
              <div className="cli-command">
                <code>pen login</code>
                <button type="button" title="复制命令" aria-label="复制 pen login 命令"
                  onClick={() => void navigator.clipboard.writeText('pen login').then(() => setToast('已复制 pen login')).catch(() => setToast('复制失败，请手动复制'))}>
                  <Copy size={13} />
                </button>
              </div>
            )}
              </div>
            ))}
            <label className="field">
              备注名 <small>可选</small>
              <input
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                maxLength={60}
                placeholder="例如：备用账号"
                autoFocus
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <small className="security-note"><LockKeyhole size={12} /> 会话 token 仅保存在本机系统凭据管理器</small>
            <button type="button" onClick={closeModal}>
              取消
            </button>
            <button className="primary" type="submit" disabled={busy === 'add' || busy === 'login' || watching}>
              {method === 'login' && loginMode === 'watch'
                ? watching
                  ? '等待登录…'
                  : watchTimedOut
                    ? '重新监听'
                    : '开始监听'
                : busy === 'login'
                  ? '处理中…'
                  : method === 'login'
                    ? codeSent
                      ? '登录'
                      : '发送验证码'
                    : busy === 'add'
                      ? '导入中…'
                      : '导入账号'}
            </button>
          </div>
        </form>
      </dialog>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
