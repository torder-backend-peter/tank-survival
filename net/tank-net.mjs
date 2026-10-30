// 탱크 서바이벌 통신 프로그램.
// host: 사무실 네트워크에 TCP 방을 열고 게임 판정을 돌린다.
// join: 방장에게 TCP로 붙어서 입력을 보내고 화면 상태를 받는다.
// 모드와는 표준출력(JSON 한 줄씩)과 유닉스 소켓 HTTP(/input, /status, /quit)로 이야기한다.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'

const PROTOCOL = 2
const opts = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const o = { mode: argv[0] }
  for (let i = 1; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1] ?? ''
  return o
}

const out = msg => process.stdout.write(JSON.stringify(msg) + '\n')
process.stdout.on('error', () => process.exit(0))

let isShuttingDown = false
// 방장일 때 연 TCP 방. 끝낼 때 포트를 바로 놓아준다
let room = null
function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  room?.close()
  for (const p of game.players.values()) p.socket?.destroy()
  try { fs.unlinkSync(opts.sock) } catch {}
  // macOS에서 파이프 쓰기는 비동기라 마지막 줄이 나갈 틈을 준다
  setTimeout(() => process.exit(0), 150)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Claude Code가 사라지거나 모드가 신호(/ping)를 15초 넘게 안 보내면 같이 끝난다
let lastPing = Date.now()
setInterval(() => {
  if (process.ppid === 1 || Date.now() - lastPing > 15_000) shutdown()
}, 2000).unref()

// ── 모드와 잇는 다리 ─────────────────────────────────────────────

const bridge = { input: () => {}, status: () => {} }

function startBridge() {
  try { fs.unlinkSync(opts.sock) } catch {}
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let msg = {}
      try { msg = JSON.parse(body || '{}') } catch {}
      lastPing = Date.now()
      if (req.url === '/input') bridge.input(msg)
      else if (req.url === '/status') bridge.status(msg)
      res.end('ok')
      if (req.url === '/quit') shutdown()
    })
  })
  server.on('error', err => { out({ t: 'error', why: `내부 연결을 못 열었어요: ${err.message}` }); shutdown() })
  server.listen(opts.sock)
}

// ── TCP 한 줄 JSON ───────────────────────────────────────────────

function readLines(socket, onLine) {
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buf += chunk
    if (buf.length > 1_000_000) return socket.destroy()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      onLine(msg)
    }
  })
}

function send(socket, msg) {
  if (socket.destroyed) return
  // 너무 밀린 참가자는 끊는다
  if (socket.writableLength > 1_000_000) return socket.destroy()
  socket.write(JSON.stringify(msg) + '\n')
}

// ── 게임 ─────────────────────────────────────────────────────────

const TICK_MS = 80
const SEC = 1000 / TICK_MS
const MAX_PLAYERS = 8
const COUNT_TICKS = 3 * SEC
const END_TICKS = 4 * SEC
const AFK_TICKS = 30 * SEC
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const ITEM_KINDS = ['heal', 'rapid', 'shield', 'strong', 'speed']

// 왼쪽 위 반쪽만 그리고 좌우, 위아래로 뒤집어 맵을 만든다. b: 벽돌, s: 강철
// 방장이 고른다. 큰 맵은 아이템이 더 많고 한 판이 조금 길다
const MAPS = {
  normal: {
    h: 13, items: 3, round: 120,
    half: [
      '.............',
      '.bb..s.......',
      '.b...s..bbb..',
      '........b....',
      '..ss........b',
      '......bb.....',
      'bb...s.......',
    ],
  },
  big: {
    h: 17, items: 5, round: 150,
    half: [
      '...................',
      '.bb...s.......bb...',
      '.b....s........b...',
      '..........ss.......',
      '..sss........b.....',
      '.......bb.......bb.',
      'bb.....b...s.......',
      '....s.........bbb..',
      '..b.....b.....s....',
    ],
  },
}
const MAP_NAME = MAPS[opts.map] ? opts.map : 'normal'
const SPEC = MAPS[MAP_NAME]
const W = SPEC.half[0].length * 2
const H = SPEC.h
const ROUND_TICKS = SPEC.round * SEC
const MAP = (() => {
  const top = SPEC.half.map(row => row + [...row].reverse().join(''))
  return [...top, ...top.slice(0, H - top.length).reverse()]
})()
// 네 모서리, 위아래 가운데, 왼쪽·오른쪽 가운데 줄
const SPAWNS = [
  [0, 0], [W - 1, H - 1], [W - 1, 0], [0, H - 1], [W / 2 - 1, 0], [W / 2, H - 1],
  [Math.floor(W / 4), Math.floor(H / 2)], [W - 1 - Math.floor(W / 4), Math.floor(H / 2)],
]

