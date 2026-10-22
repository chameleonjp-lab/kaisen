import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { steerAndObserve } from './touch-command';
import { waitForPausedView } from './paused-view';

for (const viewport of [{ width: 393, height: 852 }, { width: 852, height: 393 }]) {
  test(`Normal rendered camera has equal up/down/left/right rates in empty space at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    test.setTimeout(60_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('#start')).toBeEnabled();
    await page.locator('input[value="normal"]').check(); await page.locator('#start').tap();
    const cdp = await context.newCDPSession(page);
    const origin = viewport.width < viewport.height ? { x: 170, y: 500 } : { x: 350, y: 190 };
    const observations: any[] = [];
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
      const away = await steerAndObserve(page, cdp, origin, -1, 0);
      await page.waitForFunction(tick => (window as any).__kaisenReadState('clock').tick >= tick, away.tick + 120, { polling: 'raf' });
      for (const [name, turn, climb] of [['up', 0, .25], ['down', 0, -.25], ['left', -.25, 0], ['right', .25, 0]] as const) {
        const accepted = await steerAndObserve(page, cdp, origin, turn, climb);
        const samples = await page.evaluate(async ({ width, height, afterTick }) => {
          const { Vector3, Quaternion } = await import('/node_modules/three/build/three.module.js');
          const { projectFlightTarget } = await import('/src/flight-view.ts');
          return new Promise<any[]>((resolve, reject) => {
            const samples: any[] = []; let frame = 0, submitted = -1;
            const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('No completed camera sample window')); }, 10_000);
            const poll = () => {
              const s = (window as any).__kaisenReadState(false), pose = s.render.presentation;
              if (s.phase !== 'playing') { clearTimeout(timeout); reject(new Error(`Camera flight stopped: ${JSON.stringify(s.pauseReasons)}`)); return; }
              if (pose.tick > afterTick + 8 && s.render.queue.submittedCount !== submitted) {
                submitted = s.render.queue.submittedCount;
                const player = { ...s.player, position: new Vector3(s.player.position.x, s.player.position.y, s.player.position.z),
                  quaternion: new Quaternion().fromArray(s.player.quaternion) };
                const visible = [...s.enemies, ...s.ships].filter(t => t.health > 0 && projectFlightTarget(player,
                  new Vector3(t.position.x, t.position.y + (t.kind === 'ship' ? t.height * .4 : 0), t.position.z), width / height, 'normal').visible).length;
                samples.push({ ...pose, visible, speed: s.player.speed, shots: s.stats.shots,
                  bombCue: document.getElementById('bomb')!.dataset.ready, torpedoCue: document.getElementById('torpedo')!.dataset.ready });
                if (samples.length >= 3 && pose.elapsed - samples[0].elapsed >= .4) { clearTimeout(timeout); resolve(samples); return; }
              }
              frame = requestAnimationFrame(poll);
            };
            poll();
          });
        }, { ...viewport, afterTick: accepted.tick });
        const forward = ([x, y, z, w]: number[]) => [-2 * (x * z + w * y), 2 * (w * x - y * z), 2 * (x * x + y * y) - 1];
        const a = forward(samples[0].cameraQuaternion), b = forward(samples.at(-1).cameraQuaternion);
        const cross = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        const rate = Math.atan2(Math.hypot(...cross), a.reduce((sum, x, i) => sum + x * b[i], 0)) /
          (samples.at(-1).elapsed - samples[0].elapsed);
        observations.push({ name, rate, samples });
        expect(samples.every(s => s.alpha >= 0 && s.alpha < 1), 'the real renderer consumes the fractional accumulator').toBe(true);
        expect(samples.every(s => s.visible === 0 && s.shots === 0), 'empty view has no enemy assistance or automatic firing').toBe(true);
        expect(rate).toBeGreaterThan(.19); expect(rate).toBeLessThan(.24);
      }
      const rates = observations.map(o => o.rate);
      expect(Math.max(...rates) / Math.min(...rates)).toBeLessThan(1.05);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.locator('#pause').tap(); await waitForPausedView(page);
      await mkdir('test-results/evidence', { recursive: true });
      await page.screenshot({ path: `test-results/evidence/camera-rate-${viewport.width}.png`, style: '#pause-screen {visibility:hidden!important}' });
      expect(errors).toEqual([]);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
      await mkdir('test-results/evidence', { recursive: true });
      await writeFile(`test-results/evidence/camera-rate-${viewport.width}.json`, JSON.stringify({ observations, errors }, null, 2));
    }
  });
}
