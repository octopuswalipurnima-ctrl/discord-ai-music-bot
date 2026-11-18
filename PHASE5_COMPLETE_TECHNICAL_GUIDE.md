# Discord AI Music Bot — Complete Technical & Development Guide

**Project:** Discord AI Music Bot  
**Version:** `0.5.0`  
**Phase:** 5 — Public Operations, Redis Coordination, Sharding & Launch Hardening  
**Primary language:** TypeScript  
**Runtime:** Node.js `>=22.12.0`  
**Last updated:** 18 November 2026

---

## 0. Important status note

This guide describes the code in this repository, including the foundations added in Phases 1–5. It is not a claim that the bot has been deployed to Discord, approved by any music provider, load-tested, or fully integration-tested.

The Phase 5 implementation adds:

- A Redis connection shared by each bot shard process.
- A per-guild distributed voice-session lease.
- Redis snapshots of the **upcoming queue** so it can be recovered after a process restart.
- A Discord.js `ShardingManager` production entry point.
- Redis-backed fixed-window command, button, and dashboard API rate limiting.
- Structured JSON logs.
- Liveness, readiness, and optional Prometheus text metrics endpoints.
- Updated Docker Compose services for PostgreSQL, Redis, and the bot.
- Graceful shutdown that saves upcoming queues and releases leases where possible.

**Known Phase 5 boundary:** the dashboard HTTP server is started by shard 0 only. The current dashboard uses that shard's local Discord guild cache and local voice-player map. Consequently, the dashboard can currently manage only servers held by shard 0. A cross-shard dashboard gateway (for example, a Redis command bus or authenticated internal API to the owning shard) is still required before the dashboard can manage every server in a multi-shard deployment.

**Another boundary:** this is a sharded bot process, not a separately deployed pool of audio-rendering/voice-worker machines. Discord assigns each guild to one shard; that shard owns that guild's Discord events and local voice connection. Redis leases prevent two cooperating processes from simultaneously claiming the same guild player, but they do not move an active Discord voice connection between machines.

