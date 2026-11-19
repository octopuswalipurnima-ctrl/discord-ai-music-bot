import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
  type VoiceBasedChannel
} from 'discord.js';
import { config } from './config.js';
import { displayTitleFromUrl, resolveTrackMetadata, validateConfiguredAudioUrl, type Track } from './audio-source.js';
import {
  adjustVolume, clearUpcomingQueue, connectToVoice, cycleRepeatMode, destroySession, enqueueTrack,
  getSnapshot, pausePlayback, replayTrack, resumePlayback, setOnTrackStart, setRepeatMode,
  setVolume, shuffleQueue, skipPlayback, stopPlayback
} from './player.js';
import {
  addPlaylistTrack, createPlaylist, deletePlaylist, getPlaylistQuota, getPlaylistTracks, grantPlaylistEntitlement,
  listPlaylists, removePlaylistTrack, renamePlaylist, revokePlaylistEntitlement
} from './playlist-service.js';
import { getServerSettings, recordServerAudit, setModeratorRole } from './server-settings-service.js';
import { addCatalogueTrack, getAiShuffleTracks, getCatalogueTrack, getGuildDjStatus, removeCatalogueTrack, searchCatalogue, setGuildDjMode, MOOD_NAMES } from './dj-service.js';
import type { MoodName } from './dj-types.js';
import { enforceCommandRateLimit, consumeRateLimit } from './rate-limit.js';
import { incrementMetric } from './metrics.js';
import { log } from './logger.js';
import { saveDashboardAuthToken } from './queue-store.js';
import {
  forgetPersonalMusicData, getAssistantRecommendations, getPersonalHistory, getPersonalRecommendations,
  getPersonalTasteOverview, recordPersonalFeedback, setPersonalHistoryConsent
} from './personal-music-service.js';

async function assertGuildManager(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('This command can only be used inside a server.');
  if (guild.ownerId === interaction.user.id) return;
  const member = guild.members.cache.get(interaction.user.id) ?? await guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Only the server owner or a member with Manage Server/Administrator permission can change music settings.');
  }
}

async function assertModerator(interaction: ChatInputCommandInteraction | ButtonInteraction, guildId: string): Promise<void> {
  const guild = interaction.guild;
  if (!guild || guild.id !== guildId) throw new Error('This action must be used in the server that owns the music session.');
  if (guild.ownerId === interaction.user.id) return;
  const member = guild.members.cache.get(interaction.user.id) ?? await guild.members.fetch(interaction.user.id);
  if (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator)) return;
  const settings = await getServerSettings(guildId);
  if (!settings.moderatorRoleId) return;
  if (member.roles.cache.has(settings.moderatorRoleId)) return;
  throw new Error('This music control is reserved for server moderators. Ask the server owner to assign a music moderator role.');
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function getVoiceContext(interaction: ChatInputCommandInteraction | ButtonInteraction): {
  guild: Guild; voice: VoiceBasedChannel; text: GuildTextBasedChannel;
} {
  if (!interaction.guild) throw new Error('This command can only be used inside a server.');
  const voice = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channel ?? null;
  if (!voice) throw new Error('Join a voice channel first.');
  const state = getSnapshot(interaction.guild.id);
  if (state) {
    const botVoice = interaction.guild.members.me?.voice.channel;
    if (botVoice && botVoice.id !== voice.id) throw new Error(`Join <#${botVoice.id}> to control the current music session.`);
  }
  const text = interaction.channel;
  if (!text || !('send' in text)) throw new Error('I cannot send messages in this channel.');
  return { guild: interaction.guild, voice, text: text as GuildTextBasedChannel };
}

function makePanel(guildId: string, taggedUserId?: string): {
  content?: string;
  embeds: [EmbedBuilder];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const snapshot = getSnapshot(guildId);
  const current = snapshot?.current;
  const isPaused = Boolean(snapshot?.paused);
  const isPlaying = Boolean(current && !isPaused);
  const elapsedMs = snapshot?.playbackDurationMs ?? 0;

  let titleLine: string;
  if (current) {
    const elapsedStr = formatDuration(elapsedMs);
    const totalStr = current.durationSeconds ? formatDuration(current.durationSeconds * 1000) : '3:02';
    titleLine = `${current.title}${current.artist ? ` - ${current.artist}` : ''} (${elapsedStr} / ${totalStr})`;
  } else {
    titleLine = '🎧 Music Player — Ready in Voice';
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(titleLine)
    .setDescription(
      [
        '**Playback**',
        '⏮️ Previous · ⏯️ Play/Pause · ⏭️ Skip · ✖️ Stop\n',
        '**Music**',
        '📑 Queue · 🎵 Now Playing · ➕ Add Track · 🔍 Search\n🎶 Mood & Discover\n',
        '**Controls**',
        '🤍 Like · 🔉 Vol - · 🔊 Vol + (up to 200%) · 🪄 AI Mix\n',
        '**Library**',
        '❤️ Liked Songs · 🕒 History · 📑 Playlists · 🌐 Dashboard'
      ].join('\n')
    )
    .addFields(
      { name: 'Status', value: isPaused ? '⏸️ Paused' : isPlaying ? '▶️ Playing' : '⏹️ Idle', inline: true },
      { name: 'Volume', value: `🔊 ${snapshot?.volume ?? 70}%`, inline: true },
      { name: 'Queue', value: `📑 ${snapshot?.queue.length ?? 0} tracks`, inline: true },
      { name: 'Repeat', value: `🔁 ${snapshot?.repeatMode ?? 'off'}`, inline: true }
    );

  const summoner = taggedUserId || snapshot?.summonedBy;
  if (summoner) {
    embed.setFooter({ text: `Summoned by user <@${summoner}> • All participants can use personal & queue controls` });
  } else {
    embed.setFooter({ text: 'All voice participants can use personal & queue controls' });
  }

  // Row 1: Playback
  const rowPlayback = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`music:prev:${guildId}`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:play_pause:${guildId}`).setEmoji(isPaused ? '▶️' : '⏸️').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`music:skip:${guildId}`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:stop:${guildId}`).setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );

  // Row 2: Music (Line 1)
  const rowMusic = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`music:queue:${guildId}`).setEmoji('📑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:nowplaying:${guildId}`).setEmoji('🎵').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:add:${guildId}`).setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:search:${guildId}`).setEmoji('🔍').setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Music (Line 2 - Mood & AI)
  const rowMusicCont = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`music:mood:${guildId}`).setEmoji('🎶').setStyle(ButtonStyle.Secondary)
  );

  // Row 4: Controls
  const rowControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`music:like:${guildId}`).setEmoji('🤍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:vol_down:${guildId}`).setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:vol_up:${guildId}`).setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:ai_mix:${guildId}`).setEmoji('🪄').setStyle(ButtonStyle.Secondary)
  );

  // Row 5: Library
  const rowLibrary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`music:library_favs:${guildId}`).setEmoji('❤️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:library_history:${guildId}`).setEmoji('🕒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:library_playlists:${guildId}`).setEmoji('📑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:dashboard_link:${guildId}`).setEmoji('🌐').setStyle(ButtonStyle.Secondary)
  );

  const result: {
    content?: string;
    embeds: [EmbedBuilder];
    components: ActionRowBuilder<ButtonBuilder>[];
  } = {
    embeds: [embed],
    components: [rowPlayback, rowMusic, rowMusicCont, rowControls, rowLibrary]
  };

  if (taggedUserId) {
    result.content = `🎧 Joined voice channel! Summoned by <@${taggedUserId}>`;
  }

  return result;
}

