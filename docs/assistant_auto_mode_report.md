## Assistant Auto Mode and Frontend–Backend Integration

This report explains how the Flutter web frontend and the Node/Express backend work together to deliver the assistant UX, with a deep dive into auto mode chat. It includes a mind map-style flow diagram and key code excerpts.

### High-level architecture

- **Frontend (Flutter Web)**: `apps/web/flutter_app/lib`
  - UI scaffolding and assistant panel: `main.dart`, `widgets/assistant_panel.dart`
  - HTTP/SSE client: `api.dart` (uses `dio` and browser `EventSource`)
- **Backend (Express server)**: `apps/server/server.js`
  - Todo CRUD, search, indexing
  - Assistant endpoints (`/api/assistant/message` POST and `/api/assistant/message/stream` GET for SSE)
  - LLM orchestration (router, proposal generation, validation, repair, summary)
- **Data**: `data/`
  - Todos storage: `data/todos.json`
  - Audit trail: `data/audit.jsonl`

### End-to-end flow (mind map-style)

```mermaid
flowchart TD
  subgraph FE[Frontend (Flutter Web)]
    U[User types message] --> SND[send: api.assistantMessage(...)]
    SND -->|mode=auto/chat/plan + transcript| EVT[EventSource to GET /api/assistant/message/stream]
    EVT -->|onSummary| UI_SUM[Update placeholder bubble]
    EVT -->|onClarify| UI_CLAR[Show clarify question; store _pendingClarifyQuestion]
    EVT -->|result + done| UI_RES[Render final text + show ops list]
    UI_RES --> APPLY[Apply Selected -> POST /api/llm/apply]
  end

  subgraph BE[Backend (Express)]
    ROUTE[/app.get('/api/assistant/message/stream')/] --> MODE{mode}
    MODE -- chat --> CHATPROC[buildChatPrompt -> run model]
    CHATPROC --> SSE_SUM[send summary]
    CHATPROC --> SSE_RES[send result {text, operations: []}] --> SSE_DONE[send done]

    MODE -- auto --> ARouter[runRouter]
    ARouter -- decision=clarify --> SSE_CLAR[send clarify(question)] --> SSE_DONE
    ARouter -- decision=chat --> CHATPROC
    ARouter -- decision=plan --> PLAN

    MODE -- plan --> PLAN[Two-call pipeline]
    PLAN --> CALL1[Call #1: buildProposalPrompt -> model -> infer + validate]
    CALL1 -->|invalid| REPAIR[Repair attempt via buildRepairPrompt]
    CALL1 -->|validOps| CALL2[Call #2: buildConversationalSummaryPrompt -> model]
    CALL2 --> SSE_SUM
    CALL2 --> SSE_RES2[send result {text, operations: annotated}]
    SSE_RES2 --> SSE_DONE

    APPLY_SRV[/app.post('/api/llm/apply')/] --> MUTATE[Validate + mutate todos + refresh index]
  end

  FE -->|POST fallback on SSE error| POSTMSG[POST /api/assistant/message]
  POSTMSG -->|auto/chat/plan logic (non-streaming)| FE
```

### Key frontend pieces

- **Assistant client with SSE and auto mode** (`apps/web/flutter_app/lib/api.dart`):

```dart
Future<Map<String, dynamic>> assistantMessage(String message, {List<Map<String, String>> transcript = const [], bool streamSummary = false, String mode = 'plan', void Function(String text)? onSummary, void Function(String question)? onClarify, String? priorClarifyQuestion}) async {
  if (!streamSummary) {
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {'streamSummary': false, 'mode': mode, if (priorClarifyQuestion != null) 'clarify': {'question': priorClarifyQuestion}},
    });
    final map = Map<String, dynamic>.from(res.data as Map);
    if (onClarify != null && map['requiresClarification'] == true && map['question'] is String) {
      onClarify(map['question'] as String);
    }
    return map;
  }
  // Flutter Web: use EventSource against GET streaming endpoint
  final uri = Uri.parse('${api.options.baseUrl}/api/assistant/message/stream').replace(queryParameters: {
    'message': message,
    'transcript': transcript.isEmpty ? '[]' : jsonEncode(transcript),
    'mode': mode,
    if (priorClarifyQuestion != null) 'clarify': jsonEncode({'question': priorClarifyQuestion}),
  }).toString();

  final completer = Completer<Map<String, dynamic>>();
  try {
    final es = html.EventSource(uri);
    Map<String, dynamic>? result;
    // Future clarify listener (no-op until server emits it)
    es.addEventListener('clarify', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final q = (obj['question'] as String?) ?? '';
        if (onClarify != null && q.isNotEmpty) onClarify(q);
      } catch (_) {}
    });
    es.addEventListener('summary', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final text = (obj['text'] as String?) ?? '';
        if (onSummary != null && text.isNotEmpty) {
          onSummary(text);
        }
      } catch (_) {}
    });
    es.addEventListener('result', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        result = Map<String, dynamic>.from(jsonDecode(data) as Map);
      } catch (_) {}
    });
    es.addEventListener('done', (_) {
      es.close();
      completer.complete(result ?? {'text': '', 'operations': []});
    });
    es.addEventListener('error', (_) async {
      try { es.close(); } catch (_) {}
      if (!completer.isCompleted) {
        try {
          // Fallback to non-streaming POST on SSE error
          final res = await api.post('/api/assistant/message', data: {
            'message': message,
            'transcript': transcript,
            'options': {'streamSummary': false, 'mode': mode, if (priorClarifyQuestion != null) 'clarify': {'question': priorClarifyQuestion}},
          });
          completer.complete(Map<String, dynamic>.from(res.data as Map));
        } catch (e) {
          completer.completeError(Exception('sse_error'));
        }
      }
    });
  } catch (_) {
    // Fallback to non-streaming on any error
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {'streamSummary': false, 'mode': mode},
    });
    return Map<String, dynamic>.from(res.data as Map);
  }
  return completer.future;
}

Future<Map<String, dynamic>> applyOperations(List<Map<String, dynamic>> ops) async {
  final res = await api.post('/api/llm/apply', data: {'operations': ops});
  return Map<String, dynamic>.from(res.data as Map);
}
```

- **Sending a message and wiring UI updates** (`apps/web/flutter_app/lib/main.dart`):

