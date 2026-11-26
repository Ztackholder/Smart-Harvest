import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, ChartLine, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleUserRound,
  ClipboardList, FileText, History, LayoutGrid, Leaf, LogOut, MessageSquare, Minus, Package, Plus, Radio, RefreshCw, Search,
  ShoppingBasket, Sprout, TriangleAlert,
} from 'lucide-react'
import { ApiError } from './contracts'

const webSymbols = {
  'square.grid.2x2': LayoutGrid,
  'chart.line.uptrend.xyaxis': ChartLine,
  basket: ShoppingBasket,
  shippingbox: Package,
  leaf: Leaf,
  sprout: Sprout,
  'list.bullet.clipboard': ClipboardList,
  'bubble.left': MessageSquare,
  'arrow.triangle.2.circlepath': RefreshCw,
  calendar: CalendarDays,
  'chevron.down': ChevronDown,
  'chevron.left': ChevronLeft,
  'chevron.right': ChevronRight,
  'arrow.up.right': ArrowUpRight,
  'arrow.right': ArrowRight,
  plus: Plus,
  minus: Minus,
  search: Search,
  history: History,
  logout: LogOut,
  'exclamationmark.triangle': TriangleAlert,
  'checkmark.circle': CircleCheck,
  'antenna.radiowaves.left.and.right': Radio,
  'person.crop.circle': CircleUserRound,
  'doc.text': FileText,
  checkmark: Check,
}

export type SymbolName = keyof typeof webSymbols

export function Symbol({ name }: { name: SymbolName }) {
  const WebIcon = webSymbols[name]
  return <WebIcon aria-hidden="true" focusable="false" className="symbol" strokeWidth={1.75} />
}

export function Button({ icon, variant = 'primary', className = '', children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: SymbolName; variant?: 'primary' | 'secondary' | 'text' }) {
  return <button type="button" {...props} className={`button button--${variant} ${className}`}>
    {icon && <Symbol name={icon} />}{children}
  </button>
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'shortage' }) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}

export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'shortage' | 'error' }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'good' && <Symbol name="checkmark.circle" />}
    {(tone === 'error' || tone === 'warn' || tone === 'shortage') && <Symbol name="exclamationmark.triangle" />}
    <div>{children}</div>
  </div>
}

