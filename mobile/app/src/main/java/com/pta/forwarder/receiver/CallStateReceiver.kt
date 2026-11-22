package com.pta.forwarder.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log

/**
 * Holds the most recent incoming phone number.
 *
 * On Android 12 (API 31) and newer, [android.telephony.TelephonyCallback.CallStateListener]
 * no longer reports the caller's number -- the parameter was removed from the API.
 * The PHONE_STATE broadcast is still the only supported way to obtain it, and it is
 * populated only for apps that hold the READ_CALL_LOG permission.
 */
object CallNumberHolder {
    @Volatile
    var lastNumber: String? = null

    fun update(number: String?) {
        if (!number.isNullOrBlank() && !number.equals("Unknown", ignoreCase = true)) {
            lastNumber = number
        }
    }

    fun clear() {
        lastNumber = null
    }
}

class CallStateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CallStateReceiver"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)

        if (!number.isNullOrBlank()) {
            CallNumberHolder.update(number)
            Log.d(TAG, "Captured incoming number from PHONE_STATE broadcast")
        } else if (state == TelephonyManager.EXTRA_STATE_RINGING) {
            // Number missing: READ_CALL_LOG is most likely not granted.
            Log.w(TAG, "PHONE_STATE ringing with no number - check READ_CALL_LOG permission")
        }
    }
}
