import type { EngineInterface, Register } from 'claude-code'

const PANE = 'tank'
const TITLE = '🐾 탱크 서바이벌'
const PORT = 7777

type Kind = 'host' | 'join'
type MapName = 'normal' | 'big'
type ClaudeState = 'idle' | 'working' | 'done'
type Conn = {
  kind: Kind
  sock: string
  stream: ReturnType<EngineInterface['process']['spawn']>
  password: string
  // 방이 열렸는지, 들어갔는지, 실패했는지 처음 온 소식
  first: Promise<Message>
  settle: (msg: Message) => void
  // 통신 프로그램이 끝나면 풀린다
  done: Promise<void>
  heartbeat: { cancel: () => void }
}
type Message = { t?: string; why?: string; ips?: string[]; port?: number }

// 방장이 맵을 고를 때 쓰는 말
const MAP_WORDS: Record<string, MapName> = {
  큰맵: 'big', 큰: 'big', big: 'big', large: 'big', 대형: 'big',
  보통: 'normal', 기본: 'normal', normal: 'normal',
}

const HELP = [
  '/tank host [비번]       방 만들기 (내가 방장)',
  '/tank host [비번] 큰맵  넓은 맵으로 방 만들기',
  '/tank join IP [비번]    친구 방 들어가기',
  '/tank name 이름         내 이름 바꾸기',
  '/tank leave             방 나가기',
  '/tank                   게임 화면 열기',
]

let conn: Conn | null = null
// 통신 프로그램이 보내온 마지막 화면 상태
let view: Record<string, unknown> | null = null
let note = ''
// 방 주소와 친구에게 보낼 참가 명령어
let address = ''
let share = ''
let claude: ClaudeState = 'idle'
// 키 입력이 보낸 순서대로 도착하게 줄 세운다
let outbox: Promise<void> = Promise.resolve()

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function playerName($: EngineInterface) {
  const saved = await $.store.get('name')
  if (typeof saved === 'string' && saved) return saved
  return (await $.env.get('USER')) ?? '익명'
}

async function post($: EngineInterface, sock: string, path: string, body: unknown) {
  try {
    await $.http.fetch(`http://tank${path}`, { method: 'POST', body: JSON.stringify(body), socketPath: sock })
  } catch {
    // 통신 프로그램이 막 뜨는 중이거나 이미 끝났다
  }
}

function tell($: EngineInterface, path: string, body: unknown) {
  const c = conn
  if (!c) return
  outbox = outbox.then(() => post($, c.sock, path, body))
}

function openPane($: EngineInterface, map: MapName = 'normal') {
  return map === 'big'
    ? $.ui.open({ id: PANE, title: TITLE, rows: 34, columns: 84 })
    : $.ui.open({ id: PANE, title: TITLE, rows: 30, columns: 60 })
}

function handle($: EngineInterface, mine: Conn, line: string) {
  if (conn !== mine) return
  let msg: Message
  try {
    msg = JSON.parse(line) as Message
  } catch {
    return
  }
  if (msg.t === 's') {
    view = msg as Record<string, unknown>
  } else if (msg.t === 'ready') {
    address = `${msg.ips?.[0] ?? '내IP'}${msg.port === PORT ? '' : `:${msg.port}`}`
    share = `/tank join ${address}${mine.password ? ` ${mine.password}` : ''}`
    note = `방이 열렸어요! 친구는 ${share} 로 들어와요`
    $.ui.toast(`🐾 내 방 IP: ${address}`)
    tell($, '/status', { c: claude })
  } else if (msg.t === 'joined') {
    note = '입장했어요!'
    $.ui.toast('🐾 입장했어요! 게임 화면을 클릭하면 조작할 수 있어요')
    tell($, '/status', { c: claude })
  } else if (msg.t === 'error' || msg.t === 'closed') {
    note = msg.why ?? '연결이 끊겼어요'
    $.ui.toast(`🐾 ${note}`)
  }
  if (msg.t !== 's') mine.settle(msg)
  redraw($)
}

