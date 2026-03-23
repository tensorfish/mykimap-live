/**
 * Global error modal — shows crash details with copy-to-clipboard.
 * Call showError() from any catch block instead of silently swallowing.
 */

const overlay = () => document.getElementById("error-overlay")!;
const messageEl = () => document.getElementById("error-message")!;
const detailsEl = () => document.getElementById("error-details")!;

let lastErrorText = "";

export function showError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";

  const details = [
    `Context: ${context}`,
    `Error: ${msg}`,
    `Time: ${new Date().toISOString()}`,
    `URL: ${location.href}`,
    `UA: ${navigator.userAgent}`,
    "",
    stack,
  ].join("\n");

  lastErrorText = details;

  messageEl().textContent = `${context}: ${msg}`;
  detailsEl().textContent = details;
  overlay().classList.add("visible");

  console.error(`[${context}]`, error);
}

export function initErrorModal(): void {
  document.getElementById("error-dismiss")!.addEventListener("click", () => {
    overlay().classList.remove("visible");
  });

  document.getElementById("error-copy")!.addEventListener("click", () => {
    navigator.clipboard.writeText(lastErrorText).then(() => {
      const btn = document.getElementById("error-copy")!;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy error details"; }, 2000);
    });
  });

  // Catch unhandled errors
  window.addEventListener("error", (e) => {
    showError("Unhandled error", e.error ?? e.message);
  });

  window.addEventListener("unhandledrejection", (e) => {
    showError("Unhandled promise rejection", e.reason);
  });
}