```dart
Future<void> _sendAssistantMessage() async {
  final text = assistantCtrl.text.trim();
  if (text.isEmpty) return;
  setState(() {
    assistantTranscript.add({'role': 'user', 'text': text});
    assistantSending = true;
  });
  // Clear input immediately for snappier UX while preserving `text` captured above
  assistantCtrl.clear();
  // Insert a placeholder assistant bubble that we will update with streamed summary
  setState(() {
    assistantTranscript.add({'role': 'assistant', 'text': ''});
    assistantStreamingIndex = assistantTranscript.length - 1;
  });
  try {
    // Send last 3 turns and request streaming summary (server will fall back to JSON if not SSE)
    final recent = assistantTranscript.length <= 3 ? assistantTranscript : assistantTranscript.sublist(assistantTranscript.length - 3);
    final res = await api.assistantMessage(
      text,
      transcript: recent,
      streamSummary: true,
      mode: assistantMode,
      onSummary: (s) {
        // Update placeholder bubble with latest streamed text
        if (!mounted) return;
        setState(() {
          if (assistantStreamingIndex != null &&
              assistantStreamingIndex! >= 0 &&
              assistantStreamingIndex! < assistantTranscript.length) {
            assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': s};
          }
        });
      },
      onClarify: (q) {
        if (!mounted) return;
        setState(() {
          // Replace placeholder with clarify question if emitted
          if (assistantStreamingIndex != null &&
              assistantStreamingIndex! >= 0 &&
              assistantStreamingIndex! < assistantTranscript.length) {
            assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': q};
          } else {
            assistantTranscript.add({'role': 'assistant', 'text': q});
          }
          _pendingClarifyQuestion = q;
        });
      },
      priorClarifyQuestion: _pendingClarifyQuestion,
    );
    final reply = (res['text'] as String?) ?? '';
    final opsRaw = res['operations'] as List<dynamic>?;
    final ops = opsRaw == null
        ? <AnnotatedOp>[]
        : opsRaw.map((e) => AnnotatedOp.fromJson(e as Map<String, dynamic>)).toList();
    setState(() {
      if (reply.trim().isNotEmpty) {
        if (assistantStreamingIndex != null &&
            assistantStreamingIndex! >= 0 &&
            assistantStreamingIndex! < assistantTranscript.length) {
          assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': reply};
        } else {
          assistantTranscript.add({'role': 'assistant', 'text': reply});
        }
      }
      assistantStreamingIndex = null;
      assistantOps = ops;
      // Auto-check only valid ops
      assistantOpsChecked = List<bool>.generate(ops.length, (i) => ops[i].errors.isEmpty);
      assistantShowDiff = false;
      _pendingClarifyQuestion = null;
    });
  } catch (e) {
    setState(() {
      final errText = 'Sorry, I could not process that. (${e.toString()})';
      if (assistantStreamingIndex != null &&
          assistantStreamingIndex! >= 0 &&
          assistantStreamingIndex! < assistantTranscript.length) {
        assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': errText};
      } else {
        assistantTranscript.add({'role': 'assistant', 'text': errText});
      }
      assistantStreamingIndex = null;
    });
  } finally {
    setState(() => assistantSending = false);
  }
}
```

- **User-selectable modes (Auto/Chat/Plan)** (`apps/web/flutter_app/lib/widgets/assistant_panel.dart`):

```dart
SegmentedButton<String>(
  segments: const [
    ButtonSegment(value: 'auto', label: Text('Auto')),
    ButtonSegment(value: 'chat', label: Text('Chat')),
    ButtonSegment(value: 'plan', label: Text('Plan')),
  ],
  selected: <String>{mode!},
  onSelectionChanged: (s) {
    if (s.isNotEmpty) onModeChanged!(s.first);
  },
)
```

### Key backend pieces

- **Feature flag for auto mode**:

```js
const AUTO_MODE_ENABLED = String(process.env.ASSISTANT_AUTO_MODE_ENABLED || 'true').toLowerCase() !== 'false';
```

- **Router prompt and decisioning** (auto mode):

```js
function buildRouterPrompt({ instruction, transcript, clarify }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are an intent router for a todo assistant. Output JSON only with fields:\n` +
    `decision: one of [\"chat\", \"plan\", \"clarify\"],\n` +
    `category: one of [\"habit\", \"goal\", \"task\", \"event\"],\n` +
    `entities: object, missing: array, confidence: number 0..1, question: string (required when decision=clarify).\n` +
    `If the instruction is ambiguous about time/date or target, choose clarify and ask ONE short question. No prose.\n` +
    `If the user asks to change all items in a clear scope (e.g., \"all today\", \"all of them\", \"everything this week\"), prefer plan.\n` +
    `If a prior clarify question is present, interpret short answers like \"all of them\", \"yes\", \"all today\" as resolving that question and prefer plan.\n` +
    `Use the Context section below (this week Mon–Sun anchored to today, backlog sample, completed=false).`;
  const prior = clarify && clarify.question ? `\nPrior clarify question: ${clarify.question}` : '';
  const snapshots = buildRouterSnapshots();
  const contextJson = JSON.stringify(snapshots);
  const user = `Today: ${todayYmd} (${TIMEZONE})\nTranscript (last 3):\n${convo}${prior}\nContext (this week, Mon–Sun, master-level, backlog sample, completed=false):\n${contextJson}\nUser: ${instruction}`;
  return `${system}\n\n${user}`;
}

