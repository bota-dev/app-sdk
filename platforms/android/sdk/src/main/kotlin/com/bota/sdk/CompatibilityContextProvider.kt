@file:Suppress("DEPRECATION")

package com.bota.sdk

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri

internal class CompatibilityContextProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.applicationContext?.let(Holder::install)
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    internal object Holder {
        @Volatile
        private var applicationContext: Context? = null

        fun install(context: Context) {
            applicationContext = context.applicationContext
        }

        fun require(): Context = applicationContext ?: throw BotaSdkException.UnsupportedOperation(
            "Android application context is unavailable; initialize the app before configuring BotaClient",
        )
    }
}
