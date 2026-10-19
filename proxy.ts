// A small proxy in front of a dev server for its preview: everything passes through (WebSockets
// too, for hot reload), and HTML pages get one script added, ChoiTerm's annotate.js, so the owner
// can point at an element in the preview and send it to an agent. It listens on 127.0.0.1 only;
// other devices reach it through `tailscale serve`.
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect } from 'node:net'

export const ANNOTATE_PATH = '/__choiterm__/annotate.js'
// html2canvas, which annotate.js loads to crop a picture of the element picked.
export const SHOT_PATH = '/__choiterm__/html2canvas.js'
const TAG = `<script src="${ANNOTATE_PATH}"></script>`

export interface Proxy {
  url: string
  close(): void
}

// The script goes right after <head> (or <html>, or first), so it runs before the page's own.
export function injectScript(html: string): string {
  const head = html.match(/<head[^>]*>/i)

  if (head?.index !== undefined) return html.slice(0, head.index + head[0].length) + TAG + html.slice(head.index + head[0].length)

  const root = html.match(/<html[^>]*>/i)

  if (root?.index !== undefined) return html.slice(0, root.index + root[0].length) + TAG + html.slice(root.index + root[0].length)

  return TAG + html
}

// Headers for the dev server: its own host (dev servers refuse unknown ones) and no compression,
// so HTML can be read and changed.
export function upstreamHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  return { ...headers, host, 'accept-encoding': 'identity' }
}

// A redirect to the dev server's own address stays inside the preview.
export function localLocation(location: string, target: string): string {
  return location.startsWith(target) ? location.slice(target.length) || '/' : location
}

export function startProxy(target: string, script: () => string, shotLib: () => string = () => ''): Promise<Proxy> {
  const upstream = new URL(target)
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '')
  const port = Number(upstream.port)

  const server: Server = createServer((req, res) => {
    if (req.url === ANNOTATE_PATH || req.url === SHOT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(req.url === ANNOTATE_PATH ? script() : shotLib())

      return
    }

    const forward = request({ hostname, port, path: req.url, method: req.method, headers: upstreamHeaders(req.headers, upstream.host) }, (reply) => {
      const headers = { ...reply.headers }
      const html = /text\/html/i.test(String(headers['content-type'] ?? ''))

      if (typeof headers.location === 'string') headers.location = localLocation(headers.location, target)

      if (!html) {
        res.writeHead(reply.statusCode ?? 502, headers)
        reply.pipe(res)

        return
      }

      const chunks: Buffer[] = []

      reply.on('data', (chunk: Buffer) => chunks.push(chunk))
      reply.on('end', () => {
        // The dev server failed half way and the error answer went out already.
        if (res.headersSent) return

        // latin1 keeps every byte as it was, whatever the page's own encoding.
        const body = Buffer.from(injectScript(Buffer.concat(chunks).toString('latin1')), 'latin1')

        delete headers['content-length']
        delete headers['transfer-encoding']
        res.writeHead(reply.statusCode ?? 200, { ...headers, 'content-length': String(body.length) })
        res.end(body)
      })
    })

    forward.on('error', () => {
      if (res.headersSent) {
        res.destroy()

        return
      }

      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('개발 서버가 응답하지 않아요')
    })
    req.pipe(forward)
  })

  // Hot reload sockets: the upgrade request goes through as it came, then bytes both ways.
  server.on('upgrade', (req, socket, head) => {
    const through = connect(port, hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]

      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index] ?? ''

        lines.push(`${name}: ${name.toLowerCase() === 'host' ? upstream.host : req.rawHeaders[index + 1]}`)
      }

      through.write(`${lines.join('\r\n')}\r\n\r\n`)
      through.write(head)
      through.pipe(socket)
      socket.pipe(through)
    })

    through.on('error', () => socket.destroy())
    socket.on('error', () => through.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : 0

      resolve({ url: `http://127.0.0.1:${bound}`, close: () => server.close() })
    })
  })
}
