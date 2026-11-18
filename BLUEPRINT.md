# Implementation Blueprint

## Product goal

A public Discord voice music bot with one shared voice queue per server, per-member private playlists, owner/moderator controls, a public dashboard, a server-level AI DJ, and a privacy-aware personal AI music assistant.

The bot has two distinct permission contexts:

- **Member context:** a Discord user manages only their own playlists and playback requests.
- **Server context:** the server owner or an authorized manager configures server settings; only the actual server owner can grant or revoke special-member playlist capacity.

Playlists in Phase 1 are private to their owner and scoped to a Discord server. A regular member can create two. The Phase 2 entitlement table lets the server owner raise an approved member to three.

## System layout

```text
Discord App / Web Dashboard
           |
           v
  Interaction + OAuth API
    |          |          |
    v          v          v
Guild Player Playlist   Personal Music
    |       Service      Service
    v          |          |
Voice Engine  |       Taste Engine
    |         |          |
Audio Source |          |
Adapter      |          |
    |         |          |
    +---------+----------+
              |
              v
          PostgreSQL
   (playlists, catalogue, DJ settings,
    consent, personal events, audit log)
              |
              v
  Approved catalogue stream references
```

### Runtime components

| Module | Responsibility |
|---|---|
| `bot.ts` | Slash commands, button interactions, voice-channel membership checks |
| `player.ts` | One voice connection, queue, repeat state and volume per guild |
| `audio-source.ts` | Validates and opens approved HTTPS audio streams; FFmpeg conversion to Discord voice PCM |
| `playlist-service.ts` | User-owned playlists, per-server ownership, playlist limits, entitlements and track CRUD |
| `server-settings-service.ts` | Per-guild moderator role configuration and audit logging |
| `db.ts` | PostgreSQL pool and idempotent Phase 1–4 schema initialization |
| `personal-music-service.ts` | Opt-in consent, history/feedback events, privacy deletion, taste profiles and catalogue-only personal recommendations |
| `taste-recommendation.ts` | Explainable preference scoring, diversity, recency avoidance and local natural-language intent parsing |
| `dashboard.ts` | Discord OAuth login, manager controls, per-member personal AI DJ panel, CSRF-protected data controls |
| `register-commands.ts` | Registers application slash commands |
| `redis.ts` | Redis lifecycle and connection health |
| `queue-store.ts` | Guild session leases and upcoming queue snapshots |
| `rate-limit.ts` | Atomic shared rate limits |
| `logger.ts` | Structured JSON logs |
| `metrics.ts` | Process-local Prometheus metrics |
| `index.ts`, `worker.ts`, `worker-runtime.ts` | Production shard supervisor and shard worker lifecycle |

## Phase 1 scope — implemented in this starter

### Playback

- `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/leave`
- `/queue`, `/nowplaying`, `/volume`, `/repeat`
- `/nowplaying` produces an embed control panel with pause, resume, skip and stop buttons.
- Repeat modes: off, current track, full queue.
- The queue is per server and currently held in process memory.

### Personal playlists

- `/playlist create`, `list`, `add`, `remove`, `view`, `play`, `delete`, `rename`
- Two playlists per member per server by default.
- Playlist and track rows persist in PostgreSQL.
- Playlist names are case-insensitive within the same member/server.
- Playlist creation uses a database transaction and per-member advisory lock to prevent racing requests from exceeding the cap.

### Dashboard

- Discord OAuth2 login using `identify` and `guilds` scopes.
- Only shows mutual servers where the signed-in account is owner or has Manage Server/Administrator permission.
- Server playback state and basic admin actions are served by protected API routes.
- Dashboard sessions are stored in PostgreSQL; state and CSRF tokens protect login/actions.

### Audio input limitation

Phase 1 accepts only a direct HTTPS audio stream from a hostname explicitly placed in `AUDIO_ALLOWED_HOSTS`. It rejects page URLs, unapproved hosts, credentials in URLs, redirects, private-address DNS answers, and non-audio content types.

This is intentionally not a universal URL-to-audio extractor. A Spotify, YouTube, YouTube Music or Gaana page URL does not itself grant the bot a right to rebroadcast the underlying recording in a Discord voice channel. Provider integrations must use a permitted API and a playback licence/contract suitable for the actual use. Provider URL recognition and metadata matching are a separate feature from audio delivery, and metadata from one service must not be combined with another service's streams when the provider's rules prohibit that integration.

## Phase 2 — permission and moderation layer (implemented)

