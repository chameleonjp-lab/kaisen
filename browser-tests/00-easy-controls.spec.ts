import { test } from '@playwright/test';
import { inspectMissionInputContract } from './mission-input-contract';

test('Easy touch commands are consumed, payloads consume one round, and pause freezes the mission', async ({ page, context }) => {
  await inspectMissionInputContract(page, context, 'easy');
});
