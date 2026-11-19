import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection
} from '@discordjs/voice';
import type { Guild, GuildTextBasedChannel, VoiceBasedChannel } from 'discord.js';
import { config } from './config.js';
import { createDirectAudioResource, validateConfiguredAudioUrl, type Track } from './audio-source.js';
import { recordCataloguePlay } from './dj-service.js';
import { recordPersonalPlay } from './personal-music-service.js';
import { acquireGuildLease, clearUpcomingQueueSnapshot, loadUpcomingQueue, releaseGuildLease, renewGuildLease, saveUpcomingQueue } from './queue-store.js';
import { log } from './logger.js';

type RepeatMode = 'off' | 'track' | 'queue';

interface GuildPlayer {
  guildId: string;
  guildName: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: Track[];
  current: Track | null;
  repeatMode: RepeatMode;
  volume: number;
  textChannel: GuildTextBasedChannel | null;
  currentProcess: { kill: (signal?: NodeJS.Signals) => boolean; killed: boolean } | null;
  currentResource: import('@discordjs/voice').AudioResource<Track> | null;
  starting: boolean;
  skipRequested: boolean;
  stopRequested: boolean;
  leaseToken: string | null;
  leaseRenewal: NodeJS.Timeout | null;
  /** True once the saved Redis snapshot has been loaded; until then we must never overwrite it. */
  queueRestored: boolean;
  /** Bumped by stop/destroy so an in-flight startNext() can tell it has been cancelled. */
  epoch: number;
  summonedBy?: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
  autoPausedByEmptyVc?: boolean;
}

export interface PlayerSnapshot {
  guildId: string;
  guildName: string;
  current: Track | null;
  queue: Track[];
  repeatMode: RepeatMode;
  volume: number;
  paused: boolean;
  connected: boolean;
  playbackDurationMs?: number;
  summonedBy?: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
}

const sessions = new Map<string, GuildPlayer>();
const pendingSessions = new Map<string, Promise<GuildPlayer>>();

async function persistUpcomingQueue(state: GuildPlayer): Promise<void> {
  if (!state.queueRestored) return;
  try {
    await saveUpcomingQueue(state.guildId, state.queue);
  } catch (error) {
    log('error', 'queue_snapshot_write_failed', { guildId: state.guildId, error });
  }
}

function stopLeaseRenewal(state: GuildPlayer): void {
  if (state.leaseRenewal) clearInterval(state.leaseRenewal);
  state.leaseRenewal = null;
}

function releaseSessionLease(state: GuildPlayer): void {
  stopLeaseRenewal(state);
  const token = state.leaseToken;
  state.leaseToken = null;
  if (token) {
    void releaseGuildLease(state.guildId, token).catch((error) => {
      log('error', 'guild_voice_lease_release_failed', { guildId: state.guildId, error });
    });
  }
}

export type OnTrackStartHandler = (guildId: string, track: Track, textChannel: GuildTextBasedChannel | null) => void;
let onTrackStartHandler: OnTrackStartHandler | null = null;
export function setOnTrackStart(handler: OnTrackStartHandler): void {
  onTrackStartHandler = handler;
}

function killCurrentProcess(state: GuildPlayer): void {
  if (state.currentProcess && !state.currentProcess.killed) state.currentProcess.kill('SIGKILL');
  state.currentProcess = null;
}

async function startNext(state: GuildPlayer): Promise<void> {
  if (state.starting || state.current || state.stopRequested) return;
  const next = state.queue.shift();
  if (!next) return;
  // Claim the slot synchronously so a concurrent caller (Idle event vs /play) cannot start a second track.
  state.starting = true;
  const epoch = state.epoch;
  try {
    await persistUpcomingQueue(state);
    const started = await createDirectAudioResource(next);
    if (state.epoch !== epoch || sessions.get(state.guildId) !== state) {
      // Stopped or destroyed while the stream was opening: discard it instead of playing.
      if (!started.process.killed) started.process.kill('SIGKILL');
      return;
    }
    state.current = next;
    if (next.catalogueTrackId) void recordCataloguePlay(state.guildId, next.catalogueTrackId).catch((error) => {
      log('warn', 'catalogue_play_record_failed', { guildId: state.guildId, error });
    });
    void recordPersonalPlay(state.guildId, next.requestedBy, next).catch((error) => {
      log('warn', 'personal_play_record_failed', { guildId: state.guildId, error });
    });
    state.currentProcess = started.process;
    state.currentResource = started.resource;
    started.resource.volume?.setVolume(state.volume / 100);
    state.player.play(started.resource);
    if (onTrackStartHandler) {
      try {
        onTrackStartHandler(state.guildId, next, state.textChannel);
      } catch (handlerError) {
        log('warn', 'on_track_start_handler_failed', { guildId: state.guildId, error: handlerError });
      }
    }
  } catch (error) {
    state.current = null;
    state.currentResource = null;
    const message = error instanceof Error ? error.message : 'Unknown audio source error';
    log('warn', 'track_start_failed', { guildId: state.guildId, title: next.title, message });
    await state.textChannel?.send(`I couldn't play **${next.title}**: ${message}`).catch(() => undefined);
  } finally {
    state.starting = false;
  }
  if (!state.current && state.queue.length && state.epoch === epoch) void startNext(state);
}

