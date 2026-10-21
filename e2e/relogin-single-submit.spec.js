const { test, expect } = require("@playwright/test");

// Regression: signing out and back in within the same tab used to bind every
// feature listener a second time, so one click submitted each form twice.

async function login(page, email) {
  await page.fill("#loginEmail", email);
  await page.fill("#loginPassword", "password123");
  await page.click("#loginForm button[type='submit']");
  await expect(page.locator("#appShell")).toBeVisible({ timeout: 10_000 });
}

async function logout(page) {
  // Logout reloads the page; wait for it so the next login uses the new page.
  await Promise.all([page.waitForEvent("load"), page.click("#logoutButton")]);
  await expect(page.locator("#authView")).toBeVisible({ timeout: 10_000 });
}

function countPosts(page, action) {
  const seen = { count: 0 };
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes("/api/")) return;
    if (request.postData()?.includes(`"action":"${action}"`)) seen.count += 1;
  });
  return seen;
}

test.describe("Signing in again in the same tab", () => {
  test("admin CSV upload after logout and login sends one batch and creates each account once", async ({ page }) => {
    await page.goto("/");
    await login(page, "e2e.admin@example.com");
    await logout(page);
    await login(page, "e2e.admin@example.com");

    await page.click("#mainNav button[data-view='accountView']");
    await expect(page.locator("#accountView")).toBeVisible();

    const email = `siswa.relogin.${Date.now()}@example.test`;
    const batches = countPosts(page, "create-users-batch");
    await page.setInputFiles("#csvFile", {
      name: "akun.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`Siswa Relogin,${email},student,password123\n`),
    });
    await page.click("#csvForm button[type='submit']");

    await expect(page.getByText("Berhasil membuat 1 akun baru dari CSV.")).toBeVisible({ timeout: 10_000 });
    // Give a duplicate handler time to fire its own request if one is bound.
    await page.waitForTimeout(1_500);
    expect(batches.count).toBe(1);
    await expect(page.getByText(/Gagal: \d+/)).toHaveCount(0);
    await expect(page.locator("#userList").getByText(email)).toHaveCount(1);
  });

  test("teacher creating a class after logout and login creates it once", async ({ page }) => {
    await page.goto("/");
    await login(page, "e2e.guru@example.com");
    await logout(page);
    await login(page, "e2e.guru@example.com");

    await page.click("#mainNav button[data-view='manageClassView']");
    await expect(page.locator("#manageClassView")).toBeVisible();

    const className = `Kelas Relogin ${Date.now()}`;
    const creates = countPosts(page, "create-class");
    await page.fill("#className", className);
    await page.click("#classForm button[type='submit']");

    await expect(page.locator("#classList article").filter({ hasText: className }).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_500);
    expect(creates.count).toBe(1);
    await expect(page.locator("#classList article").filter({ hasText: className })).toHaveCount(1);
  });
});
