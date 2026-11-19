import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowRight, Copy, Download, EllipsisVertical, Info, LockKeyhole, LogIn, Minus, PanelLeft, PenTool, Play, RefreshCw, ScanLine, Settings as SettingsIcon, Square, Terminal, Users, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  appStatus,
  cancelWatch,
  checkUpdates,
  currentAccount,
  exportDiagnostics,
  getQuota,
  importAccount,
  isDesktop,
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
import './Settings.css';
import { localeFromStorage, translate, type Locale, type Translate, type TranslationKey } from './i18n';

type Filter = 'all' | 'desktop' | 'cli';
type Method = 'current' | 'cli' | 'login';
type LoginMode = 'watch' | 'code';
type Tab = 'accounts' | 'settings';

const WATCH_TIMEOUT_MS = 180_000;
const UPDATE_SKIP_KEY = 'pen-switch.update.skipped';
const UPDATE_CHECKED_KEY = 'pen-switch.update.checkedAt';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const METHODS: { id: Method; title: TranslationKey; desc: TranslationKey }[] = [
  { id: 'current', title: 'importCurrentTitle', desc: 'importCurrentDescription' },
  { id: 'login', title: 'loginNewTitle', desc: 'loginNewDescription' },
  { id: 'cli', title: 'importCliTitle', desc: 'importCliDescription' },
];

