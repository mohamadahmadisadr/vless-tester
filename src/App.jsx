import { useState, useRef, useCallback } from 'react'
import { fetchConfigs, pingAll } from './pinger'
import './App.css'

const MAX_WORKING = 5
const CONCURRENCY = 30
const TIMEOUT_MS = 5000

function pingColor(ms) {
  if (ms <= 300) return 'fast'
  if (ms <= 700) return 'mid'
  return 'slow'
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
      {copied ? (
        <><CheckIcon /> Copied</>
      ) : (
        <><CopyIcon /> Copy</>
      )}
    </button>
  )
}

function ConfigCard({ result }) {
  const color = pingColor(result.pingMs)
  return (
    <div className="config-card">
      <div className={`ping-badge ping-${color}`}>
        {result.pingMs} ms
      </div>
      <div className="config-info">
        <div className="config-tag">
          {result.tag}
          {result.transport !== 'tcp' && (
            <span className="transport-pill">{result.transport}</span>
          )}
        </div>
        <div className="config-host">
          {result.host}:{result.port}
          {result.security !== 'none' && (
            <span className="security-pill">{result.security}</span>
          )}
        </div>
      </div>
      <CopyButton text={result.raw} />
    </div>
  )
}

function StatCard({ label, value, accent }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${accent ? `stat-${accent}` : ''}`}>{value}</div>
    </div>
  )
}

export default function App() {
  const [status, setStatus] = useState('idle') // idle | fetching | testing | done | stopped
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [tested, setTestedCount] = useState(0)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const testedRef = useRef(0)

  const fastest = results.length > 0 ? Math.min(...results.map(r => r.pingMs)) : null

  const handleResult = useCallback((result) => {
    testedRef.current += 1
    setTestedCount(testedRef.current)
    if (result.reachable) {
      setResults(prev => [...prev, result].sort((a, b) => a.pingMs - b.pingMs))
    }
  }, [])

  const start = async () => {
    setResults([])
    setError(null)
    setTestedCount(0)
    testedRef.current = 0
    setTotal(0)
    setStatus('fetching')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const configs = await fetchConfigs()
      if (controller.signal.aborted) return
      setTotal(configs.length)
      setStatus('testing')

      await pingAll({
        configs,
        concurrency: CONCURRENCY,
        timeoutMs: TIMEOUT_MS,
        maxWorking: MAX_WORKING,
        onResult: handleResult,
        signal: controller.signal,
      })

      setStatus(controller.signal.aborted ? 'stopped' : 'done')
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e.message)
        setStatus('idle')
      }
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setStatus('stopped')
  }

  const clear = () => {
    abortRef.current?.abort()
    setResults([])
    setTotal(0)
    setTestedCount(0)
    testedRef.current = 0
    setError(null)
    setStatus('idle')
  }

  const isRunning = status === 'fetching' || status === 'testing'
  const progress = total > 0 ? Math.min(100, Math.round(tested / total * 100)) : 0

  return (
    <div className="app">
      <div className="container">

        <header className="header">
          <div className="header-icon">
            <ShieldIcon />
          </div>
          <div>
            <h1>VLESS Config Tester</h1>
            <p>Tests configs on your connection · stops at {MAX_WORKING} working</p>
          </div>
        </header>

        <div className="actions">
          <button className="btn btn-primary" onClick={start} disabled={isRunning}>
            <PlayIcon />
            {isRunning ? 'Testing…' : 'Start testing'}
          </button>
          <button className="btn" onClick={stop} disabled={!isRunning}>
            <StopIcon />
            Stop
          </button>
          <button className="btn btn-ghost" onClick={clear} disabled={isRunning}>
            <TrashIcon />
            Clear
          </button>
        </div>

        {error && (
          <div className="error-banner">
            <AlertIcon /> {error}
          </div>
        )}

        <div className="stats-grid">
          <StatCard label="Total configs" value={total > 0 ? total.toLocaleString() : '—'} />
          <StatCard label="Tested" value={tested.toLocaleString()} />
          <StatCard label="Working" value={results.length} accent="success" />
          <StatCard label="Fastest" value={fastest !== null ? `${fastest} ms` : '—'} accent="info" />
        </div>

        {(isRunning || status === 'done' || status === 'stopped') && (
          <div className="progress-section">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-meta">
              <span className={`status-dot status-${status}`} />
              <span className="progress-text">
                {status === 'fetching' && 'Fetching config list from GitHub…'}
                {status === 'testing' && `Testing ${tested.toLocaleString()} / ${total.toLocaleString()} configs`}
                {status === 'done' && `Done — found ${results.length} working out of ${tested.toLocaleString()} tested`}
                {status === 'stopped' && `Stopped — found ${results.length} working out of ${tested.toLocaleString()} tested`}
              </span>
              {isRunning && <span className="progress-pct">{progress}%</span>}
            </div>
          </div>
        )}

        {results.length > 0 && (
          <section className="results-section">
            <div className="results-header">
              <h2>Working configs</h2>
              <span className="badge-success">{results.length} / {MAX_WORKING}</span>
            </div>
            <div className="config-list">
              {results.map((r, i) => (
                <ConfigCard key={i} result={r} />
              ))}
            </div>
          </section>
        )}

        {status === 'idle' && results.length === 0 && !error && (
          <div className="empty-state">
            <WifiIcon />
            <p>Press <strong>Start testing</strong> to find working configs on your connection</p>
          </div>
        )}

        {(status === 'done' || status === 'stopped') && results.length === 0 && (
          <div className="empty-state empty-fail">
            <WifiOffIcon />
            <p>No working configs found on your connection</p>
          </div>
        )}

      </div>
    </div>
  )
}

function ShieldIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
}
function PlayIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5,3 19,12 5,21"/></svg>
}
function StopIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>
}
function TrashIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4h6v2"/></svg>
}
function CopyIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
}
function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
}
function AlertIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
}
function WifiIcon() {
  return <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
}
function WifiOffIcon() {
  return <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a11 11 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
}
