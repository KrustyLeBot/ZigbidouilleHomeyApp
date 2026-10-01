package com.bidouille.carhooks

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/** The only two actions for now. Single source of truth: the store, the
 *  settings screen and the car tiles all derive from this enum. */
enum class ActionId(val key: String, val label: String) {
    DEPART("depart", "DÉPART"),
    ARRIVEE("arrivee", "ARRIVÉE");

    companion object {
        fun fromKey(key: String?): ActionId? = entries.firstOrNull { it.key == key }
    }
}

data class ActionConfig(
    val id: ActionId,
    val url: String,
    val post: Boolean,
    val body: String
) {
    val isConfigured: Boolean get() = url.isNotBlank()
}

/** SharedPreferences store, one entry per action. Read fresh on every tap so
 *  editing a URL on the phone takes effect in the car immediately. */
class WebhookStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("carhooks", Context.MODE_PRIVATE)

    fun load(id: ActionId) = ActionConfig(
        id = id,
        url = prefs.getString("${id.key}_url", "").orEmpty().trim(),
        post = prefs.getBoolean("${id.key}_post", false),
        body = prefs.getString("${id.key}_body", "").orEmpty()
    )

    fun save(config: ActionConfig) {
        prefs.edit()
            .putString("${config.id.key}_url", config.url.trim())
            .putBoolean("${config.id.key}_post", config.post)
            .putString("${config.id.key}_body", config.body)
            .apply()
    }

    fun lastResult(id: ActionId): String? = prefs.getString("${id.key}_last", null)

    fun setLastResult(id: ActionId, text: String) {
        prefs.edit().putString("${id.key}_last", text).apply()
    }
}

data class WebhookResult(val ok: Boolean, val message: String)

/**
 * Plain HTTP send, off the main thread.
 *
 * No external dependency on purpose: firing a webhook needs a request and a
 * status code, and HttpURLConnection does that without adding OkHttp to an APK
 * that has to travel to the phone over whatever is at hand.
 */
object WebhookClient {

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    fun fire(config: ActionConfig, onResult: (WebhookResult) -> Unit) {
        if (!config.isConfigured) {
            onResult(WebhookResult(false, "Aucune URL configurée pour ${config.id.label}"))
            return
        }
        executor.execute {
            val result = runCatching { send(config) }
                .getOrElse { WebhookResult(false, "${clock.format(Date())} — échec : ${it.message}") }
            main.post { onResult(result) }
        }
    }

    private fun send(config: ActionConfig): WebhookResult {
        val connection = (URL(config.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 8000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "CarHooks/1.0")
        }
        try {
            if (config.post) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                val payload = config.body.ifBlank { "{}" }.toByteArray(Charsets.UTF_8)
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(payload.size)
                connection.outputStream.use { it.write(payload) }
            } else {
                connection.requestMethod = "GET"
            }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val snippet = stream?.bufferedReader()?.use(BufferedReader::readText)
                ?.trim()?.take(120).orEmpty()
            val time = clock.format(Date())

            return if (code in 200..299) {
                WebhookResult(true, "$time — OK ($code)")
            } else {
                WebhookResult(false, "$time — HTTP $code ${snippet}".trim())
            }
        } finally {
            connection.disconnect()
        }
    }
}
