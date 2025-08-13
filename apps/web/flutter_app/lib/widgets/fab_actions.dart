import 'package:flutter/material.dart';

class FabActions extends StatelessWidget {
  final VoidCallback onPressed;
  const FabActions({super.key, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    return FloatingActionButton(
      onPressed: onPressed,
      child: const Icon(Icons.add),
    );
  }
}


