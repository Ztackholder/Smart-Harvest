import { useState } from 'react'
import Papa from 'papaparse'
import { ApiError, cropName, dateTime, defaultCrop, defaultFarm, isSimulation, kg, type ObservationInput } from './contracts'
import { Button, Chip, CopyId, Empty, Field, Heading, HistoryShortcut, Notice, Panel, isoDate, localDate, number, useAction, value } from './ui'
import type { Workspace } from './workspace'

export function FarmCropFields({ farm, crop, optionalCrop = false }: { farm?: string; crop?: string; optionalCrop?: boolean }) {
  return <div className="form-grid">
    <Field label="ID kebun" name="farm_id" placeholder="FARM-01" defaultValue={farm ?? (isSimulation ? defaultFarm : '')} required />
    <Field label={optionalCrop ? 'ID komoditas (opsional)' : 'ID komoditas'} name="crop_id" placeholder="SPINACH"
      defaultValue={crop ?? (isSimulation ? defaultCrop : '')} required={!optionalCrop} />
  </div>
}

const measurements = [
  { type: 'air_temperature', label: 'Suhu udara', unit: 'C', min: -50, max: 65 },
  { type: 'relative_humidity', label: 'Kelembapan udara', unit: 'percent', min: 0, max: 100 },
  { type: 'soil_moisture_index', label: 'Kelembapan tanah', unit: 'percent', min: 0, max: 100 },
] as const
const units: Record<string, string> = { C: '°C', celsius: '°C', percent: '%' }
const sources = { manual: 'Manual', csv: 'CSV', iot: 'Sensor IoT', simulated_iot: 'Simulator IoT' }

function ObservationForm({ work, simulated = false }: { work: Workspace; simulated?: boolean }) {
  const action = useAction()
  const [saved, setSaved] = useState('')
  return <form className="form" onSubmit={action.submit(async data => {
    setSaved('')
    const readings = measurements.filter(row => value(data, row.type) !== '')
      .map(row => ({ type: row.type, unit: row.unit, value: number(data, row.type) }))
    if (!readings.length) throw new Error('Isi minimal satu pengukuran.')
    const result = await work.api.post('/farm-observations', {
      farm_id: value(data, 'farm_id'), crop_id: value(data, 'crop_id') || undefined,
      source: simulated ? 'simulated_iot' : 'manual', device_id: simulated ? value(data, 'device_id') : undefined,
      observed_at: isoDate(data, 'observed_at'), measurements: readings,
    })
    work.remember('observations', result)
    setSaved(result.observation_id)
  })}>
    <FarmCropFields optionalCrop />
    <Field label="Waktu pengamatan" name="observed_at" type="datetime-local" defaultValue={localDate()} required />
    {simulated && <Field label="ID perangkat simulasi" name="device_id" defaultValue="SYN-ESP32-01" required />}
    <fieldset className="measurement-fields">
      <legend>Pengukuran</legend><p>Isi setidaknya satu nilai.</p>
      <div className="form-grid">{measurements.map((row, i) => <Field key={row.type} label={`${row.label} (${units[row.unit]})`} name={row.type}
        type="number" step="any" min={row.min} max={row.max} defaultValue={simulated ? [25.4, 70, 53][i] : undefined} />)}</div>
    </fieldset>
    {action.error && <Notice tone="error">{action.error}</Notice>}
    {saved && <Notice tone="good">Observasi tersimpan. <CopyId value={saved} /></Notice>}
    <Button type="submit" disabled={action.pending} icon={simulated ? 'antenna.radiowaves.left.and.right' : 'checkmark'}>
      {action.pending ? 'Mengirim…' : simulated ? 'Kirim pembacaan simulasi' : 'Simpan observasi'}
    </Button>
  </form>
}

