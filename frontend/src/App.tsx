import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createApi } from './api'
import { WorkspacePage } from './pages'
import { accounts, initialPeriod, isSimulation, isValidPeriod, periodDates, periodPattern, shiftPeriod, type Account, type Estimate, type Prediction, type Role } from './contracts'
import { Button, Chip, Field, Heading, Modal, Symbol, type SymbolName, value } from './ui'
import { emptyActivity, readSimulation, type Activity } from './simulation'
import type { Page, Workspace } from './workspace'

const navigation: Record<Role, { page: Page; label: string; short: string; icon: SymbolName }[]> = {
  COORDINATOR: [
    { page: 'ringkasan', label: 'Ringkasan', short: 'Ringkasan', icon: 'square.grid.2x2' },
    { page: 'prediksi', label: 'Prediksi panen', short: 'Prediksi', icon: 'chart.line.uptrend.xyaxis' },
    { page: 'ketersediaan', label: 'Ketersediaan', short: 'Pasokan', icon: 'basket' },
    { page: 'panen', label: 'Panen aktual', short: 'Aktual', icon: 'shippingbox' },
  ],
  FARMER: [
    { page: 'observasi', label: 'Observasi kebun', short: 'Observasi', icon: 'leaf' },
    { page: 'estimasi', label: 'Estimasi panen', short: 'Estimasi', icon: 'list.bullet.clipboard' },
  ],
  MEMBER: [
    { page: 'sayuran', label: 'Sayuran tersedia', short: 'Sayuran', icon: 'basket' },
    { page: 'alokasi', label: 'Pembaruan alokasi', short: 'Alokasi', icon: 'arrow.triangle.2.circlepath' },
    { page: 'umpan-balik', label: 'Umpan balik', short: 'Umpan balik', icon: 'bubble.left' },
  ],
}

const brand = <div className="brand">
  <strong>SmartHarvest</strong>
  <span>CSA Tani Sauyunan</span>
</div>

function AccountForm({ account, onSave }: { account: Account | null; onSave: (account: Account) => void }) {
  const [selected, setSelected] = useState(account?.role ?? 'COORDINATOR')
  if (isSimulation) return <div className="account-list">
    <p>Pilih peran untuk mencoba alur dengan data simulasi.</p>
    {accounts.map(option => <button type="button" key={option.memberId ?? option.role}
      className="account-option" onClick={() => onSave(option)}>
      <span><strong>{option.name}</strong>
        {option.role === 'MEMBER' && <small>{option.canSelect ? 'Paket Pilih (2 kg)' : 'Paket reguler'}</small>}
      </span>
      {account === option ? <Chip tone="good">Aktif</Chip> : <Symbol name="chevron.right" />}
    </button>)}
  </div>
  return <form className="form" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const token = value(data, 'token')
    if (!token) return
    onSave({
      role: selected, name: accounts.find(option => option.role === selected)!.name, token,
      canSelect: selected === 'MEMBER' && data.get('can_select') === 'on',
    })
  }}>
    <Field label="Peran akun">
      <select value={selected} onChange={event => setSelected(event.target.value as Role)}>
        <option value="COORDINATOR">Koordinator</option>
        <option value="FARMER">Petani mitra</option>
        <option value="MEMBER">Anggota CSA</option>
      </select>
    </Field>
    <Field label="Token Bearer" name="token" type="password" required autoComplete="off"
      pattern="[^\s]+" hint="Gunakan token yang diberikan tim backend." />
    {selected === 'MEMBER' && <label className="check-label"><input name="can_select" type="checkbox" defaultChecked={account?.canSelect} /> Akun ini memiliki Paket Pilih</label>}
    <Button type="submit">Buka ruang kerja</Button>
  </form>
}

function PeriodForm({ period, onSave }: { period: string; onSave: (period: string) => void }) {
  const [draft, setDraft] = useState(period)
  const [error, setError] = useState('')
  const selected = draft.trim()
  const valid = isValidPeriod(selected)
  const previous = shiftPeriod(valid ? selected : period, -1)
  const next = shiftPeriod(valid ? selected : period, 1)
  const updateDraft = (target: string) => {
    setDraft(target.toUpperCase())
    setError('')
  }
  return <form className="form" onSubmit={event => {
    event.preventDefault()
    if (!valid) {
      setError('Minggu ISO tidak tersedia pada tahun tersebut.')
      return
    }
    onSave(selected)
  }}>
    <div className="period-stepper" role="group" aria-label="Geser minggu layanan">
      <Button variant="secondary" icon="chevron.left" aria-label="Minggu sebelumnya"
        disabled={!isValidPeriod(previous)} onClick={() => updateDraft(previous)} />
      <output className="period-range" aria-live="polite">{valid ? periodDates(selected) : 'Minggu belum valid'}</output>
      <Button variant="secondary" icon="chevron.right" aria-label="Minggu berikutnya"
        disabled={!isValidPeriod(next)} onClick={() => updateDraft(next)} />
    </div>
    <Field label="Minggu layanan (ISO)" name="period" placeholder="2026-W46" value={draft}
      pattern={periodPattern} required aria-invalid={error ? true : undefined}
      aria-describedby={error ? 'period-error' : undefined} onChange={event => updateDraft(event.target.value)} />
    {error && <p id="period-error" role="alert" className="field-error">{error}</p>}
    <Button type="submit">Terapkan periode</Button>
  </form>
}