const game = {
  tick: 0,
  phase: 'wait', // wait(연습) → count → play → end
  phaseEnd: 0,
  grid: [],
  players: new Map(),
  bullets: [],
  items: [],
  fx: [],
  feed: [],
  winner: null,
  nextItem: 0,
}
let nextId = 1

const resetGrid = () => { game.grid = MAP.map(row => [...row]) }
resetGrid()

const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H
const tankAt = (x, y) => [...game.players.values()].find(p => p.alive && p.x === x && p.y === y)
const itemAt = (x, y) => game.items.find(it => it.x === x && it.y === y)
const isFree = (x, y) => inBounds(x, y) && game.grid[y][x] === '.' && !tankAt(x, y)
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 8) || '익명'

function feed(text) {
  game.feed.push(text)
  if (game.feed.length > 3) game.feed.shift()
}

function addFx(x, y, k, ticks = 3) {
  game.fx.push({ x, y, k, until: game.tick + ticks })
}

function setPhase(phase, ticks) {
  game.phase = phase
  game.phaseEnd = game.tick + ticks
}

function randomFree() {
  const cells = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isFree(x, y) && !itemAt(x, y)) cells.push([x, y])
  return cells[Math.floor(Math.random() * cells.length)]
}

function spawn(p) {
  const others = [...game.players.values()].filter(o => o !== p && o.alive)
  const free = SPAWNS.filter(([x, y]) => isFree(x, y))
  const pool = free.length > 0 ? free : [randomFree()].filter(Boolean)
  // 다른 탱크에서 가장 먼 자리
  let best = pool[0]
  let bestDistance = -1
  for (const spot of pool) {
    const distance = Math.min(99, ...others.map(o => Math.abs(o.x - spot[0]) + Math.abs(o.y - spot[1])))
    if (distance > bestDistance) { best = spot; bestDistance = distance }
  }
  if (!best) return
  Object.assign(p, {
    x: best[0], y: best[1], dir: best[1] > H / 2 ? 'up' : 'down',
    e: 100, alive: true, spec: false,
    wantMove: null, wantFire: false,
    rapidUntil: 0, speedUntil: 0, strong: 0,
    shieldUntil: game.tick + 2 * SEC, // 나오자마자 맞지 않게
  })
}

function addPlayer(name, socket) {
  const used = new Set([...game.players.values()].map(p => p.animal))
  let animal = 0
  while (used.has(animal)) animal++
  const p = {
    id: nextId++, name: cleanName(name), animal, socket,
    x: 0, y: 0, dir: 'up', e: 100, alive: false, spec: false,
    afk: false, afkUntil: 0, wantMove: null, wantFire: false,
    nextMove: 0, nextFire: 0, rapidUntil: 0, shieldUntil: 0, speedUntil: 0, strong: 0,
    claude: 'idle', wins: 0, kills: 0, respawnAt: 0,
  }
  game.players.set(p.id, p)
  if (game.phase === 'play' || game.phase === 'end') p.spec = true
  else spawn(p)
  feed(`${p.name} 입장!`)
  return p
}

function removePlayer(p) {
  if (!game.players.delete(p.id)) return
  feed(`${p.name} 퇴장`)
}

