package com.pta.forwarder.receiver

import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.pta.forwarder.data.AppConfig
import com.pta.forwarder.network.CallEventType
import com.pta.forwarder.network.CloudDispatcher

class CallListener(
    private val context: Context,
    private val config: AppConfig,
    private val onCallState: ((CallEventType, String, String?, Long) -> Unit)? = null
) {

    companion object {
        private const val TAG = "CallListener"
        const val UNKNOWN_NUMBER = "Unknown"

        /**
         * The PHONE_STATE broadcast and the telephony callback are delivered
         * independently, so the number can land a moment after the RINGING state.
         * Wait this long before giving up on it.
         */
        private const val RINGING_RESOLVE_DELAY_MS = 900L
    }

    private val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private val dispatcher = CloudDispatcher(config)

    private var previousState = TelephonyManager.CALL_STATE_IDLE
    private var lastIncomingNumber: String? = null
    private var isMissed = false

    private var legacyListener: PhoneStateListener? = null
    private var modernCallback: Any? = null // TelephonyCallback

    private val handler = Handler(Looper.getMainLooper())
    private var pendingRinging: Runnable? = null

    fun startListening() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: TelephonyCallback.CallStateListener does NOT provide the
            // caller's number. It is supplied by CallStateReceiver (PHONE_STATE broadcast).
            val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    handleStateChange(state, null)
                }
            }
            modernCallback = callback
            telephonyManager.registerTelephonyCallback(context.mainExecutor, callback)
        } else {
            @Suppress("DEPRECATION")
            val listener = object : PhoneStateListener() {
                @Deprecated("Deprecated in Java")
                override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                    handleStateChange(state, phoneNumber)
                }
            }
            legacyListener = listener
            @Suppress("DEPRECATION")
            telephonyManager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
        }
    }

    fun stopListening() {
        pendingRinging?.let { handler.removeCallbacks(it) }
        pendingRinging = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modernCallback?.let {
                telephonyManager.unregisterTelephonyCallback(it as TelephonyCallback)
            }
        } else {
            legacyListener?.let {
                @Suppress("DEPRECATION")
                telephonyManager.listen(it, PhoneStateListener.LISTEN_NONE)
            }
        }
    }

    fun setIncomingNumber(number: String) {
        lastIncomingNumber = number
        CallNumberHolder.update(number)
    }

    fun acceptCall(): Boolean {
        return try {
            if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.ANSWER_PHONE_CALLS)
                == PackageManager.PERMISSION_GRANTED) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
                    telecom?.acceptRingingCall()
                    Log.i(TAG, "Call accepted via TelecomManager")
                    true
                } else {
                    Log.w(TAG, "acceptRingingCall requires Android 8.0+")
                    false
                }
            } else {
                Log.e(TAG, "Missing ANSWER_PHONE_CALLS permission")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error accepting call: ${e.message}", e)
            false
        }
    }

    fun endCall(): Boolean {
        return try {
            if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.ANSWER_PHONE_CALLS)
                == PackageManager.PERMISSION_GRANTED) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
                    val ended = telecom?.endCall() ?: false
                    Log.i(TAG, "Call ended via TelecomManager: $ended")
                    ended
                } else {
                    Log.w(TAG, "endCall via TelecomManager requires Android 9.0+")
                    false
                }
            } else {
                Log.e(TAG, "Missing ANSWER_PHONE_CALLS permission")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error ending call: ${e.message}", e)
            false
        }
    }

    /**
     * Works out the caller's number from every source available, in order of reliability:
     *  1. the value handed in by PhoneStateListener (Android 11 and below only),
     *  2. the PHONE_STATE broadcast captured by [CallStateReceiver] (Android 12+),
     *  3. the number remembered from the RINGING state of this same call,
     *  4. the most recent call log entry (needs READ_CALL_LOG).
     */
    private fun resolveNumber(incomingNumber: String?): String {
        incomingNumber?.takeIf { it.isNotBlank() }?.let { return it }
        CallNumberHolder.lastNumber?.takeIf { it.isNotBlank() }?.let { return it }
        lastIncomingNumber?.takeIf { it.isNotBlank() && it != UNKNOWN_NUMBER }?.let { return it }
        lookupNumberFromCallLog()?.let { return it }
        Log.w(TAG, "Caller number unavailable - READ_CALL_LOG is likely not granted")
        return UNKNOWN_NUMBER
    }

    private fun handleStateChange(state: Int, incomingNumber: String?) {
        val number = resolveNumber(incomingNumber)
        val timestamp = System.currentTimeMillis()

        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                isMissed = true
                if (number == UNKNOWN_NUMBER) {
                    // Give the PHONE_STATE broadcast a moment to arrive, then re-resolve.
                    val task = Runnable {
                        pendingRinging = null
                        emitRinging(resolveNumber(null), timestamp)
                    }
                    pendingRinging = task
                    handler.postDelayed(task, RINGING_RESOLVE_DELAY_MS)
                } else {
                    emitRinging(number, timestamp)
                }
            }

            TelephonyManager.CALL_STATE_OFFHOOK -> {
                // Call was answered
                if (previousState == TelephonyManager.CALL_STATE_RINGING) {
                    flushPendingRinging()
                    isMissed = false
                    val resolved = resolveNumber(incomingNumber)
                    val contactName = resolveContactName(resolved)
                    dispatcher.dispatchCall(resolved, contactName, CallEventType.ANSWERED, timestamp)
                    onCallState?.invoke(CallEventType.ANSWERED, resolved, contactName, timestamp)
                }
            }

            TelephonyManager.CALL_STATE_IDLE -> {
                // If it was ringing and never answered (offhook), it is a missed call
                if (previousState == TelephonyManager.CALL_STATE_RINGING && isMissed) {
                    flushPendingRinging()
                    val resolved = resolveNumber(incomingNumber)
                    val contactName = resolveContactName(resolved)
                    Log.d(TAG, "Missed call")
                    dispatcher.dispatchCall(resolved, contactName, CallEventType.MISSED, timestamp)
                    onCallState?.invoke(CallEventType.MISSED, resolved, contactName, timestamp)
                } else {
                    flushPendingRinging()
                }
                isMissed = false
                // Reset so the next call cannot inherit this one's number
                lastIncomingNumber = null
                CallNumberHolder.clear()
            }
        }
        previousState = state
    }

    private fun emitRinging(number: String, timestamp: Long) {
        lastIncomingNumber = number
        val contactName = resolveContactName(number)
        Log.d(TAG, "Incoming call ringing")
        dispatcher.dispatchCall(number, contactName, CallEventType.RINGING, timestamp)
        onCallState?.invoke(CallEventType.RINGING, number, contactName, timestamp)
    }

    /** If a RINGING notification is still waiting on the number, send it now. */
    private fun flushPendingRinging() {
        pendingRinging?.let {
            handler.removeCallbacks(it)
            pendingRinging = null
            it.run()
        }
    }

    /** Last resort: read the newest call log entry. Requires READ_CALL_LOG. */
    private fun lookupNumberFromCallLog(): String? {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CALL_LOG)
            != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        return try {
            val projection = arrayOf(CallLog.Calls.NUMBER)
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                null,
                null,
                "${CallLog.Calls.DATE} DESC LIMIT 1"
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                    val value = if (index >= 0) cursor.getString(index) else null
                    value?.takeIf { it.isNotBlank() }
                } else null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Call log lookup failed: ${e.message}")
            null
        }
    }

    /** Resolves the saved contact name for a number. Requires READ_CONTACTS. */
    private fun resolveContactName(phoneNumber: String): String? {
        if (phoneNumber == UNKNOWN_NUMBER || phoneNumber.isBlank()) return null
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CONTACTS)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "READ_CONTACTS not granted - caller name cannot be resolved")
            return null
        }
        return try {
            val uri: Uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(phoneNumber)
            )
            val projection = arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME)
            val cursor: Cursor? = context.contentResolver.query(uri, projection, null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    val index = it.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
                    val name = if (index >= 0) it.getString(index) else null
                    name?.takeIf { n -> n.isNotBlank() }
                } else null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Contact lookup failed: ${e.message}")
            null
        }
    }
}