async function runRouter({ instruction, transcript, clarify }) {
  try {
    const prompt = buildRouterPrompt({ instruction, transcript, clarify });
    const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
    const body = extractResponseBody(raw);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed = tryParse(body);
    if (!parsed && /```/.test(body)) {
      parsed = tryParse(body.replace(/```json|```/g, '').trim());
    }
    if (parsed && typeof parsed === 'object') {
      const result = {
        decision: String(parsed.decision || 'plan').toLowerCase(),
        category: parsed.category,
        entities: parsed.entities,
        missing: parsed.missing,
        confidence: Number(parsed.confidence || 0),
        question: parsed.question,
      };
      if (result.decision === 'clarify') {
        try {
          const snapshots = buildRouterSnapshots();
          const cands = topClarifyCandidates(instruction, snapshots, 5);
          if (cands.length) {
            const bullets = cands
              .map(c => `#${c.id} “${String(c.title).slice(0, 40)}”${c.scheduledFor ? ` @${c.scheduledFor}` : ''}`)
              .join('; ');
            const q = result.question && String(result.question).trim().length > 0
              ? result.question
              : 'Which item do you mean?';
            result.question = `${q} Options: ${bullets}.`;
          }
        } catch {}
      }
      return result;
    }
  } catch {}
  return { decision: 'plan', confidence: 0 };
}
```

- **Chat prompt**:

```js
function buildChatPrompt({ instruction, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; allow a short paragraph when needed. No markdown, no lists.`;
  const context = `Conversation (last 3 turns):\n${convo}\n\nToday: ${todayYmd} (${TIMEZONE})`;
  const user = `User message:\n${instruction}`;
  const task = `Respond helpfully and concretely. Do not output JSON.`;
  return `${system}\n\n${context}\n\n${user}\n\n${task}`;
}
```

- **Assistant endpoints (non-streaming and SSE)**:

```js
app.post('/api/assistant/message', async (req, res) => {
  try {
    const { message, transcript = [], options = {} } = req.body || {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    const mode = String((options && options.mode) || 'plan').toLowerCase();

    // Router branch for auto mode
    if (mode === 'auto' && AUTO_MODE_ENABLED) {
      const route = await runRouter({ instruction: message.trim(), transcript, clarify: options && options.clarify });
      try { appendAudit({ action: 'router_decision', mode: 'post', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
      if (route.decision === 'clarify' && route.question) {
        return res.json({ requiresClarification: true, question: route.question });
      } else if (route.decision === 'chat') {
        try {
          const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
          const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
          let s = stripGraniteTags(String(raw || ''));
          s = s.replace(/```[\s\S]*?```/g, '').trim();
          s = s.replace(/[\r\n]+/g, ' ').trim();
          const text = s || 'Okay.';
          return res.json({ text, operations: [] });
        } catch (e) {
          return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) });
        }
      }
      // else fall through to plan path
    }

    // Chat-only mode: single LLM call, no operations
    if (mode === 'chat') {
      try {
        const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let s = stripGraniteTags(String(raw || ''));
        s = s.replace(/```[\s\S]*?```/g, '').trim();
        s = s.replace(/[\r\n]+/g, ' ').trim();
        const text = s || 'Okay.';
        return res.json({ text, operations: [] });
      } catch (e) {
        return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) });
      }
    }

    // ... Plan path continues (two-call pipeline with proposal, validation/repair, and summary)

  } catch (err) {
    res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) });
  }
});
```

```js
// SSE-friendly GET endpoint for browsers (streams summary and final result)
app.get('/api/assistant/message/stream', async (req, res) => {
  try {
    const message = String(req.query.message || '');
    const transcriptParam = req.query.transcript;
    const transcript = (() => {
      try { return Array.isArray(transcriptParam) ? transcriptParam : JSON.parse(String(transcriptParam || '[]')); } catch { return []; }
    })();
    if (message.trim() === '') return res.status(400).json({ error: 'invalid_message' });
    const mode = String(req.query.mode || 'plan').toLowerCase();

    if (mode === 'chat') {
      try {
        const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let s = stripGraniteTags(String(raw || ''));
        s = s.replace(/```[\s\S]*?```/g, '').trim();
        s = s.replace(/[\r\n]+/g, ' ').trim();
        const text = s || 'Okay.';

        // Stream SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
        send('summary', JSON.stringify({ text }));
        send('result', JSON.stringify({ text, operations: [] }));
        send('done', 'true');
        return res.end();
      } catch (e) {
        try { return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) }); } catch {}
      }
    }

    if (mode === 'auto' && AUTO_MODE_ENABLED) {
      const clarify = (() => { try { return JSON.parse(String(req.query.clarify || 'null')); } catch { return null; } })();
      const route = await runRouter({ instruction: message.trim(), transcript, clarify });
      try { appendAudit({ action: 'router_decision', mode: 'sse', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
      if (route.decision === 'clarify' && route.question) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
        send('clarify', JSON.stringify({ question: route.question }));
        send('done', 'true');
        return res.end();
      } else if (route.decision === 'chat') {
        try {
          const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
          const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
          let s = stripGraniteTags(String(raw || ''));
          s = s.replace(/```[\s\S]*?```/g, '').trim();
          s = s.replace(/[\r\n]+/g, ' ').trim();
          const text = s || 'Okay.';
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
          send('summary', JSON.stringify({ text }));
          send('result', JSON.stringify({ text, operations: [] }));
          send('done', 'true');
          return res.end();
        } catch (e) {
          try { return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) }); } catch {}
        }
      }
      // else fall through to plan path; plan branch will set SSE headers below
    }

    // Establish SSE for plan path
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
    send('summary', JSON.stringify({ text: 'Planning…' }));
    const heartbeat = setInterval(() => {
      try { send('heartbeat', JSON.stringify({ ts: new Date().toISOString() })); } catch {}
    }, 10000);
    res.on('close', () => { try { clearInterval(heartbeat); } catch {} });

    // Call 1 — generate operations
    const topK = todosIndex.searchByQuery('', { k: 40 });
    const aggregates = todosIndex.getAggregates();
    const prompt1 = buildProposalPrompt({ instruction: message.trim(), todosSnapshot: { topK, aggregates }, transcript });
    const raw1 = await runOllamaWithThinkingIfGranite({ userContent: prompt1 });
    const raw1MaybeResponse = extractResponseBody(raw1);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed1 = tryParse(raw1MaybeResponse);
    if (!parsed1 && /```/.test(raw1MaybeResponse)) {
      const inner = raw1MaybeResponse.replace(/```json|```/g, '').trim();
      parsed1 = tryParse(inner);
    }
    if (!parsed1) {
      const s = raw1MaybeResponse;
      const start = s.indexOf('{');
      if (start !== -1) {
        let depth = 0; let end = -1;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) parsed1 = tryParse(s.slice(start, end + 1));
      }
    }
    let ops = [];
    if (Array.isArray(parsed1)) ops = parsed1;
    else if (parsed1 && Array.isArray(parsed1.operations)) ops = parsed1.operations;
    else if (parsed1 && Array.isArray(parsed1.actions)) ops = parsed1.actions;
    if (!ops.length && parsed1 && typeof parsed1 === 'object') ops = [parsed1];
    ops = ops.filter(o => o && typeof o === 'object').map(o => {
      const m = { ...o };
      if (!m.op && typeof m.action === 'string') m.op = m.action;
      if (!m.op && typeof m.type === 'string') m.op = m.type;
      return inferOperationShape(m);
    }).filter(Boolean);

    let validation = validateProposal({ operations: ops });
    let annotatedAll = validation.results.map(r => ({ op: r.op, errors: r.errors }));
    try {
      const summary = {
        valid: validation.results.filter(r => r.errors.length === 0).length,
        invalid: validation.results.filter(r => r.errors.length > 0).length,
      };
      appendAudit({ action: 'assistant_understanding', results: annotatedAll, summary });
    } catch {}
    let validOps = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
    if (validation.errors.length) {
      try { appendAudit({ action: 'repair_attempted', mode: 'sse', invalid_ops: validation.results.filter(r => r.errors.length > 0).length }); } catch {}
      try {
        const repairPrompt = buildRepairPrompt({ instruction: message.trim(), originalOps: ops, errors: validation.results, transcript });
        const rawRepair = await runOllamaWithThinkingIfGranite({ userContent: repairPrompt });
        const body = extractResponseBody(rawRepair);
        const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
        let parsedR = tryParse(body);
        if (!parsedR && /```/.test(body)) parsedR = tryParse(body.replace(/```json|```/g, '').trim());
        const repairedOps = (parsedR && Array.isArray(parsedR.operations)) ? parsedR.operations : [];
        const shaped = repairedOps.filter(o => o && typeof o === 'object').map(o => inferOperationShape(o)).filter(Boolean);
        const reValidation = validateProposal({ operations: shaped });
        if (!reValidation.errors.length) {
          validOps = shaped;
          validation = reValidation;
          annotatedAll = reValidation.results.map(r => ({ op: r.op, errors: r.errors }));
          try { appendAudit({ action: 'repair_success', mode: 'sse', repaired_ops: shaped.length }); } catch {}
        } else {
          try { appendAudit({ action: 'repair_failed', mode: 'sse', remaining_invalid: reValidation.results.filter(r => r.errors.length > 0).length }); } catch {}
        }
      } catch {
        try { appendAudit({ action: 'repair_error', mode: 'sse' }); } catch {}
      }
    }

    // Call 2 — conversational summary
    let text;
    try {
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: validOps, todosSnapshot: todos, transcript });
      const raw2 = await runOllamaWithThinkingIfGranite({ userContent: prompt2 });
      let s2 = stripGraniteTags(String(raw2 || ''));
      s2 = s2.replace(/```[\s\S]*?```/g, '').trim();
      s2 = s2.replace(/[\r\n]+/g, ' ').trim();
      if (!s2) throw new Error('empty_text');
      text = s2;
    } catch (e) {
      text = buildDeterministicSummaryText(validOps);
      appendAudit({ action: 'assistant_message', conversational_fallback: true, error: String(e && e.message ? e.message : e) });
    }

    // Stream SSE (headers already set)
    send('summary', JSON.stringify({ text }));
    send('result', JSON.stringify({ text, operations: annotatedAll }));
    send('done', 'true');
    try { clearInterval(heartbeat); } catch {}
    return res.end();
  } catch (err) {
    try { res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) }); } catch {}
  }
});
```

- **Two-call plan pipeline summary prompt**:

```js
function buildConversationalSummaryPrompt({ instruction, operations, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const compactOps = operations.map((op) => {
    const parts = [];
    parts.push(op.op);
    if (Number.isFinite(op.id)) parts.push(`#${op.id}`);
    if (op.title) parts.push(`“${String(op.title).slice(0, 60)}”`);
    if (op.scheduledFor !== undefined) parts.push(`@${op.scheduledFor === null ? 'unscheduled' : op.scheduledFor}`);
    if (op.priority) parts.push(`prio:${op.priority}`);
    if (typeof op.completed === 'boolean') parts.push(op.completed ? '[done]' : '[undone]');
    return `- ${parts.join(' ')}`;
  }).join('\n');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; allow a short paragraph when needed. No markdown, no lists, no JSON.`;
  const context = `Conversation (last 3 turns):\n${convo}\n\nToday: ${todayYmd} (${TIMEZONE})\nProposed operations (count: ${operations.length}):\n${compactOps}`;
  const user = `User instruction:\n${instruction}`;
  const task = `Summarize the plan in plain English grounded in the proposed operations above. If there are no valid operations, briefly explain and suggest what to clarify.`;
  return `${system}\n\n${context}\n\n${user}\n\n${task}`;
}
```

- **Operation shaping and validation**:

```js
function validateProposal(body) {
  if (!body || typeof body !== 'object') return { errors: ['invalid_body'] };
  const operations = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length) return { errors: ['missing_operations'], operations: [] };
  const results = operations.map(o => ({ op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  return { operations, results, errors: invalid.length ? ['invalid_operations'] : [] };
}

function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  const op = { ...o };
  if (!op.op) {
    const hasId = Number.isFinite(op.id);
    const hasCompleted = typeof op.completed === 'boolean';
    const hasTitleOrNotesOrSchedOrPrio = !!(op.title || op.notes || (op.scheduledFor !== undefined) || op.priority);
    if (!hasId && (op.title || op.scheduledFor !== undefined || op.priority)) {
      op.op = 'create';
      delete op.id; // ignore LLM-provided id on create
    } else if (hasId && hasCompleted && !hasTitleOrNotesOrSchedOrPrio) {
      op.op = 'complete';
    } else if (hasId && hasTitleOrNotesOrSchedOrPrio) {
      op.op = 'update';
    }
  }
  // Normalize fields
  if (op.priority && typeof op.priority === 'string') op.priority = op.priority.toLowerCase();
  if (op.scheduledFor === '') op.scheduledFor = null;
  return op;
}
```

- **Applying selected operations**:

```js
app.post('/api/llm/apply', async (req, res) => {
  const { operations } = req.body || {};
  const validation = validateProposal({ operations });
  if (validation.errors.length) {
    return res.status(400).json({ error: 'invalid_operations', detail: validation, message: 'Some operations were invalid. The assistant may be attempting unsupported or inconsistent changes.' });
  }
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  await withApplyLock(async () => {
    for (const op of operations) {
      try {
        if (op.op === 'create') {
          const t = createTodo({ title: String(op.title || '').trim(), notes: op.notes || '', scheduledFor: op.scheduledFor ?? null, priority: op.priority || 'medium', timeOfDay: (op.timeOfDay === '' ? null : op.timeOfDay) ?? null, recurrence: op.recurrence });
          todos.push(t); saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); created++;
          appendAudit({ action: 'create', op, result: 'ok', id: t.id });
        } else if (op.op === 'update') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          const now = new Date().toISOString();
          if (op.title !== undefined) t.title = op.title;
          if (op.notes !== undefined) t.notes = op.notes;
          if (op.scheduledFor !== undefined) t.scheduledFor = op.scheduledFor;
          if (op.priority !== undefined) t.priority = op.priority;
          if (op.completed !== undefined) t.completed = !!op.completed;
          if (op.timeOfDay !== undefined) t.timeOfDay = (op.timeOfDay === '' ? null : op.timeOfDay);
          if (op.recurrence !== undefined) {
            const prevType = t.recurrence?.type || 'none';
            t.recurrence = { ...t.recurrence, ...op.recurrence };
            if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
            if (prevType !== 'none' && t.recurrence.type === 'none') {
              t.completedDates = [];
            } else if (t.recurrence.type !== 'none') {
              if (!Array.isArray(t.completedDates)) t.completedDates = [];
            }
          }
          t.updatedAt = now; saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); updated++;
          appendAudit({ action: 'update', op, result: 'ok', id: t.id });
        } else if (op.op === 'delete') {
          const idx = todos.findIndex(t => t.id === op.id); if (idx === -1) throw new Error('not_found');
          const removed = todos.splice(idx, 1)[0]; saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op }); deleted++;
          appendAudit({ action: 'delete', op, result: 'ok', id: removed?.id });
        } else if (op.op === 'complete') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          t.completed = op.completed === undefined ? true : !!op.completed; t.updatedAt = new Date().toISOString();
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete', op, result: 'ok', id: t.id });
        } else if (op.op === 'complete_occurrence') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          if (!(t.recurrence && t.recurrence.type && t.recurrence.type !== 'none')) throw new Error('not_repeating');
          if (!Array.isArray(t.completedDates)) t.completedDates = [];
          const idx = t.completedDates.indexOf(op.occurrenceDate);
          const shouldComplete = (op.completed === undefined) ? true : !!op.completed;
          if (shouldComplete) { if (idx === -1) t.completedDates.push(op.occurrenceDate); }
          else { if (idx !== -1) t.completedDates.splice(idx, 1); }
          t.updatedAt = new Date().toISOString(); saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete_occurrence', op, result: 'ok', id: t.id });
        } else if (op.op === 'bulk_update') {
          // Expand where to concrete ids, then apply updates item-wise
          const targets = todosIndex.filterByWhere(op.where || {});
          const set = op.set || {};
          for (const t of targets) {
            const tt = findTodoById(t.id); if (!tt) continue;
            const now2 = new Date().toISOString();
            if (set.title !== undefined) tt.title = set.title;
            if (set.notes !== undefined) tt.notes = set.notes;
            if (set.scheduledFor !== undefined) tt.scheduledFor = set.scheduledFor;
            if (set.priority !== undefined) tt.priority = set.priority;
            if (set.completed !== undefined) tt.completed = !!set.completed;
            if (set.timeOfDay !== undefined) tt.timeOfDay = (set.timeOfDay === '' ? null : set.timeOfDay);
            if (set.recurrence !== undefined) {
              const prevType = tt.recurrence?.type || 'none';
              tt.recurrence = { ...tt.recurrence, ...set.recurrence };
              if (tt.recurrence.until === undefined) tt.recurrence.until = endOfCurrentYearYmd();
              if (prevType !== 'none' && tt.recurrence.type === 'none') {
                tt.completedDates = [];
              } else if (tt.recurrence.type !== 'none') {
                if (!Array.isArray(tt.completedDates)) tt.completedDates = [];
              }
            }
            tt.updatedAt = now2;
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ;
          results.push({ ok: true, op, count: targets.length, expandedIds: targets.map(t => t.id) });
          updated += targets.length;
          appendAudit({ action: 'bulk_update', op, result: 'ok', expandedIds: targets.map(t => t.id) });
        } else if (op.op === 'bulk_complete') {
          const targets = todosIndex.filterByWhere(op.where || {});
          for (const t of targets) {
            const tt = findTodoById(t.id); if (!tt) continue;
            tt.completed = op.completed === undefined ? true : !!op.completed;
            tt.updatedAt = new Date().toISOString();
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ;
          results.push({ ok: true, op, count: targets.length, expandedIds: targets.map(t => t.id) });
          completed += targets.length;
          appendAudit({ action: 'bulk_complete', op, result: 'ok', expandedIds: targets.map(t => t.id) });
        } else if (op.op === 'bulk_delete') {
          const targets = todosIndex.filterByWhere(op.where || {});
          const ids = new Set(targets.map(t => t.id));
          let removedCount = 0;
          for (let i = todos.length - 1; i >= 0; i--) {
            if (ids.has(todos[i].id)) { todos.splice(i, 1); removedCount++; }
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
          results.push({ ok: true, op, count: removedCount, expandedIds: Array.from(ids) });
          deleted += removedCount;
          appendAudit({ action: 'bulk_delete', op, result: 'ok', expandedIds: Array.from(ids) });
        } else {
          results.push({ ok: false, op, error: 'invalid_op' });
          appendAudit({ action: 'invalid', op, result: 'invalid' });
        }
      } catch (e) {
        results.push({ ok: false, op, error: String(e && e.message ? e.message : e) });
        appendAudit({ action: op?.op || 'unknown', op, result: 'error', error: String(e && e.message ? e.message : e) });
      }
    }
  });
  res.json({ results, summary: { created, updated, deleted, completed } });
});
```

### How auto mode chat works

- **Client** sets `assistantMode = 'auto'` by default and sends the message via SSE to `GET /api/assistant/message/stream` with the last 3 transcript turns and an optional `clarify` object when continuing a clarification.
- **Server router** (`runRouter`) inspects the instruction and context snapshot and decides:
  - **clarify**: server emits an SSE `clarify` event with a question (and suggested options). The UI replaces the placeholder bubble with this question and remembers `_pendingClarifyQuestion`. The subsequent user reply is sent with the same `mode: 'auto'` and `priorClarifyQuestion` so the router can resolve short answers like “all of them”.
  - **chat**: server runs a single chat prompt (`buildChatPrompt`) and streams `summary` and `result` with `operations: []`.
  - **plan**: server falls through to the two-call planning pipeline: propose operations (validate/repair), then generate a conversational summary. SSE `summary` is streamed during planning and the final `result` contains `text` and `operations` (annotated with validation errors).
- **UI** updates a streaming placeholder bubble via `onSummary`, swaps in a clarify question via `onClarify`, and on `result/done` renders the final text and shows the operations list with checkboxes. The user may then click “Apply Selected” which calls `/api/llm/apply`.

### Streaming protocol (SSE)

- Events used: `summary` (string text), `clarify` (question), `result` (final JSON with `text` and `operations`), `done` (terminal). A periodic `heartbeat` is sent during the plan path.
- The client handles `error` by closing SSE and falling back to the non-streaming POST.

### Model invocation and robustness

- The server uses `runOllamaWithThinkingIfGranite` to support Granite control messages. Where the LLM returns `<think>...</think><response>...</response>`, `extractResponseBody` and `stripGraniteTags` sanitize outputs before parsing or rendering.
- Proposal parsing is hardened: tries JSON, then ```json``` fenced blocks, then bracket depth scanning to recover objects; afterwards `inferOperationShape` normalizes ops.
- Invalid ops trigger a single repair attempt via `buildRepairPrompt`. If still invalid, only valid ops proceed to summary.

### Data and auditing

- All assistant decisions and mutations append entries to `data/audit.jsonl` via `appendAudit`. This includes router decisions, validation summaries, and outcomes of apply operations.

### Relevant file map

- Frontend
  - `apps/web/flutter_app/lib/main.dart`: UI state, `_sendAssistantMessage`, apply ops, assistant panel wiring
  - `apps/web/flutter_app/lib/widgets/assistant_panel.dart`: Assistant UI, mode switch, ops list/diff
  - `apps/web/flutter_app/lib/api.dart`: All HTTP calls; SSE wiring for assistant
- Backend
  - `apps/server/server.js`: Todos API, assistant endpoints, router/proposal/summary/repair, validators, LLM runtime integration
  - Data: `data/todos.json`, `data/audit.jsonl`

### Notes on configuration

- Toggle auto mode globally with `ASSISTANT_AUTO_MODE_ENABLED` (defaults to enabled). Set to `false` to force auto mode off.
- The LLM model and temperature are controlled by environment vars used in the server’s Ollama runner. Granite-specific wrapping is auto-detected.

---

This document should equip you to trace a message from the assistant UI, through SSE and the router, to either chat responses or a full plan with operations, and back to applied mutations.

### Targeted improvements to auto mode design

- **Intent routing (smarter, more structured)**
  - Require the router to return a structured payload that is actually consumed downstream. Today, `category`, `entities`, and `missing` are computed but unused.
  - **Use confidence-gated routing**: e.g., confidence < 0.45 -> force clarify; 0.45–0.7 -> safe chat; > 0.7 -> plan.
  - **Return structured clarify options** instead of embedding them in the `question` string. Add an `options` array with canonical identifiers and fields for rendering clickable choices in the UI.
  - Optionally include a `where` filter suggestion (derived from `entities`) to seed plan prompts and bulk operations.

```js
// server.js — router return shape suggestion
{
  decision: 'clarify' | 'chat' | 'plan',
  confidence: 0.0..1.0,
  question?: string,
  options?: Array<{ id: number, title: string, scheduledFor?: string|null }>,
  entities?: { date?: string, priority?: 'low'|'medium'|'high', ids?: number[], text?: string },
  where?: { /* normalized bulk filter derived from entities */ }
}
```

```js
// server.js — clarify SSE payload (structured)
send('clarify', JSON.stringify({
  question: route.question,
  options: (route.options || []).map(o => ({ id: o.id, title: o.title, scheduledFor: o.scheduledFor ?? null }))
}));
```

- **Clarification flow UX**
  - On the client, render `clarify.options` as clickable chips. Clicking emits the next user turn with `priorClarifyQuestion` and a structured `selection` (e.g., `ids: [123]`).
  - Pass a structured clarify context back to the server (not just the question text): `{ question, selection?: { ids?:[], date?:..., priority?:... } }` so the router can promote directly to `plan` with high confidence.

```dart
// api.assistantMessage(... priorClarifyQuestion)
// Extend to: priorClarify: { question, selection? }
options: {
  'streamSummary': false,
  'mode': mode,
  if (priorClarify != null) 'clarify': priorClarify,
}
```

- **Plan pipeline input (contextual and bounded)**
  - Use the router’s `entities/where` to seed `buildProposalPrompt` and limit the scope. This will reduce hallucinations and encourage correct use of `bulk_*`.
  - Dynamically vary `topK` and aggregates by intent. For example, if `entities.date=today`, include a focused snapshot of today’s items and a small sample of backlog, not a generic top-40.
  - Add an explicit “ops budget” to the prompt (e.g., “propose at most 8 operations”).

```js
// server.js — before buildProposalPrompt
const { where } = route || {};
const focused = where ? todosIndex.filterByWhere(where) : todosIndex.searchByQuery('', { k: 40 });
const snapshot = where ? { focused: focused.slice(0, 50), aggregates: todosIndex.getAggregates() } : { topK, aggregates };
const prompt1 = buildProposalPrompt({ instruction, todosSnapshot: snapshot, transcript });
```

- **Prompt hardening (router and proposals)**
  - Router: add a short taxonomy and exemplar section with 5–10 clear labeled examples for each decision type (chat/plan/clarify). This typically increases calibration and confidence separation.
  - Proposals: adopt grammar-constrained or schema-constrained decoding when available (some models support JSON schema / grammar). If unsupported, explicitly include a compact JSON schema and a one-line reminder to output a single JSON object only.
  - Encourage `bulk_*` when estimated targets > 5, discourage mass-create without anchors, and reiterate recurrence anchor rules earlier in the prompt.

```js
// server.js — prompt tail additions
`You MUST return valid JSON that conforms to the provided schema. If unsure which items, prefer decision=clarify.`
```

- **Streaming protocol enhancements**
  - Emit fine-grained stage events: `stage: 'routing'|'proposing'|'validating'|'repairing'|'summarizing'` so the UI can reflect progress (“Validating…”, “Repairing invalid ops…”).
  - Emit an early `ops` event with the annotated operations as soon as validation is complete, so users can start reviewing before the summary finishes.

```js
// server.js — SSE during plan path
send('stage', JSON.stringify({ stage: 'proposing' }));
// ...after validation
send('stage', JSON.stringify({ stage: 'validating' }));
send('ops', JSON.stringify({ operations: annotatedAll }));
// ...before summary
send('stage', JSON.stringify({ stage: 'summarizing' }));
```

- **Safety and guardrails**
  - Gate destructive ops: if more than N deletes are proposed or `bulk_delete` count > threshold, require a confirm step (the UI already relies on user selection; still, surface warnings like “This will delete 45 tasks”).
  - Add a “dry-run apply” endpoint (`POST /api/llm/dryrun`) that only returns the computed summary and diffs without mutation; the UI can show a richer diff and confirm.
  - Add idempotency keys to `/api/llm/apply` (client sends a UUID); server stores last N keys to ignore accidental resubmits.

- **Use router outputs downstream**
  - Feed `category` and extracted `entities` into `buildConversationalSummaryPrompt` to ground the summary (“for today’s tasks”, “for priority high items”).
  - If `decision='chat'`, optionally include a brief suggestion like “Would you like me to make these changes?” based on detected entities, nudging toward plan when safe.

- **Robustness upgrades**
  - Keep current JSON recovery steps, but add a strict “first valid JSON object” extractor and log both “model_raw” and “parsed_body” into audit for debugging.
  - Normalize input times/dates via a helper and include a “timezone reminder” earlier in all prompts.
  - Expand validation errors with hints; feed these hints into `buildRepairPrompt` at the top to steer the repair more directly.

- **Telemetry and evaluation**
  - Extend `audit.jsonl` with fields: `stage`, `router_confidence`, `ops_count`, `invalid_count`, `repair_success` (bool). This enables automated dashboards and offline evals.
  - Capture user outcomes: whether the user applied any ops after each plan; over time, use this for RL-ish heuristic tweaks (thresholds, budgets).

### Deeper dives and implementation plan (1–6)

#### Recent changes (implemented)

- Server POST endpoint `POST /api/assistant/message` no longer writes SSE headers or events. It now returns JSON only. Streaming remains exclusive to `GET /api/assistant/message/stream`.
- Proposal prompt now explicitly mentions and allows bulk operations (`bulk_update`, `bulk_complete`, `bulk_delete`) with a concise shape reminder and guidance to prefer bulk when targets > 5.

- Router now returns structured `options[]` when `decision=clarify`, and the SSE `clarify` payload includes both `question` and `options` for the client to render.
- Router applies confidence-gated routing with thresholds: `< 0.45` clarify, `0.45–0.70` chat (downshift from plan), `> 0.70` plan. If a structured `clarify.selection` is present, the router biases to `plan` and seeds a `where` filter.
- SSE plan path emits `stage` events (`routing`, `proposing`, `validating`, `summarizing`) and an early `ops` event after validation; if repair updates ops, a second `ops` event with `version: 2` is emitted.
- Added `POST /api/llm/dryrun` to validate and preview changes without mutation. Returns `{ results, summary, warnings? }`; warnings include bulk impact counts (e.g., large `bulk_delete`).
- Added idempotency support to `POST /api/llm/apply` via `Idempotency-Key` header or `idempotencyKey` field; 10-minute TTL cache returns the prior response for duplicate keys.

These changes fix the POST fallback path used by the frontend on SSE errors and encourage correct use of bulk operations for large-scope edits.

1) Structured clarify options (explain more)
- Server return shape (router): add `options` and normalized `where` alongside `question`.
  - `options: Array<{ id: number, title: string, scheduledFor?: string|null }>` built from `topClarifyCandidates(...)`.
  - `entities` and `where` derive from NER-like extraction and simple rules (e.g., “today”, “high priority”).
