package dev.bota.sdk.reactnative.localwifi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

/** Keeps the host process eligible for BLE callbacks; PLX remains the only GATT client. */
class BotaBleSessionService : Service() {
    internal companion object { var onPromotion: ((RuntimeException?) -> Unit)? = null }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = "bota_connected_device"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(channelId, "Connected device", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Bota Bluetooth")
            .setContentText("Maintaining your device connection")
            .setOngoing(true)
            .build()
        val confirm = onPromotion
        onPromotion = null
        try {
            startForeground(62712, notification)
            confirm?.invoke(null)
        } catch (failure: RuntimeException) {
            confirm?.invoke(failure)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }
}
