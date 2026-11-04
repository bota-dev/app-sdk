import 'dart:async';
import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:flutter/material.dart';
import 'controller.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SpeechCompanion());
}

class SpeechCompanion extends StatelessWidget {
  const SpeechCompanion({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Bota Conversation',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff215945)),
      scaffoldBackgroundColor: const Color(0xfff2f5f0),
    ),
    home: const ConversationPage(),
  );
}

class ConversationPage extends StatefulWidget {
  const ConversationPage({super.key});
  @override
  State<ConversationPage> createState() => _ConversationPageState();
}

class _ConversationPageState extends State<ConversationPage>
    with WidgetsBindingObserver {
  final model = CompanionController();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Permission dialogs can make iOS inactive. Only actual departure retires audio.
    if ([
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.detached,
    ].contains(state))
      unawaited(model.leave());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    model.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: model,
    builder: (context, _) => Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 840),
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  'BOTA / CONVERSATION',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
                const SizedBox(height: 12),
                Text(
                  'Speak. Listen. Stay in the conversation.',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 16),
                Text(model.notice, semanticsLabel: model.notice),
                const SizedBox(height: 16),
                if (!model.connected && !model.joining)
                  FilledButton(
                    onPressed: model.closing || model.cleanupFailed
                        ? null
                        : model.join,
                    child: const Text('Join session'),
                  ),
                if (model.joining) const LinearProgressIndicator(),
                if (model.connected || model.joining)
                  OutlinedButton(
                    onPressed: model.leave,
                    child: const Text('Leave'),
                  ),
                if (model.connected) ...[
                  SwitchListTile(
                    title: const Text('Microphone'),
                    value: model.input,
                    onChanged:
                        model.busy.contains('input') ||
                            model.busy.contains('finish')
                        ? null
                        : model.setInput,
                  ),
                  SwitchListTile(
                    title: const Text('Listening'),
                    value: model.listening,
                    onChanged: model.busy.contains('listen')
                        ? null
                        : model.setListening,
                  ),
                  Wrap(
                    spacing: 12,
                    children: [
                      OutlinedButton(
                        onPressed:
                            model.busy.contains('input') ||
                                model.busy.contains('finish')
                            ? null
                            : model.finish,
                        child: const Text('Finish input'),
                      ),
                      OutlinedButton(
                        onPressed: model.busy.contains('resume')
                            ? null
                            : model.resumeAudio,
                        child: const Text('Resume audio'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    initialValue: model.language,
                    decoration: const InputDecoration(
                      labelText: 'Receiving language',
                    ),
                    items: model.languages
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value.toUpperCase()),
                          ),
                        )
                        .toList(),
                    onChanged: model.busy.contains('selection')
                        ? null
                        : (value) {
                            if (value != null)
                              unawaited(model.select(value, model.mode));
                          },
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<BotaSpeechListeningMode>(
                    initialValue: model.mode,
                    decoration: const InputDecoration(
                      labelText: 'Listening mode',
                    ),
                    items: const [
                      DropdownMenuItem(
                        value: BotaSpeechListeningMode.translated,
                        child: Text('Translated'),
                      ),
                      DropdownMenuItem(
                        value: BotaSpeechListeningMode.original,
                        child: Text('Original'),
                      ),
                      DropdownMenuItem(
                        value: BotaSpeechListeningMode.captionsOnly,
                        child: Text('Captions only'),
                      ),
                    ],
                    onChanged: model.busy.contains('selection')
                        ? null
                        : (value) {
                            if (value != null)
                              unawaited(model.select(model.language, value));
                          },
                  ),
                ],
                const SizedBox(height: 24),
                Text(
                  'Conversation',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (model.connected)
                  TextButton(
                    onPressed: model.busy.contains('recover')
                        ? null
                        : model.recoverCaptions,
                    child: const Text('Recover captions'),
                  ),
                if (model.pairs.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 32),
                    child: Text(
                      'Original speech and its translation will appear together here.',
                    ),
                  ),
                for (final pair in model.pairs)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            pair.speaker,
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                          const SizedBox(height: 8),
                          if (pair.original.isNotEmpty)
                            SelectableText(pair.original),
                          if (pair.translation.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: SelectableText(
                                pair.translation,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                            ),
                          if (!pair.originalFinal) const Text('Live caption'),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
