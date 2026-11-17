# inline-images

A Claude Code mod that draws images from tool results inline in the terminal transcript. This covers screenshots, images Claude reads with the Read tool, and images returned by MCP tools.

Without it, a tool result that holds an image appears in the transcript as a line of text. With it, you see the image itself, under the tool call that produced it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace crnkyunicorn/claude-code-inline-images
```

Answer `y` to add the marketplace, then press Enter to install at the user scope. The mod is active straight away, and in every session after.

From a shell:

```sh
claude plugin install inline-images --marketplace crnkyunicorn/claude-code-inline-images
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins** → **Add marketplace** with `crnkyunicorn/claude-code-inline-images`, then **Add plugin**.

## What it does

- **Where images appear:** under any finished tool call whose output contains an image, including Read results folded into a "Read N files" row.
- **Image formats it finds:** Read tool images, MCP image results, and API-style image blocks.
- **Size:** each image is scaled to fit the terminal, at most 100 columns wide and 40 rows tall. It shows up to 4 images per tool call.
- **PNGs** up to 2 MB are drawn directly.
- **Other formats** (JPEG, GIF, WebP, …) and large PNGs are converted to a PNG at most 1600px on the longest edge. Conversion uses the first of these that's available:
  1. Python with [Pillow](https://pypi.org/project/pillow/) (`pip install pillow`)
  2. `sips` (built into macOS)
  3. `ffmpeg`
- **When an image can't be drawn,** a dim `⎿ image not shown: <reason>` line appears instead.

## Requirements

- **Claude Code** with plugin hooks support. The hooks API is early access, so a future Claude Code release may change it.
- **A terminal that can show images,** for example Ghostty, Kitty, WezTerm or iTerm2.
- **A converter** from the list above, only for non-PNG images.

## Files

```
.claude-plugin/plugin.json        mod manifest
.claude-plugin/marketplace.json   makes this repo installable with /plugin install
hooks/hooks.json                  points Claude Code at the hooks module
hooks/register.tsx                the mod
```
