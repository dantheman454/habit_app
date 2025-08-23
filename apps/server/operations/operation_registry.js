import { OperationValidators } from './validators.js';
import { OperationExecutors } from './executors.js';

export class OperationRegistry {
  constructor(dbService) {
    this.dbService = dbService;
    this.executors = new OperationExecutors(dbService);
  }
  
  registerAllOperations(processor) {
    // Todo operations
    processor.registerOperationType('todo_create', {
      validator: OperationValidators.todoCreate,
      executor: this.executors.todoCreate.bind(this.executors)
    });
    
    processor.registerOperationType('todo_update', {
      validator: OperationValidators.todoUpdate,
      executor: this.executors.todoUpdate.bind(this.executors)
    });
    
    processor.registerOperationType('todo_delete', {
      validator: OperationValidators.todoDelete,
      executor: this.executors.todoDelete.bind(this.executors)
    });

    processor.registerOperationType('todo_set_status', {
      validator: OperationValidators.todoSetStatus,
      executor: this.executors.todoSetStatus.bind(this.executors)
    });
    
    // Event operations
    processor.registerOperationType('event_create', {
      validator: OperationValidators.eventCreate,
      executor: this.executors.eventCreate.bind(this.executors)
    });
    
    processor.registerOperationType('event_update', {
      validator: OperationValidators.eventUpdate,
      executor: this.executors.eventUpdate.bind(this.executors)
    });
    
    processor.registerOperationType('event_delete', {
      validator: OperationValidators.eventDelete,
      executor: this.executors.eventDelete.bind(this.executors)
    });

    // Event occurrence status removed (no completion semantics for events)
    
    // Habit operations
    processor.registerOperationType('habit_create', {
      validator: OperationValidators.habitCreate,
      executor: this.executors.habitCreate.bind(this.executors)
    });
    
    processor.registerOperationType('habit_update', {
      validator: OperationValidators.habitUpdate,
      executor: this.executors.habitUpdate.bind(this.executors)
    });
    
    processor.registerOperationType('habit_delete', {
      validator: OperationValidators.habitDelete,
      executor: this.executors.habitDelete.bind(this.executors)
    });
    
    processor.registerOperationType('habit_set_occurrence_status', {
      validator: OperationValidators.habitSetOccurrenceStatus,
      executor: this.executors.habitSetOccurrenceStatus.bind(this.executors)
    });
  }
  
  getRegisteredOperationTypes() {
    return [
      'todo_create',
      'todo_update', 
      'todo_delete',
      'todo_set_status',
      'event_create',
      'event_update',
      'event_delete',
      
      'habit_create',
      'habit_update',
      'habit_delete',
      'habit_set_occurrence_status'
    ];
  }
  