async function replyError(interaction: ChatInputCommandInteraction | ButtonInteraction, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const payload = { content: `⚠️ ${message}`, ephemeral: true };
  if (interaction.deferred) await interaction.editReply({ content: `⚠️ ${message}` }).catch(() => undefined);
  else if (interaction.replied) await interaction.followUp(payload).catch(() => undefined);
  else await interaction.reply(payload).catch(() => undefined);
}

async function executePlaylist(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) throw new Error('Playlists are server-specific. Use this command inside a server.');
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  switch (subcommand) {
    case 'create': {
      const limit = await createPlaylist(guildId, userId, interaction.options.getString('name', true));
      const quota = await getPlaylistQuota(guildId, userId);
      await interaction.reply({ content: `Your playlist has been created. You have **${quota.count}/${limit}** playlists available in this server.`, ephemeral: true });
      break;
    }
    case 'list': {
      const [playlists, quota] = await Promise.all([listPlaylists(guildId, userId), getPlaylistQuota(guildId, userId)]);
      const text = playlists.length
        ? playlists.map((p, i) => `**${i + 1}. ${p.name}** — ${p.trackCount} tracks`).join('\n')
        : 'You have not created any playlists yet. Use `/playlist create`.';
      await interaction.reply({ content: `**Your playlists: ${quota.count}/${quota.limit}**${quota.specialMember ? ' · Special member' : ''}\n${text}`, ephemeral: true });
      break;
    }
    case 'add': {
      const url = interaction.options.getString('url', true);
      validateConfiguredAudioUrl(url);
      const title = interaction.options.getString('title') || displayTitleFromUrl(url);
      await addPlaylistTrack(guildId, userId, interaction.options.getString('playlist', true), {
        title, url, requestedBy: userId
      });
      await interaction.reply({ content: `Added **${title}** to your playlist.`, ephemeral: true });
      break;
    }
    case 'remove': {
      const title = await removePlaylistTrack(guildId, userId, interaction.options.getString('playlist', true), interaction.options.getInteger('position', true));
      await interaction.reply({ content: `Removed **${title}** from your playlist.`, ephemeral: true });
      break;
    }
    case 'view': {
      const tracks = await getPlaylistTracks(guildId, userId, interaction.options.getString('name', true));
      const lines = tracks.slice(0, 20).map((track, i) => `**${i + 1}.** ${track.title}`);
      await interaction.reply({ content: tracks.length ? `${lines.join('\n')}${tracks.length > 20 ? `\n…and ${tracks.length - 20} more.` : ''}` : 'This playlist is empty.', ephemeral: true });
      break;
    }
    case 'play': {
      const tracks = await getPlaylistTracks(guildId, userId, interaction.options.getString('name', true));
      if (!tracks.length) throw new Error('This playlist is empty.');
      const { guild, voice, text } = getVoiceContext(interaction);
      await interaction.deferReply({ ephemeral: true });
      let added = 0;
      for (const track of tracks) {
        try {
          await enqueueTrack(guild, voice, text, { ...track, requestedBy: userId });
          added++;
        } catch (error) {
          if (!added) throw error;
          break;
        }
      }
      await interaction.editReply(`Added ${added} of ${tracks.length} playlist tracks to the server queue.`);
      break;
    }
    case 'delete': {
      const name = interaction.options.getString('name', true);
      await deletePlaylist(guildId, userId, name);
      await interaction.reply({ content: `Deleted **${name}**.`, ephemeral: true });
      break;
    }
    case 'rename': {
      const oldName = interaction.options.getString('name', true);
      const newName = interaction.options.getString('new_name', true);
      await renamePlaylist(guildId, userId, oldName, newName);
      await interaction.reply({ content: `Renamed **${oldName}** to **${newName}**.`, ephemeral: true });
      break;
    }
    case 'grant': {
      if (interaction.guild.ownerId !== userId) throw new Error('Only the server owner can grant special-member playlist access.');
      const target = interaction.options.getUser('member', true);
      if (target.bot) throw new Error('Bots cannot receive personal playlist entitlements.');
      await interaction.guild.members.fetch(target.id).catch(() => { throw new Error('That member is not in this server.'); });
      await grantPlaylistEntitlement(guildId, target.id, userId);
      await recordServerAudit(guildId, userId, 'playlist_limit_granted', target.id, { maxPlaylists: 3 });
      await interaction.reply({ content: `Granted <@${target.id}> the special-member allowance of **3 playlists** in this server.`, ephemeral: true });
      break;
    }
    case 'revoke': {
      if (interaction.guild.ownerId !== userId) throw new Error('Only the server owner can revoke special-member playlist access.');
      const target = interaction.options.getUser('member', true);
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!targetMember || target.bot) throw new Error('That member is not an eligible member of this server.');
      const revoked = await revokePlaylistEntitlement(guildId, target.id);
      if (!revoked) throw new Error('That member does not have a special playlist allowance.');
      await recordServerAudit(guildId, userId, 'playlist_limit_revoked', target.id, { maxPlaylists: 2 });
      const quota = await getPlaylistQuota(guildId, target.id);
      const note = quota.count >= 2 ? ` They currently have ${quota.count} playlists; existing playlists were preserved. To create another, they must delete enough to have fewer than two saved playlists.` : '';
      await interaction.reply({ content: `Returned <@${target.id}> to the regular **2-playlist** limit.${note}`, ephemeral: true });
      break;
    }
  }
}

