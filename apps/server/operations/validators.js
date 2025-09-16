export class OperationValidators {
  static taskCreate(op) {
    const errors = [];
    
    if (!op.title || typeof op.title !== 'string' || op.title.trim().length === 0) {
      errors.push('Title is required and must be a non-empty string');
    }
    
    if (op.title && op.title.length > 255) {
      errors.push('Title must be 255 characters or less');
    }
    
    if (op.notes && typeof op.notes !== 'string') {
      errors.push('Notes must be a string');
    }
    
    if (op.scheduledFor && !OperationValidators.isValidDate(op.scheduledFor)) {
      errors.push('scheduledFor must be a valid date in YYYY-MM-DD format');
    }
    
    // tasks are all-day; time-of-day fields are not part of the schema
    
    if (op.recurrence && !OperationValidators.isValidRecurrence(op.recurrence)) {
      errors.push('recurrence must be a valid recurrence object');
    }
    
    // Optional context validation
    if (op.context !== undefined && op.context !== null) {
      const c = String(op.context);
      if (!['school','personal','work'].includes(c)) {
        errors.push('invalid_context');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static taskUpdate(op) {
    const errors = [];
    
    if (!op.id || typeof op.id !== 'number' || op.id <= 0) {
      errors.push('Valid ID is required');
    }
    
    if (op.title !== undefined && (typeof op.title !== 'string' || op.title.trim().length === 0)) {
      errors.push('Title must be a non-empty string');
    }
    
    if (op.title && op.title.length > 255) {
      errors.push('Title must be 255 characters or less');
    }
    
    if (op.notes !== undefined && typeof op.notes !== 'string') {
      errors.push('Notes must be a string');
    }
    
    if (op.scheduledFor !== undefined && !OperationValidators.isValidDate(op.scheduledFor)) {
      errors.push('scheduledFor must be a valid date in YYYY-MM-DD format');
    }
    
    // tasks are all-day; time-of-day fields are not part of the schema
    
    if (op.recurrence !== undefined && !OperationValidators.isValidRecurrence(op.recurrence)) {
      errors.push('recurrence must be a valid recurrence object');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static taskDelete(op) {
    const errors = [];
    
    if (!op.id || typeof op.id !== 'number' || op.id <= 0) {
      errors.push('Valid ID is required');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  static taskSetStatus(op) {
    const errors = [];
    if (!op.id || typeof op.id !== 'number' || op.id <= 0) {
      errors.push('Valid ID is required');
    }
    const s = (op.status === undefined || op.status === null) ? null : String(op.status);
    if (!s || !['pending','completed','skipped'].includes(s)) {
      errors.push('invalid_status');
    }
    if (op.occurrenceDate !== undefined && !(op.occurrenceDate === null || OperationValidators.isValidDate(op.occurrenceDate))) {
      errors.push('invalid_occurrenceDate');
    }
    return { valid: errors.length === 0, errors };
  }
  
  static eventCreate(op) {
    const errors = [];
    
    if (!op.title || typeof op.title !== 'string' || op.title.trim().length === 0) {
      errors.push('Title is required and must be a non-empty string');
    }
    
    if (op.title && op.title.length > 255) {
      errors.push('Title must be 255 characters or less');
    }
    
    if (op.notes && typeof op.notes !== 'string') {
      errors.push('Notes must be a string');
    }
    
    if (op.scheduledFor && !OperationValidators.isValidDate(op.scheduledFor)) {
      errors.push('scheduledFor must be a valid date in YYYY-MM-DD format');
    }
    
    if (op.startTime && !OperationValidators.isValidTime(op.startTime)) {
      errors.push('startTime must be a valid time in HH:MM format');
    }
    
    if (op.endTime && !OperationValidators.isValidTime(op.endTime)) {
      errors.push('endTime must be a valid time in HH:MM format');
    }
    
    if (op.startTime && op.endTime && op.startTime >= op.endTime) {
      errors.push('endTime must be after startTime');
    }
    
    if (op.recurrence && !OperationValidators.isValidRecurrence(op.recurrence)) {
      errors.push('recurrence must be a valid recurrence object');
    }
    // Optional context validation
    if (op.context !== undefined && op.context !== null) {
      const c = String(op.context);
      if (!['school','personal','work'].includes(c)) {
        errors.push('invalid_context');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static eventUpdate(op) {
    const errors = [];
    
    if (!op.id || typeof op.id !== 'number' || op.id <= 0) {
      errors.push('Valid ID is required');
    }
    
    if (op.title !== undefined && (typeof op.title !== 'string' || op.title.trim().length === 0)) {
      errors.push('Title must be a non-empty string');
    }
    
    if (op.title && op.title.length > 255) {
      errors.push('Title must be 255 characters or less');
    }
    
    if (op.notes !== undefined && typeof op.notes !== 'string') {
      errors.push('Notes must be a string');
    }
    
    if (op.scheduledFor !== undefined && !OperationValidators.isValidDate(op.scheduledFor)) {
      errors.push('scheduledFor must be a valid date in YYYY-MM-DD format');
    }
    
    if (op.startTime !== undefined && !OperationValidators.isValidTime(op.startTime)) {
      errors.push('startTime must be a valid time in HH:MM format');
    }
    
    if (op.endTime !== undefined && !OperationValidators.isValidTime(op.endTime)) {
      errors.push('endTime must be a valid time in HH:MM format');
    }
    
    if (op.startTime && op.endTime && op.startTime >= op.endTime) {
      errors.push('endTime must be after startTime');
    }
    
    if (op.recurrence !== undefined && !OperationValidators.isValidRecurrence(op.recurrence)) {
      errors.push('recurrence must be a valid recurrence object');
    }
    // Optional context validation
    if (op.context !== undefined && op.context !== null) {
      const c = String(op.context);
      if (!['school','personal','work'].includes(c)) {
        errors.push('invalid_context');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static eventDelete(op) {
    const errors = [];
    
    if (!op.id || typeof op.id !== 'number' || op.id <= 0) {
      errors.push('Valid ID is required');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  // Helper methods
  static isValidDate(dateStr) {
    if (typeof dateStr !== 'string') return false;
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date) && dateStr.match(/^\d{4}-\d{2}-\d{2}$/) !== null;
  }
  
  static isValidTime(timeStr) {
    if (typeof timeStr !== 'string') return false;
    return timeStr.match(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/) !== null;
  }
  
  static isValidDuration(duration) {
    return typeof duration === 'number' && duration > 0 && Number.isInteger(duration);
  }
  
  static isValidRecurrence(recurrence) {
    if (!recurrence || typeof recurrence !== 'object') return false;
    
    const validTypes = ['none', 'daily', 'weekdays', 'weekly', 'every_n_days'];
    if (!validTypes.includes(recurrence.type)) return false;
    
    if (recurrence.until && !OperationValidators.isValidDate(recurrence.until)) return false;
    
    if (recurrence.type === 'every_n_days' && (!recurrence.intervalDays || typeof recurrence.intervalDays !== 'number' || recurrence.intervalDays <= 0)) {
      return false;
    }
    
    return true;
  }
  
  
}
