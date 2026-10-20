package com.neoxify.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * What the tunnel says in the notification shade, and when.
 *
 * Shared by both processes. The words are the app's, in the customer's
 * language: the main process writes them to a file whenever the language
 * or the "Notify me" setting changes (`setNotices` in the plugin), and the
 * :xray process reads them when it posts -- the same shared-directory
 * pattern as the tunnel's state file, for the same reason: there is no
 * object to call across the process boundary. Until the app has written
 * them, the English defaults below stand.
 *
 * Two kinds of notification, on two channels:
 *  - the ongoing one a VPN service must show while it holds the device
 *    (Xray only: WireGuard's service is the library's and shows none). It
 *    says "Starting the VPN" until the engine is up and that the VPN
 *    service is running after: a fact about the engine and no more. Not
 *    "VPN is on", which a customer reads as connected -- on a censored
 *    network the engine starts locally when the server cannot be reached
 *    -- and never "protected" or "connected", which only the app's own
 *    egress check may say;
 *  - "VPN turned off", once, when Android or another VPN app takes the
 *    tunnel away -- a change the customer did not make in Neoxify and
 *    would not otherwise see with the app in the background. Not while
 *    the app is in front (its own screen says it), and only with the
 *    setting on.
 */
internal object Notices {
    /** The ongoing notification's channel. The id the service has always
     * used, so an existing install keeps the customer's choices for it. */
    const val STATUS_CHANNEL = "neoxify-vpn"
    private const val CHANGES_CHANNEL = "neoxify-changes"
    /** The service's ongoing notification. */
    const val STATUS_ID = 1
    private const val TURNED_OFF_ID = 2

    private const val TAG = "NeoxifyNotices"

    class Text(
        val enabled: Boolean,
        val statusChannel: String,
        val changesChannel: String,
        val title: String,
        val starting: String,
        val on: String,
        val offTitle: String,
        val offBody: String,
    )

    private val ENGLISH = Text(
        enabled = true,
        statusChannel = "VPN status",
        changesChannel = "Connection changes",
        title = "Neoxify",
        starting = "Starting the VPN…",
        on = "The VPN service is running. Open Neoxify to check the connection.",
        offTitle = "VPN turned off",
        offBody = "Android or another VPN app turned off Neoxify's VPN. Open Neoxify to connect again.",
    )

    private fun file(context: Context) = File(context.filesDir, "notices.json")
    private fun frontFile(context: Context) = File(context.filesDir, "app-front")

