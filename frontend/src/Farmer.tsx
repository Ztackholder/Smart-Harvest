import { useState } from 'react'
import Papa from 'papaparse'
import { ApiError, cropName, dateTime, defaultCrop, defaultFarm, kg, shortDate, type Observation, type ObservationInput } from './contracts'
import { SensorSummary } from './SensorComponents'
import { Button, Card, Chip, CopyId, Empty, Field, Notice, Symbol, isoDate, localDate, number, useAction, useResource, value } from './ui'
import type { Workspace } from './workspace'

const measurements = [
  { type: 'air_temperature', label: 'Suhu udara', unit: 'C', min: -15, max: 60 },
  { type: 'relative_humidity', label: 'Kelembapan udara', unit: 'percent', min: 0, max: 100 },
  { type: 'soil_moisture_index', label: 'Kelembapan tanah', unit: 'percent', min: 0, max: 100 },
] as const

const units: Record<string, string> = { C: '°C', celsius: '°C', percent: '%', hPa: 'hPa', ADC: 'ADC' }
const sources: Record<Observation['source'], string> = {
  manual: 'Manual', csv: 'CSV', iot: 'Sensor IoT', simulated_iot: 'Simulator IoT', external: 'Eksternal',
}

function parseCsv(contents: string) {
  const parsed = Papa.parse<Record<string, string>>(contents, {
    header: true, skipEmptyLines: 'greedy', transformHeader: header => header.trim().toLowerCase(),
  })
  if (parsed.errors.length) throw new Error(`Format CSV bermasalah pada baris ${(parsed.errors[0].row ?? 0) + 2}.`)
  const required = ['farm_id', 'observed_at', 'type', 'value', 'unit']
  if (required.some(col => !parsed.meta.fields?.includes(col))) {
    throw new Error('Kolom wajib: farm_id, observed_at, type, value, dan unit.')
  }
  if (!parsed.data.length || parsed.data.length > 200) throw new Error('Gunakan CSV dengan 1–200 baris pengukuran.')
  const grouped = new Map<string, { rows: number[]; input: ObservationInput }>()
  parsed.data.forEach((row, index) => {
    const line = index + 2
    const farm_id = row.farm_id?.trim(), crop_id = row.crop_id?.trim() || undefined
    const observed_at = row.observed_at?.trim(), type = row.type?.trim(), unit = row.unit?.trim()
    const reading = Number(row.value)
    const spec = measurements.find(m => m.type === type)
    if (!farm_id || !observed_at || !/(Z|[+-]\d{2}:\d{2})$/i.test(observed_at) || !Number.isFinite(Date.parse(observed_at)) ||
      !row.value?.trim() || !spec || !Number.isFinite(reading) || reading < spec.min || reading > spec.max || unit !== spec.unit) {
      throw new Error(`Baris ${line} berisi ID, waktu, jenis, nilai, atau satuan yang tidak valid.`)
    }
    const key = JSON.stringify([farm_id, crop_id, Date.parse(observed_at)])
    const batch = grouped.get(key) ?? { rows: [], input: { farm_id, crop_id, observed_at, source: 'csv', measurements: [] } }
    if (batch.input.measurements.some(item => item.type === spec.type)) throw new Error(`Baris ${line} mengulang jenis pengukuran.`)
    batch.input.measurements.push({ type: spec.type, unit, value: reading })
    batch.rows.push(line)
    grouped.set(key, batch)
  })
  return [...grouped.values()]
}

