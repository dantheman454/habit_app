export class OperationExecutors {
  constructor(dbService) {
    this.db = dbService;
  }
  
  async todoCreate(op) {
    try {
      const todo = await this.db.createTodo({
        title: op.title,
        notes: String(op.notes || ''),
        scheduledFor: op.scheduledFor || null,
        timeOfDay: op.timeOfDay || null,
        recurrence: op.recurrence || { type: 'none' },
        // Preserve client-provided context; Db layer defaults to 'personal' when absent
        context: op.context
      });
      
      return {
        todo,
        created: true
      };
    } catch (error) {
      throw new Error(`Failed to create todo: ${error.message}`);
    }
  }
  
  async todoUpdate(op) {
    try {
      const updateData = {};
      
      if (op.title !== undefined) updateData.title = op.title;
      if (op.notes !== undefined) updateData.notes = op.notes;
      if (op.scheduledFor !== undefined) updateData.scheduledFor = op.scheduledFor;
      if (op.timeOfDay !== undefined) updateData.timeOfDay = op.timeOfDay;
      if (op.recurrence !== undefined) updateData.recurrence = op.recurrence;
      
      const todo = await this.db.updateTodo(op.id, updateData);
      
      if (!todo) {
        throw new Error(`Todo with ID ${op.id} not found`);
      }
      
      return {
        todo,
        updated: true
      };
    } catch (error) {
      throw new Error(`Failed to update todo: ${error.message}`);
    }
  }
  
  async todoDelete(op) {
    try {
      // Check if todo exists before deleting
      const todo = await this.db.getTodoById(op.id);
      if (!todo) {
        throw new Error(`Todo with ID ${op.id} not found`);
      }
      
      await this.db.deleteTodo(op.id);
      
      return {
        deleted: true
      };
    } catch (error) {
      throw new Error(`Failed to delete todo: ${error.message}`);
    }
  }

  async todoSetStatus(op) {
    try {
      const occurrenceDate = op.occurrenceDate;
      const status = String(op.status);
      if (occurrenceDate) {
        const updated = await this.db.setTodoOccurrenceStatus({ id: op.id, occurrenceDate, status });
        return { todo: updated, updated: true };
      }
      const todo = await this.db.updateTodo(op.id, { status });
      if (!todo) throw new Error(`Todo with ID ${op.id} not found`);
      return { todo, updated: true };
    } catch (error) {
      throw new Error(`Failed to set todo status: ${error.message}`);
    }
  }
  
  async eventCreate(op) {
    try {
      const event = await this.db.createEvent({
        title: String(op.title || '').trim(),
        notes: op.notes || '',
        scheduledFor: op.scheduledFor ?? null,
        startTime: (op.startTime === '' ? null : op.startTime) ?? null,
        endTime: (op.endTime === '' ? null : op.endTime) ?? null,
        location: op.location ?? null,
        recurrence: op.recurrence,
        completed: false,
        context: op.context,
      });
      
      return {
        event,
        created: true
      };
    } catch (error) {
      throw new Error(`Failed to create event: ${error.message}`);
    }
  }
  
  async eventUpdate(op) {
    try {
      const updateData = {};
      
      if (op.title !== undefined) updateData.title = op.title;
      if (op.notes !== undefined) updateData.notes = op.notes;
      if (op.scheduledFor !== undefined) updateData.scheduledFor = op.scheduledFor;
      if (op.startTime !== undefined) updateData.startTime = op.startTime;
      if (op.endTime !== undefined) updateData.endTime = op.endTime;
      if (op.location !== undefined) updateData.location = op.location;
      if (op.recurrence !== undefined) updateData.recurrence = op.recurrence;
      
      const event = await this.db.updateEvent(op.id, updateData);
      
      if (!event) {
        throw new Error(`Event with ID ${op.id} not found`);
      }
      
      return {
        event,
        updated: true
      };
    } catch (error) {
      throw new Error(`Failed to update event: ${error.message}`);
    }
  }
  
  async eventDelete(op) {
    try {
      // Check if event exists before deleting for consistent error semantics
      const event = await this.db.getEventById(op.id);
      if (!event) {
        throw new Error(`Event with ID ${op.id} not found`);
      }
      await this.db.deleteEvent(op.id);
      return {
        deleted: true
      };
    } catch (error) {
      throw new Error(`Failed to delete event: ${error.message}`);
    }
  }

  // Event occurrence status removed: not supported; habits removed entirely
}