async function executeMusicAdmin(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('This command can only be used inside a server.');
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'set-mod-role') {
    await assertGuildManager(interaction);
    const role = interaction.options.getRole('role', true);
    if (role.id === guild.id || role.managed) throw new Error('Choose a normal server role, not @everyone or an integration-managed role.');
    await setModeratorRole(guild.id, role.id, interaction.user.id);
    await interaction.reply({ content: `Music moderator access is now granted to <@&${role.id}>. Server owners and administrators retain access.`, ephemeral: true });
    return;
  }

  if (subcommand === 'clear-mod-role') {
    await assertGuildManager(interaction);
    await setModeratorRole(guild.id, null, interaction.user.id);
    await interaction.reply({ content: 'The custom music moderator role has been removed. Only the server owner and members with Manage Server/Administrator can use moderator controls.', ephemeral: true });
    return;
  }

  if (subcommand === 'settings') {
    await assertGuildManager(interaction);
    const settings = await getServerSettings(guild.id);
    await interaction.reply({
      content: [
        '**Music settings**',
        `Moderator role: ${settings.moderatorRoleId ? `<@&${settings.moderatorRoleId}>` : 'Not configured (admins only)'}`,
        'Special playlist grants: server owner only; 3 playlists instead of 2.',
        'When a grant is revoked, saved playlists are preserved and further creation is blocked until the member is back under the regular cap.'
      ].join('\n'),
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'clear-queue') {
    await assertModerator(interaction, guild.id);
    const removed = clearUpcomingQueue(guild.id);
    if (removed === null) throw new Error('There is no active music session.');
    await interaction.reply({ content: `Removed **${removed}** upcoming ${removed === 1 ? 'track' : 'tracks'}. The current track was left playing.`, ephemeral: true });
    return;
  }
}


function parseCsv(value: string | null): string[] {
  return value ? [...new Set(value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean))].slice(0, 12) : [];
}

async function executeMood(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('AI DJ mood settings are server-specific. Use this command inside a server.');
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'status') {
    const status = await getGuildDjStatus(guild.id);
    const mode = status.mode === 'off' ? 'Off' : status.mode === 'auto' ? `Auto (currently leaning ${status.effectiveMood})` : status.mode;
    await interaction.reply({ content: `**AI DJ status**\nMode: **${mode}**\nServer catalogue: **${status.catalogueCount}** tracks\nUse \`/ai-shuffle\` to generate a mood-matched queue.`, ephemeral: true });
    return;
  }
  await assertModerator(interaction, guild.id);
  if (subcommand === 'set') {
    const mood = interaction.options.getString('mood', true) as MoodName;
    if (!MOOD_NAMES.includes(mood)) throw new Error('That mood is not supported.');
    await setGuildDjMode(guild.id, mood, interaction.user.id);
    await interaction.reply({ content: `AI DJ mood set to **${mood}**. Use \`/ai-shuffle\` to fill the queue.`, ephemeral: true });
  } else if (subcommand === 'auto') {
    await setGuildDjMode(guild.id, 'auto', interaction.user.id);
    const status = await getGuildDjStatus(guild.id);
    await interaction.reply({ content: `AI Auto mood is on. Based on recent catalogue playback, the starting mood is **${status.effectiveMood}**. The bot analyses track metadata, not voice conversations.`, ephemeral: true });
  } else if (subcommand === 'off') {
    await setGuildDjMode(guild.id, 'off', interaction.user.id);
    await interaction.reply({ content: 'AI mood selection is off. `/ai-shuffle` will use a balanced discovery mix.', ephemeral: true });
  }
}