/* --- 08. KEBUN SAYA (FARMER HOME) --- */
export function FarmerHome({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.farmerOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const [panelMode, setPanelMode] = useState<'none' | 'manual' | 'csv'>('none')
  const manualAction = useAction()
  const csvAction = useAction()
  const [savedObs, setSavedObs] = useState('')
  const [csvResults, setCsvResults] = useState<{ label: string; id?: string; message?: string }[]>([])

  const farms = query.data?.farms ?? []
  const plantings = query.data?.plantings ?? []
  const primaryFarm = farms[0]

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}

    <Card title="Panen mendatang"
      actions={<Button onClick={() => work.go('estimasi')}>
        {plantings.some(p => p.latest_estimate) ? 'Perbarui estimasi panen' : 'Laporkan estimasi'}
      </Button>}>
      {query.loading && !plantings.length ? <p className="empty">Memuat data kebun…</p> : plantings.length ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Komoditas</th>
              <th>Target panen</th>
              <th>Perkiraan saya</th>
              <th>Prediksi SmartHarvest</th>
            </tr>
          </thead>
          <tbody>
            {plantings.map(p => <tr key={`${p.farm.farm_id}:${p.crop.crop_id}`}>
              <td><strong>{cropName(p.crop.crop_id)}</strong><span className="kpi-sub"> · {p.farm.name}</span></td>
              <td>{shortDate(p.planting.target_harvest_date)}</td>
              <td className="tabular">{p.latest_estimate ? `${kg(p.latest_estimate.estimated_quantity_kg)} kg` : 'Belum diisi'}</td>
              <td className="tabular">{p.latest_prediction ? `${kg(p.latest_prediction.predicted_quantity_kg)} kg` : 'Belum tersedia'}</td>
            </tr>)}
          </tbody>
        </table>
      ) : <Empty>Belum ada data penanaman aktif untuk akun ini.</Empty>}
    </Card>

    {primaryFarm && (
      <SensorSummary
        farmName={primaryFarm.farm.name}
        telemetry={primaryFarm.telemetry}
        onViewMonitoring={() => work.go('pemantauan', { farmId: primaryFarm.farm.farm_id, cropId: plantings[0]?.crop.crop_id ?? defaultCrop })}
      />
    )}

    <Card title="Pelaporan data">
      <ul className="action-list">
        <li>
          <button type="button" className="action-row-btn" onClick={() => setPanelMode(m => m === 'manual' ? 'none' : 'manual')}>
            <div>
              <strong>Tambah observasi manual</strong>
              <span>Catat kondisi kebun jika sensor belum tersedia</span>
            </div>
            <Symbol name="chevron.right" />
          </button>
        </li>
        <li>
          <button type="button" className="action-row-btn" onClick={() => setPanelMode(m => m === 'csv' ? 'none' : 'csv')}>
            <div>
              <strong>Impor data CSV</strong>
              <span>Unggah beberapa rekaman pengukuran sekaligus</span>
            </div>
            <Symbol name="chevron.right" />
          </button>
        </li>
      </ul>

      {panelMode === 'manual' && <form className="form inline-drawer" onSubmit={manualAction.submit(async fd => {
        setSavedObs('')
        const readings = measurements.filter(m => value(fd, m.type) !== '')
          .map(m => ({ type: m.type, unit: m.unit, value: number(fd, m.type) }))
        if (!readings.length) throw new Error('Isi minimal satu pengukuran.')
        const res = await work.api.post('/farm-observations', {
          farm_id: primaryFarm?.farm.farm_id ?? defaultFarm,
          crop_id: value(fd, 'crop_id') || undefined,
          source: 'manual',
          observed_at: isoDate(fd, 'observed_at'),
          measurements: readings,
        })
        setSavedObs(res.observation_id)
        work.refresh()
      })}>
        <div className="form-grid">
          <Field label="Komoditas (opsional)">
            <select name="crop_id" defaultValue="">
              <option value="">Umum (semua komoditas)</option>
              {plantings.map(p => <option key={p.crop.crop_id} value={p.crop.crop_id}>{cropName(p.crop.crop_id)}</option>)}
            </select>
          </Field>
          <Field label="Waktu pengamatan" name="observed_at" type="datetime-local" defaultValue={localDate()} required />
        </div>
        <div className="form-grid">
          {measurements.map(m => <Field key={m.type} label={`${m.label} (${units[m.unit]})`} name={m.type}
            type="number" step="any" min={m.min} max={m.max} />)}
        </div>
        {manualAction.error && <Notice tone="error">{manualAction.error}</Notice>}
        {savedObs && <Notice tone="good">Observasi tersimpan.</Notice>}
        <Button type="submit" disabled={manualAction.pending}>{manualAction.pending ? 'Menyimpan…' : 'Simpan observasi'}</Button>
      </form>}

      {panelMode === 'csv' && <form className="form inline-drawer" onSubmit={csvAction.submit(async fd => {
        setCsvResults([])
        const file = fd.get('observations')
        if (!(file instanceof File) || !file.size || file.size > 512_000) throw new Error('Pilih berkas CSV maksimal 500 KB.')
        const batches = parseCsv(await file.text())
        for (const batch of batches) {
          const label = `Baris ${batch.rows.join(', ')}`
          try {
            const res = await work.api.post('/farm-observations', batch.input)
            setCsvResults(cur => [...cur, { label, id: res.observation_id }])
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Pengiriman gagal.'
            setCsvResults(cur => [...cur, { label, message: msg }])
            if (err instanceof ApiError && [0, 401, 403].includes(err.status)) throw err
          }
        }
        work.refresh()
      })}>
        <Field label="Berkas CSV observasi" name="observations" type="file" accept=".csv,text/csv" required
          hint="Maksimal 200 baris, sertakan zona waktu pada kolom observed_at." />
        <div className="toolbar-group">
          <Button type="submit" disabled={csvAction.pending}>{csvAction.pending ? 'Mengimpor…' : 'Impor CSV'}</Button>
          <a className="text-link" href={import.meta.env.BASE_URL + 'contoh-observasi.csv'} download>Unduh contoh CSV</a>
        </div>
        {csvAction.error && <Notice tone="error">{csvAction.error}</Notice>}
        {csvResults.length > 0 && <ul className="simple-list">{csvResults.map(row => <li key={row.label}>
          <strong>{row.label}</strong>
          <span>{row.id ? <>Tersimpan · <CopyId value={row.id} /></> : row.message}</span>
        </li>)}</ul>}
      </form>}
    </Card>
  </div>
}

