import type { McpToolContext } from './types'
import { version } from '../package.json'
import { createServer, startServer, stopServer } from './server'
import { registerToolYoutubeMusic } from './tools/youtube'

(async function main() {
  const mcp = createServer({
    name: 'youtube-music-mcp',
    version: version || '0.0.1',
  })

  process.on('SIGTERM', () => stopServer(mcp))
  process.on('SIGINT', () => stopServer(mcp))

  registerToolYoutubeMusic({ mcp } as McpToolContext)

  await startServer(mcp)
})()
