package com.pta.forwarder.network

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.pta.forwarder.data.AppConfig
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

class RelayClient(
    private val config: AppConfig,
    private val onAnswer: () -> Unit,
    private val onReject: () -> Unit
) {

    companion object {
        private const val TAG = "RelayClient"
        private const val RECONNECT_DELAY_MS = 5000L
        private const val MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000L
        private const val MIN_TOKEN_LENGTH = 32
        private const val MAX_MESSAGE_LENGTH = 4096

        /**
         * Returns null if the URL is acceptable, otherwise a human readable reason.
         * Rules: ws:// or wss:// only; plain ws:// is allowed ONLY for private LAN/VPN
         * addresses (10.x, 172.16-31.x, 192.168.x, 100.64/10 Tailscale, 127.x, *.local).
         * Anything reachable over the internet must use wss:// (TLS).
         */
        fun validateRelayUrl(raw: String): String? {
            val url = raw.trim()
            val lower = url.lowercase()
            val isWss = lower.startsWith("wss://")
            val isWs = lower.startsWith("ws://")
            if (!isWs && !isWss) return "Relay URL must start with ws:// or wss://"
            val httpUrl = ("http" + url.substring(2)).toHttpUrlOrNull() ?: return "Invalid relay URL"
            if (httpUrl.username.isNotEmpty() || httpUrl.password.isNotEmpty()) {
                return "Do not put credentials in the URL. Use the Relay Auth Token field."
            }
            if (isWs && !isPrivateHost(httpUrl.host)) {
                return "Plain ws:// is only allowed for LAN/VPN addresses. Use wss:// for internet servers."
            }
            return null
        }

        fun validateToken(token: String): String? =
            if (token.trim().length < MIN_TOKEN_LENGTH) "Relay Auth Token must be at least $MIN_TOKEN_LENGTH characters" else null

        private fun isPrivateHost(host: String): Boolean {
            if (host.endsWith(".local", ignoreCase = true)) return true
            // Only IP literals are checked - no DNS lookup (a hostname could resolve anywhere).
            if (!host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) return false
            return try {
                val addr = InetAddress.getByName(host)
                if (addr !is Inet4Address) return false
                val b = addr.address.map { it.toInt() and 0xFF }
                addr.isSiteLocalAddress ||            // 10/8, 172.16/12, 192.168/16
                    addr.isLoopbackAddress ||         // 127/8
                    (b[0] == 100 && b[1] in 64..127)  // 100.64/10 (Tailscale / CGNAT VPN)
            } catch (e: Exception) {
                false
            }
        }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var webSocket: WebSocket? = null
    private val handler = Handler(Looper.getMainLooper())
    private var isIntentionalClose = false
    private var reconnectDelayMs = RECONNECT_DELAY_MS

    fun connect() {
        if (!config.relayEnabled || config.relayWsUrl.isBlank()) {
            Log.d(TAG, "Relay client disabled or URL empty")
            return
        }

        isIntentionalClose = false
        val url = config.relayWsUrl.trim()
        val token = config.relayAuthToken.trim()

        validateRelayUrl(url)?.let {
            Log.e(TAG, "Refusing to connect: $it")
            return
        }
        validateToken(token)?.let {
            Log.e(TAG, "Refusing to connect: $it")
            return
        }

        Log.i(TAG, "Connecting to relay")

        val request = try {
            Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "Invalid relay URL")
            return
        }

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.i(TAG, "Connected to Relay WebSocket")
                reconnectDelayMs = RECONNECT_DELAY_MS
                // Identify as Phone A (Sender)
                val initMsg = JSONObject().apply {
                    put("type", "REGISTER")
                    put("role", "SENDER")
                }
                ws.send(initMsg.toString())
            }

            override fun onMessage(ws: WebSocket, text: String) {
                if (text.length > MAX_MESSAGE_LENGTH) {
                    Log.w(TAG, "Ignoring oversized relay message")
                    return
                }
                try {
                    val json = JSONObject(text)
                    val action = json.optString("action")
                    handler.post {
                        when (action.uppercase()) {
                            "ANSWER" -> {
                                Log.i(TAG, "Executing remote ANSWER command")
                                onAnswer()
                            }
                            "REJECT" -> {
                                Log.i(TAG, "Executing remote REJECT command")
                                onReject()
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse incoming relay message: ${e.message}")
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "Relay closing: $reason ($code)")
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "Relay closed: $reason ($code)")
                scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (response?.code == 401) {
                    Log.e(TAG, "Relay rejected the auth token (401). Check Relay Auth Token in Settings.")
                } else {
                    Log.e(TAG, "Relay connection failed: ${t.javaClass.simpleName}")
                }
                scheduleReconnect()
            }
        })
    }

    fun sendEvent(eventType: String, data: JSONObject) {
        val payload = JSONObject().apply {
            put("type", eventType)
            put("payload", data)
        }
        val sent = webSocket?.send(payload.toString()) ?: false
        if (!sent) {
            Log.w(TAG, "Failed to send event to relay (socket disconnected): $eventType")
        }
    }

    fun disconnect() {
        isIntentionalClose = true
        handler.removeCallbacksAndMessages(null)
        webSocket?.close(1000, "App closing")
        webSocket = null
        Log.i(TAG, "Relay disconnected")
    }

    private fun scheduleReconnect() {
        if (isIntentionalClose || !config.relayEnabled || config.relayWsUrl.isBlank()) return
        val delay = reconnectDelayMs
        // Exponential back-off so a wrong token/URL does not hammer the server.
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
        Log.d(TAG, "Scheduling reconnect in ${delay / 1000}s...")
        handler.postDelayed({
            if (!isIntentionalClose) {
                connect()
            }
        }, delay)
    }
}
