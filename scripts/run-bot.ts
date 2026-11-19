import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { config } from '../src/config.js';
import { registerBotHandlers } from '../src/bot.js';
import { log } from '../src/logger.js';

console.log('Starting Discord AI Music Bot in standalone local mode...');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

registerBotHandlers(client);

client.once('ready', (readyClient) => {
  console.log(`\n========================================================`);
  console.log(`🎶 Discord AI Music Bot is ONLINE!`);
  console.log(`🏷️  Bot Tag:     ${readyClient.user.tag}`);
  console.log(`🆔  Bot ID:      ${readyClient.user.id}`);
  console.log(`🏰  Servers:     ${readyClient.guilds.cache.size}`);
  readyClient.guilds.cache.forEach(guild => {
    console.log(`    - ${guild.name} (ID: ${guild.id})`);
  });
  console.log(`========================================================`);
  console.log(`Type /join or /play in your Discord server to summon the bot!\n`);

  readyClient.user.setActivity({
    name: 'Rihaee - Suzonn | /join',
    type: ActivityType.Listening
  });
});

client.login(config.DISCORD_TOKEN).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});
