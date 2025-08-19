import 'package:flutter/material.dart';

class ContextFilter extends StatelessWidget {
  final String? selectedContext; // 'school', 'personal', 'work', null for 'all'
  final void Function(String?) onChanged;

  const ContextFilter({
    super.key,
    required this.selectedContext,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _contextChip('All', null, Icons.public),
        const SizedBox(width: 8),
        _contextChip('School', 'school', Icons.school),
        const SizedBox(width: 8),
        _contextChip('Personal', 'personal', Icons.person),
        const SizedBox(width: 8),
        _contextChip('Work', 'work', Icons.work),
      ],
    );
  }

  Widget _contextChip(String label, String? contextValue, IconData icon) {
    final isSelected = selectedContext == contextValue;
    
    return Builder(
      builder: (context) => InkWell(
        onTap: () => onChanged(contextValue),
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: isSelected 
                ? Theme.of(context).colorScheme.primary.withAlpha((0.1 * 255).round())
                : Colors.grey.shade100,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: isSelected
                  ? Theme.of(context).colorScheme.primary
                  : Colors.grey.shade300,
              width: 1,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 16,
                color: isSelected
                    ? Theme.of(context).colorScheme.primary
                    : Colors.grey.shade600,
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  color: isSelected
                      ? Theme.of(context).colorScheme.primary
                      : Colors.black87,
                  fontSize: 14,
                  fontWeight: isSelected ? FontWeight.w500 : FontWeight.normal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