async function executeCatalogue(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('The music catalogue is server-specific. Use this command inside a server.');
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'add') {
    await assertModerator(interaction, guild.id);
    const energyValue = interaction.options.getInteger('energy');
    const id = await addCatalogueTrack(guild.id, interaction.user.id, {
      url: interaction.options.getString('url', true),
      title: interaction.options.getString('title', true),
      artist: interaction.options.getString('artist'),
      genreTags: parseCsv(interaction.options.getString('genres')),
      moodTags: parseCsv(interaction.options.getString('moods')),
      language: interaction.options.getString('language'),
      bpm: interaction.options.getInteger('bpm'),
      energy: energyValue === null ? null : energyValue / 100
    });
    await interaction.reply({ content: `Added or updated **${interaction.options.getString('title', true)}** in the server catalogue. Track ID: **${id}**.`, ephemeral: true });
    return;
  }
  if (subcommand === 'search') {
    const query = interaction.options.getString('query', true);
    const tracks = await searchCatalogue(guild.id, query, 10);
    if (!tracks.length) {
      await interaction.reply({ content: 'No catalogue matches. Ask a moderator to add approved tracks with `/catalog add`.', ephemeral: true });
      return;
    }
    const lines = tracks.map((track) => `**#${track.id}** · ${track.title}${track.artist ? ` — ${track.artist}` : ''}\n${track.genreTags.slice(0, 3).join(', ') || 'Genre not set'} · ${track.bpm ? `${track.bpm} BPM` : 'BPM unknown'} · ${track.moodTags.join(', ') || 'No mood tags'}`);
    await interaction.reply({ content: `**Catalogue results for “${query}”**\n${lines.join('\n\n')}\n\nPlay a result with \`/play catalogue_id:<ID>\`.`, ephemeral: true });
    return;
  }
  if (subcommand === 'remove') {
    await assertModerator(interaction, guild.id);
    const id = interaction.options.getInteger('track_id', true);
    if (!await removeCatalogueTrack(guild.id, id)) throw new Error('That catalogue track was not found or is already inactive.');
    await interaction.reply({ content: `Catalogue track **#${id}** has been deactivated. Existing queued copies are not changed.`, ephemeral: true });
  }
}

async function executeAiShuffle(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guild, voice, text } = getVoiceContext(interaction);
  const count = interaction.options.getInteger('count') ?? 5;
  await interaction.deferReply({ ephemeral: true });
  const result = await getAiShuffleTracks(guild.id, count, interaction.user.id);
  let added = 0;
  let firstStarted = false;
  for (const track of result.tracks) {
    try {
      const queued = await enqueueTrack(guild, voice, text, track);
      added++;
      if (queued.started) firstStarted = true;
    } catch (error) {
      if (!added) throw error;
      break;
    }
  }
  if (!added) throw new Error('No tracks could be added. Check the approved audio streams in the catalogue.');
  await interaction.editReply(`AI DJ selected **${added}** tracks for **${result.mood}** mode. It balanced mood tags, genre, tempo, energy and recent-play variety.`);
  if (firstStarted) await text.send({ ...makePanel(guild.id) }).catch(() => undefined);
}

async function executeTaste(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('Personal taste profiles are scoped to a Discord server. Use this command inside a server.');
  const subcommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (subcommand === 'opt-in') {
    await setPersonalHistoryConsent(guild.id, userId, true);
    await interaction.reply({
      content: 'Personal music history is now **on for this server**. I will record tracks you request when they start playing, plus feedback you submit. Other voice-channel listeners are not tracked. Use `/taste opt-out` to stop future collection or `/taste forget` to delete saved data.',
      ephemeral: true
    });
    return;
  }
  if (subcommand === 'opt-out') {
    await setPersonalHistoryConsent(guild.id, userId, false);
    await interaction.reply({ content: 'Personal music history is **off**. Existing history is retained until you use `/taste forget`.', ephemeral: true });
    return;
  }
  if (subcommand === 'forget') {
    await forgetPersonalMusicData(guild.id, userId);
    await interaction.reply({ content: 'Your personal music history and taste events for this server have been deleted. History tracking is now off.', ephemeral: true });
    return;
  }
  if (subcommand === 'feedback') {
    const sentiment = interaction.options.getString('sentiment', true) as 'like' | 'dislike';
    const snapshot = getSnapshot(guild.id);
    if (!snapshot?.current) throw new Error('There is no currently playing track to rate.');
    await recordPersonalFeedback(guild.id, userId, snapshot.current, sentiment);
    await interaction.reply({ content: `Saved your **${sentiment}** for **${snapshot.current.title}**. Your recommendations will take this into account.`, ephemeral: true });
    return;
  }
  if (subcommand === 'profile') {
    const overview = await getPersonalTasteOverview(guild.id, userId);
    const lines = [
      `**History collection:** ${overview.historyEnabled ? 'On' : 'Off'}`,
      `**Plays recorded:** ${overview.totalPlays}`,
      `**Likes / dislikes:** ${overview.likes} / ${overview.dislikes}`,
      `**Favourite genres:** ${overview.topGenres.join(', ') || 'Not enough feedback yet'}`,
      `**Favourite artists:** ${overview.topArtists.join(', ') || 'Not enough feedback yet'}`,
      `**Common moods:** ${overview.topMoods.join(', ') || 'Not enough feedback yet'}`
    ];
    await interaction.reply({ content: `**Your private music taste profile**\n${lines.join('\n')}\n\nThis profile is visible only to you.`, ephemeral: true });
    return;
  }
  if (subcommand === 'history') {
    const history = await getPersonalHistory(guild.id, userId, 10);
    const lines = history.map((item, index) => `**${index + 1}.** ${item.title}${item.artist ? ` — ${item.artist}` : ''} · <t:${Math.floor(new Date(item.playedAt).getTime() / 1000)}:R>`);
    await interaction.reply({ content: history.length ? `**Your recent requested tracks**\n${lines.join('\n')}` : 'No personal plays have been recorded yet.', ephemeral: true });
  }
}

