export const LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type Language = (typeof LANGUAGES)[number];
