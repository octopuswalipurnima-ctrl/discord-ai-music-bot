import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from '../src/config.js';

async function main() {
  console.log('Querying Discord REST API for guilds...');
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  try {
    const guilds = await rest.get(Routes.userGuilds()) as any[];
    console.log(`\n========================================================`);
    console.log(`🏰 REST API reports ${guilds.length} guilds where bot is a member:`);
    for (const g of guilds) {
      console.log(`   - ${g.name} (ID: ${g.id}) [Owner: ${g.owner}]`);
    }
    console.log(`========================================================\n`);
  } catch (err: any) {
    console.error('REST API error:', err.message);
  }
}

main().catch(console.error);