async function executeForMe(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('Use `/for-me` inside a server.');
  await interaction.deferReply({ ephemeral: true });
  const count = interaction.options.getInteger('count') ?? 5;
  const result = await getPersonalRecommendations(guild.id, interaction.user.id, count);
  const list = result.tracks.map((track, index) => `${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}`).join('\n');
  const { voice, text } = getVoiceContext(interaction);
  let added = 0;
  let firstStarted = false;
  for (const track of result.tracks) {
    try {
      const queued = await enqueueTrack(guild, voice, text, track);
      added++;
      if (queued.started) firstStarted = true;
    } catch (error) {
      if (!added) throw error;
      break;
    }
  }
  await interaction.editReply(`**Picked for your taste**\n${list}\n\nAdded **${added}** tracks. Based on your opt-in history and feedback.`);
  if (firstStarted) await text.send({ ...makePanel(guild.id) }).catch(() => undefined);
}

async function executeAskMusic(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('Use `/ask-music` inside a server.');
  await interaction.deferReply({ ephemeral: true });
  const request = interaction.options.getString('request', true);
  const count = interaction.options.getInteger('count') ?? 5;
  const result = await getAssistantRecommendations(guild.id, interaction.user.id, request, count);
  const parts: string[] = [];
  if (result.intent.mood) parts.push(`mood: ${result.intent.mood}`);
  if (result.intent.genres.length) parts.push(`genres: ${result.intent.genres.join(', ')}`);
  if (result.intent.language) parts.push(`language: ${result.intent.language}`);
  const interpretation = parts.length ? parts.join(' · ') : 'balanced catalogue discovery';
  const { voice, text } = getVoiceContext(interaction);
  let added = 0;
  let firstStarted = false;
  for (const track of result.tracks) {
    try {
      const queued = await enqueueTrack(guild, voice, text, track);
      added++;
      if (queued.started) firstStarted = true;
    } catch (error) {
      if (!added) throw error;
      break;
    }
  }
  const personal = result.personalised ? ' Your private taste profile was also used.' : ' Turn on `/taste opt-in` to personalise future requests.';
  await interaction.editReply(`**Music assistant**\nI understood: ${interpretation}.${personal}\nQueued **${added}** tracks from this server's approved catalogue.`);
  if (firstStarted) await text.send({ ...makePanel(guild.id) }).catch(() => undefined);
}

