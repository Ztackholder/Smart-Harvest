import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createApi, restoreSession, signIn, signOut, updatePassword } from './api'
import { WorkspacePage } from './pages'
import {
  accounts, initialPeriod, isSimulation, isValidPeriod, periodDates, periodPattern, shiftPeriod, weekLabel,
  type Account, type Catalog, type Role,
} from './contracts'
import { Button, Chip, Field, Modal, Symbol, type SymbolName, value } from './ui'
import { simulationCatalog } from './simulation'
import { emptyCatalog, type FarmFocus, type Page, type Workspace } from './workspace'

type NavItem = { page: Page; label: string; short: string; icon: SymbolName }

function navForAccount(account: Account): NavItem[] {
  if (account.role === 'COORDINATOR') {
    return [
      { page: 'ringkasan', label: 'Ringkasan', short: 'Ringkasan', icon: 'square.grid.2x2' },
      { page: 'kebun', label: 'Kebun', short: 'Kebun', icon: 'sprout' },
      { page: 'rencana', label: 'Rencana Panen', short: 'Rencana', icon: 'list.bullet.clipboard' },
      { page: 'pemantauan', label: 'Pemantauan', short: 'Sensor', icon: 'antenna.radiowaves.left.and.right' },
      { page: 'alokasi-realisasi', label: 'Alokasi & Realisasi', short: 'Alokasi', icon: 'shippingbox' },
      { page: 'riwayat-evaluasi', label: 'Riwayat & Evaluasi', short: 'Riwayat', icon: 'history' },
    ]
  }
  if (account.role === 'FARMER') {
    return [
      { page: 'kebun-saya', label: 'Kebun Saya', short: 'Kebun', icon: 'sprout' },
      { page: 'estimasi', label: 'Estimasi Panen', short: 'Estimasi', icon: 'list.bullet.clipboard' },
      { page: 'pemantauan', label: 'Pemantauan', short: 'Sensor', icon: 'antenna.radiowaves.left.and.right' },
      { page: 'riwayat-petani', label: 'Riwayat', short: 'Riwayat', icon: 'history' },
    ]
  }
  return [
    { page: 'paket-saya', label: 'Paket Saya', short: 'Paket Saya', icon: 'basket' },
    { page: 'pembaruan', label: 'Pembaruan', short: 'Pembaruan', icon: 'arrow.triangle.2.circlepath' },
    { page: 'riwayat-anggota', label: 'Riwayat', short: 'Riwayat', icon: 'history' },
  ]
}

const pageMeta: Record<Page, { title: string; subtitle: (period: string) => string }> = {
  ringkasan: { title: 'Ringkasan minggu ini', subtitle: p => weekLabel(p) },
  kebun: { title: 'Kebun mitra', subtitle: () => 'Kondisi kebun dan perkiraan panen mingguan' },
  'detail-kebun': { title: 'Detail kebun', subtitle: p => weekLabel(p) },
  rencana: { title: 'Rencana panen mingguan', subtitle: p => `${weekLabel(p)} · Tentukan sayuran dan jumlah yang ditawarkan` },
  pemantauan: { title: 'Pemantauan kebun', subtitle: p => weekLabel(p) },
  'alokasi-realisasi': { title: 'Alokasi & realisasi', subtitle: p => weekLabel(p) },
  'riwayat-evaluasi': { title: 'Riwayat & evaluasi', subtitle: p => `${weekLabel(p)} · Ringkasan siklus layanan` },
  'kebun-saya': { title: 'Kebun saya', subtitle: p => `Panen ${weekLabel(p).toLowerCase()}` },
  estimasi: { title: 'Estimasi panen', subtitle: p => weekLabel(p) },
  'riwayat-petani': { title: 'Riwayat kebun', subtitle: p => weekLabel(p) },
  'paket-saya': { title: 'Paket Saya', subtitle: () => 'CSA Tani Sauyunan' },
  pilihan: { title: 'Pilih sayuran', subtitle: p => periodDates(p) },
  pembaruan: { title: 'Pembaruan paket', subtitle: p => periodDates(p) },
  'riwayat-anggota': { title: 'Riwayat & ulasan', subtitle: () => 'Paket mingguan Anda' },
}

const legacyHashRedirect: Record<string, Page> = {
  prediksi: 'rencana',
  ketersediaan: 'rencana',
  panen: 'alokasi-realisasi',
  observasi: 'kebun-saya',
  sayuran: 'paket-saya',
  alokasi: 'pembaruan',
  'umpan-balik': 'riwayat-anggota',
}

