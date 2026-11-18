# Database notes

The bot creates and updates its PostgreSQL schema idempotently during startup in `src/db.ts` (Phase 1 through Phase 4).

Phase 1 tables: `playlists`, `playlist_tracks`, and `playlist_limits`.

Phase 2 tables: `server_settings` stores each guild's configured music moderator role; `server_audit_log` stores moderator-role changes and special playlist grants/revocations.

Playlist entitlements are scoped by `(guild_id, user_id)`. Members default to two playlists when no entitlement row exists; an entitlement row raises the cap to three. The create, grant, and revoke operations share a per-member/server advisory lock.


Phase 3 tables:

- `music_catalogue_tracks` holds each server's approved audio stream references and normalized metadata (genre tags, mood tags, tempo, energy and language). Source URLs must be approved direct HTTPS streams on `AUDIO_ALLOWED_HOSTS`.
- `guild_dj_settings` stores the server's selected mood or automatic-mood setting.
- `guild_track_history` records catalogue track starts for server-level recent-play exclusion and auto mood inference. It does not store voice audio or transcripts.

The app creates these tables idempotently at startup. Catalogue entries are guild-scoped; a track added to one server is not visible to another server.

Phase 4 tables:

- `user_music_preferences` stores each member's history consent separately for every server; tracking is off for members without an enabled row.
- `user_track_events` stores only opted-in request-start, like and dislike events with compact track metadata snapshots. Personal profile data is not shared across guilds and source URLs are not copied into the personal events table.
- Consent changes, personal event writes, and the forget operation share a PostgreSQL advisory lock per guild/member so an opt-out or delete cannot race with event collection.
- `/taste forget` deletes all user events for that server and leaves the consent preference disabled. `/taste opt-out` stops future collection while retaining existing history until a forget request.
