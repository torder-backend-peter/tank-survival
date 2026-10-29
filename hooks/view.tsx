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
// 맵 안에는 이모지를 쓰지 않는다. 터미널마다 이모지 폭이 달라 줄이 어긋난다
// 한 칸은 두 글자. 포탑이 향한 쪽으로 모양이 바뀐다
const TANK: Record<string, string> = { up: '▟▙', down: '▜▛', left: '━█', right: '█━' }
const COLORS = ['#ff7eb6', '#ffd23f', '#6bd968', '#5ec8f2', '#ff9b71', '#b388ff', '#f7b267', '#4fd1c5']
const ITEMS: Record<string, Cell & { label: string }> = {
  heal: { t: '♥♥', c: '#ff5d8f', label: '에너지' },
  rapid: { t: '≡≡', c: '#ff9f1c', label: '연사' },
  shield: { t: '◎◎', c: '#4cc9f0', label: '방패' },
  strong: { t: '✦✦', c: '#ff595e', label: '강한포탄' },
  speed: { t: '»»', c: '#8ac926', label: '속도' },
}
const BULLET: Cell = { t: '╺╸', c: '#ffe066' }
const BIG_BULLET: Cell = { t: '▐▌', c: '#ff595e' }
const PINK = '#ff8fab'
const BRICK = '#f4a261'
const STEEL = '#b8b8d1'
const SHIELD_BG = '#3d5a80'
const HIT_BG = '#ff595e'
const AFK = '#9e9e9e'

const KEYS: Record<string, string> = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  w: 'up', a: 'left', s: 'down', d: 'right',
  // 한글 자판일 때 같은 자리
  ㅈ: 'up', ㅁ: 'left', ㄴ: 'down', ㅇ: 'right',
  ' ': 'fire', space: 'fire', j: 'fire', f: 'fire', ㅓ: 'fire', ㄹ: 'fire',
}

const keyOf = (event: ClientKeyEvent) => KEYS[event.key] ?? KEYS[event.key.toLowerCase()]

