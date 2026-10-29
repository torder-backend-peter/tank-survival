import type { ClientModule, ClientKeyEvent, JsonValue } from 'claude-code'

type Player = {
  id: number
  n: string
  a: number
  x: number
  y: number
  d: string
  e: number
  al: boolean
  sp: boolean
  afk: boolean
  sh: boolean
  ra: boolean
  fa: boolean
  st: number
  c: string
  w: number
  k: number
}
type View = {
  ph: string
  left: number
  g: string
  p: Player[]
  b: [number, number, number][]
  i: [number, number, string][]
  fx: [number, number, string][]
  feed: string[]
  win: number | null
  me: number
  claude: string
  cols?: number
  role?: string
  addr?: string
  share?: string
}
type Cell = { t: string; c?: string; bg?: string }

const W = 26
const H = 13
const ANIMALS = ['🐱', '🐶', '🐸', '🐼', '🐷', '🐵', '🐻', '🐨']
const COLORS = ['#ff9ecb', '#ffd166', '#95e06c', '#8ecae6', '#ffb4a2', '#c3a6ff', '#f6bd60', '#a0e7e5']
const ITEMS: Record<string, string> = { heal: '🍓', rapid: '🔥', shield: '🐢', strong: '💣', speed: '👟' }
const FX: Record<string, string> = { boom: '💥', hit: '💥', dead: '💫', spark: '✨', block: '✨' }
// 포신은 탱크 옆 칸에 두 글자로 그린다
const CANNON: Record<string, string> = { up: '/\\', down: '\\/', left: '<=', right: '=>' }
const STEP: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const PINK = '#ff8fab'
const BRICK = '#f4a261'
const STEEL = '#b8b8d1'
const SHIELD_BG = '#bde0fe'

const KEYS: Record<string, string> = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  w: 'up', a: 'left', s: 'down', d: 'right',
  // 한글 자판일 때 같은 자리
  ㅈ: 'up', ㅁ: 'left', ㄴ: 'down', ㅇ: 'right',
  ' ': 'fire', space: 'fire', j: 'fire', f: 'fire', ㅓ: 'fire', ㄹ: 'fire',
}

const keyOf = (event: ClientKeyEvent) => KEYS[event.key] ?? KEYS[event.key.toLowerCase()]

// 한글과 이모지는 두 칸을 차지한다
const widthOf = (text: string) =>
  [...text].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠\u{1f300}-\u{1faff}]/u.test(ch) ? 2 : 1), 0)
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - widthOf(text)))

function board(v: View): Cell[][] {
  const rows: Cell[][] = []
  for (let y = 0; y < H; y++) {
    const row: Cell[] = []
    for (let x = 0; x < W; x++) {
      const cell = v.g[y * W + x]
      row.push(cell === 'b' ? { t: '▓▓', c: BRICK } : cell === 's' ? { t: '██', c: STEEL } : { t: '  ' })
    }
    rows.push(row)
  }
  const put = (x: number, y: number, cell: Cell) => {
    const row = rows[y]
    if (row && x >= 0 && x < W) row[x] = cell
  }
  const isBlank = (x: number, y: number) => rows[y]?.[x]?.t === '  '

  for (const [x, y, k] of v.i) put(x, y, { t: ITEMS[k] ?? '🎁' })
  const alive = v.p.filter(p => p.al)
  for (const p of alive) {
    const [dx, dy] = STEP[p.d] ?? [0, -1]
    if (isBlank(p.x + dx, p.y + dy)) put(p.x + dx, p.y + dy, { t: CANNON[p.d] ?? '  ', c: COLORS[p.a] })
  }
  for (const [x, y, strong] of v.b) put(x, y, { t: strong ? '🔶' : '🔸' })
  for (const p of alive) put(p.x, p.y, { t: p.afk ? '💤' : ANIMALS[p.a] ?? '🐾', bg: p.sh || p.afk ? SHIELD_BG : undefined })
  for (const [x, y, k] of v.fx) put(x, y, { t: FX[k] ?? '✨' })

  return rows
}

// 같은 색이 이어지는 칸은 한 덩어리로 묶는다
function runs(row: Cell[]): Cell[] {
  const merged: Cell[] = []
  for (const cell of row) {
    const last = merged[merged.length - 1]
    if (last && last.c === cell.c && last.bg === cell.bg) last.t += cell.t
    else merged.push({ ...cell })
  }
  return merged
}

