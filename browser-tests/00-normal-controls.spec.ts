import { test } from '@playwright/test';
import { inspectMissionInputContract } from './mission-input-contract';

test('Normal touch and manual fire are consumed, payloads consume one round, and pause clears inputs', async ({ page, context }) => {
  await inspectMissionInputContract(page, context, 'normal');
});