// 한글은 두 칸을 차지한다
const widthOf = (text: string) =>
  [...text].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0)
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
  const tint = (x: number, y: number, bg: string) => {
    const cell = rows[y]?.[x]
    if (cell) rows[y]![x] = { ...cell, bg }
  }

  for (const [x, y, k] of v.i) {
    const item = ITEMS[k]
    if (item) put(x, y, { t: item.t, c: item.c })
  }
  for (const [x, y, strong] of v.b) put(x, y, strong ? BIG_BULLET : BULLET)
  for (const p of v.p) {
    if (!p.al) continue
    put(p.x, p.y, {
      t: TANK[p.d] ?? TANK.up!,
      c: p.afk ? AFK : COLORS[p.a],
      bg: p.sh || p.afk ? SHIELD_BG : undefined,
    })
  }
  for (const [x, y, k] of v.fx) {
    if (k === 'hit') tint(x, y, HIT_BG)
    else if (k === 'block') tint(x, y, SHIELD_BG)
    else if (k === 'boom') put(x, y, { t: '░░', c: BRICK })
    else if (k === 'dead') put(x, y, { t: '××', c: HIT_BG })
    else if (k === 'spark') put(x, y, { t: '··', c: '#ffe066' })
  }

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
  if (v.ph === 'wait') return { text: '연습 중 · 친구가 들어오면 바로 시작해요 (2명부터)', color: '#6bd968' }
  if (v.ph === 'count') return { text: `${v.left}초 뒤 시작! 준비~`, color: '#ffd23f' }
  if (v.ph === 'end') {
    const winner = v.p.find(p => p.id === v.win)
    return winner
      ? { text: `★ ${winner.n} 최후의 생존자!${winner.id === v.me ? ' (나야 나!)' : ''}`, color: '#ffd23f' }
      : { text: '무승부! 곧 다음 판이에요', color: '#ffd23f' }
  }
  const time = `${Math.floor(v.left / 60)}:${String(v.left % 60).padStart(2, '0')}`
  if (me?.sp) return { text: `관전 중 · 다음 판에 들어가요 · 남은 시간 ${time}`, color: '#5ec8f2' }
  if (me && !me.al) return { text: `펑! 다음 판을 기다려요 · 남은 시간 ${time} · 남은 탱크 ${alive}대`, color: '#ff9b71' }
  return { text: `남은 시간 ${time} · 남은 탱크 ${alive}대`, color: PINK }
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
      <Text color="#5ec8f2">내 방 IP </Text>
      <Text bold color="#5ec8f2">{v.addr}</Text>
      <Text dimColor>  친구는 {v.share}</Text>
    </Text>
  ) : v.addr ? (
    <Text color="#5ec8f2">{v.addr} 방에서 플레이 중</Text>
  ) : null

  // 잘린 맵은 헷갈리기만 하니 넓히는 방법을 알려준다
  if (tooNarrow) {
    return (
      <Box flexDirection="column">
        {where}
        <Text> </Text>
        <Text bold color="#ff9b71">게임 창이 좁아요</Text>
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
        <Text bold color="#ffd23f">★ Claude가 답변을 끝냈어요! Esc 누르고 확인하러 가요{me?.afk ? ' · 내 탱크는 잠깐 보호 중' : ''}</Text>
      )}
      {v.p.map(p => {
        const hearts = Math.ceil(p.e / 20)
        const isOut = !p.al && !p.sp
        const effects = [
          p.ra && ITEMS.rapid,
          p.sh && !p.afk && ITEMS.shield,
          p.fa && ITEMS.speed,
          p.st > 0 && { ...ITEMS.strong!, t: `✦${p.st}` },
        ].filter((item): item is Cell & { label: string } => Boolean(item))
        return (
          <Box flexDirection="row">
            <Text>{p.id === v.me ? '▸ ' : '  '}</Text>
            <Text color={p.afk ? AFK : COLORS[p.a]}>{TANK.up}</Text>
            <Text bold={p.id === v.me} dimColor={isOut}> {pad(p.n, 9)}</Text>
            {p.sp ? (
              <Text dimColor>관전 중 </Text>
            ) : (
              <Text>
                <Text color={PINK}>{'♥'.repeat(hearts)}</Text>
                <Text dimColor>{'♡'.repeat(5 - hearts)}</Text>
                <Text color={HIT_BG}>{isOut ? ' 탈락' : '     '}</Text>
              </Text>
            )}
            <Text> </Text>
            {effects.map(item => (
              <Text color={item.c}>{item.t[0] === '✦' ? item.t : item.t[0]}</Text>
            ))}
            <Text>{' '.repeat(Math.max(1, 5 - effects.reduce((n, item) => n + (item.t[0] === '✦' ? item.t.length : 1), 0)))}</Text>
            {p.afk ? (
              <Text color={AFK}>zz      </Text>
            ) : p.c === 'working' ? (
              <Text color="#5ec8f2">작업중  </Text>
            ) : p.c === 'done' ? (
              <Text color="#ffd23f">답변완료</Text>
            ) : (
              <Text>        </Text>
            )}
            <Text dimColor> ★{p.w}</Text>
          </Box>
        )
      })}
      {v.feed.length > 0 && <Text dimColor>{v.feed.join(' · ')}</Text>}
      <Text dimColor>화면 클릭 후 방향키 이동 · 스페이스 발사 · Esc 입력창</Text>
      <Text>
        {Object.values(ITEMS).map(item => (
          <Text>
            <Text color={item.c}>{item.t[0]}</Text>
            <Text dimColor>{item.label} </Text>
          </Text>
        ))}
        <Text color="#5ec8f2"> 작업중</Text>
        <Text dimColor>·</Text>
        <Text color="#ffd23f">답변완료</Text>
        <Text dimColor> = 그 사람의 Claude 상태</Text>
      </Text>
    </Box>
  )
}

export default Game