/* --- ESTIMASI PANEN (FARMER) --- */
export function FarmerEstimates({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.farmerOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const action = useAction()
  const [saved, setSaved] = useState('')
  const plantings = query.data?.plantings ?? []
  const estimates = plantings.flatMap(p => p.estimates)

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    <div className="two-col-equal">
      <Card title="Laporkan estimasi panen">
        <form className="form" onSubmit={action.submit(async fd => {
          setSaved('')
          const [farm_id, crop_id] = value(fd, 'scope').split(':')
          const res = await work.api.post('/harvest-estimates', {
            farm_id: farm_id || defaultFarm,
            crop_id: crop_id || defaultCrop,
            harvest_period: work.period,
            estimated_quantity_kg: number(fd, 'quantity'),
            recorded_at: new Date().toISOString(),
          })
          setSaved(res.estimate_id)
          work.refresh()
        })}>
          <Field label="Kebun & komoditas">
            <select name="scope" required defaultValue={plantings[0] ? `${plantings[0].farm.farm_id}:${plantings[0].crop.crop_id}` : `${defaultFarm}:${defaultCrop}`}>
              {plantings.length ? plantings.map(p => (
                <option key={`${p.farm.farm_id}:${p.crop.crop_id}`} value={`${p.farm.farm_id}:${p.crop.crop_id}`}>
                  {p.farm.name} · {cropName(p.crop.crop_id)}
                </option>
              )) : <option value={`${defaultFarm}:${defaultCrop}`}>Kebun Demo · Bayam</option>}
            </select>
          </Field>
          <Field label="Perkiraan hasil panen (kg)" name="quantity" type="number" min={0} step="any" required />
          {action.error && <Notice tone="error">{action.error}</Notice>}
          {saved && <Notice tone="good">Perkiraan panen berhasil disimpan.</Notice>}
          <Button type="submit" disabled={action.pending}>{action.pending ? 'Menyimpan…' : 'Simpan estimasi'}</Button>
        </form>
      </Card>

      <Card title="Estimasi tercatat">
        {estimates.length ? <ul className="simple-list">
          {estimates.map(est => <li key={est.estimate_id}>
            <div className="row-between"><strong>{cropName(est.crop_id)}</strong><strong className="tabular">{kg(est.estimated_quantity_kg)} kg</strong></div>
            <span className="muted-meta">{dateTime(est.recorded_at)} · <Chip tone="good">Tercatat</Chip></span>
          </li>)}
        </ul> : <Empty>Belum ada estimasi yang dikirim untuk periode ini.</Empty>}
      </Card>
    </div>
  </div>
}

/* --- RIWAYAT PETANI --- */
export function FarmerHistory({ work }: { work: Workspace }) {
  const query = useResource(
    signal => work.api.farmerOverview(work.period, signal),
    [work.api, work.period, work.revision],
    work.onAuthExpired,
  )
  const obs = query.data?.recent_observations ?? []
  const estimates = query.data?.plantings.flatMap(p => p.estimates) ?? []

  return <div className="stack">
    {query.error && <Notice tone="error">{query.error} <Button variant="text" onClick={query.reload}>Muat ulang</Button></Notice>}
    <Card title="Riwayat estimasi panen">
      {estimates.length ? <ul className="simple-list">
        {estimates.map(est => <li key={est.estimate_id}>
          <div className="row-between"><strong>{cropName(est.crop_id)} ({est.harvest_period})</strong><strong className="tabular">{kg(est.estimated_quantity_kg)} kg</strong></div>
          <span className="muted-meta">{dateTime(est.recorded_at)}</span>
        </li>)}
      </ul> : <Empty>Belum ada riwayat estimasi untuk periode ini.</Empty>}
    </Card>
    <Card title="Riwayat pengukuran">
      {obs.length ? <ul className="simple-list">
        {obs.map(row => <li key={row.observation_id}>
          <div className="row-between">
            <strong>{dateTime(row.observed_at)}</strong>
            <Chip>{sources[row.source]}</Chip>
          </div>
          <span className="muted-meta">
            {row.measurements.map(m => `${m.type}: ${kg(m.value)} ${units[m.unit] ?? m.unit}`).join(' · ')}
          </span>
        </li>)}
      </ul> : <Empty>Belum ada pengukuran yang tersimpan.</Empty>}
    </Card>
  </div>
}