const columns = ['farm_id', 'crop_id', 'observed_at', 'type', 'value', 'unit']
type CsvBatch = { line: number; rows: number[]; input: ObservationInput }
function parseCsv(contents: string) {
  const parsed = Papa.parse<Record<string, string>>(contents, {
    header: true, skipEmptyLines: 'greedy', transformHeader: header => header.trim().toLowerCase(),
  })
  if (parsed.errors.length) throw new Error(`Format CSV bermasalah pada baris ${(parsed.errors[0].row ?? 0) + 2}.`)
  if (columns.filter(column => column !== 'crop_id').some(column => !parsed.meta.fields?.includes(column))) {
    throw new Error('Kolom wajib: farm_id, observed_at, type, value, dan unit.')
  }
  if (!parsed.data.length || parsed.data.length > 200) throw new Error('Gunakan CSV dengan 1-200 baris pengukuran.')
  const grouped = new Map<string, CsvBatch>()
  parsed.data.forEach((row, index) => {
    const line = index + 2
    const farm_id = row.farm_id?.trim(), crop_id = row.crop_id?.trim() || undefined
    const observed_at = row.observed_at?.trim(), type = row.type?.trim(), unit = row.unit?.trim()
    const reading = Number(row.value)
    const spec = measurements.find(measurement => measurement.type === type)
    if (!farm_id || !observed_at || !/(Z|[+-]\d{2}:\d{2})$/i.test(observed_at) || !Number.isFinite(Date.parse(observed_at)) ||
        !row.value?.trim() || !spec || !Number.isFinite(reading) || reading < spec.min || reading > spec.max || unit !== spec.unit) {
      throw new Error(`Baris ${line} berisi ID, waktu, jenis, nilai, atau satuan yang tidak valid.`)
    }
    const key = JSON.stringify([farm_id, crop_id, Date.parse(observed_at)])
    const batch = grouped.get(key) ?? { line, rows: [], input: { farm_id, crop_id, observed_at, source: 'csv', measurements: [] } }
    if (batch.input.measurements.some(item => item.type === spec.type)) throw new Error(`Baris ${line} mengulang jenis pengukuran untuk waktu yang sama.`)
    batch.input.measurements.push({ type: spec.type, unit, value: reading })
    batch.rows.push(line)
    grouped.set(key, batch)
  })
  return [...grouped.values()]
}

function CsvForm({ work }: { work: Workspace }) {
  const action = useAction()
  const [results, setResults] = useState<{ label: string; id?: string; message?: string }[]>([])
  const [sent, setSent] = useState(new Set<string>())
  return <form className="form" onSubmit={action.submit(async data => {
    setResults([])
    const file = data.get('observations')
    if (!(file instanceof File) || !file.size || file.size > 512_000) throw new Error('Pilih berkas CSV berukuran maksimal 500 KB.')
    const batches = parseCsv(await file.text())
    for (const batch of batches) {
      const label = `Baris ${batch.rows.join(', ')}`
      const key = JSON.stringify(batch.input)
      if (sent.has(key)) {
        setResults(current => [...current, { label, message: 'Sudah dikirim dalam sesi impor ini.' }])
        continue
      }
      try {
        const result = await work.api.post('/farm-observations', batch.input)
        setSent(current => new Set(current).add(key))
        work.remember('observations', result)
        setResults(current => [...current, { label, id: result.observation_id }])
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Pengiriman gagal.'
        setResults(current => [...current, { label, message }])
        if (error instanceof ApiError && [0, 401, 403].includes(error.status)) {
          throw new Error('Impor dihentikan. Periksa hasil per baris dan koneksi atau akses API sebelum mencoba lagi.')
        }
      }
    }
  })}>
    <Field label="Berkas observasi" name="observations" type="file" accept=".csv,text/csv" required disabled={action.pending}
      hint="Maksimal 200 baris dan 500 KB. Sertakan zona waktu pada kolom observed_at." />
    <div className="form-actions">
      <Button type="submit" disabled={action.pending} icon="doc.text">{action.pending ? 'Mengimpor…' : 'Impor CSV'}</Button>
      <a href={import.meta.env.BASE_URL + 'contoh-observasi.csv'} download>Unduh contoh CSV</a>
    </div>
    {action.error && <Notice tone="error">{action.error}</Notice>}
    {results.length > 0 && <ul className="results-list" aria-label="Hasil impor" aria-live="polite">{results.map(row => <li key={row.label}>
      <strong>{row.label}</strong>{row.id ? <span>Tersimpan. <CopyId value={row.id} /></span> : <span>{row.message}</span>}
    </li>)}</ul>}
  </form>
}