async function executeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await enforceCommandRateLimit(interaction.guildId ?? 'dm', interaction.user.id, interaction.commandName);
  incrementMetric('discord_commands_total', { command: interaction.commandName });
  if (interaction.commandName === 'dashboard') {
    const guild = interaction.guild;
    if (!guild) throw new Error('Use this command inside a server.');
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) throw new Error('Could not fetch your server member profile.');

    const settings = await getServerSettings(guild.id);
    const isOwner = guild.ownerId === interaction.user.id;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
    const isMod = Boolean(settings.moderatorRoleId && member.roles.cache.has(settings.moderatorRoleId));

    let role = 'member';
    let roleTitle = 'Member';
    let roleDesc = 'Personal Playlists, Personal AI Taste Profile & Queue Viewing';
    if (isOwner) {
      role = 'owner';
      roleTitle = 'Server Owner';
      roleDesc = 'Full Server Control, Playlist Quota Management, Music Controls & Settings';
    } else if (isAdmin) {
      role = 'admin';
      roleTitle = 'Administrator';
      roleDesc = 'Music Controls, AI DJ Mood, Catalogue & Settings';
    } else if (isMod) {
      role = 'moderator';
      roleTitle = 'Music Moderator';
      roleDesc = 'Music Playback Controls, AI DJ Mood & Catalogue';
    }

    const authToken = randomBytes(24).toString('hex');
    await saveDashboardAuthToken(authToken, {
      userId: interaction.user.id,
      username: interaction.user.username,
      avatar: interaction.user.displayAvatarURL(),
      guildId: guild.id,
      guildName: guild.name,
      role,
      title: roleTitle
    });

    const dashUrl = `${config.DASHBOARD_URL}/auth/token?token=${authToken}`;

    const embed = new EmbedBuilder()
      .setColor(role === 'owner' ? 0xf59e0b : role === 'admin' ? 0xec4899 : role === 'moderator' ? 0x3b82f6 : 0x10b981)
      .setTitle(`🎵 ${guild.name} — Web Music Dashboard`)
      .setDescription(
        `Here is your private, direct access link to the web music dashboard:\n\n` +
        `**Your Role:** \`${roleTitle}\`\n` +
        `**Capabilities:** ${roleDesc}\n\n` +
        `🔗 **[Click here to Open Dashboard](${dashUrl})**\n\n` +
        `*This link records your role in this server so the dashboard shows only what you can modify and use. It expires in 15 minutes.*`
      )
      .setFooter({ text: 'Discord AI Music Bot • Role-Synced Dashboard' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('Open Web Dashboard')
        .setStyle(ButtonStyle.Link)
        .setURL(dashUrl)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'join') {
    const { guild, voice, text } = getVoiceContext(interaction);
    await interaction.deferReply({ ephemeral: true });
    await connectToVoice(guild, voice, text, interaction.user.id);
    const panel = makePanel(guild.id, interaction.user.id);
    await text.send(panel).catch(() => undefined);
    await interaction.editReply({
      content: `🎧 Joined **${voice.name}** and opened the music controller. Summoned by <@${interaction.user.id}>.`,
      embeds: panel.embeds,
      components: panel.components
    });
    return;
  }
  if (interaction.commandName === 'controls') {
    return void await interaction.reply({ ...makePanel(interaction.guild!.id, interaction.user.id), ephemeral: true });
  }

  if (interaction.commandName === 'playlist') return executePlaylist(interaction);
  if (interaction.commandName === 'music-admin') return executeMusicAdmin(interaction);
  if (interaction.commandName === 'mood') return executeMood(interaction);
  if (interaction.commandName === 'catalog') return executeCatalogue(interaction);
  if (interaction.commandName === 'ai-shuffle') return executeAiShuffle(interaction);
  if (interaction.commandName === 'taste') return executeTaste(interaction);
  if (interaction.commandName === 'for-me') return executeForMe(interaction);
  if (interaction.commandName === 'ask-music') return executeAskMusic(interaction);
  if (interaction.commandName === 'play') {
    const { guild, voice, text } = getVoiceContext(interaction);
    const url = interaction.options.getString('url');
    const catalogueId = interaction.options.getInteger('catalogue_id');
    if (Boolean(url) === (catalogueId !== null)) throw new Error('Provide exactly one of `url` or `catalogue_id`.');
    await interaction.deferReply({ ephemeral: true });
    let track: Track;
    if (catalogueId !== null) {
      const catalogTrack = await getCatalogueTrack(guild.id, catalogueId);
      if (!catalogTrack) throw new Error('That track ID is not active in this server catalogue. Use `/catalog search`.');
      track = { ...catalogTrack, requestedBy: interaction.user.id };
    } else {
      const rawUrl = url!;
      const customTitle = interaction.options.getString('title') ?? undefined;
      track = await resolveTrackMetadata(rawUrl, interaction.user.id, customTitle);
    }
    const result = await enqueueTrack(guild, voice, text, track);
    const panel = makePanel(guild.id, interaction.user.id);
    await interaction.editReply({
      content: result.started ? `Now playing **${track.title}**.` : `Added **${track.title}** to the queue at position ${result.position}.`,
      embeds: panel.embeds,
      components: panel.components
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) throw new Error('This command can only be used inside a server.');
  const snapshot = getSnapshot(guild.id);
  if (interaction.commandName === 'queue') {
    if (!snapshot) return void await interaction.reply({ content: 'There is no active music session.', ephemeral: true });
    const upcoming = snapshot.queue.slice(0, 15).map((track, i) => `**${i + 1}.** ${track.title}`).join('\n') || 'No upcoming tracks.';
    return void await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('Music Queue').setDescription(`**Now:** ${snapshot.current?.title ?? 'Nothing'}\n\n${upcoming}`)] });
  }
  if (interaction.commandName === 'nowplaying') {
    return void await interaction.reply({ ...makePanel(guild.id, interaction.user.id) });
  }

  getVoiceContext(interaction);
  await assertModerator(interaction, guild.id);
  switch (interaction.commandName) {
    case 'pause': {
      if (!pausePlayback(guild.id)) throw new Error('Nothing is playing or playback is already paused.');
      await interaction.reply({ content: 'Playback paused.', ephemeral: true }); break;
    }
    case 'resume': {
      if (!resumePlayback(guild.id)) throw new Error('Playback is not paused.');
      await interaction.reply({ content: 'Playback resumed.', ephemeral: true }); break;
    }
    case 'skip': {
      if (!skipPlayback(guild.id)) throw new Error('There is no current track to skip.');
      await interaction.reply({ content: 'Skipped the current track.', ephemeral: true }); break;
    }
    case 'stop': {
      if (!stopPlayback(guild.id)) throw new Error('There is no active music session.');
      await interaction.reply({ content: 'Stopped playback and cleared the queue.', ephemeral: true }); break;
    }
    case 'leave': {
      destroySession(guild.id);
      await interaction.reply({ content: 'Disconnected from the voice channel.', ephemeral: true }); break;
    }
    case 'volume': {
      const value = interaction.options.getInteger('percent', true);
      if (!setVolume(guild.id, value)) throw new Error('There is no active music session.');
      await interaction.reply({ content: `Volume set to ${value}%.`, ephemeral: true }); break;
    }
    case 'repeat': {
      const mode = interaction.options.getString('mode', true) as 'off' | 'track' | 'queue';
      if (!setRepeatMode(guild.id, mode)) throw new Error('There is no active music session.');
      await interaction.reply({ content: `Repeat mode set to **${mode}**.`, ephemeral: true }); break;
    }
    default: throw new Error('Unknown command.');
  }
}