function onInput(p, k) {
  if (!p) return
  p.afk = false
  if (DIRS[k]) p.wantMove = k
  else if (k === 'fire') p.wantFire = true
}

function onStatus(p, c) {
  if (!p || !['idle', 'working', 'done'].includes(c)) return
  p.claude = c
  // Claude가 답을 끝내면 확인하러 갈 동안 잠깐 보호한다
  if (c === 'done' && p.alive) {
    p.afk = true
    p.afkUntil = game.tick + AFK_TICKS
  }
}

function fire(p) {
  const strong = p.strong > 0
  if (strong) p.strong--
  p.nextFire = game.tick + (game.tick < p.rapidUntil ? 2 : 6)
  const [dx, dy] = DIRS[p.dir]
  game.bullets.push({ x: p.x, y: p.y, dx, dy, owner: p.id, strong })
}

function pickUp(p) {
  const item = itemAt(p.x, p.y)
  if (!item) return
  game.items = game.items.filter(it => it !== item)
  const t = game.tick
  if (item.k === 'heal') p.e = Math.min(100, p.e + 40)
  if (item.k === 'rapid') p.rapidUntil = t + 8 * SEC
  if (item.k === 'shield') p.shieldUntil = t + 6 * SEC
  if (item.k === 'speed') p.speedUntil = t + 8 * SEC
  if (item.k === 'strong') p.strong = 3
  addFx(p.x, p.y, 'spark', 4)
}

function damage(p, amount, by) {
  if (p.afk || game.tick < p.shieldUntil) return addFx(p.x, p.y, 'block', 2)
  p.e = Math.max(0, p.e - amount)
  addFx(p.x, p.y, 'hit', 2)
  if (p.e > 0) return
  p.alive = false
  p.respawnAt = game.tick + 2 * SEC
  addFx(p.x, p.y, 'dead', 10)
  if (by && by !== p) by.kills++
  feed(by && by !== p ? `${by.name} → ${p.name} 펑!` : `${p.name} 펑!`)
}

function hitAt(b) {
  const target = tankAt(b.x, b.y)
  if (!target || target.id === b.owner) return false
  damage(target, b.strong ? 40 : 20, game.players.get(b.owner))
  return true
}

function moveBullets() {
  const kept = []
  for (const b of game.bullets) {
    // 탱크와 총알이 서로 스쳐 지나가지 않게 움직이기 전에도 본다
    if (hitAt(b)) continue
    b.x += b.dx
    b.y += b.dy
    if (!inBounds(b.x, b.y)) continue
    const cell = game.grid[b.y][b.x]
    if (cell === 'b' || (cell === 's' && b.strong)) {
      game.grid[b.y][b.x] = '.'
      addFx(b.x, b.y, 'boom', 2)
      continue
    }
    if (cell === 's') {
      addFx(b.x, b.y, 'spark', 2)
      continue
    }
    if (hitAt(b)) continue
    kept.push(b)
  }
  game.bullets = kept
}

function startRound() {
  resetGrid()
  game.bullets = []
  game.items = []
  game.fx = []
  game.winner = null
  for (const p of game.players.values()) p.alive = false
  for (const p of game.players.values()) {
    spawn(p)
    p.kills = 0
  }
  game.nextItem = game.tick + 4 * SEC
  setPhase('play', ROUND_TICKS)
  feed('시작!')
}

function endRound(alive) {
  // 시간이 다 되면 에너지가 가장 많은 탱크가 이긴다
  const sorted = [...alive].sort((a, b) => b.e - a.e)
  const winner = sorted.length > 0 && (sorted.length === 1 || sorted[0].e > sorted[1].e) ? sorted[0] : null
  game.winner = winner ? winner.id : null
  if (winner) {
    winner.wins++
    feed(`★ ${winner.name} 최후의 생존자!`)
  } else {
    feed('무승부!')
  }
  game.bullets = []
  setPhase('end', END_TICKS)
}

function backToPractice() {
  setPhase('wait', 0)
  game.winner = null
  for (const p of game.players.values()) if (!p.alive) spawn(p)
}