- SSE clarify event schema:
  - `{ question: string, options: Array<{ id, title, scheduledFor? }> }`
- Client UX:
  - Render `options` as selectable chips; selection updates local state and immediately sends the next `assistantMessage` with `mode: 'auto'` and `priorClarify`:
    - `priorClarify: { question, selection: { ids: [<pickedIds>], date?: <ymd>, priority?: 'low'|'medium'|'high' } }`
  - Keep the clarify bubble visible; show chosen chips inline for traceability.
- Server clarify handling:
  - Parse `clarify` from request. If `clarify.selection` is present, treat ambiguity as resolved: raise effective confidence and either:
    - Skip re-routing and go directly to plan with `where` seeded from selection, or
    - Re-run router but bias decision to `plan` with updated `entities` and `where`.
- Edge cases:
  - Long option lists → cap to 7 and expose “Show more” later.
  - Mixed intents → fallback to clarify with multiple sections (ids + date); still one question.

2) Confidence-gated routing (accepted)
- Initial thresholds to implement now: clarify if `< 0.45`, chat if `0.45–0.70`, plan if `> 0.70`.
- Behavior:
  - Below clarify threshold: always send `clarify` SSE.
  - Mid-range: prefer chat for informational questions; if entities/where are strong (e.g., many ids or a date), override to plan.
  - Above plan threshold: proceed to plan pipeline; if `where` is empty and instruction is Q&A-like, optionally downshift to chat at `> 0.85` only if entities are null.
