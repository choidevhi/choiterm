package com.choidev.choiterm

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import kotlin.concurrent.thread

private const val APK_PATH = "/ChoiTerm.apk"
private const val CONNECT_TIMEOUT_MS = 15_000
private const val READ_TIMEOUT_MS = 60_000

// Only the APK one of the owner's own PCs hands out.
fun isUpdateUrl(url: String): Boolean = isOwnPage(url) && runCatching { URI(url).path }.getOrNull() == APK_PATH

// Whole percent of a download, or -1 while its size is unknown.
fun percentOf(read: Long, total: Long): Int = if (total <= 0) -1 else (read * 100 / total).toInt().coerceIn(0, 100)

// The app updates itself from the PC: the APK streams straight into an Android install session
// while the page shows how far it got, then Android's own install screen asks once. Android lets
// an app install others only with "install unknown apps" switched on for it; without that, its
// settings page opens first.
object Updater {
    const val ACTION = "com.choidev.choiterm.INSTALL_STATUS"

    // What the page hears, as JSON: progress, installing, done, error.
    @Volatile var report: (JSONObject) -> Unit = {}

    @Volatile private var busy = false

    // "started", "permission" (its settings page opened), "busy" or "refused".
    fun start(activity: Activity, url: String): String {
        if (!isUpdateUrl(url)) return "refused"

        if (!activity.packageManager.canRequestPackageInstalls()) {
            activity.runOnUiThread {
                runCatching { activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))) }
            }

            return "permission"
        }

        if (busy) return "busy"

        busy = true
        thread(name = "choiterm-update") {
            try {
                install(activity.applicationContext, url)
            } catch (error: Exception) {
                busy = false
                report(JSONObject().put("state", "error").put("message", error.message ?: "받지 못했어요"))
            }
        }

        return "started"
    }

    private fun install(context: Context, url: String) {
        val connection = URL(url).openConnection() as HttpURLConnection

        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS

        if (connection.responseCode != HttpURLConnection.HTTP_OK) throw IllegalStateException("PC가 APK를 주지 않았어요 (${connection.responseCode})")

        val total = connection.contentLengthLong
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(context.packageName) }
        val id = installer.createSession(params)

        installer.openSession(id).use { session ->
            connection.inputStream.use { input ->
                session.openWrite("ChoiTerm.apk", 0, if (total > 0) total else -1).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read = 0L
                    var shown = -2

                    while (true) {
                        val count = input.read(buffer)

                        if (count < 0) break

                        output.write(buffer, 0, count)
                        read += count

                        val percent = percentOf(read, total)

                        // A message per whole percent, not per buffer.
                        if (percent != shown) {
                            shown = percent
                            report(JSONObject().put("state", "progress").put("percent", percent))
                        }
                    }

                    session.fsync(output)
                }
            }

            report(JSONObject().put("state", "installing"))

            val status = Intent(context, InstallReceiver::class.java).setAction(ACTION)
            val pending = PendingIntent.getBroadcast(context, id, status, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)

            session.commit(pending.intentSender)
        }
    }

    fun finished(ok: Boolean, message: String?) {
        busy = false
        report(if (ok) JSONObject().put("state", "done") else JSONObject().put("state", "error").put("message", message ?: "설치하지 못했어요"))
    }
}

// Android's answer to the install session: its confirmation screen to show, or how it ended.
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // The typed form only exists from Android 13; the app runs from 12.
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                } ?: return

                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.finished(true, null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.finished(false, "설치를 취소했어요")
            else -> Updater.finished(false, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }
}
