import type { McpToolContext, YouTubeSearchResults, YouTubeSearchResultItem } from '../types'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import * as dotenv from 'dotenv'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

dotenv.config()

const execPromise = promisify(exec)

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3'
const YOUTUBE_MUSIC_WATCH_URL_PREFIX = 'https://music.youtube.com/watch?v='

async function searchYoutubeVideo(
  apiKey: string,
  query: string,
  maxResults: number = 5,
): Promise<YouTubeSearchResultItem[]> {
  try {
    const searchResults = await ofetch<YouTubeSearchResults>('/search', {
      baseURL: YOUTUBE_API_BASE_URL,
      query: {
        key: apiKey,
        part: 'snippet',
        maxResults,
        type: 'video',
        q: query,
      },
    })
    return searchResults?.items ?? []
  }
  catch (error: unknown) {
    console.error('Error fetching YouTube search results:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred during YouTube search'
    throw new McpError(ErrorCode.InternalError, `YouTube API search failed: ${errorMessage}`)
  }
}

async function openUrlInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  let command: string = ''

  try {
    if (platform === 'darwin') {
      const appleScript = `tell application "Google Chrome" to open location "${url}"`
      command = `osascript -e '${appleScript.replace(/'/g, "'\''")}'`
      console.log(`Executing command for macOS: ${command}`)
      const { stderr } = await execPromise(command)
      if (stderr) {
        console.warn('osascript stderr:', stderr)
      }
    }
    else if (platform === 'win32') {
      command = `start "" "${url}"`
      console.log(`Executing command for Windows: ${command}`)
      await execPromise(command)
    }
    else {
      // Assume Linux/other POSIX-like
      command = `xdg-open "${url}"`
      console.log(`Executing command for Linux/Other: ${command}`)
      await execPromise(command)
    }
  }
  catch (execError: unknown) {
    console.error(`Error executing command "${command}":`, execError)
    const errorMsg = execError instanceof Error ? execError.message : 'Unknown execution error'
    throw new McpError(ErrorCode.InternalError, `Failed to open URL in browser: ${errorMsg}`)
  }
}

async function downloadYoutubeAudio(
  videoId: string,
  outputDir?: string,
): Promise<string> {
  const dir = outputDir || path.join(os.tmpdir(), 'youtube-audio')
  await fs.mkdir(dir, { recursive: true })

  const outputTemplate = path.join(dir, '%(title)s.%(ext)s')
  const url = `https://www.youtube.com/watch?v=${videoId}`
  const command = `yt-dlp -x --audio-format mp3 -o "${outputTemplate}" "${url}"`

  try {
    console.log(`Downloading audio with command: ${command}`)
    const { stdout, stderr } = await execPromise(command)
    if (stderr) {
      console.warn('yt-dlp stderr:', stderr)
    }
    // Parse stdout to find the actual file path
    // yt-dlp prints the final file path after download
    const lines = stdout.split('\n')
    const fileLine = lines.find(line => line.includes('[ExtractAudio] Destination:'))
    let filePath: string | undefined
    if (fileLine) {
      filePath = fileLine.split('Destination:')[1]?.trim()
    }
    if (!filePath) {
      // Fallback: find the most recent .mp3 file in the directory
      const files = await fs.readdir(dir)
      const mp3Files = files.filter(f => f.endsWith('.mp3'))
      if (mp3Files.length === 0) {
        throw new Error('Could not determine downloaded file path')
      }
      // Get stats for each file to sort by modification time
      const filesWithStats = await Promise.all(
        mp3Files.map(async (file) => {
          const stat = await fs.stat(path.join(dir, file))
          return { file, mtimeMs: stat.mtimeMs }
        })
      )
      filesWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs) // descending, most recent first
      filePath = path.join(dir, filesWithStats[0].file)
    }
    console.log(`Downloaded audio to: ${filePath}`)
    return filePath
  } catch (error: unknown) {
    console.error('Error downloading audio:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during download'
    throw new McpError(ErrorCode.InternalError, `YouTube audio download failed: ${errorMessage}`)
  }
}