- Audit and calibration:
  - Log per-message confidence and decision; review weekly to adjust thresholds.

3) Early ops event (explain more)
- Server:
  - After validation (and optional repair), emit:
    - `event: stage` `{ stage: 'validating' }`
    - `event: ops` `{ version: 1, operations: annotatedAll, validCount, invalidCount }`
  - If repair changes the set, re-emit `ops` with `version: 2`.
- Client:
  - On first `ops`, populate the operations list and allow selection immediately while the summary is still generating.
  - If a newer `version` arrives, reconcile by replacing the list while preserving checked state for still-present ops by stable key `(op, id?)`.
  - Continue showing streamed `summary` text in the bubble until `done`.
- Benefits:
  - Users can start reviewing sooner; large plans feel more responsive.
- Risks/mitigations:
  - Op churn between versions → versioning and preserving selections alleviates frustration.

4) Schema-/grammar-constrained decoding (explain more)
- If runtime supports grammars (e.g., GBNF in llama.cpp or similar), enforce a JSON object with an `operations` array and strict field types.
- If not available (likely with current Ollama setup), strengthen soft constraints:
  - Include a compact JSON Schema excerpt in the prompt and a one-line instruction “Return JSON only. No prose. One object: {"operations": [...]}”.
  - Keep current multi-strategy recovery (strip tags, fenced blocks, bracket scan) and add a “first-valid-JSON” extractor that stops at the first parseable object.
  - Add a post-parse sanitizer to coerce simple types (e.g., `id` strings → ints) before validation.
