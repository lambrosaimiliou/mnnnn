'use strict';
const { Client, GatewayIntentBits, Partials } = require('discord.js');

function createDiscordIntegration({ db, token, guildId, webhookUrl, logger = console }) {
  let client = null;
  let guild = null;
  let inviteUses = new Map();
  let connected = false;
  let lastError = token ? 'Connecting to Discord…' : 'Discord bot token has not been configured.';
  let snapshotTimer = null;
  let presenceCount = null;

  async function snapshot() {
    if (!guild) return;
    try {
      const total = Number(guild.memberCount || 0);
      const online = presenceCount;
      await db.execute(
        'INSERT INTO discord_member_snapshots (guild_id,captured_at,total_members,online_members,offline_members) VALUES (?,NOW(),?,?,?)',
        [guildId, total, online, online === null ? null : Math.max(0, total - online)]
      );
    } catch (error) {
      logger.warn('[Discord] Could not save member snapshot:', error.message);
    }
  }

  async function refreshPresence() {
    if (!guild) return;
    try {
      await guild.members.fetch({ withPresences: true });
      presenceCount = guild.presences.cache.filter((p) => p.status && p.status !== 'offline').size;
    } catch (error) {
      presenceCount = null;
      logger.warn('[Discord] Presence data unavailable:', error.message);
    }
  }

  async function refreshInvites() {
    if (!guild) return;
    try {
      const invites = await guild.invites.fetch();
      inviteUses = new Map(invites.map((invite) => [invite.code, Number(invite.uses || 0)]));
      for (const invite of invites.values()) {
        await db.execute(
          `INSERT INTO discord_invite_tracking (invite_code,inviter_id,inviter_name,uses) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE inviter_id=VALUES(inviter_id),inviter_name=VALUES(inviter_name),uses=VALUES(uses)`,
          [invite.code, invite.inviter?.id || null, invite.inviter?.globalName || invite.inviter?.username || 'Unknown', Number(invite.uses || 0)]
        );
      }
    } catch (error) {
      lastError = 'Invite tracking requires Manage Server permission for the bot.';
      logger.warn('[Discord] Invite cache unavailable:', error.message);
    }
  }

  async function onMemberJoin(member) {
    try {
      const current = await member.guild.invites.fetch();
      let used = null;
      for (const invite of current.values()) {
        const previous = inviteUses.get(invite.code) ?? 0;
        const now = Number(invite.uses || 0);
        if (now > previous) { used = invite; break; }
      }
      inviteUses = new Map(current.map((invite) => [invite.code, Number(invite.uses || 0)]));
      if (used) {
        await db.execute(
          `INSERT INTO discord_invite_tracking (invite_code,inviter_id,inviter_name,uses) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE inviter_id=VALUES(inviter_id),inviter_name=VALUES(inviter_name),uses=VALUES(uses)`,
          [used.code, used.inviter?.id || null, used.inviter?.globalName || used.inviter?.username || 'Unknown', Number(used.uses || 0)]
        );
      }
      await refreshPresence();
      await snapshot();
    } catch (error) {
      logger.warn('[Discord] Member join tracking failed:', error.message);
    }
  }

  if (token) {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildInvites],
      partials: [Partials.GuildMember]
    });
    client.once('ready', async () => {
      try {
        guild = await client.guilds.fetch(guildId);
        await guild.fetch();
        await refreshPresence();
        await refreshInvites();
        connected = true;
        lastError = null;
        await snapshot();
        snapshotTimer = setInterval(async () => { await refreshPresence(); await snapshot(); }, 6 * 60 * 60 * 1000);
        logger.log(`[Discord] Connected to guild ${guildId}.`);
      } catch (error) {
        connected = false;
        lastError = `Could not access Discord server: ${error.message}`;
        logger.error('[Discord] Guild initialization failed:', error.message);
      }
    });
    client.on('guildMemberAdd', onMemberJoin);
    client.on('inviteCreate', (invite) => inviteUses.set(invite.code, Number(invite.uses || 0)));
    client.on('inviteDelete', (invite) => inviteUses.delete(invite.code));
    client.on('error', (error) => { connected = false; lastError = error.message; logger.error('[Discord] Client error:', error.message); });
    client.login(token).catch((error) => { connected = false; lastError = `Bot login failed: ${error.message}`; logger.error('[Discord] Login failed:', error.message); });
  }

  async function getStats() {
    if (!connected || !guild) return { configured: Boolean(token), connected: false, error: lastError, online: null, offline: null, total: null, growthLastMonth: null, topInviter: null };
    const total = Number(guild.memberCount || 0);
    const online = presenceCount;
    const [snapshotRows] = await db.query(
      'SELECT total_members FROM discord_member_snapshots WHERE guild_id=? AND captured_at <= DATE_SUB(NOW(),INTERVAL 30 DAY) ORDER BY captured_at DESC LIMIT 1', [guildId]
    );
    const [inviteRows] = await db.query(
      `SELECT inviter_name, SUM(uses) uses FROM discord_invite_tracking WHERE inviter_id IS NOT NULL GROUP BY inviter_id,inviter_name ORDER BY uses DESC LIMIT 1`
    );
    return {
      configured: true, connected: true, error: lastError,
      online, offline: online === null ? null : Math.max(0, total - online), total,
      growthLastMonth: snapshotRows.length ? total - Number(snapshotRows[0].total_members) : null,
      topInviter: inviteRows.length ? { name: inviteRows[0].inviter_name, uses: Number(inviteRows[0].uses) } : null
    };
  }

  async function notify(message) {
    if (!webhookUrl) return;
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: String(message).slice(0, 1800), allowed_mentions: { parse: [] } })
      });
      if (!response.ok) logger.warn('[Discord] Webhook returned HTTP', response.status);
    } catch (error) { logger.warn('[Discord] Webhook notification failed:', error.message); }
  }
  async function close() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (client) await client.destroy();
  }
  return { getStats, notify, close };
}
module.exports = { createDiscordIntegration };
