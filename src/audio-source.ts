import dns, { type LookupAddress } from 'node:dns';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegPkg from 'ffmpeg-static';
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import { config } from './config.js';
import { log } from './logger.js';
import { isPrivateAddress } from './network-guard.js';

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
}

function parseApprovedUrl(urlText: string): URL {
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('That does not look like a valid URL.'); }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS audio links are accepted.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not accepted.');
  if (!config.audioAllowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`This host is not approved. Add ${url.hostname} to AUDIO_ALLOWED_HOSTS only after confirming you have streaming rights.`);
  }
  return url;
}

export function validateConfiguredAudioUrl(urlText: string): void {
  parseApprovedUrl(urlText);
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

function openAuthorizedAudio(urlText: string): Promise<Readable> {
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
      headers: { Accept: 'audio/*, application/octet-stream;q=0.9', 'User-Agent': 'discord-ai-music-bot/0.5' }
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        return fail(new Error('Redirecting audio URLs are not accepted. Use the final approved HTTPS stream URL.'));
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        return fail(new Error(`The audio source returned HTTP ${status}.`));
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!(contentType.startsWith('audio/') || contentType === 'application/octet-stream')) {
        response.destroy();
        return fail(new Error(`The URL returned ${contentType || 'an unknown content type'}, not an audio stream.`));
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
  const input = await openAuthorizedAudio(track.url);
  const child = spawn(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ]) as ChildProcessWithoutNullStreams;

  let ffmpegError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { ffmpegError = (ffmpegError + chunk).slice(-2000); });
  input.on('error', () => child.kill('SIGKILL'));
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
