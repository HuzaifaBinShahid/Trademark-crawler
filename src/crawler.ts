import {
  PlaywrightCrawler,
  createPlaywrightRouter,
  NonRetryableError,
} from "crawlee";
import { parse } from "date-fns";
import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

interface TrademarkData {
  nameTitle?: string;
  status?: string;
  applicationDate?: string;
  revelationDate?: string;
  applicationNumber?: string;
  categoryOfRights?: string;
  registrationNumber?: string;
  trademarkType?: string;
}

interface CrawlerOptions {
  startDate: string;
  endDate: string;
  outputFile?: string;
}

class PolishPatentCrawler {
  private results: TrademarkData[] = [];
  private baseUrl =
    "https://ewyszukiwarka.pue.uprp.gov.pl/search/advanced-search";
  private formFilled = false;

  constructor(private options: CrawlerOptions) {}

  private checkDateRange(): void {
    const { startDate, endDate } = this.options;

    const isValidDate = (dateStr: string) => {
      const parsed = parse(dateStr, "yyyy-MM-dd", new Date());
      return !isNaN(parsed.getTime());
    };

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      throw new Error("Invalid date format. Use YYYY-MM-DD.");
    }

    const parsedStart = parse(startDate, "yyyy-MM-dd", new Date());
    const parsedEnd = parse(endDate, "yyyy-MM-dd", new Date());

    if (parsedStart > parsedEnd) {
      throw new Error("Start date must be before or equal to end date.");
    }
  }

  private async configureCheckboxes(page: Page): Promise<void> {
    const checkboxes = await page.$$('input[type="checkbox"]');
    const targetCheckboxes = [
      "pwp_criteria_0",
      "collections_criteria_advanced_7",
      "collections_criteria_advanced_7_child_attrs_0",
    ];

    for (const checkbox of checkboxes) {
      const id = await checkbox.getAttribute("id");
      if (!id) continue;

      const isChecked = await checkbox.isChecked();
      const shouldBeChecked = targetCheckboxes.includes(id);

      if (isChecked !== shouldBeChecked) {
        const box = await checkbox.evaluateHandle(
          (el) =>
            el
              .closest(".ui-chkbox")
              ?.querySelector(".ui-chkbox-box") as HTMLElement
        );
        if (box) {
          await box.click();
          await page.waitForTimeout(100);
        }
      }
    }
  }

  private async inputDateValue(
    page: Page,
    selector: string,
    value: string
  ): Promise<void> {
    await page.click(selector);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.type(selector, value, { delay: 100 });
    await page.waitForTimeout(300);
  }

  private async executeSearch(page: Page): Promise<void> {
    console.log(
      `Performing search for date range: ${this.options.startDate} to ${this.options.endDate}`
    );

    await page.waitForLoadState("networkidle");
    await page.waitForSelector(".search-attr-container", { timeout: 20000 });

    await this.configureCheckboxes(page);

    await this.inputDateValue(page, "#attribute_date_from", this.options.endDate);
    await this.inputDateValue(page, "#attribute_date_to", this.options.startDate);

    await Promise.all([
      page.waitForNavigation({ timeout: 15000, waitUntil: "domcontentloaded" }),
      page.click(".ui-button-secondary .ui-clickable", { delay: 100 }),
    ]);

    await page.waitForFunction(() => {
      return (
        document.querySelector(".search-table") ||
        document.querySelector(".tabs-info-message")
      );
    });

    const errorText = await page
      .$eval(".tabs-info-message", (el) =>
        el?.textContent?.toLowerCase().trim()
      )
      .catch(() => null);

    if (errorText?.includes("no results found")) {
      throw new NonRetryableError("No results found for the given criteria");
    }

    if (errorText?.includes("too many results found")) {
      throw new NonRetryableError(
        "Too many results found. Please narrow your search criteria"
      );
    }
  }

  private async getDetailInformation(page: Page): Promise<TrademarkData> {
    return page.evaluate(() => {
      const result: any = {};
      const fieldMappings = {
        "Name/Title": "nameTitle",
        Status: "status",
        "Application date": "applicationDate",
        "Revelation date": "revelationDate",
        "Application number": "applicationNumber",
        "Category of rights": "categoryOfRights",
        "Registration number": "registrationNumber",
        "Trademark type": "trademarkType",
      };

      const rows = document.querySelectorAll("table.details-list tr");

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");

        for (let i = 0; i < cells.length; i += 2) {
          const labelCell = cells[i];
          const valueCell = cells[i + 1];

          if (labelCell?.classList.contains("detail-title") && valueCell) {
            const labelText =
              labelCell.textContent?.trim().replace(/\s+/g, " ") || "";

            const fieldName = Object.entries(fieldMappings).find(([label]) =>
              labelText.includes(label)
            )?.[1];

            if (fieldName) {
              const highlightSpan = valueCell.querySelector(".highlight");
              let value = highlightSpan?.textContent?.trim();

              if (!value) {
                value = valueCell.textContent?.trim().replace(/\s+/g, " ");
              }

              result[fieldName] = value || null;
            }
          }
        }
      });

      return result;
    });
  }

  async crawl(): Promise<TrademarkData[]> {
    this.checkDateRange();

    console.log("Starting crawler...");

    const router = createPlaywrightRouter();

    router.addDefaultHandler(async ({ page, request, enqueueLinks, log }) => {
      if (request.url.includes("/search/advanced-search") && !this.formFilled) {
        log.info("Filling out search form...");
        await this.executeSearch(page);
        this.formFilled = true;
      }

      let hasNextPage = true;

      do {
        await enqueueLinks({
          selector: "table tbody tr td a",
          label: "detail",
        });

        const nextButton = await page.$("a.ui-paginator-next:not(.ui-state-disabled)");
        if (nextButton) {
          log.info("Navigating to next page...");
          await nextButton.click();
          await page.waitForTimeout(1500);
        } else {
          log.info("No more pages to paginate.");
          hasNextPage = false;
        }
      } while (hasNextPage);
    });

    router.addHandler("detail", async ({ page, request, log }) => {
      log.info(`📄 Processing detail: ${request.url}`);

      try {
        await page.waitForLoadState("networkidle", { timeout: 20000 });
        await page.waitForSelector("section.panel", { timeout: 15000 });
        await page.waitForTimeout(1000);

        const data = await this.getDetailInformation(page);

        if (data && Object.keys(data).length) {
          this.results.push(data);
          console.log(`Extracted data from ${request.url}:`, data);
        } else {
          log.warning(`No data extracted from: ${request.url}`);
        }
      } catch (error) {
        log.error(`Failed to process ${request.url}: ${error}`);
      }
    });

    const crawler = new PlaywrightCrawler({
      requestHandler: router,
      headless: false,
      navigationTimeoutSecs: 60,
      requestHandlerTimeoutSecs: 180,
      maxRequestsPerCrawl: 1000,
      failedRequestHandler: ({ request, error }: any) => {
        console.error(`Request ${request.url} failed: ${error.message}`);
      },
    });

    await crawler.run([{ url: this.baseUrl }]);

    console.log(`Crawling completed. Found ${this.results.length} records.`);

    const outputFile = this.options.outputFile || "output.json";
    const outputPath = path.resolve(outputFile);

    fs.writeFileSync(outputPath, JSON.stringify(this.results, null, 2));
    console.log(`Results saved to: ${outputPath}`);

    return this.results;
  }
}

