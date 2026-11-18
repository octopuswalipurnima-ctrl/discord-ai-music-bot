import { SlashCommandBuilder } from 'discord.js';

const playlist = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Manage your private playlists and owner-granted playlist access')
  .addSubcommand((sub) => sub.setName('create').setDescription('Create a playlist').addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(50)))
  .addSubcommand((sub) => sub.setName('list').setDescription('List your playlists and your current limit'))
  .addSubcommand((sub) => sub.setName('add').setDescription('Add an approved audio URL to a playlist')
    .addStringOption((o) => o.setName('playlist').setDescription('Your playlist name').setRequired(true).setMaxLength(50))
    .addStringOption((o) => o.setName('url').setDescription('Direct HTTPS audio stream URL').setRequired(true).setMaxLength(1500))
    .addStringOption((o) => o.setName('title').setDescription('Track title').setMaxLength(200)))
  .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a track by its displayed position')
    .addStringOption((o) => o.setName('playlist').setDescription('Your playlist name').setRequired(true).setMaxLength(50))
    .addIntegerOption((o) => o.setName('position').setDescription('Track number').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('view').setDescription('Show tracks in a playlist')
    .addStringOption((o) => o.setName('name').setDescription('Your playlist name').setRequired(true).setMaxLength(50)))
  .addSubcommand((sub) => sub.setName('play').setDescription('Add all tracks from a playlist to the voice queue')
    .addStringOption((o) => o.setName('name').setDescription('Your playlist name').setRequired(true).setMaxLength(50)))
  .addSubcommand((sub) => sub.setName('delete').setDescription('Delete one of your playlists')
    .addStringOption((o) => o.setName('name').setDescription('Your playlist name').setRequired(true).setMaxLength(50)))
  .addSubcommand((sub) => sub.setName('rename').setDescription('Rename one of your playlists')
    .addStringOption((o) => o.setName('name').setDescription('Current playlist name').setRequired(true).setMaxLength(50))
    .addStringOption((o) => o.setName('new_name').setDescription('New playlist name').setRequired(true).setMaxLength(50)))
  .addSubcommand((sub) => sub.setName('grant').setDescription('Server owner: give a member a three-playlist limit')
    .addUserOption((o) => o.setName('member').setDescription('Member to promote').setRequired(true)))
  .addSubcommand((sub) => sub.setName('revoke').setDescription('Server owner: return a member to the two-playlist limit')
    .addUserOption((o) => o.setName('member').setDescription('Member to revoke').setRequired(true)));