- Optional: implement a minimal “JSON rewriter” pass (rule-based) to fix trailing commas, single quotes, and unquoted keys before parse attempts.

5) Dry-run apply and idempotency (explain more)
- Dry-run endpoint: `POST /api/llm/dryrun`
  - Input: `{ operations: [...] }`
  - Output:
    - `{ results: [ { op, valid: boolean, errors: string[], preview?: { before?: object, after?: object } } ], summary: { created, updated, deleted, completed } }`
  - Behavior:
    - Validate ops; for valid ops, compute a non-mutating preview (e.g., what fields would change) using in-memory copies.
    - No disk writes or index refresh; purely simulated.
- Idempotency for `/api/llm/apply`:
  - Accept `Idempotency-Key` header or `idempotencyKey` field.
  - Maintain a small in-memory store `{ key -> { status, response, ts } }` with TTL (e.g., 10 minutes) and a best-effort persistence on shutdown optional.
  - If a duplicate key arrives: return the stored response without reapplying; if a request is in-flight with the same key, coalesce.
  - Keep existing `withApplyLock` to serialize mutations; idempotency prevents accidental double-submits.
- UI impact:
  - Continue to “Always require Apply”; the dry-run powers richer diffs in the review panel.

6) Apply policy (accepted: always require apply)
- We will not auto-apply any changes, including simple/low-risk ops.
- The UI will continue to preselect valid ops by default, but final mutation only occurs after explicit “Apply Selected”.
- Add warning copy for destructive counts (e.g., bulk delete) and require a second confirm dialog if thresholds are exceeded.

