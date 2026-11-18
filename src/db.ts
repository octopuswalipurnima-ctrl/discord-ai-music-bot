import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

export async function initializeDatabase(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(24) NOT NULL,
      owner_id VARCHAR(24) NOT NULL,
      name VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, owner_id, name)
    );
    CREATE INDEX IF NOT EXISTS playlists_owner_idx ON playlists (guild_id, owner_id);

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id BIGSERIAL PRIMARY KEY,
      playlist_id BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      source_url TEXT NOT NULL,
      added_by VARCHAR(24) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_idx ON playlist_tracks (playlist_id, id);

    CREATE TABLE IF NOT EXISTS playlist_limits (
      guild_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      max_playlists SMALLINT NOT NULL DEFAULT 3 CHECK (max_playlists IN (2, 3)),
      granted_by VARCHAR(24) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id VARCHAR(24) PRIMARY KEY,
      moderator_role_id VARCHAR(24),
      updated_by VARCHAR(24),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS server_audit_log (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(24) NOT NULL,
      actor_id VARCHAR(24) NOT NULL,
      action VARCHAR(64) NOT NULL,
      target_id VARCHAR(24),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS server_audit_log_guild_idx ON server_audit_log (guild_id, created_at DESC);

    -- Phase 3: a guild-scoped catalogue of approved, playable streams and their metadata.
    CREATE TABLE IF NOT EXISTS music_catalogue_tracks (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(24) NOT NULL,
      title VARCHAR(200) NOT NULL,
      artist VARCHAR(120),
      album VARCHAR(120),
      source_url TEXT NOT NULL,
      duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
      genre_tags TEXT[] NOT NULL DEFAULT '{}',
      mood_tags TEXT[] NOT NULL DEFAULT '{}',
      language VARCHAR(32),
      bpm SMALLINT CHECK (bpm IS NULL OR bpm BETWEEN 30 AND 250),
      energy NUMERIC(4,3) CHECK (energy IS NULL OR energy BETWEEN 0 AND 1),
      added_by VARCHAR(24) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, source_url)
    );
    CREATE INDEX IF NOT EXISTS music_catalogue_guild_active_idx ON music_catalogue_tracks (guild_id, active, id DESC);
    CREATE INDEX IF NOT EXISTS music_catalogue_title_idx ON music_catalogue_tracks (guild_id, title);

    CREATE TABLE IF NOT EXISTS guild_dj_settings (
      guild_id VARCHAR(24) PRIMARY KEY,
      mood VARCHAR(24),
      auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by VARCHAR(24),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (mood IS NULL OR mood IN ('chill','party','gaming','focus','romantic','sad','nostalgic'))
    );

    CREATE TABLE IF NOT EXISTS guild_track_history (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(24) NOT NULL,
      catalogue_track_id BIGINT REFERENCES music_catalogue_tracks(id) ON DELETE SET NULL,
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS guild_track_history_recent_idx ON guild_track_history (guild_id, played_at DESC);


    -- Phase 4: personal music history is opt-in and scoped to each member in each server.
    CREATE TABLE IF NOT EXISTS user_music_preferences (
      guild_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      history_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      consent_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS user_track_events (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      catalogue_track_id BIGINT REFERENCES music_catalogue_tracks(id) ON DELETE SET NULL,
      title VARCHAR(200) NOT NULL,
      artist VARCHAR(120),
      genre_tags TEXT[] NOT NULL DEFAULT '{}',
      mood_tags TEXT[] NOT NULL DEFAULT '{}',
      language VARCHAR(32),
      bpm SMALLINT CHECK (bpm IS NULL OR bpm BETWEEN 30 AND 250),
      energy NUMERIC(4,3) CHECK (energy IS NULL OR energy BETWEEN 0 AND 1),
      event_type VARCHAR(12) NOT NULL CHECK (event_type IN ('play','like','dislike')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS user_track_events_recent_idx ON user_track_events (guild_id, user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_track_events_type_idx ON user_track_events (guild_id, user_id, event_type, created_at DESC);
  `);
}

export async function closeDatabase(): Promise<void> {
  await db.end();
}
