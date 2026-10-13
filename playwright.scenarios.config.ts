import { defineConfig } from '@playwright/test';
import original from './playwright.config';

// Optional strategy experiments retain the full mission assertions. They run
// explicitly, separately from the browser contracts used by ordinary CI.
export default defineConfig({
  ...original,
  testDir: './scenarios/browser',
  outputDir: 'scenario-results/browser',
  projects: original.projects?.filter(project => project.name === 'chromium'),
  reporter: [['list'], ['json', { outputFile: 'scenario-results/browser-results.json' }]],
});
