import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
const route = config.DISCORD_DEV_GUILD_ID
  ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_DEV_GUILD_ID)
  : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

try {
  console.log(`Registering ${commands.length} slash commands ${config.DISCORD_DEV_GUILD_ID ? 'to development guild' : 'globally'}...`);
  await rest.put(route, { body: commands });
  console.log('Slash commands registered.');
} catch (error) {
  console.error('Could not register slash commands:', error);
  process.exitCode = 1;
}