function createSession(guild: Guild, voiceChannel: VoiceBasedChannel, textChannel: GuildTextBasedChannel, leaseToken: string, summonedBy?: string): GuildPlayer {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });
  connection.subscribe(player);
  const state: GuildPlayer = {
    guildId: guild.id,
    guildName: guild.name,
    connection,
    player,
    queue: [],
    current: null,
    repeatMode: 'off',
    volume: config.DEFAULT_VOLUME,
    textChannel,
    currentProcess: null,
    currentResource: null,
    starting: false,
    skipRequested: false,
    stopRequested: false,
    leaseToken,
    leaseRenewal: null,
    queueRestored: false,
    epoch: 0,
    summonedBy,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    autoPausedByEmptyVc: false
  };

  state.leaseRenewal = setInterval(() => {
    const token = state.leaseToken;
    if (!token) return;
    void renewGuildLease(guild.id, token).then((renewed) => {
      if (!renewed) {
        log('error', 'guild_voice_lease_lost', { guildId: guild.id });
        // Another worker owns the guild now: do not overwrite the queue snapshot it may be using.
        destroySession(guild.id, true, false);
      }
    }).catch((error) => {
      log('error', 'guild_voice_lease_renewal_failed', { guildId: guild.id, error });
      destroySession(guild.id, true);
    });
  }, 20_000);
  state.leaseRenewal.unref();

  player.on(AudioPlayerStatus.Idle, () => {
    const finished = state.current;
    killCurrentProcess(state);
    state.current = null;
    state.currentResource = null;
    if (state.stopRequested) return;
    if (finished && !state.skipRequested) {
      if (state.repeatMode === 'track') state.queue.unshift(finished);
      else if (state.repeatMode === 'queue') state.queue.push(finished);
    }
    state.skipRequested = false;
    void persistUpcomingQueue(state);
    void startNext(state);
  });

  player.on('error', async (error) => {
    log('error', 'audio_player_error', { guildId: guild.id, message: error.message });
    await state.textChannel?.send(`Playback error: ${error.message}`).catch(() => undefined);
    // Let the Idle event perform cleanup and advance the queue exactly once.
    if (state.current) {
      state.skipRequested = true;
      state.player.stop(true);
    }
  });

  connection.on('error', (error) => {
    log('error', 'voice_connection_error', { guildId: guild.id, message: error.message });
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      destroySession(guild.id, true);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    killCurrentProcess(state);
    releaseSessionLease(state);
    // Only remove our own entry; a newer session for this guild must not be dropped.
    if (sessions.get(guild.id) === state) sessions.delete(guild.id);
  });
  sessions.set(guild.id, state);
  return state;
}

async function openSession(guild: Guild, voiceChannel: VoiceBasedChannel, textChannel: GuildTextBasedChannel, summonedBy?: string): Promise<GuildPlayer> {
  const leaseToken = await acquireGuildLease(guild.id);
  if (!leaseToken) throw new Error('Another music worker currently owns this server voice session. Try again in a moment.');
  let state: GuildPlayer | undefined;
  try {
    state = createSession(guild, voiceChannel, textChannel, leaseToken, summonedBy);
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
    const recovered = await loadUpcomingQueue(guild.id);
    for (const queuedTrack of recovered) {
      try {
        validateConfiguredAudioUrl(queuedTrack.url);
        state.queue.push(queuedTrack);
      } catch (error) {
        log('warn', 'recovered_queue_track_rejected', { guildId: guild.id, title: queuedTrack.title, error });
      }
    }
    state.queueRestored = true;
    await persistUpcomingQueue(state);
    return state;
  } catch (error) {
    log('error', 'voice_session_open_failed', { guildId: guild.id, error });
    // queueRestored is still false on failure, so the existing snapshot is left untouched.
    if (state) destroySession(guild.id, true);
    else await releaseGuildLease(guild.id, leaseToken).catch((releaseError) => log('error', 'guild_voice_lease_release_failed', { guildId: guild.id, error: releaseError }));
    throw new Error('I could not connect to that voice channel or restore its queue. Check my Connect and Speak permissions and Redis availability.');
  }
}