function parseArgs(): CrawlerOptions {
  const args = process.argv.slice(2);
  const options: CrawlerOptions = {
    startDate: "",
    endDate: "",
    outputFile: "output.json",
  };

  console.log("Raw arguments:", args);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--start-date=") || arg.startsWith("-s=")) {
      options.startDate = arg.split("=")[1];
    } else if (arg === "--start-date" || arg === "-s") {
      options.startDate = args[++i];
    } else if (arg.startsWith("--end-date=") || arg.startsWith("-e=")) {
      options.endDate = arg.split("=")[1];
    } else if (arg === "--end-date" || arg === "-e") {
      options.endDate = args[++i];
    } else if (arg.startsWith("--output=") || arg.startsWith("-o=")) {
      options.outputFile = arg.split("=")[1];
    } else if (arg === "--output" || arg === "-o") {
      options.outputFile = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: npm run dev -- --start-date 2024-01-01 --end-date 2024-12-31
   or: npx ts-node src/crawler.ts --start-date 2024-01-01 --end-date 2024-12-31

Options:
  -s, --start-date <date>    Start date (YYYY-MM-DD format)
  -e, --end-date <date>      End date (YYYY-MM-DD format)
  -o, --output <file>        Output JSON file (default: output.json)
  -h, --help                 Show this help message

Examples:
  npm run dev -- --start-date 2024-01-01 --end-date 2024-12-31
  npm run dev -- -s 2024-01-01 -e 2024-12-31 -o results.json
            `);
      process.exit(0);
    } else if (!arg.startsWith("-") && !options.startDate) {
      options.startDate = arg;
    } else if (!arg.startsWith("-") && !options.endDate && options.startDate) {
      options.endDate = arg;
    }
  }

  console.log("Parsed options:", options);

  if (!options.startDate || !options.endDate) {
    console.error("Error: Both start-date and end-date are required.");
    console.log("Use --help for usage information.");
    process.exit(1);
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(options.startDate) || !dateRegex.test(options.endDate)) {
    console.error("Error: Dates must be in YYYY-MM-DD format.");
    process.exit(1);
  }

  return options;
}

async function main() {
  try {
    const options = parseArgs();
    console.log(`Starting crawl with options:`, options);

    const crawler = new PolishPatentCrawler(options);
    await crawler.crawl();
  } catch (error) {
    console.error("Crawler failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { PolishPatentCrawler, TrademarkData, CrawlerOptions };