const mood = new SlashCommandBuilder()
  .setName('mood')
  .setDescription('Set or inspect the AI DJ mood for this server')
  .addSubcommand((sub) => sub.setName('set').setDescription('Set a manual AI DJ mood (moderators only)')
    .addStringOption((o) => o.setName('mood').setDescription('Music mood').setRequired(true).addChoices(
      { name: 'Chill', value: 'chill' }, { name: 'Party', value: 'party' }, { name: 'Gaming', value: 'gaming' },
      { name: 'Focus', value: 'focus' }, { name: 'Romantic', value: 'romantic' }, { name: 'Sad', value: 'sad' },
      { name: 'Nostalgic', value: 'nostalgic' }
    )))
  .addSubcommand((sub) => sub.setName('auto').setDescription('Let the AI infer the room music mood from recent tracks (moderators only)'))
  .addSubcommand((sub) => sub.setName('off').setDescription('Turn off automatic mood selection (moderators only)'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the current AI DJ mood'));

const catalogue = new SlashCommandBuilder()
  .setName('catalog')
  .setDescription("Manage this server's approved music catalogue")
  .addSubcommand((sub) => sub.setName('add').setDescription('Add an approved direct stream with metadata (moderators only)')
    .addStringOption((o) => o.setName('url').setDescription('Approved direct HTTPS audio stream URL').setRequired(true).setMaxLength(1500))
    .addStringOption((o) => o.setName('title').setDescription('Track title').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('artist').setDescription('Artist').setMaxLength(120))
    .addStringOption((o) => o.setName('genres').setDescription('Comma-separated genres, e.g. pop, edm').setMaxLength(200))
    .addStringOption((o) => o.setName('moods').setDescription('Comma-separated mood tags, e.g. party, gaming').setMaxLength(120))
    .addStringOption((o) => o.setName('language').setDescription('Language').setMaxLength(32))
    .addIntegerOption((o) => o.setName('bpm').setDescription('Tempo in beats per minute').setMinValue(30).setMaxValue(250))
    .addIntegerOption((o) => o.setName('energy').setDescription('Energy from 0 (low) to 100 (high)').setMinValue(0).setMaxValue(100)))
  .addSubcommand((sub) => sub.setName('search').setDescription('Search this server music catalogue')
    .addStringOption((o) => o.setName('query').setDescription('Track, artist, genre or mood').setRequired(true).setMinLength(2).setMaxLength(80)))
  .addSubcommand((sub) => sub.setName('remove').setDescription('Deactivate a catalogue track (moderators only)')
    .addIntegerOption((o) => o.setName('track_id').setDescription('ID shown by /catalog search').setRequired(true).setMinValue(1)));

const aiShuffle = new SlashCommandBuilder()
  .setName('ai-shuffle')
  .setDescription('Fill the queue with AI mood-matched, varied catalogue tracks')
  .addIntegerOption((o) => o.setName('count').setDescription('Number of tracks to add (1–10)').setMinValue(1).setMaxValue(10));


const taste = new SlashCommandBuilder()
  .setName('taste')
  .setDescription('Control your private, opt-in music taste profile')
  .addSubcommand((sub) => sub.setName('opt-in').setDescription('Enable private listening history for this server'))
  .addSubcommand((sub) => sub.setName('opt-out').setDescription('Stop recording future listening history'))
  .addSubcommand((sub) => sub.setName('profile').setDescription('Show your private music taste profile'))
  .addSubcommand((sub) => sub.setName('history').setDescription('Show your recent requested tracks'))
  .addSubcommand((sub) => sub.setName('feedback').setDescription('Like or dislike the currently playing track')
    .addStringOption((o) => o.setName('sentiment').setDescription('Your feedback').setRequired(true)
      .addChoices({ name: 'Like', value: 'like' }, { name: 'Dislike', value: 'dislike' })))
  .addSubcommand((sub) => sub.setName('forget').setDescription('Delete your saved music history and turn tracking off'));

const forMe = new SlashCommandBuilder()
  .setName('for-me')
  .setDescription('Queue recommendations based on your private music taste')
  .addIntegerOption((o) => o.setName('count').setDescription('Number of recommendations (1–10)').setMinValue(1).setMaxValue(10));

const askMusic = new SlashCommandBuilder()
  .setName('ask-music')
  .setDescription('Ask the music assistant for tracks in natural language')
  .addStringOption((o) => o.setName('request').setDescription('What would you like to hear?').setRequired(true).setMinLength(3).setMaxLength(300))
  .addIntegerOption((o) => o.setName('count').setDescription('Number of tracks (1–5)').setMinValue(1).setMaxValue(5));

const musicAdmin = new SlashCommandBuilder()
  .setName('music-admin')
  .setDescription('Configure moderator access and manage this server music session')
  .addSubcommand((sub) => sub.setName('set-mod-role').setDescription('Set the role allowed to moderate music')
    .addRoleOption((o) => o.setName('role').setDescription('Moderator role').setRequired(true)))
  .addSubcommand((sub) => sub.setName('clear-mod-role').setDescription('Remove the configured moderator role'))
  .addSubcommand((sub) => sub.setName('settings').setDescription('Show this server music configuration'))
  .addSubcommand((sub) => sub.setName('clear-queue').setDescription('Moderator: remove all upcoming tracks'));

const dashboard = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Get a private, direct link to the web music dashboard with your server role');

export const commands = [
  dashboard,
  new SlashCommandBuilder().setName('play').setDescription('Play an approved stream URL or a track from this server catalogue')
    .addStringOption((o) => o.setName('url').setDescription('Direct HTTPS audio URL').setRequired(false).setMaxLength(1500))
    .addIntegerOption((o) => o.setName('catalogue_id').setDescription('Track ID from /catalog search').setRequired(false).setMinValue(1))
    .addStringOption((o) => o.setName('title').setDescription('Track title (for direct URLs)').setMaxLength(200)),
  new SlashCommandBuilder().setName('pause').setDescription('Moderator: pause the current track'),
  new SlashCommandBuilder().setName('resume').setDescription('Moderator: resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Moderator: skip the current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Moderator: stop playback and clear the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Moderator: disconnect the bot from voice'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the music control panel'),
  new SlashCommandBuilder().setName('volume').setDescription('Moderator: set playback volume')
    .addIntegerOption((o) => o.setName('percent').setDescription('Volume from 0 to 100').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('repeat').setDescription('Moderator: set repeat mode')
    .addStringOption((o) => o.setName('mode').setDescription('Repeat mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Current track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  playlist,
  musicAdmin,
  mood,
  catalogue,
  aiShuffle,
  taste,
  forMe,
  askMusic
].map((command) => command.toJSON());
