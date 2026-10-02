/**
 * Tier 3: the bitmap.
 *
 * The last resort, for subtrees that cannot be moved and cannot be rebuilt —
 * a WebGL canvas, a subtree behind a shadow boundary, a virtualised row whose
 * position is recomputed every frame. An image is always wrong in the same
 * predictable way, which makes it a better answer than a broken live copy.
 *
 * A bitmap has no handlers, no focus and no state. Callers should present it as
 * a picture, not as a panel.
 */
import type { Rect } from '../shared/types.ts'

/** The image produced for a subtree. */
export interface BitmapResult {
  /** A data URL holding the rendered image. */
  readonly dataUrl: string
  /** The rect that was rendered. */
  readonly rect: Rect
  /** Whether the capture fell back to a lower-fidelity method. */
  readonly degraded: boolean
}

/**
 * Render an element to a PNG data URL using SVG `foreignObject`.
 *
 * The element is serialised into an SVG wrapper and rasterised by the browser's
 * own renderer. Two constraints come with this approach and both are inherent:
 *
 * - The serialisation is a copy, so a canvas inside it contributes nothing.
 *   There is no way to embed a live bitmap in serialised markup.
 * - External resources referenced by URL (images, fonts, stylesheets) must be
 *   fetchable and CORS-permitted, or the canvas becomes tainted and reading it
 *   back throws.
 *
 * A tainted or empty result is reported rather than thrown, because the caller
 * still has the option of the Electron `capturePage` fallback.
 * @param element - the element to rasterise.
 * @param rect - the area to render, usually the element's current rect.
 * @returns the image, or null when rasterisation was not possible.
 */
export async function rasterize(element: Element, rect: Rect): Promise<BitmapResult | null> {
  const scale = window.devicePixelRatio || 1
  const serialized = new XMLSerializer().serializeToString(element)

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"`,
    ` viewBox="0 0 ${rect.width} ${rect.height}">`,
    `<foreignObject width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${rect.width}px;height:${rect.height}px">`,
    serialized,
    '</div></foreignObject></svg>',
  ].join('')

  // SVG is decoded as an image, outside the live document.
  // Chromium taints foreignObject images loaded from blob URLs. An embedded
  // SVG data URL keeps the rasterized result readable by the canvas.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.width * scale))
    canvas.height = Math.max(1, Math.round(rect.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.scale(scale, scale)
    context.drawImage(image, 0, 0)
    return { dataUrl: canvas.toDataURL('image/png'), rect, degraded: false }
  } catch {
    // Tainted canvas, unreadable resource, or an image the engine refused to
    // decode. The Electron path handles these; here it is simply unavailable.
    return null
  }
}

/**
 * Load a blob URL into an image element.
 * @param url - the blob URL to decode.
 * @returns the decoded image.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('SVG rasterisation failed'))
    image.src = url
  })
}

/**
 * Ask the desktop shell for a native screenshot of a rect.
 *
 * Preferred over `rasterize` on the desktop, because it captures what is
 * actually on screen: canvases, WebGL, cross-origin images and fonts all come
 * out correct, and there is no tainting problem to work around.
 * @param invoke - the shell's IPC invoke function.
 * @param rect - the area to capture, in CSS pixels relative to the viewport.
 * @returns the image, or null when the shell did not provide one.
 */
export async function capturePage(
  invoke: (channel: string, payload: unknown) => Promise<unknown>,
  rect: Rect,
): Promise<BitmapResult | null> {
  try {
    const result = await invoke('better-float:capture-page', {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
    if (typeof result === 'string') return { dataUrl: result, rect, degraded: false }
    return null
  } catch {
    return null
  }
}

/**
 * Present a bitmap as a static panel node.
 * @param result - the captured image.
 * @returns an element showing the image at its natural size.
 */
export function bitmapNode(result: BitmapResult): HTMLImageElement {
  const image = document.createElement('img')
  image.src = result.dataUrl
  image.width = Math.round(result.rect.width)
  image.height = Math.round(result.rect.height)
  image.alt = ''
  image.setAttribute('aria-hidden', 'true')
  image.draggable = false
  return image
}