type ObservationMode = 'Manual' | 'Impor CSV' | 'Simulator IoT'

export function Observations({ work }: { work: Workspace }) {
  const [mode, setMode] = useState<ObservationMode>('Manual')
  const modes: ObservationMode[] = ['Manual', 'Impor CSV', ...(isSimulation ? ['Simulator IoT' as const] : [])]
  return <div className="stack">
    <Heading title="Observasi kebun">
      {work.activity.observations.length > 0 && <HistoryShortcut target="observasi-tercatat">Lihat catatan</HistoryShortcut>}
    </Heading>
    <div className="work-columns">
      <Panel title="Kirim observasi">
        <div className="segmented" role="group" aria-label="Cara mengirim observasi">
          {modes.map(item => <Button key={item} variant="text" aria-pressed={mode === item} onClick={() => setMode(item)}>{item}</Button>)}
        </div>
        {mode === 'Impor CSV' ? <CsvForm work={work} /> :
          <ObservationForm key={mode} work={work} simulated={mode === 'Simulator IoT'} />}
      </Panel>
      <Panel id="observasi-tercatat" title="Observasi tercatat" description="Gunakan ID observasi sebagai referensi prediksi.">
        {work.activity.observations.length ? <ul className="records">{work.activity.observations.map(row => <li key={row.observation_id}>
          <div className="item-top"><strong>{row.farm_id}{row.crop_id && ` (${cropName(row.crop_id)})`}</strong><Chip>{sources[row.source]}</Chip></div>
          <p>{dateTime(row.observed_at)}</p>
          <dl className="reading-values">{row.measurements.map(reading => <div key={reading.type}>
            <dt>{measurements.find(item => item.type === reading.type)?.label ?? reading.type}</dt>
            <dd>{kg(reading.value)} {units[reading.unit] ?? reading.unit}</dd>
          </div>)}</dl>
          <CopyId value={row.observation_id} />
        </li>)}</ul> : <Empty>Belum ada observasi yang dikirim dalam sesi ini.</Empty>}
      </Panel>
    </div>
  </div>
}

export function Estimates({ work }: { work: Workspace }) {
  const action = useAction()
  const [saved, setSaved] = useState('')
  const rows = work.activity.estimates.filter(row => row.harvest_period === work.period)
  return <div className="stack">
    <Heading title="Estimasi panen" />
    <div className="work-columns">
      <Panel title="Kirim perkiraan">
        <form className="form" onSubmit={action.submit(async data => {
          setSaved('')
          const result = await work.api.post('/harvest-estimates', {
            farm_id: value(data, 'farm_id'), crop_id: value(data, 'crop_id'), harvest_period: work.period,
            estimated_quantity_kg: number(data, 'quantity'), recorded_at: new Date().toISOString(),
          })
          work.remember('estimates', result)
          setSaved(result.estimate_id)
        })}>
          <FarmCropFields />
          <Field label="Perkiraan hasil (kg)" name="quantity" type="number" min={0} step="any" required />
          {action.error && <Notice tone="error">{action.error}</Notice>}
          {saved && <Notice tone="good">Estimasi tersimpan. <CopyId value={saved} /></Notice>}
          <Button type="submit" disabled={action.pending}>{action.pending ? 'Menyimpan…' : 'Simpan estimasi'}</Button>
        </form>
      </Panel>
      <Panel title="Estimasi tercatat">
        {rows.length ? <ul className="records">{rows.map(row => <li key={row.estimate_id}>
          <div className="item-top"><strong>{cropName(row.crop_id)}</strong><strong>{kg(row.estimated_quantity_kg)} kg</strong></div>
          <p>{row.farm_id}, {dateTime(row.recorded_at)}</p><CopyId value={row.estimate_id} />
        </li>)}</ul> : <Empty>Belum ada estimasi yang dikirim untuk periode ini.</Empty>}
      </Panel>
    </div>
  </div>
}
