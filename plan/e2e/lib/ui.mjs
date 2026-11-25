// Shared UI steps of the journeys: they drive a Page (lib/cdp.mjs) through real input only; the
// only page-side changes are scrollIntoView (bringing a control into view) and a temporary
// data-e2e-card marker used to find one card's Edit button.
import { sleep } from "./cdp.mjs";

export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Opens the Paseo UI, the sandbox workspace and its Decision roadmap tab; returns at the plugin's overview or a session. */
export async function openPlugin(page, baseUrl) {
  await page.send("Page.navigate", { url: baseUrl });
  await page.front();
  await page.waitFor("the sandbox workspace in the sidebar", async () => (await page.controls()).some((c) => c.label === "UI check" || c.text === "UI check"), 30_000);
  await page.click(/^UI check$/, { index: 0 });
  // A workspace with an agent opens on the agent's tab (Paseo 0.16): the panel is then opened from
  // New tab → Decision roadmap unless its tab is already there.
  const named = async () => (await page.controls()).filter((c) => c.label === "Decision roadmap" || (c.label === "" && c.text === "Decision roadmap"));
  await page.waitFor("the Decision roadmap tab or New tab", async () => (await named()).length > 0 || (await page.controls()).some((c) => c.label === "New tab"), 20_000);
  if ((await named()).length === 0) {
    await page.click(/^New tab$/, { index: 0 });
    await page.waitFor("the Decision roadmap item", async () => (await named()).some((c) => c.role === "menuitem"), 10_000);
    await page.click(/^Decision roadmap$/, { index: (await named()).findIndex((c) => c.role === "menuitem") });
  } else await page.click(/^Decision roadmap$/, { index: Math.max(0, (await named()).findIndex((c) => c.role !== "menuitem")) });
  await page.waitFor("the plugin", async () => /Sessions|‹ Back/.test(await page.text()), 20_000);
}

/** From wherever the plugin is, back to the overview and into the session titled `title`. */
export async function openSession(page, title, { timeout = 20_000 } = {}) {
  for (let i = 0; i < 4 && (await page.controls()).some((c) => c.label === "‹ Back" || c.text === "‹ Back"); i++) {
    await page.click(/^‹ Back$/);
    await sleep(600);
  }
  const row = new RegExp(`^Open session ${esc(title)}$`);
  await page.waitFor(`the session row ${title}`, async () => (await page.controls()).some((c) => row.test(c.label)), timeout);
  await page.click(row);
  // The overview row already shows the title: the session screen is proven by its own controls
  // (‹ Back and the Chat menu) with the row gone.
  await page.waitFor(
    `the session screen of ${title}`,
    async () => {
      const cs = await page.controls();
      return cs.some((c) => c.label === "‹ Back" || c.text === "‹ Back") && cs.some((c) => /^Chat menu/.test(c.label)) && !cs.some((c) => row.test(c.label)) && new RegExp(esc(title)).test(await page.text());
    },
    timeout,
  );
}

export async function chooseMode(page, mode, compact = false) {
  if (compact) await page.tap(/^Chat menu/);
  else await page.click(/^Chat menu/);
  await page.waitFor("the Chat menu items", async () => (await page.controls()).some((c) => new RegExp(`^(✓ )?${mode}$`).test(c.label || c.text)), 8_000);
  if (compact) await page.tap(new RegExp(`^(✓ )?${mode}$`));
  else await page.click(new RegExp(`^(✓ )?${mode}$`));
  await sleep(1200);
}

export async function fill(page, field, text, compact = false) {
  if (compact) await page.tap(field);
  else await page.click(field);
  await page.type(text, { replace: true });
}

/** Answers a card's question through its Edit panel: an option by its label, or free text. */
export async function answerOnCard(page, questionTitle, value) {
  const card = await page.ev(`(() => { const t = [...document.querySelectorAll('div,span')].find((e) => e.children.length === 0 && (e.textContent || '').trim().endsWith(${JSON.stringify(questionTitle)})); if (!t) return null; let c = t; for (let i = 0; i < 12 && c; i++) { if (c.querySelector('[aria-label="Edit"]') && c.querySelectorAll('[aria-label="Edit"]').length === 1) { c.setAttribute('data-e2e-card', '1'); return true; } c = c.parentElement; } return null; })()`);
  if (!card) throw new Error(`no card for ${questionTitle}`);
  await page.ev(`document.querySelector('[data-e2e-card] [aria-label="Edit"]').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const r = await page.ev(`(() => { const e = document.querySelector('[data-e2e-card] [aria-label="Edit"]'); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(600);
  await page.ev(`document.querySelector('[data-e2e-card]')?.removeAttribute('data-e2e-card')`);
  if (value.option !== undefined) await page.click(new RegExp(`^${esc(value.option)}$`));
  else await fill(page, /^Free-text answer$/, value.text);
  await page.click(/^Answer$/);
  await sleep(1200);
}