function roleLabel(role: Role) {
  if (role === 'COORDINATOR') return 'Koordinator'
  if (role === 'FARMER') return 'Petani Mitra'
  return 'CSA Tani Sauyunan'
}

function AccountForm({ account, onSave }: { account: Account | null; onSave: (account: Account) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (isSimulation) return <div className="account-list">
    <p>Pilih peran untuk mencoba alur dengan data simulasi.</p>
    {accounts.map(option => <button type="button" key={option.memberId ?? option.role}
      className="account-option" onClick={() => onSave(option)}>
      <span><strong>{option.name}</strong>
        {option.role === 'MEMBER' && <small>{option.canSelect ? 'Paket Pilih (2 kg)' : 'Paket Reguler'}</small>}
      </span>
      {account === option ? <Chip tone="good">Aktif</Chip> : <Symbol name="chevron.right" />}
    </button>)}
  </div>
  return <form className="form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    void signIn(value(data, 'username'), value(data, 'password'))
      .then(onSave)
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Tidak dapat masuk. Coba lagi.'))
      .finally(() => setBusy(false))
  }}>
    <Field label="Nama pengguna" name="username" required autoComplete="username" />
    <Field label="Kata sandi" name="password" type="password" required autoComplete="current-password" />
    {error && <p className="field-error" role="alert">{error}</p>}
    <Button type="submit" disabled={busy}>{busy ? 'Memproses…' : 'Masuk'}</Button>
  </form>
}

function PasswordForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  return <form className="form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setError('')
    void updatePassword(value(data, 'current_password'), value(data, 'new_password'), account.csrfToken ?? '')
      .then(() => setSaved(true))
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Kata sandi tidak dapat diperbarui.'))
  }}>
    <Field label="Kata sandi saat ini" name="current_password" type="password" required autoComplete="current-password" />
    <Field label="Kata sandi baru" name="new_password" type="password" required minLength={16} maxLength={256}
      autoComplete="new-password" hint="Gunakan minimal 16 karakter." />
    {error && <p className="field-error" role="alert">{error}</p>}
    {saved ? <><p role="status">Kata sandi diperbarui. Masuk kembali dengan kata sandi baru.</p><Button onClick={onDone}>Selesai</Button></>
      : <Button type="submit">Perbarui kata sandi</Button>}
  </form>
}

function PeriodForm({ period, availablePeriods, onSave }: {
  period: string; availablePeriods: string[]; onSave: (period: string) => void
}) {
  const [draft, setDraft] = useState(period)
  const previous = shiftPeriod(draft, -1)
  const next = shiftPeriod(draft, 1)
  const options = [...new Set([draft, ...availablePeriods, initialPeriod])].filter(isValidPeriod).sort().reverse()
  return <form className="form" onSubmit={event => {
    event.preventDefault()
    onSave(draft)
  }}>
    <div className="period-stepper" role="group" aria-label="Geser minggu layanan">
      <Button variant="secondary" icon="chevron.left" aria-label="Minggu sebelumnya"
        disabled={!isValidPeriod(previous)} onClick={() => setDraft(previous)} />
      <output className="period-range" aria-live="polite">
        {weekLabel(draft)} · {periodDates(draft, true)}
      </output>
      <Button variant="secondary" icon="chevron.right" aria-label="Minggu berikutnya"
        disabled={!isValidPeriod(next)} onClick={() => setDraft(next)} />
    </div>
    <Field label="Pilih minggu layanan">
      <select value={draft} onChange={e => setDraft(e.target.value)}>
        {options.map(p => <option key={p} value={p}>{weekLabel(p)} ({periodDates(p, true)})</option>)}
      </select>
    </Field>
    <Button type="submit">Terapkan periode</Button>
  </form>
}

