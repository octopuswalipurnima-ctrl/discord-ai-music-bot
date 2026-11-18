const counters = new Map<string, number>();
const startedAt = Date.now();

function key(name: string, labels: Record<string, string> = {}): string {
  const suffix = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => `${label}=${value}`).join(',');
  return suffix ? `${name}|${suffix}` : name;
}

export function incrementMetric(name: string, labels: Record<string, string> = {}, by = 1): void {
  const metricKey = key(name, labels);
  counters.set(metricKey, (counters.get(metricKey) ?? 0) + by);
}

export function renderPrometheusMetrics(extra: { shardId: string; guildCount: number; voiceSessions: number }): string {
  const lines = [
    '# HELP musicbot_process_uptime_seconds Process uptime in seconds',
    '# TYPE musicbot_process_uptime_seconds gauge',
    `musicbot_process_uptime_seconds ${(Date.now() - startedAt) / 1000}`,
    '# HELP musicbot_discord_guilds Number of guilds in this shard cache',
    '# TYPE musicbot_discord_guilds gauge',
    `musicbot_discord_guilds{shard="${extra.shardId}"} ${extra.guildCount}`,
    '# HELP musicbot_voice_sessions Active voice sessions in this process',
    '# TYPE musicbot_voice_sessions gauge',
    `musicbot_voice_sessions{shard="${extra.shardId}"} ${extra.voiceSessions}`,
    '# HELP musicbot_events_total Application event counters',
    '# TYPE musicbot_events_total counter'
  ];
  for (const [metricKey, value] of counters) {
    const [name, labelPart] = metricKey.split('|');
    const labels = labelPart ? `{${labelPart.split(',').map((pair) => {
      const [label, labelValue] = pair.split('=');
      return `${label}="${(labelValue ?? '').replaceAll('"', '\\"')}"`;
    }).join(',')}}` : '';
    lines.push(`${name}${labels} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
