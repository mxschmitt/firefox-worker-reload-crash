import { test, expect } from "@playwright/test";

test("Firefox tab survives reloads while a Worker script is compiling", async ({ page }) => {
  page.on("crash", () => console.log("EVENT page.crash"));

  await page.goto("/");
  await page.waitForFunction(() => window.__ready === true);

  for (let i = 1; i <= 5; i++) {
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__ready === true);
  }

  expect(page.isClosed(), "page should still be open (not crashed)").toBe(false);
});
