import 'package:flutter/material.dart';

class FabActions extends StatelessWidget {
  final VoidCallback onCreateTodo;
  final VoidCallback onCreateEvent;
  final VoidCallback onCreateHabit;
  const FabActions({
    super.key,
    required this.onCreateTodo,
    required this.onCreateEvent,
    required this.onCreateHabit,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      onSelected: (v) {
        if (v == 'todo')
          onCreateTodo();
        else if (v == 'event')
          onCreateEvent();
        else if (v == 'habit')
          onCreateHabit();
      },
      itemBuilder: (c) => const [
        PopupMenuItem<String>(value: 'todo', child: Text('New Task')),
        PopupMenuItem<String>(value: 'event', child: Text('New Event')),
        PopupMenuItem<String>(value: 'habit', child: Text('New Habit')),
      ],
      child: FloatingActionButton(
        onPressed: null,
        child: const Icon(Icons.add),
      ),
    );
  }
}
