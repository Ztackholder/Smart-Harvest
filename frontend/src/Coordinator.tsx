import { useState } from 'react'
import {
  cropName, dateTime, kg, relativeTime, shortDate, weekLabel,
  type Availability, type CoordinatorMemberRow, type CoordinatorPlantingCard,
} from './contracts'
import { SensorSummary } from './SensorComponents'
import { Button, Card, Chip, CopyId, Empty, Field, LineChart, Modal, Notice, ProgressBar, Symbol, isoDate, localDate, number, useAction, useResource, value } from './ui'
import type { Workspace } from './workspace'

function cropAgeDays(plantingDate: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(plantingDate)) / 86_400_000))
}

/* --- 02. KEBUN MITRA (GROUPED BY FARM, VISUAL SENSOR SUMMARY, NO APPROVAL COLUMN) --- */
export function FarmsDirectory({ work }: { work: Workspace }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'attention'>('all')
  const query = useResource(
    signal => work.api.coordinatorOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const farms = query.data?.farms ?? []
  const filtered = farms.filter(fg => {
    const cropStr = fg.plantings.map(p => `${cropName(p.crop.crop_id)} ${p.crop.crop_id}`).join(' ')
    const text = `${fg.farm.name} ${fg.farm.farmer_name ?? ''} ${cropStr}`.toLowerCase()
    if (search.trim() && !text.includes(search.trim().toLowerCase())) return false
    if (filter === 'attention') {
      const hasDiff = fg.plantings.some(c =>
        c.latest_prediction && c.latest_estimate &&
        Math.abs(c.latest_prediction.predicted_quantity_kg - c.latest_estimate.estimated_quantity_kg) >= 0.5,
      )
      return hasDiff || fg.telemetry.status !== 'online'
    }
    return true
  })

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    <div className="search-row">
      <div className="search-input-wrap">
        <Symbol name="search" />
        <input type="search" aria-label="Cari kebun, petani, atau komoditas" placeholder="Cari kebun, petani, atau komoditas"
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <select className="compact-select" aria-label="Filter kebun" value={filter} onChange={e => setFilter(e.target.value as 'all' | 'attention')}>
        <option value="all">Semua kebun</option>
        <option value="attention">Perlu perhatian</option>
      </select>
    </div>

    {query.loading && !farms.length ? <p className="empty" role="status">Memuat daftar kebun…</p> :
      filtered.length ? filtered.map(fg => {
        const hasDiff = fg.plantings.some(c =>
          c.latest_prediction && c.latest_estimate &&
          Math.abs(c.latest_prediction.predicted_quantity_kg - c.latest_estimate.estimated_quantity_kg) >= 0.5,
        )
        return <div key={fg.farm.farm_id} className="stack-tight">
          <SensorSummary
            compact
            farmName={`${fg.farm.name}${fg.farm.farmer_name ? ` · ${fg.farm.farmer_name}` : ''}`}
            telemetry={fg.telemetry}
            onViewMonitoring={() => work.go('pemantauan', { farmId: fg.farm.farm_id, cropId: fg.plantings[0]?.crop.crop_id ?? 'SPINACH' })}
          />
          <Card title={`Ringkasan panen · ${fg.farm.name}`}
            actions={hasDiff ? <Chip tone="warn">Ada selisih perkiraan</Chip> : undefined}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Komoditas</th>
                  <th>Perkiraan petani</th>
                  <th>Prediksi panen</th>
                  <th>Selisih</th>
                </tr>
              </thead>
              <tbody>
                {fg.plantings.map(c => {
                  const diff = c.latest_prediction && c.latest_estimate
                    ? c.latest_prediction.predicted_quantity_kg - c.latest_estimate.estimated_quantity_kg
                    : null
                  return <tr key={c.crop.crop_id}>
                    <td><strong>{cropName(c.crop.crop_id)}</strong></td>
                    <td className="tabular">{c.latest_estimate ? `${kg(c.latest_estimate.estimated_quantity_kg)} kg` : 'Belum diisi'}</td>
                    <td className="tabular">{c.latest_prediction ? `${kg(c.latest_prediction.predicted_quantity_kg)} kg` : 'Data belum cukup'}</td>
                    <td className={`tabular ${diff !== null && diff < 0 ? 'text-shortage' : diff !== null && diff > 0 ? 'text-good' : ''}`}>
                      {diff === null ? '—' : `${diff > 0 ? '+' : ''}${kg(diff)} kg`}
                    </td>
                  </tr>
                })}
              </tbody>
            </table>
            <div className="card-footer-row">
              <span className="muted-meta">{fg.plantings.length} komoditas aktif · {weekLabel(work.period)}</span>
              <Button variant="secondary" onClick={() => work.go('detail-kebun', { farmId: fg.farm.farm_id, cropId: fg.plantings[0]?.crop.crop_id ?? 'SPINACH' })}>
                Detail kebun ›
              </Button>
            </div>
          </Card>
        </div>
      }) : <Empty>Tidak ada kebun yang cocok dengan pencarian.</Empty>}
  </div>
}

/* --- 03. DETAIL KEBUN --- */
export function FarmDetail({ work }: { work: Workspace }) {
  const recalc = useAction()
  const [notice, setNotice] = useState('')
  const query = useResource(
    signal => work.api.coordinatorOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const farms = query.data?.farms ?? []
  const farmGroup = farms.find(fg => !work.focus || fg.farm.farm_id === work.focus.farmId) ?? farms[0]
  const [selectedCrop, setSelectedCrop] = useState(work.focus?.cropId)
  const card = farmGroup?.plantings.find(p => p.crop.crop_id === selectedCrop) ?? farmGroup?.plantings[0]

  if (query.loading && !farmGroup) return <p className="empty" role="status">Memuat detail kebun…</p>
  if (!farmGroup || !card) return <Empty>Kebun tidak ditemukan.</Empty>

  const pred = card.latest_prediction
  const est = card.latest_estimate
  const diff = pred && est ? pred.predicted_quantity_kg - est.estimated_quantity_kg : null
  const cov = card.telemetry.coverage
  const histPoints = [...card.prediction_history].reverse().map(row => ({
    label: shortDate(row.generated_at),
    value: row.predicted_quantity_kg,
  }))

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    <div className="breadcrumb-row">
      <Button variant="text" icon="chevron.left" onClick={() => work.go('kebun')}>Kebun mitra</Button>
      <span className="muted-meta">/ {farmGroup.farm.name}{farmGroup.farm.farmer_name ? ` (${farmGroup.farm.farmer_name})` : ''}</span>
    </div>

    {farmGroup.plantings.length > 1 && (
      <div className="range-pills" role="tablist" aria-label="Pilih komoditas di kebun">
        {farmGroup.plantings.map(p => (
          <button key={p.crop.crop_id} type="button" role="tab"
            aria-selected={p.crop.crop_id === card.crop.crop_id}
            className={`range-pill ${p.crop.crop_id === card.crop.crop_id ? 'range-pill--active' : ''}`}
            onClick={() => setSelectedCrop(p.crop.crop_id)}>
            {cropName(p.crop.crop_id)}
          </button>
        ))}
      </div>
    )}

    <Card>
      <div className="detail-hero">
        <div className="detail-hero-main">
          <span className="kpi-label">Prediksi panen · {cropName(card.crop.crop_id)}</span>
          <div className="detail-hero-numbers">
            <strong className="metric-xl">{pred ? `${kg(pred.predicted_quantity_kg)} kg` : 'Data belum cukup'}</strong>
            {diff !== null && <span className={diff < 0 ? 'text-shortage' : 'text-good'}>
              {diff < 0 ? `−${kg(Math.abs(diff))} kg dari perkiraan petani` : `+${kg(diff)} kg dari perkiraan petani`}
            </span>}
          </div>
          <p className="muted-meta">
            {pred
              ? `Pembaruan terakhir ${relativeTime(pred.generated_at)} · Target panen ${shortDate(card.planting.target_harvest_date)}`
              : 'Belum ada hasil prediksi untuk periode ini.'}
          </p>
        </div>
        <div className="detail-context-grid">
          <div><span className="kpi-label">Luas tanam</span><strong className="metric-medium">{kg(card.planting.planted_area_m2)} m²</strong></div>
          <div><span className="kpi-label">Jumlah tanaman</span><strong className="metric-medium">{card.planting.plant_count}</strong></div>
          <div><span className="kpi-label">Umur tanaman</span><strong className="metric-medium">{cropAgeDays(card.planting.planting_date)} hari</strong></div>
        </div>
        <form onSubmit={recalc.submit(async () => {
          setNotice('')
          const result = await work.api.post('/harvest-predictions', {
            farm_id: card.farm.farm_id, crop_id: card.crop.crop_id, target_period: work.period,
            planting_id: card.planting.planting_id,
          })
          setNotice(`Hasil prediksi diperbarui: ${kg(result.predicted_quantity_kg)} kg.`)
          work.refresh()
        })}>
          <Button variant="secondary" type="submit" disabled={recalc.pending}>{recalc.pending ? 'Menghitung…' : 'Hitung ulang'}</Button>
        </form>
      </div>
      {recalc.error && <Notice tone="error">{recalc.error}</Notice>}
      {notice && <Notice tone="good">{notice}</Notice>}
      {pred && <details className="tech-details">
        <summary>Detail teknis dan sumber data</summary>
        <dl className="details-grid">
          <div><dt>ID Prediksi</dt><dd><CopyId value={pred.prediction_id} /></dd></div>
          <div><dt>Model</dt><dd>{pred.model_version}</dd></div>
          <div><dt>Rute</dt><dd>{pred.inference_route ?? 'manual'}</dd></div>
          <div><dt>Sumber data latih</dt><dd>{pred.source_of_training_data === 'synthetic' ? 'Sintetis (prototipe)' : pred.source_of_training_data}</dd></div>
          <div><dt>Riwayat pengukuran (7 hari)</dt><dd>{pred.input_snapshot?.observation_count ?? 0} rekaman</dd></div>
          <div><dt>Dibuat</dt><dd>{dateTime(pred.generated_at)}</dd></div>
        </dl>
      </details>}
    </Card>

    <div className="two-col-wide">
      <Card title="Riwayat prediksi" subtitle="kg">
        <LineChart points={histPoints} unit="kg" label="Riwayat prediksi" />
      </Card>
      <Card title="Kelengkapan data" subtitle="Jendela 7 hari · minimal 80%">
        <div className="coverage-list">
          {([
            ['Suhu udara', cov.air_temperature.coverage],
            ['Kelembapan udara', cov.relative_humidity.coverage],
            ['Kelembapan tanah', cov.soil_moisture_index.coverage],
          ] as const).map(([label, frac]) => {
            const pct = Math.round(frac * 100)
            return <div key={label} className="coverage-item">
              <div className="row-between"><span>{label}</span><strong className="tabular">{pct}%</strong></div>
              <ProgressBar value={pct} max={100} tone={pct >= 80 ? 'good' : 'warn'} label={`Kelengkapan ${label}`} />
            </div>
          })}
        </div>
      </Card>
    </div>

    <SensorSummary
      farmName={farmGroup.farm.name}
      telemetry={farmGroup.telemetry}
      onViewMonitoring={() => work.go('pemantauan', { farmId: farmGroup.farm.farm_id, cropId: card.crop.crop_id })}
    />
  </div>
}

/* --- 04. RENCANA PANEN: SIMPLIFIED OFFER DECISION WORKSPACE --- */
export function HarvestPlan({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.coordinatorOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const [demandDrafts, setDemandDrafts] = useState<Record<string, string>>({})
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [farmerConfirmed, setFarmerConfirmed] = useState<Record<string, boolean>>({})
  const [manualFallback, setManualFallback] = useState<Record<string, boolean>>({})
  const [confirmOffer, setConfirmOffer] = useState<{ cropId: string; totalKg: number; useManual: boolean; demandNum: number | null; noteVal: string; list: CoordinatorPlantingCard[] } | null>(null)
  const [copiedKey, setCopiedKey] = useState('')
  const [feedbackMsg, setFeedbackMsg] = useState('')
  const [actionError, setActionError] = useState('')
  const [busyCrop, setBusyCrop] = useState<string | null>(null)

  const data = query.data
  const plantings = data?.plantings ?? []
  const byCrop = new Map<string, CoordinatorPlantingCard[]>()
  for (const p of plantings) {
    const arr = byCrop.get(p.crop.crop_id) ?? []
    arr.push(p)
    byCrop.set(p.crop.crop_id, arr)
  }

  const executePublish = async () => {
    if (!confirmOffer) return
    const { cropId, useManual, demandNum, noteVal, list } = confirmOffer
    const unapproved = list.filter(c => !c.approval)
    setActionError('')
    setFeedbackMsg('')
    setBusyCrop(cropId)
    try {
      let planId: string | undefined
      if (!useManual) {
        const created = await work.api.post('/commodity-plans', {
          crop_id: cropId,
          period: work.period,
          planned_demand_kg: demandNum ?? 0,
          review_note: noteVal,
          verified_with_farmer: Boolean(farmerConfirmed[cropId]),
          review_outcome: 'CONFIRMED',
          farmer_verification_status: farmerConfirmed[cropId] ? 'CONFIRMED' : 'UNCONFIRMED',
        })
        planId = created.plan_id
      }
      const finalNote = noteVal.trim() || 'Penawaran dibuka oleh koordinator'
      for (const item of unapproved) {
        if (useManual) {
          if (!item.latest_estimate) throw new Error(`Perkiraan petani belum tersedia untuk ${item.farm.name}.`)
          await work.api.post('/approved-availability', {
            farm_id: item.farm.farm_id, crop_id: cropId, period: work.period,
            basis_type: 'MANUAL_ESTIMATE', basis_id: item.latest_estimate.estimate_id,
            approved_quantity_kg: item.latest_estimate.estimated_quantity_kg,
            approval_note: finalNote,
          })
        } else {
          if (!item.latest_prediction) throw new Error(`Hasil prediksi belum tersedia untuk ${item.farm.name}.`)
          await work.api.post('/approved-availability', {
            farm_id: item.farm.farm_id, crop_id: cropId, period: work.period,
            basis_type: 'PREDICTION', basis_id: item.latest_prediction.prediction_id,
            approved_quantity_kg: item.latest_prediction.predicted_quantity_kg,
            approval_note: finalNote,
            commodity_plan_id: planId,
          })
        }
      }
      setFeedbackMsg(`Penawaran ${cropName(cropId)} (${kg(confirmOffer.totalKg)} kg) sudah dibuka untuk anggota.`)
      setConfirmOffer(null)
      work.refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Penawaran gagal dibuka.')
      setConfirmOffer(null)
    } finally {
      setBusyCrop(null)
    }
  }

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    {actionError && <Notice tone="error">{actionError}</Notice>}
    {feedbackMsg && <Notice tone="good">{feedbackMsg}</Notice>}

    {[...byCrop.entries()].map(([cropId, list]) => {
      const plan = data?.commodity_plans.find(p => p.crop_id === cropId)
      const unapproved = list.filter(c => !c.approval)
      const allOffered = unapproved.length === 0
      const offeredTotal = list.reduce((s, c) => s + (c.approval?.approved_quantity_kg ?? 0), 0)

      // 4. Collapsed compact summary once published
      if (allOffered) {
        const latestApprovedAt = list.map(c => c.approval?.approved_at).filter(Boolean).sort().at(-1)
        const newerPrediction = list.some(c =>
          c.latest_prediction && c.approval?.basis_type === 'PREDICTION' &&
          c.latest_prediction.prediction_id !== c.approval.basis_id,
        )
        return <Card key={cropId} title={cropName(cropId)}
          actions={<Chip tone="good">Pilihan sudah dibuka</Chip>}>
          <div className="row-between">
            <div>
              <span className="kpi-label">Jumlah yang ditawarkan</span>
              <strong className="metric-large tabular">{kg(offeredTotal)} kg</strong>
            </div>
            <div className="toolbar-group">
              {latestApprovedAt && <span className="muted-meta">Dibuka {relativeTime(latestApprovedAt)}</span>}
              <Button variant="secondary" onClick={() => work.go('alokasi-realisasi')}>Lihat pembagian ›</Button>
            </div>
          </div>
          {newerPrediction && <Notice tone="warn">Ada hasil prediksi terbaru setelah penawaran dibuka. Penawaran aktif tidak berubah otomatis.</Notice>}
        </Card>
      }

      const useManual = manualFallback[cropId] ?? list.every(c => !c.latest_prediction && Boolean(c.latest_estimate))
      const totalEstimate = list.reduce((s, c) => s + (c.latest_estimate?.estimated_quantity_kg ?? 0), 0)
      const totalPred = list.reduce((s, c) => s + (c.latest_prediction?.predicted_quantity_kg ?? 0), 0)
      const activeSupply = useManual ? totalEstimate : totalPred
      const demandStr = demandDrafts[cropId] ?? (plan ? String(plan.planned_demand_kg) : '')
      const demandNum = demandStr.trim() === '' ? null : Number(demandStr)
      const gap = demandNum !== null && Number.isFinite(demandNum) ? Math.max(0, demandNum - activeSupply) : null
      const noteVal = noteDrafts[cropId] ?? plan?.review_note ?? ''

      const farmsNeedingConfirm = list.filter(c => {
        const hasDiff = c.latest_prediction && c.latest_estimate &&
          Math.abs(c.latest_prediction.predicted_quantity_kg - c.latest_estimate.estimated_quantity_kg) >= 0.5
        return (gap !== null && gap > 0) || hasDiff
      })
      const needsFarmerConfirm = farmsNeedingConfirm.length > 0
      const confirmedOk = !needsFarmerConfirm || Boolean(farmerConfirmed[cropId])
      const canOffer = confirmedOk && (useManual || (demandNum !== null && Number.isFinite(demandNum))) && activeSupply > 0
      const disabledReason = !useManual && demandNum === null
        ? 'Masukkan kebutuhan mingguan (kg) terlebih dahulu.'
        : !confirmedOk
          ? 'Konfirmasi ketersediaan dengan petani terlebih dahulu.'
          : ''

      return <div key={cropId} className="stack-tight">
        {plan?.is_stale && <Notice tone="warn">Hasil prediksi berubah setelah tinjauan terakhir.</Notice>}

        <div className="two-col-wide">
          <Card title={`${cropName(cropId)} · sumber pasokan`}
            actions={<Chip>Pilihan belum dibuka</Chip>}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kebun</th>
                  <th>Perkiraan petani</th>
                  <th>Prediksi panen</th>
                  <th>Selisih</th>
                </tr>
              </thead>
              <tbody>
                {list.map(c => {
                  const diff = c.latest_prediction && c.latest_estimate
                    ? c.latest_prediction.predicted_quantity_kg - c.latest_estimate.estimated_quantity_kg
                    : null
                  return <tr key={c.farm.farm_id}>
                    <td><strong>{c.farm.name}</strong>{c.farm.farmer_name && <span className="kpi-sub"> · {c.farm.farmer_name}</span>}</td>
                    <td className="tabular">{c.latest_estimate ? `${kg(c.latest_estimate.estimated_quantity_kg)} kg` : 'Belum diisi'}</td>
                    <td className="tabular">{c.latest_prediction ? `${kg(c.latest_prediction.predicted_quantity_kg)} kg` : 'Data belum cukup'}</td>
                    <td className={`tabular ${diff !== null && diff < 0 ? 'text-shortage' : diff !== null && diff > 0 ? 'text-good' : ''}`}>
                      {diff === null ? '—' : `${diff > 0 ? '+' : ''}${kg(diff)} kg`}
                    </td>
                  </tr>
                })}
                <tr className="table-total">
                  <td><strong>Total</strong></td>
                  <td className="tabular"><strong>{kg(totalEstimate)} kg</strong></td>
                  <td className="tabular"><strong>{kg(totalPred)} kg</strong></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </Card>

          <Card title="Kebutuhan mingguan">
            <Field label="Kebutuhan (kg)" type="number" min={0} step="any" placeholder="Contoh: 12"
              value={demandStr} onChange={e => setDemandDrafts(prev => ({ ...prev, [cropId]: e.target.value }))} />
            <div>
              <span className="kpi-label">Potensi kekurangan</span>
              <strong className={`metric-large ${gap && gap > 0 ? 'text-shortage' : ''}`}>
                {gap === null ? 'Isi kebutuhan' : `${kg(gap)} kg`}
              </strong>
              <ProgressBar value={activeSupply} max={Math.max(demandNum ?? 0, activeSupply, 1)}
                tone={gap && gap > 0 ? 'shortage' : 'good'} label={`Perbandingan pasokan ${cropName(cropId)}`} />
              <p className="muted-meta">{gap === null ? 'Kebutuhan belum ditentukan' : gap > 0 ? 'Perlu konfirmasi petani' : 'Mencukupi kebutuhan'}</p>
            </div>
          </Card>
        </div>

        <Card title={`Penawaran ${cropName(cropId)}`}>
          {needsFarmerConfirm && (
            <div className="review-farmer-box">
              <strong>Konfirmasi dengan petani</strong>
              <p className="muted-meta">
                {gap && gap > 0
                  ? `Kebutuhan melebihi prediksi sebesar ${kg(gap)} kg.`
                  : 'Terdapat perbedaan antara perkiraan petani dan prediksi panen.'}
              </p>
              <div className="farmer-contact-list">
                {farmsNeedingConfirm.map(c => {
                  const msgParts = [`Halo ${c.farm.farmer_name ?? 'Pak/Bu'}, izin konfirmasi rencana panen ${cropName(cropId)} (${weekLabel(work.period)}).`]
                  if (c.latest_estimate) msgParts.push(`Estimasi sebelumnya: ${kg(c.latest_estimate.estimated_quantity_kg)} kg.`)
                  if (c.latest_prediction) msgParts.push(`Prediksi terbaru: ${kg(c.latest_prediction.predicted_quantity_kg)} kg.`)
                  msgParts.push('Apakah jumlah tersebut masih sesuai dengan kondisi kebun saat ini? Terima kasih.')
                  const msgText = msgParts.join(' ')
                  const digits = c.farm.contact_phone?.replace(/\D/g, '')
                  const cKey = `${cropId}:${c.farm.farm_id}`
                  return <div key={c.farm.farm_id} className="farmer-contact-row">
                    <div>
                      <strong>{c.farm.name}</strong>
                      <span className="muted-meta"> · {c.farm.farmer_name ?? 'Petani mitra'}</span>
                    </div>
                    {digits ? (
                      <a className="button button--secondary" target="_blank" rel="noopener noreferrer"
                        href={`https://wa.me/${digits}?text=${encodeURIComponent(msgText)}`}>
                        Hubungi petani
                      </a>
                    ) : (
                      <Button variant="secondary" onClick={() => {
                        void navigator.clipboard?.writeText(msgText).then(() => setCopiedKey(cKey)).catch(() => undefined)
                      }}>
                        {copiedKey === cKey ? 'Pesan disalin' : 'Salin pesan untuk petani'}
                      </Button>
                    )}
                  </div>
                })}
              </div>
              <label className="check-label">
                <input type="checkbox" checked={Boolean(farmerConfirmed[cropId])}
                  onChange={e => setFarmerConfirmed(prev => ({ ...prev, [cropId]: e.target.checked }))} />
                Saya sudah mengonfirmasi ketersediaan dengan petani
              </label>
            </div>
          )}

          <div className="row-between">
            <div>
              <span className="kpi-label">Jumlah yang ditawarkan kepada anggota</span>
              <strong className="metric-large tabular">{kg(activeSupply)} kg</strong>
              <span className="kpi-sub">{useManual ? 'Berdasarkan perkiraan petani' : 'Berdasarkan prediksi panen'}</span>
            </div>
            {list.some(c => c.latest_estimate) && (
              <label className="check-label">
                <input type="checkbox" checked={useManual}
                  onChange={e => setManualFallback(prev => ({ ...prev, [cropId]: e.target.checked }))} />
                Gunakan perkiraan petani (manual)
              </label>
            )}
          </div>

          <Field label="Catatan singkat (opsional)">
            <input type="text" placeholder="Catatan keputusan penawaran minggu ini…"
              value={noteVal} onChange={e => setNoteDrafts(prev => ({ ...prev, [cropId]: e.target.value }))} />
          </Field>

          {disabledReason && <p className="muted-meta">{disabledReason}</p>}

          <div className="card-footer-row">
            <span className="muted-meta">{weekLabel(work.period)} · {list.length} kebun</span>
            <Button disabled={busyCrop === cropId || !canOffer}
              onClick={() => setConfirmOffer({ cropId, totalKg: activeSupply, useManual, demandNum, noteVal, list })}>
              {busyCrop === cropId ? 'Membuka…' : 'Buka pilihan sayuran'}
            </Button>
          </div>
        </Card>
      </div>
    })}

    {confirmOffer && <Modal title={`Buka pilihan ${cropName(confirmOffer.cropId)}`} onClose={() => setConfirmOffer(null)}>
      <div className="stack-tight">
        <p>Penawaran akan terlihat oleh seluruh anggota pada periode <strong>{weekLabel(work.period)}</strong>:</p>
        <ul className="simple-list">
          <li><div className="row-between"><span>Komoditas</span><strong>{cropName(confirmOffer.cropId)}</strong></div></li>
          <li><div className="row-between"><span>Jumlah ditawarkan</span><strong className="tabular">{kg(confirmOffer.totalKg)} kg</strong></div></li>
          <li><div className="row-between"><span>Sumber</span><strong>{confirmOffer.useManual ? 'Perkiraan petani' : 'Prediksi panen'}</strong></div></li>
        </ul>
        <div className="toolbar-group">
          <Button variant="secondary" onClick={() => setConfirmOffer(null)}>Batal</Button>
          <Button disabled={busyCrop !== null} onClick={() => void executePublish()}>
            {busyCrop ? 'Membuka…' : 'Ya, buka pilihan sayuran'}
          </Button>
        </div>
      </div>
    </Modal>}

    {!plantings.length && !query.loading && <Empty>Belum ada komoditas aktif untuk periode ini.</Empty>}
  </div>
}

/* --- 06. ALOKASI & REALISASI --- */
export function AllocationRealization({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.coordinatorOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const actualAction = useAction()
  const adjustAction = useAction()
  const [showActualForm, setShowActualForm] = useState(false)
  const [showAdjustForm, setShowAdjustForm] = useState(false)
  const [selectedAvl, setSelectedAvl] = useState<Availability>()
  const [memberAmounts, setMemberAmounts] = useState<Record<string, string>>({})
  const [detailMember, setDetailMember] = useState<CoordinatorMemberRow | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [receiptError, setReceiptError] = useState('')

  const data = query.data
  const plantings = data?.plantings ?? []
  const approvals = data?.approvals ?? []
  const selections = data?.selections ?? []
  const memberRows = data?.member_rows ?? []

  const totalOffered = approvals.reduce((s, a) => s + a.approved_quantity_kg, 0)
  const totalSelected = selections.reduce((s, sel) => s + sel.items.reduce((a, b) => a + b.quantity_kg, 0), 0)
  const totalPlannedDistribution = memberRows.reduce((s, m) => s + (m.allocated_total_kg ?? m.requested_total_kg ?? 0), 0)
  const totalActual = plantings.reduce((s, p) => s + (p.actual_harvest?.actual_quantity_kg ?? 0), 0)
  const hasActual = plantings.some(p => p.actual_harvest)
  const actualShortage = hasActual && totalPlannedDistribution > totalActual ? totalPlannedDistribution - totalActual : 0
  const activeAvl = approvals.find(a => a.availability_id === selectedAvl?.availability_id) ?? approvals[0]
  const matchingActual = activeAvl
    ? plantings.find(p => p.farm.farm_id === activeAvl.farm_id && p.crop.crop_id === activeAvl.crop_id)?.actual_harvest
    : undefined

  // Per-crop breakdown
  const cropsInScope = [...new Set(plantings.map(p => p.crop.crop_id))]

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    {receiptError && <Notice tone="error">{receiptError}</Notice>}
    {statusMsg && <Notice tone="good">{statusMsg}</Notice>}

    <div className="kpi-grid">
      <div className="kpi-card">
        <span className="kpi-label">Jumlah yang ditawarkan</span>
        <strong className="kpi-value">{kg(totalOffered)} kg</strong>
        <span className="kpi-sub">{approvals.length ? `${approvals.length} penawaran aktif` : 'Pilihan belum dibuka'}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Pilihan anggota</span>
        <strong className="kpi-value">{kg(totalSelected)} kg</strong>
        <span className="kpi-sub">Permintaan Paket Custom</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Rencana pembagian</span>
        <strong className="kpi-value">{kg(totalPlannedDistribution)} kg</strong>
        <span className="kpi-sub">Termasuk Paket Reguler</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Hasil panen</span>
        <strong className="kpi-value">{hasActual ? `${kg(totalActual)} kg` : 'Belum dicatat'}</strong>
        <span className="kpi-sub">{actualShortage > 0 ? `Kurang ${kg(actualShortage)} kg` : hasActual ? 'Hasil panen tercatat' : 'Catat setelah panen'}</span>
      </div>
    </div>

    <Card title="Ringkasan per komoditas"
      actions={<Button onClick={() => setShowActualForm(v => !v)}>
        {showActualForm ? 'Tutup formulir hasil panen' : 'Catat hasil panen'}
      </Button>}>
      {cropsInScope.length ? <table className="data-table">
        <thead>
          <tr>
            <th>Komoditas</th>
            <th>Ditawarkan</th>
            <th>Rencana pembagian</th>
            <th>Hasil panen</th>
            <th>Selisih</th>
          </tr>
        </thead>
        <tbody>
          {cropsInScope.map(cid => {
            const cropAvls = approvals.filter(a => a.crop_id === cid)
            const offered = cropAvls.reduce((s, a) => s + a.approved_quantity_kg, 0)
            const allocSum = cropAvls.reduce((s, a) => s + (a.member_allocations?.reduce((x, y) => x + y.quantity_kg, 0) ?? 0), 0)
            const reqSum = selections.reduce((s, sel) => s + sel.items.filter(it => cropAvls.some(a => a.availability_id === it.availability_id)).reduce((x, y) => x + y.quantity_kg, 0), 0)
            const planned = allocSum > 0 ? allocSum : reqSum
            const cropActuals = plantings.filter(p => p.crop.crop_id === cid && p.actual_harvest)
            const actualSum = cropActuals.reduce((s, p) => s + (p.actual_harvest?.actual_quantity_kg ?? 0), 0)
            const diff = cropActuals.length ? actualSum - planned : null
            return <tr key={cid}>
              <td><strong>{cropName(cid)}</strong></td>
              <td className="tabular">{offered > 0 ? `${kg(offered)} kg` : 'Belum dibuka'}</td>
              <td className="tabular">{kg(planned)} kg</td>
              <td className="tabular">{cropActuals.length ? `${kg(actualSum)} kg` : 'Belum dicatat'}</td>
              <td className={`tabular ${diff !== null && diff < 0 ? 'text-shortage' : ''}`}>
                {diff === null ? '—' : diff < 0 ? `Kurang ${kg(Math.abs(diff))} kg` : 'Cukup'}
              </td>
            </tr>
          })}
        </tbody>
      </table> : <Empty>Belum ada data komoditas.</Empty>}
    </Card>

    {actualShortage > 0 && <div className="amber-banner">
      <div>
        <strong>Penyesuaian paket diperlukan</strong>
        <p>Hasil panen kurang {kg(actualShortage)} kg dari rencana pembagian anggota.</p>
      </div>
      <Button onClick={() => setShowAdjustForm(true)}>Kelola alokasi</Button>
    </div>}

    {showActualForm && <Card title="Catat hasil panen terkonfirmasi">
      <form className="form" onSubmit={actualAction.submit(async fd => {
        setStatusMsg('')
        const [farm_id, crop_id] = value(fd, 'scope').split(':')
        const res = await work.api.post('/actual-harvests', {
          farm_id, crop_id, period: work.period,
          actual_quantity_kg: number(fd, 'quantity'),
          harvested_at: isoDate(fd, 'harvested_at'),
          source: 'coordinator-confirmed',
          confirmation_note: value(fd, 'note'),
        })
        setStatusMsg(`Hasil panen ${kg(res.actual_quantity_kg)} kg dikonfirmasi.`)
        setShowActualForm(false)
        work.refresh()
      })}>
        <Field label="Kebun & komoditas">
          <select name="scope" required defaultValue={plantings[0] ? `${plantings[0].farm.farm_id}:${plantings[0].crop.crop_id}` : ''}>
            {plantings.map(p => <option key={`${p.farm.farm_id}:${p.crop.crop_id}`} value={`${p.farm.farm_id}:${p.crop.crop_id}`}>
              {p.farm.name} · {cropName(p.crop.crop_id)}
            </option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Hasil panen (kg)" name="quantity" type="number" min={0} step="any" required />
          <Field label="Waktu panen" name="harvested_at" type="datetime-local" defaultValue={localDate()} required />
        </div>
        <Field label="Catatan konfirmasi"><textarea name="note" rows={2} required /></Field>
        {actualAction.error && <Notice tone="error">{actualAction.error}</Notice>}
        <Button type="submit" disabled={actualAction.pending}>{actualAction.pending ? 'Menyimpan…' : 'Simpan hasil panen'}</Button>
      </form>
    </Card>}

    {showAdjustForm && activeAvl && <Card title="Kelola pembagian paket"
      actions={<Button variant="text" onClick={() => setShowAdjustForm(false)}>Tutup</Button>}>
      <form className="form" onSubmit={adjustAction.submit(async fd => {
        setStatusMsg('')
        const qty = number(fd, 'quantity')
        const allocs = memberRows
          .map(m => ({ member_id: m.member_id, quantity_kg: Number(memberAmounts[m.member_id] ?? 0) }))
          .filter(a => Number.isFinite(a.quantity_kg) && a.quantity_kg > 0)
        const res = await work.api.post('/allocation-adjustments', {
          availability_id: activeAvl.availability_id,
          expected_version: activeAvl.version,
          approved_quantity_kg: qty,
          reason: value(fd, 'reason'),
          actual_harvest_id: matchingActual?.actual_harvest_id,
          member_allocations: allocs,
        })
        setStatusMsg(`Pembagian paket diperbarui (versi ${res.version}).`)
        setShowAdjustForm(false)
        work.refresh()
      })}>
        {approvals.length > 1 && <Field label="Sayuran & kebun">
          <select value={activeAvl.availability_id} onChange={e => setSelectedAvl(approvals.find(a => a.availability_id === e.target.value))}>
            {approvals.map(a => <option key={a.availability_id} value={a.availability_id}>
              {cropName(a.crop_id)} · {kg(a.approved_quantity_kg)} kg (v{a.version})
            </option>)}
          </select>
        </Field>}
        <Field label="Batas kuantitas (kg)" name="quantity" type="number" min={0} step="any"
          defaultValue={matchingActual ? Math.min(activeAvl.approved_quantity_kg, matchingActual.actual_quantity_kg) : activeAvl.approved_quantity_kg} required />
        <div className="form-grid">
          {memberRows.map(m => <Field key={m.member_id} label={`${m.name} (${m.package_name}) — kg`}
            type="number" min={0} step="any" placeholder="0"
            value={memberAmounts[m.member_id] ?? ''}
            onChange={e => setMemberAmounts(prev => ({ ...prev, [m.member_id]: e.target.value }))} />)}
        </div>
        <Field label="Alasan pembagian / penyesuaian"><textarea name="reason" rows={2} required /></Field>
        {adjustAction.error && <Notice tone="error">{adjustAction.error} {adjustAction.status === 409 && <Button variant="text" onClick={query.reload}>Muat ulang</Button>}</Notice>}
        <Button type="submit" disabled={adjustAction.pending}>{adjustAction.pending ? 'Menyimpan…' : 'Simpan pembagian'}</Button>
      </form>
    </Card>}

    <Card title="Daftar paket anggota"
      actions={approvals.length > 0 && <Button variant="secondary" onClick={() => setShowAdjustForm(v => !v)}>Kelola alokasi</Button>}>
      {memberRows.length ? <table className="data-table">
        <thead>
          <tr>
            <th>Anggota</th>
            <th>Paket</th>
            <th>Permintaan</th>
            <th>Rencana pembagian</th>
            <th>Status</th>
            <th>Tindakan</th>
          </tr>
        </thead>
        <tbody>
          {memberRows.map(m => {
            const hasFinalAlloc = (m.allocated_total_kg ?? 0) > 0
            return <tr key={m.member_id}>
              <td>
                <button type="button" className="member-name-btn" onClick={() => setDetailMember(m)}>
                  <span className="avatar-badge" aria-hidden="true">{m.initials}</span>
                  <strong>{m.name}</strong>
                </button>
              </td>
              <td>{m.package_name}</td>
              <td className="tabular">{m.eligible ? (m.requested_total_kg !== null ? `${kg(m.requested_total_kg)} kg` : 'Belum memilih') : 'Diatur pengelola'}</td>
              <td className="tabular">{hasFinalAlloc ? `${kg(m.allocated_total_kg ?? 0)} kg` : 'Menunggu'}</td>
              <td>
                <Chip tone={m.lifecycle_status === 'Diterima' || m.lifecycle_status === 'Siap didistribusikan' ? 'good' : m.lifecycle_status === 'Perlu penyesuaian' ? 'warn' : 'neutral'}>
                  {m.lifecycle_status}
                </Chip>
              </td>
              <td>
                {m.receipt_confirmed ? <Chip tone="good">Diterima</Chip> : hasFinalAlloc ? (
                  <Button variant="secondary" onClick={() => {
                    setStatusMsg('')
                    setReceiptError('')
                    void work.api.post('/package-receipts', { member_id: m.member_id, period: work.period, confirmed: true })
                      .then(() => { setStatusMsg(`Penerimaan paket ${m.name} dicatat.`); work.refresh() })
                      .catch(err => setReceiptError(err instanceof Error ? err.message : 'Gagal mencatat penerimaan.'))
                  }}>
                    Catat penerimaan
                  </Button>
                ) : (
                  <span className="muted-meta">Siapkan paket dahulu</span>
                )}
              </td>
            </tr>
          })}
        </tbody>
      </table> : <Empty>Belum ada data anggota.</Empty>}
    </Card>

    {detailMember && <Modal title={`${detailMember.name} · ${detailMember.package_name}`} onClose={() => setDetailMember(null)}>
      <div className="stack-tight">
        <p className="muted-meta">Status: <strong>{detailMember.lifecycle_status}</strong></p>
        <div>
          <strong>Permintaan anggota</strong>
          {detailMember.requested_items.length ? <ul className="simple-list">
            {detailMember.requested_items.map((it, idx) => <li key={idx}>
              <div className="row-between">
                <span>{it.crop_id ? cropName(it.crop_id) : 'Sayuran'}</span>
                <strong className="tabular">{kg(it.quantity_kg)} kg</strong>
              </div>
            </li>)}
          </ul> : <p className="muted-meta">{detailMember.eligible ? 'Belum memilih sayuran.' : 'Isi paket ditentukan oleh pengelola berdasarkan ketersediaan sayuran.'}</p>}
        </div>
        <div>
          <strong>Pembagian paket</strong>
          {detailMember.allocated_items.length ? <ul className="simple-list">
            {detailMember.allocated_items.map((it, idx) => <li key={idx}>
              <div className="row-between">
                <span>{cropName(it.crop_id)}</span>
                <strong className="tabular">{kg(it.quantity_kg)} kg</strong>
              </div>
            </li>)}
          </ul> : <p className="muted-meta">Belum ada pembagian akhir.</p>}
        </div>
      </div>
    </Modal>}
  </div>
}

/* --- 07. RIWAYAT & EVALUASI --- */
export function HistoryEvaluation({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.coordinatorOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const data = query.data
  const plantings = data?.plantings ?? []
  const approvals = data?.approvals ?? []
  const adjustments = data?.adjustments ?? []
  const feedback = data?.feedback ?? []
  const members = data?.members ?? []

  const totalEstimate = plantings.reduce((s, p) => s + (p.latest_estimate?.estimated_quantity_kg ?? 0), 0)
  const totalPred = plantings.reduce((s, p) => s + (p.latest_prediction?.predicted_quantity_kg ?? 0), 0)
  const totalInitialApproved = approvals.reduce((s, a) => s + (a.initial_approved_quantity_kg ?? a.approved_quantity_kg), 0)
  const totalFinalApproved = approvals.reduce((s, a) => s + a.approved_quantity_kg, 0)
  const totalActual = plantings.reduce((s, p) => s + (p.actual_harvest?.actual_quantity_kg ?? 0), 0)
  const hasActual = plantings.some(p => p.actual_harvest)
  const barMax = Math.max(totalEstimate, totalPred, totalInitialApproved, totalFinalApproved, totalActual, 1)

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}

    <div className="kpi-grid">
      <div className="kpi-card">
        <span className="kpi-label">Perkiraan petani</span>
        <strong className="kpi-value">{totalEstimate > 0 ? `${kg(totalEstimate)} kg` : '—'}</strong>
        <span className="kpi-sub">{plantings.length} penanaman</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Prediksi panen</span>
        <strong className="kpi-value">{totalPred > 0 ? `${kg(totalPred)} kg` : '—'}</strong>
        <span className="kpi-sub">{weekLabel(work.period)}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Jumlah ditawarkan</span>
        <strong className="kpi-value">{totalInitialApproved > 0 ? `${kg(totalInitialApproved)} kg` : '—'}</strong>
        <span className="kpi-sub">Sebelum panen</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Hasil panen</span>
        <strong className="kpi-value">{hasActual ? `${kg(totalActual)} kg` : '—'}</strong>
        <span className="kpi-sub">{hasActual ? 'Terkonfirmasi' : 'Belum dicatat'}</span>
      </div>
    </div>

    <Card title="Realisasi dan penyesuaian paket">
      <div className="comparison-bars">
        <div className="comparison-row">
          <span>Perkiraan petani</span>
          <ProgressBar value={totalEstimate} max={barMax} tone="good" label="Perkiraan petani" />
          <strong className="tabular">{kg(totalEstimate)} kg</strong>
        </div>
        <div className="comparison-row">
          <span>Prediksi panen</span>
          <ProgressBar value={totalPred} max={barMax} tone="good" label="Prediksi panen" />
          <strong className="tabular">{kg(totalPred)} kg</strong>
        </div>
        <div className="comparison-row">
          <span>Pembagian akhir</span>
          <ProgressBar value={totalFinalApproved} max={barMax} tone="good" label="Pembagian akhir" />
          <strong className="tabular">{kg(totalFinalApproved)} kg</strong>
        </div>
        <div className="comparison-row">
          <span>Hasil panen</span>
          <ProgressBar value={totalActual} max={barMax} tone="good" label="Hasil panen" />
          <strong className="tabular">{hasActual ? `${kg(totalActual)} kg` : '—'}</strong>
        </div>
      </div>
      {adjustments.length > 0 && <ul className="simple-list">
        {adjustments.map(adj => <li key={adj.adjustment_id}>
          <strong>Versi {adj.version} · {kg(adj.approved_quantity_kg)} kg</strong>
          <span>{adj.reason} · {dateTime(adj.approved_at)}</span>
        </li>)}
      </ul>}
    </Card>

    <Card title="Ulasan paket anggota">
      {members.length ? <ul className="simple-list">
        {members.map(m => {
          const fb = feedback.find(f => f.member_id === m.member_id)
          return <li key={m.member_id}>
            <strong>{m.name ?? m.member_id}</strong>
            {fb ? <p>{fb.comment}</p> : <span className="muted-meta">Belum ada ulasan</span>}
          </li>
        })}
      </ul> : <Empty>Belum ada ulasan untuk periode ini.</Empty>}
    </Card>
  </div>
}
