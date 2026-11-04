package dev.bota.speech.companion

import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import android.os.Looper
import android.content.Intent
import android.net.Uri

@RunWith(RobolectricTestRunner::class)
@Config(application = CompanionApplication::class, sdk = [26])
class CompanionActivityTest {
    @Test fun exportedLauncherIgnoresIntentAuthority() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://untrusted.example/join?code=injected"))
            .putExtra("host", "https://untrusted.example").putExtra("code", "injected")
            .putExtra("autoJoin", true).putExtra("input", true)
        val controller = Robolectric.buildActivity(CompanionActivity::class.java, intent).create().start().resume().visible()
        val activity = controller.get()
        shadowOf(Looper.getMainLooper()).idle()
        fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup)
            (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
        val fields = children(activity.findViewById(android.R.id.content)).filterIsInstance<EditText>()
        assertEquals("", fields.single { it.hint == activity.getString(R.string.code) }.text.toString())
        assertEquals(activity.getString(R.string.default_host), fields.single { it.hint == activity.getString(R.string.host) }.text.toString())
        val state = (activity.application as CompanionApplication).model.state.value
        assertFalse(state.joining); assertFalse(state.connected); assertFalse(state.input); assertFalse(state.listening)
        controller.pause().stop().destroy()
    }

    @Test fun realActivityStartsSilentAndForgetsCodeOnDeparture() {
        val controller = Robolectric.buildActivity(CompanionActivity::class.java).create().start().resume().visible()
        val activity = controller.get()
        shadowOf(Looper.getMainLooper()).idle()
        fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup)
            (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
        val views = children(activity.findViewById(android.R.id.content))
        val code = views.filterIsInstance<EditText>().single { it.hint == activity.getString(R.string.code) }
        assertFalse(code.isSaveEnabled)
        code.setText("synthetic-access-code")
        val model = (activity.application as CompanionApplication).model
        assertFalse(model.state.value.connected); assertFalse(model.state.value.input); assertFalse(model.state.value.listening)
        assertTrue(views.filterIsInstance<Button>().single { it.text == activity.getString(R.string.join) }.isEnabled)
        controller.pause().stop(); shadowOf(Looper.getMainLooper()).idle()
        assertEquals("", code.text.toString()); assertFalse(model.state.value.connected)
        controller.destroy()
    }
}