    /** Saves the app's words and setting. Whole, so a reader sees the
     * previous file or this one. */
    fun write(context: Context, text: Text) {
        try {
            val json = JSONObject()
                .put("enabled", text.enabled)
                .put("statusChannel", text.statusChannel)
                .put("changesChannel", text.changesChannel)
                .put("title", text.title)
                .put("starting", text.starting)
                .put("on", text.on)
                .put("offTitle", text.offTitle)
                .put("offBody", text.offBody)
            val tmp = File(context.filesDir, "notices.json.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(file(context))) {
                file(context).writeText(json.toString())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not save the notification text", e)
        }
    }

    /** The app's words, or English where it has not said. A blank string
     * is taken as not said: a notification with no text is worse than one
     * in English. */
    fun read(context: Context): Text = try {
        val f = file(context)
        if (!f.exists()) {
            ENGLISH
        } else {
            val json = JSONObject(f.readText())
            fun text(key: String, fallback: String) =
                json.optString(key, "").takeIf { it.isNotBlank() } ?: fallback
            Text(
                enabled = json.optBoolean("enabled", ENGLISH.enabled),
                statusChannel = text("statusChannel", ENGLISH.statusChannel),
                changesChannel = text("changesChannel", ENGLISH.changesChannel),
                title = text("title", ENGLISH.title),
                starting = text("starting", ENGLISH.starting),
                on = text("on", ENGLISH.on),
                offTitle = text("offTitle", ENGLISH.offTitle),
                offBody = text("offBody", ENGLISH.offBody),
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not read the notification text", e)
        ENGLISH
    }

    /** How long the main process's word that the app is in front lasts.
     * It is renewed by the activity's resume and by every status the app
     * asks for (the plugin's `markFront`); the phone's main page asks at
     * least every 15 seconds. Past this, a main process that died in front
     * -- a crash, a force-stop -- no longer counts as in front, and the
     * tunnel's "turned off" notice is not held back for good by a file it
     * left behind. */
    const val FRONT_FRESH_MS = 20_000L

    /** Whether the app is in front, as the main process last said
     * (`setInFront`) within `FRONT_FRESH_MS`. A marker without a time --
     * an older build's -- is not. */
    fun appInFront(context: Context): Boolean = try {
        val f = frontFile(context)
        val at = if (f.exists()) f.readText().trim().toLongOrNull() else null
        at != null && (System.currentTimeMillis() - at) in 0L..FRONT_FRESH_MS
    } catch (e: Exception) {
        false
    }

    /** The app is in front now (its time written), or is not (removed). */
    fun setInFront(context: Context, front: Boolean) {
        try {
            if (front) frontFile(context).writeText(System.currentTimeMillis().toString()) else frontFile(context).delete()
        } catch (e: Exception) {
            Log.w(TAG, "could not record whether the app is in front", e)
        }
    }

    /** Opens the app where it was, from a tap on either notification. */
    private fun openApp(context: Context): PendingIntent? = try {
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "no way to open the app from a notification", e)
        null
    }

    private fun builder(context: Context, channel: String): Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, channel)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }

    /** The ongoing notification: "Starting the VPN" until the engine is
     * up (`up` false), that the service is running after. */
    fun status(context: Context, up: Boolean): Notification {
        val text = read(context)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Created again with the current language's name: Android keeps
            // the customer's settings for the id and takes the new name.
            manager.createNotificationChannel(
                NotificationChannel(STATUS_CHANNEL, text.statusChannel, NotificationManager.IMPORTANCE_LOW),
            )
        }
        val b = builder(context, STATUS_CHANNEL)
            .setContentTitle(text.title)
            .setContentText(if (up) text.on else text.starting)
            .setSmallIcon(R.drawable.ic_stat_neoxify)
            .setOngoing(true)
            .setShowWhen(false)
        openApp(context)?.let { b.setContentIntent(it) }
        return b.build()
    }

    /** Replaces the ongoing notification's text, for "the service is
     * running" once the engine is up. Best-effort: the tunnel does not
     * depend on it. */
    fun updateStatus(context: Context, up: Boolean) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(STATUS_ID, status(context, up))
        } catch (e: Exception) {
            Log.w(TAG, "could not update the VPN notification", e)
        }
    }

    /** "VPN turned off": Android or another VPN app took the tunnel away.
     * Nothing with the setting off, with the app in front, or where
     * Android is not showing this app's notifications. */
    fun postTurnedOff(context: Context) {
        try {
            val text = read(context)
            if (!text.enabled || appInFront(context)) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!manager.areNotificationsEnabled()) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANGES_CHANNEL, text.changesChannel, NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
            val b = builder(context, CHANGES_CHANNEL)
                .setContentTitle(text.offTitle)
                .setContentText(text.offBody)
                .setStyle(Notification.BigTextStyle().bigText(text.offBody))
                .setSmallIcon(R.drawable.ic_stat_neoxify)
                .setAutoCancel(true)
            openApp(context)?.let { b.setContentIntent(it) }
            manager.notify(TURNED_OFF_ID, b.build())
        } catch (e: Exception) {
            Log.w(TAG, "could not say the VPN was turned off", e)
        }
    }

    /** A connect is under way: an earlier "turned off" is out of date. */
    fun clearTurnedOff(context: Context) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(TURNED_OFF_ID)
        } catch (e: Exception) {
            Log.w(TAG, "could not clear the turned-off notice", e)
        }
    }
}
