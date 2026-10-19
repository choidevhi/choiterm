package com.choidev.choiterm

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.InputContentInfo
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

private const val HOME_PREFS = "home"
private const val HOME_KEY = "url"
private const val MAIN_KEY = "main"

// The owner's main PC: entered on the first start, or built in (-Pchoiterm.home=https://pc.tailnet.ts.net:8449/).
// Empty until then, and the app asks for it.
object Home {
    @Volatile var main: String = BuildConfig.CHOITERM_HOME
}

fun loadHome(context: Context) {
    val prefs = context.getSharedPreferences(HOME_PREFS, Context.MODE_PRIVATE)
    // Versions before the setup screen kept only the PC shown last; it becomes the main one.
    val main = prefs.getString(MAIN_KEY, null) ?: prefs.getString(HOME_KEY, null)?.let(::normalizeHome)

    if (main != null) Home.main = main
}

// "https://pc.tailnet.ts.net:8449/" from what the owner typed (the port defaults to ChoiTerm's), or
// null when it is not a tailnet address.
fun normalizeHome(typed: String): String? {
    val text = typed.trim().let { if (it.contains("://")) it else "https://$it" }
    val target = runCatching { URI(text) }.getOrNull() ?: return null
    val host = target.host?.lowercase() ?: return null

    if (target.scheme != "https" || !host.endsWith(".ts.net") || host.count { it == '.' } < 3) return null

    return "https://$host:${if (target.port > 0) target.port else DEFAULT_PORT}/"
}

private const val DEFAULT_PORT = 8449

// Only ChoiTerm pages (any of the owner's PCs) stay in the app; any other link opens in the browser.
// Every PC on the owner's tailnet serves ChoiTerm at the same port, under the same tailnet name.
fun isOwnPage(url: String): Boolean {
    val home = runCatching { URI(Home.main) }.getOrNull() ?: return false
    val homeHost = home.host ?: return false
    val suffix = ".${homeHost.substringAfter('.')}"
    val target = runCatching { URI(url) }.getOrNull() ?: return false
    val host = target.host ?: return false
    val machine = host.removeSuffix(suffix)

    return target.scheme == home.scheme && target.port == home.port && host.endsWith(suffix) && machine.isNotEmpty() && !machine.contains('.')
}

// "https://host:port/" of a ChoiTerm page, or null for anything else.
fun originOf(url: String): String? {
    if (!isOwnPage(url)) return null

    val target = URI(url)

    return "${target.scheme}://${target.host}:${target.port}/"
}

// The PC whose page the app showed last, opened again on the next start.
fun rememberedHome(context: Context): String =
    context.getSharedPreferences(HOME_PREFS, Context.MODE_PRIVATE).getString(HOME_KEY, null)?.let(::originOf) ?: Home.main

private fun rememberHome(context: Context, origin: String) {
    context.getSharedPreferences(HOME_PREFS, Context.MODE_PRIVATE).edit().putString(HOME_KEY, origin).apply()
}

private const val PICK_FILES = 1
private const val ASK_NOTIFICATIONS = 2

class MainActivity : Activity() {
    private lateinit var web: TermWebView
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    // The origin of the ChoiTerm page on screen, for uploads and for opening a notice's session.
    @Volatile private var pageOrigin = Home.main

    // PCs that failed since the last page that loaded, so falling back never goes round in circles,
    // and what to tell the page that loads next about it.
    private val failedOrigins = mutableSetOf<String>()
    // The PC of the load under way, once it failed (its error page also "finishes").
    private var failingNow: String? = null
    private var lastGood: String? = null
    private var pendingNotice: String? = null

    @Deprecated("Platform Activity result; this app has no AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode != PICK_FILES) return

        val callback = pendingFiles ?: return
        val picked = mutableListOf<Uri>()
        val clips = data?.clipData

        if (resultCode == RESULT_OK && clips != null) {
            for (index in 0 until clips.itemCount) picked.add(clips.getItemAt(index).uri)
        } else if (resultCode == RESULT_OK) {
            data?.data?.let { picked.add(it) }
        }

        pendingFiles = null
        callback.onReceiveValue(picked.toTypedArray())
    }

    // A WebView shows no file picker by itself: the page's file input lands here.
    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            pendingFiles?.onReceiveValue(null)
            pendingFiles = callback