function WorkspaceView({ account, onAccount, onExit, period, setPeriod }: {
  account: Account; onAccount: (account: Account) => void; onExit: () => void
  period: string; setPeriod: (period: string) => void
}) {
  const [hash, setHash] = useState(window.location.hash.slice(1))
  const [revision, setRevision] = useState(0)
  const [activity, setActivity] = useState<Activity>(() => isSimulation ? readSimulation() : emptyActivity)
  const [dialog, setDialog] = useState<'account' | 'period'>()
  const [proposal, setProposal] = useState<Prediction | Estimate>()
  const [predictionId, setPredictionId] = useState<string>()
  const nav = navigation[account.role]
  const page = nav.find(item => item.page === hash)?.page ?? nav[0].page
  const main = useRef<HTMLElement>(null)
  const previousPage = useRef(page)
  const api = useMemo(() => createApi(account), [account])
  const go = useCallback((target: Page) => { window.location.hash = target; setHash(target) }, [])
  const openPrediction = useCallback((id?: string) => { setPredictionId(id); go('prediksi') }, [go])
  const propose = (basis: Prediction | Estimate) => {
    setProposal(basis)
    if ('target_period' in basis) setPeriod(basis.target_period)
    else setPeriod(basis.harvest_period)
    go('ketersediaan')
  }
  const refresh = useCallback(() => {
    setRevision(value => value + 1)
    if (isSimulation) setActivity(readSimulation())
  }, [])
  const remember = useCallback(<K extends keyof Activity>(key: K, row: Activity[K][number]) => {
    if (isSimulation) { refresh(); return }
    const ids = { observations: 'observation_id', predictions: 'prediction_id', estimates: 'estimate_id',
      risks: 'prediction_id', approvals: 'availability_id', actuals: 'actual_harvest_id' } as const
    const rowId = (entry: Activity[K][number]) => (entry as unknown as Record<string, string>)[ids[key]]
    setActivity(current => ({ ...current, [key]: [row, ...current[key].filter(entry => rowId(entry) !== rowId(row))] }))
    if (key === 'approvals') refresh()
  }, [refresh])
  const work: Workspace = { account, api, period, activity, revision, refresh, remember, go, proposal, propose, predictionId, openPrediction }

  useEffect(() => {
    const receiveHash = () => setHash(window.location.hash.slice(1))
    window.addEventListener('hashchange', receiveHash)
    return () => window.removeEventListener('hashchange', receiveHash)
  }, [])
  useEffect(() => {
    if (page === previousPage.current) return
    previousPage.current = page
    window.scrollTo(0, 0)
    main.current?.querySelector('h1')?.focus({ preventScroll: true })
  }, [page])
  useEffect(() => {
    if (!isSimulation) return
    const sync = (event: StorageEvent) => { if (event.key === 'smartharvest.simulation.v1' || !event.key) refresh() }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [refresh])

  const navLinks = (compact = false) => nav.map(item => <a key={item.page} href={`#${item.page}`}
    aria-current={item.page === page ? 'page' : undefined}
    onClick={() => { if (item.page === 'ketersediaan' && page !== 'ketersediaan') setProposal(undefined) }}>
    <Symbol name={item.icon} />{compact ? item.short : item.label}
  </a>)

  return <div className="shell">
    <a href="#konten" className="skip-link" onClick={event => { event.preventDefault(); main.current?.focus() }}>Lewati ke konten</a>
    <header>
      <div className="masthead">
        <div className="masthead-inner">
          {brand}
          <nav className="desktop-nav" aria-label="Navigasi utama">{navLinks()}</nav>
          <Button variant="secondary" className="account-trigger" icon="person.crop.circle" aria-haspopup="dialog"
            onClick={() => setDialog('account')}>{account.name}<Symbol name="chevron.down" /></Button>
        </div>
      </div>
      <div className="workspace-strip">
        <div className="workspace-strip-inner">
          <Button className="period-trigger" variant="text" icon="calendar" aria-haspopup="dialog"
            aria-label={`Ubah periode ${period}`} onClick={() => setDialog('period')}><span>Periode</span> <strong>{period}</strong></Button>
          {isSimulation && <span className="simulation-label">Data simulasi</span>}
        </div>
      </div>
    </header>
    <main id="konten" ref={main} className="main" tabIndex={-1}><WorkspacePage key={`${page}:${period}`} page={page} work={work} /></main>
    <nav className="mobile-nav" aria-label="Navigasi utama">{navLinks(true)}</nav>
    {dialog === 'period' && <Modal title="Pilih periode" onClose={() => setDialog(undefined)}>
      <PeriodForm period={period} onSave={target => {
        if (target !== period) {
          setPeriod(target)
          setProposal(undefined)
          setPredictionId(undefined)
        }
        setDialog(undefined)
      }} />
    </Modal>}
    {dialog === 'account' && <Modal title={isSimulation ? 'Ganti peran' : 'Akun REST API'} onClose={() => setDialog(undefined)}>
      <AccountForm account={account} onSave={next => {
        setDialog(undefined)
        if (next !== account) onAccount(next)
      }} />
      {!isSimulation && <Button variant="text" onClick={onExit}>Keluar dari sesi</Button>}
    </Modal>}
  </div>
}

export function App() {
  const [period, setPeriod] = useState(initialPeriod)
  const [session, setSession] = useState({ account: isSimulation ? accounts[0] : null, key: 0 } as {
    account: Account | null; key: number
  })
  const start = (account: Account) => {
    const previous = session.account
    if (previous?.role !== account.role) window.location.hash = navigation[account.role][0].page
    setSession(current => ({ account, key: current.key + 1 }))
  }

  if (session.account) return <WorkspaceView key={session.key} account={session.account} onAccount={start} period={period} setPeriod={setPeriod}
    onExit={() => setSession(current => ({ account: null, key: current.key + 1 }))} />
  return <main className="connect">
    {brand}
    <Heading title="Hubungkan akun" description="Masuk ke ruang kerja SmartHarvest dengan token REST API." />
    <AccountForm onSave={start} account={null} />
  </main>
}