1. Owner-only `/playlist grant @member` and `/playlist revoke @member` commands, plus matching owner-only dashboard actions.
2. Granting a member writes `(guild_id, user_id, max_playlists=3, granted_by)` into `playlist_limits`. Grants are validated against actual guild membership and bots are rejected.
3. Revocation deletes the entitlement and returns the member to a two-playlist allowance. Existing playlists are never deleted; if the member has two or more, creation remains blocked until they reduce their count to fewer than two.
4. `/music-admin set-mod-role`, `/music-admin clear-mod-role`, and `/music-admin settings` configure a per-server music moderator role. Server owner, Administrator, and Manage Server permissions always retain moderator access.
5. `/pause`, `/resume`, `/skip`, `/stop`, `/leave`, `/volume`, `/repeat`, Now Playing buttons, and `/music-admin clear-queue` require a moderator. `/play`, `/queue`, `/nowplaying`, and personal playlist operations remain member-accessible.
6. `/music-admin clear-queue` removes upcoming tracks while the current track continues.
7. The dashboard lists the guild's assignable roles, lets server managers set the moderator role, and allows only the current owner to grant/revoke special playlist capacity.
8. `server_settings` stores moderator role configuration. `server_audit_log` records role changes and special-member grants/revocations. Database changes are idempotently applied at startup.
9. Playlist create/grant/revoke operations use the same per-user/server PostgreSQL advisory lock. This avoids concurrent create/revoke operations crossing the playlist cap.

## Phase 3 — catalogue and mood DJ (implemented in this starter)

1. Added a server-scoped `music_catalogue_tracks` table for approved direct HTTPS streams and normalized metadata: title, artist, album, duration, genre tags, mood tags, language, BPM and energy. Catalogue URLs still pass the Phase 1 HTTPS host allow-list and SSRF checks at playback time.
2. Added `/catalog add`, `/catalog search` and `/catalog remove`. Only the server owner, administrators, members with Manage Server, or the configured moderator role can add/remove tracks. Every server has an isolated catalogue.
3. Added `/mood set`, `/mood auto`, `/mood off` and `/mood status`. Mood changes are moderator-only; status is member-accessible. Mood state is persisted per guild in `guild_dj_settings`.
4. Added `/ai-shuffle count:1..10`. A metadata-ranking engine scores mood tags, genre, BPM and energy; then uses artist/genre variety and recent-play exclusion. Off mode produces a balanced discovery mix.
5. `/play catalogue_id:<ID>` queues a track returned by `/catalog search`; direct HTTPS stream playback remains available.
6. Catalogue track starts are recorded in `guild_track_history` to support recent-play exclusion and Auto mood inference. Auto mode classifies recent track metadata; it does not inspect voice audio, record conversations, or transcribe members.
7. The web dashboard includes per-server mood selection, current effective mood and catalogue size.
8. The recommender is an explainable metadata-based scoring algorithm, not an LLM. External Spotify/YouTube/Gaana or other service adapters are not included because their API access and public Discord playback rights must be confirmed independently. The source adapter contract can be extended only when the relevant provider permits the exact playback use.

## Phase 4 — personal AI DJ and privacy-aware assistant (implemented)

1. `user_music_preferences` stores per-user/per-server consent. History is off by default; `/taste opt-in` starts collection and `/taste opt-out` stops future collection without deleting prior history.
2. `user_track_events` stores compact track metadata snapshots for opted-in play-start events and user-submitted likes/dislikes. Only the requester is attributed; the bot does not track other voice participants, inspect voice activity, record conversations, or transcribe audio.
3. `/taste profile` and `/taste history` are private ephemeral commands. `/taste feedback sentiment:like|dislike` explicitly rates the current track. `/taste forget` transactionally deletes the user's event history for that server and leaves collection disabled.
4. Personal taste vectors weight explicit likes and dislikes more strongly than play-start events. Candidate ranking uses artist, genre, mood, language, energy, recent-play avoidance and artist/genre diversity.
5. `/for-me count` requires opt-in and queues tracks from the current server's active moderator-managed catalogue. `/ask-music request count` supports natural-language intent with local parsing by default; an optional OpenAI-compatible endpoint can parse mood/genre/keywords, but final track selection remains grounded in the local catalogue.
6. Dashboard personal endpoints verify live membership and use the authenticated Discord ID only—there is no target-user parameter. Writes require CSRF tokens. Members can see their own consent, counts and recent requests even without Manage Server permissions; server settings remain manager-only.
7. Consent changes, event writes and history deletion use a shared PostgreSQL advisory lock per user/server so an opt-out or forget operation is serialized with event collection.
8. The optional external intent parser receives only the `/ask-music` request text, not the stored history, likes or taste profile. Blank AI endpoint settings use the built-in parser with no outbound AI request.



