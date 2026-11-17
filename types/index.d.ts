// Which image the viewer pane shows: the thumbnails' cache key and the image's place in it.
// An empty key means none has been chosen.
export type Viewing = { key: string; index: number }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': { viewing: Shaped<Viewing> }
  }
}
