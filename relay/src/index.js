require('dotenv').config();
const { WebSocketServer } = require('ws');
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const TelegramBot = require('node-telegram-bot-api');
const AudioBridge = require('./audio_bridge');

const fs = require('fs');
const http = require('http');
const https = require('https');
const {
  loadAuthToken,
  safeEqual,
  extractToken,
  FailedAuthLimiter,
  MessageRateLimiter,
  validateCallPayload,
  escapeHtml,
  maskNumber,
  idList
} = require('./security');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Bind to a specific interface (e.g. your LAN IP or 127.0.0.1 behind a reverse proxy).
const BIND_HOST = (process.env.BIND_HOST || '0.0.0.0').trim();
const AUTH_TOKEN = loadAuthToken();
const TLS_CERT_FILE = (process.env.TLS_CERT_FILE || '').trim();
const TLS_KEY_FILE = (process.env.TLS_KEY_FILE || '').trim();
const MAX_PAYLOAD_BYTES = 16 * 1024;
const HEARTBEAT_MS = 30 * 1000;

// Only these Discord users / Telegram users may Answer / Reject calls.
const DISCORD_ALLOWED_USER_IDS = idList(process.env.DISCORD_ALLOWED_USER_IDS);
const TELEGRAM_ALLOWED_USER_IDS = idList(process.env.TELEGRAM_ALLOWED_USER_IDS);

const audioBridge = new AudioBridge(
  process.env.AUDIO_SOURCE_DEVICE || 'default',
  process.env.AUDIO_SINK_DEVICE || 'default'
);

let phoneSocket = null;
let activeCallInfo = null; // { number, name, startTime, discordMessageId, telegramMessageId }

// ==========================================
// 1. SECURE WEBSOCKET SERVER (Connection to Phone A)
// ==========================================
const useTls = TLS_CERT_FILE && TLS_KEY_FILE;
const httpServer = useTls
  ? https.createServer({
      cert: fs.readFileSync(TLS_CERT_FILE),
      key: fs.readFileSync(TLS_KEY_FILE),
      minVersion: 'TLSv1.2'
    })
  : http.createServer();

// Any plain HTTP request (port scanners, browsers) gets a bare 404 - nothing is revealed.
httpServer.on('request', (req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const authLimiter = new FailedAuthLimiter();

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false
});

