import dns, { type LookupAddress } from 'node:dns';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegPkg from 'ffmpeg-static';
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import { Ytdl } from '@distube/ytdl-core';
import spotifyUrlInfo from 'spotify-url-info';
import ytSearch from 'yt-search';
import { config } from './config.js';
import { log } from './logger.js';
import { isPrivateAddress } from './network-guard.js';

const spotify = spotifyUrlInfo(fetch);

export function isYouTubeUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch {
    return false;
  }
}

export function isSpotifyUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.hostname.toLowerCase().includes('spotify.com');
  } catch {
    return false;
  }
}

export function isYouTubePlaylistUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase();
    const isYt = host.includes('youtube.com') || host.includes('youtu.be');
    return isYt && (url.searchParams.has('list') || url.pathname.includes('/playlist'));
  } catch {
    return false;
  }
}

export function cleanYouTubeVideoUrl(urlText: string): string {
  try {
    const url = new URL(urlText);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.slice(1);
      return id ? `https://www.youtube.com/watch?v=${id}` : urlText;
    }
    const id = url.searchParams.get('v');
    if (id) return `https://www.youtube.com/watch?v=${id}`;
    return urlText;
  } catch {
    return urlText;
  }
}

export async function extractYouTubePlaylistVideos(urlText: string): Promise<Array<{ title: string; url: string; videoId: string }>> {
  try {
    const fetchUrl = urlText.replace('music.youtube.com', 'www.youtube.com');
    const html = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10_000)
    }).then(r => r.text());

    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const playlistTitle = titleMatch?.[1]?.replace(' - YouTube', '').trim() || 'YouTube Playlist';

    const matches = [...html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)];
    const uniqueIds: string[] = [...new Set(matches.map(m => m[1]).filter((id): id is string => typeof id === 'string' && id.length === 11))];

    try {
      const v = new URL(urlText).searchParams.get('v');
      if (v && uniqueIds.includes(v)) {
        const idx = uniqueIds.indexOf(v);
        uniqueIds.splice(idx, 1);
        uniqueIds.unshift(v);
      }
    } catch {}

    return uniqueIds.map((id, index) => ({
      title: `${playlistTitle} #${index + 1}`,
      url: `https://www.youtube.com/watch?v=${id}`,
      videoId: id
    }));
  } catch (error) {
    log('warn', 'youtube_playlist_extract_failed', { url: urlText, error });
    return [];
  }
}

export interface Track {
  title: string;
  url: string;
  requestedBy: string;
  artist?: string;
  catalogueTrackId?: number;
  genreTags?: string[];
  moodTags?: string[];
  language?: string;
  bpm?: number;
  energy?: number;
  durationSeconds?: number;
}

function parseApprovedUrl(urlText: string): URL {
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('That does not look like a valid URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTPS/HTTP audio links are accepted.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not accepted.');

  if (config.audioAllowedHosts.size > 0 && !config.audioAllowedHosts.has('*')) {
    if (!config.audioAllowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error(`Host ${url.hostname} is not in the approved hosts list. Configure AUDIO_ALLOWED_HOSTS=* to allow all public audio streams.`);
    }
  }
  return url;
}

export function validateConfiguredAudioUrl(urlText: string): void {
  if (isYouTubeUrl(urlText) || isSpotifyUrl(urlText)) return;
  parseApprovedUrl(urlText);
}

export async function resolveTrackMetadata(urlText: string, requestedBy: string, customTitle?: string): Promise<Track> {
  const tracks = await resolvePlayableTracks(urlText, requestedBy, customTitle);
  if (!tracks.length) throw new Error('No playable track could be resolved.');
  return tracks[0]!;
}

