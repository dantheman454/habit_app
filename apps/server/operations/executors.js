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
        recurrence: op.recurrence || { type: 'none' }
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

  // Event occurrence status removed: not supported
  
  async habitCreate(op) {
    try {
      const habit = await this.db.createHabit({
        title: op.title,
        notes: op.notes || null,
        scheduledFor: op.scheduledFor ?? null,
        timeOfDay: op.timeOfDay ?? null,
        // Align validators' frequency with DB's recurrence
        recurrence: (op.frequency !== undefined ? op.frequency : (op.recurrence ?? { type: 'daily' })),
        completed: false,
      });
      
      return {
        habit,
        created: true
      };
    } catch (error) {
      throw new Error(`Failed to create habit: ${error.message}`);
    }
  }
  
  async habitUpdate(op) {
    try {
      const updateData = {};
      
      if (op.title !== undefined) updateData.title = op.title;
      if (op.notes !== undefined) updateData.notes = op.notes;
      // Map frequency -> recurrence for DB
      if (op.frequency !== undefined) updateData.recurrence = op.frequency;
      if (op.recurrence !== undefined) updateData.recurrence = op.recurrence;
      if (op.scheduledFor !== undefined) updateData.scheduledFor = op.scheduledFor;
      if (op.timeOfDay !== undefined) updateData.timeOfDay = op.timeOfDay;
      
      const habit = await this.db.updateHabit(op.id, updateData);
      
      if (!habit) {
        throw new Error(`Habit with ID ${op.id} not found`);
      }
      
      return {
        habit,
        updated: true
      };
    } catch (error) {
      throw new Error(`Failed to update habit: ${error.message}`);
    }
  }
  
  async habitDelete(op) {
    try {
      // Check if habit exists before deleting for consistent error semantics
      const habit = await this.db.getHabitById(op.id);
      if (!habit) {
        throw new Error(`Habit with ID ${op.id} not found`);
      }
      await this.db.deleteHabit(op.id);
      
      return {
        deleted: true
      };
    } catch (error) {
      throw new Error(`Failed to delete habit: ${error.message}`);
    }
  }

  async habitSetOccurrenceStatus(op) {
    try {
      const status = String(op.status);
      const completed = status === 'completed';
      const updated = await this.db.toggleHabitOccurrence({ 
        id: op.id, 
        occurrenceDate: op.occurrenceDate, 
        completed 
      });
      return { habit: updated, updated: true };
    } catch (error) {
      throw new Error(`Failed to set habit occurrence status: ${error.message}`);
    }
  }
}
