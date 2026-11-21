# PTA Forwarder — Relay Daemon & Discord Voice Bridge

This is the self-hosted relay daemon that connects **Phone A** (PTA Android), **Phone B** (via stock Discord & Telegram apps), and the **Discord Voice Bridge**.

## Features
- **Remote Call Control:** Instant interactive cards in `#calls` (Discord) and Telegram with `[ ✅ Answer & Join Voice ]` and `[ ❌ Reject Call ]`.
- **Bidirectional WebSocket:** Real-time link between Phone A's background service and this relay.
- **Discord Voice Bridge:** When answered, the Discord bot automatically joins the `🔊 Active Call` voice channel and bridges 2-way cellular audio.
- **Zero Cost & Zero Root:** Runs on your local Linux machine/server/Raspberry Pi where Phone A stays docked.

---

## 1. Quickstart

### Prerequisites
- Node.js 18+ (tested on Node v22)
- Linux with PipeWire or PulseAudio (for Bluetooth HFP audio bridging)

### Installation
```bash
cd relay
npm install
```

### Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in the values:
- `PORT`: WebSocket port (default `8080`).
- `DISCORD_BOT_TOKEN`: Your Discord bot token (create from Discord Developer Portal).
- `DISCORD_GUILD_ID`: Your Discord Server ID.
- `DISCORD_TEXT_CHANNEL_ID`: Channel ID for `#calls`.
- `DISCORD_VOICE_CHANNEL_ID`: Voice Channel ID for `🔊 Active Call`.
- `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`: Optional Telegram credentials.

---

## 2. Pairing Phone A via Bluetooth (HFP)

To stream cellular audio to Discord with zero root:
1. Run `./setup_hfp_linux.sh` or use `bluetoothctl` to pair Phone A to this machine.
2. In your Linux audio settings (`pavucontrol` or `wpctl`), ensure Phone A is connected with the **Hands-Free / Headset (HFP/HSP)** profile.
3. Start the relay:
```bash
npm start
```

---

## 3. Configuring Phone A (Android App)

1. Open the **PTA Forwarder** app on Phone A.
2. Set Role to **SENDER (PTA)**.
3. In **Relay Server**, enter your machine's IP address:
   ```
   ws://192.168.1.X:8080

and paste the same RELAY_AUTH_TOKEN into **Relay Auth Token**. Plain ws:// is accepted only for LAN/VPN addresses; internet servers must use wss://.
   ```
4. Tap **START SERVICE**.

Phone A will connect to the relay and all incoming calls will immediately post interactive cards to your Discord server and Telegram!

4. Port Security
- Every WebSocket connection must send `Authorization: Bearer <RELAY_AUTH_TOKEN>`; others get 401 and are dropped.
- 5 failed auth attempts from one IP within 10 minutes block that IP for 30 minutes.
- Plain HTTP requests on the port get a bare 404; only `/` and `/ws` accept upgrades.
- Max message size 16 KB, max 10 messages/second, heartbeat drops dead connections, payloads are schema-validated.
- Only one phone session at a time; Discord/Telegram buttons only work for allowed user IDs.
- Firewall: allow the port only from your LAN/VPN, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp`.
- Never port-forward 8080 on your router without TLS. Prefer a VPN (Tailscale/WireGuard) for remote access.
