import { useState } from 'react'
import { Droplets, Gauge, Sprout, Thermometer } from 'lucide-react'
import { dateTime, kg, relativeTime, type Observation, type TelemetrySummary } from './contracts'
import { Button, Chip, CopyId, Empty } from './ui'

const statusBadges: Record<TelemetrySummary['status'], { label: string; tone: 'good' | 'warn' | 'shortage' | 'neutral' }> = {
  online: { label: 'Aktif', tone: 'good' },
  stale: { label: 'Terlambat', tone: 'warn' },
  offline: { label: 'Offline', tone: 'shortage' },
  unknown: { label: 'Belum ada data', tone: 'neutral' },
}

const sourceLabels: Record<Observation['source'], string> = {
  iot: 'Sensor IoT',
  simulated_iot: 'Simulator IoT',
  manual: 'Manual',
  csv: 'CSV',
  external: 'Eksternal',
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null
  const w = 110
  const h = 28
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(0.5, max - min)
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 4) + 2
      const y = h - 4 - ((v - min) / span) * (h - 8)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Tren ${label}`}>
      <polyline fill="none" points={pts} className="sparkline-line" />
    </svg>
  )
}

export function SensorSummary({
  farmName,
  telemetry,
  onViewMonitoring,
  compact = false,
}: {
  farmName: string
  telemetry: TelemetrySummary
  onViewMonitoring?: () => void
  compact?: boolean
}) {
  const badge = statusBadges[telemetry.status]
  const r = telemetry.readings
  const sp = telemetry.sparklines ?? {
    air_temperature: [],
    relative_humidity: [],
    soil_moisture_index: [],
    pressure: [],
  }

  const fmt = (val: number | null | undefined, unit: string, decimals = 1) => {
    if (val === null || val === undefined) return 'Belum tersedia'
    return `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: decimals }).format(val)}${unit}`
  }

  const tiles = [
    {
      key: 'air_temperature',
      label: 'Suhu udara',
      value: fmt(r.air_temperature, ' °C', 1),
      Icon: Thermometer,
      points: sp.air_temperature,
      warn: r.air_temperature !== null && r.air_temperature >= 32,
    },
    {
      key: 'relative_humidity',
      label: 'Kelembapan udara',
      value: fmt(r.relative_humidity, '%', 1),
      Icon: Droplets,
      points: sp.relative_humidity,
      warn: false,
    },
    {
      key: 'soil_moisture_index',
      label: 'Kelembapan tanah',
      value: fmt(r.soil_moisture_index, '%', 0),
      Icon: Sprout,
      points: sp.soil_moisture_index,
      warn: r.soil_moisture_index !== null && r.soil_moisture_index <= 25,
    },
    {
      key: 'pressure',
      label: 'Tekanan udara',
      value: fmt(r.pressure, ' hPa', 0),
      Icon: Gauge,
      points: sp.pressure,
      warn: false,
    },
  ]

  return (
    <section className={`card ${compact ? 'card--compact' : ''}`}>
      <header className="card-header">
        <div>
          <h2>Kondisi kebun</h2>
          <p className="card-subtitle">{farmName}</p>
        </div>
        <Chip tone={badge.tone}>{badge.label}</Chip>
      </header>

      <div className="sensor-tiles-grid">
        {tiles.map(({ key, label, value, Icon, points, warn }) => (
          <div key={key} className={`sensor-tile ${warn ? 'sensor-tile--warn' : ''}`}>
            <div className="sensor-tile-head">
              <Icon className="sensor-tile-icon" aria-hidden="true" strokeWidth={1.75} />
              <span>{label}</span>
            </div>
            <strong className={`sensor-tile-val ${warn ? 'text-shortage' : ''}`}>{value}</strong>
            {!compact && <Sparkline values={points} label={label} />}
          </div>
        ))}
      </div>

      <div className="card-footer-row">
        <span className="muted-meta">
          Pembaruan terakhir: {telemetry.last_observed_at ? relativeTime(telemetry.last_observed_at) : 'Belum tersedia'}
        </span>
        {onViewMonitoring && (
          <Button variant="text" onClick={onViewMonitoring}>
            Lihat pemantauan ›
          </Button>
        )}
      </div>
    </section>
  )
}

export function DeviceStatusCard({
  farmName,
  telemetry,
  rawObservations,
  rawLoading,
  rawOffset,
  onToggleRaw,
  showRaw,
  onPrevRaw,
  onNextRaw,
}: {
  farmName: string
  telemetry: TelemetrySummary
  rawObservations: Observation[]
  rawLoading: boolean
  rawOffset: number
  showRaw: boolean
  onToggleRaw: () => void
  onPrevRaw: () => void
  onNextRaw: () => void
}) {
  const badge = statusBadges[telemetry.status]
  const sourceText =
    telemetry.provenance === 'mqtt_public_unverified'
      ? 'ESP32 / MQTT publik (identitas belum terverifikasi)'
      : telemetry.source === 'simulated_iot'
        ? 'Simulator lokal'
        : telemetry.source
          ? sourceLabels[telemetry.source]
          : 'Belum ada perangkat'

  const intervalText = (() => {
    const cfg = telemetry.configured_interval_seconds
    const obs = telemetry.observed_interval_seconds
    if (cfg && obs) return `Terjadwal ${cfg} dtk · Teramati ${obs} dtk`
    if (cfg) return `Terjadwal ${cfg} detik`
    if (obs) return `Teramati ${obs} detik`
    return 'Belum tersedia'
  })()

  return (
    <section className="card">
      <header className="card-header">
        <div>
          <h2>Status perangkat</h2>
          <p className="card-subtitle">
            {farmName}
            {telemetry.device_id ? ` · ${telemetry.device_id}` : ''} · {sourceText}
          </p>
        </div>
        <div className="toolbar-group">
          <Chip tone={badge.tone}>{badge.label}</Chip>
          <Chip tone={telemetry.inference_ready ? 'good' : 'warn'}>
            {telemetry.inference_ready ? 'Kelengkapan data: cukup' : 'Data belum cukup'}
          </Chip>
        </div>
      </header>

      <div className="device-metrics-grid">
        <div>
          <span className="kpi-label">Pembaruan terakhir</span>
          <strong className="metric-medium">
            {telemetry.last_observed_at ? relativeTime(telemetry.last_observed_at) : 'Belum tersedia'}
          </strong>
          {telemetry.last_observed_at && <span className="kpi-sub">{dateTime(telemetry.last_observed_at)}</span>}
        </div>
        <div>
          <span className="kpi-label">Interval pengiriman</span>
          <strong className="metric-medium">{intervalText}</strong>
        </div>
        <div>
          <span className="kpi-label">Rekaman tersimpan (7 hari)</span>
          <strong className="metric-medium tabular">{telemetry.observation_count_7d}</strong>
        </div>
      </div>

      <div className="card-footer-row">
        <span className="muted-meta">
          Cakupan 7 hari: Suhu {Math.round(telemetry.coverage.air_temperature.coverage * 100)}% · Kelembapan{' '}
          {Math.round(telemetry.coverage.relative_humidity.coverage * 100)}% · Tanah{' '}
          {Math.round(telemetry.coverage.soil_moisture_index.coverage * 100)}%
        </span>
        <Button variant="text" onClick={onToggleRaw} aria-expanded={showRaw}>
          {showRaw ? 'Tutup data' : 'Lihat data ›'}
        </Button>
      </div>

      {showRaw && (
        <div className="raw-table-wrap">
          {rawLoading ? (
            <p className="empty">Memuat riwayat pengukuran…</p>
          ) : rawObservations.length ? (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Waktu</th>
                    <th>Sumber</th>
                    <th>Perangkat</th>
                    <th>Pengukuran</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {rawObservations.map(row => (
                    <tr key={row.observation_id}>
                      <td>{dateTime(row.observed_at)}</td>
                      <td>
                        <Chip>{sourceLabels[row.source]}</Chip>
                      </td>
                      <td>{row.device_id ?? '—'}</td>
                      <td>{row.measurements.map(m => `${m.type}: ${kg(m.value)} ${m.unit}`).join(', ')}</td>
                      <td>
                        <CopyId value={row.observation_id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pagination-row">
                <Button variant="secondary" disabled={rawOffset === 0} onClick={onPrevRaw}>
                  Sebelumnya
                </Button>
                <Button variant="secondary" disabled={rawObservations.length < 25} onClick={onNextRaw}>
                  Berikutnya
                </Button>
              </div>
            </>
          ) : (
            <Empty>Belum ada riwayat pengukuran untuk kebun ini.</Empty>
          )}
        </div>
      )}
    </section>
  )
}
