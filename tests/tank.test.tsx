import { expect, mock, test } from 'claude-code/testing'

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

test('hosting draws the game and sends arrow keys to the helper', { timeoutMs: 20000 }, async ($, on) => {
  mock.store(on)
  mock.env(on, { USER: 'peter' })
  const posts: { url: string; body: string }[] = []
  let quit = () => {}
  const quitting = new Promise<void>(resolve => {
    quit = resolve
  })
  on('command.register', () => ({ value: { command: 'tank' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  const copied: string[] = []
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
  on('process.spawn', async function* () {
    yield line({ t: 'ready', ips: ['192.168.0.10'], port: 7777 })
    yield line(SNAP)
    await quitting
    return { value: { code: 0, signal: null } }
  })

  const ran = await $.command.run(typed('host 1234'))
  expect(ran.text).toContain('내 IP: 192.168.0.10')
  expect(ran.text).toContain('/tank join 192.168.0.10 1234')
  expect(copied).toEqual(['/tank join 192.168.0.10 1234'])

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
