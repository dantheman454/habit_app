import 'package:flutter/material.dart';
import '../util/context_colors.dart';

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
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        _contextChip('All', null, Icons.public),
        _contextChip('School', 'school', Icons.school),
        _contextChip('Personal', 'personal', Icons.person),
        _contextChip('Work', 'work', Icons.work),
      ],
    );
  }

  Widget _contextChip(String label, String? contextValue, IconData icon) {
    final isSelected = selectedContext == contextValue;
    final color = contextValue != null ? ContextColors.getContextColor(contextValue) : Colors.grey.shade600;
    
    return Builder(
      builder: (context) => InkWell(
        onTap: () => onChanged(contextValue),
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: ContextColors.getContextButtonColor(contextValue, isSelected),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: isSelected
                  ? color
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
                color: Colors.black87,
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  color: Colors.black87,
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
