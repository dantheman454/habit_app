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
  
  async todoComplete(op) {
    try {
      const todo = await this.db.updateTodo(op.id, { completed: true });
      
      if (!todo) {
        throw new Error(`Todo with ID ${op.id} not found`);
      }
      
      return {
        todo,
        completed: true
      };
    } catch (error) {
      throw new Error(`Failed to complete todo: ${error.message}`);
    }
  }
  
  async eventCreate(op) {
    try {
      const event = await this.db.events.create({
        title: op.title,
        notes: op.notes || null,
        scheduledFor: op.scheduledFor,
        timeOfDay: op.timeOfDay || null,
        duration: op.duration || null
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
      if (op.timeOfDay !== undefined) updateData.timeOfDay = op.timeOfDay;
      if (op.duration !== undefined) updateData.duration = op.duration;
      
      const event = await this.db.events.update(op.id, updateData);
      
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
      const deleted = await this.db.events.delete(op.id);
      
      if (!deleted) {
        throw new Error(`Event with ID ${op.id} not found`);
      }
      
      return {
        deleted: true
      };
    } catch (error) {
      throw new Error(`Failed to delete event: ${error.message}`);
    }
  }
  
  async habitCreate(op) {
    try {
      const habit = await this.db.habits.create({
        title: op.title,
        notes: op.notes || null,
        frequency: op.frequency ? JSON.stringify(op.frequency) : null
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
      if (op.frequency !== undefined) updateData.frequency = JSON.stringify(op.frequency);
      
      const habit = await this.db.habits.update(op.id, updateData);
      
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
      const deleted = await this.db.habits.delete(op.id);
      
      if (!deleted) {
        throw new Error(`Habit with ID ${op.id} not found`);
      }
      
      return {
        deleted: true
      };
    } catch (error) {
      throw new Error(`Failed to delete habit: ${error.message}`);
    }
  }
  
  async habitToggle(op) {
    try {
      const result = await this.db.habits.toggleOccurrence(op.id, op.date);
      
      return {
        habit: result.habit,
        occurrence: result.occurrence,
        toggled: true
      };
    } catch (error) {
      throw new Error(`Failed to toggle habit occurrence: ${error.message}`);
    }
  }
}
