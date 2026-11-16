/**
 * @file Ensures disabled analytics never collects deep links or workspace state.
 */
import { test, expect } from './visitor.fixture.mjs'

// Isolate documents so navigation cannot interrupt another deep link's startup reads.
for (const path of [
  '/',
  '/engine/private-job',
  '/data/private-dataset',
  '/account/private-account',
]) {
  test(`no telemetry scripts or requests exist on public deep link ${path}`, async ({ page }) => {
    const requests = []
    page.on('request', (request) => {
      if (/cloudflareinsights/.test(request.url())) requests.push(request.url())
    })
    await page.goto(`${path}?private=not-for-analytics#private-fragment`)
    await expect(page.locator('header').getByText('M&A Capitals', { exact: true })).toBeVisible()
    if (path === '/') await expect(page.getByText(/40 of 120 rows loaded/)).toBeVisible()
    else if (path.startsWith('/engine'))
      await expect(page.getByRole('button', { name: '▶ Run', exact: true }).first()).toBeDisabled()
    else await expect(page.getByText('MT5 Terminals', { exact: true })).toBeVisible()
    await expect(page.locator('script[src*="insights"],script[data-cf-beacon]')).toHaveCount(0)
    expect(requests).toEqual([])
  })
}

test('navigation, theme and disabled operator controls work without analytics', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('EURUSD.csv', { exact: true })).toBeVisible()
  await page.getByText('Engine', { exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('button', { name: '▶ Run', exact: true }).first()).toBeDisabled()
  await page.getByRole('button', { name: 'Jour', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('script[src*="insights"],script[data-cf-beacon]')).toHaveCount(0)
})