function WorkspaceView({ account, onAccount, onExit, period, setPeriod }: {
  account: Account; onAccount: (account: Account) => void; onExit: () => void
  period: string; setPeriod: (period: string) => void
}) {
  const [hash, setHash] = useState(window.location.hash.slice(1))
  const [focus, setFocus] = useState<FarmFocus>()
  const [revision, setRevision] = useState(0)
  const [catalog, setCatalog] = useState<Catalog>(() => isSimulation ? simulationCatalog : emptyCatalog)
  const [dialog, setDialog] = useState<'account' | 'period'>()
  const nav = useMemo(() => navForAccount(account), [account])
  const normalizedHash = legacyHashRedirect[hash] ?? hash
  const validPages = new Set<Page>([
    ...nav.map(n => n.page),
    ...(account.role === 'COORDINATOR' ? ['detail-kebun' as const] : []),
    ...(account.role === 'MEMBER' && account.canSelect ? ['pilihan' as const] : []),
  ])
  const page: Page = validPages.has(normalizedHash as Page) ? (normalizedHash as Page) : nav[0].page
  const main = useRef<HTMLElement>(null)
  const api = useMemo(() => createApi(account), [account])

  const go = useCallback((target: Page, nextFocus?: FarmFocus) => {
    if (nextFocus) setFocus(nextFocus)
    window.location.hash = target
    setHash(target)
  }, [])
  const refresh = useCallback(() => setRevision(n => n + 1), [])

  useEffect(() => {
    const onHash = () => setHash(window.location.hash.slice(1))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    let active = true
    api.catalog().then(data => { if (active) setCatalog(data) }).catch(() => undefined)
    return () => { active = false }
  }, [api])

  const work: Workspace = { account, api, period, catalog, revision, refresh, go, focus, onAuthExpired: onExit }
  const meta = pageMeta[page]
  const showDemoBadge = isSimulation || catalog.farms.some(f => f.synthetic)
  const availablePeriods = catalog.periods.length ? catalog.periods : [period]

  // Member mobile-first layout (09-paket-saya-pilih.png & 10-paket-saya-reguler.png)
  if (account.role === 'MEMBER') {
    return <div className="member-shell">
      <a href="#konten" className="skip-link">Lewati ke konten</a>
      <header className="member-header">
        <div className="member-header-inner">
          <div>
            <span className="member-brand">SmartHarvest</span>
            <h1>{meta.title}</h1>
            <span className="member-sub">CSA Tani Sauyunan</span>
          </div>
          <div className="member-header-actions">
            {showDemoBadge && <Chip tone="warn">Mode demo</Chip>}
            <button type="button" className="period-pill period-pill--dark" onClick={() => setDialog('period')}>
              {periodDates(period, true)}
            </button>
            <button type="button" className="icon-btn" aria-label="Akun" onClick={() => setDialog('account')}>
              <Symbol name="person.crop.circle" />
            </button>
          </div>
        </div>
      </header>
      <main id="konten" ref={main} className="member-main" tabIndex={-1}>
        <WorkspacePage key={`${page}:${period}`} page={page} work={work} />
      </main>
      <nav className="member-bottom-nav" aria-label="Navigasi anggota">
        {nav.map(item => {
          const active = item.page === page || (item.page === 'paket-saya' && page === 'pilihan')
          return <a key={item.page} href={`#${item.page}`}
            aria-current={active ? 'page' : undefined}
            onClick={e => { e.preventDefault(); go(item.page) }}>
            <Symbol name={item.icon} />
            <span>{item.short}</span>
          </a>
        })}
      </nav>
      {dialog === 'period' && <Modal title="Pilih periode" onClose={() => setDialog(undefined)}>
        <PeriodForm period={period} availablePeriods={availablePeriods} onSave={p => { setPeriod(p); setDialog(undefined) }} />
      </Modal>}
      {dialog === 'account' && <Modal title={isSimulation ? 'Ganti peran' : 'Akun'} onClose={() => setDialog(undefined)}>
        {isSimulation ? <AccountForm account={account} onSave={next => { setDialog(undefined); onAccount(next) }} /> : <>
          <p>{account.username} · {account.name}</p>
          <PasswordForm account={account} onDone={onExit} />
          <Button variant="text" onClick={onExit}>Keluar</Button>
        </>}
      </Modal>}
    </div>
  }

  // Coordinator & Farmer persistent sidebar layout (00–08 references)
  return <div className="app-shell">
    <a href="#konten" className="skip-link">Lewati ke konten</a>
    <aside className="sidebar" aria-label="Navigasi utama">
      <div className="sidebar-brand">
        <strong>SmartHarvest</strong>
        <span>{roleLabel(account.role)}</span>
      </div>
      <nav className="sidebar-nav">
        {nav.map(item => {
          const active = item.page === page || (item.page === 'kebun' && page === 'detail-kebun')
          return <a key={item.page} href={`#${item.page}`} aria-current={active ? 'page' : undefined}
            onClick={e => { e.preventDefault(); go(item.page) }}>
            {item.label}
          </a>
        })}
      </nav>
      <div className="sidebar-footer">
        <button type="button" className="sidebar-account" onClick={() => setDialog('account')}>
          <span>{account.username ?? account.name}</span>
          <small>Akun & kata sandi</small>
        </button>
        <button type="button" className="sidebar-logout" onClick={onExit}>Keluar</button>
      </div>
    </aside>

    <div className="workspace-area">
      <header className="workspace-header">
        <div>
          <h1 tabIndex={-1}>{meta.title}</h1>
          <p className="muted-meta">{meta.subtitle(period)}</p>
        </div>
        <div className="toolbar-group">
          {showDemoBadge && <Chip tone="warn">Mode demo</Chip>}
          <button type="button" className="period-pill" aria-haspopup="dialog" onClick={() => setDialog('period')}>
            {periodDates(period, true)}
          </button>
        </div>
      </header>
      <main id="konten" ref={main} className="workspace-main" tabIndex={-1}>
        <WorkspacePage key={`${page}:${period}:${focus?.farmId ?? ''}:${focus?.cropId ?? ''}`} page={page} work={work} />
      </main>
    </div>

    <nav className="mobile-bottom-nav" aria-label="Navigasi mobile">
      {nav.map(item => {
        const active = item.page === page || (item.page === 'kebun' && page === 'detail-kebun')
        return <a key={item.page} href={`#${item.page}`} aria-current={active ? 'page' : undefined}
          onClick={e => { e.preventDefault(); go(item.page) }}>
          <Symbol name={item.icon} />
          <span>{item.short}</span>
        </a>
      })}
    </nav>

    {dialog === 'period' && <Modal title="Pilih periode" onClose={() => setDialog(undefined)}>
      <PeriodForm period={period} availablePeriods={availablePeriods} onSave={p => { setPeriod(p); setDialog(undefined) }} />
    </Modal>}
    {dialog === 'account' && <Modal title={isSimulation ? 'Ganti peran' : 'Akun'} onClose={() => setDialog(undefined)}>
      {isSimulation ? <AccountForm account={account} onSave={next => { setDialog(undefined); onAccount(next) }} /> : <>
        <p>{account.username} · {account.name}</p>
        <PasswordForm account={account} onDone={onExit} />
        <Button variant="text" onClick={onExit}>Keluar</Button>
      </>}
    </Modal>}
  </div>
}

