package dev.bota.speech.companion

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.*
import dev.bota.sdk.speech.SpeechListeningMode
import dev.bota.sdk.speech.livekit.LiveKitSpeechMedia
import java.util.UUID
import kotlinx.coroutines.*

/** One process owner survives Activity replacement until native cleanup settles. */
class CompanionApplication : Application() {
    internal lateinit var model: CompanionModel
        private set
    override fun onCreate() {
        super.onCreate()
        model = CompanionModel({ LiveKitSpeechMedia.create(this, it) },
            { checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED })
    }
}

class CompanionActivity : Activity() {
    private val ui = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val model get() = (application as CompanionApplication).model
    private lateinit var form: LinearLayout
    private lateinit var controls: LinearLayout
    private lateinit var role: Spinner
    private lateinit var host: EditText
    private lateinit var code: EditText
    private lateinit var join: Button
    private lateinit var leave: Button
    private lateinit var input: Switch
    private lateinit var listening: Switch
    private lateinit var finish: Button
    private lateinit var resume: Button
    private lateinit var recover: Button
    private lateinit var language: Spinner
    private lateinit var mode: Spinner
    private lateinit var notice: TextView
    private lateinit var captions: LinearLayout
    private var rendering = false
    private var lastPairs: List<CaptionPair>? = null
    private var lastLanguages: List<String>? = null
    private var permissionOwner: UUID? = null
    private val green = Color.rgb(33, 89, 69)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = column().apply { setBackgroundColor(Color.rgb(242, 245, 240)); setPadding(dp(24), dp(24), dp(24), dp(24)) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                view.setPadding(dp(24) + bars.left, dp(24) + bars.top, dp(24) + bars.right, dp(24) + bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(dp(24), dp(24) + insets.systemWindowInsetTop, dp(24), dp(24) + insets.systemWindowInsetBottom)
            }
            insets
        }
        root.addView(label(R.string.brand, 13f).apply { setTextColor(green); setTypeface(null, Typeface.BOLD) })
        root.addView(label(R.string.headline, 28f).apply { setTypeface(null, Typeface.BOLD) })
        root.addView(label(R.string.intro, 15f))
        form = column()
        role = Spinner(this).apply { adapter = ArrayAdapter.createFromResource(this@CompanionActivity, R.array.roles, android.R.layout.simple_spinner_dropdown_item) }
        host = EditText(this).apply { setHint(R.string.host); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; setText(R.string.default_host) }
        code = EditText(this).apply {
            setHint(R.string.code); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        join = button(R.string.join) {
            val selectedCode = code.text.toString(); code.text.clear()
            val selectedRole = if (role.selectedItemPosition == 0) "a" else "b"
            ui.launch { model.join(host.text.toString(), selectedRole, selectedCode) }
        }
        listOf(role, host, code, join).forEach(form::addView); root.addView(form)
        notice = TextView(this).apply { textSize = 15f; setPadding(0, dp(14), 0, dp(14)) }
        root.addView(notice)
        leave = button(R.string.leave) { code.text.clear(); ui.launch { model.leave() } }; root.addView(leave)
        controls = column()
        input = Switch(this).apply {
            setText(R.string.microphone)
            setOnCheckedChangeListener { _, enabled ->
                if (!rendering) {
                    if (enabled && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        permissionOwner = model.owner
                        rendering = true; isChecked = false; rendering = false
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 10)
                    } else ui.launch { model.setInput(enabled) }
                }
            }
        }
        listening = Switch(this).apply {
            setText(R.string.listening)
            setOnCheckedChangeListener { _, enabled -> if (!rendering) ui.launch { model.setListening(enabled) } }
        }
        finish = button(R.string.finish) { ui.launch { model.finish() } }
        resume = button(R.string.resume) { ui.launch { model.resumeAudio() } }
        listOf(input, listening, finish, resume).forEach(controls::addView)
        controls.addView(label(R.string.language, 15f)); language = Spinner(this); controls.addView(language)
        controls.addView(label(R.string.mode, 15f))
        mode = Spinner(this).apply { adapter = ArrayAdapter.createFromResource(this@CompanionActivity, R.array.modes, android.R.layout.simple_spinner_dropdown_item) }
        controls.addView(mode)
        val modes = listOf(SpeechListeningMode.TRANSLATED, SpeechListeningMode.ORIGINAL, SpeechListeningMode.CAPTIONS_ONLY)
        language.onItemSelectedListener = selected {
            val desired = language.selectedItem as? String
            if (!rendering && desired != null && desired != model.state.value.language) ui.launch { model.select(desired, model.state.value.mode) }
        }
        mode.onItemSelectedListener = selected {
            val desired = modes[mode.selectedItemPosition]
            if (!rendering && desired != model.state.value.mode) ui.launch { model.select(model.state.value.language, desired) }
        }
        recover = button(R.string.recover) { ui.launch { model.recoverCaptions() } }; controls.addView(recover)
        root.addView(controls)
        root.addView(label(R.string.conversation, 22f))
        captions = column().apply { isSaveEnabled = false }; root.addView(captions)
        setContentView(ScrollView(this).apply { addView(root) })
        ui.launch { model.state.collect { render(it) } }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10) {
            val original = permissionOwner; permissionOwner = null
            if (original != null) ui.launch { model.setInput(true, original) }
        }
    }
    override fun onStop() {
        code.text.clear(); permissionOwner = null
        ui.launch(start = CoroutineStart.UNDISPATCHED) { model.leave() }
        super.onStop()
    }
    override fun onDestroy() { ui.cancel(); super.onDestroy() }

    private fun render(state: CompanionState) {
        rendering = true
        form.visibility = if (state.connected) View.GONE else View.VISIBLE
        val canJoin = !state.joining && !state.closing && !state.cleanupFailed
        listOf(role, host, code, join).forEach { it.isEnabled = canJoin }
        join.setText(if (state.joining) R.string.joining else R.string.join)
        leave.visibility = if (state.connected || state.joining) View.VISIBLE else View.GONE
        notice.text = state.notice
        controls.visibility = if (state.connected) View.VISIBLE else View.GONE
        input.isChecked = state.input; listening.isChecked = state.listening
        input.isEnabled = "input" !in state.busy && "finish" !in state.busy
        listening.isEnabled = "listen" !in state.busy
        finish.isEnabled = "finish" !in state.busy && "input" !in state.busy
        resume.isEnabled = "resume" !in state.busy; recover.isEnabled = "recovery" !in state.busy
        language.isEnabled = "selection" !in state.busy; mode.isEnabled = language.isEnabled
        if (lastLanguages != state.languages) {
            lastLanguages = state.languages
            language.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, state.languages)
        }
        language.setSelection(state.languages.indexOf(state.language).coerceAtLeast(0))
        mode.setSelection(listOf(SpeechListeningMode.TRANSLATED, SpeechListeningMode.ORIGINAL, SpeechListeningMode.CAPTIONS_ONLY).indexOf(state.mode))
        if (lastPairs != state.pairs) {
            lastPairs = state.pairs; captions.removeAllViews()
            if (state.pairs.isEmpty()) captions.addView(label(R.string.empty, 16f))
            state.pairs.forEach { pair ->
                val card = column().apply { setPadding(dp(16), dp(12), dp(16), dp(12)); setBackgroundColor(Color.WHITE) }
                card.addView(TextView(this).apply { text = pair.speaker; setTextColor(green); setTypeface(null, Typeface.BOLD) })
                if (pair.original.isNotEmpty()) card.addView(TextView(this).apply { text = pair.original; textSize = 17f; setTextIsSelectable(true) })
                if (pair.translation.isNotEmpty()) card.addView(TextView(this).apply { text = pair.translation; textSize = 20f; setTextIsSelectable(true) })
                if (!pair.originalFinal) card.addView(label(R.string.pending, 12f))
                captions.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            }
        }
        rendering = false
    }
    private fun selected(action: () -> Unit) = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = action()
        override fun onNothingSelected(parent: AdapterView<*>?) {}
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun label(resource: Int, size: Float) = TextView(this).apply { setText(resource); textSize = size; setPadding(0, dp(8), 0, dp(12)) }
    private fun button(resource: Int, action: () -> Unit) = Button(this).apply {
        setText(resource); backgroundTintList = ColorStateList.valueOf(green); setTextColor(Color.WHITE); setOnClickListener { action() }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