  getOperationSchema(operationType) {
    const schemas = {
      'todo_create': {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          recurrence: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['none', 'daily', 'weekly', 'monthly', 'yearly', 'every_n_days'] 
              },
              intervalDays: { type: 'number', minimum: 1 },
              until: { type: 'string', format: 'date' }
            },
            required: ['type']
          }
        },
        required: ['title']
      },
      'todo_update': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          recurrence: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['none', 'daily', 'weekly', 'monthly', 'yearly', 'every_n_days'] 
              },
              intervalDays: { type: 'number', minimum: 1 },
              until: { type: 'string', format: 'date' }
            },
            required: ['type']
          }
        },
        required: ['id']
      },
      'todo_delete': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 }
        },
        required: ['id']
      },
      'todo_set_status': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 },
          status: { type: 'string', enum: ['pending', 'completed', 'skipped'] },
          occurrenceDate: { type: 'string', format: 'date' }
        },
        required: ['id', 'status']
      },
      'event_create': {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          startTime: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          endTime: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          location: { type: 'string' },
          recurrence: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['none', 'daily', 'weekly', 'monthly', 'yearly', 'every_n_days'] 
              },
              intervalDays: { type: 'number', minimum: 1 },
              until: { type: 'string', format: 'date' }
            },
            required: ['type']
          }
        },
        required: ['title']
      },
      'event_update': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          startTime: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          endTime: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          location: { type: 'string' },
          recurrence: {
            type: 'object',
            properties: {
              type: { 
                type: 'string', 
                enum: ['none', 'daily', 'weekly', 'monthly', 'yearly', 'every_n_days'] 
              },
              intervalDays: { type: 'number', minimum: 1 },
              until: { type: 'string', format: 'date' }
            },
            required: ['type']
          }
        },
        required: ['id']
      },
      'event_delete': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 }
        },
        required: ['id']
      },
      
      'habit_create': {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          recurrence: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
              daysOfWeek: { 
                type: 'array', 
                items: { type: 'number', minimum: 0, maximum: 6 }
              }
            },
            required: ['type']
          }
        },
        required: ['title']
      },
      'habit_update': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 255 },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
          recurrence: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
              daysOfWeek: { 
                type: 'array', 
                items: { type: 'number', minimum: 0, maximum: 6 }
              }
            },
            required: ['type']
          }
        },
        required: ['id']
      },
      'habit_delete': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 }
        },
        required: ['id']
      },
      'habit_set_occurrence_status': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 },
          occurrenceDate: { type: 'string', format: 'date' },
          status: { type: 'string', enum: ['pending', 'completed', 'skipped'] }
        },
        required: ['id', 'occurrenceDate', 'status']
      }
    };
    
    return schemas[operationType] || null;
  }
  
  getOperationDocumentation(operationType) {
    const docs = {
      'todo_create': {
        description: 'Create a new todo item',
        examples: [
          {
            description: 'Simple todo',
            operation: {
              kind: 'todo',
              action: 'create',
              title: 'Buy groceries'
            }
          },
          {
            description: 'Todo with scheduling',
            operation: {
              kind: 'todo',
              action: 'create',
              title: 'Team meeting',
              scheduledFor: '2025-08-20',
              timeOfDay: '14:30',
              recurrence: { type: 'weekly' }
            }
          }
        ]
      },
      'todo_update': {
        description: 'Update an existing todo item',
        examples: [
          {
            description: 'Update title',
            operation: {
              kind: 'todo',
              action: 'update',
              id: 1,
              title: 'Updated task title'
            }
          }
        ]
      },
      'todo_delete': {
        description: 'Delete a todo item',
        examples: [
          {
            description: 'Delete by ID',
            operation: {
              kind: 'todo',
              action: 'delete',
              id: 1
            }
          }
        ]
      },
      'todo_set_status': {
        description: 'Set master or occurrence status for a todo',
        examples: [
          {
            description: 'Set master status',
            operation: { kind: 'todo', action: 'set_status', id: 1, status: 'completed' }
          },
          {
            description: 'Set occurrence status',
            operation: { kind: 'todo', action: 'set_status', id: 1, status: 'skipped', occurrenceDate: '2025-08-18' }
          }
        ]
      },
      'event_create': {
        description: 'Create a new calendar event',
        examples: [
          {
            description: 'Simple event',
            operation: {
              kind: 'event',
              action: 'create',
              title: 'Doctor appointment',
              scheduledFor: '2025-08-20',
              startTime: '10:00',
              endTime: '11:00',
              location: 'Medical Center'
            }
          }
        ]
      },
      'event_update': {
        description: 'Update an existing calendar event',
        examples: [
          {
            description: 'Update event time',
            operation: {
              kind: 'event',
              action: 'update',
              id: 1,
              startTime: '11:00',
              endTime: '12:00'
            }
          }
        ]
      },
      'event_delete': {
        description: 'Delete a calendar event',
        examples: [
          {
            description: 'Delete by ID',
            operation: {
              kind: 'event',
              action: 'delete',
              id: 1
            }
          }
        ]
      },
      
      'habit_create': {
        description: 'Create a new habit to track',
        examples: [
          {
            description: 'Daily habit',
            operation: {
              kind: 'habit',
              action: 'create',
              title: 'Exercise',
              scheduledFor: '2025-08-18',
              timeOfDay: '07:00',
              recurrence: { type: 'daily' }
            }
          },
          {
            description: 'Weekly habit',
            operation: {
              kind: 'habit',
              action: 'create',
              title: 'Read',
              scheduledFor: '2025-08-18',
              timeOfDay: '20:00',
              recurrence: { 
                type: 'weekly',
                daysOfWeek: [1, 3, 5] // Monday, Wednesday, Friday
              }
            }
          }
        ]
      },
      'habit_update': {
        description: 'Update an existing habit',
        examples: [
          {
            description: 'Update frequency',
            operation: {
              kind: 'habit',
              action: 'update',
              id: 1,
              recurrence: { type: 'daily' }
            }
          }
        ]
      },
      'habit_delete': {
        description: 'Delete a habit',
        examples: [
          {
            description: 'Delete by ID',
            operation: {
              kind: 'habit',
              action: 'delete',
              id: 1
            }
          }
        ]
      },
      'habit_set_occurrence_status': {
        description: 'Set the status of a specific occurrence of a recurring habit',
        examples: [
          {
            description: 'Set occurrence status',
            operation: { 
              kind: 'habit', 
              action: 'set_occurrence_status', 
              id: 1, 
              occurrenceDate: '2025-08-18',
              status: 'completed' 
            }
          }
        ]
      }
    };
    
    return docs[operationType] || null;
  }
}