export function Field({ label, hint, children, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: string; children?: ReactNode
}) {
  const labelId = useId()
  const hintId = useId()
  const inputMode = props.inputMode ?? (props.type === 'number' ? (props.step === 'any' ? 'decimal' : 'numeric') : undefined)
  return <label className="field">
    <span id={labelId}>{label}</span>
    {children ?? <input {...props} inputMode={inputMode} aria-labelledby={labelId} aria-describedby={hint ? hintId : props['aria-describedby']} />}
    {hint && <small id={hintId}>{hint}</small>}
  </label>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function Card({ title, subtitle, actions, className = '', children }: {
  title?: string; subtitle?: string; actions?: ReactNode; className?: string; children: ReactNode
}) {
  const id = useId()
  return <section className={`card ${className}`} aria-labelledby={title ? id : undefined}>
    {(title || actions) && <header className="card-header">
      <div>{title && <h2 id={id}>{title}</h2>}{subtitle && <p className="card-subtitle">{subtitle}</p>}</div>
      {actions}
    </header>}
    {children}
  </section>
}

export function ProgressBar({ value, max, tone = 'good', label }: {
  value: number; max: number; tone?: 'good' | 'warn' | 'shortage'; label?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return <div className="bar-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
    <span className={`bar-fill bar-fill--${tone}`} style={{ width: `${pct}%` }} />
  </div>
}

export function LineChart({ points, unit, height = 136, label }: {
  points: { label: string; value: number | null }[]; unit: string; height?: number; label: string
}) {
  const valid = points.map((p, i) => (p.value !== null && Number.isFinite(p.value) ? { ...p, i, value: p.value } : null))
  const numeric = valid.filter((p): p is { label: string; value: number; i: number } => p !== null)
  if (!numeric.length) {
    return <div className="chart-empty" role="img" aria-label={`${label}: belum ada data`}>Belum ada data pada rentang ini.</div>
  }
  const width = 460
  const padX = 12
  const padTop = 14
  const padBottom = 26
  const plotH = height - padTop - padBottom
  const plotW = width - padX * 2
  const minVal = Math.min(...numeric.map(p => p.value))
  const maxVal = Math.max(...numeric.map(p => p.value))
  const span = Math.max(1, maxVal - minVal)
  const low = minVal - span * 0.15
  const high = maxVal + span * 0.15
  const xFor = (i: number) => points.length <= 1 ? padX + plotW / 2 : padX + (i / (points.length - 1)) * plotW
  const yFor = (v: number) => padTop + plotH - ((v - low) / (high - low)) * plotH

  // Build disconnected segments so null intervals render truthfully as gaps (never 0)
  const segments: string[] = []
  let current: string[] = []
  for (let i = 0; i < valid.length; i++) {
    const pt = valid[i]
    if (pt) {
      current.push(`${xFor(pt.i).toFixed(1)},${yFor(pt.value).toFixed(1)}`)
    } else if (current.length) {
      segments.push(current.join(' '))
      current = []
    }
  }
  if (current.length) segments.push(current.join(' '))

  const tickIndices = points.length <= 4
    ? points.map((_, i) => i)
    : [0, Math.floor((points.length - 1) / 3), Math.floor(((points.length - 1) * 2) / 3), points.length - 1]

  return <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} (${unit})`}>
    {[0, 0.5, 1].map(frac => {
      const y = padTop + frac * plotH
      return <line key={frac} x1={padX} x2={width - padX} y1={y} y2={y} className="chart-grid" />
    })}
    {segments.map((pts, idx) => <polyline key={idx} fill="none" points={pts} className="chart-line" />)}
    {numeric.length <= 24 && numeric.map(pt =>
      <circle key={pt.i} cx={xFor(pt.i)} cy={yFor(pt.value)} r={3} className="chart-dot">
        <title>{`${pt.label}: ${pt.value} ${unit}`}</title>
      </circle>
    )}
    {tickIndices.map((idx, pos) => (
      <text key={`${idx}-${pos}`} x={xFor(idx)} y={height - 6}
        textAnchor={pos === 0 ? 'start' : pos === tickIndices.length - 1 ? 'end' : 'middle'}
        className="chart-axis">{points[idx]?.label ?? ''}</text>
    ))}
  </svg>
}

export function CopyId({ value }: { value: string }) {
  const [result, setResult] = useState<'copied' | 'failed'>()
  useEffect(() => {
    if (result !== 'copied') return
    const timeout = setTimeout(() => setResult(undefined), 1800)
    return () => clearTimeout(timeout)
  }, [result])
  return <span className="copy-control">
    <span className="copy-value">{value}</span>
    <button className="copy-id" type="button" aria-label={'Salin ' + value} onClick={async () => {
      try {
        await navigator.clipboard.writeText(value)
        setResult('copied')
      } catch {
        setResult('failed')
      }
    }}>{result === 'copied' ? 'Disalin' : 'Salin'}</button>
  </span>
}

export function useAction() {
  const busy = useRef(false)
  const [state, setState] = useState<{ pending: boolean; error?: string; status?: number }>({ pending: false })
  return {
    ...state,
    clear() { setState({ pending: false }) },
    submit(fn: (data: FormData) => Promise<void>) {
      return async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (busy.current) return
        const data = new FormData(event.currentTarget)
        busy.current = true
        setState({ pending: true })
        try {
          await fn(data)
          setState({ pending: false })
        } catch (error) {
          setState({
            pending: false,
            error: error instanceof Error ? error.message : 'Terjadi gangguan. Coba lagi.',
            status: error instanceof ApiError ? error.status : undefined,
          })
        } finally {
          busy.current = false
        }
      }
    },
  }
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  onAuthExpired?: () => void,
) {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data?: T; error?: string; status?: number; loading: boolean; stale: boolean }>({
    loading: true,
    stale: false,
  })
  const reqId = useRef(0)

  useEffect(() => {
    const id = ++reqId.current
    const controller = new AbortController()
    setState(prev => ({ ...prev, loading: !prev.data, error: undefined }))
    load(controller.signal).then(
      data => {
        if (reqId.current === id) setState({ data, loading: false, stale: false })
      },
      err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (reqId.current !== id) return
        if (err instanceof ApiError && err.status === 401 && onAuthExpired) {
          onAuthExpired()
          return
        }
        setState(prev => ({
          data: prev.data,
          loading: false,
          stale: Boolean(prev.data),
          error: err instanceof Error ? err.message : String(err),
          status: err instanceof ApiError ? err.status : undefined,
        }))
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  return {
    ...state,
    reload: () => setTick(n => n + 1),
  }
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current!
    const focused = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
    }
  }, [])
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="modal-body">
      <header className="modal-heading"><h2 id={id}>{title}</h2><Button variant="text" onClick={onClose}>Tutup</Button></header>
      {children}
    </div>
  </dialog>
}

export const value = (data: FormData, field: string) => String(data.get(field) ?? '').trim()
export const number = (data: FormData, field: string) => Number(value(data, field))
export const localDate = () => {
  const now = new Date()
  return new Date(+now - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export const isoDate = (data: FormData, field: string) => new Date(value(data, field)).toISOString()
