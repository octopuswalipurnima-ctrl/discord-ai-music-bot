# Discord AI Music Bot

**Version 0.5.0 — Phase 5 public-operations foundation**

A Discord music bot with private member playlists, owner-granted playlist limits, moderator controls, a metadata-based AI DJ, opt-in personal taste recommendations, a Discord OAuth dashboard, Redis coordination and Discord sharding.

## Main features

- `/play` for approved direct HTTPS audio streams or this server's approved catalogue.
- Voice controls: `/pause`, `/resume`, `/skip`, `/stop`, `/leave`, `/volume`, `/repeat`, `/queue`, `/nowplaying`.
- Personal playlists: two per member by default; server owner can grant three to selected members.
- Moderator role for shared playback controls and AI DJ settings.
- Server catalogue, mood selection, automatic mood inference and AI shuffle.
- Personal listening history is opt-in and off by default; likes/dislikes, `/for-me`, `/ask-music`, `/taste forget`.
- Redis guild voice-session leases, upcoming-queue snapshots and shared rate limits.
- Production Discord sharding with `ShardingManager`.
- Express dashboard, liveness/readiness endpoints, optional metrics and JSON logs.

## Quick start

Requirements: Node.js `>=22.12.0`, Docker Compose, a Discord application, PostgreSQL and Redis.

```bash
cp .env.example .env
# Fill in Discord credentials, session secret, PostgreSQL password and allowed audio hosts.
npm install
docker compose up -d postgres redis
npm run register
npm run dev
```

For the container deployment:

```bash
docker compose --profile app up --build -d
```

The production container starts the shard manager. The development command starts one direct worker.

## Important playback restriction

This project plays only direct HTTPS audio streams on hostnames explicitly listed in `AUDIO_ALLOWED_HOSTS`, after validating the response. It does not extract audio from YouTube, Spotify, Gaana or other consumer music pages. Add only sources for which you have confirmed the required streaming and Discord broadcast rights.

## Phase 5 documentation

Read **[PHASE5_COMPLETE_TECHNICAL_GUIDE.md](./PHASE5_COMPLETE_TECHNICAL_GUIDE.md)** for the detailed architecture, every phase's features, source-file map, packages and infrastructure used, database/Redis design, command reference, installation/deployment, security, testing status, limitations and release checklist.

Also see [BLUEPRINT.md](./BLUEPRINT.md).

## Phase 5 caveats

- Redis stores upcoming queue snapshots, not the active FFmpeg process or current track position. A new `/play` request creates a voice session and restores the saved upcoming queue.
- Each guild's voice session belongs to its owning Discord shard; Redis uses a lease to avoid multiple processes claiming the same guild.
- Only shard 0 currently hosts the dashboard. Cross-shard dashboard RPC/routing is Phase 5.1 work.
- Sharding is started by one `ShardingManager` process tree. Multi-host shard assignment needs an external orchestration plan.
- Source transpile/syntax validation passed for 23 TypeScript files; dashboard inline JavaScript parsed successfully; 11 pure unit tests passed when the relevant modules were transpiled independently.
- Full npm dependency installation, dependency-based build/type-check, Docker Compose validation and live Discord integration tests still need to be completed on a machine with registry access, Docker and real Discord credentials.

## Validation commands

```bash
npm run typecheck
npm run build
npm test
```

For configuration and a complete technical explanation, read the Phase 5 guide.