/** One session per guild, even when several members run /play at the same moment. */
function getOrCreateSession(guild: Guild, voiceChannel: VoiceBasedChannel, textChannel: GuildTextBasedChannel, summonedBy?: string): Promise<GuildPlayer> {
  const pending = pendingSessions.get(guild.id);
  if (pending) return pending;
  const existing = sessions.get(guild.id);
  if (existing) {
    if (summonedBy) existing.summonedBy = summonedBy;
    existing.voiceChannelId = voiceChannel.id;
    existing.voiceChannelName = voiceChannel.name;
    return Promise.resolve(existing);
  }
  const creating = openSession(guild, voiceChannel, textChannel, summonedBy).finally(() => {
    if (pendingSessions.get(guild.id) === creating) pendingSessions.delete(guild.id);
  });
  pendingSessions.set(guild.id, creating);
  return creating;
}

export async function connectToVoice(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: GuildTextBasedChannel,
  summonedBy?: string
): Promise<GuildPlayer> {
  const state = await getOrCreateSession(guild, voiceChannel, textChannel, summonedBy);
  if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    throw new Error('I am already connected to another voice channel in this server.');
  }
  state.textChannel = textChannel;
  if (summonedBy) state.summonedBy = summonedBy;
  state.voiceChannelId = voiceChannel.id;
  state.voiceChannelName = voiceChannel.name;
  return state;
}

export async function enqueueTrack(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: GuildTextBasedChannel,
  track: Track
): Promise<{ position: number; started: boolean }> {
  validateConfiguredAudioUrl(track.url);
  const state = await getOrCreateSession(guild, voiceChannel, textChannel, track.requestedBy);
  if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    throw new Error('I am already playing in another voice channel in this server.');
  }
  state.textChannel = textChannel;
  if (!state.summonedBy) state.summonedBy = track.requestedBy;
  state.voiceChannelId = voiceChannel.id;
  state.voiceChannelName = voiceChannel.name;
  if (state.queue.length >= config.MAX_QUEUE_SIZE) throw new Error(`The queue is full (limit ${config.MAX_QUEUE_SIZE}).`);
  const wasIdle = !state.current && !state.starting;
  state.queue.push(track);
  const position = state.current || state.starting ? state.queue.length : state.queue.length - 1;
  await persistUpcomingQueue(state);
  if (wasIdle) {
    await startNext(state);
    if (!state.current && state.queue.length === 0) {
      throw new Error(`I could not start **${track.title}**. Check the audio URL and the bot's playback-channel message.`);
    }
  }
  return { position, started: wasIdle && state.current?.url === track.url };
}

export function hasSession(guildId: string): boolean {
  return sessions.has(guildId);
}

export function getSnapshot(guildId: string): PlayerSnapshot | null {
  const state = sessions.get(guildId);
  if (!state) return null;
  return {
    guildId: state.guildId,
    guildName: state.guildName,
    current: state.current,
    queue: [...state.queue],
    repeatMode: state.repeatMode,
    volume: state.volume,
    paused: state.player.state.status === AudioPlayerStatus.Paused,
    connected: state.connection.state.status === VoiceConnectionStatus.Ready,
    playbackDurationMs: state.currentResource?.playbackDuration ?? 0,
    summonedBy: state.summonedBy,
    voiceChannelId: state.voiceChannelId,
    voiceChannelName: state.voiceChannelName
  };
}

export function replayTrack(guildId: string): boolean {
  const state = sessions.get(guildId);
  if (!state || !state.current) return false;
  state.queue.unshift(state.current);
  state.skipRequested = true;
  state.player.stop(true);
  return true;
}

