import type { McpToolContext, YouTubeSearchResults, YouTubeSearchResultItem } from '../types'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import * as dotenv from 'dotenv'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

dotenv.config()

const execPromise = promisify(exec)

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3'
const YOUTUBE_MUSIC_WATCH_URL_PREFIX = 'https://music.youtube.com/watch?v='

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads', 'audio')

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

async function downloadAudioWithYtDlp(videoUrl: string, videoTitle: string): Promise<string> {
  try {
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true })

    const outputFilePath = path.join(DOWNLOAD_DIR, `${videoTitle}.%(ext)s`)
    const command = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" "${videoUrl}"`
    console.log(`Executing yt-dlp command: ${command}`)

    const { stdout, stderr } = await execPromise(command)

    if (stderr) {
      console.warn('yt-dlp stderr:', stderr)
    }
    console.log('yt-dlp stdout:', stdout)

    const match = stdout.match(/\[ExtractAudio\] Destination: (.+\.mp3)/)
    if (match && match) { // Corrected: return match
      return match // Return the full path to the downloaded file
    }
    else {
      // Fallback if regex doesn't match, try to find a file in the directory
      const files = await fs.readdir(DOWNLOAD_DIR)
      // Clean up title for filename matching, yt-dlp might sanitize it
      const sanitizedTitle = videoTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
      const downloadedFile = files.find((file: string) => file.includes(sanitizedTitle) && file.endsWith('.mp3')) // Explicitly type file
      if (downloadedFile) {
        return path.join(DOWNLOAD_DIR, downloadedFile)
      }
      throw new McpError(ErrorCode.InternalError, 'Could not determine downloaded audio file path.')
    }
  }
  catch (execError: unknown) {
    console.error(`Error executing yt-dlp command to download "${videoUrl}":`, execError)
    const errorMsg = execError instanceof Error ? execError.message : 'Unknown execution error'
    throw new McpError(ErrorCode.InternalError, `Failed to download audio with yt-dlp: ${errorMsg}`)
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
    async ({ trackName }: { trackName: string }) => { // Explicitly type trackName
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
    'Search for a track on YouTube Music and download its audio.',
    {
      trackName: z.string().describe('The name of the track to search for and download audio'),
    },
    async ({ trackName }: { trackName: string }) => { // Explicitly type trackName
      try {
        const searchResults = await searchYoutubeVideo(apiKey, trackName, 1)

        if (searchResults.length === 0) {
          return {
            content: [{ type: 'text', text: `No search results found for: ${trackName}` }],
          }
        }

        const topResult = searchResults // Corrected: use searchResults
        const videoId = topResult?.id?.videoId
        const title = topResult?.snippet?.title ?? 'Unknown Title'

        if (!videoId) {
          console.error('Could not find video ID in top search result:', topResult)
          throw new McpError(ErrorCode.InternalError, 'Could not extract video ID from YouTube search result.')
        }

        const youtubeVideoUrl = `https://www.youtube.com/watch?v=${videoId}`

        const downloadedFilePath = await downloadAudioWithYtDlp(youtubeVideoUrl, title)

        return {
          content: [{ type: 'text', text: `Downloaded audio for: ${title} to ${downloadedFilePath}` }],
          audioUrl: downloadedFilePath, // Assuming the client can handle a local file path or a URL to serve it
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
            : 'An unexpected error occurred during track download.'

        return {
          content: [{ type: 'text', text: `Error downloading track: ${message}` }],
          isError: true,
        }
      }
    },
  )
}