export async function resolvePlayableTracks(input: string, requestedBy: string, customTitle?: string): Promise<Track[]> {
  const trimmed = input.trim();

  // 1. Spotify
  if (isSpotifyUrl(trimmed)) {
    try {
      const isSingleTrack = trimmed.includes('/track/');
      if (isSingleTrack) {
        const data = await spotify.getData(trimmed);
        const artist = data.artists?.[0]?.name || data.artist || '';
        const title = customTitle || data.name || 'Spotify Track';
        const query = `${title} ${artist}`.trim();
        const searchRes = await ytSearch(query);
        const first = searchRes.videos[0];
        if (first) {
          return [{
            url: first.url,
            title: first.title,
            artist: first.author?.name || artist,
            durationSeconds: first.seconds,
            requestedBy
          }];
        }
      } else {
        const tracks = await spotify.getTracks(trimmed);
        if (tracks.length > 0) {
          const limit = Math.min(tracks.length, 30);
          const resolved: Track[] = [];
          for (let i = 0; i < limit; i++) {
            const t = tracks[i]!;
            const artist = t.artists?.[0]?.name || t.artist || '';
            const query = `${t.name} ${artist}`.trim();
            try {
              const res = await ytSearch(query);
              const v = res.videos[0];
              if (v) {
                resolved.push({
                  url: v.url,
                  title: t.name,
                  artist: artist || v.author?.name,
                  durationSeconds: v.seconds,
                  requestedBy
                });
              }
            } catch {}
          }
          if (resolved.length > 0) return resolved;
        }
      }
    } catch (spotifyErr) {
      log('warn', 'spotify_resolve_failed', { url: trimmed, error: spotifyErr });
    }
  }

  // 2. YouTube Playlist
  if (isYouTubePlaylistUrl(trimmed)) {
    const listVideos = await extractYouTubePlaylistVideos(trimmed);
    if (listVideos.length > 0) {
      return listVideos.slice(0, 50).map((v) => ({
        url: v.url,
        title: v.title,
        requestedBy
      }));
    }
  }

  // 3. YouTube Single Video
  if (isYouTubeUrl(trimmed)) {
    const cleanUrl = cleanYouTubeVideoUrl(trimmed);
    try {
      const metaYtdl = new Ytdl();
      const info = await metaYtdl.getInfo(cleanUrl);
      const title = customTitle || info.videoDetails.title || 'YouTube Audio';
      const artist = info.videoDetails.author?.name || undefined;
      const durationSeconds = Number(info.videoDetails.lengthSeconds) || undefined;
      return [{
        url: cleanUrl,
        title,
        artist,
        durationSeconds,
        requestedBy
      }];
    } catch {
      return [{
        url: cleanUrl,
        title: customTitle || 'YouTube Audio',
        requestedBy
      }];
    }
  }

  // 4. Search query
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    try {
      const searchRes = await ytSearch(trimmed);
      const v = searchRes.videos[0];
      if (v) {
        return [{
          url: v.url,
          title: customTitle || v.title,
          artist: v.author?.name,
          durationSeconds: v.seconds,
          requestedBy
        }];
      }
    } catch (searchErr) {
      log('warn', 'yt_search_keyword_failed', { query: trimmed, error: searchErr });
    }
  }

  // 5. Direct audio
  validateConfiguredAudioUrl(trimmed);
  return [{
    url: trimmed,
    title: customTitle || displayTitleFromUrl(trimmed),
    requestedBy
  }];
}