async function executeButton(interaction: ButtonInteraction): Promise<void> {
  const buttonLimit = await consumeRateLimit('music-button', [interaction.guildId ?? 'dm', interaction.user.id], 15, 10_000);
  if (!buttonLimit.allowed) {
    incrementMetric('rate_limit_rejections_total', { surface: 'music-button' });
    throw new Error('Please slow down before pressing music controls again.');
  }
  const [, action, guildId] = interaction.customId.split(':');
  if (!guildId || guildId !== interaction.guildId) throw new Error('This control belongs to another server.');

  const snapshot = getSnapshot(guildId);

  // Read-only / Personal Actions (available to all server members)
  if (action === 'queue') {
    if (!snapshot) return void await interaction.reply({ content: 'There is no active music session.', ephemeral: true });
    const upcoming = snapshot.queue.slice(0, 15).map((track, i) => `**${i + 1}.** ${track.title}`).join('\n') || 'Queue is currently empty.';
    return void await interaction.reply({
      content: `**Current Queue (${snapshot.queue.length} tracks)**\n**Now Playing:** ${snapshot.current?.title ?? 'Nothing'}\n\n${upcoming}`,
      ephemeral: true
    });
  }

  if (action === 'nowplaying') {
    if (!snapshot?.current) return void await interaction.reply({ content: 'Nothing is currently playing.', ephemeral: true });
    const current = snapshot.current;
    const elapsed = formatDuration(snapshot.playbackDurationMs ?? 0);
    const total = current.durationSeconds ? formatDuration(current.durationSeconds * 1000) : '3:02';
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`🎵 ${current.title}`)
      .setDescription(current.artist ? `by **${current.artist}**` : 'Artist unknown')
      .addFields(
        { name: 'Progress', value: `⏱️ ${elapsed} / ${total}`, inline: true },
        { name: 'Requested by', value: `<@${current.requestedBy}>`, inline: true },
        { name: 'BPM', value: current.bpm ? String(current.bpm) : 'Unknown', inline: true },
        { name: 'Energy', value: current.energy !== undefined ? `${current.energy}%` : 'Unknown', inline: true },
        { name: 'Mood Tags', value: current.moodTags?.join(', ') || 'None', inline: true },
        { name: 'Genres', value: current.genreTags?.join(', ') || 'None', inline: true }
      );
    return void await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (action === 'like') {
    if (!snapshot?.current) return void await interaction.reply({ content: 'Nothing is currently playing to like.', ephemeral: true });
    await recordPersonalFeedback(guildId, interaction.user.id, snapshot.current, 'like');
    return void await interaction.reply({
      content: `❤️ Saved **${snapshot.current.title}** to your favorites and personal taste profile!`,
      ephemeral: true
    });
  }

  if (action === 'library_favs') {
    const overview = await getPersonalTasteOverview(guildId, interaction.user.id);
    const lines = [
      `**Favorite genres:** ${overview.topGenres.join(', ') || 'No feedback recorded yet'}`,
      `**Favorite artists:** ${overview.topArtists.join(', ') || 'No feedback recorded yet'}`,
      `**Common moods:** ${overview.topMoods.join(', ') || 'No feedback recorded yet'}`
    ];
    return void await interaction.reply({
      content: `**Your Music Profile & Favorites**\n${lines.join('\n')}\n\nVisible only to you.`,
      ephemeral: true
    });
  }

  if (action === 'library_history') {
    const history = await getPersonalHistory(guildId, interaction.user.id);
    const lines = history.slice(0, 10).map((h, i) => `**${i + 1}.** ${h.title}${h.artist ? ` — ${h.artist}` : ''} (${h.playedAt})`);
    return void await interaction.reply({
      content: history.length ? `**Your Recent Listening History**\n${lines.join('\n')}` : 'No personal play history recorded yet.',
      ephemeral: true
    });
  }

  if (action === 'library_playlists') {
    const [playlists, quota] = await Promise.all([listPlaylists(guildId, interaction.user.id), getPlaylistQuota(guildId, interaction.user.id)]);
    const text = playlists.length
      ? playlists.map((p, i) => `**${i + 1}. ${p.name}** — ${p.trackCount} tracks`).join('\n')
      : 'You have not created any playlists yet. Use `/playlist create <name>`.';
    return void await interaction.reply({
      content: `**Your Playlists (${quota.count}/${quota.limit})**\n${text}\n\nUse \`/playlist play <name>\` to play a playlist in voice!`,
      ephemeral: true
    });
  }

  if (action === 'dashboard_link') {
    const member = interaction.guild?.members.cache.get(interaction.user.id) ?? await interaction.guild?.members.fetch(interaction.user.id);
    const settings = await getServerSettings(guildId);
    let role = 'member';
    if (interaction.guild?.ownerId === interaction.user.id) role = 'owner';
    else if (member?.permissions.has(PermissionFlagsBits.Administrator) || member?.permissions.has(PermissionFlagsBits.ManageGuild)) role = 'owner';
    else if (settings.moderatorRoleId && member?.roles.cache.has(settings.moderatorRoleId)) role = 'moderator';

    const token = randomBytes(24).toString('hex');
    await saveDashboardAuthToken(token, {
      userId: interaction.user.id,
      guildId,
      role,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    const dashUrl = `${config.DASHBOARD_URL}/auth/token?token=${token}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('Open Web Studio').setStyle(ButtonStyle.Link).setURL(dashUrl)
    );
    return void await interaction.reply({
      content: `Here is your direct access link to the Web Studio with your **${role.toUpperCase()}** role. Valid for 15 minutes:`,
      components: [row],
      ephemeral: true
    });
  }

  if (action === 'add') {
    const modal = new ModalBuilder()
      .setCustomId(`music_modal_add:${guildId}`)
      .setTitle('Add Song to Queue');
    const input = new TextInputBuilder()
      .setCustomId('url_or_title')
      .setLabel('Audio URL or Title')
      .setPlaceholder('https://example.com/song.mp3 or Title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return void await interaction.showModal(modal);
  }

  if (action === 'search') {
    const modal = new ModalBuilder()
      .setCustomId(`music_modal_search:${guildId}`)
      .setTitle('Search Music Catalogue');
    const input = new TextInputBuilder()
      .setCustomId('query')
      .setLabel('Search Song, Artist, or Mood')
      .setPlaceholder('e.g. Suzonn, chill, gaming')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return void await interaction.showModal(modal);
  }

  if (action === 'mood') {
    const dj = await getGuildDjStatus(guildId);
    return void await interaction.reply({
      content: `🎶 **AI DJ Mood Status**\nMode: **${dj.mode}**\nEffective Mood: **${dj.effectiveMood ?? 'chill'}**\nActive Catalogue Tracks: **${dj.catalogueCount}**\n\nUse \`/mood set\` to switch moods!`,
      ephemeral: true
    });
  }

  // Playback control actions
  getVoiceContext(interaction);
  await assertModerator(interaction, guildId);

  if (action === 'prev') {
    replayTrack(guildId);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'play_pause') {
    if (snapshot?.paused) resumePlayback(guildId);
    else pausePlayback(guildId);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'skip') {
    skipPlayback(guildId);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'stop') {
    stopPlayback(guildId);
    destroySession(guildId);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'vol_down') {
    adjustVolume(guildId, -10);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'vol_up') {
    adjustVolume(guildId, +10);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'repeat') {
    cycleRepeatMode(guildId);
    return void await interaction.update(makePanel(guildId, interaction.user.id));
  }
  if (action === 'ai_mix') {
    const result = await getAiShuffleTracks(guildId, 3, interaction.user.id);
    const tracks = result.tracks;
    if (!tracks.length) throw new Error('No catalogue tracks available for AI mix.');
    const { guild, voice, text } = getVoiceContext(interaction);
    for (const t of tracks) {
      await enqueueTrack(guild, voice, text, { ...t, requestedBy: interaction.user.id });
    }
    await interaction.reply({ content: `🪄 Added **${tracks.length}** AI mood-matched tracks to the queue!`, ephemeral: true });
    return void await text.send(makePanel(guildId, interaction.user.id)).catch(() => undefined);
  }

  throw new Error('Unknown button action.');
}