export function registerToolYoutubeMusic({ mcp }: McpToolContext): void {
  if (!YOUTUBE_API_KEY) {
    console.error('YOUTUBE_API_KEY environment variable is not set. YouTube tools will not be registered.')
    return
  }

  const apiKey = YOUTUBE_API_KEY // Make it const within the scope

  mcp.tool(
    'searchTrack',
    'Search for tracks on YouTube Music by name.',
    {
      trackName: z.string().describe('The name of the track to search for'),
    },
    async ({ trackName }) => {
      try {
        const searchResults = await searchYoutubeVideo(apiKey, trackName, 5)
        return {
          content: [
            { type: 'text', text: JSON.stringify(searchResults, null, 2) },
          ],
        }
      }
      catch (error: unknown) {
        console.error('Error in searchTrack tool:', error)
        const message = error instanceof McpError ? error.message : 'An unexpected error occurred during search.'
        return {
          content: [{ type: 'text', text: `Error searching YouTube: ${message}` }],
          isError: true,
        }
      }
    },
  )

  mcp.tool(
    'playTrack',
    'Search for a track on YouTube Music and open the top result in the default browser.',
    {
      trackName: z.string().describe('The name of the track to search for and play'),
    },
    async ({ trackName }) => {
      try {
        const searchResults = await searchYoutubeVideo(apiKey, trackName, 1)

        if (searchResults.length === 0) {
          return {
            content: [{ type: 'text', text: `No search results found for: ${trackName}` }],
          }
        }

        const topResult = searchResults[0]
        const videoId = topResult?.id?.videoId
        const title = topResult?.snippet?.title ?? 'Unknown Title'

        if (!videoId) {
          console.error('Could not find video ID in top search result:', topResult)
          throw new McpError(ErrorCode.InternalError, 'Could not extract video ID from YouTube search result.')
        }

        const youtubeMusicUrl = `${YOUTUBE_MUSIC_WATCH_URL_PREFIX}${videoId}`

        await openUrlInBrowser(youtubeMusicUrl)

        return {
          content: [{ type: 'text', text: `Attempting to play in browser: ${title} (${youtubeMusicUrl})` }],
        }
      }
      catch (error: unknown) {
        console.error('Error in playTrack tool:', error)
        if (error instanceof McpError && error.code === ErrorCode.InternalError) {
          throw error
        }
        const message = error instanceof McpError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'An unexpected error occurred during track playback.'

        return {
          content: [{ type: 'text', text: `Error playing track: ${message}` }],
          isError: true,
        }
      }
    },
  )

  mcp.tool(
    'downloadTrack',
    'Search for a track on YouTube Music, download the audio, and return the file path.',
    {
      trackName: z.string().describe('The name of the track to search for and download'),
    },
    async ({ trackName }) => {
      try {
        const searchResults = await searchYoutubeVideo(apiKey, trackName, 1)

        if (searchResults.length === 0) {
          return {
            content: [{ type: 'text', text: `No search results found for: ${trackName}` }],
          }
        }

        const topResult = searchResults[0]
        const videoId = topResult?.id?.videoId
        const title = topResult?.snippet?.title ?? 'Unknown Title'

        if (!videoId) {
          console.error('Could not find video ID in top search result:', topResult)
          throw new McpError(ErrorCode.InternalError, 'Could not extract video ID from YouTube search result.')
        }

        const filePath = await downloadYoutubeAudio(videoId)

        return {
          content: [
            { type: 'text', text: `Downloaded audio: ${title}` },
            { type: 'text', text: `File path: ${filePath}` },
          ],
        }
      }
      catch (error: unknown) {
        console.error('Error in downloadTrack tool:', error)
        if (error instanceof McpError && error.code === ErrorCode.InternalError) {
          throw error
        }
        const message = error instanceof McpError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'An unexpected error occurred during track download.'

        return {
          content: [{ type: 'text', text: `Error downloading track: ${message}` }],
          isError: true,
        }
      }
    },
  )
}