function step() {
  game.tick++
  const t = game.tick
  const players = [...game.players.values()]
  const isPractice = game.phase === 'wait' || game.phase === 'count'

  if (game.phase === 'wait') {
    if (players.length >= 2) setPhase('count', COUNT_TICKS)
  } else if (game.phase === 'count') {
    if (players.length < 2) setPhase('wait', 0)
    else if (t >= game.phaseEnd) startRound()
  } else if (game.phase === 'play') {
    const alive = players.filter(p => p.alive)
    if (alive.length <= 1 || t >= game.phaseEnd) endRound(alive)
  } else if (game.phase === 'end' && t >= game.phaseEnd) {
    if (players.length >= 2) setPhase('count', COUNT_TICKS)
    else backToPractice()
  }

  if (isPractice) {
    for (const p of players) if (!p.alive && !p.spec && t >= p.respawnAt) spawn(p)
  }

  if (game.phase !== 'end') {
    for (const p of players) {
      if (!p.alive) continue
      if (p.afk && t >= p.afkUntil) p.afk = false
      if (p.wantMove && t >= p.nextMove) {
        p.dir = p.wantMove
        const [dx, dy] = DIRS[p.dir]
        if (isFree(p.x + dx, p.y + dy)) {
          p.x += dx
          p.y += dy
          pickUp(p)
        }
        p.nextMove = t + (t < p.speedUntil ? 2 : 3)
        p.wantMove = null
      }
      if (p.wantFire) {
        p.wantFire = false
        if (!p.afk && t >= p.nextFire) fire(p)
      }
    }
    moveBullets()
    if (t >= game.nextItem) {
      game.nextItem = t + 7 * SEC
      const spot = game.items.length < SPEC.items ? randomFree() : null
      if (spot) game.items.push({ x: spot[0], y: spot[1], k: ITEM_KINDS[Math.floor(Math.random() * ITEM_KINDS.length)] })
    }
  }
  game.fx = game.fx.filter(f => f.until > t)
}

function snapshot() {
  const t = game.tick
  return {
    t: 's',
    ph: game.phase,
    w: W,
    h: H,
    left: game.phase === 'wait' ? 0 : Math.max(0, Math.ceil((game.phaseEnd - t) / SEC)),
    g: game.grid.map(row => row.join('')).join(''),
    p: [...game.players.values()].map(p => ({
      id: p.id, n: p.name, a: p.animal, x: p.x, y: p.y, d: p.dir, e: p.e,
      al: p.alive, sp: p.spec, afk: p.afk,
      sh: t < p.shieldUntil, ra: t < p.rapidUntil, fa: t < p.speedUntil, st: p.strong,
      c: p.claude, w: p.wins, k: p.kills,
    })),
    b: game.bullets.map(b => [b.x, b.y, b.strong ? 1 : 0]),
    i: game.items.map(it => [it.x, it.y, it.k]),
    fx: game.fx.map(f => [f.x, f.y, f.k]),
    feed: game.feed,
    win: game.winner,
  }
}

// 실제 사무실 연결(en0 같은 것)을 앞에 두고, 가상 머신·도커용 bridge 같은 건 뺀다
const VIRTUAL = /^(bridge|vmnet|vboxnet|docker|utun|awdl|llw|veth|br-)/
const lanIps = () => Object.entries(os.networkInterfaces())
  .filter(([name]) => !VIRTUAL.test(name))
  .sort(([a], [b]) => Number(!a.startsWith('en')) - Number(!b.startsWith('en')))
  .flatMap(([, addrs]) => addrs ?? [])
  .filter(a => a.family === 'IPv4' && !a.internal)
  .map(a => a.address)

// ── 방장 ─────────────────────────────────────────────────────────