function WindowTitleBar({ t }: { t: Translate }) {
  const [maximized, setMaximized] = useState(false);
  const dragStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isDesktop) return;

    const currentWindow = getCurrentWindow();
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const syncMaximized = () => {
      void currentWindow.isMaximized().then((value) => {
        if (mounted) setMaximized(value);
      }).catch(() => undefined);
    };

    syncMaximized();
    void currentWindow.onResized(syncMaximized).then((stopListening) => {
      if (mounted) unlisten = stopListening;
      else stopListening();
    }).catch(() => undefined);

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  if (!isDesktop) return null;

  const minimize = () => void getCurrentWindow().minimize().catch(() => undefined);
  const toggleMaximize = async () => {
    const currentWindow = getCurrentWindow();
    try {
      await currentWindow.toggleMaximize();
      setMaximized(await currentWindow.isMaximized());
    } catch {
      // The native window may reject controls while closing.
    }
  };
  const close = () => void getCurrentWindow().close().catch(() => undefined);

  return (
    <header className="window-titlebar">
      <div
        className="window-titlebar-drag"
        onPointerDown={(event) => {
          dragStart.current = event.button === 0
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null;
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (!start || start.pointerId !== event.pointerId) return;
          if (!(event.buttons & 1)) {
            dragStart.current = null;
            return;
          }
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;

          dragStart.current = null;
          void getCurrentWindow().startDragging().catch(() => undefined);
        }}
        onPointerUp={() => {
          dragStart.current = null;
        }}
        onPointerCancel={() => {
          dragStart.current = null;
        }}
      >
        <PenTool size={15} aria-hidden="true" />
        <span>{t('windowTitle')}</span>
      </div>
      <div className="window-controls">
        <button type="button" className="window-control" title={t('minimizeWindow')} aria-label={t('minimizeWindow')} onClick={minimize}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="window-control" title={maximized ? t('restoreWindow') : t('maximizeWindow')} aria-label={maximized ? t('restoreWindow') : t('maximizeWindow')} onClick={() => void toggleMaximize()}>
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
        </button>
        <button type="button" className="window-control window-control-close" title={t('closeWindow')} aria-label={t('closeWindow')} onClick={close}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function WatchTimer({ t }: { t: Translate }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedText = clock(elapsed);
  return <span className="elapsed" aria-label={t('timerAria', { time: elapsedText })}>{elapsedText}</span>;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function qty(value: number | string | undefined, t: Translate): string {
  if (value === undefined) return '—';
  if (value === 'unlimited') return t('unlimited');
  if (typeof value === 'number') return value.toLocaleString('en-US');
  return value;
}

function featureOf(view: QuotaView | undefined, key: string): QuotaFeature | undefined {
  return view?.quota?.features.find((feature) => feature.key === key);
}

function quotaNote(view: QuotaView | undefined, locale: Locale, t: Translate): string {
  if (view?.quota?.resetsAt) {
    const date = new Date(view.quota.resetsAt).toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
    });
    const localizedDate = locale === 'en-US'
      ? new Date(view.quota.resetsAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
      : date;
    return t('quotaPeriod', { date: localizedDate });
  }
  return view?.reason ?? t('quotaUnknown');
}

function quotaCell(label: string, feature: QuotaFeature | undefined, note: string, t: Translate) {
  const limit = feature?.limit;
  const unlimited = limit === 'unlimited';
  const usd = feature?.unit === 'USD';
  const prefix = usd ? '$' : '';
  const value = !feature
    ? '—'
      : unlimited
        ? t('unlimited')
        : `${prefix}${qty(feature.used, t)} / ${prefix}${qty(limit as number | string | undefined, t)}`;
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
  const [filter, setFilter] = useState<Filter>('all');
  const [modal, setModal] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<Account | null>(null);
  const [switchError, setSwitchError] = useState('');
  const [accountAction, setAccountAction] = useState<{ kind: 'rename' | 'remove'; account: Account } | null>(null);
  const [actionAlias, setActionAlias] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [locale, setLocale] = useState<Locale>(localeFromStorage);
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
  const [skippedVersion, setSkippedVersion] = useState<string | null>(() =>
    localStorage.getItem(UPDATE_SKIP_KEY),
  );
  const [menu, setMenu] = useState('');
  const [sync, setSync] = useState<TranslationKey>('syncNever');
  const [loading, setLoading] = useState(true);
  const [quotas, setQuotas] = useState<Record<string, QuotaView>>({});
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const quotaSequence = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const switchDialog = useRef<HTMLDialogElement>(null);
  const actionDialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const t = useCallback<Translate>((key, values) => translate(locale, key, values), [locale]);

  useEffect(() => {
    localStorage.setItem('pen-switch.locale', locale);
    const title = translate(locale, 'windowTitle');
    document.title = title;
    if ('__TAURI_INTERNALS__' in window) {
      void getCurrentWindow().setTitle(title).catch(() => undefined);
    }
  }, [locale]);

  const loadQuotas = useCallback(async (list: Account[], force = false) => {
    const sequence = ++quotaSequence.current;
    setLoadingQuotas(true);
    const targets = list.filter((account) => account.hasToken);
    const entries = await Promise.all(
      targets.map(async (account) => {
        try {
          return [account.id, await getQuota(account.id, force)] as const;
        } catch {
          return [
            account.id,
            { status: 'unavailable', reason: t('quotaFailed'), quota: null } as QuotaView,
          ] as const;
        }
      }),
    );
    if (sequence !== quotaSequence.current) return;
    setQuotas(Object.fromEntries(entries));
    setLoadingQuotas(false);
    if (force) {
      const count = entries.filter(([, view]) => view.status === 'ok').length;
      setToast(t('quotaRefreshResult', { count, total: entries.length }));
    }
  }, [t]);

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
      setSync('syncNow');
      // 先出本地结果，再异步做服务端复核，避免启动被网络拖住。
      void verifySessions()
        .then((verified) => {
          if (sequence !== refreshSequence.current) return;
          setAccounts(verified);
          setSync('syncVerified');
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

  const runUpdateCheck = useCallback(async (manual: boolean) => {
    if (manual) {
      setCheckingUpdates(true);
      setUpdateError('');
    }
    try {
      const info = await checkUpdates();
      setUpdateInfo(info);
      if (manual) setSkippedVersion(null);
      localStorage.setItem(UPDATE_CHECKED_KEY, String(Date.now()));
    } catch (err) {
      // 启动时的静默检查不打扰用户，只有手动检查才显示错误。
      if (manual) setUpdateError(messageOf(err));
    } finally {
      if (manual) setCheckingUpdates(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const last = Number(localStorage.getItem(UPDATE_CHECKED_KEY) ?? 0);
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
    const timer = setTimeout(() => void runUpdateCheck(false), 1500);
    return () => clearTimeout(timer);
  }, [runUpdateCheck]);

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
      setToast(`${t(report.penRestarted ? 'switchedRestarted' : 'switched', { email: report.switchedTo })}${detail}`);
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
        setError(t('missingCurrentAccount'));
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
      setToast(t('savedAndReturned', { email: account.email, original: original.email }));
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
        setError(t('invalidEmail'));
        return;
      }
      if (!codeSent) {
        await sendLoginCode();
        return;
      }
      if (!loginCode.trim()) {
        setError(t('enterCode'));
        return;
      }
      setBusy('login');
      setError('');
      try {
        const account = await loginWithCode(loginEmail.trim(), loginCode.trim());
        if (alias.trim()) await saveAlias(account.id, alias.trim());
        closeModal();
        await refresh();
        setToast(t('addedAccount', { email: account.email }));
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
      setToast(t('importedAccount', { email: account.email }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function sendLoginCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.trim())) {
      setError(t('invalidEmail'));
      return;
    }
    setBusy('login');
    setError('');
    try {
      await requestLoginCode(loginEmail.trim());
      setCodeSent(true);
      setToast(t('codeSent', { email: loginEmail.trim() }));
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
        setToast(t('renamed'));
      } else {
        await removeAccount(account.id);
        setToast(t('removedAccount'));
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
      setToast(t('importedAccount', { email: account.email }));
    } catch (err) {
      setToast(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function handleCheckUpdates() {
    if (checkingUpdates) return;
    setUpdateInfo(null);
    await runUpdateCheck(true);
  }

  async function openRelease() {
    const url = updateInfo?.releaseUrl;
    if (!url) {
      setToast(t('updateUnavailable'));
      return;
    }
    try {
      await openUrl(url);
    } catch (err) {
      setToast(messageOf(err));
    }
  }

  function skipUpdate() {
    if (!updateInfo?.latestVersion) return;
    localStorage.setItem(UPDATE_SKIP_KEY, updateInfo.latestVersion);
    setSkippedVersion(updateInfo.latestVersion);
  }

  async function handleExport() {
    try {
      const path = await exportDiagnostics();
      setToast(t('exportSuccess', { path }));
    } catch (err) {
      setToast(messageOf(err));
    }
  }

  async function handleRefresh() {
    setBusy('sync');
    await refresh();
    setBusy('');
    setToast(t('refreshSuccess'));
  }

  const liveEmail = status?.liveEmail ?? null;
  const unknownLive =
    liveEmail && !accounts.some((account) => account.email.toLowerCase() === liveEmail.toLowerCase())
      ? liveEmail
      : null;

  const stateText = (account: Account) =>
    account.sessionState === 'ok'
      ? account.isCurrent
        ? t('currentLogin')
        : t('available')
      : account.sessionState === 'needs_reimport'
        ? t('needsReimport')
        : t('unknown');

  const selected = accounts.find((account) => account.isCurrent) ?? null;
  const divergent = Boolean(selected && selected.email !== online?.email);

  const visible =
    filter === 'all' ? accounts : accounts.filter((account) => account.source === filter);
  const countOf = (value: Filter) =>
    value === 'all' ? accounts.length : accounts.filter((a) => a.source === value).length;

  return (
    <div className="app-window">
      <WindowTitleBar t={t} />
      <div className={'shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
      <aside>
        <div className="brand">
          <PenTool className="brand-mark" size={16} aria-hidden="true" />
          <span className="brand-name">pen.dev</span>
          <button className="brand-collapse" type="button"
            aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}>
            <PanelLeft size={15} aria-hidden="true" />
          </button>
        </div>
        <nav className="app-nav" aria-label={t('settings')}>
          <button className={'nav' + (tab === 'accounts' ? ' active' : '')} aria-current={tab === 'accounts' ? 'page' : undefined} onClick={() => setTab('accounts')}>
            <Users size={15} aria-hidden="true" /> <span>{t('accounts')}</span>
          </button>
          <button className={'nav' + (tab === 'settings' ? ' active' : '')} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>
            <SettingsIcon size={15} aria-hidden="true" /> <span>{t('settings')}</span>
          </button>
        </nav>
      </aside>

      <main>
        {tab !== 'settings' ? <>
        <header>
          <div>
            <h1>{t('accounts')}</h1>
            <p>{t('appDescription')}</p>
          </div>
          <button className="primary" ref={addButton} onClick={openModal}>
            ＋ {t('addAccount')}
          </button>
        </header>

        <div className="mock-note">
          {t('local')} <span>{t('localNote')}</span>
        </div>

        {unknownLive && (
          <div className="mock-note">
            NEW <span>{t('newAccount', { email: unknownLive })}</span>
            <button className="primary" disabled={!!busy} onClick={() => void handleQuickImport()}>
              {t('import')}
            </button>
          </div>
        )}

        <section className="current">
          <span className="dot" />
          <span>{t('currentLogin')}</span>
          <strong>{online?.email ?? liveEmail ?? t('notImported')}</strong>
          <span className="badge">
            {online ? (quotas[online.id]?.quota?.plan ?? t('unknownPlan')) : liveEmail ? t('notImported') : '—'}
          </span>
          <span className="current-usage">
            {online
              ? `${t('sourcePrefix')}: ${t(online.source === 'desktop' ? 'desktopSession' : 'cliSession')}`
              : liveEmail
                ? t('notInList')
                : '—'}
          </span>
          {divergent && selected && (
            <small title={t('appSelectedNotWritten')}>
              {t('selectedAccount', { email: selected.email })}
            </small>
          )}
          <button
            className={busy === 'sync' ? 'spinning icon' : 'icon'}
            title={t('refreshSession')}
            disabled={!!busy}
            onClick={handleRefresh}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </section>

        <div className="filters">
          <div className="segments">
            {(['all', 'desktop', 'cli'] as Filter[]).map((value) => (
              <button
                key={value}
                className={filter === value ? 'selected' : ''}
                onClick={() => setFilter(value)}
              >
                {t(value === 'all' ? 'all' : value === 'desktop' ? 'desktopSession' : 'cliSession')}
                <span>{countOf(value)}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <small>{t(sync)}</small>
            <button type="button" className="icon" title={t('refreshQuotas')} aria-label={t('refreshQuotas')}
              disabled={loading || loadingQuotas || !accounts.some((account) => account.hasToken)}
              onClick={() => void loadQuotas(accounts, true)}>
              <RefreshCw size={15} className={loadingQuotas ? 'spinning' : undefined} aria-hidden="true" />
            </button>
          </div>
        </div>

        <section className="accounts" aria-label={t('accountList')}>
          {loading && <div className="empty">{t('loadingAccounts')}</div>}
          {!loading && accounts.length === 0 && (
            <div className="empty">{t('emptyAccounts')}</div>
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
                    <span className="badge">{quotas[account.id]?.quota?.plan ?? account.plan ?? t('unknownPlan')}</span>
                  </div>
                  <small>
                    {account.alias || (account.hasToken ? t('sessionSaved') : t('needsReimport'))}
                    {' · '}
                    {t(account.source === 'desktop' ? 'desktopSession' : 'cliSession')}
                    {account.lastVerifiedAt
                      ? ` · ${t('verifiedAt')} ${new Date(account.lastVerifiedAt).toLocaleTimeString(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`
                      : ''}
                  </small>
                </div>
                <div className="quotas">
                  {quotaCell(
                    t('quotaAgentDays'),
                    featureOf(quotas[account.id], 'mcp_usage_days'),
                    quotaNote(quotas[account.id], locale, t), t,
                  )}
                  {quotaCell(
                    t('quotaImages'),
                    featureOf(quotas[account.id], 'image_generations'),
                    quotaNote(quotas[account.id], locale, t), t,
                  )}
                  {quotaCell(
                    t('quotaHosted'),
                    featureOf(quotas[account.id], 'pen_inference_budget_usd'),
                    quotaNote(quotas[account.id], locale, t), t,
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
                          ? t('currentAccountMatches')
                          : t('sessionVerified')
                        : account.sessionState === 'needs_reimport'
                          ? account.revoked
                            ? t('sessionRevoked')
                            : t('sessionMissing')
                          : t('sessionUnverified')
                    }
                  >
                    ● {stateText(account)}
                  </span>
                  <button
                    className="play"
                    aria-label={t('switchTo', { email: account.email })}
                    title={account.isCurrent ? t('currentLogin') : t('switchAccount')}
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
                      aria-label={t('manageAccount', { email: account.email })}
                      onClick={() => setMenu(menu === account.id ? '' : account.id)}
                    >
                      <EllipsisVertical size={15} aria-hidden="true" />
                    </button>
                    {menu === account.id && (
                      <div className="menu">
                        <button onClick={() => openAccountAction('rename', account)}>{t('rename')}</button>
                        <button
                          disabled={account.isCurrent}
                          onClick={() => openAccountAction('remove', account)}
                        >
                          {t('remove')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
          {!loading && accounts.length > 0 && visible.length === 0 && (
            <div className="empty">{t('noFilteredAccounts')}</div>
          )}
          <footer>
            ⓘ {t('quotaFooter')}
          </footer>
        </section>
        </> : (
          <section className="settings-page" aria-labelledby="settings-title">
            <header>
              <div>
                <h1 id="settings-title">{t('settings')}</h1>
                <p>{t('settingsDescription')}</p>
              </div>
            </header>
            <section className="settings-section">
              <div className="settings-copy">
                <h2>{t('language')}</h2>
                <p>{t('languageDescription')}</p>
              </div>
              <label className="language-select">
                <span className="visually-hidden">{t('language')}</span>
                <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                  <option value="zh-CN">{t('chinese')}</option>
                  <option value="en-US">{t('english')}</option>
                </select>
              </label>
            </section>
            <section className="settings-section">
              <div className="settings-copy">
                <h2>{t('version')}</h2>
                <p>{t('currentVersion')}</p>
              </div>
              <span className="settings-value">{t('versionValue', { version: status?.backendVersion ?? '0.1.0' })}</span>
            </section>
            <section className="settings-section">
              <div className="settings-copy">
                <h2>{t('updates')}</h2>
                <p>{t('updatesDescription')}</p>
                {updateInfo && !updateInfo.updateAvailable && (
                  <small className="settings-feedback" role="status">{t('updateUpToDate', { version: updateInfo.currentVersion })}</small>
                )}
                {updateInfo?.updateAvailable && updateInfo.latestVersion && updateInfo.latestVersion !== skippedVersion && (
                  <div className="settings-update" role="status">
                    <span>{t('updateAvailable', { version: updateInfo.latestVersion })}</span>
                    {updateInfo.releaseUrl && <button type="button" className="link" onClick={() => void openRelease()}>{t('releasePage')}</button>}
                    <button type="button" className="link" onClick={skipUpdate}>{t('skip')}</button>
                  </div>
                )}
                {updateError && <small className="settings-feedback update-error" role="alert">{t('updateError', { error: updateError })}</small>}
              </div>
              <button className="settings-action" type="button" onClick={() => void handleCheckUpdates()} disabled={checkingUpdates}>
                <RefreshCw size={15} className={checkingUpdates ? 'spinning' : undefined} aria-hidden="true" />
                {checkingUpdates ? t('checking') : t('updateCheck')}
              </button>
            </section>
            <section className="settings-section">
              <div className="settings-copy">
                <h2>{t('diagnostics')}</h2>
                <p>{t('diagnosticsDescription')}</p>
              </div>
              <button className="settings-action" type="button" onClick={() => void handleExport()}>
                <Download size={15} aria-hidden="true" />
                {t('exportDiagnostics')}
              </button>
            </section>
          </section>
        )}
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
              <span className="switch-eyebrow">{t('accountManagement')}</span>
              <h2 id="account-action-title">{accountAction?.kind === 'rename' ? t('editAccountNote') : t('removeAccountTitle')}</h2>
              <p>{accountAction?.kind === 'rename' ? t('editAccountDescription') : t('removeAccountDescription')}</p>
            </div>
            <button type="button" className="icon" aria-label={t('close')} onClick={closeAccountAction} disabled={actionBusy}><X size={16} aria-hidden="true" /></button>
          </div>
          <div className="account-action-body">
            <div className="action-account" title={accountAction?.account.email}>{accountAction?.account.email}</div>
            {accountAction?.kind === 'rename' ? (
              <label className="field" htmlFor="account-alias">{t('note')}
                <input id="account-alias" value={actionAlias} maxLength={60} autoFocus
                  placeholder={t('exampleBackup')} onChange={(event) => setActionAlias(event.target.value)} disabled={actionBusy} />
              </label>
            ) : (
              <div className="switch-notice"><Info size={16} aria-hidden="true" />
                <span>{t('removeAccountWarning')}</span>
              </div>
            )}
            {actionError && <p className="switch-error" role="alert">{actionError}</p>}
          </div>
          <div className="switch-dialog-footer">
            <button type="button" onClick={closeAccountAction} disabled={actionBusy}>{t('cancel')}</button>
            <button type="submit" className={accountAction?.kind === 'remove' ? 'destructive' : 'primary'} disabled={actionBusy}>
              {actionBusy ? t('processing') : accountAction?.kind === 'rename' ? t('saveNote') : t('remove')}
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
            <span className="switch-eyebrow">{t('switchAccount')}</span>
            <h2 id="switch-dialog-title">{t('switchTitle')}</h2>
            <p>{t('switchDescription')}</p>
          </div>
          <button type="button" className="icon" aria-label={t('close')} onClick={closeSwitchDialog} disabled={!!busy}><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="switch-dialog-body">
          <div className="switch-route">
            <div className="switch-identity">
              <span className="switch-caption">{t('currentAccount')}</span>
              <strong title={online?.email ?? status?.liveEmail ?? undefined}>{online?.email ?? status?.liveEmail ?? t('notImported')}</strong>
            </div>
            <ArrowRight size={18} className="switch-arrow" aria-hidden="true" />
            <div className="switch-identity target">
              <span className="switch-caption">{t('targetAccount')}</span>
              <strong title={switchTarget?.email}>{switchTarget?.email}</strong>
            </div>
          </div>
          <div className="switch-notice">
            <Info size={16} aria-hidden="true" />
            <span>{status?.penRunning
              ? t('switchRunningWarning')
              : t('switchStoppedWarning')}
              <br />{t('quotaNotReset')}</span>
          </div>
          {switchError && <p className="switch-error" role="alert">{t('switchFailed', { error: switchError })}</p>}
        </div>
        <div className="switch-dialog-footer">
          <button type="button" onClick={closeSwitchDialog} disabled={!!busy}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={!!busy || !switchTarget}
            onClick={() => switchTarget && void handleSwitch(switchTarget)}>
            {busy ? t('switching') : t('confirmSwitch')}
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
            <h2>{t('addAccountTitle')}</h2>
            <p>
              {method === 'login'
                ? t('addLoginDescription')
                : t('addImportDescription')}
            </p>
          </div>
          <button className="icon" aria-label={t('close')} onClick={closeModal}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleImport}>
          <div className="dialog-body">
            <div className="mock-note">
              LOCAL{' '}
              <span>
                {method === 'login'
                  ? t('localLoginNote')
                  : t('localImportNote')}
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
                    {t(item.title)}
                    {item.id === 'login' && <em className="recommended">{t('recommended')}</em>}
                  </strong>
                  <small>{t(item.desc)}</small>
                </span>
              </label>
            {item.id === 'login' && method === 'login' && loginMode === 'watch' && (
              <div className="watch-flow">
                <ol className="watch-steps">
                  <li className={watchOrigin || online ? 'done' : ''}>
                    {watchOrigin || online || liveEmail
                      ? t('watchSavedCurrent', { email: watchOrigin?.email ?? online?.email ?? liveEmail ?? '' })
                      : t('watchNoCurrent')}
                  </li>
                  <li>{t('watchStepLogin')}</li>
                  <li className={watchResult ? 'done' : ''}>{t('watchStepFinish')}</li>
                </ol>
                <div className="watching-bar" role={watching ? 'status' : undefined}>
                  <span className={watching ? 'pulse' : 'idle-dot'} />
                  <span className="watching-label">
                    {watching ? t('watchingSession') : t('waitingForLogin')}
                  </span>
                  {watching ? <WatchTimer t={t} /> : <span className="elapsed">0:00</span>}
                  {watching && <button type="button" onClick={stopWatch}>{t('cancelWatch')}</button>}
                </div>
                {watchTimedOut && (
                  <p className="error" role="alert">
                    {t('watchTimeout', { time: clock(Math.floor(WATCH_TIMEOUT_MS / 1000)) })}
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
                  {t('useEmailCode')}
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
                  {t('useAutoCapture')}
                </button>
                <label className="field">
                  {t('email')}
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(event) => {
                      setLoginEmail(event.target.value);
                      setCodeSent(false);
                    }}
                    placeholder={t('emailPlaceholder')}
                    autoFocus
                  />
                </label>
                {codeSent && (
                  <label className="field">
                    {t('verificationCode')}
                    <input
                      value={loginCode}
                      onChange={(event) => setLoginCode(event.target.value)}
                      placeholder={t('codePlaceholder')}
                      autoFocus
                    />
                  </label>
                )}
                {codeSent && (
                  <button type="button" onClick={() => void sendLoginCode()} disabled={busy === 'login'}>
                    {t('resendCode')}
                  </button>
                )}
              </div>
            )}
            {item.id === 'cli' && (
              <div className="cli-command">
                <code>pen login</code>
                <button type="button" title={t('copyCommand')} aria-label={t('copyCommand')}
                  onClick={() => void navigator.clipboard.writeText('pen login').then(() => setToast(t('copiedCommand'))).catch(() => setToast(t('copyFailed')))}>
                  <Copy size={13} />
                </button>
              </div>
            )}
              </div>
            ))}
            <label className="field">
              {t('note')} <small>{t('optional')}</small>
              <input
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                maxLength={60}
                placeholder={t('exampleBackupAlias')}
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
            <small className="security-note"><LockKeyhole size={12} /> {t('secureToken')}</small>
            <button type="button" onClick={closeModal}>
              {t('cancel')}
            </button>
            <button className="primary" type="submit" disabled={busy === 'add' || busy === 'login' || watching}>
              {method === 'login' && loginMode === 'watch'
                ? watching
                  ? t('waitingLogin')
                  : watchTimedOut
                    ? t('retryWatch')
                    : t('beginWatch')
                : busy === 'login'
                  ? t('loggingIn')
                  : method === 'login'
                    ? codeSent
                      ? t('login')
                      : t('sendCode')
                    : busy === 'add'
                      ? t('importing')
                      : t('importAccount')}
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
    </div>
  );
}

export default App;
