import { test, expect } from '../fixtures/extension';
import { mockTranslateProviders } from '../mocks/translateRoutes';

test.use({ classicScrollbars: true });

test('defaults to the left and waits for manual webpage translation', async ({ context, page, seedConfig, serviceWorker }) => {
    const recorder = await mockTranslateProviders(context);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedConfig({ fluento_config_floatBallSwitch: true });
    await serviceWorker.evaluate(() => chrome.storage.local.remove([
        'fluento_config_defaultStrategy', 'fluento_config_floatBallDockedPosition', 'fluento_config_floatBallPosition',
    ]));
    await page.goto('/basic.html');
    const shell = page.locator('#fluento-float-ball-host [data-dock="left"]');
    const button = shell.getByRole('switch');
    await expect(shell).toHaveAttribute('data-retracted', 'true');
    await expect.poll(() => button.evaluate(el => el.getBoundingClientRect().right)).toBe(16);
    await expect(async () => {
        expect(recorder.requests).toBeGreaterThan(0);
    }).not.toPass({ timeout: 1000, intervals: [50] });

    await page.mouse.move(8, (await button.boundingBox())!.y + 16);
    await button.click();
    await expect(page.locator('#p1 .fluento-translation')).toBeVisible();
    expect(recorder.requests).toBeGreaterThan(0);
});

test('right-docked ball follows the viewport when only the scrollbar changes', async ({ context, page, seedConfig }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedConfig({
        fluento_config_defaultStrategy: 'never',
        fluento_config_floatBallSwitch: true,
        fluento_config_floatBallDockedPosition: { x: 100, y: 75, dock: 'right' },
    });
    await context.route('**/float-ball.html', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>html{width:1280px;height:720px;overflow-y:hidden}body{margin:0}</style><p>Fixed-size document root</p>',
    }));
    await page.goto('/float-ball.html');
    const shell = page.locator('#fluento-float-ball-host [data-dock="right"]');
    const widthShown = () => shell.locator('button[role=switch]').evaluate(button =>
        document.documentElement.clientWidth - button.getBoundingClientRect().left);
    await expect(shell).toHaveAttribute('data-retracted', 'true');
    await expect.poll(widthShown).toBe(16);

    const metrics = () => page.evaluate(() => {
        const root = document.documentElement;
        return { inner: innerWidth, client: root.clientWidth, rootWidth: root.getBoundingClientRect().width };
    });
    const before = await metrics();
    await page.evaluate(() => { document.documentElement.style.overflowY = 'scroll'; });
    await expect.poll(async () => (await metrics()).client).toBeLessThan(before.client);
    expect(await metrics()).toMatchObject({ inner: before.inner, rootWidth: before.rootWidth });
    await expect.poll(widthShown).toBe(16);

    await page.evaluate(() => { document.documentElement.style.overflowY = 'hidden'; });
    await expect.poll(async () => (await metrics()).client).toBe(before.client);
    await expect.poll(widthShown).toBe(16);
});