function host() {
  const port = Number(opts.port) || 7777
  const password = opts.pw || ''
  const me = addPlayer(opts.name, null)
  bridge.input = msg => onInput(me, msg.k)
  bridge.status = msg => onStatus(me, msg.c)

  const server = room = net.createServer(socket => {
    socket.setNoDelay(true)
    let player = null
    const helloTimer = setTimeout(() => { if (!player) socket.destroy() }, 5000)
    const deny = why => { send(socket, { t: 'deny', why }); socket.end() }
    readLines(socket, msg => {
      if (!player) {
        if (msg.t !== 'hello') return socket.destroy()
        clearTimeout(helloTimer)
        if (msg.v !== PROTOCOL) return deny('모드 버전이 달라요. 방장과 같은 버전으로 맞춰주세요')
        if (String(msg.pw || '') !== password) return deny('비밀번호가 틀렸어요')
        if (game.players.size >= MAX_PLAYERS) return deny(`방이 꽉 찼어요 (최대 ${MAX_PLAYERS}명)`)
        player = addPlayer(msg.name, socket)
        send(socket, { t: 'welcome', id: player.id })
        return
      }
      if (msg.t === 'in') onInput(player, msg.k)
      else if (msg.t === 'st') onStatus(player, msg.c)
    })
    const drop = () => {
      clearTimeout(helloTimer)
      if (player) removePlayer(player)
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })
  // 방금 닫은 방이 포트를 놓는 중일 수 있어서 3초까지 다시 시도한다
  let tries = 0
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && ++tries < 15) return setTimeout(() => server.listen(port, '0.0.0.0'), 200)
    out({ t: 'error', why: err.code === 'EADDRINUSE' ? `포트 ${port}을 이미 쓰고 있어요. 다른 방이 열려 있는지 확인해주세요` : `방을 못 열었어요: ${err.message}` })
    shutdown()
  })
  server.on('listening', () => out({ t: 'ready', ips: lanIps(), port, map: MAP_NAME }))
  server.listen(port, '0.0.0.0')

  setInterval(() => {
    step()
    const snap = snapshot()
    for (const p of game.players.values()) if (p.socket) send(p.socket, snap)
    out({ ...snap, me: me.id })
  }, TICK_MS)
}

// ── 참가 ─────────────────────────────────────────────────────────

function describe(err) {
  if (err.code === 'ECONNREFUSED') return '그 주소에 열린 방이 없어요'
  if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return '방장 컴퓨터에 닿지 않아요. 같은 사무실 네트워크인지 확인해주세요'
  if (err.code === 'ENOTFOUND') return '주소를 찾을 수 없어요'
  return `연결이 끊겼어요: ${err.message}`
}

function join() {
  const [hostName, portText] = String(opts.addr || '').split(':')
  const port = Number(portText) || 7777
  const socket = net.connect({ host: hostName, port })
  socket.setNoDelay(true)
  socket.setTimeout(5000, () => {
    out({ t: 'error', why: '방장 컴퓨터가 응답하지 않아요. 같은 사무실 네트워크인지 확인해주세요' })
    socket.destroy()
    shutdown()
  })
  let me = 0
  socket.on('connect', () => {
    socket.setTimeout(0)
    send(socket, { t: 'hello', v: PROTOCOL, name: opts.name, pw: opts.pw || '' })
  })
  readLines(socket, msg => {
    if (msg.t === 'welcome') {
      me = msg.id
      out({ t: 'joined' })
    } else if (msg.t === 'deny') {
      out({ t: 'error', why: msg.why })
      shutdown()
    } else if (msg.t === 's' && me) {
      out({ ...msg, me })
    }
  })
  socket.on('error', err => {
    out({ t: 'error', why: describe(err) })
    shutdown()
  })
  socket.on('close', () => {
    out({ t: 'closed', why: me ? '방이 닫혔어요' : '방에 들어가지 못했어요' })
    shutdown()
  })
  bridge.input = msg => send(socket, { t: 'in', k: msg.k })
  bridge.status = msg => send(socket, { t: 'st', c: msg.c })
}

startBridge()
if (opts.mode === 'host') host()
else if (opts.mode === 'join') join()
else {
  out({ t: 'error', why: `모르는 모드: ${opts.mode}` })
  shutdown()
}
