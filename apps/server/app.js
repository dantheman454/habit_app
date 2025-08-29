import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import tasksRouter from './routes/tasks.js';
import eventsRouter from './routes/events.js';
import goalsRouter from './routes/goals.js';
import searchRouter from './routes/search.js';
import scheduleRouter from './routes/schedule.js';
import assistantRouter, { setOperationProcessor } from './routes/assistant.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Mount routes
app.use(healthRouter);
app.use(tasksRouter);
app.use(eventsRouter);
app.use(goalsRouter);
app.use(searchRouter);
app.use(scheduleRouter);
app.use(assistantRouter);

export { setOperationProcessor };
export default app;