### User-facing commands

- `/taste opt-in` and `/taste opt-out` control per-user, per-server event collection.
- `/taste profile` summarizes preferred genres, artists and moods from private events.
- `/taste history` shows recent requested songs.
- `/taste feedback sentiment:like|dislike` records explicit feedback on the current song.
- `/taste forget` removes the user's event records and disables tracking.
- `/for-me count` generates a personal queue from the user's profile.
- `/ask-music request count` parses a natural-language request and ranks only the current server's active catalogue.

### Privacy and data flow

History is disabled by default. After opt-in, the bot records only the requester ID already attached to a queued track when that track begins playback, plus feedback submitted by that user. It does not infer which other voice participants listened, read voice activity, or capture conversations. Personal data is partitioned by `(guild_id, user_id)`. `/taste opt-out` preserves old events, which remain viewable by the user, but stops new collection; `/taste forget` transactionally deletes all personal events in that server and writes an off consent state. Personal history stores track metadata snapshots, not source URLs.

### Recommendation approach

The personal taste profile is computed from stored play, like and dislike events. Plays contribute a small positive signal; explicit likes and dislikes have stronger positive/negative weights. Ranking uses artist, genre and mood preferences, optional natural-language constraints, language and energy metadata, recent-play avoidance and artist/genre diversity. All playable candidates must be active in that server's moderator-managed catalogue.

The natural-language assistant uses a local intent parser by default. An optional OpenAI-compatible chat completion endpoint may be configured with `AI_API_BASE_URL`, `AI_API_KEY` and `AI_MODEL`. Only the request text is sent to that external endpoint; personal listening history and preference profile remain local. The model returns structured intent, not track names or stream URLs, and the application validates the mood and then selects from the approved local catalogue.

### Dashboard additions

Signed-in members of mutual bot servers can view and control their own per-server consent/profile via `/api/personal/:guildId/*`. These routes verify live server membership, require CSRF tokens for writes, and never accept a target user ID—the authenticated Discord account is always the data owner. Manager-only settings and playback routes remain separate.

## Phase 5 — public operations and scaling foundation

### Implemented in this repository

- Redis client and health checks shared by each shard process.
- Per-guild Redis voice-session lease with a random ownership token, 60-second expiry, and 20-second renewals. Lua compare-and-renew/release prevents one process from releasing another process's lease.
- Redis snapshots for upcoming queue items, capped by the configured maximum and expiring after seven days. On a new `/play` session, restored URLs are revalidated against the configured audio-host allow-list.
- Discord.js `ShardingManager` production entry point, automatic shard count by default, and one worker process for each shard. Development can still run a single unsharded worker.
- Redis-backed fixed-window rate limits for Discord commands, music buttons, and dashboard API writes.
- Structured JSON logs with timestamp, severity, service, shard ID, event and structured fields.
- `/health/live`, `/health`, `/health/ready`, and optional bearer-protected `/metrics`.
- Docker Compose services for PostgreSQL, Redis and an optional production bot container; health checks and persistent volumes are configured.
- Graceful worker shutdown that snapshots upcoming queues and closes local voice sessions, dashboard, PostgreSQL and Redis connections.

### Explicit Phase 5 boundaries

- The Redis lease coordinates guild ownership; it does not migrate a live Discord voice connection between hosts.
- Queue persistence stores upcoming tracks only. The active track, elapsed playback position, repeat mode and volume are not restored. The upcoming queue is loaded when a later `/play` request opens a new voice session.
- Sharding is a single `ShardingManager` process tree in the provided Docker topology. Multi-host shard assignment requires external orchestration and a fixed global shard plan.
- The dashboard currently runs on shard 0 and uses that process's local guild/player cache. A cross-shard command bus or owner-shard RPC must be added before the dashboard can manage every guild in a multi-shard deployment.
- Metrics counters are process-local; they are not aggregated across shards.

## Current non-goals / not implemented

- No Spotify/YouTube/Gaana page URL extraction or audio bypass.
- No universal consumer-platform track search or provider page URL resolver. Catalogue search currently searches only the tracks that a moderator has added to that server.
- No playlist sharing/privacy modes yet; playlists remain private to their owner inside each server.
- No standalone independently scalable audio-worker fleet; the guild-owning Discord shard manages its voice connection.
- No cross-shard dashboard routing or global metrics aggregation yet.
- No automatic restore of the active song/current timestamp after restart.
