// Shared enums and models for the Habitus app
enum ViewMode { day, week, month }

enum MainView { tasks }

enum SmartList { today, all }

enum AppTab { tasks, events, habits }

class Habit {
  final int id;
  String title;
  String notes;
  String? startedOn; // YYYY-MM-DD or null
  Map<String, dynamic>? recurrence; // {type, intervalDays?, until?}
  int? weeklyTargetCount; // null or >=1
  String? context; // 'school'|'personal'|'work'
  final String createdAt;
  String updatedAt;

  Habit({
    required this.id,
    required this.title,
    required this.notes,
    this.startedOn,
    this.recurrence,
    this.weeklyTargetCount,
    this.context,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Habit.fromJson(Map<String, dynamic> j) => Habit(
        id: j['id'] as int,
        title: (j['title'] ?? '') as String,
        notes: (j['notes'] ?? '') as String,
        startedOn: j['startedOn'] as String?,
        recurrence: (j['recurrence'] as Map<String, dynamic>?),
        weeklyTargetCount: j['weeklyTargetCount'] as int?,
        context: j['context'] as String?,
        createdAt: j['createdAt'] as String,
        updatedAt: j['updatedAt'] as String,
      );
}
