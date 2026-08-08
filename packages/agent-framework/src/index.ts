export { agents, tasks, taskEvents, products, architectureProposals } from './db/schema.js';
export { createDb, type Db } from './db/client.js';
export { PresenceHeartbeat, listPresence, type PresenceInfo } from './presence.js';
export {
  connectQueue,
  ensureStream,
  publishTask,
  consumeTasks,
  type TaskMessage,
  type TaskHandler,
  type ConsumeOptions,
} from './queue.js';
export type { LLMClient } from './llm/client.js';
export { GroqClient } from './llm/groq.js';
export { ZeropsAgent, type ZeropsAgentDeps } from './agent.js';
