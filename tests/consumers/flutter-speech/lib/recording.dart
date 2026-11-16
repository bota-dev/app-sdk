import 'dart:async';
import 'package:bota_app_sdk/bota_app_sdk.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class RecordingCompanion extends StatelessWidget {
  const RecordingCompanion({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Recording translation',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff215945)),
    ),
    home: const RecordingPage(),
  );
}

class RecordingPage extends StatefulWidget {
  const RecordingPage({super.key});
  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage>
    with WidgetsBindingObserver {
  static const host = MethodChannel('dev.bota.recording.companion/host');
  final client = BotaRecordingSpeechClient();
  BotaRecordingSpeechSession? session;
  final captions = <String, String>{};
  String notice = 'Ready', language = 'zh', finalText = '';
  bool busy = false,
      active = false,
      polling = false,
      cleanupFailed = false,
      disposing = false;
  int generation = 0;
  Timer? timer;
  Future<void>? closing;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  void change(void Function() update) {
    if (mounted && !disposing) setState(update);
  }

  Future<void> action(Future<void> Function() work) async {
    if (busy || cleanupFailed) return;
    change(() => busy = true);
    try {
      await work();
    } catch (_) {
      change(
        () => notice =
            'The operation could not complete. Original audio remains independent.',
      );
    } finally {
      change(() => busy = false);
    }
  }

  Future<void> start() async {
    final owner = ++generation;
    change(() {
      notice = 'Preparing microphone…';
      captions.clear();
      finalText = '';
    });
    final value = await host.invokeMapMethod<String, Object?>('prepare');
    if (generation != owner || !mounted) {
      await host.invokeMethod<void>('leave');
      return;
    }
    final id = value!['activityId']! as String;
    change(() {
      language = value['target']! as String;
      active = true;
      notice = 'Connecting…';
    });
    final acquired = await client.start(
      id,
      observer: BotaRecordingSpeechObserver(
        onStatus: (status) {
          if (generation == owner) change(() => notice = status);
        },
        onCaption: (caption) {
          if (generation != owner) return;
          change(() {
            captions['${caption.unitId}:${caption.targetLanguage ?? 'source'}'] =
                '[${caption.targetLanguage ?? caption.sourceLanguage}; revision ${caption.revision}${caption.isFinal ? '' : '; interim'}] ${caption.text}';
            if (captions.length > 100) captions.remove(captions.keys.first);
          });
        },
      ),
    );
    if (generation != owner || !mounted) {
      await acquired.close();
      return;
    }
    session = acquired;
    change(() {
      if (notice == 'Connecting…')
        notice = 'Microphone active. Live captions are provisional.';
    });
    timer = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (polling || generation != owner) return;
      polling = true;
      try {
        final view = await host.invokeMapMethod<String, Object?>('original');
        if (generation == owner &&
            view?['status'] is String &&
            view?['passages'] is List) {
          final passages = (view!['passages']! as List)
              .whereType<String>()
              .take(64);
          change(
            () => finalText = '${view['status']}\n${passages.join('\n\n')}',
          );
        }
      } catch (_) {
        /* Current capture and verified local originals are independent. */
      } finally {
        polling = false;
      }
    });
  }

  Future<void> close() {
    if (closing != null) return closing!;
    generation++;
    timer?.cancel();
    timer = null;
    session = null;
    change(() => active = false);
    final task = () async {
      var failed = false;
      try {
        await client.close();
      } catch (_) {
        failed = true;
      }
      try {
        await host.invokeMethod<void>('leave');
      } catch (_) {
        failed = true;
      }
      change(() {
        cleanupFailed = failed;
        notice = failed
            ? 'Cleanup failed. Reopen the App before starting another activity.'
            : 'Closed.';
      });
    }();
    closing = task.whenComplete(() => closing = null);
    return closing!;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached)
      unawaited(close());
  }

  @override
  void dispose() {
    disposing = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Recording translation')),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'One microphone. One translation language. Original audio is optional.',
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              children: [
                FilledButton(
                  onPressed: active || busy || cleanupFailed
                      ? null
                      : () => action(start),
                  child: const Text('Start microphone'),
                ),
                OutlinedButton(
                  onPressed: active || busy ? close : null,
                  child: const Text('Close'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            const Text('Translate to'),
            DropdownButton<String>(
              value: language,
              items: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de']
                  .map(
                    (value) =>
                        DropdownMenuItem(value: value, child: Text(value)),
                  )
                  .toList(),
              onChanged: session == null || busy
                  ? null
                  : (value) => action(() async {
                      change(() => notice = 'Changing language…');
                      await session!.changeTarget(value!);
                      change(() {
                        language = value;
                        notice = 'Language change acknowledged.';
                      });
                    }),
            ),
            Wrap(
              spacing: 10,
              children: [
                OutlinedButton(
                  onPressed: session == null || busy
                      ? null
                      : () => action(() async {
                          final enabled = await session!.qualifyHeadphones();
                          change(
                            () => notice = enabled
                                ? 'Headphone playback enabled.'
                                : 'Audio paused. Captions and original capture continue.',
                          );
                        }),
                  child: const Text('Confirm headphones'),
                ),
                OutlinedButton(
                  onPressed: session == null || busy
                      ? null
                      : () => action(() async {
                          await session!.finish();
                          change(
                            () => notice =
                                'Capture stopped. Original upload and final text continue.',
                          );
                        }),
                  child: const Text('Stop capture'),
                ),
              ],
            ),
            const Text(
              'Speaker playback is unavailable. Reconfirm headphones after a route change.',
            ),
            const SizedBox(height: 16),
            Semantics(liveRegion: true, child: Text(notice)),
            const SizedBox(height: 24),
            Text(
              'Live captions (provisional)',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            SelectableText(captions.values.join('\n')),
            const SizedBox(height: 24),
            Text(
              'Final original and translation',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            SelectableText(finalText),
          ],
        ),
      ),
    ),
  );
}