### Example prompt updates

- **Router prompt header (excerpt)**

```text
You are an intent router for a todo assistant.
Return a single JSON object with fields:
  decision: "chat" | "plan" | "clarify"
  confidence: number 0..1
  question?: string (required when decision=clarify)
  options?: Array<{ id: number, title: string, scheduledFor?: string|null }>
  entities?: { date?: string, priority?: "low"|"medium"|"high", ids?: number[], text?: string }
  where?: { ids?: number[], scheduled_range?: { from?: string, to?: string }, priority?: string, completed?: boolean, repeating?: boolean }

Guidance:
- If time/date/target is ambiguous: decision=clarify and ask ONE short question. Prefer including 3–7 options.
- If the user asks to change a clear scope (e.g., "all today", "everything this week"): decision=plan.
- If the user is just asking a question without change intent: decision=chat.
- Avoid prose. JSON only.
```

- **Proposal prompt tail (excerpt)**

```text
Constraints:
- Output exactly one JSON object: { "operations": [...] }
- Propose at most 8 operations.
- Prefer bulk_* when count of targets > 5.
- For any repeating task (recurrence.type != none), an anchor scheduledFor is REQUIRED.
- For repeating tasks, avoid "complete"; use "complete_occurrence" with occurrenceDate.
```

### Optional enhancements

- **Small keyword heuristic pre-router**: lightweight rule checks (e.g., contains “explain”, “what”, “why” → bias to chat; contains “delete”, “remove all”, “complete everything” → bias to plan + safety). Combine with LLM decisions for extra robustness.
- **Memory of recent confirmations**: if a user recently confirmed a scope (“all today”), bias subsequent short-form requests toward that scope for a short time window.
- **Batching**: if a long-running proposal is in progress and the user sends another message, cancel/replace the in-flight SSE to avoid stale results.

### Decisions locked-in and implementation specifics

- Confirmed:
  - 1) Structured clarify options: YES. Implement `clarify` SSE payload with `question` and `options[]`; accept `priorClarify` with `selection` from the client.
  - 2) Confidence-gated routing: YES. Thresholds: clarify < 0.45, chat 0.45–0.70, plan > 0.70 (calibrate via audit).
  - 3) Early ops event: YES. Emit `stage` and `ops` events post-validation (and post-repair if changed) with versioning.
  - 6) Apply policy: YES. Always require Apply; add destructive thresholds and confirm dialog.

- Chosen defaults for 5) Idempotency/dry-run: use `Idempotency-Key` header with 10-minute TTL; add `/api/llm/dryrun` with side-effect-free previews.