async function pump($: EngineInterface, mine: Conn, finish: () => void) {
  let buf = ''
  try {
    for await (const chunk of mine.stream) {
      if (chunk.stream !== 'stdout') {
        $.ui.log(chunk.text, { to: 'debug' })
        continue
      }
      buf += chunk.text
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        handle($, mine, buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
  } catch (err) {
    if (conn === mine) note = `통신 프로그램을 못 띄웠어요. Node가 설치돼 있어야 해요 (${String(err)})`
  }
  mine.heartbeat.cancel()
  finish()
  if (conn === mine) {
    conn = null
    view = null
    redraw($)
  }
}

async function stop($: EngineInterface) {
  const c = conn
  if (!c) return
  conn = null
  view = null
  c.heartbeat.cancel()
  await post($, c.sock, '/quit', {})
  // 포트를 놓을 때까지 잠깐 기다린다
  await Promise.race([c.done, $.clock.sleep(2000)])
  try {
    await c.stream.return(undefined as never)
  } catch {
    // 이미 끝났다
  }
  redraw($)
}

async function start($: EngineInterface, kind: Kind, target: string, password: string, map: MapName = 'normal') {
  await stop($)
  const sock = `/tmp/tank-survival-${crypto.randomUUID().slice(0, 8)}.sock`
  const name = await playerName($)
  const where = kind === 'host' ? ['--port', String(PORT), '--map', map] : ['--addr', target]
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/net/tank-net.mjs`, kind, '--sock', sock, '--name', name, '--pw', password, ...where],
  })
  let settle: (msg: Message) => void = () => {}
  const first = new Promise<Message>(resolve => {
    settle = resolve
  })
  let finish = () => {}
  const done = new Promise<void>(resolve => {
    finish = resolve
  })
  // 모드가 살아 있다는 신호. 끊기면 통신 프로그램이 알아서 끝난다
  const heartbeat = $.clock.every(5000, () => void post($, sock, '/ping', {}))
  const mine: Conn = { kind, sock, stream, first, settle, password, done, heartbeat }
  conn = mine
  view = null
  address = kind === 'join' ? target : ''
  share = ''
  note = kind === 'host' ? '방을 여는 중...' : '방에 들어가는 중...'
  void pump($, mine, finish)
  redraw($)

  return mine
}

// 첫 소식을 잠깐 기다린다. 늦으면 null
async function firstNews($: EngineInterface, mine: Conn) {
  return Promise.race([mine.first, $.clock.sleep(4000).then(() => null)])
}

function setClaude($: EngineInterface, next: ClaudeState) {
  claude = next
  tell($, '/status', { c: next })
  redraw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tank',
      description: '탱크 서바이벌: 방 만들기, 참가, 나가기',
      argumentHint: '[host [비번] | join IP [비번] | name 이름 | leave]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'tank' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    if (sub === 'host') {
      // 맵 이름과 비번은 어느 순서로 써도 된다
      const map = rest.map(word => MAP_WORDS[word]).find(Boolean) ?? 'normal'
      const password = rest.find(word => !MAP_WORDS[word]) ?? ''
      const mine = await start($, 'host', '', password, map)
      await openPane($, map)
      const news = await firstNews($, mine)
      if (news?.t !== 'ready') return { text: `🐾 ${news?.why ?? '방을 여는 중이에요. 열리면 알림으로 방 주소를 알려드릴게요.'}` }
      const copied = await $.ui.copy({ text: share })
      return {
        text: [
          `🐾 ${map === 'big' ? '큰 맵으로 ' : ''}방이 열렸어요! 내 IP: ${address}`,
          `친구에게 이 명령어를 보내주세요${copied.isCopied ? ' (클립보드에 복사해뒀어요)' : ''}:`,
          `  ${share}`,
          '게임 화면을 클릭하면 조작할 수 있어요.',
        ].join('\n'),
      }
    }
    if (sub === 'join') {
      const target = rest[0]
      if (!target) return { text: '사용법: /tank join 방장IP [비번]' }
      const mine = await start($, 'join', target, rest[1] ?? '')
      await openPane($)
      const news = await firstNews($, mine)
      if (news?.t === 'joined') return { text: `🐾 ${target} 방에 들어왔어요! 게임 화면을 클릭하면 조작할 수 있어요.` }
      return { text: `🐾 ${news?.why ?? `${target} 방에 들어가는 중이에요.`}` }
    }
    if (sub === 'leave') {
      const wasIn = conn !== null
      await stop($)
      note = ''
      return { text: wasIn ? '🐾 방에서 나왔어요.' : '🐾 들어가 있는 방이 없어요.' }
    }
    if (sub === 'name') {
      const name = rest.join(' ').trim().slice(0, 8)
      if (!name) return { text: `🐾 지금 이름: ${await playerName($)} (바꾸려면 /tank name 이름)` }
      await $.store.set('name', name)
      redraw($)
      return { text: `🐾 이제 "${name}"(으)로 나와요. 다음에 방에 들어갈 때부터 적용돼요.` }
    }
    if (sub === '' || sub === 'open') {
      await openPane($)
      return { text: '🐾 게임 화면을 열었어요.' }
    }

    return { text: ['🐾 탱크 서바이벌 명령어', ...HELP].join('\n') }
  })

  on('turn.start', ($, e, next) => {
    if (!e.agentId && claude !== 'working') setClaude($, 'working')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason !== 'aborted') {
      setClaude($, 'done')
      if (conn) $.ui.toast('🔔 Claude가 답변을 끝냈어요! 내 탱크는 💤 잠깐 보호 중')
    }

    return done
  })

  on('ui.message', ($, e) => {
    const k = (e.data as { k?: unknown } | null)?.k
    if (e.element === 'game' && typeof k === 'string') tell($, '/input', { k })

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>탱크 서바이벌은 터미널에서 할 수 있어요.</Text>
    }
    const { Box, Text, Client } = $.ui.resolve(e)

    if (conn && view) {
      return (
        <Client
          key="game"
          module="./view.tsx"
          props={{ ...view, claude, cols: e.props.bodyColumns, role: conn.kind, addr: address, share }}
        />
      )
    }

    const name = await playerName($)
    return (
      <Box flexDirection="column">
        <Text bold color="#ff8fab">🐾 탱크 서바이벌</Text>
        <Text dimColor>Claude가 일하는 동안 사무실 사람들과 한 판!</Text>
        <Text> </Text>
        {note !== '' && <Text color="#ffd166">{note}</Text>}
        {note !== '' && <Text> </Text>}
        {HELP.map(line => (
          <Text>{line}</Text>
        ))}
        <Text> </Text>
        <Text>내 이름: {name}</Text>
        <Text dimColor>에너지를 다 잃으면 탈락, 마지막까지 살아남으면 승리 ★</Text>
      </Box>
    )
  })
}
