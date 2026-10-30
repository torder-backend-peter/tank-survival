import { expect, mock, test, type TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'tank-survival',
  component: 'Pane',
  requestId: 'tank',
  props: {
    title: '🐾 탱크 서바이벌',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const player = (id: number, name: string, x: number, y: number, extra: object = {}) => ({
  id, n: name, a: id - 1, x, y, d: 'right', e: 60, al: true, sp: false, afk: false,
  sh: false, ra: false, fa: false, st: 0, c: 'idle', w: 0, k: 0, ...extra,
})

const SNAP = {
  t: 's',
  ph: 'play',
  w: 26,
  h: 13,
  left: 83,
  g: 'bb' + 's'.repeat(2) + '.'.repeat(26 * 13 - 4),
  p: [player(1, '방장', 3, 3, { ra: true, c: 'working' }), player(2, '철수', 10, 5, { afk: true, c: 'done' })],
  b: [[6, 3, 0]],
  i: [[8, 8, 'heal']],
  fx: [[12, 6, 'boom']],
  feed: ['🚩 시작!'],
  win: null,
  me: 1,
}

// 입력창에서 친 명령처럼
const typed = (args: string) => ({
  command: 'tank',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const line = (msg: object) => ({ stream: 'stdout' as const, text: JSON.stringify(msg) + '\n' })

test('the lobby lists the commands, on every surface that draws it', async ($, on) => {
  mock.store(on)
  mock.env(on, { USER: 'peter' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /\/tank host/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/tank join/ })).toBeDefined()
    await ui.unmount()
  }
})

// 통신 프로그램 대신 ready와 화면 한 장을 보내고, 나가라는 말을 받으면 끝난다
function fakeHelper(on: Parameters<TestBody>[1], snap: object) {
  mock.store(on)
  mock.env(on, { USER: 'peter' })
  const posts: { url: string; body: string }[] = []
  const argvs: string[][] = []
  const copied: string[] = []
  let quit = () => {}
  const quitting = new Promise<void>(resolve => {
    quit = resolve
  })
  on('command.register', () => ({ value: { command: 'tank' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  mock.clock(on)
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, body: String(e.init?.body ?? '') })
    if (e.url.endsWith('/quit')) quit()
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('process.spawn', async function* (_, e) {
    argvs.push([...e.argv])
    yield line({ t: 'ready', ips: ['192.168.0.10'], port: 7777 })
    yield line(snap)
    await quitting
    return { value: { code: 0, signal: null } }
  })
  return { posts, argvs, copied }
}

test('hosting draws the game and sends arrow keys to the helper', { timeoutMs: 20000 }, async ($, on) => {
  const { posts, argvs, copied } = fakeHelper(on, SNAP)

  const ran = await $.command.run(typed('host 1234'))
  expect(ran.text).toContain('내 IP: 192.168.0.10')
  expect(ran.text).toContain('/tank join 192.168.0.10 1234')
  expect(copied).toEqual(['/tank join 192.168.0.10 1234'])
  expect(argvs[0]?.join(' ')).toContain('--pw 1234 --port 7777 --map normal')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /남은 탱크/, in: 'game' }))?.text).toBe('남은 시간 1:23 · 남은 탱크 2대')
    expect(await ui.find({ type: 'Text', text: /방장/, in: 'game' })).toBeDefined()
    // 맵의 탱크는 이모지가 아니라 블록 글자로 그린다
    expect(await ui.find({ type: 'Text', text: '█━', in: 'game' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '192.168.0.10', in: 'game' })).toBeDefined()
    await ui.key({ key: 'right', in: 'game' })
    await ui.key({ key: ' ', in: 'game' })
    await ui.unmount()
  }

  const inputs = posts.filter(p => p.url.endsWith('/input')).map(p => JSON.parse(p.body))
  expect(inputs).toEqual([{ k: 'right' }, { k: 'fire' }, { k: 'right' }, { k: 'fire' }])

  const left = await $.command.run(typed('leave'))
  expect(left.text).toBe('🐾 방에서 나왔어요.')
})

test('the host can pick the big map, written before or after the password', { timeoutMs: 20000 }, async ($, on) => {
  // 큰 맵: 38×17, 내 탱크는 오른쪽 끝 줄에
  const big = { ...SNAP, w: 38, h: 17, g: '.'.repeat(38 * 17), p: [player(1, '방장', 37, 16)] }
  const { argvs } = fakeHelper(on, big)

  const ran = await $.command.run(typed('host 큰맵 1234'))
  expect(ran.text).toContain('큰 맵으로 방이 열렸어요!')
  expect(ran.text).toContain('/tank join 192.168.0.10 1234')
  expect(argvs[0]?.join(' ')).toContain('--pw 1234 --port 7777 --map big')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 84 } })
  expect(await ui.find({ type: 'Text', text: '█━', in: 'game' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /좁아요/, in: 'game' })).toBeUndefined()
  await ui.unmount()

  // 좁은 창에서는 넓혀달라고 한다
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await narrow.find({ type: 'Text', text: /맵은/, in: 'game' }))?.text).toBe('지금 60칸, 맵은 78칸이 필요해요.')
  await narrow.unmount()

  await $.command.run(typed('leave'))
  await $.command.run(typed('host 1234 big'))
  expect(argvs[1]?.join(' ')).toContain('--pw 1234 --port 7777 --map big')
  await $.command.run(typed('leave'))
})