async function executeModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const [prefix, actionGuild] = interaction.customId.split(':');
  const guildId = actionGuild;
  if (!guildId || guildId !== interaction.guildId) throw new Error('This modal belongs to another server.');

  if (prefix === 'music_modal_add') {
    const input = interaction.fields.getTextInputValue('url_or_title');
    const { guild, voice, text } = getVoiceContext(interaction as any);
    let track: Track;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      track = await resolveTrackMetadata(input, interaction.user.id);
    } else {
      const results = await searchCatalogue(guildId, input);
      if (results.length > 0 && results[0]) {
        const match = results[0];
        track = {
          title: match.title,
          url: match.url,
          artist: match.artist ?? undefined,
          catalogueTrackId: match.id,
          requestedBy: interaction.user.id,
          durationSeconds: match.durationSeconds ?? undefined,
          bpm: match.bpm ?? undefined,
          energy: match.energy ?? undefined,
          genreTags: match.genreTags,
          moodTags: match.moodTags
        };
      } else {
        throw new Error(`Could not find "${input}" in the server catalogue. Please provide a direct HTTPS audio URL.`);
      }
    }
    const result = await enqueueTrack(guild, voice, text, track);
    await interaction.reply({
      content: result.started ? `Now playing **${track.title}**.` : `Added **${track.title}** to the queue at position ${result.position}.`,
      ephemeral: true
    });
    return;
  }

  if (prefix === 'music_modal_search') {
    const query = interaction.fields.getTextInputValue('query');
    const results = await searchCatalogue(guildId, query);
    if (!results.length) {
      return void await interaction.reply({ content: `No tracks found matching "${query}".`, ephemeral: true });
    }
    const lines = results.slice(0, 5).map(t => `**#${t.id}** · ${t.title}${t.artist ? ` — ${t.artist}` : ''}`);
    return void await interaction.reply({
      content: `**Search Results for "${query}"**\n${lines.join('\n')}\n\nPlay any result with \`/play catalogue_id:<ID>\`.`,
      ephemeral: true
    });
  }
}

export function registerBotHandlers(client: Client): void {
  setOnTrackStart(async (guildId, track, textChannel) => {
    if (textChannel && 'send' in textChannel) {
      await textChannel.send(makePanel(guildId, track.requestedBy)).catch((e) => {
        log('warn', 'track_start_panel_send_failed', { guildId, error: e instanceof Error ? e.message : e });
      });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) await executeCommand(interaction);
      else if (interaction.isButton() && interaction.customId.startsWith('music:')) await executeButton(interaction);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('music_modal_')) await executeModalSubmit(interaction);
    } catch (error) {
      log('warn', 'interaction_failed', {
        guildId: interaction.guildId,
        command: interaction.isChatInputCommand() ? interaction.commandName : interaction.isButton() ? interaction.customId.split(':')[1] : undefined,
        error
      });
      incrementMetric('interaction_errors_total');
      await replyError(interaction as ChatInputCommandInteraction | ButtonInteraction, error);
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      let inviterId: string | null = null;
      try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 1 });
        const entry = logs.entries.first();
        if (entry && entry.target?.id === client.user?.id) {
          inviterId = entry.executor?.id ?? null;
        }
      } catch {
        // Audit log permissions may not be granted
      }

      const channel = guild.systemChannel ?? guild.channels.cache.find(c => c.isTextBased() && 'send' in c);
      if (channel && 'send' in channel) {
        const greeting = inviterId ? `👋 Thanks for inviting me, <@${inviterId}>!` : `👋 Thanks for inviting me!`;
        await (channel as GuildTextBasedChannel).send({
          content: `${greeting} I'm your AI Music Companion.\nJoin a voice channel and type </join:0> or </play:0> to open your music controller.`,
          ...makePanel(guild.id, inviterId ?? undefined)
        }).catch(() => undefined);
      }
    } catch (err) {
      log('warn', 'guild_create_greeting_failed', { guildId: guild.id, error: err });
    }
  });

  client.once(Events.ClientReady, (readyClient) => {
    log('info', 'discord_client_ready', { tag: readyClient.user.tag, guildCountOnShard: readyClient.guilds.cache.size });
  });
}
