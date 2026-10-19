package com.choidev.choiterm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

const val EXTRA_SESSION = "session"
const val EXTRA_BASE = "base"

private const val STATUS_CHANNEL = "status"
private const val ANSWER_CHANNEL = "answers"
private const val STATUS_ID = 1
private const val PREFS = "notify"
private const val OLD_LAST_ID = "lastId"
private const val READ_TIMEOUT_MS = 90_000
private const val MACHINES_TIMEOUT_MS = 15_000
private const val MAX_BACKOFF_MS = 60_000L
private const val MACHINES_EVERY_MS = 10 * 60_000L

data class Notice(
    val id: Long,
    val session: String,
    val title: String,
    val kind: String,
    val text: String,
    // Button labels; tapping one answers the question in that session (the server knows the keys).
    val answers: List<String> = emptyList(),
    // The PC it came from (its page's origin), set by the listener rather than read from the line.
    val base: String = Home.main,
)

data class Machine(val name: String, val url: String)

// One `data:` line of the server's event stream; null for anything that is not a notice.
fun parseNotice(line: String): Notice? {
    if (!line.startsWith("data:")) return null

    return runCatching {
        val json = JSONObject(line.removePrefix("data:").trim())
        val answers = json.optJSONArray("answers")
        val labels = (0 until (answers?.length() ?: 0)).mapNotNull { answers?.optJSONObject(it)?.optString("label")?.takeIf(String::isNotEmpty) }

        Notice(json.getLong("id"), json.getString("session"), json.getString("title"), json.getString("kind"), json.getString("text"), labels)
    }.getOrNull()
}

// The owner's PCs running ChoiTerm, from a server's /machines; only ChoiTerm pages on the tailnet
// are kept, so the phone never connects anywhere else.
fun parseMachines(text: String): List<Machine> = runCatching {
    val list = JSONObject(text).getJSONArray("machines")

    (0 until list.length()).mapNotNull { index ->
        val entry = list.optJSONObject(index) ?: return@mapNotNull null
        val url = originOf(entry.optString("url")) ?: return@mapNotNull null

        Machine(entry.optString("name").ifEmpty { url }, url)
    }
}.getOrDefault(emptyList())

// With more than one PC the notification also says which one.
fun headline(notice: Notice, machine: String? = null): String {
    val what = when (notice.kind) {
        "done" -> "${notice.title} · 끝났어요"
        "question" -> "${notice.title} · 질문이 있어요"
        else -> "${notice.title} · 확인이 필요해요"
    }

    return if (machine.isNullOrEmpty()) what else "$machine · $what"
}

// Keeps one connection open to each of the owner's PCs so Claude's finished turns and questions
// reach the phone while the app is closed. Android only lets that live as a foreground service,
// hence the quiet status notification.
class NotifyService : Service() {
    @Volatile private var running = true
    private val listening = ConcurrentHashMap.newKeySet<String>()
    private val names = ConcurrentHashMap<String, String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        loadHome(this)

        val manager = getSystemService(NotificationManager::class.java)

        manager.createNotificationChannel(NotificationChannel(STATUS_CHANNEL, "연결 유지", NotificationManager.IMPORTANCE_MIN))
        manager.createNotificationChannel(NotificationChannel(ANSWER_CHANNEL, "답변과 질문", NotificationManager.IMPORTANCE_HIGH))

