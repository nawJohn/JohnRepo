const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DOWNLOAD_FOLDER =
  "C:\\Hudu PDFs\\Cybersecurity Removal KBs";

const KB_FOLDER_URL =
  "https://hudu01.kinzit.com/kba?folder=5";

function safeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
}

function waitForDownloadStart(cdp, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let timer;

    const handler = event => {
      clearTimeout(timer);
      cdp.off("Browser.downloadWillBegin", handler);
      resolve(event);
    };

    timer = setTimeout(() => {
      cdp.off("Browser.downloadWillBegin", handler);

      reject(
        new Error(
          "Hudu did not initiate a download within 30 seconds."
        )
      );
    }, timeout);

    cdp.on("Browser.downloadWillBegin", handler);
  });
}

(async () => {
  fs.mkdirSync(DOWNLOAD_FOLDER, {
    recursive: true
  });

  console.log("Launching browser...");

  const context =
    await chromium.launchPersistentContext(
      path.join(__dirname, "hudu-profile"),
      {
        headless: false,
        acceptDownloads: true,

        // Temporary certificate workarounds.
        ignoreHTTPSErrors: true,
        args: ["--ignore-certificate-errors"]
      }
    );

  const page =
    context.pages()[0] ||
    await context.newPage();

  const cdp =
    await context.newCDPSession(page);

  await cdp.send(
    "Browser.setDownloadBehavior",
    {
      behavior: "allow",
      downloadPath: DOWNLOAD_FOLDER,
      eventsEnabled: true
    }
  );

  console.log("Opening Hudu...");

  await page.goto(KB_FOLDER_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });

  console.log(
    "Complete the Hudu login and MFA if prompted."
  );

  // Wait indefinitely for the KB table so manual MFA
  // does not cause a timeout.
  await page.waitForSelector("table", {
    timeout: 0
  });

  console.log("Knowledge base table found.");

  const articles = await page
    .locator("table tbody a")
    .evaluateAll(links =>
      links
        .map(link => ({
          title: link.textContent.trim(),
          url: link.href
        }))
        .filter(
          article =>
            article.title &&
            article.url
        )
    );

  console.log(
    `Found ${articles.length} article(s).`
  );

  const failures = [];

  for (const article of articles) {
    try {
      console.log("");
      console.log(
        `Exporting: ${article.title}`
      );

      await page.goto(article.url, {
        waitUntil: "domcontentloaded",
        timeout: 120000
      });

      const downloadButton = page
        .locator(`
          [data-tippy-content="Print"]:visible,
          [data-tippy-content="Download"]:visible,
          [title="Print"]:visible,
          [title="Download"]:visible,
          [aria-label="Print"]:visible,
          [aria-label="Download"]:visible,
          [data-original-title="Print"]:visible,
          [data-original-title="Download"]:visible,
          [data-bs-original-title="Print"]:visible,
          [data-bs-original-title="Download"]:visible,
          button:has(.fa-download):visible,
          a:has(.fa-download):visible,
          button:has(.fa-print):visible,
          a:has(.fa-print):visible,
          button:has(svg[data-icon="download"]):visible,
          a:has(svg[data-icon="download"]):visible,
          button:has(svg[data-icon="print"]):visible,
          a:has(svg[data-icon="print"]):visible
        `)
        .first();

      await downloadButton.waitFor({
        state: "visible",
        timeout: 30000
      });

      const downloadStartPromise =
        waitForDownloadStart(cdp);

      await downloadButton.click({
        timeout: 30000
      });

      const downloadInfo =
        await downloadStartPromise;

        try {
          await cdp.send("Browser.cancelDownload", {
            guid: downloadInfo.guid
        });
      } catch {
        
  // The authenticated request below will still retrieve the PDF.
}

        try {
          await cdp.send("Browser.cancelDownload", {
            guid: downloadInfo.guid
        });
      } catch {
  // Continue because the authenticated request below
  // saves the PDF independently.
      }

      console.log(
        `Generated URL: ${downloadInfo.url}`
      );

      if (
        downloadInfo.url.startsWith("blob:")
      ) {
        throw new Error(
          "Hudu generated a browser-only blob URL."
        );
      }

      /*
       * Retrieve the generated PDF with the
       * authenticated Hudu browser session instead
       * of relying on Chromium/Edge's download
       * manager.
       */
      const response =
        await context.request.get(
          downloadInfo.url,
          {
            timeout: 120000,
            failOnStatusCode: false
          }
        );

      const body =
        await response.body();

      const contentType =
        response.headers()["content-type"] ||
        "";

      const hasPdfSignature =
        body
          .subarray(0, 5)
          .toString("ascii") === "%PDF-";

      console.log(
        `Response: ${response.status()} ${contentType}`
      );

      if (!response.ok()) {
        throw new Error(
          `PDF request returned HTTP ${response.status()}.`
        );
      }

      if (
        !contentType
          .toLowerCase()
          .includes("pdf") &&
        !hasPdfSignature
      ) {
        throw new Error(
          `The response was not a PDF. Content type: ${contentType}`
        );
      }

      const filename =
        `${safeFilename(article.title)}.pdf`;

      const destination =
        path.join(
          DOWNLOAD_FOLDER,
          filename
        );

      fs.writeFileSync(
        destination,
        body
      );

      console.log(
        `Saved: ${destination}`
      );

      console.log("Waiting 15 seconds before the next export...");
      await page.waitForTimeout(15000);
    } catch (error) {
      console.error(
        `Failed: ${article.title}`
      );

      console.error(
        error.message
      );

      failures.push({
        title: article.title,
        error: error.message
      });

      console.log(
        "Waiting 30 seconds after the failure..."
      );

      await page.waitForTimeout(30000);
  }
  }

  console.log("");
  console.log(
    `Finished. Successfully saved ${
      articles.length - failures.length
    } of ${articles.length} article(s).`
  );

  if (failures.length > 0) {
    console.log("");
    console.log("Failures:");

    for (const failure of failures) {
      console.log(
        `- ${failure.title}: ${failure.error}`
      );
    }
  }

  await context.close();

  if (failures.length > 0) {
    process.exitCode = 1;
  }
})().catch(error => {
  console.error(
    "Script failed:",
    error
  );

  process.exitCode = 1;
});