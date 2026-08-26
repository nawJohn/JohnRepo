const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DOWNLOAD_FOLDER = "C:\\Hudu PDFs\\Cybersecurity Removal KBs";
const KB_FOLDER_URL = "https://hudu01.kinzit.com/kba?folder=5";

function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

(async () => {
  fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });

  // Persistent profile retains the Hudu login between runs.
  const context = await chromium.launchPersistentContext("./hudu-profile", {
    headless: false,
    acceptDownloads: true,
    ignoreHTTPSErrors: true
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(KB_FOLDER_URL);

  // On the first run, sign in manually if prompted.
  await page.waitForSelector("table");

  const articles = await page.locator("table tbody a").evaluateAll(links =>
    links
      .map(link => ({
        title: link.textContent.trim(),
        url: link.href
      }))
      .filter(article => article.title && article.url)
  );

  for (const article of articles) {
    console.log(`Exporting: ${article.title}`);

    await page.goto(article.url, { waitUntil: "domcontentloaded" });

    // This selector may need minor adjustment for your Hudu version.
const downloadButton = page.locator(`
  [title="Download"]:visible,
  [aria-label="Download"]:visible,
  [data-original-title="Download"]:visible,
  [data-bs-original-title="Download"]:visible,
  button:has-text("Download"):visible,
  a:has-text("Download"):visible,
  button:has(.fa-download):visible,
  a:has(.fa-download):visible,
  button:has(svg[data-icon="download"]):visible,
  a:has(svg[data-icon="download"]):visible
`).first();

await downloadButton.click({ timeout: 30000 });

const download = await downloadPromise;
const filename = `${safeFilename(article.title)}.pdf`;

await download.saveAs(path.join(DOWNLOAD_FOLDER, filename));
    await page.waitForTimeout(1000);
  }

  await context.close();
})();