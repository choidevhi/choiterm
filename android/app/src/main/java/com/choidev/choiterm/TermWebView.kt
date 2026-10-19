package com.choidev.choiterm

import android.content.Context
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import android.webkit.WebView

// Image MIME types offered to keyboards; without them Samsung's and Gboard's clipboard grey out
// images, since a WebView text box says it takes text only.
private val IMAGE_TYPES = arrayOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/*")

// A WebView whose text boxes also accept images from the keyboard (clipboard, stickers, GIFs).
// The image itself goes to `onImage`; the page only ever gets the uploaded file's path.
class TermWebView(context: Context) : WebView(context) {
    var onImage: ((InputContentInfo) -> Unit)? = null

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null

        outAttrs.contentMimeTypes = IMAGE_TYPES

        return object : InputConnectionWrapper(base, false) {
            override fun commitContent(info: InputContentInfo, flags: Int, opts: Bundle?): Boolean {
                val handler = onImage ?: return false

                if (flags and InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) {
                    if (runCatching { info.requestPermission() }.isFailure) return false
                }

                handler(info)

                return true
            }
        }
    }
}