#### Wire contracts (final)

- Router result (server internal):
```json
{
  "decision": "clarify|chat|plan",
  "confidence": 0.0,
  "question": "optional when decision=clarify",
  "options": [ { "id": 123, "title": "...", "scheduledFor": "YYYY-MM-DD|null" } ],
  "entities": { "date": "YYYY-MM-DD", "priority": "low|medium|high", "ids": [1,2], "text": "..." },
  "where": { "ids": [1,2], "scheduled_range": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, "priority": "high", "completed": false, "repeating": true }
}
```

- SSE events (server -> client):
```json
// clarify
{ "question": "...", "options": [ { "id": 123, "title": "...", "scheduledFor": null } ] }

// stage
{ "stage": "routing|proposing|validating|repairing|summarizing" }

// ops (versioned)
{ "version": 1, "operations": [ { "op": { /* normalized op */ }, "errors": ["..."] } ], "validCount": 3, "invalidCount": 1 }

// summary
{ "text": "..." }

// result (unchanged)
{ "text": "...", "operations": [ { "op": { /* ... */ }, "errors": [] } ] }
```

- Client clarify continuation (client -> server):
```json
{
  "message": "Yes, those three.",
  "options": { "mode": "auto", "clarify": { "question": "Which items?", "selection": { "ids": [123,456,789], "date": null, "priority": null } } }
}
```

#### UI changes

- Assistant panel: render clarify `options[]` as chips; maintain `selection` state; on send, include `priorClarify` as above. Preserve chip choices in transcript.
- Show progress text based on `stage` events inside the assistant bubble (not the header). Populate ops list immediately on first `ops` event; if `version` increases, reconcile while preserving prior checks when possible.

#### Backend changes

- Router: populate `options`, `entities`, `where`; apply thresholds (0.45/0.70); if `clarify.selection` present, bias to plan and seed `where`.
- SSE: emit `stage` at each phase; emit `ops` after validation and after successful repair; keep `summary/result/done` flow.
- Plan: if `where` exists, construct a focused snapshot for `buildProposalPrompt` (use `filterByWhere(where)`) and cap size (e.g., 50).
- Apply: enforce “always require apply”; for destructive ops above thresholds (e.g., >20 deletes), require client confirmation (UI) and return a soft warning in `dryrun` response.

#### Runtime grammar support (4) — test plan and implementation fork

- Structured outputs in Ollama: recent releases support constraining model outputs to JSON schemas (structured outputs). We will prefer this for proposal/repair if available.
- Granite compatibility: Granite models run on Ollama, but structured-output support may vary by model. Verify via the test below.
- Quick capability test (local):
  - Ensure Ollama is installed and running.
  - Pull the Granite model you use (e.g., `granite3.3:8b` or your selected tag).
  - Use the HTTP API to attempt a JSON-schema-constrained generation. Example:

```bash
curl -s http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "granite3.3:8b",
    "prompt": "Return operations to create one task titled Buy milk today.",
    "format": "json",
    "json_schema": {
      "type": "object",
      "properties": {
        "operations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "op": {"type": "string"},
              "title": {"type": ["string", "null"]},
              "scheduledFor": {"type": ["string", "null"]}
            },
            "required": ["op"]
          }
        }
      },
      "required": ["operations"]
    }
  }' | jq .
```

- If the response adheres to the schema (single JSON object with `operations`), enable schema-constrained decoding for proposal/repair. If not, fall back to the soft-constraint strategy below.

- If supported:
  - Introduce a `supportsJsonFormat` or `supportsGrammar` flag; when true, enable strict/constrained decoding for proposal/repair calls only.
  - Keep chat/summary calls unconstrained to preserve natural text.

- If not supported (fallback):
  - Use the strengthened prompt schema excerpt and retain robust recovery (tags strip, fenced block parse, bracket scan, first-valid-JSON, sanitizer).

##### Local test results (this environment)

- Ollama detected at `http://localhost:11434` with version `0.11.2`.
- Granite models available: `granite3.3:8b` (and `granite-code:8b`).
- Test 1 (format=json bias):

```bash
curl -s http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"granite3.3:8b","prompt":"Return a single JSON object with key operations only.","format":"json","stream":false}' | jq .
```

  - Result: Response contained a valid JSON object in `response` string (bias toward JSON works).

- Test 2 (JSON schema constraint attempt A — json_schema at top-level):

```bash
curl -s http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"granite3.3:8b","prompt":"Return operations JSON only.","format":"json","json_schema":{...},"stream":false}' | jq .
```

  - Result: Model ignored schema and produced unrelated JSON-shaped content. Indicates schema constraint not enforced.

- Test 3 (JSON schema constraint attempt B — format as object with schema):

```bash
curl -s http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"granite3.3:8b","prompt":"Return operations JSON only.","format":{"type":"json","schema":{...}},"stream":false}' | jq .
```

  - Result: `{ "error": "invalid JSON schema in format" }`. Indicates current server does not accept this structured-output parameter.

- Decision for this setup (Option 1):
  - Use `format: "json"` for proposal/repair calls to bias JSON, keep chat/summary unconstrained.
  - Retain and strengthen robust parsing: strip Granite tags; try plain JSON, fenced blocks, bracket-scan, first-valid-JSON; sanitize/coerce types before `validateProposal`.
  - Keep one repair attempt and deterministic summary fallback; continue to stream `stage` and early `ops` events.
  - Always require Apply; warn on >20 deletes or >50 bulk updates; confirm before applying.
  - Leave “strict schema” as a future optional enhancement pending runtime support; keep this as a feature flag to enable later without removing the robust fallback.

#### Dry-run and idempotency (5) — chosen approach

- Dry-run endpoint: `POST /api/llm/dryrun` (no writes)
  - Input: `{ operations: [...] }`
  - Output: `{ results: [ { op, valid, errors, preview?: { before?: object, after?: object } } ], summary: { created, updated, deleted, completed }, warnings?: [string] }`
  - For bulk ops, include counts and sample ids (up to 10) in `preview` and warnings for large-impact changes.

- Idempotency:
  - Use `Idempotency-Key` request header; server caches response for 10 minutes; duplicate key returns cached response.
  - Combine with existing apply mutex; coalesce concurrent requests with identical keys; optional lightweight persistence on graceful shutdown.

- Warning thresholds (UI + dry-run):
  - Show a warning banner if `bulk_delete` would remove more than 20 items.
  - Show a warning banner if `bulk_update` affects more than 50 items.
  - Always require explicit Apply (no auto-apply), with an extra confirm dialog when thresholds are exceeded.

### Open items to confirm (minor)

1) Dry-run warning thresholds: default delete warning at >20 items and bulk-update warning at >50 items acceptable?
2) `stage` event strings and order OK as defined? Should we show them in the UI header or within the assistant bubble only?
3) For grammar support: if Ollama `--format json` is available, proceed with it as a bias (not strict). If you prefer strict grammar, should we prototype a llama.cpp path for proposals/repair only?

