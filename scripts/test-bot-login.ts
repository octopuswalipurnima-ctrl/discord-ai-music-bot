import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';

console.log('Connecting to Discord Gateway with token...');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.once('ready', (readyClient) => {
  console.log(`\n========================================================`);
  console.log(`🤖 Bot Authenticated Successfully!`);
  console.log(`🏷️  Bot Tag:     ${readyClient.user.tag}`);
  console.log(`🆔  Bot ID:      ${readyClient.user.id}`);
  console.log(`🏰  Guilds:      ${readyClient.guilds.cache.size}`);
  readyClient.guilds.cache.forEach(guild => {
    console.log(`    - ${guild.name} (ID: ${guild.id})`);
  });
  console.log(`========================================================\n`);
  client.destroy();
  process.exit(0);
});

client.login(config.DISCORD_TOKEN).catch((err) => {
  console.error('Bot login failed:', err.message);
  process.exit(1);
});