            val intent = Intent(Intent.ACTION_GET_CONTENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)

            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent.createChooser(intent, null), PICK_FILES)
                true
            } catch (_: ActivityNotFoundException) {
                pendingFiles = null
                false
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The DayNight theme brings a title bar, which would cover the page's session tabs.
        actionBar?.hide()

        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val background = if (dark) Color.parseColor("#262624") else Color.parseColor("#FAF9F5")

        web = TermWebView(this)
        web.onImage = { info -> thread(name = "choiterm-keyboard-image") { uploadKeyboardImage(info) } }
        web.setBackgroundColor(background)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.textZoom = 100
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.addJavascriptInterface(Bridge(), "ChoiTermApp")

        // Edge to edge: pad by the system bars, and by the keyboard while it is up, so the page's
        // tabs stay below the status bar and its input bar sits just above the keyboard. A WebView
        // draws under its own padding, so the padding goes on a frame around it.
        val frame = FrameLayout(this)

        frame.setBackgroundColor(background)
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        frame.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsets.Type.ime())

            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsets.CONSUMED
        }

        window.decorView.setBackgroundColor(background)
        setContentView(frame)

        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                goBack()
            }
        }

        loadHome(this)

        // Not set up yet: ask for the PC's address first.
        if (Home.main.isEmpty()) {
            web.loadDataWithBaseURL(null, setupPage(), "text/html", "utf-8", null)
            startForegroundService(Intent(this, NotifyService::class.java))

            return
        }

        val session = intent.getStringExtra(EXTRA_SESSION)
        val home = rememberedHome(this)
        val base = intent.getStringExtra(EXTRA_BASE)?.let(::originOf) ?: home

        pageOrigin = home

        when {
            session != null -> web.loadUrl("$base#open=${Uri.encode(session)}")
            savedInstanceState == null -> web.loadUrl(home)
            else -> web.restoreState(savedInstanceState)
        }

        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK_NOTIFICATIONS)
        }

        startForegroundService(Intent(this, NotifyService::class.java))
    }

    // An image from the keyboard: upload it to the PC like a 📎 file, then hand the page its path
    // for the input bar. The page itself never sees the image bytes.
    private fun uploadKeyboardImage(info: InputContentInfo) {
        val base = pageOrigin
        val home = URI(base)
        val mime = info.description.getMimeType(0) ?: "image/png"
        val ext = mime.substringAfter('/').replace("jpeg", "jpg").substringBefore(';')

        try {
            val bytes = contentResolver.openInputStream(info.contentUri)?.use { it.readBytes() } ?: error("no image data")
            val name = URLEncoder.encode("keyboard.$ext", "UTF-8")
            val connection = URL("${base}upload?name=$name").openConnection() as HttpURLConnection

            connection.requestMethod = "POST"
            connection.doOutput = true
            // The server takes uploads only from its own page's origin.
            connection.setRequestProperty("Origin", "${home.scheme}://${home.host}:${home.port}")
            connection.setRequestProperty("Content-Type", "application/octet-stream")
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }

            val reply = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val path = JSONObject(reply).getString("path")

            connection.disconnect()
            runOnUiThread {
                web.evaluateJavascript("window.choiterm && window.choiterm.addPaths(${JSONArray(listOf(path))})", null)
            }
        } catch (error: Exception) {
            val message = JSONObject.quote("이미지를 보내지 못했어요 (${error.message ?: error.javaClass.simpleName})")

            runOnUiThread { web.evaluateJavascript("window.choiterm && window.choiterm.notice($message)", null) }
        } finally {
            info.releasePermission()
        }
    }

    // A notification tapped while the app is already open: switch the page to that session, on the
    // PC it came from.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)

        val session = intent.getStringExtra(EXTRA_SESSION) ?: return
        val base = intent.getStringExtra(EXTRA_BASE)?.let(::originOf) ?: pageOrigin

        if (base == pageOrigin) {
            web.evaluateJavascript("window.choiterm && window.choiterm.open(${JSONObject.quote(session)})", null)
        } else {
            web.loadUrl("$base#open=${Uri.encode(session)}")
        }
    }

    // Called from the page: links in the terminal open in an app the owner picks.
    private inner class Bridge {
        // The setup page: the main PC's address, checked and kept, then opened.
        @JavascriptInterface
        fun setHome(typed: String): Boolean {
            val origin = normalizeHome(typed) ?: return false

            getSharedPreferences(HOME_PREFS, Context.MODE_PRIVATE).edit().putString(MAIN_KEY, origin).putString(HOME_KEY, origin).apply()
            Home.main = origin
            runOnUiThread {
                pageOrigin = origin
                web.loadUrl(origin)
            }

            return true
        }

        // From the offline page: type the address again.
        @JavascriptInterface
        fun resetHome() {
            runOnUiThread { web.loadDataWithBaseURL(null, setupPage(), "text/html", "utf-8", null) }
        }

        // The page checks it to tell an app that can switch PCs inside itself from an older one.
        @JavascriptInterface
        fun version(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        @JavascriptInterface
        fun openUrl(url: String) {
            val uri = Uri.parse(url)

            if (uri.scheme != "http" && uri.scheme != "https") return

            runOnUiThread {
                runCatching { startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW, uri), "링크 열기")) }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Back first closes what the page has open (viewer, gallery, side list, sheets), one layer at a
    // time. With only the terminal left the app goes to the background instead of closing, so
    // returning is instant.
    private fun goBack() {
        web.evaluateJavascript("window.choiterm && window.choiterm.back ? window.choiterm.back() === true : false") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    // The page tells the server who is using the terminal from its visibility, so pause and
    // resume the WebView with the app.
    override fun onResume() {
        super.onResume()
        visible = true
        web.onResume()
    }

    override fun onPause() {
        visible = false
        web.onPause()
        super.onPause()
    }

    companion object {
        // Read by NotifyService: while the app is on screen the page shows notices itself.
        @Volatile var visible = false
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isOwnPage(request.url.toString())) return false

            startActivity(Intent(Intent.ACTION_VIEW, request.url))

            return true
        }

        // The PC on screen is the one to open next time, and the one uploads go to; a PC that
        // answered with an error page is neither.
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (originOf(url) != null) failingNow = null
        }

        override fun onPageFinished(view: WebView, url: String) {
            val origin = originOf(url) ?: return

            if (origin == failingNow) return

            failedOrigins.clear()
            pageOrigin = origin
            lastGood = origin
            rememberHome(this@MainActivity, origin)

            val message = pendingNotice ?: return

            pendingNotice = null
            view.evaluateJavascript("window.choiterm && window.choiterm.notice(${JSONObject.quote(message)})", null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) unreachable(view, request.url.toString())
        }

        // A PC whose server is down still answers through Tailscale, with 502.
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 400) unreachable(view, request.url.toString())
        }
    }

    // A PC that does not answer never strands the app on an error page: it goes back to the last PC
    // that worked (else the main PC), says why, and that PC is the one opened next time. Only when
    // none answers is the offline page shown.
    private fun unreachable(view: WebView, url: String) {
        val failed = originOf(url) ?: pageOrigin

        // One failed load can report both an HTTP error and a load error.
        if (failed == failingNow) return

        failingNow = failed
        failedOrigins.add(failed)

        val fallback = listOfNotNull(lastGood, Home.main.ifEmpty { null }).firstOrNull { it !in failedOrigins }
        val name = URI(failed).host.substringBefore('.')

        if (fallback == null) {
            view.loadDataWithBaseURL(null, offlinePage(failed), "text/html", "utf-8", null)

            return
        }

        rememberHome(this, fallback)
        pendingNotice = "$name PC가 응답하지 않아 ${URI(fallback).host.substringBefore('.')}(으)로 돌아왔어요"
        view.loadUrl(fallback)
    }

    // `failed` is the PC that did not answer (a valid ChoiTerm origin, so safe inside the page);
    // when it is not the main PC, that one is offered too.
    private fun offlinePage(failed: String): String {
        val main = Home.main
        val other = if (failed != main && main.isNotEmpty()) """<button class="ghost" onclick="location.replace('$main')">기본 PC로</button>""" else ""

        return """
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: light dark; --bg: #FAF9F5; --text: #3D3D3A; --muted: #73726C; --accent: #C96442; }
          @media (prefers-color-scheme: dark) { :root { --bg: #262624; --text: #E8E6DC; --muted: #9C9A92; --accent: #D97757; } }
          body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
                 gap: 10px; background: var(--bg); color: var(--text); font: 15px system-ui, sans-serif; text-align: center; }
          p { margin: 0; } .muted { color: var(--muted); font-size: 13px; }
          button { margin-top: 12px; padding: 12px 28px; border: 0; border-radius: 12px; background: var(--accent);
                   color: var(--bg); font: 600 15px system-ui, sans-serif; }
          button.ghost { margin-top: 0; background: transparent; color: var(--accent); }
        </style>
        <p>PC에 연결할 수 없어요</p>
        <p class="muted">PC가 켜져 있고 Tailscale이 연결돼 있는지 확인해 주세요</p>
        <button onclick="location.replace('$failed')">다시 연결</button>
        $other
        <button class="ghost" onclick="ChoiTermApp.resetHome()">PC 주소 바꾸기</button>
        """.trimIndent()
    }

    // The first start: where the owner's PC is (its Tailscale address, which the PC's ChoiTerm shows).
    private fun setupPage(): String = """
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: light dark; --bg: #ffffff; --text: #0a0a0a; --muted: #737373; --line: #e5e5e5; --accent: #171717; --on: #fafafa; }
          @media (prefers-color-scheme: dark) { :root { --bg: #111111; --text: #e0e0e0; --muted: #a1a1a1; --line: #2a2a2a; --accent: #f5f5f5; --on: #111111; } }
          body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 0 24px;
                 box-sizing: border-box; background: var(--bg); color: var(--text); font: 15px system-ui, sans-serif; }
          h1 { margin: 0; font-size: 22px; } p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
          input { padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text); font: 16px ui-monospace, monospace; }
          button { padding: 13px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on); font: 600 15px system-ui, sans-serif; }
          .bad { color: #ef4444; font-size: 13px; min-height: 18px; }
        </style>
        <h1>ChoiTerm</h1>
        <p>PC의 ChoiTerm 주소를 넣어 주세요. PC에서 ChoiTerm을 열면 상태 줄과 README에 나오는 Tailscale 주소예요.</p>
        <input id="home" type="url" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="my-pc.tail1234.ts.net">
        <div class="bad" id="bad"></div>
        <button onclick="if (!ChoiTermApp.setHome(document.getElementById('home').value)) document.getElementById('bad').textContent = 'https://PC이름.tailnet이름.ts.net:8449 꼴의 주소가 아니에요'">연결</button>
        """.trimIndent()
}