httpServer.on('upgrade', (req, socket, head) => {
  const ip = req.socket.remoteAddress || 'unknown';

  const reject = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  if (authLimiter.isBlocked(ip)) return reject(429, 'Too Many Requests');

  if (req.url !== '/' && req.url !== '/ws') return reject(404, 'Not Found');

  const token = extractToken(req);
  if (!token || !safeEqual(token, AUTH_TOKEN)) {
    authLimiter.recordFailure(ip);
    console.warn(`[Security] Rejected unauthenticated connection from ${ip}`);
    return reject(401, 'Unauthorized');
  }

  authLimiter.recordSuccess(ip);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WebSocket] Phone A connected (authenticated) from ${ip}`);

  // Only one phone at a time: close the previous session.
  if (phoneSocket && phoneSocket !== ws && phoneSocket.readyState === 1) {
    phoneSocket.close(4000, 'Replaced by new connection');
  }
  phoneSocket = ws;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const limiter = new MessageRateLimiter(10, 20);

  ws.on('message', (message, isBinary) => {
    if (isBinary) return ws.close(1003, 'Binary not supported');
    if (!limiter.allow()) {
      console.warn('[Security] Message rate limit exceeded, closing socket');
      return ws.close(1008, 'Rate limit');
    }

    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('[WebSocket] Invalid JSON from Phone A');
      return;
    }

    if (data && data.type === 'REGISTER') {
      console.log('[WebSocket] Phone A registered as', String(data.role || '').slice(0, 20));
      return;
    }

    if (data && data.type === 'CALL_STATE') {
      const payload = validateCallPayload(data.payload);
      if (!payload) {
        console.warn('[WebSocket] Dropped invalid CALL_STATE payload');
        return;
      }
      console.log(`[WebSocket] CALL_STATE ${payload.eventType} ${maskNumber(payload.number)}`);
      handlePhoneCallEvent(payload).catch((e) => console.error('[Call] Handler error:', e.message));
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Phone A disconnected');
    if (phoneSocket === ws) phoneSocket = null;
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err.message);
  });
});

// Heartbeat: drop dead / half-open connections.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, BIND_HOST, () => {
  console.log(`[WebSocket] ${useTls ? 'Secure (wss)' : 'Plain (ws)'} server listening on ${BIND_HOST}:${PORT}`);
  if (!useTls) {
    console.warn('[Security] TLS is OFF. Use plain ws:// only inside your LAN/VPN. ' +
      'For internet access set TLS_CERT_FILE/TLS_KEY_FILE or put the relay behind nginx with HTTPS.');
  }
});

function sendToPhone(command) {
  if (phoneSocket && phoneSocket.readyState === 1) { // OPEN
    phoneSocket.send(JSON.stringify(command));
    console.log('[WebSocket] Sent to Phone A:', command.action);
    return true;
  } else {
    console.warn('[WebSocket] Cannot send command: Phone A is not connected');
    return false;
  }
}

// ==========================================
// 2. DISCORD BOT SETUP
// ==========================================
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

discordClient.on('ready', () => {
  console.log(`[Discord] Bot logged in as ${discordClient.user.tag}`);
});

discordClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId } = interaction;
  if (!['btn_answer', 'btn_reject', 'btn_end'].includes(customId)) return;

  // Only allowed users may control calls
  if (DISCORD_ALLOWED_USER_IDS.size === 0 || !DISCORD_ALLOWED_USER_IDS.has(interaction.user.id)) {
    console.warn(`[Security] Discord user ${interaction.user.id} is not allowed to control calls`);
    await interaction.reply({ content: '⛔ You are not allowed to control calls.', ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();

  if (customId === 'btn_answer') {
    console.log('[Discord] User clicked ANSWER');
    sendToPhone({ action: 'ANSWER' });

    // Join Discord Voice Channel
    try {
      const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID);
      const voiceChannel = guild?.channels.cache.get(process.env.DISCORD_VOICE_CHANNEL_ID);

      if (guild && voiceChannel) {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });

        audioBridge.start(connection);
      }
    } catch (err) {
      console.error('[Discord] Voice connection failed:', err.message);
    }

    // Update Embed to "In Call"
    const inCallEmbed = new EmbedBuilder()
      .setTitle(`🟢 In Call: ${activeCallInfo?.name || activeCallInfo?.number || 'Unknown'}`)
      .setDescription(`Connected to Voice Channel <#${process.env.DISCORD_VOICE_CHANNEL_ID}>`)
      .setColor(0x10B981)
      .setTimestamp();

    const endRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_end')
        .setLabel('End Call')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ embeds: [inCallEmbed], components: [endRow] });

  } else if (customId === 'btn_reject') {
    console.log('[Discord] User clicked REJECT');
    sendToPhone({ action: 'REJECT' });

    const rejectEmbed = new EmbedBuilder()
      .setTitle(`❌ Call Rejected: ${activeCallInfo?.name || activeCallInfo?.number || 'Unknown'}`)
      .setColor(0xEF4444)
      .setTimestamp();

    await interaction.editReply({ embeds: [rejectEmbed], components: [] });
    activeCallInfo = null;

  } else if (customId === 'btn_end') {
    console.log('[Discord] User clicked END CALL');
    sendToPhone({ action: 'REJECT' });

    audioBridge.stop();
    const connection = getVoiceConnection(process.env.DISCORD_GUILD_ID);
    if (connection) connection.destroy();

    const endedEmbed = new EmbedBuilder()
      .setTitle(`🏁 Call Ended: ${activeCallInfo?.name || activeCallInfo?.number || 'Unknown'}`)
      .setColor(0x6B7280)
      .setTimestamp();

    await interaction.editReply({ embeds: [endedEmbed], components: [] });
    activeCallInfo = null;
  }
});

const isConfigured = (val) => val && !val.includes('your_') && val.trim() !== '';

if (isConfigured(process.env.DISCORD_BOT_TOKEN)) {
  discordClient.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error('[Discord] Login error:', err.message);
  });
} else {
  console.log('[Discord] Note: DISCORD_BOT_TOKEN contains placeholder. Update relay/.env to enable Discord Bot.');
}

