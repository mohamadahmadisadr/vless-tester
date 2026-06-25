// ─────────────────────────────────────────────────────────────
// VLESS Config Tester — pure browser, no backend
// Strategy per transport:
//   ws/h2  → real VLESS handshake over WebSocket (accurate)
//   reality → TLS image probe (good approximation)
//   all else → image probe (TCP reachability only)
// ─────────────────────────────────────────────────────────────

const GITHUB_URL =
  'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt'

// ── Config fetching ──────────────────────────────────────────

export async function fetchConfigs() {
  const res = await fetch(GITHUB_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text.split('\n').map(parseVless).filter(Boolean)
}

// ── URI parser ───────────────────────────────────────────────

export function parseVless(raw) {
  try {
    const line = raw.trim()
    if (!line) return null
    const u = new URL(line)
    if (u.protocol !== 'vless:') return null
    const p = u.searchParams
    const host = u.hostname
    const port = u.port || '443'
    const sni = p.get('sni') || host
    const hostHdr = p.get('host') || sni
    const transport = (p.get('type') || 'tcp').toLowerCase()
    const security = (p.get('security') || 'none').toLowerCase()
    const path = p.get('path') || '/'
    const uuid = u.username
    const tag = decodeURIComponent(u.hash.replace('#', '')) || `${host}:${port}`
    return { raw: line, host, port, sni, hostHdr, path, uuid, security, transport, tag }
  } catch { return null }
}

// ── VLESS header builder ─────────────────────────────────────
// Binary format (version 0):
//  [1]  version = 0x00
//  [16] UUID bytes
//  [1]  addons length = 0x00
//  [1]  command = 0x01 (TCP)
//  [2]  dest port (big-endian)
//  [1]  addr type: 0x02=IPv4 0x03=domain
//  [1]  domain length
//  [n]  domain bytes
// ─────────────────────────────────────────────────────────────

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function buildVlessHeader(uuid) {
  const uuidBytes = uuidToBytes(uuid)
  const probeHost = 'www.gstatic.com'
  const probePort = 80
  const hostBytes = new TextEncoder().encode(probeHost)

  const buf = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBytes.length)
  let i = 0
  buf[i++] = 0x00                       // version
  buf.set(uuidBytes, i); i += 16        // UUID
  buf[i++] = 0x00                       // addons length
  buf[i++] = 0x01                       // command TCP
  buf[i++] = (probePort >> 8) & 0xff    // port high
  buf[i++] = probePort & 0xff    // port low
  buf[i++] = 0x02                       // addr type: domain
  buf[i++] = hostBytes.length           // domain length
  buf.set(hostBytes, i)
  return buf
}

function buildHTTPRequest() {
  return new TextEncoder().encode(
    'GET /generate_204 HTTP/1.1\r\n' +
    'Host: www.gstatic.com\r\n' +
    'Connection: close\r\n' +
    'User-Agent: Mozilla/5.0\r\n\r\n'
  )
}

// ── WebSocket VLESS probe ────────────────────────────────────
// A result is ONLY counted as working when the server sends
// back a message after we send the VLESS header + HTTP request.
//
// Explicitly NOT working:
//  - ws.onopen fires but server immediately closes → null
//  - ws.onerror fires → null
//  - timeout → null
//
// This eliminates the false positives where the server accepts
// the TCP/TLS connection but rejects the VLESS handshake.
// ─────────────────────────────────────────────────────────────

function probeVlessWS(cfg, timeoutMs) {
  return new Promise(resolve => {
    const useTLS = cfg.security === 'tls' || cfg.security === 'reality'
    const scheme = useTLS ? 'wss' : 'ws'
    const url = `${scheme}://${cfg.host}:${cfg.port}${cfg.path}`

    let ws
    let settled = false
    let t0 = null
    let gotOpen = false

    const done = (ms) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws && ws.readyState <= 1 && ws.close() } catch { }
      resolve(ms)
    }

    const timer = setTimeout(() => done(null), timeoutMs)

    try {
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        gotOpen = true
        t0 = performance.now()

        // Send VLESS header + HTTP payload as one binary frame
        const header = buildVlessHeader(cfg.uuid)
        const http = buildHTTPRequest()
        const payload = new Uint8Array(header.length + http.length)
        payload.set(header, 0)
        payload.set(http, header.length)

        try {
          ws.send(payload.buffer)
        } catch {
          done(null)
        }
      }

      ws.onmessage = () => {
        // ✅ Server sent data back after our VLESS header
        // This is the ONLY condition we count as working
        if (t0 !== null) {
          done(Math.round(performance.now() - t0))
        }
      }

      ws.onerror = () => {
        // Connection failed at WS level
        done(null)
      }

      ws.onclose = (e) => {
        // Server closed without sending any message → rejected
        // Do NOT resolve with a time here — that was the false positive
        if (!settled) {
          done(null)
        }
      }
    } catch {
      done(null)
    }
  })
}

// ── Image probe ──────────────────────────────────────────────
// Measures TCP+TLS reachability only.
// onerror still means host responded — just no valid image.
// Only setTimeout = truly unreachable.
// ─────────────────────────────────────────────────────────────

function probeImage(host, port, timeoutMs) {
  return new Promise(resolve => {
    const img = new Image()
    const start = performance.now()
    let settled = false

    const done = (ms) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      img.onload = img.onerror = null
      img.src = ''
      resolve(ms)
    }

    const timer = setTimeout(() => done(null), timeoutMs)
    img.onload = img.onerror = () => done(Math.round(performance.now() - start))
    img.src = `https://${host}:${port}/favicon.ico?_=${Date.now()}`
  })
}

// ── Main ping dispatcher ─────────────────────────────────────

export async function pingConfig(cfg, timeoutMs = 7000) {
  if (cfg.transport === 'ws' || cfg.transport === 'h2') {
    return probeVlessWS(cfg, timeoutMs)
  }
  return probeImage(cfg.host, cfg.port, timeoutMs)
}

// ── Batch runner ─────────────────────────────────────────────

export async function pingAll({
  configs,
  concurrency = 20,
  timeoutMs = 7000,
  maxWorking = 5,
  onResult,
  signal,
}) {
  const queue = [...configs]
  let workingCount = 0

  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted || workingCount >= maxWorking) break
      const cfg = queue.shift()
      if (!cfg) break

      const ms = await pingConfig(cfg, timeoutMs)
      if (signal?.aborted) break

      const result = { ...cfg, pingMs: ms ?? 0, reachable: ms !== null }
      if (ms !== null) workingCount++
      onResult?.(result)
      if (workingCount >= maxWorking) break
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, configs.length) }, worker)
  )
}