export function App() {
  const [period, setPeriod] = useState(initialPeriod)
  const [authLoading, setAuthLoading] = useState(!isSimulation)
  const [session, setSession] = useState<{ account: Account | null; key: number }>({
    account: isSimulation ? accounts[0] : null,
    key: 0,
  })
  useEffect(() => {
    if (isSimulation) return
    let active = true
    void restoreSession()
      .then(account => { if (active) setSession(cur => ({ account, key: cur.key + 1 })) })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthLoading(false) })
    return () => { active = false }
  }, [])
  const start = (account: Account) => {
    const first = navForAccount(account)[0].page
    if (session.account?.role !== account.role) window.location.hash = first
    setSession(cur => ({ account, key: cur.key + 1 }))
  }
  const exit = () => {
    const token = session.account?.csrfToken
    if (!isSimulation && token) {
      void signOut(token).catch(() => undefined).finally(() => setSession(cur => ({ account: null, key: cur.key + 1 })))
    } else {
      setSession(cur => ({ account: null, key: cur.key + 1 }))
    }
  }

  if (session.account) {
    return <WorkspaceView key={session.key} account={session.account} onAccount={start} period={period} setPeriod={setPeriod} onExit={exit} />
  }
  if (authLoading) return <main className="connect"><div className="login-brand"><strong>SmartHarvest</strong><span>CSA Tani Sauyunan</span></div><p role="status">Memeriksa sesi…</p></main>
  return <main className="connect">
    <div className="login-brand"><strong>SmartHarvest</strong><span>CSA Tani Sauyunan</span></div>
    <div className="card">
      <h1 className="login-title">Masuk ke SmartHarvest</h1>
      <p className="muted-meta">Gunakan nama pengguna dan kata sandi akun Anda.</p>
      <AccountForm onSave={start} account={null} />
    </div>
  </main>
}
