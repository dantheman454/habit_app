import { OperationValidators } from './validators.js';
import { OperationExecutors } from './executors.js';

export class OperationRegistry {
  constructor(dbService) {
    this.dbService = dbService;
    this.executors = new OperationExecutors(dbService);
  }
  
  registerAllOperations(processor) {
    // Task operations
    processor.registerOperationType('task_create', {
      validator: OperationValidators.taskCreate,
      executor: this.executors.taskCreate.bind(this.executors)
    });
    
    processor.registerOperationType('task_update', {
      validator: OperationValidators.taskUpdate,
      executor: this.executors.taskUpdate.bind(this.executors)
    });
    
    processor.registerOperationType('task_delete', {
      validator: OperationValidators.taskDelete,
      executor: this.executors.taskDelete.bind(this.executors)
    });

    processor.registerOperationType('task_set_status', {
      validator: OperationValidators.taskSetStatus,
      executor: this.executors.taskSetStatus.bind(this.executors)
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
  }
  
  getRegisteredOperationTypes() {
    return [
      'task_create',
      'task_update', 
      'task_delete',
      'task_set_status',
      'event_create',
      'event_update',
      'event_delete'
    ];
  }
  
  getOperationSchema(operationType) {
    const schemas = {
      'task_create': {
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
      'task_update': {
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
      'task_delete': {
        type: 'object',
        properties: {
          id: { type: 'number', minimum: 1 }
        },
        required: ['id']
      },
      'task_set_status': {
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
      }
    };
    
    return schemas[operationType] || null;
  }
  
  getOperationDocumentation(operationType) {
    const docs = {
      'task_create': {
        description: 'Create a new task item',
        examples: [
          {
            description: 'Simple task',
            operation: {
              kind: 'task',
              action: 'create',
              title: 'Buy groceries'
            }
          },
          {
            description: 'Task with scheduling',
            operation: {
              kind: 'task',
              action: 'create',
              title: 'Team meeting',
              scheduledFor: '2025-08-20',
              timeOfDay: '14:30',
              recurrence: { type: 'weekly' }
            }
          }
        ]
      },
      'task_update': {
        description: 'Update an existing task item',
        examples: [
          {
            description: 'Update title',
            operation: {
              kind: 'task',
              action: 'update',
              id: 1,
              title: 'Updated task title'
            }
          }
        ]
      },
      'task_delete': {
        description: 'Delete a task item',
        examples: [
          {
            description: 'Delete by ID',
            operation: {
              kind: 'task',
              action: 'delete',
              id: 1
            }
          }
        ]
      },
      'task_set_status': {
        description: 'Set master or occurrence status for a task',
        examples: [
          {
            description: 'Set master status',
            operation: { kind: 'task', action: 'set_status', id: 1, status: 'completed' }
          },
          {
            description: 'Set occurrence status',
            operation: { kind: 'task', action: 'set_status', id: 1, status: 'skipped', occurrenceDate: '2025-08-18' }
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
      }
    };
    
    return docs[operationType] || null;
  }
}