function headline(v: View, me: Player | undefined): { text: string; color: string } {
  const alive = v.p.filter(p => p.al).length
  if (v.ph === 'wait') return { text: '🌱 연습 중 · 친구가 들어오면 바로 시작해요 (2명부터)', color: '#95e06c' }
  if (v.ph === 'count') return { text: `⏳ ${v.left}초 뒤 시작! 준비~`, color: '#ffd166' }
  if (v.ph === 'end') {
    const winner = v.p.find(p => p.id === v.win)
    return winner
      ? { text: `🏆 ${ANIMALS[winner.a]} ${winner.n} 최후의 생존자!${winner.id === v.me ? ' (나야 나!)' : ''}`, color: '#ffd166' }
      : { text: '🤝 무승부! 곧 다음 판이에요', color: '#ffd166' }
  }
  const time = `${Math.floor(v.left / 60)}:${String(v.left % 60).padStart(2, '0')}`
  if (me?.sp) return { text: `👀 관전 중 · 다음 판에 들어가요 · ⏱ ${time}`, color: '#8ecae6' }
  if (me && !me.al) return { text: `😵 펑! 다음 판을 기다려요 · ⏱ ${time} · 남은 탱크 ${alive}대`, color: '#ffb4a2' }
  return { text: `⏱ ${time} · 남은 탱크 ${alive}대`, color: PINK }
}

const Game: ClientModule<JsonValue, true> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onKey(event => {
      const k = keyOf(event)
      if (k) surface.post({ k })
    })
    surface.setState(true)
  }

  const v = props as unknown as View
  const me = v.p.find(p => p.id === v.me)
  const head = headline(v, me)
  // 자리 잡기 전에는 폭이 0으로 온다
  const tooNarrow = typeof v.cols === 'number' && v.cols > 0 && v.cols < W * 2 + 2

  const where = v.role === 'host' && v.addr ? (
    <Text>
      <Text color="#8ecae6">📡 내 방 IP </Text>
      <Text bold color="#8ecae6">{v.addr}</Text>
      <Text dimColor>  친구는 {v.share}</Text>
    </Text>
  ) : v.addr ? (
    <Text color="#8ecae6">📡 {v.addr} 방에서 플레이 중</Text>
  ) : null

  // 잘린 맵은 헷갈리기만 하니 넓히는 방법을 알려준다
  if (tooNarrow) {
    return (
      <Box flexDirection="column">
        {where}
        <Text> </Text>
        <Text bold color="#ffb4a2">🐾 게임 창이 좁아요</Text>
        <Text>지금 {v.cols}칸, 맵은 {W * 2 + 2}칸이 필요해요.</Text>
        <Text>창 왼쪽 경계를 마우스로 끌어 넓혀주세요. 넓힌 폭은 기억돼요.</Text>
        <Text> </Text>
        <Text color={head.color}>{head.text}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {where}
      <Box flexDirection="column" borderStyle="round" borderColor={PINK} width={W * 2 + 2}>
        {board(v).map(row => (
          <Box flexDirection="row">
            {runs(row).map(cell => (
              <Text color={cell.c} backgroundColor={cell.bg}>{cell.t}</Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text bold color={head.color}>{head.text}</Text>
      {v.claude === 'done' && (
        <Text bold color="#ffd166">🔔 Claude가 답변을 끝냈어요! Esc 누르고 확인하러 가요{me?.afk ? ' · 내 탱크는 💤 보호 중' : ''}</Text>
      )}
      {v.p.map(p => {
        const hearts = Math.ceil(p.e / 20)
        const effects = [p.ra ? '🔥' : '', p.sh && !p.afk ? '🐢' : '', p.fa ? '👟' : '', p.st > 0 ? `💣${p.st}` : '', p.afk ? '💤' : ''].join('')
        const claude = p.c === 'working' ? '🔨' : p.c === 'done' ? '🔔' : ''
        const isOut = !p.al && !p.sp
        return (
          <Box flexDirection="row">
            <Text color={COLORS[p.a]}>{p.id === v.me ? '▸ ' : '  '}{ANIMALS[p.a]} {pad(p.n, 9)}</Text>
            {p.sp ? (
              <Text dimColor>관전 중      </Text>
            ) : (
              <Text>
                <Text color={PINK}>{'♥'.repeat(hearts)}</Text>
                <Text dimColor>{'♡'.repeat(5 - hearts)}</Text>
                <Text>{isOut ? ' 💫 ' : '    '}</Text>
              </Text>
            )}
            <Text>{pad(effects, 8)} {pad(claude, 3)}</Text>
            <Text dimColor>🏆{p.w}</Text>
          </Box>
        )
      })}
      {v.feed.length > 0 && <Text dimColor>{v.feed.join('  ')}</Text>}
      <Text dimColor>화면 클릭 후 방향키 이동 · 스페이스 발사 · Esc 입력창</Text>
      <Text dimColor>🍓에너지 🔥연사 🐢방패 💣강한포탄 👟속도 · 🔨Claude 작업중 🔔답변 완료</Text>
    </Box>
  )
}

export default Game
