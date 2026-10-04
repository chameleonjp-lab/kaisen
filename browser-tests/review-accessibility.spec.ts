import { test, expect } from '@playwright/test';

test('pause layout settings are reachable by keyboard and modal backward focus stays usable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').tap();
  await page.locator('#pause').tap();
  await expect(page.locator('#pause-screen')).toBeVisible();
  await page.locator('#resume').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#pause-restart')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#pause-home')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#pause-rules')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#pause-controls')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#control-settings')).toBeVisible();
  await expect(page.locator('#control-close')).toBeFocused();
  // Backward traversal from Close wraps to the visible modal Save action.
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#control-save')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#control-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#control-settings')).not.toBeVisible();
  await expect(page.locator('#pause-screen')).toBeVisible();
  await expect(page.locator('#pause-controls')).toBeFocused();
});