        val status = Notification.Builder(this, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("ChoiTerm 알림 대기 중")
            .setContentIntent(openApp(null, null, 0))
            .setOngoing(true)
            .build()

        startForeground(STATUS_ID, status, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        thread(name = "choiterm-machines", isDaemon = true) { watchMachines() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun openApp(session: String?, base: String?, request: Int): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        if (session != null) intent.putExtra(EXTRA_SESSION, session)
        if (base != null) intent.putExtra(EXTRA_BASE, base)

        return PendingIntent.getActivity(this, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    // Asks the PC the app last showed (or the main one) which PCs run ChoiTerm, now and every ten
    // minutes, and starts listening to each new one.
    private fun watchMachines() {
        while (running) {
            val home = rememberedHome(this)

            startListening(home)

            val main = Home.main
            val machines = fetchMachines(home) ?: if (home != main && main.isNotEmpty()) fetchMachines(main) else null

            for (machine in machines.orEmpty()) {
                names[machine.url] = machine.name
                startListening(machine.url)
            }

            var waited = 0L

            while (running && waited < MACHINES_EVERY_MS) {
                Thread.sleep(1_000)
                waited += 1_000
            }
        }
    }

    private fun fetchMachines(base: String): List<Machine>? = runCatching {
        val connection = URL("${base}machines").openConnection() as HttpURLConnection

        connection.connectTimeout = MACHINES_TIMEOUT_MS
        connection.readTimeout = MACHINES_TIMEOUT_MS

        val text = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }

        connection.disconnect()
        parseMachines(text)
    }.getOrNull()

    private fun startListening(base: String) {
        if (!listening.add(base)) return

        thread(name = "choiterm-events-$base", isDaemon = true) { listen(base) }
    }

    // Where this PC's stream left off. A PC heard for the first time starts from now (ids are
    // times), so it does not replay what it kept; the main PC keeps the id stored before there
    // were several.
    private fun lastId(base: String): Long {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = "$OLD_LAST_ID:$base"

        return when {
            prefs.contains(key) -> prefs.getLong(key, 0)
            base == Home.main && prefs.contains(OLD_LAST_ID) -> prefs.getLong(OLD_LAST_ID, 0)
            else -> System.currentTimeMillis()
        }
    }

    private fun listen(base: String) {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var backoff = 2_000L

        while (running) {
            try {
                val connection = URL("${base}events").openConnection() as HttpURLConnection

                connection.readTimeout = READ_TIMEOUT_MS
                connection.setRequestProperty("Accept", "text/event-stream")
                connection.setRequestProperty("Last-Event-ID", lastId(base).toString())

                BufferedReader(InputStreamReader(connection.inputStream, Charsets.UTF_8)).use { reader ->
                    backoff = 2_000L

                    while (running) {
                        val line = reader.readLine() ?: break
                        val notice = parseNotice(line)?.copy(base = base) ?: continue

                        prefs.edit().putLong("$OLD_LAST_ID:$base", notice.id).apply()
                        show(notice)
                    }
                }

                connection.disconnect()
            } catch (_: Exception) {
                // PC off, Tailscale down or the stream dropped: try again, waiting longer each time.
            }

            if (!running) return

            Thread.sleep(backoff)
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private fun show(notice: Notice) {
        // The page already shows it when the app is open on screen.
        if (MainActivity.visible) return

        val slot = (notice.base + notice.session).hashCode()
        val machine = if (listening.size > 1) names[notice.base] else null
        val builder = Notification.Builder(this, ANSWER_CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(headline(notice, machine))
            .setContentText(notice.text)
            .setStyle(Notification.BigTextStyle().bigText(notice.text))
            .setContentIntent(openApp(notice.session, notice.base, slot))
            .setAutoCancel(true)

        notice.answers.forEachIndexed { index, label ->
            val intent = Intent(this, AnswerReceiver::class.java)
                .putExtra(EXTRA_NOTICE, notice.id)
                .putExtra(EXTRA_INDEX, index)
                .putExtra(EXTRA_LABEL, label)
                .putExtra(EXTRA_SLOT, slot)
                .putExtra(EXTRA_BASE, notice.base)
            val pending = PendingIntent.getBroadcast(this, (notice.id * 4 + index).toInt(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

            builder.addAction(Notification.Action.Builder(null, label, pending).build())
        }

        getSystemService(NotificationManager::class.java).notify(slot, builder.build())
    }
}
