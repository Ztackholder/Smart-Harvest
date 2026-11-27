import { useState } from 'react'
import { cropImage, cropName, dateTime, kg, periodDates } from './contracts'
import { Button, Card, Chip, Empty, Field, Modal, Notice, ProgressBar, Symbol, WhatsAppIcon, useAction, useResource, value } from './ui'
import type { Workspace } from './workspace'

function CropThumb({ cropId, large = false }: { cropId: string; large?: boolean }) {
  const src = cropImage(cropId)
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return <img className={large ? 'crop-card-img' : 'crop-thumb'} src={src} alt={`Ilustrasi ${cropName(cropId)}`} onError={() => setFailed(true)} />
  }
  return <div className={`${large ? 'crop-card-img' : 'crop-thumb'} crop-thumb--fallback`} aria-hidden="true">
    <Symbol name="leaf" />
  </div>
}

/* --- 09 & 10. PAKET SAYA (OVERVIEW) --- */
export function MemberHome({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.memberOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const subAction = useAction()
  const [subModal, setSubModal] = useState(false)
  const [subSaved, setSubSaved] = useState('')
  const data = query.data
  if (query.loading && !data) return <p className="empty" role="status">Memuat informasi paket…</p>

  const member = data?.member
  const eligible = member?.eligible ?? Boolean(work.account.canSelect)
  const quota = member?.quota_kg ?? (eligible ? 2 : 0)
  const nextSub = data?.next_period_subscription ?? null
  const currentPkg = member?.package_name ?? (eligible ? 'Paket Custom' : 'Paket Reguler')
  const altPkg = currentPkg === 'Paket Custom' ? 'Paket Reguler' : 'Paket Custom'
  const availability = data?.availability ?? []
  const selection = data?.selection ?? null
  const step = data?.progress_step ?? 'waiting_publication'

  const steps = eligible
    ? [
        { key: 'published', label: 'Pilihan dibuka' },
        { key: 'selected', label: 'Dikonfirmasi' },
        { key: 'allocated', label: 'Disiapkan' },
        { key: 'received', label: 'Diterima' },
      ]
    : [
        { key: 'published', label: 'Penawaran dibuka' },
        { key: 'selected', label: 'Dijadwalkan' },
        { key: 'allocated', label: 'Disiapkan' },
        { key: 'received', label: 'Diterima' },
      ]

  const stepIndex =
    step === 'feedback_sent' || step === 'received' ? 3 :
    step === 'allocated' ? 2 :
    step === 'selected' ? 1 :
    step === 'published' ? 0 : -1

  const statusText =
    step === 'feedback_sent' || step === 'received' ? 'Paket diterima' :
    step === 'allocated' ? 'Paket sedang disiapkan' :
    step === 'selected' ? 'Pilihan dikonfirmasi' :
    step === 'published' ? (eligible ? 'Pilihan sayuran dibuka' : 'Menunggu penjadwalan koordinator') :
    'Pilihan sayuran minggu ini belum dibuka.'

  const uniqueCrops = [...new Map(availability.map(a => [a.crop_id, a])).values()]

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}

    <div className="subscription-card">
      <div className="row-between">
        <div>
          <span className="kpi-label">Langganan aktif · {member?.name ?? work.account.name}</span>
          <strong className="metric-large">{currentPkg}</strong>
        </div>
        <Button variant="secondary" onClick={() => { setSubSaved(''); setSubModal(true) }}>Ubah paket</Button>
      </div>
      <p>{eligible ? `Pilih sendiri sayuran sesuai kuota langganan Anda (${kg(quota)} kg/minggu).` : 'Isi paket ditentukan oleh pengelola berdasarkan ketersediaan sayuran.'}</p>
      {nextSub && <p className="muted-meta">Periode berikutnya ({periodDates(nextSub.effective_period, true)}): <strong>{nextSub.package_name}</strong></p>}
    </div>
    {subSaved && <Notice tone="good">{subSaved}</Notice>}
    {subModal && <Modal title="Ubah jenis paket periode berikutnya" onClose={() => setSubModal(false)}>
      <form className="stack-tight" onSubmit={subAction.submit(async () => {
        const res = await work.api.post('/member/subscription', {
          period: work.period,
          target_package: altPkg,
        })
        setSubSaved(`Paket periode berikutnya (${periodDates(res.effective_period, true)}) dijadwalkan ke ${res.package_name}.`)
        setSubModal(false)
        work.refresh()
      })}>
        <p className="muted-meta">Perubahan hanya berlaku untuk periode minggu berikutnya. Pilihan dan alokasi periode {periodDates(work.period, true)} tetap dipertahankan.</p>
        <div className="card">
          <strong>Paket saat ini: {currentPkg}</strong>
          <p className="muted-meta">{altPkg === 'Paket Custom' ? 'Paket Custom: Pilih sendiri sayuran sesuai kuota langganan Anda (2 kg/minggu).' : 'Paket Reguler: Isi paket ditentukan oleh pengelola berdasarkan ketersediaan sayuran.'}</p>
        </div>
        {subAction.error && <Notice tone="error">{subAction.error}</Notice>}
        <div className="row-actions">
          <Button variant="secondary" onClick={() => setSubModal(false)}>Batal</Button>
          <Button type="submit" disabled={subAction.pending}>
            {subAction.pending ? 'Menyimpan…' : `Jadwalkan ${altPkg}`}
          </Button>
        </div>
      </form>
    </Modal>}

    <Card title="Status minggu ini" subtitle={periodDates(work.period)}>
      <p className="text-good"><strong>{statusText}</strong></p>
      <ol className="progress-steps progress-steps--4" aria-label="Tahapan paket mingguan">
        {steps.map((s, idx) => {
          const done = stepIndex >= idx
          return <li key={s.key} className={done ? 'progress-step progress-step--done' : 'progress-step'}>
            <span className="progress-dot" aria-hidden="true" />
            <span>{s.label}</span>
          </li>
        })}
      </ol>
    </Card>

    {eligible ? (
      <Card title="Paket minggu ini">
        {selection ? <>
          <ul className="simple-list">
            {selection.items.map(it => {
              const avl = availability.find(a => a.availability_id === it.availability_id)
              return <li key={it.availability_id}>
                <div className="row-between">
                  <strong>{avl ? cropName(avl.crop_id) : 'Sayuran'}</strong>
                  <strong className="tabular">{kg(it.quantity_kg)} kg</strong>
                </div>
              </li>
            })}
          </ul>
          <Button variant="secondary" className="btn-full" onClick={() => work.go('pembaruan')}>Lihat pembaruan paket</Button>
        </> : availability.length ? <>
          <p className="muted-meta">{uniqueCrops.length} jenis sayuran tersedia untuk dipilih minggu ini.</p>
          <Button className="btn-full" onClick={() => work.go('pilihan')}>Pilih sayuran</Button>
        </> : <Empty>Pilihan sayuran minggu ini belum dibuka.</Empty>}
      </Card>
    ) : (
      <section className="stack-tight">
        <div>
          <h2 className="member-section-title">Sayuran minggu ini</h2>
          <p className="muted-meta">Isi paket ditentukan oleh pengelola berdasarkan ketersediaan sayuran.</p>
        </div>
        {!availability.length ? (
          <Card><Empty>Pilihan sayuran minggu ini belum dibuka.</Empty></Card>
        ) : (
          <div className="stack-tight">
            {availability.map(row => (
              <div key={row.availability_id} className="produce-card">
                <div className="produce-info">
                  <CropThumb cropId={row.crop_id} />
                  <div>
                    <strong>{cropName(row.crop_id)}</strong>
                    <span className="muted-meta">
                      {row.own_allocation_kg !== undefined
                        ? `Paket Anda: ${kg(row.own_allocation_kg)} kg`
                        : 'Menunggu pembagian koordinator'}
                    </span>
                  </div>
                </div>
                {row.own_allocation_kg !== undefined && <Chip tone="good">{kg(row.own_allocation_kg)} kg</Chip>}
              </div>
            ))}
            <Button className="btn-full" onClick={() => work.go('pembaruan')}>Lihat pembaruan</Button>
          </div>
        )}
      </section>
    )}
  </div>
}

