import { useEffect, useState } from 'react'
import { type Observation } from './contracts'
import { DeviceStatusCard, SensorSummary } from './SensorComponents'
import { Button, Card, Empty, LineChart, Notice, useResource } from './ui'
import type { Workspace } from './workspace'

type RangeKey = '1h' | '24h' | '7d'

function formatAxisLabel(iso: string, range: RangeKey) {
  const date = new Date(iso)
  if (range === '7d') {
    return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }).format(date)
  }
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).format(date)
}

export function Monitoring({ work }: { work: Workspace }) {
  const authorizedFarms = work.account.farmIds?.length
    ? work.catalog.farms.filter(f => work.account.farmIds!.includes(f.farm_id))
    : work.catalog.farms

  const preferredFarm = work.focus?.farmId && authorizedFarms.some(f => f.farm_id === work.focus?.farmId)
    ? work.focus.farmId
    : authorizedFarms[0]?.farm_id ?? ''

  const [farmId, setFarmId] = useState(preferredFarm)
  const [range, setRange] = useState<RangeKey>('24h')
  const [showRaw, setShowRaw] = useState(false)
  const [rawOffset, setRawOffset] = useState(0)
  const [pollTick, setPollTick] = useState(0)

  // Reset farm selection whenever account or authorized farms change (B09)
  const effectiveFarmId = authorizedFarms.some(f => f.farm_id === farmId) ? farmId : (authorizedFarms[0]?.farm_id ?? '')
  useEffect(() => {
    if (effectiveFarmId !== farmId) {
      setFarmId(effectiveFarmId)
      setRawOffset(0)
    }
  }, [effectiveFarmId, farmId])

  const summaryQ = useResource(
    async signal => {
      if (!effectiveFarmId) return null
      return work.api.telemetrySummary(effectiveFarmId, signal)
    },
    [work.api, work.account.userId, effectiveFarmId, work.revision, pollTick],
    work.onAuthExpired,
  )
  const historyQ = useResource(
    async signal => {
      if (!effectiveFarmId) return null
      return work.api.telemetryHistory(effectiveFarmId, range, 'all', signal)
    },
    [work.api, work.account.userId, effectiveFarmId, range, work.revision],
    work.onAuthExpired,
  )
  const rawQ = useResource(
    async signal => {
      void signal
      if (!showRaw || !effectiveFarmId) return { items: [] as Observation[] }
      return work.api.observations(effectiveFarmId, 25, rawOffset)
    },
    [work.api, work.account.userId, effectiveFarmId, showRaw, rawOffset, work.revision],
    work.onAuthExpired,
  )

  const forbidden = summaryQ.status === 403 || historyQ.status === 403
  useEffect(() => {
    if (!effectiveFarmId || forbidden) return
    const timer = window.setInterval(() => setPollTick(n => n + 1), 15_000)
    return () => window.clearInterval(timer)
  }, [effectiveFarmId, forbidden])

  if (!authorizedFarms.length) {
    return <Card title="Pemantauan kebun">
      <Empty>Belum ada kebun yang terhubung dengan akun Anda. Hubungi pengelola untuk menghubungkan akun ke kebun.</Empty>
    </Card>
  }

  const summary = summaryQ.data ?? undefined
  const history = historyQ.data ?? undefined
  const farmObj = authorizedFarms.find(f => f.farm_id === effectiveFarmId)
  const farmName = farmObj?.name ?? effectiveFarmId
  const series = history?.series ?? []

  const chartPoints = (key: 'air_temperature' | 'relative_humidity' | 'soil_moisture_index' | 'pressure') =>
    series.map(pt => ({ label: formatAxisLabel(pt.timestamp, range), value: pt[key] }))

  return <div className="stack">
    {(summaryQ.error || historyQ.error) && <Notice tone="error">
      {summaryQ.error ?? historyQ.error}{' '}
      <Button variant="text" onClick={() => {
        if (forbidden && authorizedFarms[0]) setFarmId(authorizedFarms[0].farm_id)
        else { summaryQ.reload(); historyQ.reload() }
      }}>
        {forbidden ? 'Kembali ke kebun Anda' : 'Muat ulang'}
      </Button>
    </Notice>}

    <div className="toolbar-row">
      <div className="toolbar-group">
        {authorizedFarms.length > 1 ? (
          <select className="compact-select" aria-label="Pilih kebun" value={effectiveFarmId}
            onChange={e => { setFarmId(e.target.value); setRawOffset(0) }}>
            {authorizedFarms.map(f => <option key={f.farm_id} value={f.farm_id}>{f.name}</option>)}
          </select>
        ) : (
          <strong className="toolbar-farm-label">{farmName}{farmObj?.farmer_name ? ` · ${farmObj.farmer_name}` : ''}</strong>
        )}
        <span className="muted-meta">Rentang waktu</span>
        <div className="range-pills" role="group" aria-label="Rentang waktu grafik">
          {([['1h', '1 jam'], ['24h', '24 jam'], ['7d', '7 hari']] as const).map(([key, label]) => (
            <button key={key} type="button" className={`range-pill ${range === key ? 'range-pill--active' : ''}`}
              aria-pressed={range === key} onClick={() => setRange(key)}>{label}</button>
          ))}
        </div>
      </div>
      <Button variant="secondary" icon="arrow.triangle.2.circlepath" onClick={() => { summaryQ.reload(); historyQ.reload() }}>
        Muat ulang
      </Button>
    </div>

    {summary && <SensorSummary farmName={farmName} telemetry={summary} />}

    <div className="two-col-equal">
      <Card title="Tren suhu udara" subtitle="°C">
        <LineChart points={chartPoints('air_temperature')} unit="°C" label="Grafik suhu udara" />
      </Card>
      <Card title="Tren kelembapan udara" subtitle="%">
        <LineChart points={chartPoints('relative_humidity')} unit="%" label="Grafik kelembapan udara" />
      </Card>
      <Card title="Tren kelembapan tanah" subtitle="%">
        <LineChart points={chartPoints('soil_moisture_index')} unit="%" label="Grafik kelembapan tanah" />
      </Card>
      <Card title="Tren tekanan udara" subtitle="hPa">
        <LineChart points={chartPoints('pressure')} unit="hPa" label="Grafik tekanan udara" />
      </Card>
    </div>

    {summary && <DeviceStatusCard
      farmName={farmName}
      telemetry={summary}
      rawObservations={rawQ.data?.items ?? []}
      rawLoading={rawQ.loading}
      rawOffset={rawOffset}
      showRaw={showRaw}
      onToggleRaw={() => setShowRaw(open => !open)}
      onPrevRaw={() => setRawOffset(o => Math.max(0, o - 25))}
      onNextRaw={() => setRawOffset(o => o + 25)}
    />}
  </div>
}
