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

@RunWith(RobolectricTestRunner::class)
@Config(application = CompanionApplication::class, sdk = [26])
class CompanionActivityTest {
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
