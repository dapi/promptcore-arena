async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await page.locator("#model").selectOption("training");
  await page.locator("#run").click();
  await page.locator("#run").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#run").disabled, {
    timeout: 15000,
  });
  if (
    !(await page
      .locator("#mode-label")
      .innerText()
      .then((t) => t.includes("ТРЕНИРОВКА")))
  )
    throw new Error("Mode not labelled");
  await page.locator("#timeline").evaluate((el) => {
    el.value = el.max;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#result-banner").waitFor({ state: "visible" });
  const result = await page.locator("#result-banner").innerText();
  await page.locator("#timeline").evaluate((el) => {
    el.value = "0";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-pov="A"]').click();
  if (
    !(await page
      .locator(".setup-panel")
      .innerText()
      .then((t) => t.includes("ВНЕ ОБЗОРА")))
  )
    throw new Error("Opponent data leak");
  await page.locator('[data-pov="all"]').click();
  await page.locator("#next").click();
  if ((await page.locator("#turn-label").innerText()) !== "01")
    throw new Error("Replay step");
  await page.locator("#prev").click();
  await page.locator('[data-tab="archive"]').click();
  await page.locator("[data-replay]").first().click();
  if ((await page.locator("#prompt-a").inputValue()) === "")
    throw new Error("Prompt not restored");
  await page.locator("#play").click();
  await page.locator("#series").click();
  await page.waitForFunction(() => !document.querySelector("#run").disabled, {
    timeout: 20000,
  });
  await page.locator("#series-results button").nth(3).waitFor();
  const series = await page.locator("#series-results").innerText();
  await page.locator("#series-results button").nth(1).click();
  await page.locator("#timeline").evaluate((el) => {
    el.value = "9";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.screenshot({
    path: "artifacts/arena-battle-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/arena-mobile.png", fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (overflow) throw new Error("Mobile horizontal overflow");
  await page.locator('[data-tab="rules"]').click();
  await page.locator("#rules-tab").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1512, height: 1100 });
  await page.locator('[data-tab="arena"]').click();
  return { result, series, errors, mobileOverflow: overflow };
}
