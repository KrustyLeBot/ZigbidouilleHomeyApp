package com.bidouille.carhooks

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaBrowserCompat.MediaItem
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.MediaBrowserServiceCompat

/**
 * The Android Auto surface.
 *
 * Three load-bearing rules, so that whatever is playing keeps playing:
 *  1. never call requestAudioFocus() — the app plays nothing and has no reason to ask;
 *  2. never reach STATE_PLAYING — the most recently active session owns media key
 *     routing, steering wheel buttons included, and we must not steal it;
 *  3. no MediaStyle notification, no foreground service — stay out of the player stack.
 *
 * The session still has to be active, otherwise Android Auto refuses to talk to the
 * MediaBrowserService. That is unavoidable, but a session that never plays stays
 * behind the real player in the routing order.
 */
class CarHooksMediaService : MediaBrowserServiceCompat() {

    private lateinit var session: MediaSessionCompat
    private lateinit var store: WebhookStore
    private val idle = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        store = WebhookStore(this)

        session = MediaSessionCompat(this, "CarHooks").apply {
            setPlaybackState(stoppedState())
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
                    handleTap(mediaId)
                }

                // None of these may start anything.
                override fun onPlay() = Unit
                override fun onPause() = Unit
                override fun onStop() = Unit
            })
            isActive = true
        }
        sessionToken = session.sessionToken
    }

    override fun onDestroy() {
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    override fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?
    ): BrowserRoot {
        val extras = Bundle().apply {
            putBoolean(CONTENT_STYLE_SUPPORTED, true)
            putInt(CONTENT_STYLE_BROWSABLE_HINT, CONTENT_STYLE_GRID)
            putInt(CONTENT_STYLE_PLAYABLE_HINT, CONTENT_STYLE_GRID)
        }
        return BrowserRoot(ROOT_ID, extras)
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaItem>>) {
        if (parentId != ROOT_ID) {
            result.sendResult(mutableListOf())
            return
        }
        result.sendResult(ActionId.entries.map(::mediaItem).toMutableList())
    }

    private fun mediaItem(id: ActionId): MediaItem {
        val config = store.load(id)
        val subtitle = when {
            !config.isConfigured -> "URL à configurer sur le téléphone"
            else -> store.lastResult(id).orEmpty()
        }
        val description = MediaDescriptionCompat.Builder()
            .setMediaId(id.key)
            .setTitle(id.label)
            .setSubtitle(subtitle)
            .setIconUri(iconUri(id))
            .build()
        return MediaItem(description, MediaItem.FLAG_PLAYABLE)
    }

    private fun iconUri(id: ActionId): Uri {
        val res = if (id == ActionId.DEPART) R.drawable.ic_depart else R.drawable.ic_arrivee
        return Uri.parse("android.resource://$packageName/$res")
    }

    private fun handleTap(mediaId: String?) {
        val action = ActionId.fromKey(mediaId) ?: return

        // Answer SYNCHRONOUSLY, before returning: given no usable state, Android Auto
        // opens its "now playing" screen and waits there for a STATE_PLAYING that never
        // comes, which is the endless spinner. STATE_ERROR is the only channel AA reads
        // without opening the player, so it is what carries our feedback.
        feedback("${action.label} — envoi…")

        WebhookClient.fire(store.load(action)) { result ->
            store.setLastResult(action, result.message)
            feedback("${action.label} : ${result.message}")
            // Also refresh the tile subtitle, which persists after the banner is gone.
            notifyChildrenChanged(ROOT_ID)
            // Back to neutral once the message has been read, so no error banner stays
            // stuck to the app in the browse view.
            idle.removeCallbacksAndMessages(null)
            idle.postDelayed({ session.setPlaybackState(stoppedState()) }, 5000L)
        }
    }

    private fun feedback(message: String) {
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID)
                .setState(PlaybackStateCompat.STATE_ERROR, 0L, 0f)
                .setErrorMessage(PlaybackStateCompat.ERROR_CODE_APP_ERROR, message)
                .build()
        )
    }

    private fun stoppedState(): PlaybackStateCompat = PlaybackStateCompat.Builder()
        .setActions(PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID)
        .setState(PlaybackStateCompat.STATE_STOPPED, 0L, 0f)
        .build()

    private companion object {
        const val ROOT_ID = "carhooks_root"
        const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        const val CONTENT_STYLE_BROWSABLE_HINT = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
        const val CONTENT_STYLE_PLAYABLE_HINT = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        const val CONTENT_STYLE_GRID = 2
    }
}