// ==========================================
// 3. TELEGRAM BOT SETUP
// ==========================================
let telegramBot = null;
if (isConfigured(process.env.TELEGRAM_BOT_TOKEN)) {
  telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[Telegram] Bot initialized');

  telegramBot.on('callback_query', async (query) => {
    const action = query.data;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const fromId = String(query.from?.id || '');

    // Only accept button presses from the configured chat and allowed users
    const chatOk = String(chatId) === String(process.env.TELEGRAM_CHAT_ID);
    const userOk = TELEGRAM_ALLOWED_USER_IDS.size === 0
      ? String(chatId) === fromId // private chat: the chat id is the user id
      : TELEGRAM_ALLOWED_USER_IDS.has(fromId);
    if (!chatOk || !userOk) {
      console.warn(`[Security] Telegram user ${fromId} is not allowed to control calls`);
      telegramBot.answerCallbackQuery(query.id, { text: 'Not allowed', show_alert: true }).catch(() => {});
      return;
    }

    if (action === 'call_answer') {
      console.log('[Telegram] User tapped ANSWER');
      sendToPhone({ action: 'ANSWER' });
      await telegramBot.editMessageText(`🟢 <b>Call Answered</b>: ${escapeHtml(activeCallInfo?.name || activeCallInfo?.number || '')}`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } else if (action === 'call_reject') {
      console.log('[Telegram] User tapped REJECT');
      sendToPhone({ action: 'REJECT' });
      await telegramBot.editMessageText(`❌ <b>Call Rejected</b>: ${escapeHtml(activeCallInfo?.name || activeCallInfo?.number || '')}`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
      activeCallInfo = null;
    }

    telegramBot.answerCallbackQuery(query.id).catch(() => {});
  });
}

// ==========================================
// 4. PHONE CALL EVENT HANDLER
// ==========================================
async function handlePhoneCallEvent(payload) {
  const { eventType, number, name, timestamp } = payload;
  const displayName = name ? `${name} (${number})` : number;

  if (eventType === 'RINGING') {
    activeCallInfo = { number, name, startTime: Date.now() };

    // Discord Alert
    if (discordClient.isReady() && process.env.DISCORD_TEXT_CHANNEL_ID) {
      const channel = discordClient.channels.cache.get(process.env.DISCORD_TEXT_CHANNEL_ID);
      if (channel) {
        const ringEmbed = new EmbedBuilder()
          .setTitle(`📞 INCOMING CALL: ${displayName}`)
          .setDescription('Status: **Ringing...**\nSelect an action below:')
          .setColor(0x2563EB)
          .setTimestamp(new Date(timestamp));

        const buttonsRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_answer')
            .setLabel('Answer & Join Voice')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('btn_reject')
            .setLabel('Reject Call')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
        );

        const msg = await channel.send({ embeds: [ringEmbed], components: [buttonsRow] });
        activeCallInfo.discordMessageId = msg.id;
        activeCallInfo.channelId = channel.id;
      }
    }

    // Telegram Alert
    if (telegramBot && process.env.TELEGRAM_CHAT_ID) {
      const text = `📞 <b>INCOMING CALL:</b> <code>${escapeHtml(displayName)}</code>\nStatus: <i>Ringing...</i>`;
      const options = {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Answer', callback_data: 'call_answer' },
              { text: '❌ Reject', callback_data: 'call_reject' }
            ]
          ]
        }
      };
      const tgMsg = await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, text, options);
      activeCallInfo.telegramMessageId = tgMsg.message_id;
    }

  } else if (eventType === 'MISSED') {
    // If missed, cleanup audio & update cards
    audioBridge.stop();
    const connection = getVoiceConnection(process.env.DISCORD_GUILD_ID);
    if (connection) connection.destroy();

    if (activeCallInfo?.discordMessageId && process.env.DISCORD_TEXT_CHANNEL_ID) {
      const channel = discordClient.channels.cache.get(process.env.DISCORD_TEXT_CHANNEL_ID);
      if (channel) {
        try {
          const msg = await channel.messages.fetch(activeCallInfo.discordMessageId);
          const missedEmbed = new EmbedBuilder()
            .setTitle(`🔴 Missed Call: ${displayName}`)
            .setColor(0xEF4444)
            .setTimestamp(new Date(timestamp));
          await msg.edit({ embeds: [missedEmbed], components: [] });
        } catch (e) {}
      }
    }

    if (telegramBot && activeCallInfo?.telegramMessageId && process.env.TELEGRAM_CHAT_ID) {
      telegramBot.editMessageText(`🔴 <b>Missed Call:</b> <code>${escapeHtml(displayName)}</code>`, {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        message_id: activeCallInfo.telegramMessageId,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    activeCallInfo = null;

  } else if (eventType === 'ANSWERED') {
    console.log(`[Call] Call answered: ${maskNumber(number)}`);
  }
}
