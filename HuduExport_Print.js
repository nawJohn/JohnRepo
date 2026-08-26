const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const DOWNLOAD_FOLDER = "%";
const KB_FOLDER_URL = "%";

const MAX_ATTEMPTS = 4;
const SUCCESS_DELAY_MS = 2000;
const RETRY_DELAYS_MS = [5000, 10000, 20000];
const DOWNLOAD_START_TIMEOUT_MS = 60000;
const PDF_REQUEST_TIMEOUT_MS = 120000;

function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function isValidPdf(filePath) {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 5) {
      return false;
    }

    const handle = fs.openSync(filePath, "r");
    const signature = Buffer.alloc(5);

    try {
      fs.readSync(handle, signature, 0, 5, 0);
    } finally {
      fs.closeSync(handle);
    }

    return signature.toString("ascii") === "%PDF-";
  } catch {
    return false;
  }
}

function sanitizedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[unavailable]";
  }
}

function createDownloadWaiter(cdp, timeout) {
  let handler;
  let timer;
  let finished = false;

  function cleanup() {
    if (handler) {
      cdp.off("Browser.downloadWillBegin", handler);
    }

    if (timer) {
      clearTimeout(timer);
    }
  }

  const promise = new Promise((resolve, reject) => {
    handler = event => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      resolve(event);
    };

    timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      reject(new Error("Hudu did not initiate a PDF download before the timeout."));
    }, timeout);

    cdp.on("Browser.downloadWillBegin", handler);
  });

  return {
    promise,
    cancel() {
      if (!finished) {
        finished = true;
        cleanup();
      }
    }
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

(async () => {
  fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(DOWNLOAD_FOLDER, `hudu-export-${timestamp}.log`);

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    fs.appendFileSync(logFile, `${line}\r\n`, "utf8");
  }

  log(`Log file: ${logFile}`);
  log("Launching Chromium...");

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, "hudu-profile"),
    {
      headless: false,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      args: ["--ignore-certificate-errors"]
    }
  );

  try {
    const page = context.pages()[0] || await context.newPage();
    const cdp = await context.newCDPSession(page);

    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DOWNLOAD_FOLDER,
      eventsEnabled: true
    });

    log(`Opening KB folder: ${KB_FOLDER_URL}`);

    await page.goto(KB_FOLDER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });

    log("Complete login and MFA if prompted. Waiting for the KB table...");
    await page.waitForSelector("table", { timeout: 0 });

    const discoveredArticles = await page
      .locator("table tbody a")
      .evaluateAll(links =>
        links
          .map(link => ({
            title: link.textContent.trim(),
            url: link.href
          }))
          .filter(article => article.title && article.url)
      );

    const articles = Array.from(
      new Map(discoveredArticles.map(article => [article.url, article])).values()
    );

    log(`Found ${articles.length} unique article(s).`);

    const completed = [];
    const skipped = [];
    const failed = [];

    for (let index = 0; index < articles.length; index += 1) {
      const article = articles[index];
      const filename = `${safeFilename(article.title)}.pdf`;
      const destination = path.join(DOWNLOAD_FOLDER, filename);
      const label = `${index + 1}/${articles.length} ${article.title}`;

      if (isValidPdf(destination)) {
        log(`SKIP ${label} — a valid PDF already exists.`);
        skipped.push(article.title);
        continue;
      }

      let saved = false;
      let lastError = "Unknown error";

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let downloadWaiter;

        try {
          log(`START ${label} — attempt ${attempt}/${MAX_ATTEMPTS}.`);

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

          downloadWaiter = createDownloadWaiter(cdp, DOWNLOAD_START_TIMEOUT_MS);

          await downloadButton.click({ timeout: 30000 });
          const downloadInfo = await downloadWaiter.promise;

          log(`URL ${label} — ${sanitizedUrl(downloadInfo.url)}`);

          try {
            await cdp.send("Browser.cancelDownload", { guid: downloadInfo.guid });
          } catch (cancelError) {
            log(`NOTICE ${label} — native download cancellation: ${cancelError.message}`);
          }

          if (downloadInfo.url.startsWith("blob:")) {
            throw new Error("Hudu generated a browser-only blob URL.");
          }

          const response = await context.request.get(downloadInfo.url, {
            timeout: PDF_REQUEST_TIMEOUT_MS,
            failOnStatusCode: false
          });

          const status = response.status();
          const contentType = response.headers()["content-type"] || "";
          const body = await response.body();
          const hasPdfSignature = body.subarray(0, 5).toString("ascii") === "%PDF-";

          log(`HTTP ${label} — status=${status}, type=${contentType || "unknown"}, bytes=${body.length}.`);

          if (!response.ok()) {
            throw new Error(`PDF request returned HTTP ${status}.`);
          }

          if (!contentType.toLowerCase().includes("pdf") && !hasPdfSignature) {
            throw new Error(`Response was not a PDF; content type was ${contentType || "unknown"}.`);
          }

          fs.writeFileSync(destination, body);

          if (!isValidPdf(destination)) {
            throw new Error("The saved file failed PDF signature validation.");
          }

          log(`SAVED ${label} — ${destination}`);
          completed.push(article.title);
          saved = true;
          break;
        } catch (error) {
          if (downloadWaiter) {
            downloadWaiter.cancel();
          }

          lastError = error.message || String(error);
          log(`ERROR ${label} — attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);

          if (attempt < MAX_ATTEMPTS) {
            const retryDelay = RETRY_DELAYS_MS[attempt - 1] || 60000;
            log(`RETRY ${label} — waiting ${retryDelay / 1000} seconds.`);
            await sleep(retryDelay);
          }
        }
      }

      if (!saved) {
        failed.push({ title: article.title, error: lastError });
        log(`FAILED ${label} — all ${MAX_ATTEMPTS} attempts exhausted.`);
      } else {
        log(`WAIT ${label} — pausing ${SUCCESS_DELAY_MS / 1000} seconds before the next article.`);
        await sleep(SUCCESS_DELAY_MS);
      }
    }

    log(`SUMMARY saved=${completed.length}, skipped=${skipped.length}, failed=${failed.length}.`);

    if (failed.length > 0) {
      log("FAILED ARTICLES:");
      for (const failure of failed) {
        log(`- ${failure.title}: ${failure.error}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await context.close();
  }
})().catch(error => {
  console.error("Fatal script error:", error);
  process.exitCode = 1;
});
