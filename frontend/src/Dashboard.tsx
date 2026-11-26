import { cropName, kg, periodDates, weekLabel } from './contracts'
import { SensorSummary } from './SensorComponents'
import { Button, Card, Empty, Notice, ProgressBar, Symbol, useResource } from './ui'
import { nextCoordinatorStep } from './workflow'
import type { Workspace } from './workspace'

export function Dashboard({ work }: { work: Workspace }) {
  const { api, period, revision, go, onAuthExpired } = work
  const query = useResource(signal => api.coordinatorOverview(period, signal), [api, period, revision], onAuthExpired)
  const data = query.data

  if (query.loading && !data) {
    return <div className="stack"><p className="empty" role="status">Memuat ringkasan minggu ini…</p></div>
  }

  const farms = data?.farms ?? []
  const plantings = data?.plantings ?? []
  const plans = data?.commodity_plans ?? []
  const approvals = data?.approvals ?? []
  const selections = data?.selections ?? []
  const adjustments = data?.adjustments ?? []
  const receipts = data?.receipts ?? []
  const feedback = data?.feedback ?? []
  const members = data?.members ?? []

  const byCrop = new Map<string, typeof plantings>()
  for (const card of plantings) {
    const list = byCrop.get(card.crop.crop_id) ?? []
    list.push(card)
    byCrop.set(card.crop.crop_id, list)
  }

  const commoditySummaries = [...byCrop.entries()].map(([cropId, list]) => {
    const plan = plans.find(p => p.crop_id === cropId)
    const predictedTotal = list.reduce((sum, item) => sum + (item.latest_prediction?.predicted_quantity_kg ?? 0), 0)
    const predictedCount = list.filter(item => item.latest_prediction).length
    const estimateTotal = list.reduce((sum, item) => sum + (item.latest_estimate?.estimated_quantity_kg ?? 0), 0)
    const demand = plan ? plan.planned_demand_kg : null
    const gap = demand !== null ? Math.max(0, demand - predictedTotal) : null
    return { cropId, list, plan, predictedTotal, predictedCount, estimateTotal, demand, gap }
  })

  const totalPredicted = commoditySummaries.reduce((sum, c) => sum + c.predictedTotal, 0)
  const hasAnyPrediction = commoditySummaries.some(c => c.predictedCount > 0)
  const definedDemands = commoditySummaries.filter(c => c.demand !== null)
  const totalDemand = definedDemands.length ? definedDemands.reduce((sum, c) => sum + (c.demand ?? 0), 0) : null
  const totalShortage = definedDemands.length ? definedDemands.reduce((sum, c) => sum + (c.gap ?? 0), 0) : null
  const totalOffered = approvals.reduce((sum, a) => sum + a.approved_quantity_kg, 0)
  const totalPlantings = plantings.length

  const totalRequested = selections.reduce((sum, s) => sum + s.items.reduce((a, b) => a + b.quantity_kg, 0), 0)
  const allReceiptsConfirmed = members.length > 0 && members.every(m => receipts.some(r => r.member_id === m.member_id && r.received))
  const nextSteps = plantings.map(card => {
    const plan = plans.find(p => p.crop_id === card.crop.crop_id)
    const hasRisk = Boolean(
      (card.latest_prediction && data?.risks.some(r => r.prediction_id === card.latest_prediction?.prediction_id)) ||
      (plan && !plan.is_stale),
    )
    const actualQty = card.actual_harvest?.actual_quantity_kg
    const actualBelow = actualQty !== undefined && actualQty < totalRequested
    const adjustedAfterActual = Boolean(card.actual_harvest && adjustments.some(a => a.actual_harvest_id === card.actual_harvest?.actual_harvest_id))
    const step = nextCoordinatorStep({
      hasFarmData: Boolean(card.latest_estimate || card.telemetry.observation_count_7d > 0),
      hasEstimate: Boolean(card.latest_estimate),
      hasPrediction: Boolean(card.latest_prediction),
      predictionUnavailable: card.prediction_state?.status === 'unavailable',
      hasRiskOrPlan: hasRisk,
      planStale: Boolean(plan?.is_stale),
      hasAvailability: Boolean(card.approval),
      approvedBasisType: card.approval?.basis_type,
      hasActual: Boolean(card.actual_harvest),
      actualBelowAllocation: actualBelow,
      allocationAdjustedAfterActual: adjustedAfterActual,
      allReceiptsConfirmed,
      hasFeedback: feedback.length > 0,
    })
    return { card, step }
  })
  const primaryAction = nextSteps.find(item => item.step.key !== 'complete') ?? nextSteps[0]

  const attentionItems: { key: string; farmName: string; detail: string; actionLabel: string; onClick: () => void }[] = []
  for (const card of plantings) {
    if (card.latest_prediction && card.latest_estimate) {
      const diff = card.latest_prediction.predicted_quantity_kg - card.latest_estimate.estimated_quantity_kg
      if (Math.abs(diff) >= 0.5) {
        attentionItems.push({
          key: `diff-${card.farm.farm_id}-${card.crop.crop_id}`,
          farmName: card.farm.name,
          detail: `${cropName(card.crop.crop_id)}: hasil prediksi ${diff < 0 ? 'lebih rendah' : 'lebih tinggi'} ${kg(Math.abs(diff))} kg dari perkiraan petani`,
          actionLabel: 'Tinjau kebun',
          onClick: () => go('detail-kebun', { farmId: card.farm.farm_id, cropId: card.crop.crop_id }),
        })
      }
    }
    if (card.prediction_state?.status === 'unavailable') {
      attentionItems.push({
        key: `unavail-${card.farm.farm_id}-${card.crop.crop_id}`,
        farmName: card.farm.name,
        detail: `${cropName(card.crop.crop_id)}: data belum cukup untuk prediksi, gunakan perkiraan petani`,
        actionLabel: 'Buka rencana',
        onClick: () => go('rencana'),
      })
    }
  }
  const attentionFarms = farms.filter(f => f.telemetry.status !== 'online')

  return <div className="stack">
    {query.error && <Notice tone="error">
      {query.error} {query.stale && '(menampilkan data terakhir)'} <Button variant="text" onClick={query.reload}>Muat ulang</Button>
    </Notice>}

    <div className="kpi-grid">
      <div className="kpi-card">
        <span className="kpi-label">Prediksi panen</span>
        <strong className="kpi-value">{hasAnyPrediction ? `${kg(totalPredicted)} kg` : 'Belum ada'}</strong>
        <span className="kpi-sub">
          {commoditySummaries.length ? `${commoditySummaries.length} komoditas · ${farms.length} kebun` : `${totalPlantings} kebun aktif`}
        </span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Kebutuhan mingguan</span>
        <strong className="kpi-value">{totalDemand !== null ? `${kg(totalDemand)} kg` : 'Belum diisi'}</strong>
        <span className="kpi-sub">{weekLabel(period)} · {periodDates(period, true)}</span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Potensi kekurangan</span>
        <strong className={`kpi-value ${totalShortage && totalShortage > 0 ? 'text-shortage' : ''}`}>
          {totalShortage === null ? 'Belum dinilai' : `${kg(totalShortage)} kg`}
        </strong>
        <span className="kpi-sub">
          {totalShortage === null ? 'Tentukan kebutuhan di Rencana Panen' : totalShortage > 0 ? 'Perlu ditinjau' : 'Mencukupi kebutuhan'}
        </span>
      </div>
      <div className="kpi-card">
        <span className="kpi-label">Ditawarkan kepada anggota</span>
        <strong className="kpi-value">{approvals.length > 0 ? `${kg(totalOffered)} kg` : 'Pilihan belum dibuka'}</strong>
        <span className="kpi-sub">
          {approvals.length > 0 ? `${approvals.length}/${totalPlantings} sumber dibuka` : 'Atur penawaran di Rencana Panen'}
        </span>
      </div>
    </div>

    <div className="two-col-wide">
      <Card title="Pasokan per komoditas">
        {commoditySummaries.length ? <div className="commodity-bars">
          {commoditySummaries.map(item => (
            <div key={item.cropId} className="commodity-bar-row">
              <div className="row-between">
                <strong>{cropName(item.cropId)}</strong>
                <strong className="tabular">
                  {item.predictedCount > 0 ? `${kg(item.predictedTotal)} kg` : item.estimateTotal > 0 ? `${kg(item.estimateTotal)} kg (est.)` : 'Belum ada'}
                  {item.demand !== null && ` / ${kg(item.demand)} kg`}
                </strong>
              </div>
              <ProgressBar
                value={item.predictedCount > 0 ? item.predictedTotal : item.estimateTotal}
                max={Math.max(item.demand ?? 0, item.predictedTotal, item.estimateTotal, 1)}
                tone={item.gap && item.gap > 0 ? 'shortage' : 'good'}
                label={`Pasokan ${cropName(item.cropId)}`}
              />
              {item.gap !== null && item.gap > 0 && <p className="text-shortage">Potensi kekurangan {kg(item.gap)} kg</p>}
              <p className="muted-meta">
                {item.predictedCount > 0 ? 'Hasil prediksi' : 'Menunggu prediksi'} · {item.list.length} sumber pasokan
                {item.plan?.is_stale && ' · Tinjauan perlu diperbarui'}
              </p>
            </div>
          ))}
        </div> : <Empty>Belum ada kebun atau komoditas aktif untuk periode ini.</Empty>}
      </Card>

      <Card title="Tindak lanjut">
        {primaryAction ? <div className="action-card-body">
          <strong>{primaryAction.step.label}</strong>
          <p className="muted-meta">{primaryAction.step.reason}</p>
          {primaryAction.step.action && (
            <Button onClick={() => go(primaryAction.step.action!, {
              farmId: primaryAction.card.farm.farm_id, cropId: primaryAction.card.crop.crop_id,
            })}>
              {primaryAction.step.action === 'rencana' ? 'Buka Rencana Panen' : primaryAction.step.label}
            </Button>
          )}
        </div> : <Empty>Belum ada tindak lanjut untuk periode ini.</Empty>}
      </Card>
    </div>

    {attentionFarms.length > 0 && <div className="two-col-equal">
      {attentionFarms.map(fg => (
        <SensorSummary key={fg.farm.farm_id} compact farmName={fg.farm.name} telemetry={fg.telemetry}
          onViewMonitoring={() => go('pemantauan', { farmId: fg.farm.farm_id, cropId: fg.plantings[0]?.crop.crop_id ?? 'SPINACH' })} />
      ))}
    </div>}

    <Card title="Kebun yang perlu perhatian">
      {attentionItems.length ? <ul className="attention-list">
        {attentionItems.map(item => <li key={item.key}>
          <div className="attention-main">
            <strong>{item.farmName}</strong>
            <span>{item.detail}</span>
          </div>
          <Button variant="text" onClick={item.onClick}>{item.actionLabel} <Symbol name="chevron.right" /></Button>
        </li>)}
      </ul> : <Empty>Tidak ada selisih pasokan yang perlu ditindaklanjuti saat ini.</Empty>}
    </Card>
  </div>
}
