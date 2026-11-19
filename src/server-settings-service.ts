import { db } from './db.js';

export interface ServerSettings {
  guildId: string;
  moderatorRoleId: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

const inMemorySettings = new Map<string, ServerSettings>();

export async function getServerSettings(guildId: string): Promise<ServerSettings> {
  try {
    const result = await db.query(
      `SELECT guild_id AS "guildId", moderator_role_id AS "moderatorRoleId",
              updated_by AS "updatedBy", updated_at AS "updatedAt"
         FROM server_settings WHERE guild_id = $1`,
      [guildId]
    );
    return result.rows[0] as ServerSettings | undefined ?? {
      guildId, moderatorRoleId: null, updatedBy: null, updatedAt: null
    };
  } catch {
    return inMemorySettings.get(guildId) ?? {
      guildId, moderatorRoleId: null, updatedBy: null, updatedAt: null
    };
  }
}

export async function setModeratorRole(guildId: string, roleId: string | null, actorId: string): Promise<void> {
  inMemorySettings.set(guildId, {
    guildId,
    moderatorRoleId: roleId,
    updatedBy: actorId,
    updatedAt: new Date()
  });
  try {
    await db.query(
      `INSERT INTO server_settings (guild_id, moderator_role_id, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (guild_id) DO UPDATE
         SET moderator_role_id = EXCLUDED.moderator_role_id,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [guildId, roleId, actorId]
    );
    await recordServerAudit(guildId, actorId, roleId ? 'moderator_role_set' : 'moderator_role_cleared', null, { roleId });
  } catch {
    // Non-fatal when running in memory mode
  }
}

export async function recordServerAudit(
  guildId: string, actorId: string, action: string, targetId: string | null, details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO server_audit_log (guild_id, actor_id, action, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [guildId, actorId, action, targetId, JSON.stringify(details)]
    );
  } catch {
    // Non-fatal
  }
}
