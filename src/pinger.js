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
  // raw.githubusercontent.com sends Access-Control-Allow-Origin: *
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
//  [1] version = 0x00
//  [16] UUID bytes
//  [1] addons length = 0x00
//  [1] command = 0x01 (TCP)
//  [2] dest port (big-endian)
//  [1] addr type: 0x02=IPv4 0x03=domain 0x04=IPv6
//  [1] domain length (if type=domain)
//  [n] address bytes
// ─────────────────────────────────────────────────────────────

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function buildVlessHeader(uuid, destHost, destPort) {
  const uuidBytes = uuidToBytes(uuid)
  const portNum = parseInt(destPort, 10)
  const enc = new TextEncoder()
  const hostBytes = enc.encode(destHost)

  // probe target: www.gstatic.com port 80 (generate_204)
  const probeHost = 'www.gstatic.com'
  const probePort = 80
  const probeBytes = enc.encode(probeHost)

  // total size: 1+16+1+1+2+1+1+n
  const size = 1 + 16 + 1 + 1 + 2 + 1 + 1 + probeBytes.length
  const buf = new Uint8Array(size)
  let i = 0

  buf[i++] = 0x00                      // version
  buf.set(uuidBytes, i); i += 16       // UUID
  buf[i++] = 0x00                      // addons length
  buf[i++] = 0x01                      // command TCP
  buf[i++] = (probePort >> 8) & 0xff   // port high
  buf[i++] = probePort & 0xff   // port low
  buf[i++] = 0x02                      // addr type: domain
  buf[i++] = probeBytes.length         // domain length
  buf.set(probeBytes, i)               // domain bytes

  return buf
}

// HTTP request to send through the tunnel after VLESS handshake
function buildHTTPRequest(host) {
  const req =
    `GET /generate_204 HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Connection: close\r\n` +
    `User-Agent: Mozilla/5.0\r\n\r\n`
  return new TextEncoder().encode(req)
}

// ── WebSocket VLESS probe ────────────────────────────────────
// Opens a real WebSocket to the Xray server, sends a VLESS
// header requesting a connection to www.gstatic.com:80, then
// sends an HTTP GET /generate_204.
// Any response (including a VLESS error frame) proves the
// server received and processed the VLESS header → alive.
// ─────────────────────────────────────────────────────────────

function probeVlessWS(cfg, timeoutMs) {
  return new Promise(resolve => {
    const useTLS = cfg.security === 'tls' || cfg.security === 'reality'
    const scheme = useTLS ? 'wss' : 'ws'
    const url = `${scheme}://${cfg.host}:${cfg.port}${cfg.path}`

    let ws
    let settled = false
    let t0

    const done = (ms) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws && ws.readyState <= 1 && ws.close() } catch { }
      resolve(ms)
    }

    const timer = setTimeout(() => done(null), timeoutMs)

    try {
      // Pass SNI via Sec-WebSocket-Protocol header trick used by Xray clients
      ws = new WebSocket(url, cfg.hostHdr !== cfg.host ? [cfg.hostHdr] : [])
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        t0 = performance.now()
        // Send VLESS header + HTTP payload in one binary frame
        const vlessHeader = buildVlessHeader(cfg.uuid, 'www.gstatic.com', 80)
        const httpReq = buildHTTPRequest('www.gstatic.com')
        const payload = new Uint8Array(vlessHeader.length + httpReq.length)
        payload.set(vlessHeader, 0)
        payload.set(httpReq, vlessHeader.length)
        ws.send(payload)
      }

      ws.onmessage = () => {
        // Any message back = server processed our VLESS header
        done(Math.round(performance.now() - t0))
      }

      ws.onerror = () => done(null)
      ws.onclose = (e) => {
        // Some servers close immediately after responding — still alive
        if (!settled && t0) {
          done(Math.round(performance.now() - t0))
        } else {
          done(null)
        }
      }
    } catch {
      done(null)
    }
  })
}

// ── Image probe ──────────────────────────────────────────────
// Measures TCP+TLS reachability. Both onload and onerror mean
// the host responded at the network level. Only setTimeout
// means truly unreachable.
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
    // Always https — avoids mixed-content block on https pages
    img.src = `https://${host}:${port}/favicon.ico?_=${Date.now()}`
  })
}

// ── Main ping dispatcher ─────────────────────────────────────

export async function pingConfig(cfg, timeoutMs = 7000) {
  const t = cfg.transport

  if (t === 'ws' || t === 'h2') {
    // Real VLESS handshake via WebSocket
    return probeVlessWS(cfg, timeoutMs)
  }

  // For REALITY, xhttp, grpc, tcp — image probe for TCP/TLS reachability
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
