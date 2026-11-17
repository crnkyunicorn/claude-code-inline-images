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
