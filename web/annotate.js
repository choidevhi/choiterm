// Added by ChoiTerm's preview proxy to the pages of a dev server: while ChoiTerm asks, the element
// under the pointer is outlined, and a click sends what it is (tag, text, a selector, its HTML and
// main styles) to ChoiTerm instead of clicking it. Nothing else changes in the page.
(() => {
  if (window.__choitermAnnotate || window.parent === window) return

  window.__choitermAnnotate = true

  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-weight', 'border', 'border-radius', 'gap']
  let on = false
  let box = null
  let label = null

  function ensureOverlay() {
    if (box !== null) return

    box = document.createElement('div')
    label = document.createElement('div')
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e8794f;background:rgba(232,121,79,.12);border-radius:3px;display:none'
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;background:#e8794f;color:#fff;font:600 11px/1.4 system-ui,sans-serif;display:none'
    document.documentElement.append(box, label)
  }

  function selectorOf(element) {
    const parts = []

    for (let node = element; node && node.nodeType === 1 && node !== document.body && parts.length < 6; node = node.parentElement) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }

      const parent = node.parentElement
      const same = parent ? [...parent.children].filter((child) => child.tagName === node.tagName) : []
      const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''

      parts.unshift(`${node.tagName.toLowerCase()}${nth}`)
    }

    return parts.join(' > ')
  }

  function describe(element) {
    const style = getComputedStyle(element)
    const text = (element.value ?? element.innerText ?? '').toString().replace(/\s+/g, ' ').trim()

    return {
      tag: element.tagName.toLowerCase() + (element.classList.length ? `.${[...element.classList].slice(0, 3).join('.')}` : ''),
      text: text.slice(0, 120),
      selector: selectorOf(element),
      html: element.outerHTML.replace(/\s+/g, ' ').slice(0, 600),
      styles: STYLE_KEYS.map((key) => `${key}: ${style.getPropertyValue(key)}`).join('; '),
      url: location.href,
    }
  }

  function outline(element) {
    const rect = element.getBoundingClientRect()

    box.style.display = 'block'
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    label.style.display = 'block'
    label.textContent = describe(element).tag
    label.style.left = `${rect.left}px`
    label.style.top = `${Math.max(0, rect.top - 22)}px`
  }

  // html2canvas comes from ChoiTerm's proxy on first use; a picture that takes too long is skipped.
  const SHOT_PATH = '/__choiterm__/html2canvas.js'
  const SHOT_WAIT_MS = 5000
  const SHOT_MAX_PX = 1000
  let library = null

  function loadLibrary() {
    library ??= new Promise((resolve) => {
      const tag = document.createElement('script')

      tag.src = SHOT_PATH
      tag.onload = () => resolve(window.html2canvas ?? null)
      tag.onerror = () => resolve(null)
      document.head.append(tag)
    })

    return library
  }

  async function picture(element) {
    const draw = await loadLibrary()

    if (typeof draw !== 'function') return null

    const rect = element.getBoundingClientRect()
    const scale = Math.min(window.devicePixelRatio || 1, SHOT_MAX_PX / Math.max(rect.width, rect.height, 1))
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SHOT_WAIT_MS))

    box.style.display = 'none'
    label.style.display = 'none'

    try {
      const canvas = await Promise.race([draw(element, { logging: false, scale, useCORS: true, backgroundColor: null }), timeout])

      return canvas ? canvas.toDataURL('image/png') : null
    } catch {
      return null
    } finally {
      box.style.display = 'block'
      label.style.display = 'block'
    }
  }

  addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.choiterm !== 'annotate') return

    on = event.data.on === true
    ensureOverlay()

    if (!on) {
      box.style.display = 'none'
      label.style.display = 'none'
    }
  })

  addEventListener('mousemove', (event) => {
    if (!on) return

    const element = document.elementFromPoint(event.clientX, event.clientY)

    if (element && element !== box) outline(element)
  }, true)

  // While pointing, a click (or tap) picks the element and does nothing else in the page.
  addEventListener('click', (event) => {
    if (!on) return

    event.preventDefault()
    event.stopPropagation()

    const element = document.elementFromPoint(event.clientX, event.clientY)

    if (!element) return

    outline(element)

    const info = describe(element)
    const at = { x: event.clientX, y: event.clientY }

    window.parent.postMessage({ choiterm: 'annotated', info, ...at }, '*')
    void picture(element).then((shot) => window.parent.postMessage({ choiterm: 'annotated-shot', selector: info.selector, shot }, '*'))
  }, true)
})()
