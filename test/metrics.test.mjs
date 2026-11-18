import test from 'node:test';
import assert from 'node:assert/strict';
import { incrementMetric, renderPrometheusMetrics } from '../dist/metrics.js';

test('renders process, guild, session and application counters in Prometheus text format', () => {
  incrementMetric('discord_commands_total', { command: 'play' }, 2);
  const output = renderPrometheusMetrics({ shardId: '0', guildCount: 12, voiceSessions: 3 });
  assert.match(output, /musicbot_process_uptime_seconds/);
  assert.match(output, /musicbot_discord_guilds\{shard="0"\} 12/);
  assert.match(output, /musicbot_voice_sessions\{shard="0"\} 3/);
  assert.match(output, /discord_commands_total\{command="play"\} 2/);
});