/* --- PILIH SAYURAN (NESTED IMAGE CATALOG FOR ELIGIBLE MEMBERS) --- */
export function MemberSelectionCatalog({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.memberOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const selectAction = useAction()
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [reviewing, setReviewing] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  const data = query.data
  if (query.loading && !data) return <p className="empty" role="status">Memuat katalog sayuran…</p>

  const member = data?.member
  const eligible = member?.eligible ?? Boolean(work.account.canSelect)
  const quota = member?.quota_kg ?? 2
  const availability = data?.availability ?? []
  const selection = data?.selection ?? null

  if (!eligible) {
    return <Card title="Pilih sayuran">
      <Empty>Paket Reguler: Isi paket ditentukan oleh pengelola berdasarkan ketersediaan sayuran.</Empty>
    </Card>
  }

  const totalSelected = availability.reduce((sum, row) => sum + (amounts[row.availability_id] ?? 0), 0)
  const quotaExceeded = quota > 0 && totalSelected - quota > 1e-6
  const selectedItems = availability
    .filter(row => (amounts[row.availability_id] ?? 0) > 0)
    .map(row => ({ row, qty: amounts[row.availability_id] }))

  const adjustQty = (avlId: string, maxStock: number, delta: number) => {
    setSavedMsg('')
    setAmounts(prev => {
      const current = prev[avlId] ?? 0
      const next = Math.max(0, Math.min(maxStock, Math.round((current + delta) * 100) / 100))
      return { ...prev, [avlId]: next }
    })
  }

  return <div className="stack">
    <div className="breadcrumb-row">
      <Button variant="text" icon="chevron.left" onClick={() => work.go('paket-saya')}>Kembali ke Paket Saya</Button>
    </div>

    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    {savedMsg && <Notice tone="good">{savedMsg}</Notice>}

    {selection ? (
      <Card title="Pilihan Anda sudah tercatat" actions={<Chip tone="good">Dikonfirmasi</Chip>}>
        <ul className="simple-list">
          {selection.items.map(it => {
            const avl = availability.find(a => a.availability_id === it.availability_id)
            return <li key={it.availability_id}>
              <div className="row-between">
                <strong>{avl ? cropName(avl.crop_id) : 'Sayuran'}</strong>
                <strong className="tabular">{kg(it.quantity_kg)} kg</strong>
              </div>
            </li>
          })}
        </ul>
        <p className="muted-meta">Dikirim pada {dateTime(selection.recorded_at)}</p>
      </Card>
    ) : !availability.length ? (
      <Card><Empty>Pilihan sayuran minggu ini belum dibuka.</Empty></Card>
    ) : reviewing ? (
      <Card title="Tinjau pilihan Anda" subtitle={periodDates(work.period)}>
        <ul className="simple-list">
          {selectedItems.map(({ row, qty }) => <li key={row.availability_id}>
            <div className="row-between">
              <strong>{cropName(row.crop_id)}</strong>
              <strong className="tabular">{kg(qty)} kg</strong>
            </div>
          </li>)}
          <li className="table-total">
            <div className="row-between">
              <strong>Total pilihan</strong>
              <strong className="tabular">{kg(totalSelected)} / {kg(quota)} kg</strong>
            </div>
          </li>
        </ul>
        <p className="muted-meta">Permintaan Anda akan disesuaikan apabila hasil panen akhir berubah.</p>
        {selectAction.error && <Notice tone="error">
          {selectAction.error} {selectAction.status === 409 && <Button variant="text" onClick={() => { setReviewing(false); query.reload() }}>Muat ulang stok</Button>}
        </Notice>}
        <form onSubmit={selectAction.submit(async () => {
          const items = selectedItems.map(({ row, qty }) => ({
            availability_id: row.availability_id,
            availability_version: row.version,
            quantity_kg: qty,
          }))
          await work.api.post('/member-selections', { period: work.period, items })
          setSavedMsg('Pilihan sayuran berhasil dikonfirmasi.')
          setReviewing(false)
          work.refresh()
        })}>
          <div className="toolbar-group">
            <Button variant="secondary" onClick={() => setReviewing(false)}>Ubah pilihan</Button>
            <Button type="submit" disabled={selectAction.pending}>
              {selectAction.pending ? 'Menyimpan…' : 'Konfirmasi pilihan'}
            </Button>
          </div>
        </form>
      </Card>
    ) : (
      <>
        <Card>
          <div className="row-between">
            <div>
              <span className="kpi-label">Kuota terpakai</span>
              <strong className={`metric-medium tabular ${quotaExceeded ? 'text-shortage' : ''}`}>
                {kg(totalSelected)} / {kg(quota)} kg
              </strong>
            </div>
            <span className="muted-meta">Sisa kuota: <strong>{kg(Math.max(0, quota - totalSelected))} kg</strong></span>
          </div>
          <ProgressBar value={totalSelected} max={Math.max(quota, 1)} tone={quotaExceeded ? 'shortage' : 'good'} label="Kuota terpakai" />
          {quotaExceeded && <p className="text-shortage">Total melebihi batas kuota mingguan Anda.</p>}
        </Card>

        <div className="catalog-grid">
          {availability.map(row => {
            const val = amounts[row.availability_id] ?? 0
            const maxStock = row.remaining_quantity_kg ?? row.approved_quantity_kg
            const remainingQuota = Math.max(0, quota - totalSelected)
            const canAdd = val < maxStock && remainingQuota >= 0.25
            return <div key={row.availability_id} className="catalog-card">
              <CropThumb cropId={row.crop_id} large />
              <div className="catalog-card-body">
                <strong>{cropName(row.crop_id)}</strong>
                <span className="muted-meta">Tersedia: {kg(maxStock)} kg</span>
                <div className="stepper" role="group" aria-label={`Jumlah ${cropName(row.crop_id)}`}>
                  <button type="button" className="stepper-btn" aria-label={`Kurangi ${cropName(row.crop_id)}`}
                    disabled={val <= 0} onClick={() => adjustQty(row.availability_id, maxStock, -0.25)}>
                    <Symbol name="minus" />
                  </button>
                  <input type="number" className="stepper-input" aria-label={`Berat ${cropName(row.crop_id)} (kg)`}
                    min={0} max={maxStock} step={0.25} value={val}
                    onChange={e => setAmounts(prev => ({ ...prev, [row.availability_id]: Math.max(0, Number(e.target.value) || 0) }))} />
                  <span className="stepper-unit">kg</span>
                  <button type="button" className="stepper-btn stepper-btn--plus" aria-label={`Tambah ${cropName(row.crop_id)}`}
                    disabled={!canAdd} onClick={() => adjustQty(row.availability_id, maxStock, 0.25)}>
                    <Symbol name="plus" />
                  </button>
                </div>
              </div>
            </div>
          })}
        </div>

        <Button className="btn-full" disabled={totalSelected <= 0 || quotaExceeded} onClick={() => setReviewing(true)}>
          Tinjau pilihan ({kg(totalSelected)} kg)
        </Button>
      </>
    )}
  </div>
}

/* --- PEMBARUAN PAKET (MEMBER) --- */
export function MemberUpdates({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.memberOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const updates = query.data?.updates ?? []
  const allocatedItems = (query.data?.availability ?? []).filter(a => (a.own_allocation_kg ?? 0) > 0)
  const allocatedTotal = allocatedItems.reduce((s, a) => s + (a.own_allocation_kg ?? 0), 0)

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}

    <Card title="Isi paket Anda saat ini" subtitle={periodDates(work.period)}
      actions={allocatedItems.length > 0 && <Chip tone="good">{kg(allocatedTotal)} kg</Chip>}>
      {allocatedItems.length ? <ul className="simple-list">
        {allocatedItems.map(a => (
          <li key={a.availability_id}>
            <div className="row-between">
              <div className="produce-info">
                <CropThumb cropId={a.crop_id} />
                <strong>{cropName(a.crop_id)}</strong>
              </div>
              <strong className="tabular">{kg(a.own_allocation_kg ?? 0)} kg</strong>
            </div>
          </li>
        ))}
      </ul> : <Empty>Paket Anda sedang menunggu pembagian oleh pengelola.</Empty>}
    </Card>

    <Card title="Riwayat perubahan paket" subtitle={periodDates(work.period)}>
      {updates.length ? <ul className="simple-list">
        {updates.map(row => {
          const hasPrev = row.previous_quantity_kg !== undefined && row.previous_quantity_kg !== null
          const isRemoved = row.removed || row.quantity_kg === 0
          return <li key={`${row.adjustment_id}-${row.availability_id}`}>
            <div className="row-between">
              <strong>{row.crop_id ? cropName(row.crop_id) : 'Sayuran'}</strong>
              <Chip tone={isRemoved ? 'shortage' : hasPrev ? 'warn' : 'good'}>
                {isRemoved ? 'Dihapus (0 kg)' : hasPrev ? `Disesuaikan → ${kg(row.quantity_kg)} kg` : `Disiapkan · ${kg(row.quantity_kg)} kg`}
              </Chip>
            </div>
            <p>{row.reason}</p>
            <span className="muted-meta">
              {hasPrev && `${kg(row.previous_quantity_kg ?? 0)} kg → ${kg(row.quantity_kg)} kg · `}
              {dateTime(row.approved_at)}
            </span>
          </li>
        })}
      </ul> : <Empty>Belum ada penyesuaian atau pembaruan paket pada periode ini.</Empty>}
    </Card>
  </div>
}

/* --- RIWAYAT & ULASAN PAKET (PACKAGE-CENTRIC) --- */
export function MemberHistoryFeedback({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.memberOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const fbAction = useAction()
  const [reviewPeriod, setReviewPeriod] = useState<string | null>(null)
  const [copiedPeriod, setCopiedPeriod] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState('')

  const data = query.data
  if (query.loading && !data) return <p className="empty" role="status">Memuat riwayat paket…</p>

  const packages = data?.packages ?? []

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    {savedMsg && <Notice tone="good">{savedMsg}</Notice>}

    {packages.length ? packages.map(pkg => {
      const items = pkg.allocated_items.length ? pkg.allocated_items : pkg.requested_items
      const isWriting = reviewPeriod === pkg.period
      const contactMsg = `Halo pengelola CSA Tani Sauyunan, saya ${data?.member.name ?? 'anggota'} ingin menanyakan paket periode ${periodDates(pkg.period, true)}. Terima kasih.`

      return <Card key={pkg.period}
        title={periodDates(pkg.period, true)}
        subtitle={`${pkg.package_name}${pkg.total_kg > 0 ? ` · Total ${kg(pkg.total_kg)} kg` : ''}`}
        actions={<Chip tone={pkg.receipt_confirmed ? 'good' : 'neutral'}>{pkg.status_label}</Chip>}>

        {items.length ? <div className="package-items-list">
          {items.map((it, idx) => <div key={`${it.crop_id}-${idx}`} className="package-item-row">
            <CropThumb cropId={it.crop_id} />
            <div className="row-between" style={{ flex: 1 }}>
              <strong>{cropName(it.crop_id)}</strong>
              <strong className="tabular">{kg(it.quantity_kg)} kg</strong>
            </div>
          </div>)}
        </div> : <p className="muted-meta">Belum ada sayuran yang tercatat untuk minggu ini.</p>}

        {pkg.feedback ? (
          <div className="saved-review-box">
            <Chip tone="good">Ulasan terkirim</Chip>
            <p>“{pkg.feedback.comment}”</p>
          </div>
        ) : isWriting ? (
          <form className="form inline-drawer" onSubmit={fbAction.submit(async fd => {
            setSavedMsg('')
            const comment = value(fd, 'comment')
            if (!comment) throw new Error('Tuliskan ulasan sebelum mengirim.')
            await work.api.post('/member-feedback', { period: pkg.period, comment })
            setSavedMsg('Ulasan paket berhasil dikirim.')
            setReviewPeriod(null)
            work.refresh()
          })}>
            <Field label="Bagaimana paket Anda?">
              <textarea name="comment" rows={3} required maxLength={2000} placeholder="Kesegaran sayuran, kesesuaian isi paket, atau saran…" />
            </Field>
            {fbAction.error && <Notice tone="error">{fbAction.error}</Notice>}
            <div className="toolbar-group">
              <Button variant="secondary" onClick={() => setReviewPeriod(null)}>Batal</Button>
              <Button type="submit" disabled={fbAction.pending}>{fbAction.pending ? 'Mengirim…' : 'Kirim ulasan'}</Button>
            </div>
          </form>
        ) : null}

        <div className="card-footer-row">
          <Button variant="text" onClick={() => {
            void navigator.clipboard?.writeText(contactMsg).then(() => setCopiedPeriod(pkg.period)).catch(() => undefined)
          }}>
            <WhatsAppIcon /> {copiedPeriod === pkg.period ? 'Pesan pengelola disalin' : 'Hubungi pengelola'}
          </Button>
          {pkg.receipt_confirmed && !pkg.feedback && !isWriting && (
            <Button onClick={() => setReviewPeriod(pkg.period)}>Beri ulasan</Button>
          )}
        </div>
      </Card>
    }) : <Card><Empty>Belum ada riwayat paket.</Empty></Card>}
  </div>
}
