import 'package:flutter/material.dart';
import 'dart:math' as math;
import '../util/context_colors.dart';
import 'expandable_text.dart';

class EventTimeline extends StatelessWidget {
  final String dateYmd;
  final List<Map<String, dynamic>> events;
  final void Function(int eventId)? onTapEvent;
  final int minHour;
  final int maxHour;
  final Duration slot;
  final ScrollController?
  scrollController; // when provided, enables scrollable mode
  final double? pixelsPerMinute; // used only when scrollController is provided

  const EventTimeline({
    super.key,
    required this.dateYmd,
    required this.events,
    this.onTapEvent,
    this.minHour = 6,
    this.maxHour = 22,
    this.slot = const Duration(minutes: 30),
    this.scrollController,
    this.pixelsPerMinute,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final double height = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : 600.0;
        final double width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : 400.0;
        final int spanMinutes = (maxHour - minHour) * 60;
        final bool scrollable = scrollController != null;
        final double pxPerMin = scrollable
            ? (pixelsPerMinute ?? 2.0)
            : math.max(0.8, height / spanMinutes);

        final normalized = _normalizeEvents(events, minHour, spanMinutes);
        normalized.sort(
          (a, b) =>
              a.startM != b.startM ? a.startM - b.startM : a.endM - b.endM,
        );
        final laneEnds = <int>[]; // in minutes from start of day window
        for (final e in normalized) {
          int laneIndex = 0;
          for (; laneIndex < laneEnds.length; laneIndex++) {
            if (laneEnds[laneIndex] <= e.startM) {
              break;
            }
          }
          if (laneIndex == laneEnds.length) {
            laneEnds.add(e.endM);
          } else {
            laneEnds[laneIndex] = e.endM;
          }
          e.lane = laneIndex;
        }
        final int laneCount = math.max(1, laneEnds.length);

        final gridLines = <Widget>[];
        for (int h = minHour; h <= maxHour; h++) {
          final top = ((h - minHour) * 60) * pxPerMin;
          gridLines.add(
            Positioned(
              top: top,
              left: 0,
              right: 0,
              child: Container(
                height: 1,
                color: Theme.of(
                  context,
                ).colorScheme.outlineVariant.withAlpha((0.5 * 255).round()),
              ),
            ),
          );
          gridLines.add(
            Positioned(
              top: top + 2,
              left: 4,
              child: Text(
                '${h.toString().padLeft(2, '0')}:00',
                style: TextStyle(
                  fontSize: 10,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          );
        }

        final blocks = <Widget>[];
        String _fmtLabel(int m) {
          final h = minHour + (m ~/ 60);
          final mm = (m % 60).toString().padLeft(2, '0');
          return '${h.toString().padLeft(2, '0')}:$mm';
        }

        for (final e in normalized) {
          final double top = e.startM * pxPerMin;
          final double heightPx = math.max(16, (e.endM - e.startM) * pxPerMin);
          final double leftPx = (width * (e.lane / laneCount));
          final double widthPx = width * (1 / laneCount) - 4; // small gap
          final titleText = e.title.isEmpty ? 'Event' : e.title;
          final tooltip =
              '$titleText  ${_fmtLabel(e.startM)}–${_fmtLabel(e.endM)}';
          // Find the original event data to get notes
          final rawEvent = events.firstWhere(
            (raw) => raw['id'] == e.id,
            orElse: () => const {},
          );
          final notes = rawEvent['notes'] as String?;

          blocks.add(
            Positioned(
              top: top,
              left: leftPx,
              width: widthPx,
              height: heightPx,
              child: Tooltip(
                message: tooltip,
                preferBelow: false,
                waitDuration: const Duration(milliseconds: 300),
                child: _EventBlock(
                  id: e.id,
                  title: e.title,
                  context: e.context,
                  notes: notes,
                  onTap: () => onTapEvent?.call(e.id),
                ),
              ),
            ),
          );
        }

        final content = Container(
          color: Theme.of(context).colorScheme.surface,
          child: Stack(children: [...gridLines, ...blocks]),
        );

        if (scrollable) {
          final fullHeight = spanMinutes * pxPerMin;
          return Scrollbar(
            controller: scrollController,
            thumbVisibility: true,
            child: SingleChildScrollView(
              controller: scrollController,
              child: SizedBox(height: fullHeight, width: width, child: content),
            ),
          );
        }

        return content;
      },
    );
  }

  List<_NormalizedEvent> _normalizeEvents(
    List<Map<String, dynamic>> items,
    int minHour,
    int spanMinutes,
  ) {
    final list = <_NormalizedEvent>[];
    for (final raw in items) {
      final int id = (raw['id'] is int)
          ? raw['id'] as int
          : int.tryParse('${raw['id']}') ?? -1;
      final String title = (raw['title'] ?? '').toString();
      final String? startStr =
          (raw['startTime'] ?? raw['timeOfDay']) as String?;
      final String? endStr = raw['endTime'] as String?;
      final String? context = raw['context'] as String?;
      int startM = _parseHm(startStr, minHour);
      int endM = endStr != null && endStr.isNotEmpty
          ? _parseHm(endStr, minHour)
          : startM + 15; // minimum 15 minutes when no end
      if (endM <= startM) endM = startM + 15;
      // clamp to visible window
      startM = startM.clamp(0, spanMinutes);
      endM = endM.clamp(0, spanMinutes);
      list.add(
        _NormalizedEvent(
          id: id,
          title: title,
          startM: startM,
          endM: endM,
          lane: 0,
          context: context,
        ),
      );
    }
    return list;
  }

  int _parseHm(String? hhmm, int minHour) {
    try {
      if (hhmm == null || hhmm.isEmpty) return 0;
      final parts = hhmm.split(':');
      if (parts.length != 2) return 0;
      final h = int.tryParse(parts[0]) ?? 0;
      final m = int.tryParse(parts[1]) ?? 0;
      return (h - minHour) * 60 + m;
    } catch (_) {
      return 0;
    }
  }
}

class _NormalizedEvent {
  final int id;
  final String title;
  final int startM;
  final int endM;
  final String? context;
  int lane;
  _NormalizedEvent({
    required this.id,
    required this.title,
    required this.startM,
    required this.endM,
    this.context,
    this.lane = 0,
  });
}

class _EventBlock extends StatelessWidget {
  final int id;
  final String title;
  final String? context;
  final String? notes;
  final VoidCallback? onTap;
  const _EventBlock({
    required this.id,
    required this.title,
    this.context,
    this.notes,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Context-based colors for events
    final Color bg =
        ContextColors.getContextBackgroundColor(this.context) ??
        Colors.green.shade50;
    final Color contextColor = this.context != null
        ? ContextColors.getContextColor(this.context)
        : Colors.green.shade600;
    final Color border = contextColor.withOpacity(0.3);
    final Color accent = contextColor;
    final Color fg = Colors.black87;

    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(6),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          decoration: BoxDecoration(
            border: Border.all(color: border),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Accent stripe on the left
              Container(
                width: 4,
                decoration: BoxDecoration(
                  color: accent,
                  borderRadius: const BorderRadius.only(
                    topLeft: Radius.circular(6),
                    bottomLeft: Radius.circular(6),
                  ),
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title.isEmpty ? 'Event' : title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: fg,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if ((notes ?? '').trim().isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: ExpandableText(
                            notes!.trim(),
                            maxLines: 2,
                            style: const TextStyle(
                              color: Colors.black54,
                              fontSize: 12,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
