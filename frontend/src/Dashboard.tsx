import { useCallback } from 'react'
import { cropName, dateTime, isSimulation, kg, periodDates } from './contracts'
import { Button, Empty, Heading, Panel, QueryMessage, Symbol, useQuery } from './ui'
import { latestPredictions, type Workspace } from './workspace'

export function Dashboard({ work }: { work: Workspace }) {
  const { period, api, activity, go, openPrediction, revision } = work
  const load = useCallback(() => { void revision; return api.availability(period) }, [api, period, revision])
  const availability = useQuery(load)
  const comparisons = latestPredictions(activity, period).map(row => ({
    row, risk: activity.risks.find(item => item.prediction_id === row.prediction_id),
  }))
  const shortages = comparisons.flatMap(({ row, risk }) =>
    risk && risk.shortage_gap_kg > 0 ? [{ row, risk }] : [])
  const maximum = Math.max(1, ...comparisons.flatMap(({ row, risk }) => [
    row.predicted_quantity_kg, risk?.planned_demand_kg ?? 0,
  ]))
  const step = 10 ** Math.floor(Math.log10(maximum)) / 2
  const scale = Math.ceil(maximum / step) * step
  const published = availability.data?.items.filter(row => row.status === 'APPROVED')

  return <div className="dashboard stack">
    <Heading title="Ringkasan panen" description={periodDates(period)}>
      {comparisons.length === 0 && <Button icon="arrow.up.right" onClick={() => openPrediction()}>Buka prediksi</Button>}
    </Heading>

    <div className="supply-overview">
      {shortages.length > 0 && <section className="supply-alert" aria-labelledby="risk-title">
        <h2 id="risk-title"><Symbol name="exclamationmark.triangle" />Risiko pasokan</h2>
        <ul>{shortages.map(({ row, risk }) => <li key={row.prediction_id}>
          <p><strong>{cropName(row.crop_id)}</strong> bisa kurang <strong>{kg(risk.shortage_gap_kg)} kg</strong>.</p>
          <Button variant="secondary" onClick={() => openPrediction(row.prediction_id)}
            aria-label={`Tinjau risiko ${cropName(row.crop_id)} dari ${row.farm_id}`}>
            Tinjau risiko <Symbol name="chevron.right" />
          </Button>
        </li>)}</ul>
      </section>}

      <Panel title="Prediksi dan kebutuhan" className="supply-comparison">
        {comparisons.length ? <>
          <ul className="chart-legend" aria-label="Legenda grafik">
            <li><span className="legend-forecast" aria-hidden="true" />Prediksi</li>
            <li><span className="legend-target" aria-hidden="true" />Target kebutuhan</li>
            <li className="chart-scale">0-{kg(scale)} kg</li>
          </ul>
          <table className="supply-table" aria-label="Perbandingan pasokan per komoditas" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">Komoditas</th>
                <th scope="col" role="columnheader">Perbandingan</th>
                <th scope="col" role="columnheader">Prediksi</th>
                <th scope="col" role="columnheader">Kebutuhan</th>
                <th scope="col" role="columnheader">Status</th>
              </tr>
            </thead>
            <tbody role="rowgroup">{comparisons.map(({ row, risk }) => {
              const crop = cropName(row.crop_id)
              const shortage = (risk?.shortage_gap_kg ?? 0) > 0
              return <tr key={row.prediction_id} className="supply-row" role="row">
                <th scope="row" role="rowheader" className="supply-crop">
                  <Button variant="text" onClick={() => openPrediction(row.prediction_id)}
                    aria-label={`Buka prediksi ${crop} dari ${row.farm_id}`}>{crop}</Button>
                  <span>{row.farm_id}</span>
                </th>
                <td className="supply-plot" role="cell">
                  <div className="supply-track" aria-hidden="true">
                    <span className="supply-fill" style={{ width: `${row.predicted_quantity_kg / scale * 100}%` }} />
                    {risk && <span className="supply-target" style={{ left: `clamp(1px, ${risk.planned_demand_kg / scale * 100}%, calc(100% - 1px))` }} />}
                  </div>
                </td>
                <td className="supply-forecast" role="cell">
                  <span className="supply-label" aria-hidden="true">Prediksi</span>
                  {kg(row.predicted_quantity_kg)} kg
                </td>
                <td className="supply-demand" role="cell">
                  <span className="supply-label" aria-hidden="true">Kebutuhan</span>
                  {risk ? `${kg(risk.planned_demand_kg)} kg` : 'Belum diisi'}
                </td>
                <td className={shortage ? 'supply-status supply-status--shortage' : 'supply-status'} role="cell">
                  {risk ? shortage ? `Kurang ${kg(risk.shortage_gap_kg)} kg` : 'Mencukupi' : 'Belum dinilai'}
                </td>
              </tr>
            })}</tbody>
          </table>
        </> : <Empty>Belum ada prediksi yang dibuka untuk periode ini.</Empty>}
      </Panel>

      <Panel title="Pasokan resmi" className="supply-published" actions={<Button variant="text" icon="chevron.right" aria-label="Kelola pasokan"
        onClick={() => go('ketersediaan')}>Kelola</Button>}>
        <QueryMessage {...availability} />
        {published?.length ? <ul className="published-list">{published.map(row => <li key={row.availability_id}>
          <div><strong>{cropName(row.crop_id)}</strong><span>{row.farm_id}</span></div>
          <strong>{kg(row.approved_quantity_kg)} kg</strong>
        </li>)}</ul> : published && <Empty>Belum ada ketersediaan resmi.</Empty>}
      </Panel>
    </div>
    {isSimulation && <footer className="source-note">
      <p>Prediksi memakai data sintetis. Observasi sensor berasal dari simulator.</p>
      {activity.observations.length > 0 && <p>Observasi terakhir <strong>{dateTime(activity.observations[0].observed_at)}</strong></p>}
    </footer>}
  </div>
}