/**
 * DNS lookup used for the actual TCP connection. Validating the address here (instead of resolving
 * once up front and letting fetch resolve again) closes the DNS-rebinding window: the address that
 * is checked is the address that is connected to.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some(({ address }) => isPrivateAddress(address))) {
      return callback(Object.assign(new Error('The audio host resolved to a private or invalid network address.'), { code: 'EBLOCKEDADDR' }), []);
    }
    if (options.all) return callback(null, list);
    const first = list[0]!;
    return callback(null, first.address, first.family);
  });
}

function openAuthorizedAudio(urlText: string, redirectCount = 0): Promise<Readable> {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects while resolving audio stream.'));
  const url = parseApprovedUrl(urlText);
  return new Promise<Readable>((resolve, reject) => {
    let settled = false;
    let activeResponse: Readable | null = null;
    const fail = (error: Error): void => {
      if (settled) { activeResponse?.destroy(error); return; }
      settled = true;
      reject(error);
    };
    const request = https.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      timeout: 15_000,
      headers: {
        Accept: 'audio/*, application/ogg, application/octet-stream, video/ogg;q=0.9, */*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 discord-ai-music-bot/0.5'
      }
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        try {
          const nextUrl = new URL(response.headers.location, url).href;
          settled = true;
          return void openAuthorizedAudio(nextUrl, redirectCount + 1).then(resolve, reject);
        } catch (e) {
          return fail(new Error('Invalid redirect location received from audio stream.'));
        }
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        return fail(new Error(`The audio source returned HTTP ${status}.`));
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const isKnownAudioType = contentType.startsWith('audio/') ||
        contentType === 'application/octet-stream' ||
        contentType === 'application/ogg' ||
        contentType === 'video/ogg' ||
        contentType.includes('audio') ||
        /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba)(\?|$)/i.test(url.pathname);

      if (!isKnownAudioType && (contentType.startsWith('text/html') || contentType.startsWith('application/json'))) {
        response.destroy();
        return fail(new Error(`The URL returned ${contentType || 'an unknown content type'}, not a playable audio stream.`));
      }
      settled = true;
      activeResponse = response;
      resolve(response);
    });
    // Socket idle timeout: covers the connect/headers phase and also a stream that stalls mid-track.
    request.on('timeout', () => request.destroy(new Error('The audio source timed out.')));
    request.on('error', (error) => fail(error));
    request.end();
  });
}

export interface StartedAudio {
  resource: AudioResource<Track>;
  process: ChildProcessWithoutNullStreams;
}

const ffmpegBinary: string | null = (ffmpegPkg as unknown as { default?: string | null })?.default ?? (ffmpegPkg as unknown as string | null);

export async function createDirectAudioResource(track: Track): Promise<StartedAudio> {
  if (!ffmpegBinary) throw new Error('FFmpeg binary was not found. Reinstall dependencies or install FFmpeg on the host.');

  let input: Readable;
  if (isYouTubeUrl(track.url)) {
    const cleanUrl = cleanYouTubeVideoUrl(track.url);
    const streamYtdl = new Ytdl();
    input = streamYtdl.download(cleanUrl, {
      filter: (format) => Boolean(format.hasAudio && !format.hasVideo),
      highWaterMark: 1 << 25
    }) as unknown as Readable;
  } else {
    input = await openAuthorizedAudio(track.url);
  }

  const child = spawn(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ]) as ChildProcessWithoutNullStreams;

  let ffmpegError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { ffmpegError = (ffmpegError + chunk).slice(-2000); });
  input.on('error', (err) => {
    log('error', 'audio_input_stream_error', { url: track.url, message: (err as Error).message });
    child.kill('SIGKILL');
  });
  child.stdin.on('error', () => undefined);
  input.pipe(child.stdin);
  child.on('close', (code: number | null) => {
    input.destroy();
    if (code && code !== 0) log('warn', 'ffmpeg_exited_nonzero', { code, stderr: ffmpegError });
  });
  child.stdout.on('close', () => {
    if (!child.killed) child.kill('SIGKILL');
  });

  const resource = createAudioResource<Track>(child.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track
  });
  resource.volume?.setVolume(config.DEFAULT_VOLUME / 100);
  return { resource, process: child };
}

export function displayTitleFromUrl(urlText: string): string {
  try {
    const url = new URL(urlText);
    const filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? 'Audio stream');
    return filename.length > 3 ? filename.slice(0, 200) : `${url.hostname} audio`;
  } catch {
    return 'Audio stream';
  }
}
