package com.choidev.choiterm

import android.app.Notification
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import kotlin.concurrent.thread

const val EXTRA_NOTICE = "notice"
const val EXTRA_INDEX = "index"
const val EXTRA_LABEL = "label"
const val EXTRA_SLOT = "slot"

private const val TIMEOUT_MS = 10_000
private const val RESULT_SHOWN_MS = 6_000L

// What the notification says once a button was pressed.
fun answerResult(status: Int, label: String): String = when (status) {
    200 -> "답했어요: $label"
    409 -> "이미 답했거나 지난 질문이에요"
    else -> "답하지 못했어요 ($status)"
}

// A button on a question's notification: tells the PC which choice was picked, and the PC presses
// that key in the session. The server takes it only with the ChoiTerm page's own origin.
class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val notice = intent.getLongExtra(EXTRA_NOTICE, -1)
        val index = intent.getIntExtra(EXTRA_INDEX, -1)
        val label = intent.getStringExtra(EXTRA_LABEL) ?: ""
        val slot = intent.getIntExtra(EXTRA_SLOT, 0)
        // The PC that asked; the main PC for a notification shown by an older version.
        loadHome(context)

        val base = intent.getStringExtra(EXTRA_BASE)?.let(::originOf) ?: Home.main

        if (notice < 0 || index < 0) return

        val done = goAsync()

        thread(name = "choiterm-answer") {
            val status = runCatching { post(base, notice, index) }.getOrDefault(0)
            val result = Notification.Builder(context, "answers")
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(answerResult(status, label))
                .setTimeoutAfter(RESULT_SHOWN_MS)
                .setAutoCancel(true)
                .build()

            context.getSystemService(NotificationManager::class.java).notify(slot, result)
            done.finish()
        }
    }

    private fun post(base: String, notice: Long, index: Int): Int {
        val home = URI(base)
        val connection = URL("${base}answer").openConnection() as HttpURLConnection

        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Origin", "${home.scheme}://${home.host}:${home.port}")
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(JSONObject().put("notice", notice).put("index", index).toString().toByteArray()) }

        val status = connection.responseCode

        connection.disconnect()

        return status
    }
}