export function adjustVolume(guildId: string, delta: number): number | null {
  const state = sessions.get(guildId);
  if (!state) return null;
  const target = Math.max(0, Math.min(200, state.volume + delta));
  setVolume(guildId, target);
  return target;
}

export function cycleRepeatMode(guildId: string): RepeatMode | null {
  const state = sessions.get(guildId);
  if (!state) return null;
  const modes: RepeatMode[] = ['off', 'track', 'queue'];
  const next = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length] ?? 'off';
  setRepeatMode(guildId, next);
  return next;
}

export function shuffleQueue(guildId: string): boolean {
  const state = sessions.get(guildId);
  if (!state || state.queue.length <= 1) return false;
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const trackI = state.queue[i];
    const trackJ = state.queue[j];
    if (trackI && trackJ) {
      state.queue[i] = trackJ;
      state.queue[j] = trackI;
    }
  }
  void persistUpcomingQueue(state);
  return true;
}

export function pausePlayback(guildId: string): boolean {
  const state = sessions.get(guildId);
  return state ? state.player.pause() : false;
}

export function resumePlayback(guildId: string): boolean {
  const state = sessions.get(guildId);
  if (!state) return false;
  state.autoPausedByEmptyVc = false;
  return state.player.unpause();
}

export function isAutoPausedByEmptyVc(guildId: string): boolean {
  return Boolean(sessions.get(guildId)?.autoPausedByEmptyVc);
}

export function setAutoPausedByEmptyVc(guildId: string, value: boolean): void {
  const state = sessions.get(guildId);
  if (state) state.autoPausedByEmptyVc = value;
}

export function getSessionTextChannel(guildId: string): GuildTextBasedChannel | null {
  return sessions.get(guildId)?.textChannel ?? null;
}

export function skipPlayback(guildId: string): boolean {
  const state = sessions.get(guildId);
  if (!state?.current) return false;
  state.skipRequested = true;
  return state.player.stop(true);
}

export function stopPlayback(guildId: string): boolean {
  const state = sessions.get(guildId);
  if (!state) return false;
  state.autoPausedByEmptyVc = false;
  state.queue = [];
  void persistUpcomingQueue(state);
  state.repeatMode = 'off';
  state.epoch++;
  state.stopRequested = true;
  killCurrentProcess(state);
  state.current = null;
  state.currentResource = null;
  state.player.stop(true);
  state.stopRequested = false;
  return true;
}

export function clearUpcomingQueue(guildId: string): number | null {
  const state = sessions.get(guildId);
  if (!state) return null;
  const removed = state.queue.length;
  state.queue = [];
  void persistUpcomingQueue(state);
  return removed;
}

export function setVolume(guildId: string, volume: number): boolean {
  const state = sessions.get(guildId);
  if (!state) return false;
  state.volume = Math.max(0, Math.min(200, volume));
  state.currentResource?.volume?.setVolume(state.volume / 100);
  return true;
}

export function setRepeatMode(guildId: string, mode: RepeatMode): boolean {
  const state = sessions.get(guildId);
  if (!state) return false;
  state.repeatMode = mode;
  return true;
}

export function getRepeatModes(): RepeatMode[] {
  return ['off', 'track', 'queue'];
}

export function destroySession(guildId: string, preserveUpcomingQueue = false, writeSnapshot = true): void {
  const state = sessions.get(guildId);
  if (!state) return;
  state.autoPausedByEmptyVc = false;
  state.stopRequested = true;
  state.epoch++;
  if (!preserveUpcomingQueue) {
    state.queue = [];
    void clearUpcomingQueueSnapshot(guildId).catch((error) => log('error', 'queue_snapshot_clear_failed', { guildId, error }));
  } else if (writeSnapshot) {
    void persistUpcomingQueue(state);
  }
  state.current = null;
  state.currentResource = null;
  killCurrentProcess(state);
  state.player.stop(true);
  state.connection.destroy();
  releaseSessionLease(state);
  sessions.delete(guildId);
}

export async function shutdownPlayerSessions(): Promise<void> {
  const active = [...sessions.values()];
  await Promise.all(active.filter((state) => state.queueRestored).map((state) => saveUpcomingQueue(state.guildId, state.queue).catch((error) => {
    log('error', 'queue_snapshot_shutdown_save_failed', { guildId: state.guildId, error });
  })));
  for (const state of active) destroySession(state.guildId, true);
}

export function getSessionCount(): number {
  return sessions.size;
}
