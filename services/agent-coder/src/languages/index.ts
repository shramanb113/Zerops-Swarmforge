import type { Language } from '@swarmforge/agent-framework';
import type { CoderLanguageProfile } from './shared.js';
import { typescriptProfile } from './typescript.js';

export type { CoderLanguageProfile } from './shared.js';
export { FRONTEND_INSTRUCTIONS } from './shared.js';

export const CODER_LANGUAGE_PROFILES: Partial<Record<Language, CoderLanguageProfile>> = {
  typescript: typescriptProfile,
};