A review pass (see [Review fixes](#24-review-fixes-after-the-phase-5-audit)) corrected several defects found by reading every source file against this guide. The source was syntax/transpile-checked in this workspace. A full npm install and dependency-based TypeScript build could not be completed here because the package registry install timed out. See [Testing and validation](#20-testing-and-validation) for the exact status.

---

# 1. What this product is

The bot is a multi-server Discord music application with two different kinds of music intelligence:

1. **Server AI DJ:** the server's moderators set a music mood or enable automatic mood inference. The recommender ranks tracks from that server's approved catalogue.
2. **Personal AI assistant:** each member can independently opt into a private taste profile. Their plays and explicit likes/dislikes influence their future recommendations. Listening-history collection is off by default.

The product also includes personal playlists, a server-level moderator role, server-owner playlist entitlements, voice playback controls, a web dashboard, and Phase 5 operational services.

## Product goals

- Make ordinary playback easy for members.
- Keep each user's playlists private and separate from other members' playlists.
- Give server owners a way to grant selected members one additional playlist slot.
- Let server moderators control shared voice playback and the server mood.
- Recommend music from metadata rather than returning arbitrary or unverified audio URLs.
- Keep personal recommendation data opt-in and server-scoped.
- Support multiple Discord gateway shards and share coordination state through Redis.
- Make failures visible through logs, health endpoints, metrics, and restart policies.

## What the bot is not

- It is not a tool for extracting audio from YouTube, YouTube Music, Spotify, Gaana, or another consumer website.
- It does not automatically possess rights to rebroadcast a song into a Discord voice channel.
- It does not listen to voice-channel conversations, detect emotions in members' voices, or record microphone audio.
- Its existing AI DJ is primarily a metadata-based recommendation engine. It is not a trained music-understanding model.
- It is not yet a fully distributed cross-region, multi-host voice-worker platform.

---

# 2. Features by phase

## Phase 1 — Playback and playlist foundation

- Discord application and slash-command handling.
- Join the command user's voice channel.
- Queue and play approved direct HTTPS audio streams.
- Pause, resume, skip, stop, leave, volume, repeat, queue, and now-playing controls.
- Interactive Discord message controls.
- Per-user, per-server playlists.
- Default two-playlist quota.
- PostgreSQL persistence for playlists and their tracks.
- Initial Discord OAuth dashboard.

## Phase 2 — Server permissions and moderation

- Server owner can grant a chosen user a three-playlist maximum.
- Server owner can revoke that entitlement.
- Other users retain the two-playlist maximum.
- Moderator role can be configured for music controls.
- Owner, administrators, Manage Server users, and the configured music moderator role have the relevant administrative rights according to command-specific checks.
- Server audit records for permission changes.
- Dashboard controls for server settings and playlist entitlements.

A grant affects the maximum number of playlists a user may create. Revoking a grant does not automatically delete the member's existing third playlist. The user can still manage existing playlists, but must be below the normal quota before creating another.

## Phase 3 — Server AI DJ

- Seven supported moods: `chill`, `party`, `gaming`, `focus`, `romantic`, `sad`, `nostalgic`.
- Manual mood selection.
- Automatic mood mode inferred from recent catalogue metadata.
- Metadata-aware AI shuffle.
- Genre, BPM, energy, language, mood-tag, and artist-diversity scoring.
- Recent-play exclusion when enough eligible catalogue items remain.
- Per-server approved music catalogue.
- Catalogue search and moderator-only add/remove operations.

The auto-mood system uses catalogue play history and track metadata; it does not analyse voice conversation or member microphones.

## Phase 4 — Personal AI music assistant

- Listening-history collection is disabled by default.
- Each member controls their own consent separately in each server.
- Record the user who requested a track when it starts playing, if that member has opted in.
- Explicit like and dislike feedback.
- Personal profile with favourite genres, artists, and moods.
- Personal recent-history view.
- `/for-me` personal recommendation command.
- `/ask-music` natural-language request command.
- `/taste opt-out` stops future collection.
- `/taste forget` deletes the member's saved music events for that server and turns collection off.
- Optional OpenAI-compatible request parser. A built-in parser is available when no external AI endpoint is configured.

The user who opted in can view their personal information through the private Discord responses and personal dashboard. Other voice-channel listeners are not automatically recorded.

## Phase 5 — Public operations and scaling foundation

- Redis coordination client.
- One active voice-session lease per guild.
- Lease renewal every 20 seconds with a 60-second expiry.
- Durable upcoming-queue snapshot with a seven-day expiry.
- Automatic Discord sharding through `ShardingManager` in production mode.
- A process per shard, each handling the guilds assigned to that shard.
- Discord command rate limit by guild, user, and command.
- Global Discord command rate limit by guild and user.
- Music button rate limit.
- Dashboard API rate limit.
- JSON structured logs.
- `/health/live`, `/health`, and `/health/ready` endpoints.
- Optional authenticated `/metrics` endpoint.
- Docker Compose Redis service with persistence and health check.
- Docker health check for dashboard readiness.
- Graceful shutdown and queue snapshot preservation.

---

# 3. Architecture overview

```mermaid
flowchart TD
    U[Discord member or moderator] --> D[Discord Gateway]
    D --> SM[ShardingManager]
    SM --> S0[Shard process 0]
    SM --> S1[Shard process 1]
    SM --> SN[Other shard processes]
    S0 --> C0[Discord.js Client]
    S1 --> C1[Discord.js Client]
    SN --> CN[Discord.js Client]
    C0 --> B0[Command and permission layer]
    C1 --> B1[Command and permission layer]
    CN --> BN[Command and permission layer]
    B0 --> P0[Local guild voice player]
    B1 --> P1[Local guild voice player]
    BN --> PN[Local guild voice player]
    P0 --> V0[Discord voice connection]
    P1 --> V1[Discord voice connection]
    PN --> VN[Discord voice connection]
    B0 --> R[(Redis)]
    B1 --> R
    BN --> R
    B0 --> PG[(PostgreSQL)]
    B1 --> PG
    BN --> PG
    S0 --> WEB[Express dashboard on shard 0]
    WEB --> PG
    WEB --> R
```

## Responsibilities of each layer

| Layer | Responsibility | Main implementation |
|---|---|---|
| Discord gateway | Receives guild, interaction, and voice-state events | `discord.js` |
| Shard manager | Creates and supervises shard processes | `ShardingManager` in `src/index.ts` |
| Shard worker | Creates a Discord client and attaches handlers | `src/worker.ts`, `src/worker-runtime.ts` |
| Command layer | Validates command inputs and chooses the operation | `src/bot.ts`, `src/commands.ts` |
| Permission layer | Checks owner/admin/Manage Server/moderator rights | Helpers in `src/bot.ts` and service rules |
| Voice player | Manages one process-local player and queue per guild | `src/player.ts` |
| Audio source | Validates and opens an approved HTTPS stream; runs FFmpeg | `src/audio-source.ts` |
| Redis coordination | Session lease, queue snapshot, fixed-window limits | `src/redis.ts`, `src/queue-store.ts`, `src/rate-limit.ts` |
| Persistent application data | Playlists, catalogue, history, server settings, audit events | `src/db.ts` and service modules |
| Web control panel | OAuth, server settings, profile views, player controls | `src/dashboard.ts` |
| Operational visibility | JSON logs, health responses, metrics | `src/logger.ts`, `src/metrics.ts` |

## Single-guild playback lifecycle

1. A member joins a Discord voice channel.
2. The member uses `/play` or a recommendation command.
3. The bot validates that the member is in a voice channel and that the requested source is permitted.
4. If the guild has no local player, the owning shard requests a Redis lease for that guild.
5. The lease is granted only if no other process currently owns it.
6. The bot joins the voice channel and waits for the voice connection to become ready.
7. If a previous upcoming queue snapshot exists, the bot loads it and re-validates each restored URL.
8. The requested track is added and the upcoming queue is written back to Redis.
9. FFmpeg converts the authorized audio response to the raw PCM stream expected by the Discord voice player.
10. The player advances through the local queue, updating the Redis upcoming-queue snapshot after transitions.
11. A lease-renewal timer refreshes the guild lease while the voice session exists.
12. When the player disconnects or the process shuts down, the lease is released where possible.

---

# 4. Technology and packages used

This section lists the actual technology choices in the repository and what each one does. Versions are managed in `package.json`; use the lockfile generated by your own successful install/release process to freeze exact dependency versions.

## Runtime and language

| Technology | Why it is used |
|---|---|
| Node.js 22.12+ | JavaScript runtime for bot, HTTP dashboard, workers, database and Redis clients |
| TypeScript 5.9 series | Static typing, interfaces, safer refactoring, strict compiler checks |
| ECMAScript modules | Project uses `"type": "module"` and `.js` import specifiers in TypeScript source |

## Discord and audio packages

| Package | Role |
|---|---|
| `discord.js` | Discord gateway connection, slash commands, buttons, embeds, permissions, REST command registration, sharding manager |
| `@discordjs/voice` | Join voice channels, create audio players/resources, handle voice connection states |
| `@discordjs/opus` | Opus codec support for the voice audio stack |
| `ffmpeg-static` | Supplies an FFmpeg executable packaged as a dependency |

## Application server and security packages

| Package | Role |
|---|---|
| `express` | Serves the dashboard and JSON API |
| `express-session` | Cookie-backed dashboard sessions |
| `connect-pg-simple` | Stores dashboard sessions in PostgreSQL instead of process memory |
| `zod` | Validates environment variables at process startup |
| `dotenv` | Loads `.env` variables for local development |

## Data packages

| Package | Role |
|---|---|
| `pg` | PostgreSQL connection pool and SQL queries |
| `redis` | Official Node.js Redis client used for leases, queue snapshots, and rate limits |

## Development packages

| Package | Role |
|---|---|
| `typescript` | Compiler and type checker |
| `tsx` | Runs TypeScript directly during development and watch mode |
| `@types/node` | Node.js type definitions |
| `@types/express` | Express type definitions |
| `@types/express-session` | Session type definitions |
| `@types/connect-pg-simple` | PostgreSQL session-store type definitions |
| `@types/pg` | PostgreSQL type definitions |

## Infrastructure software

| Service | Role |
|---|---|
| PostgreSQL 17 | Durable relational application data |
| Redis 7 | Shared operational state, coordination and rate-limit counters |
| Docker | Container image for the TypeScript application |
| Docker Compose | Local/test composition of PostgreSQL, Redis and bot services |
| FFmpeg | Runtime audio transcoding from supported source streams to Discord voice PCM |

## What was not used

- No React, Next.js, Vue, Angular, or other frontend framework. The dashboard is server-served HTML/CSS/vanilla JavaScript inside `src/dashboard.ts`.
- No Prisma, TypeORM, Drizzle, or other ORM. SQL is issued through `pg` with parameterized queries.
- No Kafka, RabbitMQ, or Kubernetes. They are not required for this first sharding/Redis layer.
- No audio scraping library for consumer streaming sites.
- No machine-learning training pipeline. The recommendation system ranks tagged catalogue metadata.
- No separate managed audio-worker service. Voice sessions are local to the Discord shard process that owns the guild.

---

# 5. Repository and source-file map

The important project structure is:

```text
discord-ai-music-bot/
├── src/
│   ├── index.ts
│   ├── worker.ts
│   ├── worker-runtime.ts
│   ├── bot.ts
│   ├── commands.ts
│   ├── register-commands.ts
│   ├── player.ts
│   ├── audio-source.ts
│   ├── queue-store.ts
│   ├── redis.ts
│   ├── rate-limit.ts
│   ├── logger.ts
│   ├── metrics.ts
│   ├── db.ts
│   ├── config.ts
│   ├── playlist-service.ts
│   ├── server-settings-service.ts
│   ├── dj-service.ts
│   ├── dj-types.ts
│   ├── recommendation.ts
│   ├── personal-music-service.ts
│   ├── taste-recommendation.ts
│   └── dashboard.ts
├── test/
│   ├── recommendation.test.mjs
│   ├── taste-recommendation.test.mjs
│   └── metrics.test.mjs
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── BLUEPRINT.md
└── PHASE5_COMPLETE_TECHNICAL_GUIDE.md
```

## File-by-file responsibilities

### Process and Discord files

- **`src/index.ts`** — production entry point. In production with sharding enabled, it creates the Discord.js `ShardingManager`, selects `SHARD_COUNT` or Discord's automatic count, spawns shard processes, logs shard lifecycle events, and disables respawn during manager shutdown. In non-production development mode, it starts one worker directly.
- **`src/worker.ts`** — the entry point executed by each shard process. It installs fatal/unhandled-error logging and starts the worker runtime.
- **`src/worker-runtime.ts`** — creates the Discord client, initializes Redis and PostgreSQL, registers interaction handlers, starts the HTTP dashboard only on shard 0, and performs graceful worker shutdown.
- **`src/bot.ts`** — routes slash command and button interactions to the appropriate services. It contains voice-context checks and server/moderator permission checks.
- **`src/commands.ts`** — defines the slash-command JSON schema sent to Discord. A command definition must be registered after adding or changing slash commands.
- **`src/register-commands.ts`** — uploads the slash command list to the selected development guild or globally using Discord's REST API.

### Music and audio files

- **`src/player.ts`** — keeps process-local `GuildPlayer` sessions. It handles join, enqueue, play-next, pause, resume, skip, stop, volume, repeat, queue clearing and disconnect. It now uses Redis leases and upcoming-queue snapshots.
- **`src/audio-source.ts`** — describes a `Track`, validates HTTPS host allow-lists, rejects URL credentials, rejects private IP destinations, blocks redirects, checks the response content type, and starts FFmpeg to produce a Discord-compatible raw PCM stream.
- **`src/queue-store.ts`** — owns the Redis lease scripts and queue serialization/restoration functions.

### AI and catalogue files

- **`src/dj-types.ts`** — shared mood, DJ mode, and catalogue candidate types.
- **`src/recommendation.ts`** — metadata mood-scoring and server AI-shuffle selection logic.
- **`src/dj-service.ts`** — PostgreSQL catalogue CRUD, effective mood status, server mode, recent catalogue play history and recommendation orchestration.
- **`src/taste-recommendation.ts`** — builds taste profiles from play/like/dislike events and scores candidates for individual taste or parsed user requests.
- **`src/personal-music-service.ts`** — stores consent, records opted-in personal events, returns personal profile/history, applies feedback, deletes personal data, and optionally calls an OpenAI-compatible parser for request interpretation.

### Database and permissions files

- **`src/db.ts`** — PostgreSQL pool and schema initialization statements. Pool size is configurable per shard worker.
- **`src/playlist-service.ts`** — playlist operations and transactional playlist quota checks. PostgreSQL advisory transaction locks prevent racing create/grant/revoke changes.
- **`src/server-settings-service.ts`** — moderator role settings and server audit events.
- **`src/config.ts`** — environment parsing and validation through Zod.

### Phase 5 operations files

- **`src/redis.ts`** — node-redis client, connect/reconnect lifecycle, ping, and shutdown.
- **`src/rate-limit.ts`** — atomic Redis fixed-window counter and per-command policies.
- **`src/logger.ts`** — JSON-formatted application event logs with timestamp, severity, service, shard ID and structured fields.
- **`src/metrics.ts`** — in-process counters and Prometheus text output.
- **`src/dashboard.ts`** — Express OAuth callback, session handling, dashboard pages, member and management APIs, CSRF checks, API rate limiter, health and metrics routes.

---

# 6. Discord setup and permissions

## Create the Discord application

1. Open the Discord Developer Portal.
2. Create an application for the bot.
3. Add a Bot user and copy the bot token into `DISCORD_TOKEN`.
4. Copy the application ID into `DISCORD_CLIENT_ID`.
5. If using the web dashboard, add an OAuth2 redirect URI that exactly matches `DASHBOARD_CALLBACK_URL`.
6. Copy the OAuth2 client secret into `DISCORD_CLIENT_SECRET`.
7. Keep the token and client secret private. Never put them in source code, screenshots, public repositories, or logs.

## Required gateway intents

The application requests:

- `Guilds`
- `GuildVoiceStates`

It does not request privileged Message Content or Presence intents for this command-based design.

## Bot permission planning

When generating an install URL, grant only the permissions the bot needs for the channels where it operates. At minimum, voice playback requires access to view/join the relevant voice channel and speak. Text control messages require channel visibility and sending messages; embeds and interactive controls require their corresponding channel permissions. Manage Server is not a bot permission requirement for every member; the bot checks the interacting user's actual Discord permissions for privileged settings.

Do not grant Administrator to the bot just to make setup easier.

## Development guild registration

Set `DISCORD_DEV_GUILD_ID` to a test server ID before running `npm run register`. Guild commands normally become available faster for development iteration.

For global registration, leave `DISCORD_DEV_GUILD_ID` blank. Global propagation may not be immediate.

---

# 7. Command reference

The slash command definitions live in `src/commands.ts`. All listed commands are server-oriented unless otherwise noted.

## Playback commands

| Command | Who can use it | Purpose |
|---|---|---|
| `/play url:<https-url>` | Member in voice | Queue an approved direct audio stream |
| `/play catalogue_id:<id>` | Member in voice | Queue a track already in this server's catalogue |
| `/pause` | Owner/admin/Manage Server/configured music moderator | Pause active playback |
| `/resume` | Same moderator set | Resume playback |
| `/skip` | Same moderator set | Skip current track |
| `/stop` | Same moderator set | Stop playback and empty the queue |
| `/leave` | Same moderator set | Disconnect the bot from voice |
| `/queue` | Server member | Display the current and upcoming tracks |
| `/nowplaying` | Server member | Display the current music panel |
| `/volume percent:<0-100>` | Moderator | Set volume |
| `/repeat mode:<off|track|queue>` | Moderator | Set repeat behavior |

## Playlist commands

| Command | Purpose |
|---|---|
| `/playlist create name:<name>` | Create a personal playlist if under the quota |
| `/playlist list` | List the current member's playlists and quota |
| `/playlist add playlist:<name> url:<url> title:<optional>` | Add an approved stream reference |
| `/playlist remove playlist:<name> position:<n>` | Remove a track by list position |
| `/playlist view name:<name>` | View a playlist |
| `/playlist play name:<name>` | Queue all tracks from a playlist |
| `/playlist delete name:<name>` | Delete one of the member's playlists |
| `/playlist rename name:<old> new_name:<new>` | Rename a playlist |
| `/playlist grant member:@user` | Actual server owner grants the three-playlist cap |
| `/playlist revoke member:@user` | Actual server owner returns the cap to two |

Default quota is two playlists per member per server. A granted member has a maximum of three. A playlist can have at most 500 tracks.

## Moderator configuration

| Command | Purpose |
|---|---|
| `/music-admin set-mod-role role:@Role` | Assign the role permitted to moderate playback |
| `/music-admin clear-mod-role` | Remove the configured role |
| `/music-admin settings` | Display music settings |
| `/music-admin clear-queue` | Clear upcoming tracks while leaving the current track playing |

## AI DJ and catalogue commands

| Command | Purpose |
|---|---|
| `/mood set mood:<mood>` | Set a manual server mood |
| `/mood auto` | Infer mood from recent catalogue tracks |
| `/mood off` | Turn off server mood mode |
| `/mood status` | Inspect current effective mode/mood |
| `/ai-shuffle count:<1-10>` | Fill queue with varied mood-ranked catalogue tracks |
| `/catalog add ...` | Add a moderator-approved direct stream and metadata |
| `/catalog search query:<text>` | Search the server catalogue |
| `/catalog remove track_id:<id>` | Deactivate a catalogue entry |

Catalogue add supports title, artist, genre tags, mood tags, language, BPM and energy. Energy is accepted on a 0–100 command scale and normalized before storage.

## Personal AI commands

| Command | Purpose |
|---|---|
| `/taste opt-in` | Enable personal music history for this server |
| `/taste opt-out` | Stop future history collection |
| `/taste profile` | View the member's taste profile privately |
| `/taste history` | View recent tracks the member requested |
| `/taste feedback sentiment:<like|dislike>` | Rate the current track |
| `/taste forget` | Delete personal music events for this server and turn history off |
| `/for-me count:<1-10>` | Queue personal recommendations |
| `/ask-music request:<text> count:<1-5>` | Parse a natural-language request and queue matching catalogue items |

---

# 8. Audio and music-source system

## Supported playback input in this code

The implemented source adapter accepts **direct HTTPS audio stream URLs** whose hostnames are included in `AUDIO_ALLOWED_HOSTS`.

For example, if the operator controls a lawful stream endpoint at `audio.example.net`, the configured allow-list can include that exact hostname:

```env
AUDIO_ALLOWED_HOSTS=audio.example.net
```

The URL must return an audio content type (`audio/*`) or `application/octet-stream`. The adapter rejects redirects, URL usernames/passwords, non-HTTPS schemes, unapproved hosts, and DNS results that resolve to private/reserved IP space. The address check runs inside the connection's own DNS lookup (`guardedLookup` in `src/audio-source.ts`, rules in `src/network-guard.ts`), so the address that is validated is the address that is connected to; this closes the DNS-rebinding gap of resolving once and letting the HTTP client resolve again. IPv4-mapped and NAT64 IPv6 forms of private addresses are also blocked. A stream that stalls for 15 seconds is dropped.

## Why page URLs are not treated as streams

A Spotify track page or a YouTube watch page is not the same thing as a licensed direct audio stream. The bot does not scrape or rip platform audio. To add a provider integration, the developer must confirm that the provider's API terms, product policy, music licence, territory, and broadcast permissions allow the exact intended behavior. A provider may allow metadata lookup but not audio extraction or rebroadcast.

A provider adapter should be introduced as a separate module that:

1. Accepts and validates the provider's URL format.
2. Uses the provider's official API or a licensed partner interface.
3. Resolves metadata and a permitted playback reference.
4. Checks the specific server's/owner's authorization to use the source.
5. Returns a `Track` only when playback is genuinely allowed.
6. Handles token renewal, rate limits, regional availability and expired links.

Do not add a consumer website hostname to `AUDIO_ALLOWED_HOSTS` as a bypass for its restrictions.

## Audio conversion path

```text
HTTPS audio response
      |
      v
URL and host allow-list validation
      |
      v
DNS private-address validation
      |
      v
Fetch stream without following redirects
      |
      v
Content-Type validation
      |
      v
FFmpeg input pipe
      |
      v
48 kHz, stereo, signed 16-bit PCM output
      |
      v
@discordjs/voice AudioResource
      |
      v
Discord voice connection
```

FFmpeg is spawned as a child process. The player kills the child process when the track ends, is skipped, or the session is destroyed.

---

# 9. Database design

PostgreSQL is the durable source of truth for member playlists, server settings, catalogue metadata, and user music history. The schema is initialized in `src/db.ts` using `CREATE TABLE IF NOT EXISTS` statements.

## Main tables

| Table | Purpose | Important relationship or field |
|---|---|---|
| `playlists` | Personal playlists | `guild_id`, `owner_id`, unique member/server/name |
| `playlist_tracks` | Items in each playlist | Foreign key to `playlists`, cascade delete |
| `playlist_limits` | Three-playlist entitlement | Composite key of `guild_id` and `user_id` |
| `server_settings` | Per-server settings | `moderator_role_id` |
| `server_audit_log` | Server-level configuration change history | Actor, action, target, JSON details |
| `music_catalogue_tracks` | Server's approved playable catalogue | Source URL, tags, language, BPM, energy, active flag |
| `guild_dj_settings` | Current server DJ mode | Mood or auto flag |
| `guild_track_history` | Recent catalogue playback history | Used by server AI DJ auto-mood/repeat avoidance |
| `user_music_preferences` | User consent per server | `history_enabled` defaults to false |
| `user_track_events` | User plays, likes, dislikes | User + guild + event type + copied metadata |

## Quota concurrency handling

Playlist creation and entitlement grant/revoke operations use a PostgreSQL transaction and an advisory transaction lock keyed by the server and user. This serializes concurrent operations for the same member without blocking unrelated members. The quota check and insert happen inside the same transaction.

## Schema initialization note

The current project uses idempotent table/index creation on startup. It does not yet use a versioned migration framework such as node-pg-migrate, Knex migrations, Prisma Migrate, or Flyway. For a long-lived public production deployment, convert the schema into ordered, reviewed migration files and run them as a controlled deployment step rather than relying only on application-startup DDL.

---

# 10. Redis design added in Phase 5

Redis is required by the Phase 5 runtime. The service starts Redis before starting the bot workers. Every shard process creates its own Redis client connection.

## Redis key layout

| Key | Data | Expiration |
|---|---|---|
| `music:lease:<guildId>` | Random lease token identifying the current guild voice-session owner | 60 seconds; renewed while session is active |
| `music:queue:<guildId>` | JSON array of upcoming `Track` objects | 7 days |
| `ratelimit:command-global:<guildId>:<userId>` | Global per-user command counter | Fixed 10-second window |
| `ratelimit:command:<guildId>:<userId>:<command>` | Per-command counter | Fixed 10-second window |
| `ratelimit:music-button:<guildId>:<userId>` | Button interaction counter | Fixed 10-second window |
| `ratelimit:dashboard-api:<userId-or-ip>` | Dashboard API request counter | Configured window, 60 seconds by default |

## Distributed guild lease

When a shard creates a player session, it generates a random UUID token and tries to create the guild lease using Redis `SET key token NX PX 60000`.

- `NX` means Redis only creates the key when it does not already exist.
- `PX 60000` gives the lease a 60-second lifetime.
- The process renews the lease every 20 seconds.
- Renewal only succeeds if the token stored in Redis still matches that process's token.
- Release only deletes the key if the stored token matches the releasing process's token.

The compare-token logic is implemented as Lua scripts so the read-and-update operation is atomic in Redis. This avoids a stale process accidentally deleting a lease owned by a newer process.

If the process loses the lease or cannot renew it due to a Redis error, it destroys its local voice session and preserves the upcoming queue snapshot. This is a fail-closed safety behavior: it prefers disconnecting over risking two processes controlling the same guild voice session.

## Upcoming queue recovery

The bot saves the queue array after enqueue and queue transitions. On a new session it reads the saved array, checks each item, re-validates its stream URL against the current allow-list, restores valid pending tracks, and then appends the new request.

Important details:

- The currently playing track is **not** checkpointed.
- The bot does not save FFmpeg process state or current playback position.
- A crashed shard cannot keep the old Discord voice connection alive.
- Records read back from Redis are treated as untrusted: `src/queue-sanitize.ts` drops unknown fields and out-of-range values, and a snapshot is never overwritten until it has been loaded (a failed voice join cannot erase a saved queue).
- A restarted shard does not autonomously rejoin a voice channel from the snapshot. The next playback request creates a session and triggers queue restoration.
- A crashed worker's lease can remain until Redis expires it (up to 60 seconds), so an immediate retry may receive a temporary "another worker owns the session" response.
- A signed stream URL may expire during the seven-day queue TTL. The source adapter validates the host, but the provider may still reject an expired link when FFmpeg opens it.

This is queue recovery, not seamless continuous playback failover.

## Redis availability policy

Redis must be reachable for:

- Guild voice-session lease acquisition/renewal.
- Queue snapshot reads/writes.
- Rate-limit counter operations.

Rate-limited command paths fail closed if Redis is unavailable. The readiness route returns `503` if Redis cannot be pinged. This makes the operational dependency visible rather than silently running without distributed coordination.

---

# 11. Rate limiting and abuse prevention

The limits are enforced server-side with Redis counters, so they are shared between cooperating shard processes that use the same Redis database.

## Discord command limits

The implementation checks both:

1. A global counter for the member in the guild.
2. A per-command counter for that member, guild, and command name.

| Command category | Per-command cap | Window |
|---|---:|---:|
| Expensive request commands (`play`, `ai-shuffle`, `for-me`, `ask-music`) | 5 | 10 seconds |
| Administrative commands (`music-admin`, `mood`, `catalog`) | 6 | 10 seconds |
| Other commands | 12 | 10 seconds |
| Global combined commands | 25 | 10 seconds |

## Button limits

Music control buttons are limited to eight interactions per user per guild per ten seconds.

## Dashboard API limits

Default: 60 API requests per user (or IP for anonymous access) per 60 seconds. Configure with:

```env
DASHBOARD_RATE_LIMIT_MAX=60
DASHBOARD_RATE_LIMIT_WINDOW_MS=60000
```

The `Retry-After` header is returned for rate-limited API requests.

## What this does not replace

Rate limiting does not replace Discord's own REST/gateway limits, anti-abuse review, provider quotas, account-level abuse handling, bot verification requirements, or a WAF at the public HTTP edge. Tune values based on real production traffic and abuse metrics.

---

# 12. Discord sharding and worker ownership

## What sharding does

Discord.js `ShardingManager` starts a separate process for each shard. Each child has its own Discord.js client and handles the guilds assigned to its shard. `SHARD_COUNT=auto` uses the shard count Discord recommends for the bot at the time it requests the count.

In this project:

- `src/index.ts` is the manager/launcher in production.
- `src/worker.ts` is the file started for each shard.
- `src/worker-runtime.ts` initializes shared services and the Discord client.
- The shard manager respawns a child after it exits unexpectedly.
- The manager disables respawn during a deliberate manager shutdown.

## How the development and production entry points differ

- `npm run dev` uses `tsx watch` and starts one direct worker to make local iteration simple.
- `npm run build` compiles `src/index.ts` and `src/worker.ts` into `dist/`.
- `npm start` runs `dist/index.js`. When `NODE_ENV=production` and `SHARDING_ENABLED=true`, this starts the `ShardingManager`.
- The container has `NODE_ENV=production`, so the Docker Compose bot service starts the manager.

## Important scaling boundary

This process manager is a single-host/process-tree sharding setup. To distribute shard IDs across multiple physical hosts or containers, an external deployment controller must assign non-overlapping shard IDs and the same total shard count across those hosts. Do not start multiple independent `ShardingManager` instances with automatic shard lists and the same bot token unless you have deliberately configured disjoint shard lists and a common total shard count.

## Dashboard boundary

Only shard 0 starts the Express dashboard listener, avoiding multiple workers trying to bind to the same port. The dashboard currently consults shard 0's local guild cache and voice-player map. It will not display or control guilds held only by shards 1+.

Required next improvement for a true public multi-shard dashboard:

1. Make a dedicated dashboard API service.
2. Validate a user's current guild membership and permissions.
3. Resolve the target guild's shard ID using the Discord.js shard utility or an equivalent mapping.
4. Send a signed, validated internal command to that owning shard through Redis Pub/Sub/Streams or a dedicated internal RPC channel.
5. Have the target shard re-check all permissions and action arguments before touching the local player.
6. Return a bounded response to the dashboard service.
7. Store shared player snapshots in Redis for read-only dashboard views, with a freshness timestamp.

The owner shard must always perform the final authorization check. Never rely only on dashboard visibility or a client-supplied guild ID.

---

# 13. Dashboard and HTTP security

## OAuth login

The dashboard uses Discord OAuth2 with `identify` and `guilds` scopes. It stores the OAuth user profile, a filtered list of managed guilds, a filtered list of mutual guilds, and a CSRF token in the server-side session.

The OAuth login flow uses a random state value and checks the callback state before exchanging the authorization code. Sessions are stored in PostgreSQL through `connect-pg-simple`.

## Session and browser protections

- HTTP-only session cookie.
- `SameSite=Lax`.
- Secure cookie when `DASHBOARD_URL` starts with HTTPS.
- Seven-day cookie maximum age.
- Session regeneration after successful OAuth login.
- CSRF token on dashboard POST requests.
- Constant-time comparison for CSRF tokens and metrics token.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- Restrictive `Permissions-Policy`.
- JSON request body limit of 10 KB.
- Dashboard API rate limiting.

## Production deployment requirements

- Put the dashboard behind HTTPS (for example, Caddy, Nginx, or a managed HTTPS load balancer).
- Set `DASHBOARD_URL` and `DASHBOARD_CALLBACK_URL` to their real HTTPS URLs.
- Set a high-entropy `SESSION_SECRET` with at least 32 characters.
- Restrict inbound access to PostgreSQL and Redis. The Compose example only publishes their ports on loopback for local administration.
- Use Redis authentication/ACL and TLS if connecting to a managed or remote Redis service.
- Use PostgreSQL TLS if the managed database requires it (`DATABASE_SSL=true`).
- Keep `.env` out of version control and use a deployment secret manager for production secrets.
- Rotate Discord bot tokens, OAuth secrets, database passwords, Redis passwords, and metrics tokens if they are exposed.

---

# 14. Observability: logs, health and metrics

## Structured logs

The logger writes one JSON object per event with:

- `timestamp`
- `level`
- `service`
- `shardId`
- `event`
- additional structured context

Example (illustrative):

```json
{
  "timestamp": "2026-11-18T08:00:00.000Z",
  "level": "info",
  "service": "discord-ai-music-bot",
  "shardId": "0",
  "event": "discord_client_ready",
  "guildCountOnShard": 120
}
```

Do not log full stream URLs if they contain signed query tokens. The current queue persistence stores complete approved source URLs in Redis; Redis must therefore be treated as a secret-bearing service and access-controlled accordingly.

## Health endpoints

| Endpoint | Meaning | Expected behavior |
|---|---|---|
| `GET /health/live` | HTTP process is alive | `200` while Express can respond |
| `GET /health` | Basic liveness alias | `200` while Express can respond |
| `GET /health/ready` | PostgreSQL, Redis and Discord client readiness | `200` only when dependencies are ready; otherwise `503` |

The Compose bot health check uses `/health/ready`.

## Prometheus metrics

`GET /metrics` is disabled and returns `404` unless `METRICS_TOKEN` has a non-empty value. When enabled, send:

```http
Authorization: Bearer YOUR_METRICS_TOKEN
```

The endpoint reports local process uptime, shard guild count, active local voice-session count, and counters such as Discord commands, dashboard API requests, and rate-limit rejections.

Counters are in process memory and are not aggregated across shards. The next monitoring improvement is to export counters to a shared metrics backend or scrape each shard's own metrics endpoint through an authenticated metrics sidecar/collector.

---

# 15. Environment variables

Copy `.env.example` to `.env` and set the values for the environment in which the process runs.

| Variable | Required? | Default / example | Meaning |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes | — | Bot token. Secret. |
| `DISCORD_CLIENT_ID` | Yes | — | Discord application ID. |
| `DISCORD_CLIENT_SECRET` | Dashboard OAuth | Empty | OAuth client secret; enables OAuth login when set. Secret. |
| `DISCORD_DEV_GUILD_ID` | No | Empty | If set, register commands to this development guild; otherwise global. |
| `DATABASE_URL` | Yes | `postgres://musicbot:...@localhost:5432/musicbot` | PostgreSQL connection URL. |
| `POSTGRES_PASSWORD` | Compose | Strong random password | Compose variable for the local PostgreSQL container; not read by application config. |
| `DATABASE_SSL` | No | `false` | Set `true` for PostgreSQL TLS with certificate verification. |
| `DB_POOL_MAX` | No | `6` | Maximum PostgreSQL connections per worker process. |
| `REDIS_URL` | Yes for Phase 5 | `redis://localhost:6379` | Redis connection URL. Use `rediss://` for TLS-capable remote Redis. |
| `SHARDING_ENABLED` | No | `true` | Production switch for manager-based sharding. |
| `SHARD_COUNT` | No | `auto` | `auto` or a positive explicit shard count up to 1000. |
| `DASHBOARD_URL` | No | `http://localhost:3000` | Public dashboard base URL. |
| `DASHBOARD_CALLBACK_URL` | No | `http://localhost:3000/auth/callback` | Exact Discord OAuth callback URL. |
| `SESSION_SECRET` | Yes | Generate your own | Server-side cookie signing secret; at least 32 characters. Secret. |
| `PORT` | No | `3000` | Express listening port. |
| `AUDIO_ALLOWED_HOSTS` | Audio required | Empty | Comma-separated exact hostnames that the operator is authorized to stream. |
| `MAX_QUEUE_SIZE` | No | `100` | Maximum number of pending tracks in one guild queue. |
| `DEFAULT_VOLUME` | No | `70` | Default player volume from 0–100. |
| `AI_API_BASE_URL` | No | Empty | Optional OpenAI-compatible API base URL for request interpretation. |
| `AI_API_KEY` | No | Empty | Optional external AI API key. Secret. |
| `AI_MODEL` | No | `gpt-4o-mini` | Model identifier understood by the configured compatible provider. |
| `DASHBOARD_RATE_LIMIT_MAX` | No | `60` | Requests per user/IP per configured window. |
| `DASHBOARD_RATE_LIMIT_WINDOW_MS` | No | `60000` | Dashboard API window duration in milliseconds. |
| `METRICS_TOKEN` | No | Empty | If set, enables authenticated `/metrics`. Secret. |

### Secrets generation

Generate a high-entropy session secret with a password manager or a cryptographic random generator. For example, on a machine with OpenSSL:

```bash
openssl rand -hex 32
```

Do not use the example placeholder values in a public deployment.

---

# 16. Local development setup

## Requirements

- Node.js `>=22.12.0`.
- npm compatible with the installed Node.js version.
- Docker and Docker Compose (for local PostgreSQL and Redis).
- A Discord application and test server.
- A permitted direct audio stream URL hosted on an allow-listed hostname if you want to test playback.

## Step-by-step

### Step 1 — Extract and open the project

Extract the project ZIP and open the `discord-ai-music-bot` directory in VS Code or another editor.

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Create the local environment file

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill in the Discord token, application ID, callback values, PostgreSQL password, and session secret.

For a local `npm run dev` process, use these service URLs:

```env
DATABASE_URL=postgres://musicbot:YOUR_PASSWORD@localhost:5432/musicbot
REDIS_URL=redis://localhost:6379
SHARDING_ENABLED=true
```

`npm run dev` intentionally starts one direct worker rather than spawning production shards.

### Step 4 — Start PostgreSQL and Redis

```bash
docker compose up -d postgres redis
```

### Step 5 — Register Discord commands

Set `DISCORD_DEV_GUILD_ID`, then run:

```bash
npm run register
```

### Step 6 — Start the development bot

```bash
npm run dev
```

### Step 7 — Check the dashboard

Open `http://localhost:3000`. Sign in with Discord using the OAuth application you configured.

### Step 8 — Run project checks

```bash
npm run typecheck
npm run build
npm test
```

`npm test` compiles the project first, then runs the unit tests in `test/`.

---

# 17. Docker deployment

## Local container deployment

1. Ensure `.env` exists and contains real credentials.
2. Set `POSTGRES_PASSWORD` in `.env` to a strong random value.
3. Set `DASHBOARD_URL` and `DASHBOARD_CALLBACK_URL` correctly.
4. Set `SESSION_SECRET` to a cryptographically random value.
5. Set `AUDIO_ALLOWED_HOSTS` to only authorized audio hosts.
6. Run:

```bash
docker compose --profile app up --build -d
```

Check the services:

```bash
docker compose ps
docker compose logs -f bot
docker compose logs -f redis
docker compose logs -f postgres
```

Open the dashboard through a trusted HTTPS reverse proxy in a production deployment. The Compose example binds local PostgreSQL, Redis and dashboard ports to loopback for host access; do not expose database/Redis ports publicly.

## Container behavior

- PostgreSQL uses a named persistent volume.
- Redis uses AOF plus periodic RDB snapshots and a named volume.
- The bot waits for PostgreSQL and Redis health checks before starting.
- `NODE_ENV=production` and `SHARDING_ENABLED=true` activate the shard manager.
- Docker restarts the bot container if the top-level process exits.
- The shard manager respawns an individual shard if that child exits unexpectedly.
- Container readiness checks the HTTP `/health/ready` route.

## Updating the bot

```bash
git pull
# or replace the project files with the new release

docker compose --profile app up --build -d
```

After any slash-command schema change, register commands as a controlled deployment step:

```bash
npm run register
```

If you build only inside Docker, execute command registration using a separate one-off container or from a trusted deployment machine with the same `.env` values.

---

# 18. Backups and data retention

## PostgreSQL

Back up PostgreSQL regularly. For example, from a host with `pg_dump` and network access to the database:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=musicbot-$(date +%F).dump
```

Restore with:

```bash
pg_restore --clean --if-exists --dbname="$DATABASE_URL" musicbot-YYYY-MM-DD.dump
```

Use an encrypted, access-controlled backup destination and test restores. Backups contain member IDs, playlists, server configuration, audit records, and opt-in personal music events.

## Redis

Redis uses AOF and RDB persistence in Compose, but Redis is operational state, not the permanent source of truth for playlists or member profiles. Back up Redis if operational queue continuity matters. A Redis snapshot may contain upcoming tracks and full stream URLs; treat it as sensitive.

## User deletion and history consent

- History starts off.
- Opting out stops future capture but retains existing user events.
- Forget deletes the user's `user_track_events` for that server and disables consent.
- Server owners should not be able to read another user's private personal taste history through the bot's normal commands.
- A production service should publish its data retention period and backup deletion schedule. Deleting live rows does not immediately remove copies from retained database backups; backup retention must be described honestly in the service privacy notice.

---

# 19. Troubleshooting and runbook

## Bot does not log in

- Check `DISCORD_TOKEN`.
- Confirm the token has not been reset.
- Ensure the bot application and token belong to the same application.
- Inspect shard-manager and shard logs.

## Slash commands do not appear

- Run `npm run register`.
- Check `DISCORD_CLIENT_ID`.
- Check `DISCORD_DEV_GUILD_ID` for typos.
- Confirm the bot is installed in the target server and has `applications.commands` scope.
- Global command propagation may take time.

## Bot cannot join voice

- Check the bot can view and connect to the voice channel.
- Check the bot can speak.
- Check the channel is not full or permission-overridden.
- Check the member invoking `/play` is currently in a voice channel.

## Audio source is rejected

- Confirm the URL is HTTPS.
- Confirm its hostname appears exactly in `AUDIO_ALLOWED_HOSTS`.
- Confirm the URL returns an audio stream, not an HTML page.
- Confirm it does not redirect.
- Confirm its DNS records do not resolve to private/reserved addresses.
- Confirm the operator actually has the necessary streaming and Discord broadcast rights.

## Redis is not ready

- Run `docker compose ps redis`.
- Check `docker compose logs redis`.
- Check `REDIS_URL` from inside the bot container, not only from the host.
- Check Redis ACL/password/TLS configuration if using a managed service.
- Check `/health/ready`.

## A voice session says another worker owns the guild

- A previous worker may still hold the 60-second lease.
- Wait for the old lease TTL or verify the old process is gone.
- Check Redis connectivity and shard logs.
- Do not manually delete live lease keys while a healthy voice worker is active.

## Queue is empty after restart

- The bot persists only upcoming tracks, not the current track.
- It restores the upcoming queue when a new `/play` request creates a voice session.
- If Redis was unavailable before the crash, the newest queue mutations may not have been saved.
- Signed source URLs can expire before the queue is restored.

## Dashboard cannot find a server

- Confirm the bot is installed in the server.
- Confirm the user has Manage Server or is the owner for admin controls.
- In Phase 5, the dashboard is attached to shard 0 only. A guild on another shard will not appear/manage correctly until the cross-shard dashboard command bus is implemented.

## Database connection exhaustion

- `DB_POOL_MAX` applies to each process. If there are N shards, the potential application pool total can approach N × `DB_POOL_MAX`, plus the dashboard/session-store usage and operational clients.
- Reduce `DB_POOL_MAX` if your PostgreSQL plan has a low connection limit.
- Consider PgBouncer or another supported connection pooler for a larger deployment.

---

# 20. Testing and validation

## Automated tests included

- Mood recommendation tests.
- Personal taste recommendation tests.
- Phase 5 metrics formatting test.

The recommender tests exercise mood ranking, variety, recently played avoidance, inferred mood behavior, taste weights, positive/negative feedback, and request parsing. Metrics tests exercise the Prometheus text output and counters.

## Validation status for this generated Phase 5 package

| Check | Status |
|---|---|
| TypeScript source syntax/transpile check | Passed — 23 of 23 source files |
| Dashboard embedded JavaScript parse check | Passed |
| Pure unit tests | Passed — 21 of 21 (11 original + 10 for the network guard and queue sanitiser), after transpiling the test-target source modules independently |
| ZIP integrity | Passed — archive test completed without errors |
| Full `npm install` | Not completed; package registry request timed out in this workspace |
| Full TypeScript type-check with actual package declarations | Not completed |
| Docker Compose configuration validation | Not run; Docker CLI is unavailable in this workspace |
| PostgreSQL integration tests | Not run |
| Redis integration tests | Not run |
| Discord login/sharding test | Not run |
| Voice playback test with a permitted source | Not run |
| Multi-shard dashboard integration test | Not run; cross-shard routing is a documented Phase 5.1 limitation |
| Public load/security test | Not run |

Run this full validation sequence on a machine with registry access and credentials:

```bash
npm install
npm run typecheck
npm run build
npm test
npm run register
npm start
```

For integration testing, start PostgreSQL and Redis, use a private test Discord server, add an authorized test stream, and check all health endpoints.

## Suggested production test matrix

1. Add bot to one test server; verify command registration.
2. Join a voice channel; play a known authorized audio stream.
3. Pause/resume/skip/repeat/volume/leave.
4. Test regular member playlist quota and owner grant/revoke behavior.
5. Test mood commands and catalogue shuffle.
6. Enable personal history on one test user; confirm events are stored only for that user; opt out and forget.
7. Send a burst of commands; confirm rate limits and retry messages.
8. Start two bot processes in a controlled test; verify only one obtains the guild lease.
9. Kill a shard with tracks in the upcoming queue; wait for lease expiry; trigger a new `/play`; verify valid queued entries are restored.
10. Restart PostgreSQL and Redis independently in a test environment; confirm readiness returns `503` while a required dependency is down.
11. Simulate a shard crash; confirm the manager respawns it and logs the event.
12. Test dashboard management for a guild assigned to shard 0. Separately verify that a non-zero-shard guild remains a known limitation until Phase 5.1.

---

# 21. Current limitations and Phase 5.1 work

The current code is a useful public-launch **foundation**, not a complete large-scale SaaS deployment. The following work remains before marketing it as fully horizontally scalable:

## Highest priority

1. **Cross-shard dashboard routing:** move dashboard API operations to an authenticated internal command bus and route commands to the guild-owning shard.
2. **Shared player status:** publish a read-only, timestamped snapshot for each guild to Redis so any dashboard process can show current state.
3. **External shard orchestration:** define a deployment plan for disjoint shard ID lists across multiple hosts/containers with a single consistent total shard count.
4. **Versioned schema migrations:** create ordered migration files, a migration tracking table, and rollback/forward procedures.
5. **Real package lock and reproducible builds:** produce and commit `package-lock.json` from a successful dependency installation.
6. **Automated Redis/PostgreSQL integration tests:** use ephemeral services in CI and test lease races, queue recovery and failure modes.
7. **Secret management and TLS:** configure managed PostgreSQL and Redis with TLS, ACLs and secret rotation.

## Next priority

- Shared metrics backend or OpenTelemetry exporter.
- Error tracking integration.
- Structured log shipping and alerting.
- Per-provider official metadata adapters and playback license review.
- Queue persistence versioning (field-level validation of Redis records is implemented in `src/queue-sanitize.ts`).
- Queue track expiry/refresh policy for signed stream URLs.
- More robust audio source timeout, maximum stream duration and FFmpeg resource limits.
- Configurable per-server queue quotas and per-user song request quotas.
- Automated server removal cleanup/retention policy.
- Dashboard ownership/moderator audit view.
- Deployment runbooks and disaster recovery exercises.
- Security review and load testing.

## Large-scale audio-worker architecture (future)

For a very large bot, separate the responsibilities further:

- **Gateway shard:** receive Discord interactions and guild events.
- **Control API:** validate sessions, permissions and send commands.
- **Voice worker:** own one or more guild voice sessions and stream authorized audio.
- **Queue coordinator:** Redis-based guild queue and leases.
- **Metadata/recommendation service:** catalogue search, AI ranking and personal profiles.
- **PostgreSQL:** durable application data.
- **Object storage/CDN:** only for content the operator has rights to host and serve.

This is a possible future architecture. The current repository does not implement these as separate independently scalable services.

---

# 22. Reference documentation

These are the relevant primary documentation sources for the libraries and operational behavior used in this project. Check them again when upgrading dependencies.

- Discord.js `ShardingManager` (14.27 documentation): https://discord.js.org/docs/packages/discord.js/14.27.0/ShardingManager:Class
- Discord.js client sharding options: https://discord.js.org/docs/packages/discord.js/14.21.0/ClientOptions:Interface
- Redis Node.js client guide: https://redis.io/docs/latest/develop/clients/node-redis/
- Redis Lua scripting and atomic execution: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Node.js documentation: https://nodejs.org/docs/latest/api/
- Docker Compose documentation: https://docs.docker.com/compose/
- Discord Developer Portal: https://discord.com/developers/applications
- Discord OAuth2 documentation: https://discord.com/developers/docs/topics/oauth2
- Spotify Developer Policy: https://developer.spotify.com/policy
- YouTube API Services Developer Policies: https://developers.google.com/youtube/terms/developer-policies/

---

# 23. Quick release checklist

Before calling a release public-ready, check every item below:

- [ ] Install dependencies successfully and create/commit a lockfile.
- [ ] `npm run typecheck` passes with real installed package types.
- [ ] `npm run build` succeeds.
- [ ] `npm test` succeeds.
- [ ] PostgreSQL and Redis have authentication, restricted network exposure, persistence, monitoring and tested backups.
- [ ] Bot token, OAuth secret, database credentials, Redis credentials, session secret and metrics token come from a secret manager.
- [ ] Dashboard served over HTTPS with exact OAuth callback URL.
- [ ] Slash commands registered globally.
- [ ] Bot's permissions and installation scopes are minimal and tested.
- [ ] Audio provider rights and public broadcast permissions reviewed for every enabled source.
- [ ] All queues, rate limits, lease renewals, restarts and failure scenarios tested.
- [ ] Shard count and deployment model tested for expected server count.
- [ ] Cross-shard dashboard gateway implemented, or dashboard limitations clearly disclosed to users.
- [ ] Logs, alerts, metrics and incident response procedures configured.
- [ ] Privacy notice explains opt-in history, forget behavior, backup retention and any external AI request processing.
- [ ] Public bot verification or other Discord requirements checked for the bot's scale and feature set.

---

# 24. Review fixes after the Phase 5 audit

Defects found by cross-checking the code against this guide, and fixed:

| # | Problem | Fix |
|---|---|---|
| 1 | Two members running `/play` at the same moment in an idle server: the second request lost the Redis lease race against the *same* process and got "another worker owns the session". | One pending session promise per guild (`getOrCreateSession` in `src/player.ts`). |
| 2 | A failed voice join (missing permission, timeout) wrote the empty in-memory queue to Redis and erased the saved queue. Shutdown could do the same for a session still restoring. | `queueRestored` flag; snapshots are written only after the saved queue has been loaded. |
| 3 | Race between the track-ended event and `/play` could start two tracks, replacing one and leaking an FFmpeg process. A `/stop` or leave during stream opening could still start the track afterwards. | `starting` is claimed synchronously; an `epoch` counter cancels in-flight starts. |
| 4 | Losing the lease then wrote this process's queue over the new owner's snapshot. | Lease-loss teardown skips the snapshot write. |
| 5 | The shard manager exited immediately after signalling shards, so inside Docker the "graceful shutdown" was cut short. | Manager waits (up to 20 s) for shards to exit; Compose gets `stop_grace_period: 30s` and `init: true`; workers have a 15 s hard shutdown timeout. |
| 6 | `SHARD_ID` is never set by discord.js (it sets `SHARDS`), so every shard logged and labelled metrics as shard `0`/`master`. | `getShardLabel()` in `src/logger.ts`. |
| 7 | DNS was resolved and checked, then resolved again by `fetch` (rebinding window); IPv4-mapped IPv6 addresses such as `::ffff:10.0.0.1` passed the private-address check. | Connection-time lookup guard and full range table (`src/network-guard.ts`). |
| 8 | Redis queue records were only checked for three string fields. | Full validation (`src/queue-sanitize.ts`). |
| 9 | The shard-manager process imported the whole bot (database pool, dashboard, Redis client). | `src/worker-runtime.ts` is imported lazily, only for the unsharded development path. |
| 10 | Dashboard "Leave" reported success when no session existed; async handlers returned response objects (a likely type error with `@types/express` 5); no JSON error handler. | Existence check, `safe()` route wrapper, JSON 500 handler. |
| 11 | Raw `console.log/warn` calls bypassed the JSON logger; interaction failures were never logged; button rate-limit rejections were not counted. | Structured logging and `interaction_errors_total` / button metric. |
| 12 | Container ran as root. | `USER node`. |

Still open (unchanged from section 21): cross-shard dashboard routing, versioned migrations, lockfile, integration tests, and the validation items in section 20. Not fixed because it is a feature rather than a defect: the bot does not leave a voice channel when everyone else has left.

---

**End of guide.**  
This document is the detailed build and operations reference for the repository as it exists in Phase 5. Update it whenever a feature, environment variable, database table, Redis key, permission rule, or deployment service changes.
