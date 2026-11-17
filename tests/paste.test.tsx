import { expect, test } from 'claude-code/testing'

const ROW = (text: string) =>
  ({
    plugin: 'inline-images',
    component: 'UserMessage',
    surface: 'terminal',
    props: { text, origin: { kind: 'composer' }, isExpanded: true },
  }) as const

test('a prompt with an image the mod cannot read is still sent as typed', async ($, on) => {
  let sent: string | undefined
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text }
  })

  const result = await $.prompt.submit({
    text: 'what is this? [Image #1]',
    attachments: [{ type: 'image', mediaType: 'image/png', id: 'not-held' }],
  } as any)

  expect(sent).toBe('what is this? [Image #1]')
  expect((result as { text?: string }).text).toBe('what is this? [Image #1]')
})

test('a message with no pasted images draws as the engine draws it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const ui = await $.ui.mount(ROW('hello') as any)
  expect((await ui.find({ type: 'Text', text: /engine row/ }))?.text).toBe('engine row')
  expect(await ui.find({ type: 'Text', text: /image/ })).toBeUndefined()
  await ui.unmount()
})

const VIEWER = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'inline-images',
    component: 'Pane',
    requestId: 'inline-images-viewer',
    surface,
    props: {
      title: 'Image',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

test('the viewer pane with nothing chosen says so and offers close, on every surface', async ($, on) => {
  on('ui.close', () => ({}))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(VIEWER(surface) as any)
    expect((await ui.find({ type: 'Text', text: /No image selected/ }))?.text).toBe('No image selected.')
    expect(await ui.find({ type: 'Button', key: 'close' } as any)).toBeDefined()
    await ui.unmount()
  }
})

test('a choice an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { key: 'old', index: 3 }, version: 1 } }))
  const ui = await $.ui.mount(VIEWER('terminal') as any)
  expect((await ui.find({ type: 'Text', text: /No image selected/ }))?.text).toBe('No image selected.')
  await ui.unmount()
})
