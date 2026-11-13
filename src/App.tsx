import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  appStatus,
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
  type Account,
  type AppStatus,
  type QuotaFeature,
  type QuotaView,
} from './api';
import './App.css';

type Filter = '全部' | 'desktop' | 'cli';
type Method = 'current' | 'cli' | 'login';

const METHODS: { id: Method; title: string; desc: string }[] = [
  { id: 'current', title: '导入当前登录', desc: '读取 ~/.pencil/session-desktop.json' },
  { id: 'cli', title: '从 CLI 会话导入', desc: '读取 ~/.pencil/session-cli.json' },
  { id: 'login', title: '登录一个新账号', desc: '用邮箱验证码登录 pen.dev，成功后加入列表' },
];

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
  const [method, setMethod] = useState<Method>('current');
  const [alias, setAlias] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [menu, setMenu] = useState('');
  const [sync, setSync] = useState('尚未同步');
  const [loading, setLoading] = useState(true);
  const [quotas, setQuotas] = useState<Record<string, QuotaView>>({});
  const dialog = useRef<HTMLDialogElement>(null);
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

  const refresh = useCallback(async () => {
    try {
      const [list, statusView, live] = await Promise.all([
        listAccounts(),
        appStatus(),
        currentAccount(),
      ]);
      setAccounts(list);
      void loadQuotas(list);
      setStatus(statusView);
      setOnline(live);
      setSync('刚刚同步');
      // 先出本地结果，再异步做服务端复核，避免启动被网络拖住。
      void verifySessions()
        .then((verified) => {
          setAccounts(verified);
          setSync('刚刚校对');
          void loadQuotas(verified);
        })
        .catch(() => {
          /* 离线时保留本地状态 */
        });
    } catch (err) {
      setToast(messageOf(err));
    } finally {
      setLoading(false);
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

  function closeModal() {
    setModal(false);
    setError('');
  }

  function openModal() {
    setAlias('');
    setMethod('current');
    setError('');
    setLoginEmail('');
    setLoginCode('');
    setCodeSent(false);
    setModal(true);
  }

  async function handleSwitch(account: Account) {
    if (isDesktop && status?.penRunning) {
      const confirmed = confirm('切换会先退出 pen.dev，写入会话后自动重新打开。继续？');
      if (!confirmed) return;
    }
    setBusy(account.id);
    try {
      const report = await switchAccount(account.id, true);
      await refresh();
      const detail = report.warnings.length ? ` · ${report.warnings.join(' · ')}` : '';
      setToast(
        report.penRestarted
          ? `已切换并重启 pen.dev：${report.switchedTo}${detail}`
          : `已切换到 ${report.switchedTo}${detail}`,
      );
    } catch (err) {
      setToast(messageOf(err));
    } finally {
      setBusy('');
    }
  }

  async function handleImport(event: FormEvent) {
    event.preventDefault();
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

  async function handleRename(account: Account) {
    setMenu('');
    const next = prompt('账号备注', account.alias);
    if (next === null) return;
    try {
      await saveAlias(account.id, next);
      await refresh();
    } catch (err) {
      setToast(messageOf(err));
    }
  }

  async function handleRemove(account: Account) {
    setMenu('');
    if (!confirm(`从列表移除 ${account.email}？`)) return;
    try {
      await removeAccount(account.id);
      await refresh();
      setToast('账号已移除');
    } catch (err) {
      setToast(messageOf(err));
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
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-icon">↗</span> pen.dev <span className="brand-sub">switch</span>
        </div>
        <button className="nav active">♙ <span>账号</span></button>
        <div className="sidebar-bottom">
          <span className="dot" /> {isDesktop ? '本地后端模式' : '浏览器演示数据'}
          <small>
            v{status?.backendVersion ?? '0.1.0'} · Tauri
            {status ? (status.penRunning ? ' · pen 运行中' : ' · pen 未运行') : ''}
          </small>
          <button className="icon" onClick={() => void handleExport()} title="导出诊断日志">
            导出诊断
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
            ↻
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
                    onClick={() => void handleSwitch(account)}
                  >
                    {busy === account.id ? '◌' : '▶'}
                  </button>
                  <div className="menu-wrap">
                    <button
                      className="icon"
                      aria-label={`管理 ${account.email}`}
                      onClick={() => setMenu(menu === account.id ? '' : account.id)}
                    >
                      ⋮
                    </button>
                    {menu === account.id && (
                      <div className="menu">
                        <button onClick={() => void handleRename(account)}>修改备注</button>
                        <button
                          disabled={account.isCurrent}
                          onClick={() => void handleRemove(account)}
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
                ? '用邮箱验证码登录 pen.dev，成功后加入本机列表。'
                : '从本机已登录的会话导入，账号资料只保存在这台电脑。'}
            </p>
          </div>
          <button className="icon" aria-label="关闭" onClick={closeModal}>
            ×
          </button>
        </div>
        <form onSubmit={handleImport}>
          <div className="dialog-body">
            <div className="mock-note">
              LOCAL{' '}
              <span>
                {method === 'login'
                  ? '验证码只用于向 pen.dev 换取会话，不会保存密码。'
                  : '不会读取密码或验证码，只复制现有会话文件里的邮箱与 token。'}
              </span>
            </div>
            {METHODS.map((item) => (
              <label className={'option ' + (method === item.id ? 'chosen' : '')} key={item.id}>
                <input
                  type="radio"
                  name="method"
                  value={item.id}
                  checked={method === item.id}
                  onChange={() => {
                    setMethod(item.id);
                    setError('');
                  }}
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.desc}</small>
                </span>
              </label>
            ))}
            {method === 'login' && (
              <>
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
              </>
            )}
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
            <small>token 保存在系统凭据管理器</small>
            <button type="button" onClick={closeModal}>
              取消
            </button>
            <button className="primary" type="submit" disabled={busy === 'add' || busy === 'login'}>
              {busy === 'login'
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
